// OWNER: Rendering agent.
/**
 * Data overlays drawn semi-transparently over the world:
 *   food, fertility, climate  → 1 px/tile image (smoothed)
 *   density, disease          → coarse agent bins, blurred
 *   territory                 → tribe-hued fill + vector border lines per tribe
 * Rebuilt at a low cadence (and only when the sim tick advanced); drawing is a single blit.
 */
import type { Simulation } from '../sim/simulation';
import { TERRAIN, type Tribe } from '../sim/types';
import { RAMPS, hslToRgb, hueColor, type Ramp } from './colors';
import type { OverlayKind } from './renderer';

const GRID_CELL = 16; // world units per density/disease bin

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
  food: { title: 'Food', ramp: RAMPS.food, lo: 'bare', hi: 'abundant' },
  fertility: { title: 'Soil fertility', ramp: RAMPS.fertility, lo: 'degraded', hi: 'fertile' },
  density: { title: 'Population density', ramp: RAMPS.density, lo: 'empty', hi: 'crowded' },
  disease: { title: 'Disease', ramp: RAMPS.disease, lo: 'healthy', hi: 'outbreak', note: 'glowing = infected' },
  climate: { title: 'Climate effect on regrowth', ramp: null, lo: 'suppressed', hi: 'boosted' },
};

export class OverlayLayer {
  private tileC = canvas(1, 1);
  private tileCtx = this.tileC.getContext('2d')!;
  private tileImg: ImageData | null = null;
  private gridC = canvas(1, 1);
  private gridCtx = this.gridC.getContext('2d')!;
  private gridImg: ImageData | null = null;
  private grid = new Float32Array(0);
  private tmp = new Float32Array(0);
  private gw = 0;
  private gh = 0;
  private kind: OverlayKind = 'none';
  private lastFrame = -1e9;
  private lastTick = -1;
  private lastSim: Simulation | null = null;
  /** Grid layer (density/disease) vs tile layer. */
  private usingGrid = false;
  // territory
  private borders = new Map<number, Path2D>();
  private territorySig = -1;
  private tribeTiles = new Map<number, number>();
  private rgb = [0, 0, 0];
  private legendBars = new Map<string, HTMLCanvasElement>();
  /** Max value seen in last density/disease build (for legend). */
  private gridMax = 0;

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
    if (kind === 'density' || kind === 'disease') {
      this.buildGrid(sim, kind);
      this.usingGrid = true;
      return;
    }
    this.usingGrid = false;
    const d = this.tileImg.data;
    const N = W * H;
    if (kind === 'territory') {
      this.buildTerritory(sim, changed);
      return;
    }
    if (kind === 'food') {
      const food = world.food;
      const cap = 16 * (sim.state.config.foodCapacity || 1);
      const lut = RAMPS.food;
      for (let i = 0; i < N; i++) {
        let v = food[i] / cap;
        v = v > 0 ? Math.sqrt(v > 1 ? 1 : v) : 0;
        const li = ((v * 255) | 0) * 4;
        const o = i * 4;
        d[o] = lut[li];
        d[o + 1] = lut[li + 1];
        d[o + 2] = lut[li + 2];
        d[o + 3] = lut[li + 3];
      }
    } else if (kind === 'fertility') {
      const fert = world.fertility;
      const terr = world.terrain;
      const lut = RAMPS.fertility;
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        const t = terr[i];
        if (t === TERRAIN.DeepWater || t === TERRAIN.Water || t === TERRAIN.Wall) {
          d[o + 3] = 0;
          continue;
        }
        let v = fert[i];
        v = v > 1 ? 1 : v > 0 ? v : 0;
        const li = ((v * 255) | 0) * 4;
        d[o] = lut[li];
        d[o + 1] = lut[li + 1];
        d[o + 2] = lut[li + 2];
        d[o + 3] = lut[li + 3];
      }
    } else if (kind === 'climate') {
      const cm = world.climateMod;
      const down = RAMPS.climateDown;
      const up = RAMPS.climateUp;
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        const v = cm[i];
        if (!(Math.abs(v - 1) > 0.02)) {
          d[o + 3] = 0;
          continue;
        }
        let li: number;
        let lut: Ramp;
        if (v < 1) {
          lut = down;
          li = ((Math.min(1, 1 - v) * 255) | 0) * 4;
        } else {
          lut = up;
          li = ((Math.min(1, (v - 1) / 1.5) * 255) | 0) * 4;
        }
        d[o] = lut[li];
        d[o + 1] = lut[li + 1];
        d[o + 2] = lut[li + 2];
        d[o + 3] = lut[li + 3];
      }
    }
    this.tileCtx.putImageData(this.tileImg, 0, 0);
  }

  private buildGrid(sim: Simulation, kind: OverlayKind): void {
    const gw = Math.max(1, Math.ceil(sim.worldW / GRID_CELL));
    const gh = Math.max(1, Math.ceil(sim.worldH / GRID_CELL));
    if (gw !== this.gw || gh !== this.gh) {
      this.gw = gw;
      this.gh = gh;
      this.grid = new Float32Array(gw * gh);
      this.tmp = new Float32Array(gw * gh);
      this.gridC.width = gw;
      this.gridC.height = gh;
      this.gridImg = this.gridCtx.createImageData(gw, gh);
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
      let cx = (a.x / GRID_CELL) | 0;
      let cy = (a.y / GRID_CELL) | 0;
      cx = cx < 0 ? 0 : cx >= gw ? gw - 1 : cx;
      cy = cy < 0 ? 0 : cy >= gh ? gh - 1 : cy;
      g[cy * gw + cx] += w;
    }
    // two separable [1 2 1] blur passes
    const t = this.tmp;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < gh; y++) {
        const row = y * gw;
        for (let x = 0; x < gw; x++) {
          const l = g[row + (x > 0 ? x - 1 : x)];
          const r = g[row + (x < gw - 1 ? x + 1 : x)];
          t[row + x] = (l + 2 * g[row + x] + r) * 0.25;
        }
      }
      for (let y = 0; y < gh; y++) {
        const up = (y > 0 ? y - 1 : y) * gw;
        const dn = (y < gh - 1 ? y + 1 : y) * gw;
        const row = y * gw;
        for (let x = 0; x < gw; x++) g[row + x] = (t[up + x] + 2 * t[row + x] + t[dn + x]) * 0.25;
      }
    }
    let max = 0;
    for (let i = 0; i < g.length; i++) if (g[i] > max) max = g[i];
    this.gridMax = max;
    const norm = 1 / Math.max(disease ? 0.35 : 0.9, max);
    const lut = disease ? RAMPS.disease : RAMPS.density;
    const d = this.gridImg!.data;
    for (let i = 0; i < g.length; i++) {
      let v = g[i] * norm;
      v = v > 1 ? 1 : v;
      v = Math.sqrt(v);
      const li = ((v * 255) | 0) * 4;
      const o = i * 4;
      d[o] = lut[li];
      d[o + 1] = lut[li + 1];
      d[o + 2] = lut[li + 2];
      d[o + 3] = lut[li + 3];
    }
    this.gridCtx.putImageData(this.gridImg!, 0, 0);
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
        hslToRgb(tr ? tr.hue : (id * 137.5) % 360, 0.75, 0.55, this.rgb);
        lr = this.rgb[0];
        lg = this.rgb[1];
        lb = this.rgb[2];
      }
      d[o] = lr;
      d[o + 1] = lg;
      d[o + 2] = lb;
      d[o + 3] = 105;
    }
    this.tileCtx.putImageData(this.tileImg!, 0, 0);

    // vector borders, merged into runs, one Path2D per tribe
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

  /** Draw the overlay in world space. */
  draw(ctx: CanvasRenderingContext2D, sim: Simulation, kind: OverlayKind, zoom: number): void {
    if (kind === 'none' || kind !== this.kind) return;
    ctx.imageSmoothingEnabled = true;
    if (this.usingGrid) {
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.gridC, 0, 0, this.gw * GRID_CELL, this.gh * GRID_CELL);
      ctx.globalAlpha = 1;
      return;
    }
    ctx.globalAlpha = kind === 'territory' ? 1 : 0.88;
    ctx.drawImage(this.tileC, 0, 0, sim.worldW, sim.worldH);
    ctx.globalAlpha = 1;
    if (kind === 'territory' && this.borders.size) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const [id, path] of this.borders) {
        const tr = sim.getTribe(id);
        const hue = tr ? tr.hue : (id * 137.5) % 360;
        ctx.lineWidth = 3.5 / zoom;
        ctx.strokeStyle = 'rgba(4,8,18,0.55)';
        ctx.stroke(path);
        ctx.lineWidth = 1.6 / zoom;
        ctx.strokeStyle = hueColor(hue, 0.85, 0.66, 0.95);
        ctx.stroke(path);
      }
    }
  }

  private legendBar(key: string, ramp: Ramp | null): HTMLCanvasElement {
    let c = this.legendBars.get(key);
    if (c) return c;
    c = canvas(128, 1);
    const cx = c.getContext('2d')!;
    const img = cx.createImageData(128, 1);
    for (let i = 0; i < 128; i++) {
      const t = i / 127;
      let r: number, g: number, b: number, a: number;
      if (ramp) {
        const li = Math.round(t * 255) * 4;
        r = ramp[li];
        g = ramp[li + 1];
        b = ramp[li + 2];
        a = Math.max(ramp[li + 3], 60);
      } else {
        // climate: red ← neutral → green
        const u = t * 2 - 1;
        const lut = u < 0 ? RAMPS.climateDown : RAMPS.climateUp;
        const li = Math.round(Math.abs(u) * 255) * 4;
        r = lut[li];
        g = lut[li + 1];
        b = lut[li + 2];
        a = Math.max(lut[li + 3], 40);
      }
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = a;
    }
    cx.putImageData(img, 0, 0);
    this.legendBars.set(key, c);
    return c;
  }

  /**
   * Draw a compact legend with its bottom-right corner at (right, bottom) in CSS px
   * (ctx in CSS-pixel screen space). Returns the legend height.
   */
  drawLegend(ctx: CanvasRenderingContext2D, sim: Simulation, kind: OverlayKind, right: number, bottom: number): number {
    if (kind === 'none') return 0;
    const pad = 10;
    const w = 178;
    ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'alphabetic';
    if (kind === 'territory') {
      const tribes: Tribe[] = [];
      for (const t of sim.state.tribes) if (t.extinctTick === -1 || (this.tribeTiles.get(t.id) ?? 0) > 0) tribes.push(t);
      tribes.sort((a, b) => (this.tribeTiles.get(b.id) ?? b.territory ?? 0) - (this.tribeTiles.get(a.id) ?? a.territory ?? 0));
      const shown = Math.min(6, tribes.length);
      const h = pad * 2 + 16 + Math.max(1, shown) * 16 + (tribes.length > shown ? 14 : 0);
      const x = right - w;
      const y = bottom - h;
      panel(ctx, x, y, w, h);
      ctx.fillStyle = '#dbe6ff';
      ctx.fillText('Tribal territory', x + pad, y + pad + 10);
      ctx.font = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      if (!shown) {
        ctx.fillStyle = 'rgba(200,215,240,0.6)';
        ctx.fillText('No tribes yet', x + pad, y + pad + 30);
      }
      for (let i = 0; i < shown; i++) {
        const t = tribes[i];
        const yy = y + pad + 26 + i * 16;
        ctx.fillStyle = hueColor(t.hue, 0.8, 0.6);
        ctx.fillRect(x + pad, yy - 8, 10, 10);
        ctx.fillStyle = '#c9d6ee';
        const tiles = this.tribeTiles.get(t.id) ?? t.territory ?? 0;
        ctx.fillText(clip(t.name, 16), x + pad + 16, yy + 1);
        ctx.fillStyle = 'rgba(200,215,240,0.6)';
        const s = `${tiles}`;
        ctx.fillText(s, x + w - pad - ctx.measureText(s).width, yy + 1);
      }
      if (tribes.length > shown) {
        ctx.fillStyle = 'rgba(200,215,240,0.55)';
        ctx.fillText(`+${tribes.length - shown} more`, x + pad, y + h - pad + 2);
      }
      return h;
    }
    const spec = LEGENDS[kind];
    const h = spec.note ? 66 : 54;
    const x = right - w;
    const y = bottom - h;
    panel(ctx, x, y, w, h);
    ctx.fillStyle = '#dbe6ff';
    ctx.fillText(spec.title, x + pad, y + pad + 10);
    const bar = this.legendBar(kind, spec.ramp);
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(x + pad, y + 26, w - pad * 2, 8);
    ctx.drawImage(bar, x + pad, y + 26, w - pad * 2, 8);
    ctx.font = '10px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = 'rgba(200,215,240,0.7)';
    ctx.fillText(spec.lo, x + pad, y + 46);
    const hiTxt = kind === 'density' && this.gridMax > 0 ? `${spec.hi}` : spec.hi;
    ctx.fillText(hiTxt, x + w - pad - ctx.measureText(hiTxt).width, y + 46);
    if (kind === 'climate') {
      const s = 'normal';
      ctx.fillText(s, x + w / 2 - ctx.measureText(s).width / 2, y + 46);
    }
    if (spec.note) {
      ctx.fillStyle = 'rgba(170,240,140,0.8)';
      ctx.fillText(spec.note, x + pad, y + 59);
    }
    return h;
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Rounded translucent panel (screen space). */
export function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  const r = 7;
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(7,11,22,0.78)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(140,170,255,0.18)';
  ctx.stroke();
}
