// OWNER: map ground engineer (terrainLayer.ts, camera.ts, minimap.ts, overlays.ts).
/**
 * Ground renderer: crisp at every zoom, with detail that appears as you zoom in.
 *
 * Geometry. The ground is the simulation's tile grid, drawn as flat colours. A tile corner is
 * rounded off (radius half a tile) when the tile's horizontal, vertical and diagonal neighbours
 * at that corner all share another terrain type, so coasts and terrain borders read as smooth
 * shapes while every tile still shows its own terrain and food. Water meets land along a thin
 * lighter shoreline.
 *
 * Detail by device pixels per tile (S):
 *   S <= OV        overview: the whole world cached at OV px per tile (8 for normal worlds).
 *                  Also the minimap thumbnail and the fallback while closer levels are painted.
 *   OV < S <= 128  chunks: 512 px canvases cached at L = 16, 32, 64 or 128 px per tile (the
 *                  smallest L >= S), drawn at 0.5x to 1x, never enlarged. Plants, tree crowns,
 *                  stones and speckles appear from L = 16 on.
 *   S > 128        direct: the few visible tiles are drawn as vectors every frame.
 * Plants follow each tile's food (count and size), so grazed land looks bare.
 *
 * Every cached canvas remembers a key per tile (terrain, food level, dryness, corner and shore
 * masks, elevation band). When keys change only those tiles are repainted, clipped to their
 * squares; repaints and new chunks share a per-frame time budget. A season change repaints
 * cached canvases gradually within the same budget.
 */
import { TERRAIN_INFO } from '../sim/constants';
import { TERRAIN, type EnvState, type TerrainType, type WorldState } from '../sim/types';

/** Overview resolution in px per tile for normal world sizes (smaller for very large worlds). */
export const PX = 8;

/** Visible world rectangle and CSS px per world unit (optional 4th argument of draw). */
export interface GroundView {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  zoom: number;
}

const LEVELS = [16, 32, 64, 128];
const CHUNK_PX = 512;
const DIRECT_FROM = 128;
/** Per-frame time for repainting cached canvases and painting new chunks (ms). */
const BUDGET_MS = 4;
const CACHE_LIMIT = 160 * 1024 * 1024;
const HALF_PI = Math.PI / 2;
const KEY_VALID = 1 << 24;

const DEEP = TERRAIN.DeepWater;
const WATER = TERRAIN.Water;
const SAND = TERRAIN.Sand;
const GRASS = TERRAIN.Grass;
const FOREST = TERRAIN.Forest;
const DESERT = TERRAIN.Desert;
const ROCK = TERRAIN.Rock;
const WALL = TERRAIN.Wall;

const MAX_FOOD: number[] = [];
for (let t = 0; t < 256; t++) MAX_FOOD[t] = TERRAIN_INFO[t as TerrainType]?.maxFood ?? 0;
const IS_WATER: boolean[] = [];
for (let t = 0; t < 256; t++) IS_WATER[t] = t === DEEP || t === WATER;

function hash3(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ palette

type RGB = readonly [number, number, number];

interface SeasonPal {
  grass: RGB;
  grassBare: RGB;
  forest: RGB;
  forestBare: RGB;
  tuft: RGB;
  tuftLight: RGB;
  crown: RGB;
  crownShade: RGB;
  shrub: RGB;
}

// spring, summer, autumn, winter: muted greens, dry earth, no yellow cast
const SEASONS: SeasonPal[] = [
  {
    grass: [104, 136, 76],
    grassBare: [140, 127, 96],
    forest: [64, 94, 60],
    forestBare: [102, 96, 74],
    tuft: [80, 114, 60],
    tuftLight: [132, 158, 98],
    crown: [74, 110, 66],
    crownShade: [46, 70, 46],
    shrub: [98, 120, 74],
  },
  {
    grass: [110, 134, 72],
    grassBare: [146, 130, 96],
    forest: [62, 90, 56],
    forestBare: [104, 96, 72],
    tuft: [88, 114, 58],
    tuftLight: [140, 156, 94],
    crown: [72, 104, 60],
    crownShade: [46, 68, 42],
    shrub: [104, 118, 70],
  },
  {
    grass: [128, 126, 82],
    grassBare: [144, 126, 94],
    forest: [86, 90, 60],
    forestBare: [108, 96, 72],
    tuft: [112, 108, 66],
    tuftLight: [158, 146, 100],
    crown: [122, 106, 66],
    crownShade: [78, 68, 46],
    shrub: [120, 112, 72],
  },
  {
    grass: [116, 124, 108],
    grassBare: [128, 122, 108],
    forest: [62, 80, 68],
    forestBare: [96, 94, 84],
    tuft: [98, 108, 94],
    tuftLight: [146, 152, 138],
    crown: [66, 88, 74],
    crownShade: [44, 60, 52],
    shrub: [104, 112, 98],
  },
];

const C_DEEP: RGB = [46, 80, 104];
const C_WATER: RGB = [61, 102, 128];
const C_SAND: RGB = [184, 167, 126];
const C_DESERT: RGB = [166, 143, 104];
const C_ROCK: RGB = [121, 116, 107];
const C_ROCK_HIGH: RGB = [156, 151, 142];
const C_WALL: RGB = [98, 92, 84];
const C_DRY: RGB = [150, 133, 98];

const CSS_SHORE = 'rgba(160,190,204,0.8)';
const CSS_SAND_DARK = 'rgb(160,143,104)';
const CSS_SAND_LIGHT = 'rgb(206,192,154)';
const CSS_DESERT_DARK = 'rgb(140,118,84)';
const CSS_DESERT_LIGHT = 'rgb(190,170,130)';
const CSS_STONE = 'rgb(150,145,135)';
const CSS_STONE_SHADE = 'rgb(88,84,78)';
const CSS_MORTAR = 'rgb(62,58,54)';

/** Ground brightness of grass/forest by food level q (0 bare .. 7 bloom). */
const FOOD_MIX = [0, 0.3, 0.5, 0.66, 0.8, 0.92, 1, 1];

function mix(a: RGB, b: RGB, t: number, out: number[]): number[] {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

function mixPal(a: SeasonPal, b: SeasonPal, t: number): SeasonPal {
  const m = (x: RGB, y: RGB): RGB => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
  return {
    grass: m(a.grass, b.grass),
    grassBare: m(a.grassBare, b.grassBare),
    forest: m(a.forest, b.forest),
    forestBare: m(a.forestBare, b.forestBare),
    tuft: m(a.tuft, b.tuft),
    tuftLight: m(a.tuftLight, b.tuftLight),
    crown: m(a.crown, b.crown),
    crownShade: m(a.crownShade, b.crownShade),
    shrub: m(a.shrub, b.shrub),
  };
}

const css = (c: ArrayLike<number>): string => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;

// 16 fixed permutations of the 9 plant cells (3x3) of a tile
const PERMS: Uint8Array[] = [];
for (let p = 0; p < 16; p++) {
  const a = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  for (let i = 8; i > 0; i--) {
    const j = Math.floor(hash3(p, i, 91) * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  PERMS.push(Uint8Array.from(a));
}
const TREE_SLOTS = [0.3, 0.3, 0.7, 0.38, 0.42, 0.72];

// ------------------------------------------------------------------ cached canvases

interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Pixels per tile. */
  L: number;
  tx0: number;
  ty0: number;
  tw: number;
  th: number;
  /** Tile keys at the last paint, (tw+2) x (th+2) with a one-tile margin; 0 = not painted. */
  keys: Uint32Array;
  /** Palette version painted with (-1 = never painted). */
  pal: number;
  /** Key version last synced against. */
  ver: number;
  /** Frame this surface was last drawn. */
  used: number;
  bytes: number;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

export class TerrainLayer {
  private world: WorldState | null = null;
  private W = 0;
  private H = 0;
  private ts = 8;
  private version = -1;
  // static per tile (rebuilt when terrain changes)
  private corner = new Uint8Array(0);
  private shore = new Uint8Array(0);
  private band = new Uint8Array(0);
  // dynamic per tile
  private keys = new Uint32Array(0);
  private gkey = new Uint16Array(0);
  private keysVer = 1;
  private cap = 1;
  // palette
  private pal: SeasonPal = SEASONS[0];
  private palKey = -1;
  private palVer = 0;
  private cssCache: (string | undefined)[] = new Array(4096);
  private tuftCss = '';
  private tuftLightCss = '';
  private crownCss = '';
  private crownShadeCss = '';
  private shrubCss = '';
  private rgb = [0, 0, 0];
  // ground colours, one texel per tile
  private ground: HTMLCanvasElement = makeCanvas(1, 1);
  private groundCtx: CanvasRenderingContext2D = this.ground.getContext('2d')!;
  private groundImg: ImageData | null = null;
  // caches
  private overview: Surface | null = null;
  private ovL = PX;
  private chunks = new Map<number, Surface>();
  private bytes = 0;
  private pool: HTMLCanvasElement[] = [];
  // scratch
  private stamp = new Int32Array(0);
  private stampVal = 1;
  private list = new Int32Array(1024);
  private list2 = new Int32Array(1024);
  private cuts = new Float64Array(1024);
  private frame = 0;
  private deadline = 0;
  /** Sim tick of the last vegetation update (-1 = never). */
  vegTick = -1;
  /** Bumped whenever the overview's pixels change (the minimap redraws its thumbnail). */
  revision = 0;
  /** Last frame's level: 0 overview, 16..128 chunks, -1 direct (for tests and tuning). */
  lastLevel = 0;

  /** Forget everything (new simulation). */
  reset(): void {
    this.world = null;
    this.version = -1;
    this.vegTick = -1;
    this.palKey = -1;
    this.dropChunks();
    this.overview = null;
  }

  private dropChunks(): void {
    for (const c of this.chunks.values()) this.release(c);
    this.chunks.clear();
    this.bytes = 0;
  }

  private release(s: Surface): void {
    if (this.pool.length < 24 && s.canvas.width === CHUNK_PX && s.canvas.height === CHUNK_PX) this.pool.push(s.canvas);
    else {
      s.canvas.width = 1;
      s.canvas.height = 1;
    }
  }

  // ---------------------------------------------------------------- terrain and keys

  /** Make sure the static tile data reflects `world`. Returns true when anything was rebuilt. */
  syncTerrain(world: WorldState): boolean {
    const W = world.width;
    const H = world.height;
    const fresh = world !== this.world || W !== this.W || H !== this.H;
    if (!fresh && world.terrainVersion === this.version) return false;
    this.version = world.terrainVersion;
    if (fresh) {
      this.world = world;
      this.W = W;
      this.H = H;
      this.ts = world.tileSize > 0 ? world.tileSize : 8;
      const N = W * H;
      this.corner = new Uint8Array(N);
      this.shore = new Uint8Array(N);
      this.band = new Uint8Array(N);
      this.keys = new Uint32Array(N);
      this.gkey = new Uint16Array(N);
      this.stamp = new Int32Array(N);
      this.ground = makeCanvas(W, H);
      this.groundCtx = this.ground.getContext('2d')!;
      this.groundImg = this.groundCtx.createImageData(W, H);
      this.dropChunks();
      this.ovL = Math.max(1, Math.min(PX, Math.floor(4096 / Math.max(W, H))));
      const ov = this.ovL;
      const c = makeCanvas(W * ov, H * ov);
      this.overview = { canvas: c, ctx: c.getContext('2d')!, L: ov, tx0: 0, ty0: 0, tw: W, th: H, keys: new Uint32Array((W + 2) * (H + 2)), pal: -1, ver: 0, used: 0, bytes: 0 };
      this.vegTick = -1;
    }
    this.computeStatic(world);
    this.computeKeys(world, this.cap);
    if (fresh) {
      this.ensurePalette(undefined, true);
      this.paintFull(this.overview!);
    }
    return true;
  }

  /** Corner rounding masks, shore masks and elevation bands for every tile. */
  private computeStatic(world: WorldState): void {
    const W = this.W;
    const H = this.H;
    const t = world.terrain;
    const e = world.elevation;
    const corner = this.corner;
    const shore = this.shore;
    const band = this.band;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const tt = t[i];
        const n = y > 0 ? t[i - W] : tt;
        const s = y < H - 1 ? t[i + W] : tt;
        const w = x > 0 ? t[i - 1] : tt;
        const ea = x < W - 1 ? t[i + 1] : tt;
        // shore: edges where water meets anything else (N, E, S, W)
        const wt = IS_WATER[tt];
        let sm = 0;
        if (IS_WATER[n] !== wt) sm |= 1;
        if (IS_WATER[ea] !== wt) sm |= 2;
        if (IS_WATER[s] !== wt) sm |= 4;
        if (IS_WATER[w] !== wt) sm |= 8;
        shore[i] = sm;
        // convex corners: TL bit0, TR bit1, BL bit2, BR bit3 (walls stay square)
        let cm = 0;
        if (tt !== WALL && x > 0 && x < W - 1 && y > 0 && y < H - 1) {
          if (w === n && w !== tt && w !== WALL && t[i - W - 1] === w) cm |= 1;
          if (ea === n && ea !== tt && ea !== WALL && t[i - W + 1] === ea) cm |= 2;
          if (w === s && w !== tt && w !== WALL && t[i + W - 1] === w) cm |= 4;
          if (ea === s && ea !== tt && ea !== WALL && t[i + W + 1] === ea) cm |= 8;
        }
        corner[i] = cm;
        let ev = e[i];
        if (!(ev >= 0)) ev = 0;
        else if (ev > 1) ev = 1;
        band[i] = tt === ROCK ? Math.min(7, Math.floor(Math.max(0, ev - 0.45) * 16)) : Math.min(7, Math.floor(ev * 8));
      }
    }
  }

  /** Tile keys from terrain, food and fertility. Updates the ground texels of changed tiles. */
  private computeKeys(world: WorldState, cap: number): boolean {
    const W = this.W;
    const N = W * this.H;
    const terr = world.terrain;
    const food = world.food;
    const fert = world.fertility;
    const keys = this.keys;
    const gkey = this.gkey;
    const corner = this.corner;
    const shore = this.shore;
    const band = this.band;
    const img = this.groundImg!.data;
    const rgb = this.rgb;
    let minX = W;
    let minY = this.H;
    let maxX = -1;
    let maxY = -1;
    let changed = false;
    for (let i = 0; i < N; i++) {
      const t = terr[i];
      let q = 0;
      let dry = 0;
      if (t >= SAND && t <= ROCK) {
        const mf = MAX_FOOD[t] * cap;
        const r = mf > 0 ? food[i] / mf : 0;
        if (r >= 0.06) {
          q = 1 + ((r * 5) | 0);
          if (q > 7) q = 7;
        }
        if (t === GRASS || t === FOREST) {
          const fe = fert[i];
          dry = fe >= 0.8 ? 0 : fe >= 0.55 ? 1 : fe >= 0.3 ? 2 : 3;
        }
      }
      const g = t | (q << 3) | (dry << 6) | (band[i] << 8);
      const k = (KEY_VALID | g | (corner[i] << 11) | (shore[i] << 15)) >>> 0;
      if (k === keys[i]) continue;
      keys[i] = k;
      changed = true;
      if (gkey[i] === g && img[i * 4 + 3] === 255) continue;
      gkey[i] = g;
      this.groundRGB(g, rgb);
      const o = i * 4;
      img[o] = rgb[0];
      img[o + 1] = rgb[1];
      img[o + 2] = rgb[2];
      img[o + 3] = 255;
      const x = i % W;
      const y = (i - x) / W;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (maxX >= 0) this.groundCtx.putImageData(this.groundImg!, 0, 0, minX, minY, maxX - minX + 1, maxY - minY + 1);
    if (changed) this.keysVer++;
    return changed;
  }

  /** Ground colour of a ground key (terrain | food level << 3 | dryness << 6 | band << 8). */
  private groundRGB(g: number, out: number[]): number[] {
    const t = g & 7;
    const q = (g >> 3) & 7;
    const dry = (g >> 6) & 3;
    const b = (g >> 8) & 7;
    const p = this.pal;
    switch (t) {
      case DEEP:
        out[0] = C_DEEP[0];
        out[1] = C_DEEP[1];
        out[2] = C_DEEP[2];
        return out;
      case WATER:
        out[0] = C_WATER[0];
        out[1] = C_WATER[1];
        out[2] = C_WATER[2];
        return out;
      case GRASS:
        mix(p.grassBare, p.grass, FOOD_MIX[q], out);
        break;
      case FOREST:
        mix(p.forestBare, p.forest, FOOD_MIX[q], out);
        break;
      case SAND:
        mix(C_SAND, C_SAND, 0, out);
        break;
      case DESERT:
        mix(C_DESERT, C_DESERT, 0, out);
        break;
      case ROCK:
        mix(C_ROCK, C_ROCK_HIGH, b / 7, out);
        return out;
      default:
        mix(C_WALL, C_WALL, 0, out);
        return out;
    }
    if (dry > 0) {
      const k = dry * 0.16;
      out[0] += (C_DRY[0] - out[0]) * k;
      out[1] += (C_DRY[1] - out[1]) * k;
      out[2] += (C_DRY[2] - out[2]) * k;
    }
    const br = 0.95 + b * 0.014;
    out[0] *= br;
    out[1] *= br;
    out[2] *= br;
    return out;
  }

  private groundCss(g: number): string {
    let s = this.cssCache[g];
    if (s === undefined) {
      s = css(this.groundRGB(g, this.rgb));
      this.cssCache[g] = s;
    }
    return s;
  }

  /** Season palette (quantised blend over the last 30% of each season). Returns true when it changed. */
  private ensurePalette(env: EnvState | undefined, force = false): boolean {
    const season = env ? env.season & 3 : 0;
    const prog = env ? Math.max(0, Math.min(1, env.seasonProgress || 0)) : 0;
    let blend = (prog - 0.7) / 0.3;
    blend = blend < 0 ? 0 : blend > 1 ? 1 : blend * blend * (3 - 2 * blend);
    const step = Math.round(blend * 4);
    const key = season * 8 + step;
    if (!force && key === this.palKey) return false;
    this.palKey = key;
    this.palVer++;
    this.pal = step === 0 ? SEASONS[season] : mixPal(SEASONS[season], SEASONS[(season + 1) & 3], step / 4);
    this.cssCache.fill(undefined);
    const p = this.pal;
    this.tuftCss = css(p.tuft);
    this.tuftLightCss = css(p.tuftLight);
    this.crownCss = css(p.crown);
    this.crownShadeCss = css(p.crownShade);
    this.shrubCss = css(p.shrub);
    // every ground texel changes colour
    if (this.groundImg) {
      const img = this.groundImg.data;
      const gkey = this.gkey;
      const rgb = this.rgb;
      for (let i = 0; i < gkey.length; i++) {
        this.groundRGB(gkey[i], rgb);
        const o = i * 4;
        img[o] = rgb[0];
        img[o + 1] = rgb[1];
        img[o + 2] = rgb[2];
        img[o + 3] = 255;
      }
      this.groundCtx.putImageData(this.groundImg, 0, 0);
    }
    return true;
  }

  /** Refresh food levels and the season palette. Cheap when nothing changed; call every few frames. */
  updateVegetation(world: WorldState, env: EnvState | undefined, foodCapacity: number, tick: number): void {
    if (world !== this.world || !this.groundImg) return;
    const cap = foodCapacity > 0 && Number.isFinite(foodCapacity) ? foodCapacity : 1;
    const palChanged = this.ensurePalette(env);
    if (tick === this.vegTick && cap === this.cap && !palChanged) return;
    this.vegTick = tick;
    this.cap = cap;
    this.computeKeys(world, cap);
    if (palChanged && this.overview) {
      // the overview must stay complete (minimap, fallback): repaint it now
      this.paintFull(this.overview);
    }
  }

  // ---------------------------------------------------------------- painting

  /** Repaint a whole surface. */
  private paintFull(s: Surface): void {
    const ctx = s.ctx;
    const L = s.L;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.ground, s.tx0, s.ty0, s.tw, s.th, 0, 0, s.tw * L, s.th * L);
    ctx.setTransform(L, 0, 0, L, -s.tx0 * L, -s.ty0 * L);
    const W = this.W;
    const H = this.H;
    const n = s.tw * s.th;
    const list = this.scratch(n);
    let k = 0;
    for (let y = s.ty0; y < s.ty0 + s.th; y++) for (let x = s.tx0; x < s.tx0 + s.tw; x++) list[k++] = y * W + x;
    // shore lines of the one-tile margin reach into this surface
    const mx0 = Math.max(0, s.tx0 - 1);
    const my0 = Math.max(0, s.ty0 - 1);
    const mx1 = Math.min(W, s.tx0 + s.tw + 1);
    const my1 = Math.min(H, s.ty0 + s.th + 1);
    const sl = this.scratch2((mx1 - mx0) * (my1 - my0));
    let sn = 0;
    const shore = this.shore;
    const corner = this.corner;
    for (let y = my0; y < my1; y++) {
      for (let x = mx0; x < mx1; x++) {
        const i = y * W + x;
        if (shore[i] || corner[i]) sl[sn++] = i;
      }
    }
    this.paintShapes(ctx, list, k, L, sl, sn);
    // remember keys (with margin)
    const keys = this.keys;
    const mw = s.tw + 2;
    for (let yy = -1; yy <= s.th; yy++) {
      const y = s.ty0 + yy;
      for (let xx = -1; xx <= s.tw; xx++) {
        const x = s.tx0 + xx;
        s.keys[(yy + 1) * mw + xx + 1] = x >= 0 && y >= 0 && x < W && y < H ? keys[y * W + x] : 0;
      }
    }
    s.pal = this.palVer;
    s.ver = this.keysVer;
    if (s === this.overview) this.revision++;
  }

  /**
   * Repaint the tiles of `s` whose keys changed (and tiles whose rounded corners take a changed
   * neighbour's colour). Returns false when it gave up because of the time budget.
   */
  private syncSurface(s: Surface, force: boolean): boolean {
    if (s.pal !== this.palVer) {
      if (!force && s.pal >= 0 && performance.now() > this.deadline) return false;
      this.paintFull(s);
      return true;
    }
    if (s.ver === this.keysVer) return true;
    if (!force && performance.now() > this.deadline) return false;
    const W = this.W;
    const H = this.H;
    const keys = this.keys;
    const corner = this.corner;
    const sk = s.keys;
    const mw = s.tw + 2;
    const x0 = s.tx0;
    const y0 = s.ty0;
    const x1 = x0 + s.tw;
    const y1 = y0 + s.th;
    const stamp = this.stamp;
    const sv = ++this.stampVal;
    let list = this.scratch(64);
    let n = 0;
    const add = (i: number, x: number, y: number) => {
      if (x < x0 || x >= x1 || y < y0 || y >= y1 || stamp[i] === sv) return;
      stamp[i] = sv;
      if (n >= list.length) list = this.growScratch(n * 2);
      list[n++] = i;
    };
    for (let yy = -1; yy <= s.th; yy++) {
      const y = y0 + yy;
      if (y < 0 || y >= H) continue;
      const row = y * W;
      const srow = (yy + 1) * mw + 1;
      for (let xx = -1; xx <= s.tw; xx++) {
        const x = x0 + xx;
        if (x < 0 || x >= W) continue;
        const i = row + x;
        const k = keys[i];
        if (sk[srow + xx] === k) continue;
        sk[srow + xx] = k;
        add(i, x, y);
        // neighbours whose rounded corners are filled with this tile's colour
        if (x > 0 && corner[i - 1] & 10) add(i - 1, x - 1, y);
        if (x < W - 1 && corner[i + 1] & 5) add(i + 1, x + 1, y);
      }
    }
    s.ver = this.keysVer;
    if (n === 0) return true;
    if (n > Math.min(1200, s.tw * s.th * 0.35)) {
      this.paintFull(s);
      return true;
    }
    this.paintDirty(s, list, n);
    if (s === this.overview) this.revision++;
    return true;
  }

  private paintDirty(s: Surface, list: Int32Array, n: number): void {
    const ctx = s.ctx;
    const L = s.L;
    const W = this.W;
    const H = this.H;
    ctx.save();
    ctx.setTransform(L, 0, 0, L, -s.tx0 * L, -s.ty0 * L);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const i = list[k];
      const x = i % W;
      ctx.rect(x, (i - x) / W, 1, 1);
    }
    ctx.clip();
    const gkey = this.gkey;
    let last = -1;
    for (let k = 0; k < n; k++) {
      const i = list[k];
      const g = gkey[i];
      if (g !== last) {
        ctx.fillStyle = this.groundCss(g);
        last = g;
      }
      const x = i % W;
      ctx.fillRect(x, (i - x) / W, 1, 1);
    }
    // shore lines of the dirty tiles and their neighbours
    const stamp = this.stamp;
    const sv = ++this.stampVal;
    const shore = this.shore;
    const corner = this.corner;
    let sl = this.scratch2(n * 9);
    let sn = 0;
    for (let k = 0; k < n; k++) {
      const i = list[k];
      const x = i % W;
      const y = (i - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (stamp[j] === sv || !(shore[j] || corner[j])) continue;
          stamp[j] = sv;
          if (sn >= sl.length) sl = this.growScratch2(sn * 2);
          sl[sn++] = j;
        }
      }
    }
    this.paintShapes(ctx, list, n, L, sl, sn);
    ctx.restore();
  }

  /**
   * Rounded corners, shore lines and detail of the tiles in list[0..n) (shore lines of sl[0..sn)).
   * ctx's transform maps one unit to one tile; `S` is device px per tile (level of detail, line widths).
   */
  private paintShapes(ctx: CanvasRenderingContext2D, list: Int32Array, n: number, S: number, sl: Int32Array, sn: number): void {
    const W = this.W;
    const terr = this.world!.terrain;
    const corner = this.corner;
    const gkey = this.gkey;
    // ---- rounded corners, batched by fill colour
    let nc = 0;
    let cuts = this.cuts;
    for (let k = 0; k < n; k++) {
      const i = list[k];
      const m = corner[i];
      if (!m) continue;
      for (let q = 0; q < 4; q++) {
        if (!((m >> q) & 1)) continue;
        const h = q & 1 ? i + 1 : i - 1;
        if (nc >= cuts.length) {
          const c2 = new Float64Array(cuts.length * 2);
          c2.set(cuts);
          cuts = this.cuts = c2;
        }
        cuts[nc++] = gkey[h] * 67108864 + i * 4 + q;
      }
    }
    if (nc > 0) {
      const sub = cuts.subarray(0, nc);
      sub.sort();
      let cur = -1;
      for (let k = 0; k < nc; k++) {
        const v = sub[k];
        const g = Math.floor(v / 67108864);
        const rest = v - g * 67108864;
        const i = Math.floor(rest / 4);
        const q = rest - i * 4;
        if (g !== cur) {
          if (cur >= 0) ctx.fill();
          ctx.fillStyle = this.groundCss(g);
          ctx.beginPath();
          cur = g;
        }
        const x = i % W;
        const y = (i - x) / W;
        const sx = q & 1;
        const sy = q >> 1;
        const px = x + sx;
        const py = y + sy;
        const cx = x + 0.5;
        const cy = y + 0.5;
        ctx.moveTo(px, py);
        ctx.lineTo(px, cy);
        ctx.arc(cx, cy, 0.5, sx ? 0 : Math.PI, sy ? HALF_PI : -HALF_PI, sx !== sy);
        ctx.closePath();
      }
      ctx.fill();
    }
    // ---- shore lines
    if (sn > 0 && S >= 4) {
      const shore = this.shore;
      ctx.beginPath();
      let any = false;
      for (let k = 0; k < sn; k++) {
        const i = sl[k];
        const t = terr[i];
        const x = i % W;
        const y = (i - x) / W;
        const m = corner[i];
        const wt = IS_WATER[t];
        if (wt) {
          const sm = shore[i];
          if (sm) {
            // straight parts of the edges facing land; a corner that is rounded on either side is left to its arc
            if (sm & 1) {
              const j = i - W;
              const a = m & 1 || corner[j] & 4 ? 0.5 : 0;
              const b = m & 2 || corner[j] & 8 ? 0.5 : 0;
              if (a + b < 1) {
                ctx.moveTo(x + a, y);
                ctx.lineTo(x + 1 - b, y);
                any = true;
              }
            }
            if (sm & 4) {
              const j = i + W;
              const a = m & 4 || corner[j] & 1 ? 0.5 : 0;
              const b = m & 8 || corner[j] & 2 ? 0.5 : 0;
              if (a + b < 1) {
                ctx.moveTo(x + a, y + 1);
                ctx.lineTo(x + 1 - b, y + 1);
                any = true;
              }
            }
            if (sm & 8) {
              const j = i - 1;
              const a = m & 1 || corner[j] & 2 ? 0.5 : 0;
              const b = m & 4 || corner[j] & 8 ? 0.5 : 0;
              if (a + b < 1) {
                ctx.moveTo(x, y + a);
                ctx.lineTo(x, y + 1 - b);
                any = true;
              }
            }
            if (sm & 2) {
              const j = i + 1;
              const a = m & 2 || corner[j] & 1 ? 0.5 : 0;
              const b = m & 8 || corner[j] & 4 ? 0.5 : 0;
              if (a + b < 1) {
                ctx.moveTo(x + 1, y + a);
                ctx.lineTo(x + 1, y + 1 - b);
                any = true;
              }
            }
          }
        }
        if (m) {
          for (let q = 0; q < 4; q++) {
            if (!((m >> q) & 1)) continue;
            const h = q & 1 ? i + 1 : i - 1;
            if (IS_WATER[terr[h]] === wt) continue;
            const sx = q & 1;
            const sy = q >> 1;
            ctx.moveTo(x + sx, y + 0.5);
            ctx.arc(x + 0.5, y + 0.5, 0.5, sx ? 0 : Math.PI, sy ? HALF_PI : -HALF_PI, sx !== sy);
            any = true;
          }
        }
      }
      if (any) {
        const lw = Math.max(0.9, Math.min(2.2, S * 0.045));
        ctx.lineWidth = lw / S;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = CSS_SHORE;
        ctx.stroke();
      }
    }
    if (S < 12) return;
    this.paintDetail(ctx, list, n, S);
  }

  /** Plants, tree crowns, stones, speckles and wall blocks (S >= 12 device px per tile). */
  private paintDetail(ctx: CanvasRenderingContext2D, list: Int32Array, n: number, S: number): void {
    const W = this.W;
    const terr = this.world!.terrain;
    const corner = this.corner;
    const gkey = this.gkey;
    const lod = S < 28 ? 1 : S < 80 ? 2 : 3;
    const px = 1 / S;
    // is (u,v) with radius r clear of the tile's rounded-off corners?
    const clear = (m: number, u: number, v: number, r: number): boolean => {
      if (!m) return true;
      const q = (u > 0.5 ? 1 : 0) | (v > 0.5 ? 2 : 0);
      if (!((m >> q) & 1)) return true;
      const du = u - 0.5;
      const dv = v - 0.5;
      return Math.sqrt(du * du + dv * dv) + r <= 0.48;
    };
    let hasSand = false;
    let hasDesert = false;
    let hasRock = false;
    let hasGrass = false;
    let hasForest = false;
    let hasWall = false;
    let hasShrub = false;
    for (let k = 0; k < n; k++) {
      const t = terr[list[k]];
      if (t === SAND) hasSand = true;
      else if (t === DESERT) hasDesert = true;
      else if (t === ROCK) hasRock = true;
      else if (t === GRASS) hasGrass = true;
      else if (t === FOREST) hasForest = true;
      else if (t === WALL) hasWall = true;
      if ((t === SAND || t === DESERT || t === ROCK) && ((gkey[list[k]] >> 3) & 7) >= 2) hasShrub = true;
    }
    // ---- speckles on sand and desert
    const speck = (type: number, tone: number, style: string) => {
      ctx.fillStyle = style;
      ctx.beginPath();
      const cnt = lod === 1 ? 3 : lod === 2 ? 6 : 10;
      const sz = Math.max(1.1 * px, 0.022);
      for (let k = 0; k < n; k++) {
        const i = list[k];
        if (terr[i] !== type) continue;
        const x = i % W;
        const y = (i - x) / W;
        const m = corner[i];
        for (let j = tone; j < cnt; j += 2) {
          const u = 0.06 + hash3(x, y, 40 + j) * 0.88;
          const v = 0.06 + hash3(x, y, 60 + j) * 0.88;
          if (!clear(m, u, v, sz)) continue;
          ctx.rect(x + u, y + v, sz, sz);
        }
      }
      ctx.fill();
    };
    if (hasSand) {
      speck(SAND, 0, CSS_SAND_DARK);
      speck(SAND, 1, CSS_SAND_LIGHT);
    }
    if (hasDesert) {
      speck(DESERT, 0, CSS_DESERT_DARK);
      speck(DESERT, 1, CSS_DESERT_LIGHT);
    }
    // ---- stones on rock (and the odd pebble in the desert)
    if (hasRock || hasDesert) {
      for (let pass = 0; pass < 2; pass++) {
        ctx.fillStyle = pass === 0 ? CSS_STONE_SHADE : CSS_STONE;
        ctx.beginPath();
        const ox = pass === 0 ? 0.025 : 0;
        const oy = pass === 0 ? 0.03 : 0;
        for (let k = 0; k < n; k++) {
          const i = list[k];
          const t = terr[i];
          if (t !== ROCK && t !== DESERT) continue;
          const x = i % W;
          const y = (i - x) / W;
          const m = corner[i];
          const cnt = t === ROCK ? 1 + Math.floor(hash3(x, y, 7) * 3) : hash3(x, y, 7) < 0.35 ? 1 : 0;
          for (let j = 0; j < cnt; j++) {
            const rs = (t === ROCK ? 0.07 + hash3(x, y, 11 + j) * 0.08 : 0.04 + hash3(x, y, 11 + j) * 0.03) * (pass === 0 ? 1 : 0.92);
            const u = rs + 0.06 + hash3(x, y, 13 + j) * (0.82 - rs * 2);
            const v = rs + 0.06 + hash3(x, y, 17 + j) * (0.8 - rs * 2);
            if (!clear(m, u, v, rs + 0.03)) continue;
            const cx = x + u + ox;
            const cy = y + v + oy;
            if (lod === 1) {
              ctx.moveTo(cx + rs, cy);
              ctx.arc(cx, cy, rs, 0, Math.PI * 2);
              continue;
            }
            // a rounded six-sided stone, a little flatter than tall
            for (let s = 0; s < 6; s++) {
              const ang = (s / 6) * Math.PI * 2 + hash3(x, y, 19 + j) * 1.2;
              const rr = rs * (0.78 + hash3(x + s, y, 23 + j) * 0.32);
              const vx = cx + Math.cos(ang) * rr;
              const vy = cy + Math.sin(ang) * rr * 0.78;
              if (s === 0) ctx.moveTo(vx, vy);
              else ctx.lineTo(vx, vy);
            }
            ctx.closePath();
          }
        }
        ctx.fill();
      }
    }
    // ---- sparse shrubs where sand, desert or rock holds some food
    if (hasShrub) {
      ctx.fillStyle = this.shrubCss;
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const i = list[k];
        const t = terr[i];
        if (t !== SAND && t !== DESERT && t !== ROCK) continue;
        const q = (gkey[i] >> 3) & 7;
        if (q < 2) continue;
        const x = i % W;
        const y = (i - x) / W;
        const m = corner[i];
        const cnt = Math.min(3, q - 1);
        for (let j = 0; j < cnt; j++) {
          const r = 0.045 + hash3(x, y, 31 + j) * 0.025;
          const u = 0.12 + hash3(x, y, 33 + j) * 0.76;
          const v = 0.12 + hash3(x, y, 35 + j) * 0.76;
          if (!clear(m, u, v, r)) continue;
          ctx.moveTo(x + u + r, y + v);
          ctx.arc(x + u, y + v, r, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
    // ---- grass: plants whose number and size follow the tile's food
    if (hasGrass) {
      const tuftPass = (light: boolean) => {
        ctx.beginPath();
        for (let k = 0; k < n; k++) {
          const i = list[k];
          if (terr[i] !== GRASS) continue;
          const q = (gkey[i] >> 3) & 7;
          if (q === 0) continue;
          const x = i % W;
          const y = (i - x) / W;
          const m = corner[i];
          const perm = PERMS[(hash3(x, y, 3) * 16) | 0];
          const sz = 0.1 + q * 0.012;
          for (let j = 0; j < q; j++) {
            const c = perm[j];
            const cu = c % 3;
            const cv = (c - cu) / 3;
            const u = (cu + 0.5 + (hash3(x, y, 50 + j) - 0.5) * 0.55) / 3;
            const v = (cv + 0.62 + (hash3(x, y, 70 + j) - 0.5) * 0.45) / 3;
            if (lod === 1) {
              if (light) continue;
              const r = sz * 0.42;
              if (!clear(m, u, v, r) || u < r || v < r || u > 1 - r || v > 1 - r) continue;
              ctx.rect(x + u - r, y + v - r, r * 2, r * 2);
              continue;
            }
            const h = sz * (0.9 + hash3(x, y, 90 + j) * 0.3);
            const bu = Math.min(1 - h * 0.62, Math.max(h * 0.62, u));
            const bv = Math.min(0.97, Math.max(h * 1.15, v));
            if (!clear(m, bu, bv - h * 0.5, h * 0.65)) continue;
            const bx = x + bu;
            const by = y + bv;
            if (light) {
              ctx.moveTo(bx, by);
              ctx.lineTo(bx + h * 0.06, by - h * 1.1);
            } else {
              ctx.moveTo(bx - h * 0.12, by);
              ctx.lineTo(bx - h * 0.58, by - h * 0.82);
              ctx.moveTo(bx + h * 0.12, by);
              ctx.lineTo(bx + h * 0.6, by - h * 0.76);
            }
          }
        }
      };
      if (lod === 1) {
        ctx.fillStyle = this.tuftCss;
        tuftPass(false);
        ctx.fill();
      } else {
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(1.1 * px, lod === 2 ? 0.026 : 0.02);
        ctx.strokeStyle = this.tuftCss;
        tuftPass(false);
        ctx.stroke();
        ctx.strokeStyle = this.tuftLightCss;
        tuftPass(true);
        ctx.stroke();
      }
    }
    // ---- forest: tree crowns (fewer and smaller where the forest is stripped)
    if (hasForest) {
      for (let pass = 0; pass < 2; pass++) {
        ctx.fillStyle = pass === 0 ? this.crownShadeCss : this.crownCss;
        ctx.beginPath();
        const ox = pass === 0 ? 0.035 : 0;
        const oy = pass === 0 ? 0.045 : 0;
        for (let k = 0; k < n; k++) {
          const i = list[k];
          if (terr[i] !== FOREST) continue;
          const q = (gkey[i] >> 3) & 7;
          const x = i % W;
          const y = (i - x) / W;
          const m = corner[i];
          const cnt = q === 0 ? 1 : q <= 2 ? 2 : 3;
          for (let j = 0; j < cnt; j++) {
            let rr = (0.15 + Math.min(q, 6) * 0.019) * (0.9 + hash3(x, y, 120 + j) * 0.2);
            if (pass === 1) rr *= 0.94;
            const lim = rr * 1.1 + 0.03;
            let u = TREE_SLOTS[j * 2] + (hash3(x, y, 130 + j) - 0.5) * 0.14;
            let v = TREE_SLOTS[j * 2 + 1] + (hash3(x, y, 140 + j) - 0.5) * 0.14;
            u = Math.min(1 - lim - 0.04, Math.max(lim, u));
            v = Math.min(1 - lim - 0.05, Math.max(lim, v));
            if (!clear(m, u, v, rr * 0.8)) continue;
            const cx = x + u + ox;
            const cy = y + v + oy;
            ctx.moveTo(cx + rr, cy);
            ctx.arc(cx, cy, rr, 0, Math.PI * 2);
            if (lod >= 2) {
              const r1 = rr * 0.62;
              const r2 = rr * 0.58;
              ctx.moveTo(cx - rr * 0.45 + r1, cy + rr * 0.25);
              ctx.arc(cx - rr * 0.45, cy + rr * 0.25, r1, 0, Math.PI * 2);
              ctx.moveTo(cx + rr * 0.42 + r2, cy + rr * 0.3);
              ctx.arc(cx + rr * 0.42, cy + rr * 0.3, r2, 0, Math.PI * 2);
            }
          }
        }
        ctx.fill();
      }
    }
    // ---- walls as blocks (lines kept inside the tile)
    if (hasWall) {
      const lw = Math.max(1.2 * px, 0.035);
      const e = lw / 2;
      ctx.lineWidth = lw;
      ctx.lineCap = 'butt';
      ctx.strokeStyle = CSS_MORTAR;
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const i = list[k];
        if (terr[i] !== WALL) continue;
        const x = i % W;
        const y = (i - x) / W;
        ctx.moveTo(x, y + e);
        ctx.lineTo(x + 1, y + e);
        ctx.moveTo(x, y + 0.5);
        ctx.lineTo(x + 1, y + 0.5);
        ctx.moveTo(x + 0.5, y);
        ctx.lineTo(x + 0.5, y + 0.5);
        ctx.moveTo(x + e, y + 0.5);
        ctx.lineTo(x + e, y + 1);
        if (x + 1 >= W || terr[i + 1] !== WALL) {
          ctx.moveTo(x + 1 - e, y);
          ctx.lineTo(x + 1 - e, y + 1);
        }
        if (y + 1 >= this.H || terr[i + W] !== WALL) {
          ctx.moveTo(x, y + 1 - e);
          ctx.lineTo(x + 1, y + 1 - e);
        }
        if (x > 0 && terr[i - 1] !== WALL) {
          ctx.moveTo(x + e, y);
          ctx.lineTo(x + e, y + 0.5);
        }
      }
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------- scratch buffers

  private scratch(n: number): Int32Array {
    if (this.list.length < n) this.list = new Int32Array(Math.max(n, this.list.length * 2));
    return this.list;
  }

  private growScratch(n: number): Int32Array {
    const a = new Int32Array(Math.max(n, 64));
    a.set(this.list.subarray(0, Math.min(this.list.length, a.length)));
    this.list = a;
    return a;
  }

  private scratch2(n: number): Int32Array {
    if (this.list2.length < n) this.list2 = new Int32Array(Math.max(n, this.list2.length * 2));
    return this.list2;
  }

  private growScratch2(n: number): Int32Array {
    const a = new Int32Array(Math.max(n, 64));
    a.set(this.list2.subarray(0, Math.min(this.list2.length, a.length)));
    this.list2 = a;
    return a;
  }

  // ---------------------------------------------------------------- chunks

  private chunk(L: number, cx: number, cy: number): Surface {
    const key = L * 4194304 + cy * 2048 + cx;
    let c = this.chunks.get(key);
    if (c) return c;
    const T = CHUNK_PX / L;
    const tx0 = cx * T;
    const ty0 = cy * T;
    const tw = Math.min(T, this.W - tx0);
    const th = Math.min(T, this.H - ty0);
    const w = tw * L;
    const h = th * L;
    let canvas: HTMLCanvasElement | undefined;
    if (w === CHUNK_PX && h === CHUNK_PX) canvas = this.pool.pop();
    if (!canvas) canvas = makeCanvas(w, h);
    c = { canvas, ctx: canvas.getContext('2d')!, L, tx0, ty0, tw, th, keys: new Uint32Array((tw + 2) * (th + 2)), pal: -1, ver: 0, used: this.frame, bytes: w * h * 4 };
    this.chunks.set(key, c);
    this.bytes += c.bytes;
    return c;
  }

  private evict(): void {
    if (this.bytes <= CACHE_LIMIT) return;
    const all = [...this.chunks.entries()].filter(([, c]) => c.used < this.frame).sort((a, b) => a[1].used - b[1].used);
    for (const [k, c] of all) {
      if (this.bytes <= CACHE_LIMIT * 0.8) break;
      this.chunks.delete(k);
      this.bytes -= c.bytes;
      this.release(c);
    }
  }

  // ---------------------------------------------------------------- drawing

  /**
   * Draw the ground into the world rectangle. ctx must be in world space (world units → device px).
   * `view` (visible world rectangle, CSS px per unit) is optional; without it the visible area is
   * taken from ctx's transform and canvas size.
   */
  draw(ctx: CanvasRenderingContext2D, worldW: number, worldH: number, view?: GroundView): void {
    const ov = this.overview;
    if (!this.world || !ov) return;
    this.frame++;
    const tf = ctx.getTransform();
    const a = tf.a;
    const d = tf.d;
    if (!(a > 0) || !(d > 0)) return;
    const W = this.W;
    const H = this.H;
    const ts = worldW / W;
    const S = a * ts;
    this.deadline = performance.now() + BUDGET_MS;
    let x0: number;
    let y0: number;
    let x1: number;
    let y1: number;
    if (view && Number.isFinite(view.x0) && Number.isFinite(view.x1) && Number.isFinite(view.y0) && Number.isFinite(view.y1)) {
      x0 = view.x0;
      y0 = view.y0;
      x1 = view.x1;
      y1 = view.y1;
    } else {
      x0 = -tf.e / a;
      y0 = -tf.f / d;
      x1 = (ctx.canvas.width - tf.e) / a;
      y1 = (ctx.canvas.height - tf.f) / d;
    }
    const tx0 = Math.max(0, Math.floor(x0 / ts));
    const ty0 = Math.max(0, Math.floor(y0 / ts));
    const tx1 = Math.min(W, Math.ceil(x1 / ts));
    const ty1 = Math.min(H, Math.ceil(y1 / ts));
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (S <= ov.L || tx1 <= tx0 || ty1 <= ty0) {
      this.lastLevel = 0;
      this.syncSurface(ov, true);
      ctx.imageSmoothingEnabled = S < ov.L;
      ctx.imageSmoothingQuality = S < ov.L * 0.5 ? 'medium' : 'low';
      ctx.drawImage(ov.canvas, 0, 0, worldW, worldH);
      return;
    }
    // keep the overview (minimap, fallback) reasonably fresh while zoomed in
    if (this.frame % 10 === 0) this.syncSurface(ov, false);

    if (S > DIRECT_FROM) {
      this.lastLevel = -1;
      this.drawDirect(ctx, tf, ts, tx0, ty0, tx1, ty1, S);
      return;
    }
    let L = LEVELS[LEVELS.length - 1];
    for (const l of LEVELS) {
      if (l >= S) {
        L = l;
        break;
      }
    }
    this.lastLevel = L;
    const T = CHUNK_PX / L;
    const cx0 = Math.floor(tx0 / T);
    const cy0 = Math.floor(ty0 / T);
    const cx1 = Math.floor((tx1 - 1) / T);
    const cy1 = Math.floor((ty1 - 1) / T);
    // paint: chunks nearest the centre first
    const mx = (cx0 + cx1) / 2;
    const my = (cy0 + cy1) / 2;
    const todo: Surface[] = [];
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) todo.push(this.chunk(L, cx, cy));
    todo.sort((p, q) => Math.abs(p.tx0 / T - mx) + Math.abs(p.ty0 / T - my) - (Math.abs(q.tx0 / T - mx) + Math.abs(q.ty0 / T - my)));
    let first = true;
    for (const c of todo) {
      c.used = this.frame;
      if (c.pal < 0) {
        if (first || performance.now() < this.deadline) {
          this.paintFull(c);
          first = false;
        }
      } else this.syncSurface(c, false);
    }
    // draw at whole device pixels so neighbouring chunks meet without seams
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const c of todo) {
      const dx0 = Math.round(tf.e + a * c.tx0 * ts);
      const dy0 = Math.round(tf.f + d * c.ty0 * ts);
      const dx1 = Math.round(tf.e + a * (c.tx0 + c.tw) * ts);
      const dy1 = Math.round(tf.f + d * (c.ty0 + c.th) * ts);
      if (c.pal >= 0) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'low';
        ctx.drawImage(c.canvas, 0, 0, c.canvas.width, c.canvas.height, dx0, dy0, dx1 - dx0, dy1 - dy0);
        continue;
      }
      // not painted yet: the coarser level if cached, else the overview
      const parent = L > LEVELS[0] ? this.chunks.get((L / 2) * 4194304 + Math.floor(c.ty0 / (T * 2)) * 2048 + Math.floor(c.tx0 / (T * 2))) : undefined;
      if (parent && parent.pal >= 0) {
        const pl = parent.L;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(parent.canvas, (c.tx0 - parent.tx0) * pl, (c.ty0 - parent.ty0) * pl, c.tw * pl, c.th * pl, dx0, dy0, dx1 - dx0, dy1 - dy0);
      } else {
        const ol = ov.L;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(ov.canvas, c.tx0 * ol, c.ty0 * ol, c.tw * ol, c.th * ol, dx0, dy0, dx1 - dx0, dy1 - dy0);
      }
    }
    ctx.setTransform(tf);
    this.evict();
  }

  /** Close zoom: ground texels for the visible tiles, then corners, shore and detail as vectors. */
  private drawDirect(ctx: CanvasRenderingContext2D, tf: DOMMatrix, ts: number, tx0: number, ty0: number, tx1: number, ty1: number, S: number): void {
    const W = this.W;
    const H = this.H;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.ground, tx0, ty0, tx1 - tx0, ty1 - ty0, tx0 * ts, ty0 * ts, (tx1 - tx0) * ts, (ty1 - ty0) * ts);
    ctx.setTransform(tf.a * ts, tf.b, tf.c, tf.d * ts, tf.e, tf.f);
    const n = (tx1 - tx0) * (ty1 - ty0);
    const list = this.scratch(n);
    let k = 0;
    for (let y = ty0; y < ty1; y++) for (let x = tx0; x < tx1; x++) list[k++] = y * W + x;
    const mx0 = Math.max(0, tx0 - 1);
    const my0 = Math.max(0, ty0 - 1);
    const mx1 = Math.min(W, tx1 + 1);
    const my1 = Math.min(H, ty1 + 1);
    const sl = this.scratch2((mx1 - mx0) * (my1 - my0));
    let sn = 0;
    for (let y = my0; y < my1; y++) {
      for (let x = mx0; x < mx1; x++) {
        const i = y * W + x;
        if (this.shore[i] || this.corner[i]) sl[sn++] = i;
      }
    }
    this.paintShapes(ctx, list, k, S, sl, sn);
    ctx.setTransform(tf);
  }

  /** Thumbnail draw (used by the minimap). */
  drawThumb(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    const ov = this.overview;
    if (!ov || ov.pal < 0) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(ov.canvas, x, y, w, h);
  }
}
