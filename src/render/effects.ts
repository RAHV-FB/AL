// OWNER: map agents engineer.
/**
 * Disaster marks. Disasters are tracked renderer-side by id so that ended (or removed) disasters fade
 * out, and a fresh meteor impact gets one brief expanding ring. Every mark is flat and quiet: a light
 * tint, a thin outline in a muted colour per kind, sparse hatching on blight, a few small flakes in a
 * cold snap. A whole-map disaster tints the world lightly and gets a short note at the top of the map.
 * No gradients, glows, flashes or additive blending.
 */
import type { Simulation } from '../sim/simulation';
import type { Disaster, DisasterKind } from '../sim/types';
import { PAL, flatPanel } from './colors';

interface Tracked {
  d: Disaster;
  firstSeen: number;
  endedAt: number; // ms, -1 while active
  stamp: number;
  /** Seen within a few ticks of its start: play the impact ring. */
  fresh: boolean;
}

const FADE_IN = 600;
const FADE_OUT = 2000;
const IMPACT_MS = 1100;
const TAU = Math.PI * 2;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function h(id: number, i: number, k: number): number {
  let x = Math.imul(id + 1, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35);
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x ^= x >>> 12;
  return (x >>> 0) / 4294967296;
}

/** Map label of each disaster kind (sentence case). */
export const DISASTER_LABEL: Record<DisasterKind, string> = {
  drought: 'Drought',
  blight: 'Blight',
  bloom: 'Bloom',
  plague: 'Plague',
  meteor: 'Meteor strike',
  coldsnap: 'Cold snap',
};

/** Muted outline colour of each disaster kind (also suits the minimap). */
export const DISASTER_COLOR: Record<DisasterKind, string> = {
  drought: '#cf9f55',
  blight: '#a3835c',
  bloom: '#8fb573',
  plague: '#c2c066',
  meteor: '#cf5b45',
  coldsnap: '#a9c4d8',
};

/** Flat tint colour and its alpha inside a local disaster. */
const TINT: Record<DisasterKind, [string, number]> = {
  drought: ['#d6a648', 0.1],
  blight: ['#6e5a40', 0.13],
  bloom: ['#8fb573', 0.09],
  plague: ['#b4b35c', 0.1],
  meteor: ['#2a1d16', 0.24],
  coldsnap: ['#d4e2ec', 0.12],
};

const DASH: Partial<Record<DisasterKind, [number, number]>> = {
  drought: [7, 4],
  plague: [4, 3],
};

export class DisasterFx {
  private tracked = new Map<number, Tracked>();
  private stamp = 0;
  private lastSim: Simulation | null = null;
  private dash = [0, 0];
  private noDash: number[] = [];
  /** Number of disasters currently drawn (for stats/debug). */
  visible = 0;

  /** Update the tracked set from the simulation. */
  sync(sim: Simulation, time: number): void {
    if (sim !== this.lastSim) {
      this.tracked.clear();
      this.lastSim = sim;
    }
    const stamp = ++this.stamp;
    const tick = sim.state.tick;
    const list = sim.state.disasters ?? [];
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      let t = this.tracked.get(d.id);
      if (!t) {
        t = { d, firstSeen: time, endedAt: -1, stamp, fresh: tick - d.startTick < 40 };
        this.tracked.set(d.id, t);
      }
      t.d = d;
      t.stamp = stamp;
      const over = !d.active || (d.duration > 0 && tick >= d.startTick + d.duration);
      if (over && t.endedAt < 0) t.endedAt = time;
      else if (!over && t.endedAt >= 0) t.endedAt = -1;
    }
    for (const [id, t] of this.tracked) {
      if (t.stamp !== stamp && t.endedAt < 0) t.endedAt = time;
      if (t.endedAt >= 0 && time - t.endedAt > FADE_OUT) this.tracked.delete(id);
    }
  }

  private alphaOf(t: Tracked, time: number): number {
    let a = Math.min(1, (time - t.firstSeen) / FADE_IN);
    if (t.endedAt >= 0) a *= Math.max(0, 1 - (time - t.endedAt) / FADE_OUT);
    const inten = Number.isFinite(t.d.intensity) ? Math.max(0, Math.min(1, t.d.intensity)) : 0.7;
    return a * (0.6 + 0.4 * inten);
  }

  /** World-space marks. ctx must be in world space; (x0,y0)-(x1,y1) is the visible world rectangle. */
  drawWorld(ctx: CanvasRenderingContext2D, time: number, zoom: number, x0: number, y0: number, x1: number, y1: number, worldW: number, worldH: number): void {
    this.visible = 0;
    if (!this.tracked.size) return;
    const px = 1 / zoom;
    ctx.lineCap = 'butt';
    for (const t of this.tracked.values()) {
      const d = t.d;
      const A = this.alphaOf(t, time);
      if (A <= 0.003) continue;
      const kind = d.kind;
      const tint = TINT[kind] ?? TINT.drought;
      const R = d.radius;
      if (!(R > 0)) {
        // whole map: a light flat tint of the world (and sparse flakes in a cold snap)
        this.visible++;
        ctx.globalAlpha = A * tint[1] * 0.55;
        ctx.fillStyle = tint[0];
        ctx.fillRect(0, 0, worldW, worldH);
        if (kind === 'coldsnap') this.flakesInView(ctx, d.id, x0, y0, x1, y1, zoom, A, worldW, worldH);
        continue;
      }
      if (d.x + R < x0 || d.x - R > x1 || d.y + R < y0 || d.y - R > y1) continue;
      this.visible++;
      ctx.beginPath();
      ctx.arc(d.x, d.y, R, 0, TAU);
      ctx.globalAlpha = A * tint[1];
      ctx.fillStyle = tint[0];
      ctx.fill();
      const col = DISASTER_COLOR[kind] ?? PAL.ochre;
      if (kind === 'blight') this.hatch(ctx, d.x, d.y, R, Math.max(10 * px, R / 9), col, A * 0.5, px);
      else if (kind === 'coldsnap') this.flakesInCircle(ctx, d, px, A);
      else if (kind === 'meteor' && t.fresh) {
        const age = time - t.firstSeen;
        if (age < IMPACT_MS) {
          const u = age / IMPACT_MS;
          const e = 1 - (1 - u) * (1 - u) * (1 - u);
          ctx.beginPath();
          ctx.arc(d.x, d.y, R * (0.2 + 1.05 * e), 0, TAU);
          ctx.globalAlpha = (1 - u) * 0.9;
          ctx.strokeStyle = PAL.ochre;
          ctx.lineWidth = 1.5 * px;
          ctx.stroke();
        }
      }
      // outline
      ctx.beginPath();
      ctx.arc(d.x, d.y, R, 0, TAU);
      ctx.globalAlpha = A * 0.95;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.4 * px;
      const dash = DASH[kind];
      if (dash) {
        this.dash[0] = dash[0] * px;
        this.dash[1] = dash[1] * px;
        ctx.setLineDash(this.dash);
      }
      ctx.stroke();
      if (dash) ctx.setLineDash(this.noDash);
    }
    ctx.globalAlpha = 1;
  }

  /** Sparse diagonal hatching clipped to a circle (analytic chords, no clip path). */
  private hatch(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, gap: number, col: string, alpha: number, px: number): void {
    const k = Math.SQRT1_2;
    ctx.beginPath();
    for (let u = -R + gap * 0.5; u < R; u += gap) {
      const L = Math.sqrt(R * R - u * u);
      // chord at offset u along the normal (k, -k), running along (k, k)
      const mx = cx + u * k;
      const my = cy - u * k;
      ctx.moveTo(mx - L * k, my - L * k);
      ctx.lineTo(mx + L * k, my + L * k);
    }
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = col;
    ctx.lineWidth = px;
    ctx.stroke();
  }

  /** A few small six-armed flakes inside a local cold snap (fixed places, no animation). */
  private flakesInCircle(ctx: CanvasRenderingContext2D, d: Disaster, px: number, A: number): void {
    const R = d.radius;
    const n = Math.max(5, Math.min(22, Math.round((R * R) / 2600)));
    const s = 3.6 * px;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = h(d.id, i, 1) * TAU;
      const rr = Math.sqrt(h(d.id, i, 2)) * R * 0.9;
      flake(ctx, d.x + Math.cos(a) * rr, d.y + Math.sin(a) * rr, s);
    }
    this.strokeFlakes(ctx, px, A);
  }

  /** Sparse flakes over the visible part of the world during a whole-map cold snap (anchored to the ground). */
  private flakesInView(ctx: CanvasRenderingContext2D, id: number, x0: number, y0: number, x1: number, y1: number, zoom: number, A: number, worldW: number, worldH: number): void {
    const px = 1 / zoom;
    const cell = Math.pow(2, Math.round(Math.log2(150 / zoom)));
    const i0 = Math.max(0, Math.floor(x0 / cell));
    const j0 = Math.max(0, Math.floor(y0 / cell));
    const i1 = Math.min(Math.floor(worldW / cell), Math.floor(x1 / cell));
    const j1 = Math.min(Math.floor(worldH / cell), Math.floor(y1 / cell));
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) return;
    const s = 3.6 * px;
    ctx.beginPath();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const fx = (i + 0.15 + 0.7 * h(id, i * 977 + j, 1)) * cell;
        const fy = (j + 0.15 + 0.7 * h(id, i * 977 + j, 2)) * cell;
        if (fx > worldW || fy > worldH) continue;
        flake(ctx, fx, fy, s);
      }
    }
    this.strokeFlakes(ctx, px, A);
  }

  private strokeFlakes(ctx: CanvasRenderingContext2D, px: number, A: number): void {
    ctx.lineCap = 'round';
    ctx.globalAlpha = A * 0.45;
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 2.6 * px;
    ctx.stroke();
    ctx.globalAlpha = A * 0.95;
    ctx.strokeStyle = '#e3edf3';
    ctx.lineWidth = 1.1 * px;
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  /** Labels above local disasters (screen space, CSS px). */
  drawLabels(ctx: CanvasRenderingContext2D, time: number, toSX: (x: number) => number, toSY: (y: number) => number, zoom: number, viewW: number, viewH: number): void {
    if (!this.tracked.size || zoom < 0.3) return;
    ctx.font = `500 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    for (const t of this.tracked.values()) {
      const d = t.d;
      if (!(d.radius > 0)) continue;
      const sx = toSX(d.x);
      const sy = toSY(d.y - d.radius) - 5;
      if (sx < -80 || sx > viewW + 80 || sy < 14 || sy > viewH + 40) continue;
      const A = this.alphaOf(t, time);
      if (A < 0.05) continue;
      const text = DISASTER_LABEL[d.kind] ?? d.kind;
      ctx.globalAlpha = Math.min(1, A * 1.2);
      ctx.strokeStyle = PAL.ink;
      ctx.lineWidth = 3.2;
      ctx.strokeText(text, sx, sy);
      ctx.fillStyle = PAL.text;
      ctx.fillText(text, sx, sy);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /** Notes for whole-map disasters, at the top centre of the map (screen space, CSS px). */
  drawScreen(ctx: CanvasRenderingContext2D, time: number, viewW: number, viewH: number, insets: { top: number; right: number; bottom: number; left: number }): void {
    if (!this.tracked.size) return;
    let y = insets.top + 48;
    const cx = (insets.left + viewW - insets.right) / 2;
    ctx.font = `500 12px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const t of this.tracked.values()) {
      const d = t.d;
      if (d.radius > 0) continue;
      const A = this.alphaOf(t, time);
      if (A < 0.05) continue;
      if (y > viewH * 0.4) break;
      const text = `${DISASTER_LABEL[d.kind] ?? d.kind} across the whole map`;
      const w = ctx.measureText(text).width + 34;
      const x = Math.round(cx - w / 2) + 0.5;
      ctx.globalAlpha = Math.min(1, A * 1.3);
      flatPanel(ctx, x, y + 0.5, w, 26);
      ctx.fillStyle = DISASTER_COLOR[d.kind] ?? PAL.ochre;
      ctx.fillRect(x + 11, y + 9.5, 8, 8);
      ctx.fillStyle = PAL.text;
      ctx.fillText(text, x + 25, y + 14);
      y += 32;
    }
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';
  }

  /** Active disasters (for the minimap). */
  forEach(cb: (d: Disaster, alpha: number) => void, time: number): void {
    for (const t of this.tracked.values()) cb(t.d, this.alphaOf(t, time));
  }
}

/** Six-armed flake: three lines through the centre. */
function flake(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI) / 3 + Math.PI / 2;
    const c = Math.cos(a) * s;
    const sn = Math.sin(a) * s;
    ctx.moveTo(x - c, y - sn);
    ctx.lineTo(x + c, y + sn);
  }
}
