// OWNER: Rendering agent.
/**
 * Cached ground layers:
 *  - `base`  (PX px per tile): terrain colour, water depth, shoreline foam, grain. Static.
 *  - `veg`   (1 px per tile):  vegetation density/colour from food, fertility & season. Dynamic.
 *  - `shade` (PX px per tile): hillshade from elevation + canopy/rock texture. Static.
 * Static layers rebuild only when `world.terrainVersion` changes, and then only the dirty
 * rectangle of tiles that actually changed (cheap while painting terrain).
 */
import { TERRAIN_INFO } from '../sim/constants';
import { TERRAIN, type EnvState, type TerrainType, type WorldState } from '../sim/types';

export const PX = 4;

function hash3(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash3(xi, yi, s);
  const b = hash3(xi + 1, yi, s);
  const c = hash3(xi, yi + 1, s);
  const d = hash3(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const isWater = (t: number) => t === TERRAIN.Water || t === TERRAIN.DeepWater;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

// season palettes: [grass, forest, shrub] RGB; index = season (spring, summer, autumn, winter)
const SEASON_VEG: number[][][] = [
  [[88, 160, 70], [34, 106, 54], [112, 142, 72]],
  [[100, 150, 58], [30, 94, 44], [134, 132, 66]],
  [[150, 134, 60], [128, 86, 40], [146, 116, 64]],
  [[136, 146, 136], [50, 78, 70], [128, 128, 122]],
];

export class TerrainLayer {
  readonly base: HTMLCanvasElement;
  readonly shade: HTMLCanvasElement;
  readonly veg: HTMLCanvasElement;
  private baseCtx: CanvasRenderingContext2D;
  private shadeCtx: CanvasRenderingContext2D;
  private vegCtx: CanvasRenderingContext2D;
  private baseImg: ImageData | null = null;
  private shadeImg: ImageData | null = null;
  private vegImg: ImageData | null = null;
  private w = 0;
  private h = 0;
  private version = -1;
  private lastTerrain: Uint8Array | null = null;
  private dist = new Float32Array(0);
  private slope = new Float32Array(0);
  private world: WorldState | null = null;
  /** Sim tick of the last vegetation rebuild. */
  vegTick = -1;
  private vegSeasonKey = -1;
  /** Bumped whenever any layer's pixels change (minimap uses it). */
  revision = 0;
  private seasonCol = [0, 0, 0, 0, 0, 0, 0, 0, 0];

  constructor() {
    this.base = makeCanvas(1, 1);
    this.shade = makeCanvas(1, 1);
    this.veg = makeCanvas(1, 1);
    this.baseCtx = this.base.getContext('2d')!;
    this.shadeCtx = this.shade.getContext('2d')!;
    this.vegCtx = this.veg.getContext('2d')!;
  }

  /** Forget everything (new simulation). */
  reset(): void {
    this.version = -1;
    this.lastTerrain = null;
    this.world = null;
    this.vegTick = -1;
    this.vegSeasonKey = -1;
  }

  /** Make sure the static layers reflect `world`. Returns true when pixels were rebuilt. */
  syncTerrain(world: WorldState): boolean {
    const W = world.width;
    const H = world.height;
    const sizeChanged = W !== this.w || H !== this.h || this.world !== world || !this.lastTerrain;
    if (!sizeChanged && world.terrainVersion === this.version) return false;
    this.version = world.terrainVersion;
    let tx0 = 0;
    let ty0 = 0;
    let tx1 = W;
    let ty1 = H;
    if (sizeChanged) {
      this.w = W;
      this.h = H;
      this.world = world;
      this.base.width = W * PX;
      this.base.height = H * PX;
      this.shade.width = W * PX;
      this.shade.height = H * PX;
      this.veg.width = W;
      this.veg.height = H;
      this.baseImg = this.baseCtx.createImageData(W * PX, H * PX);
      this.shadeImg = this.shadeCtx.createImageData(W * PX, H * PX);
      this.vegImg = this.vegCtx.createImageData(W, H);
      this.dist = new Float32Array(W * H);
      this.slope = new Float32Array(W * H);
      this.lastTerrain = new Uint8Array(world.terrain);
      this.vegTick = -1;
    } else {
      // dirty rectangle of changed tiles
      const prev = this.lastTerrain!;
      const cur = world.terrain;
      let minX = W;
      let minY = H;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          if (prev[row + x] !== cur[row + x]) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return false;
      prev.set(cur);
      const m = 12; // water depth / shading influence radius
      tx0 = Math.max(0, minX - m);
      ty0 = Math.max(0, minY - m);
      tx1 = Math.min(W, maxX + m + 1);
      ty1 = Math.min(H, maxY + m + 1);
      this.vegTick = -1;
    }
    this.computeFields(world);
    this.paint(world, tx0, ty0, tx1, ty1);
    this.revision++;
    return true;
  }

  /** Distance-to-land (tiles) for water and hillshade per tile. */
  private computeFields(world: WorldState): void {
    const W = this.w;
    const H = this.h;
    const t = world.terrain;
    const e = world.elevation;
    const d = this.dist;
    const INF = 1e6;
    for (let i = 0; i < d.length; i++) d[i] = isWater(t[i]) ? INF : 0;
    const D = 1.4142;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let v = d[i];
        if (v === 0) continue;
        if (x > 0) v = Math.min(v, d[i - 1] + 1);
        if (y > 0) {
          v = Math.min(v, d[i - W] + 1);
          if (x > 0) v = Math.min(v, d[i - W - 1] + D);
          if (x < W - 1) v = Math.min(v, d[i - W + 1] + D);
        }
        d[i] = v;
      }
    }
    for (let y = H - 1; y >= 0; y--) {
      for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        let v = d[i];
        if (v === 0) continue;
        if (x < W - 1) v = Math.min(v, d[i + 1] + 1);
        if (y < H - 1) {
          v = Math.min(v, d[i + W] + 1);
          if (x < W - 1) v = Math.min(v, d[i + W + 1] + D);
          if (x > 0) v = Math.min(v, d[i + W - 1] + D);
        }
        d[i] = v;
      }
    }
    for (let i = 0; i < d.length; i++) if (d[i] >= INF) d[i] = 30;
    const s = this.slope;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const tt = t[i];
        if (isWater(tt)) {
          s[i] = 0;
          continue;
        }
        const ex = (e[y * W + Math.min(W - 1, x + 1)] - e[y * W + Math.max(0, x - 1)]) * 0.5;
        const ey = (e[Math.min(H - 1, y + 1) * W + x] - e[Math.max(0, y - 1) * W + x]) * 0.5;
        const k = tt === TERRAIN.Rock ? 34 : tt === TERRAIN.Wall ? 0 : 16;
        let v = (ex + ey) * k;
        // elevation step at shoreline
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        s[i] = v;
      }
    }
  }

  private paint(world: WorldState, tx0: number, ty0: number, tx1: number, ty1: number): void {
    const W = this.w;
    const H = this.h;
    const PW = W * PX;
    const terr = world.terrain;
    const elev = world.elevation;
    const dist = this.dist;
    const slope = this.slope;
    const bd = this.baseImg!.data;
    const sd = this.shadeImg!.data;
    const px0 = tx0 * PX;
    const py0 = ty0 * PX;
    const px1 = tx1 * PX;
    const py1 = ty1 * PX;
    const inv = 1 / PX;
    for (let py = py0; py < py1; py++) {
      const v = (py + 0.5) * inv - 0.5;
      let y0 = Math.floor(v);
      const fy = v - y0;
      let y1 = y0 + 1;
      if (y0 < 0) y0 = 0;
      if (y1 > H - 1) y1 = H - 1;
      const tyPlain = Math.min(H - 1, Math.floor((py + 0.5) * inv));
      for (let px = px0; px < px1; px++) {
        const u = (px + 0.5) * inv - 0.5;
        let x0 = Math.floor(u);
        const fx = u - x0;
        let x1 = x0 + 1;
        if (x0 < 0) x0 = 0;
        if (x1 > W - 1) x1 = W - 1;
        const i00 = y0 * W + x0;
        const i10 = y0 * W + x1;
        const i01 = y1 * W + x0;
        const i11 = y1 * W + x1;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        const e = elev[i00] * w00 + elev[i10] * w10 + elev[i01] * w01 + elev[i11] * w11;
        const dd = dist[i00] * w00 + dist[i10] * w10 + dist[i01] * w01 + dist[i11] * w11;
        let sh = slope[i00] * w00 + slope[i10] * w10 + slope[i01] * w01 + slope[i11] * w11;

        // organic (domain-warped) terrain lookup; walls stay crisp
        const txPlain = Math.min(W - 1, Math.floor((px + 0.5) * inv));
        let t = terr[tyPlain * W + txPlain] as TerrainType;
        if (t !== TERRAIN.Wall) {
          const wx = (vnoise(px * 0.21, py * 0.21, 11) - 0.5) * 0.9 + (hash3(px, py, 5) - 0.5) * 0.25;
          const wy = (vnoise(px * 0.21, py * 0.21, 23) - 0.5) * 0.9 + (hash3(px, py, 7) - 0.5) * 0.25;
          let tx = Math.floor((px + 0.5) * inv + wx);
          let ty = Math.floor((py + 0.5) * inv + wy);
          tx = tx < 0 ? 0 : tx >= W ? W - 1 : tx;
          ty = ty < 0 ? 0 : ty >= H ? H - 1 : ty;
          const tw = terr[ty * W + tx] as TerrainType;
          if (tw !== TERRAIN.Wall) t = tw;
        }
        const n = hash3(px, py, 3) - 0.5;
        const info = TERRAIN_INFO[t] ?? TERRAIN_INFO[TERRAIN.Grass];
        let r = info.color[0];
        let g = info.color[1];
        let b = info.color[2];
        let lum = 0; // shade-layer luminance delta (-1..1)

        if (t === TERRAIN.Water || t === TERRAIN.DeepWater) {
          // depth ramp: shallow → water → deep → abyss
          const dep = dd + (t === TERRAIN.DeepWater ? 1.2 : 0) + (0.5 - e) * 2;
          if (dep < 1.2) {
            const k = Math.max(0, dep) / 1.2;
            r = 64 + (36 - 64) * k;
            g = 124 + (86 - 124) * k;
            b = 150 + (124 - 150) * k;
          } else if (dep < 4) {
            const k = (dep - 1.2) / 2.8;
            r = 36 + (18 - 36) * k;
            g = 86 + (44 - 86) * k;
            b = 124 + (78 - 124) * k;
          } else {
            const k = Math.min(1, (dep - 4) / 7);
            r = 18 + (8 - 18) * k;
            g = 44 + (24 - 44) * k;
            b = 78 + (50 - 78) * k;
          }
          if (dd < 0.75) {
            const f = ((0.75 - dd) / 0.75) * 0.55;
            r += (170 - r) * f;
            g += (205 - g) * f;
            b += (210 - b) * f;
          }
          const wave = vnoise(px * 0.18, py * 0.6, 31);
          lum = (wave - 0.5) * 0.14;
          r += n * 4;
          g += n * 5;
          b += n * 6;
          sh = 0;
        } else {
          const bright = 0.86 + 0.3 * (e - 0.5);
          r *= bright;
          g *= bright;
          b *= bright;
          switch (t) {
            case TERRAIN.Sand: {
              r += n * 12;
              g += n * 11;
              b += n * 8;
              lum = (hash3(px, py, 9) - 0.5) * 0.14;
              if (dd > 0) break;
              break;
            }
            case TERRAIN.Grass: {
              r += n * 8;
              g += n * 12;
              b += n * 6;
              lum = (hash3(px, py, 13) - 0.5) * 0.16 + (vnoise(px * 0.35, py * 0.35, 41) - 0.5) * 0.2;
              break;
            }
            case TERRAIN.Forest: {
              r += n * 6;
              g += n * 10;
              b += n * 6;
              const c = vnoise(px * 0.7, py * 0.7, 17);
              lum = (c - 0.5) * 0.95 + (hash3(px, py, 19) - 0.5) * 0.2;
              break;
            }
            case TERRAIN.Desert: {
              const dune = Math.sin(px * 0.55 + py * 0.22 + vnoise(px * 0.08, py * 0.08, 29) * 7);
              r += dune * 7 + n * 10;
              g += dune * 6 + n * 9;
              b += dune * 4 + n * 7;
              lum = dune * 0.08 + (hash3(px, py, 21) - 0.5) * 0.1;
              break;
            }
            case TERRAIN.Rock: {
              const crag = vnoise(px * 0.45, py * 0.45, 37);
              r += n * 16 + (crag - 0.5) * 20;
              g += n * 16 + (crag - 0.5) * 20;
              b += n * 16 + (crag - 0.5) * 22;
              lum = (crag - 0.5) * 0.6 + (hash3(px, py, 27) - 0.5) * 0.24;
              if (e > 0.72) {
                // snowy peaks
                const f = Math.min(1, (e - 0.72) * 4);
                r += (225 - r) * f;
                g += (230 - g) * f;
                b += (236 - b) * f;
              }
              break;
            }
            case TERRAIN.Wall: {
              const lx = px % PX;
              const ly = py % PX;
              const edge = lx === 0 || ly === 0 || lx === PX - 1 || ly === PX - 1;
              if (edge) {
                r *= 0.7;
                g *= 0.7;
                b *= 0.75;
              }
              lum = lx === 1 || ly === 1 ? 0.35 : edge ? -0.45 : 0.05;
              break;
            }
            default:
              r += n * 8;
              g += n * 8;
              b += n * 8;
          }
        }
        const o = (py * PW + px) * 4;
        bd[o] = r;
        bd[o + 1] = g;
        bd[o + 2] = b;
        bd[o + 3] = 255;
        let L = sh + lum;
        if (L > 1) L = 1;
        else if (L < -1) L = -1;
        if (L >= 0) {
          sd[o] = 255;
          sd[o + 1] = 250;
          sd[o + 2] = 232;
          sd[o + 3] = L * 70;
        } else {
          sd[o] = 0;
          sd[o + 1] = 6;
          sd[o + 2] = 22;
          sd[o + 3] = -L * 150;
        }
      }
    }
    this.baseCtx.putImageData(this.baseImg!, 0, 0, px0, py0, px1 - px0, py1 - py0);
    this.shadeCtx.putImageData(this.shadeImg!, 0, 0, px0, py0, px1 - px0, py1 - py0);
  }

  /** Recompute the vegetation layer (1 px/tile). Cheap (~25k tiles); call every few frames. */
  updateVegetation(world: WorldState, env: EnvState | undefined, foodCapacity: number, tick: number): void {
    if (!this.vegImg || world !== this.world) return;
    // season blend (cross-fade over the last 30% of each season)
    const season = env ? env.season | 0 : 0;
    const prog = env ? Math.max(0, Math.min(1, env.seasonProgress || 0)) : 0;
    let blend = (prog - 0.7) / 0.3;
    blend = blend < 0 ? 0 : blend > 1 ? 1 : blend * blend * (3 - 2 * blend);
    const seasonKey = season * 100 + Math.round(blend * 40);
    if (tick === this.vegTick && seasonKey === this.vegSeasonKey) return;
    this.vegTick = tick;
    this.vegSeasonKey = seasonKey;
    const sa = SEASON_VEG[season & 3];
    const sb = SEASON_VEG[(season + 1) & 3];
    const sc = this.seasonCol;
    for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) sc[k * 3 + c] = sa[k][c] + (sb[k][c] - sa[k][c]) * blend;

    const N = world.width * world.height;
    const terr = world.terrain;
    const food = world.food;
    const fert = world.fertility;
    const d = this.vegImg.data;
    const cap = foodCapacity > 0 ? foodCapacity : 1;
    const maxFoodOf = MAX_FOOD;
    for (let i = 0; i < N; i++) {
      const t = terr[i];
      const o = i * 4;
      const mf = maxFoodOf[t] * cap;
      let r = mf > 0 ? food[i] / mf : 0;
      if (!(r > 0)) r = 0;
      else if (r > 1.5) r = 1.5;
      let fe = fert[i];
      if (!(fe >= 0)) fe = 0;
      else if (fe > 1) fe = 1;
      let R = 0;
      let Gc = 0;
      let B = 0;
      let A = 0;
      if (t === TERRAIN.Grass || t === TERRAIN.Forest) {
        const forest = t === TERRAIN.Forest;
        const lr = forest ? sc[3] : sc[0];
        const lg = forest ? sc[4] : sc[1];
        const lb = forest ? sc[5] : sc[2];
        const br = forest ? 82 : 122;
        const bgc = forest ? 68 : 100;
        const bb = forest ? 46 : 64;
        const k = r >= 1 ? 1 : Math.pow(r, 0.75);
        R = br + (lr - br) * k;
        Gc = bgc + (lg - bgc) * k;
        B = bb + (lb - bb) * k;
        if (r > 1) {
          // overflowing (bloom): brighter, more saturated
          const x = (r - 1) * 1.2;
          R += (R * 0.9 - R) * x;
          Gc += (Math.min(255, Gc * 1.3) - Gc) * x;
          B += (B * 0.85 - B) * x;
        }
        const dry = (1 - fe) * (1 - fe);
        R += (160 - R) * dry * 0.8;
        Gc += (138 - Gc) * dry * 0.8;
        B += (86 - B) * dry * 0.8;
        A = forest ? 205 : 190;
      } else if (t === TERRAIN.Sand || t === TERRAIN.Desert || t === TERRAIN.Rock) {
        R = sc[6];
        Gc = sc[7];
        B = sc[8];
        A = Math.min(1, r) * 150 * Math.min(1, fe * 1.4 + 0.1);
      } else if (t === TERRAIN.Water) {
        R = 52;
        Gc = 128;
        B = 98;
        A = Math.min(1, r) * 80;
      }
      d[o] = R;
      d[o + 1] = Gc;
      d[o + 2] = B;
      d[o + 3] = A;
    }
    this.vegCtx.putImageData(this.vegImg, 0, 0);
    this.revision++;
  }

  /** Draw all ground layers into the world rectangle (ctx must be in world space). */
  draw(ctx: CanvasRenderingContext2D, worldW: number, worldH: number): void {
    if (!this.baseImg) return;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, 0, 0, worldW, worldH);
    ctx.drawImage(this.veg, 0, 0, worldW, worldH);
    ctx.drawImage(this.shade, 0, 0, worldW, worldH);
  }

  /** Thumbnail draw (used by the minimap). */
  drawThumb(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    if (!this.baseImg) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.base, x, y, w, h);
    ctx.drawImage(this.veg, x, y, w, h);
    ctx.drawImage(this.shade, x, y, w, h);
  }
}

const MAX_FOOD: number[] = [];
for (let t = 0; t < 8; t++) MAX_FOOD[t] = TERRAIN_INFO[t as TerrainType]?.maxFood ?? 0;
for (let t = 8; t < 256; t++) MAX_FOOD[t] = 0;
