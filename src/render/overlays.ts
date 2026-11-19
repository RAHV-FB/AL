// OWNER: map ground engineer (terrainLayer.ts, camera.ts, minimap.ts, overlays.ts).
/**
 * Data overlays drawn over the ground, one value per tile, never blurred:
 *   food, fertility, climate  per-tile colour from flat ramps
 *   density, disease          agents counted per tile and spread over the neighbouring tiles
 *   territory                 the owning tribe's colour per tile plus crisp border lines
 * Values are grouped into the classes the legend shows (five steps; climate: two slower, two faster),
 * so every colour on the map is one of the legend's colours and smooth fields read as clear bands.
 * Every overlay is a 1 texel per tile image drawn without smoothing, so tiles stay sharp at any
 * zoom. Rebuilt at a low cadence (and only when the sim tick advanced); drawing is a single blit.
 */
import type { Simulation } from '../sim/simulation';
import { TERRAIN, type Tribe } from '../sim/types';
import { hslToRgb, hueColor, makeRamp, type Ramp } from './colors';
import type { OverlayKind } from './renderer';

/** Width of the overlay legend panel (CSS px). */
export const LEGEND_WIDTH = 184;

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const C_PANEL = '#1c1b18';
const C_BORDER = '#3e3b34';
const C_TEXT = '#e8e3d8';
const C_MUTED = '#aba596';

// Flat ramps (no neon). stops: [t, r, g, b, a]
const RAMP = {
  // bare earth to deep green
  food: makeRamp([
    [0, 222, 208, 168, 220],
    [0.3, 200, 184, 120, 215],
    [0.55, 150, 166, 92, 215],
    [0.8, 86, 130, 70, 222],
    [1, 38, 90, 50, 232],
  ]),
  // sand to moss
  fertility: makeRamp([
    [0, 222, 196, 140, 215],
    [0.5, 180, 172, 106, 210],
    [1, 92, 124, 70, 215],
  ]),
  // transparent to ochre to rust
  density: makeRamp([
    [0, 214, 166, 72, 0],
    [0.12, 214, 166, 72, 90],
    [0.5, 212, 140, 64, 160],
    [1, 207, 91, 69, 210],
  ]),
  // muted yellow-green
  disease: makeRamp([
    [0, 178, 182, 102, 0],
    [0.15, 178, 182, 102, 95],
    [0.6, 160, 170, 76, 165],
    [1, 138, 154, 58, 215],
  ]),
  // rust where growth is suppressed, green where it is boosted
  climateDown: makeRamp([
    [0, 207, 91, 69, 0],
    [0.1, 207, 91, 69, 70],
    [1, 190, 70, 52, 190],
  ]),
  climateUp: makeRamp([
    [0, 120, 168, 96, 0],
    [0.1, 120, 168, 96, 70],
    [1, 84, 150, 78, 190],
  ]),
};

/** Ramp offsets (into a 256-entry RGBA table) of the legend's five classes: the colour at each class centre. */
const CLASS_OFS = [0, 1, 2, 3, 4].map((k) => Math.round(((k + 0.5) / 5) * 255) * 4);

/** Offset of the class that holds v (0..1): five equal classes, as in the legend. */
function classOfs(v: number): number {
  return CLASS_OFS[v >= 1 ? 4 : v > 0 ? Math.floor(v * 5) : 0];
}

/** Climate classes: mild and strong, the legend's inner and outer steps on each side of normal. */
const CLIMATE_MILD = Math.round(0.4 * 255) * 4;
const CLIMATE_STRONG = Math.round(0.8 * 255) * 4;

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

interface LegendSpec {
  title: string;
  ramp: Ramp | null;
  lo: string;
  hi: string;
  note?: string;
}

const LEGENDS: Record<Exclude<OverlayKind, 'none' | 'territory'>, LegendSpec> = {
  food: { title: 'Food', ramp: RAMP.food, lo: 'bare', hi: 'abundant' },
  fertility: { title: 'Soil fertility', ramp: RAMP.fertility, lo: 'degraded', hi: 'fertile' },
  density: { title: 'Population density', ramp: RAMP.density, lo: 'empty', hi: 'crowded' },
  disease: { title: 'Disease', ramp: RAMP.disease, lo: 'healthy', hi: 'outbreak', note: 'Ringed agents are infected' },
  climate: { title: 'Climate effect on regrowth', ramp: null, lo: 'slower', hi: 'faster' },
};

export class OverlayLayer {
  private tileC = canvas(1, 1);
  private tileCtx = this.tileC.getContext('2d')!;
  private tileImg: ImageData | null = null;
  private grid = new Float32Array(0);
  private tmp = new Float32Array(0);
  private kind: OverlayKind = 'none';
  private lastFrame = -1e9;
  private lastTick = -1;
  private lastSim: Simulation | null = null;
  // territory
  private borders = new Map<number, Path2D>();
  private territorySig = -1;
  private tribeTiles = new Map<number, number>();
  private rgb = [0, 0, 0];

  /** Rebuild overlay pixels if due. `frame` is the renderer's frame counter. */
  update(sim: Simulation, kind: OverlayKind, frame: number): void {
    if (kind === 'none') {
      this.kind = kind;
      return;
    }
    const tick = sim.state.tick;
    const changed = kind !== this.kind || sim !== this.lastSim;
    const cadence = kind === 'density' || kind === 'disease' ? 3 : kind === 'territory' ? 12 : 10;
    if (!changed && (tick === this.lastTick || frame - this.lastFrame < cadence)) return;
    this.kind = kind;
    this.lastSim = sim;
    this.lastFrame = frame;
    this.lastTick = tick;
    const world = sim.state.world;
    const W = world.width;
    const H = world.height;
    if (!this.tileImg || this.tileImg.width !== W || this.tileImg.height !== H) {
      this.tileC.width = W;
      this.tileC.height = H;
      this.tileImg = this.tileCtx.createImageData(W, H);
    }
    if (kind === 'territory') {
      this.buildTerritory(sim, changed);
      return;
    }
    if (kind === 'density' || kind === 'disease') {
      this.buildDensity(sim, kind);
      return;
    }
    const d = this.tileImg.data;
    const N = W * H;
    const terr = world.terrain;
    const put = (o: number, lut: Ramp, li: number) => {
      d[o] = lut[li];
      d[o + 1] = lut[li + 1];
      d[o + 2] = lut[li + 2];
      d[o + 3] = lut[li + 3];
    };
    if (kind === 'food') {
      const food = world.food;
      const cap = 16 * (sim.state.config.foodCapacity || 1);
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        const t = terr[i];
        if (t === TERRAIN.DeepWater || t === TERRAIN.Water || t === TERRAIN.Wall) {
          d[o + 3] = 0;
          continue;
        }
        let v = food[i] / cap;
        v = v > 0 ? Math.sqrt(v > 1 ? 1 : v) : 0;
        put(o, RAMP.food, classOfs(v));
      }
    } else if (kind === 'fertility') {
      const fert = world.fertility;
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        const t = terr[i];
        if (t === TERRAIN.DeepWater || t === TERRAIN.Water || t === TERRAIN.Wall) {
          d[o + 3] = 0;
          continue;
        }
        let v = fert[i];
        v = v > 1 ? 1 : v > 0 ? v : 0;
        put(o, RAMP.fertility, classOfs(v));
      }
    } else if (kind === 'climate') {
      const cm = world.climateMod;
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        const v = cm[i];
        const t = terr[i];
        // nothing grows on water or walls, so their regrowth rate means nothing
        if (!(Math.abs(v - 1) > 0.02) || t === TERRAIN.DeepWater || t === TERRAIN.Water || t === TERRAIN.Wall) {
          d[o + 3] = 0;
          continue;
        }
        // strong: regrowth at half or less, or at 1.75x or more
        if (v < 1) put(o, RAMP.climateDown, 1 - v >= 0.5 ? CLIMATE_STRONG : CLIMATE_MILD);
        else put(o, RAMP.climateUp, v - 1 >= 0.75 ? CLIMATE_STRONG : CLIMATE_MILD);
      }
    }
    this.tileCtx.putImageData(this.tileImg, 0, 0);
  }

  /** Agents (or infected agents, weighted by virulence) per tile, spread over the neighbouring tiles. */
  private buildDensity(sim: Simulation, kind: OverlayKind): void {
    const world = sim.state.world;
    const W = world.width;
    const H = world.height;
    const ts = world.tileSize > 0 ? world.tileSize : 8;
    const N = W * H;
    if (this.grid.length !== N) {
      this.grid = new Float32Array(N);
      this.tmp = new Float32Array(N);
    }
    const g = this.grid;
    g.fill(0);
    const agents = sim.state.agents;
    const disease = kind === 'disease';
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.alive) continue;
      let w = 1;
      if (disease) {
        if (!(a.infection > 0)) continue;
        w = 0.6 + (a.virulence || 0.5);
      }
      let cx = (a.x / ts) | 0;
      let cy = (a.y / ts) | 0;
      cx = cx < 0 ? 0 : cx >= W ? W - 1 : cx;
      cy = cy < 0 ? 0 : cy >= H ? H - 1 : cy;
      g[cy * W + cx] += w;
    }
    // three separable [1 2 1] passes: a smooth field about two tiles wide
    const t = this.tmp;
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const l = g[row + (x > 0 ? x - 1 : x)];
          const r = g[row + (x < W - 1 ? x + 1 : x)];
          t[row + x] = (l + 2 * g[row + x] + r) * 0.25;
        }
      }
      for (let y = 0; y < H; y++) {
        const up = (y > 0 ? y - 1 : y) * W;
        const dn = (y < H - 1 ? y + 1 : y) * W;
        const row = y * W;
        for (let x = 0; x < W; x++) g[row + x] = (t[up + x] + 2 * t[row + x] + t[dn + x]) * 0.25;
      }
    }
    let max = 0;
    for (let i = 0; i < N; i++) if (g[i] > max) max = g[i];
    const norm = 1 / Math.max(disease ? 0.08 : 0.25, max);
    const lut = disease ? RAMP.disease : RAMP.density;
    // below this a tile stays clear (a lone agent spread over its neighbours does not tint the land)
    const floor = disease ? 0.1 : 0.04;
    const d = this.tileImg!.data;
    for (let i = 0; i < N; i++) {
      let v = g[i] * norm;
      v = v > 1 ? 1 : v;
      if (disease) v = Math.sqrt(v);
      const o = i * 4;
      if (v < floor) {
        d[o + 3] = 0;
        continue;
      }
      const li = classOfs(v);
      d[o] = lut[li];
      d[o + 1] = lut[li + 1];
      d[o + 2] = lut[li + 2];
      d[o + 3] = lut[li + 3];
    }
    this.tileCtx.putImageData(this.tileImg!, 0, 0);
  }

  private buildTerritory(sim: Simulation, force: boolean): void {
    const world = sim.state.world;
    const W = world.width;
    const H = world.height;
    const ter = world.territory;
    if (!ter || ter.length !== W * H) return;
    // signature of territory + tribe hues
    let sig = 0;
    for (let i = 0; i < ter.length; i += 1) sig = (Math.imul(sig, 31) + ter[i] + 7) | 0;
    for (const t of sim.state.tribes) sig = (Math.imul(sig, 17) + t.id * 1000 + Math.round(t.hue)) | 0;
    if (!force && sig === this.territorySig) return;
    this.territorySig = sig;
    const d = this.tileImg!.data;
    const counts = this.tribeTiles;
    counts.clear();
    let lastId = -2;
    let lr = 0;
    let lg = 0;
    let lb = 0;
    for (let i = 0; i < ter.length; i++) {
      const id = ter[i];
      const o = i * 4;
      if (id < 0) {
        d[o + 3] = 0;
        continue;
      }
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (id !== lastId) {
        lastId = id;
        const tr = sim.getTribe(id);
        // the tribe colour used everywhere: hsl(hue, 45%, 58%)
        hslToRgb(tr ? tr.hue : (id * 137.5) % 360, 0.45, 0.58, this.rgb);
        lr = this.rgb[0];
        lg = this.rgb[1];
        lb = this.rgb[2];
      }
      d[o] = lr;
      d[o + 1] = lg;
      d[o + 2] = lb;
      d[o + 3] = 92;
    }
    this.tileCtx.putImageData(this.tileImg!, 0, 0);

    // vector borders along tile edges, merged into runs, one Path2D per tribe
    this.borders.clear();
    const ts = world.tileSize;
    const own = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : ter[y * W + x]);
    const pathOf = (id: number): Path2D => {
      let p = this.borders.get(id);
      if (!p) {
        p = new Path2D();
        this.borders.set(id, p);
      }
      return p;
    };
    const emit = (a: number, b: number, x0: number, y0: number, x1: number, y1: number) => {
      if (a >= 0) {
        const p = pathOf(a);
        p.moveTo(x0, y0);
        p.lineTo(x1, y1);
      }
      if (b >= 0 && b !== a) {
        const p = pathOf(b);
        p.moveTo(x0, y0);
        p.lineTo(x1, y1);
      }
    };
    // horizontal edges (between row y-1 and y), y = 0..H
    for (let y = 0; y <= H; y++) {
      let runA = -2;
      let runB = -2;
      let runStart = 0;
      for (let x = 0; x <= W; x++) {
        const a = x < W ? own(x, y - 1) : -3;
        const b = x < W ? own(x, y) : -3;
        const boundary = x < W && a !== b;
        if (runA !== -2 && (!boundary || a !== runA || b !== runB)) {
          emit(runA, runB, runStart * ts, y * ts, x * ts, y * ts);
          runA = -2;
        }
        if (boundary && runA === -2) {
          runA = a;
          runB = b;
          runStart = x;
        }
      }
    }
    // vertical edges (between col x-1 and x), x = 0..W
    for (let x = 0; x <= W; x++) {
      let runA = -2;
      let runB = -2;
      let runStart = 0;
      for (let y = 0; y <= H; y++) {
        const a = y < H ? own(x - 1, y) : -3;
        const b = y < H ? own(x, y) : -3;
        const boundary = y < H && a !== b;
        if (runA !== -2 && (!boundary || a !== runA || b !== runB)) {
          emit(runA, runB, x * ts, runStart * ts, x * ts, y * ts);
          runA = -2;
        }
        if (boundary && runA === -2) {
          runA = a;
          runB = b;
          runStart = y;
        }
      }
    }
  }

  /** Draw the overlay in world space (crisp: one texel per tile, no smoothing). */
  draw(ctx: CanvasRenderingContext2D, sim: Simulation, kind: OverlayKind, zoom: number): void {
    if (kind === 'none' || kind !== this.kind) return;
    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = kind === 'territory' ? 1 : 0.9;
    ctx.drawImage(this.tileC, 0, 0, sim.worldW, sim.worldH);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = smooth;
    if (kind === 'territory' && this.borders.size) {
      const ts = sim.state.world.tileSize || 8;
      const tilePx = ts * zoom;
      // 1 px lines from afar, up to 2 px once tiles are large
      const lw = tilePx < 12 ? 1 : tilePx < 40 ? 1.5 : 2;
      ctx.lineJoin = 'miter';
      ctx.lineCap = 'square';
      ctx.lineWidth = lw / zoom;
      for (const [id, path] of this.borders) {
        const tr = sim.getTribe(id);
        const hue = tr ? tr.hue : (id * 137.5) % 360;
        ctx.strokeStyle = hueColor(hue, 0.45, 0.58, 0.95);
        ctx.stroke(path);
      }
      ctx.lineCap = 'butt';
    }
  }

  /**
   * Draw a compact legend with its bottom-right corner at (right, bottom) in CSS px
   * (ctx in CSS-pixel screen space). Returns the legend height.
   */
  drawLegend(ctx: CanvasRenderingContext2D, sim: Simulation, kind: OverlayKind, right: number, bottom: number): number {
    if (kind === 'none') return 0;
    const pad = 10;
    const w = LEGEND_WIDTH;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    if (kind === 'territory') {
      const tribes: Tribe[] = [];
      for (const t of sim.state.tribes) if (t.extinctTick === -1 || (this.tribeTiles.get(t.id) ?? 0) > 0) tribes.push(t);
      tribes.sort((a, b) => (this.tribeTiles.get(b.id) ?? b.territory ?? 0) - (this.tribeTiles.get(a.id) ?? a.territory ?? 0));
      const shown = Math.min(6, tribes.length);
      const rowH = 18;
      const h = pad * 2 + 16 + Math.max(1, shown) * rowH + (tribes.length > shown ? 16 : 0);
      const x = right - w;
      const y = bottom - h;
      legendPanel(ctx, x, y, w, h);
      ctx.font = `600 12px ${FONT}`;
      ctx.fillStyle = C_TEXT;
      ctx.fillText('Tribal territory', x + pad, y + pad + 11);
      ctx.font = `12px ${FONT}`;
      if (!shown) {
        ctx.fillStyle = C_MUTED;
        ctx.fillText('No tribes yet', x + pad, y + pad + 32);
      }
      for (let i = 0; i < shown; i++) {
        const t = tribes[i];
        const yy = y + pad + 32 + i * rowH;
        ctx.fillStyle = hueColor(t.hue, 0.45, 0.58);
        ctx.fillRect(x + pad, yy - 9, 10, 10);
        ctx.fillStyle = C_TEXT;
        ctx.fillText(clip(t.name, 16), x + pad + 18, yy);
        ctx.fillStyle = C_MUTED;
        const tiles = this.tribeTiles.get(t.id) ?? t.territory ?? 0;
        const s = `${tiles} tiles`;
        ctx.fillText(s, x + w - pad - ctx.measureText(s).width, yy);
      }
      if (tribes.length > shown) {
        ctx.fillStyle = C_MUTED;
        ctx.fillText(`${tribes.length - shown} more`, x + pad, y + h - pad);
      }
      return h;
    }
    const spec = LEGENDS[kind];
    const h = spec.note ? 74 : 58;
    const x = right - w;
    const y = bottom - h;
    legendPanel(ctx, x, y, w, h);
    ctx.font = `600 12px ${FONT}`;
    ctx.fillStyle = C_TEXT;
    ctx.fillText(spec.title, x + pad, y + pad + 11);
    // the scale as five flat steps
    const bw = w - pad * 2;
    const by = y + 28;
    const steps = 5;
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      const sx = x + pad + Math.round((s * bw) / steps);
      const ex = x + pad + Math.round(((s + 1) * bw) / steps);
      if (kind === 'climate' && s === 2) {
        // normal regrowth has no colour on the map: an empty box
        ctx.strokeStyle = C_BORDER;
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 0.5, by + 0.5, ex - sx - 1, 7);
        continue;
      }
      ctx.fillStyle = stepColor(spec.ramp, t);
      ctx.fillRect(sx, by, ex - sx, 8);
    }
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = C_MUTED;
    ctx.fillText(spec.lo, x + pad, y + 50);
    ctx.fillText(spec.hi, x + w - pad - ctx.measureText(spec.hi).width, y + 50);
    if (kind === 'climate') {
      const s = 'normal';
      ctx.fillText(s, x + w / 2 - ctx.measureText(s).width / 2, y + 50);
    }
    if (spec.note) {
      ctx.fillStyle = C_MUTED;
      ctx.fillText(spec.note, x + pad, y + 66);
    }
    return h;
  }
}

/** Opaque colour of a ramp at t (climate: rust below the middle, green above). */
function stepColor(ramp: Ramp | null, t: number): string {
  let lut: Ramp;
  let v: number;
  if (ramp) {
    lut = ramp;
    v = t;
  } else {
    const u = t * 2 - 1;
    if (Math.abs(u) < 0.25) return '#6e6a5e';
    lut = u < 0 ? RAMP.climateDown : RAMP.climateUp;
    v = Math.abs(u);
  }
  const li = Math.max(0, Math.min(255, Math.round(v * 255))) * 4;
  return `rgb(${lut[li]},${lut[li + 1]},${lut[li + 2]})`;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Plain panel: flat fill, 1 px border, 2 px radius, no shadow (screen space). */
function legendPanel(ctx: CanvasRenderingContext2D, x0: number, y0: number, w0: number, h0: number): void {
  // half-pixel aligned so the 1 px border stays sharp
  const x = Math.round(x0) + 0.5;
  const y = Math.round(y0) + 0.5;
  const w = Math.round(w0) - 1;
  const h = Math.round(h0) - 1;
  const r = 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = C_PANEL;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = C_BORDER;
  ctx.stroke();
}
