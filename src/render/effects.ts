// OWNER: Rendering agent.
/**
 * Animated disaster visuals. Disasters are tracked renderer-side by id so that ended
 * (or removed) disasters fade out smoothly, and meteor impacts get a one-shot flash +
 * shockwave. All gradients are cached unit gradients drawn under a transform, so the
 * per-frame cost is a handful of fills and no allocations.
 */
import type { Simulation } from '../sim/simulation';
import type { Disaster, DisasterKind } from '../sim/types';

interface Tracked {
  d: Disaster;
  firstSeen: number;
  endedAt: number; // ms, -1 while active
  stamp: number;
  /** Seen within a few ticks of its start → play the impact animation. */
  fresh: boolean;
}

const FADE_IN = 700;
const FADE_OUT = 2600;
const TAU = Math.PI * 2;

function h(id: number, i: number, k: number): number {
  let x = Math.imul(id + 1, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35);
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x ^= x >>> 12;
  return (x >>> 0) / 4294967296;
}

const LABEL: Record<DisasterKind, string> = {
  drought: 'Drought',
  blight: 'Blight',
  bloom: 'Bloom',
  plague: 'Plague',
  meteor: 'Meteor strike',
  coldsnap: 'Cold snap',
};

const LABEL_COLOR: Record<DisasterKind, string> = {
  drought: '#ffc27a',
  blight: '#cc9cff',
  bloom: '#c8ff9a',
  plague: '#a8f070',
  meteor: '#ffb08a',
  coldsnap: '#cfe8ff',
};

// [stop, r, g, b, a] for unit radial gradients
const AREA_STOPS: Record<DisasterKind, [number, number, number, number, number][]> = {
  drought: [[0, 255, 176, 80, 0.26], [0.7, 255, 140, 50, 0.15], [1, 255, 120, 40, 0]],
  blight: [[0, 50, 10, 70, 0.42], [0.72, 80, 25, 100, 0.22], [1, 80, 25, 100, 0]],
  bloom: [[0, 180, 255, 130, 0.22], [0.8, 120, 230, 110, 0.11], [1, 120, 230, 110, 0]],
  plague: [[0, 120, 210, 60, 0.26], [0.6, 100, 180, 50, 0.13], [1, 90, 160, 40, 0]],
  meteor: [[0, 255, 130, 40, 0.55], [0.3, 190, 60, 20, 0.35], [0.65, 40, 12, 6, 0.3], [1, 30, 10, 5, 0]],
  coldsnap: [[0, 200, 230, 255, 0.28], [0.8, 170, 210, 255, 0.15], [1, 170, 210, 255, 0]],
};

const VIGNETTE: Record<DisasterKind, [number, number, number]> = {
  drought: [255, 140, 40],
  blight: [110, 30, 140],
  bloom: [150, 255, 120],
  plague: [110, 220, 60],
  meteor: [255, 110, 40],
  coldsnap: [150, 200, 255],
};

export class DisasterFx {
  private tracked = new Map<number, Tracked>();
  private stamp = 0;
  private lastSim: Simulation | null = null;
  private grads = new Map<string, CanvasGradient>();
  private gradCtx: CanvasRenderingContext2D | null = null;
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

  private grad(ctx: CanvasRenderingContext2D, key: string, inner: number, stops: [number, number, number, number, number][]): CanvasGradient {
    if (this.gradCtx !== ctx) {
      this.grads.clear();
      this.gradCtx = ctx;
    }
    let g = this.grads.get(key);
    if (!g) {
      g = ctx.createRadialGradient(0, 0, inner, 0, 0, 1);
      for (const s of stops) g.addColorStop(s[0], `rgba(${s[1]},${s[2]},${s[3]},${s[4]})`);
      this.grads.set(key, g);
    }
    return g;
  }

  /** Disc filled with a cached unit gradient (world or screen space). */
  private disc(ctx: CanvasRenderingContext2D, g: CanvasGradient, x: number, y: number, r: number, alpha: number): void {
    if (alpha <= 0.002 || r <= 0) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(r, r);
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  private alphaOf(t: Tracked, time: number): number {
    let a = Math.min(1, (time - t.firstSeen) / FADE_IN);
    if (t.endedAt >= 0) a *= Math.max(0, 1 - (time - t.endedAt) / FADE_OUT);
    const inten = Number.isFinite(t.d.intensity) ? Math.max(0, Math.min(1, t.d.intensity)) : 0.7;
    return a * (0.55 + 0.45 * inten);
  }

  /** World-space effects for local disasters. ctx must be in world space. */
  drawWorld(ctx: CanvasRenderingContext2D, time: number, zoom: number, x0: number, y0: number, x1: number, y1: number): void {
    this.visible = 0;
    if (!this.tracked.size) return;
    const px = 1 / zoom;
    for (const t of this.tracked.values()) {
      const d = t.d;
      const R = d.radius;
      if (!(R > 0)) continue;
      if (d.x + R * 1.7 < x0 || d.x - R * 1.7 > x1 || d.y + R * 1.7 < y0 || d.y - R * 1.7 > y1) continue;
      const A = this.alphaOf(t, time);
      if (A <= 0.003) continue;
      this.visible++;
      const id = d.id;
      const area = this.grad(ctx, 'a:' + d.kind, 0, AREA_STOPS[d.kind]);
      switch (d.kind) {
        case 'drought': {
          this.disc(ctx, area, d.x, d.y, R, A);
          ctx.globalAlpha = A;
          ctx.lineWidth = 1.6 * px;
          for (let k = 0; k < 3; k++) {
            ctx.strokeStyle = k === 0 ? 'rgba(255,214,150,0.5)' : 'rgba(255,190,120,0.22)';
            ctx.beginPath();
            const base = R * (0.97 - k * 0.22);
            const ph = time * (0.0022 + k * 0.0011) + k * 2.1;
            for (let j = 0; j <= 96; j++) {
              const th = (j / 96) * TAU;
              const rr = base * (1 + 0.018 * Math.sin(7 * th + ph) + 0.011 * Math.sin(13 * th - ph * 1.7));
              const xx = d.x + Math.cos(th) * rr;
              const yy = d.y + Math.sin(th) * rr;
              if (j === 0) ctx.moveTo(xx, yy);
              else ctx.lineTo(xx, yy);
            }
            ctx.stroke();
          }
          // rising heat wisps
          ctx.strokeStyle = 'rgba(255,230,180,0.18)';
          ctx.lineWidth = 1.2 * px;
          ctx.beginPath();
          for (let i = 0; i < 18; i++) {
            const a = h(id, i, 1) * TAU;
            const rr = Math.sqrt(h(id, i, 2)) * R * 0.85;
            const cyc = (time * 0.00025 * (0.6 + h(id, i, 3)) + h(id, i, 4)) % 1;
            const wx = d.x + Math.cos(a) * rr;
            const wy = d.y + Math.sin(a) * rr - cyc * R * 0.12;
            const len = R * 0.05;
            ctx.moveTo(wx, wy);
            ctx.quadraticCurveTo(wx + Math.sin(time * 0.004 + i) * len * 0.5, wy - len * 0.5, wx, wy - len);
          }
          ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        }
        case 'blight': {
          this.disc(ctx, area, d.x, d.y, R, A);
          ctx.globalAlpha = A;
          ctx.fillStyle = 'rgba(170,100,215,0.75)';
          ctx.beginPath();
          const n = 56;
          for (let i = 0; i < n; i++) {
            const a = h(id, i, 1) * TAU + time * 0.00012 * (h(id, i, 2) - 0.5);
            const rr = Math.sqrt(h(id, i, 3)) * R * 0.95;
            const bob = Math.sin(time * 0.0018 + h(id, i, 4) * TAU) * R * 0.03;
            const sx = d.x + Math.cos(a) * rr;
            const sy = d.y + Math.sin(a) * rr + bob;
            const s = Math.max(1.3 * px, 0.5 + h(id, i, 5) * 1.1);
            ctx.moveTo(sx + s, sy);
            ctx.arc(sx, sy, s, 0, TAU);
          }
          ctx.fill();
          ctx.fillStyle = 'rgba(40,8,55,0.7)';
          ctx.beginPath();
          for (let i = 0; i < n; i += 2) {
            const a = h(id, i, 1) * TAU + time * 0.00012 * (h(id, i, 2) - 0.5);
            const rr = Math.sqrt(h(id, i, 3)) * R * 0.95;
            const bob = Math.sin(time * 0.0018 + h(id, i, 4) * TAU) * R * 0.03;
            const s = Math.max(0.6 * px, 0.25 + h(id, i, 5) * 0.5);
            const sx = d.x + Math.cos(a) * rr;
            const sy = d.y + Math.sin(a) * rr + bob;
            ctx.moveTo(sx + s, sy);
            ctx.arc(sx, sy, s, 0, TAU);
          }
          ctx.fill();
          ctx.globalAlpha = 1;
          break;
        }
        case 'bloom': {
          this.disc(ctx, area, d.x, d.y, R, A);
          ctx.strokeStyle = 'rgba(255,250,190,0.95)';
          ctx.lineWidth = 1.2 * px;
          for (let i = 0; i < 40; i++) {
            const tw = Math.sin(time * 0.004 * (0.6 + h(id, i, 4)) + h(id, i, 5) * TAU);
            if (tw <= 0.2) continue;
            const a2 = tw * tw * tw;
            const a = h(id, i, 1) * TAU;
            const rr = Math.sqrt(h(id, i, 2)) * R * 0.92;
            const sx = d.x + Math.cos(a) * rr;
            const sy = d.y + Math.sin(a) * rr;
            const s = (2 + 4 * a2) * px;
            ctx.globalAlpha = A * a2;
            ctx.beginPath();
            ctx.moveTo(sx - s, sy);
            ctx.lineTo(sx + s, sy);
            ctx.moveTo(sx, sy - s);
            ctx.lineTo(sx, sy + s);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          break;
        }
        case 'plague': {
          for (let b = 0; b < 5; b++) {
            const bx = d.x + (h(id, b, 1) - 0.5) * R * 0.9 + Math.sin(time * 0.00035 + h(id, b, 2) * TAU) * R * 0.14;
            const by = d.y + (h(id, b, 3) - 0.5) * R * 0.9 + Math.cos(time * 0.0003 + h(id, b, 4) * TAU) * R * 0.14;
            const br = R * (0.45 + 0.35 * h(id, b, 5));
            this.disc(ctx, area, bx, by, br, A * (0.75 + 0.25 * Math.sin(time * 0.0015 + b)));
          }
          this.disc(ctx, area, d.x, d.y, R, A * 0.7);
          ctx.globalAlpha = A * 0.8;
          ctx.strokeStyle = 'rgba(160,240,100,0.55)';
          ctx.lineWidth = 1.4 * px;
          this.dash[0] = 7 * px;
          this.dash[1] = 6 * px;
          ctx.setLineDash(this.dash);
          ctx.lineDashOffset = -time * 0.01 * px;
          ctx.beginPath();
          ctx.arc(d.x, d.y, R, 0, TAU);
          ctx.stroke();
          ctx.setLineDash(this.noDash);
          ctx.lineDashOffset = 0;
          ctx.globalAlpha = 1;
          break;
        }
        case 'meteor': {
          const age = time - t.firstSeen;
          // scorched crater with flickering embers
          this.disc(ctx, area, d.x, d.y, R * 0.8, A * (0.85 + 0.15 * Math.sin(time * 0.013)));
          ctx.globalAlpha = A;
          ctx.fillStyle = 'rgba(255,150,60,0.9)';
          ctx.beginPath();
          for (let i = 0; i < 24; i++) {
            const a = h(id, i, 1) * TAU;
            const rr = Math.sqrt(h(id, i, 2)) * R * 0.55;
            const cyc = (time * 0.0004 * (0.5 + h(id, i, 3)) + h(id, i, 4)) % 1;
            const ex = d.x + Math.cos(a) * rr + Math.sin(time * 0.003 + i) * R * 0.02;
            const ey = d.y + Math.sin(a) * rr - cyc * R * 0.25;
            const s = Math.max(0.9 * px, 0.6 * (1 - cyc));
            ctx.moveTo(ex + s, ey);
            ctx.arc(ex, ey, s, 0, TAU);
          }
          ctx.fill();
          ctx.globalAlpha = 1;
          if (t.fresh && age < 1600) {
            const prev = ctx.globalCompositeOperation;
            ctx.globalCompositeOperation = 'lighter';
            if (age < 600) {
              const core = this.grad(ctx, 'meteorCore', 0, [[0, 255, 255, 235, 1], [0.35, 255, 210, 140, 0.7], [1, 255, 120, 40, 0]]);
              this.disc(ctx, core, d.x, d.y, R * (0.5 + age / 500), 1 - age / 600);
            }
            for (let k = 0; k < 2; k++) {
              const tt = (age - k * 180) / 1400;
              if (tt <= 0 || tt >= 1) continue;
              const e = 1 - Math.pow(1 - tt, 3);
              ctx.globalAlpha = (1 - tt) * (k ? 0.5 : 0.9);
              ctx.strokeStyle = k ? 'rgba(255,170,90,1)' : 'rgba(255,236,200,1)';
              ctx.lineWidth = (k ? 2 : 6 * (1 - tt) + 1.2) * px;
              ctx.beginPath();
              ctx.arc(d.x, d.y, R * (0.15 + 1.55 * e), 0, TAU);
              ctx.stroke();
            }
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = prev;
          }
          break;
        }
        case 'coldsnap': {
          this.disc(ctx, area, d.x, d.y, R, A);
          ctx.globalAlpha = A * 0.8;
          ctx.strokeStyle = 'rgba(215,238,255,0.55)';
          ctx.lineWidth = 1.2 * px;
          ctx.beginPath();
          ctx.arc(d.x, d.y, R, 0, TAU);
          ctx.stroke();
          // falling snow clipped to the circle
          ctx.globalAlpha = A;
          ctx.fillStyle = 'rgba(245,250,255,0.9)';
          ctx.beginPath();
          const n = 90;
          const R2 = R * R;
          for (let i = 0; i < n; i++) {
            const sp = 0.012 * (0.5 + h(id, i, 3));
            const fy = ((h(id, i, 2) * 2 * R + time * sp) % (2 * R)) - R;
            const fx = (h(id, i, 1) * 2 - 1) * R + Math.sin(time * 0.0016 + h(id, i, 4) * TAU) * R * 0.04;
            if (fx * fx + fy * fy > R2) continue;
            const s = Math.max(1.1 * px, 0.35 + h(id, i, 5) * 0.45);
            ctx.moveTo(d.x + fx + s, d.y + fy);
            ctx.arc(d.x + fx, d.y + fy, s, 0, TAU);
          }
          ctx.fill();
          ctx.globalAlpha = 1;
          break;
        }
      }
    }
  }

  /** Labels above local disasters (screen space, CSS px). */
  drawLabels(ctx: CanvasRenderingContext2D, time: number, toSX: (x: number) => number, toSY: (y: number) => number, zoom: number, viewW: number, viewH: number): void {
    if (!this.tracked.size || zoom < 0.35) return;
    ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const t of this.tracked.values()) {
      const d = t.d;
      if (!(d.radius > 0)) continue;
      const sx = toSX(d.x);
      const sy = toSY(d.y - d.radius) - 4;
      if (sx < -80 || sx > viewW + 80 || sy < -20 || sy > viewH + 40) continue;
      const A = this.alphaOf(t, time);
      if (A < 0.05) continue;
      ctx.globalAlpha = Math.min(1, A * 1.2);
      ctx.fillStyle = 'rgba(5,8,16,0.6)';
      ctx.fillText(LABEL[d.kind], sx + 1, sy + 1);
      ctx.fillStyle = LABEL_COLOR[d.kind];
      ctx.fillText(LABEL[d.kind], sx, sy);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /** Screen-space effects: global-disaster vignettes, global snow, meteor flash. ctx in CSS px. */
  drawScreen(ctx: CanvasRenderingContext2D, time: number, viewW: number, viewH: number, toSX: (x: number) => number, toSY: (y: number) => number): void {
    if (!this.tracked.size) return;
    const hx = viewW / 2;
    const hy = viewH / 2;
    const diag = Math.sqrt(hx * hx + hy * hy);
    for (const t of this.tracked.values()) {
      const d = t.d;
      const A = this.alphaOf(t, time);
      if (A <= 0.003) continue;
      const age = time - t.firstSeen;
      if (d.kind === 'meteor' && t.fresh && age < 320) {
        // impact flash (stronger when on screen)
        const sx = toSX(d.x);
        const sy = toSY(d.y);
        const onScreen = sx > -100 && sx < viewW + 100 && sy > -100 && sy < viewH + 100;
        ctx.globalAlpha = (1 - age / 320) * (onScreen ? 0.4 : 0.12);
        ctx.fillStyle = '#fff3e0';
        ctx.fillRect(0, 0, viewW, viewH);
        ctx.globalAlpha = 1;
      }
      if (d.radius > 0) continue;
      const c = VIGNETTE[d.kind];
      const g = this.grad(ctx, 'v:' + d.kind, 0.5, [[0, c[0], c[1], c[2], 0], [0.55, c[0], c[1], c[2], 0.12], [1, c[0], c[1], c[2], 0.5]]);
      ctx.save();
      ctx.translate(hx, hy);
      ctx.scale(diag, diag);
      ctx.globalAlpha = A * (0.85 + 0.15 * Math.sin(time * 0.0012));
      ctx.fillStyle = g;
      ctx.fillRect(-hx / diag, -hy / diag, viewW / diag, viewH / diag);
      ctx.restore();
      if (d.kind === 'coldsnap') {
        ctx.globalAlpha = A * 0.85;
        ctx.fillStyle = 'rgba(245,250,255,0.85)';
        ctx.beginPath();
        for (let i = 0; i < 150; i++) {
          const sp = 0.05 * (0.4 + h(d.id, i, 3));
          const fy = (h(d.id, i, 2) * (viewH + 20) + time * sp) % (viewH + 20) - 10;
          const fx = h(d.id, i, 1) * viewW + Math.sin(time * 0.0012 + h(d.id, i, 4) * TAU) * 14;
          const s = 0.8 + h(d.id, i, 5) * 1.6;
          ctx.moveTo(fx + s, fy);
          ctx.arc(fx, fy, s, 0, TAU);
        }
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (d.kind === 'bloom') {
        ctx.strokeStyle = 'rgba(255,250,190,0.9)';
        ctx.lineWidth = 1.2;
        for (let i = 0; i < 40; i++) {
          const tw = Math.sin(time * 0.003 * (0.6 + h(d.id, i, 4)) + h(d.id, i, 5) * TAU);
          if (tw <= 0.3) continue;
          const sx = h(d.id, i, 1) * viewW;
          const sy = h(d.id, i, 2) * viewH;
          const s = 2 + 4 * tw * tw;
          ctx.globalAlpha = A * tw * tw * 0.8;
          ctx.beginPath();
          ctx.moveTo(sx - s, sy);
          ctx.lineTo(sx + s, sy);
          ctx.moveTo(sx, sy - s);
          ctx.lineTo(sx, sy + s);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  /** Active disasters (for the minimap). */
  forEach(cb: (d: Disaster, alpha: number) => void, time: number): void {
    for (const t of this.tracked.values()) cb(t.d, this.alphaOf(t, time));
  }
}
