// OWNER: Rendering agent.
/**
 * Batched agent drawing. Visible agents are counting-sorted into hue buckets so the whole
 * population is drawn with ~O(buckets) fill calls instead of one per agent:
 *   dark outline → tribe ring (tribe hue) → body (gene hue) → heading ticks → carry dots.
 * Per-agent work (glyphs, labels, bars) only happens at high zoom on the screen pass.
 */
import type { Simulation } from '../sim/simulation';
import type { Agent } from '../sim/types';
import { HUE_BUCKETS, bucketPalette, hueBucket, hueColor } from './colors';

const TAU = Math.PI * 2;

function glowSprite(r: number, g: number, b: number, size = 64): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const x = c.getContext('2d')!;
  const grad = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.9)`);
  grad.addColorStop(0.35, `rgba(${r},${g},${b},0.35)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = grad;
  x.fillRect(0, 0, size, size);
  return c;
}

/** Body radius in world units: 3 × size × growth (growth 0.5 → 1 by age/maturity). */
export function agentRadius(a: Agent): number {
  const t = a.traits;
  const mat = t && t.maturityAge > 0 ? t.maturityAge : 600;
  const growth = Math.min(1, 0.5 + 0.5 * (a.age / mat));
  const size = t && t.size > 0 ? t.size : 1;
  return 3 * size * (growth > 0.5 ? growth : 0.5);
}

export function tribeHueOf(sim: Simulation, tribeId: number): number {
  const t = sim.getTribe(tribeId);
  return t ? t.hue : (tribeId * 137.508) % 360;
}

export class AgentPainter {
  /** Indices (into sim.state.agents) of visible agents, and their radii. */
  vis = new Int32Array(1024);
  rad = new Float32Array(1024);
  visN = 0;
  private bodyOrder = new Int32Array(1024);
  private ringOrder = new Int32Array(1024);
  private bodyBucket = new Int16Array(1024);
  private ringBucket = new Int16Array(1024);
  private counts = new Int32Array(HUE_BUCKETS + 1);
  private pos = new Int32Array(HUE_BUCKETS + 1);
  private ringCounts = new Int32Array(HUE_BUCKETS + 1);
  private bodyColors = bucketPalette(0.7, 0.6);
  private bodyColorsDim = bucketPalette(0.55, 0.5);
  private ringColors = bucketPalette(0.95, 0.6);
  private glowWarm = glowSprite(255, 236, 190);
  private glowSick = glowSprite(140, 255, 80);

  private ensure(n: number): void {
    if (this.vis.length >= n) return;
    const m = Math.max(n, this.vis.length * 2);
    this.vis = new Int32Array(m);
    this.rad = new Float32Array(m);
    this.bodyOrder = new Int32Array(m);
    this.ringOrder = new Int32Array(m);
    this.bodyBucket = new Int16Array(m);
    this.ringBucket = new Int16Array(m);
  }

  /** Cull + bucket visible agents. */
  collect(sim: Simulation, zoom: number, x0: number, y0: number, x1: number, y1: number): void {
    const agents = sim.state.agents;
    this.ensure(agents.length);
    const minR = 1.5 / zoom;
    let n = 0;
    const counts = this.counts;
    const rc = this.ringCounts;
    counts.fill(0);
    rc.fill(0);
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.alive) continue;
      const x = a.x;
      const y = a.y;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      let r = agentRadius(a);
      if (r < minR) r = minR;
      this.vis[n] = i;
      this.rad[n] = r;
      const b = hueBucket(a.traits ? a.traits.hue : 0);
      this.bodyBucket[n] = b;
      counts[b + 1]++;
      if (a.tribeId >= 0) {
        const rb = hueBucket(tribeHueOf(sim, a.tribeId));
        this.ringBucket[n] = rb;
        rc[rb + 1]++;
      } else this.ringBucket[n] = -1;
      n++;
    }
    this.visN = n;
    // counting sort → bodyOrder / ringOrder hold positions into vis[]
    for (let b = 0; b < HUE_BUCKETS; b++) counts[b + 1] += counts[b];
    for (let b = 0; b < HUE_BUCKETS; b++) rc[b + 1] += rc[b];
    const pos = this.pos;
    pos.set(counts);
    for (let k = 0; k < n; k++) this.bodyOrder[pos[this.bodyBucket[k]]++] = k;
    pos.set(rc);
    for (let k = 0; k < n; k++) {
      const rb = this.ringBucket[k];
      if (rb >= 0) this.ringOrder[pos[rb]++] = k;
    }
  }

  /** World-space pass. `night` 0..1, `diseaseMode` boosts infection glow. */
  draw(ctx: CanvasRenderingContext2D, sim: Simulation, zoom: number, night: number, diseaseMode: boolean, time: number): void {
    const n = this.visN;
    if (!n) return;
    const agents = sim.state.agents;
    const vis = this.vis;
    const rad = this.rad;
    const px = 1 / zoom;
    const lod = zoom < 0.9 ? 0 : zoom < 2.5 ? 1 : 2;

    // night glow (additive) so agents stay readable after the night tint
    if (night > 0.12) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.5, night * 0.45);
      const spr = this.glowWarm;
      for (let k = 0; k < n; k++) {
        const a = agents[vis[k]];
        const g = rad[k] * 3.4 + 2 * px;
        ctx.drawImage(spr, a.x - g, a.y - g, g * 2, g * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    // infection aura
    {
      const spr = this.glowSick;
      const pulse = 0.8 + 0.2 * Math.sin(time * 0.005);
      ctx.globalAlpha = (diseaseMode ? 0.95 : 0.6) * pulse;
      if (night > 0.3 || diseaseMode) ctx.globalCompositeOperation = 'lighter';
      for (let k = 0; k < n; k++) {
        const a = agents[vis[k]];
        if (!(a.infection > 0)) continue;
        const g = rad[k] * (diseaseMode ? 4.2 : 3) + 3 * px;
        ctx.drawImage(spr, a.x - g, a.y - g, g * 2, g * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    // drop shadows (daylight, closer zooms)
    if (lod >= 1 && night < 0.6) {
      ctx.fillStyle = `rgba(0,4,12,${(0.28 * (1 - night)).toFixed(2)})`;
      ctx.beginPath();
      const ox = 0.35 + 0.6 * px;
      for (let k = 0; k < n; k++) {
        const a = agents[vis[k]];
        const r = rad[k] * 1.08;
        ctx.moveTo(a.x + ox + r, a.y + ox * 1.4);
        ctx.arc(a.x + ox, a.y + ox * 1.4, r, 0, TAU);
      }
      ctx.fill();
    }
    // dark outline for contrast against any terrain
    ctx.fillStyle = 'rgba(6,9,18,0.9)';
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const a = agents[vis[k]];
      const ring = a.tribeId >= 0 ? Math.max(0.9 * px, rad[k] * 0.3) : 0;
      const r = rad[k] + ring + 0.7 * px;
      ctx.moveTo(a.x + r, a.y);
      ctx.arc(a.x, a.y, r, 0, TAU);
    }
    ctx.fill();
    // tribe rings (as discs under the body)
    const rc = this.ringCounts;
    for (let b = 0; b < HUE_BUCKETS; b++) {
      const s = rc[b];
      const e = rc[b + 1];
      if (e <= s) continue;
      ctx.fillStyle = this.ringColors[b];
      ctx.beginPath();
      for (let j = s; j < e; j++) {
        const k = this.ringOrder[j];
        const a = agents[vis[k]];
        const r = rad[k] + Math.max(0.9 * px, rad[k] * 0.3);
        ctx.moveTo(a.x + r, a.y);
        ctx.arc(a.x, a.y, r, 0, TAU);
      }
      ctx.fill();
    }
    // bodies
    const counts = this.counts;
    const pal = night > 0.5 ? this.bodyColors : this.bodyColors;
    for (let b = 0; b < HUE_BUCKETS; b++) {
      const s = counts[b];
      const e = counts[b + 1];
      if (e <= s) continue;
      ctx.fillStyle = pal[b];
      ctx.beginPath();
      for (let j = s; j < e; j++) {
        const k = this.bodyOrder[j];
        const a = agents[vis[k]];
        const r = rad[k];
        ctx.moveTo(a.x + r, a.y);
        ctx.arc(a.x, a.y, r, 0, TAU);
      }
      ctx.fill();
    }
    if (lod === 0) return;
    // resting agents look dimmer (sleeping)
    ctx.fillStyle = 'rgba(10,14,30,0.35)';
    ctx.beginPath();
    let anyRest = false;
    for (let k = 0; k < n; k++) {
      const a = agents[vis[k]];
      if (a.action !== 'rest') continue;
      anyRest = true;
      const r = rad[k];
      ctx.moveTo(a.x + r, a.y);
      ctx.arc(a.x, a.y, r, 0, TAU);
    }
    if (anyRest) ctx.fill();
    // heading ticks
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(0.9 * px, 0.55);
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const a = agents[vis[k]];
      const r = rad[k];
      const hd = Number.isFinite(a.heading) ? a.heading : 0;
      const c = Math.cos(hd);
      const s = Math.sin(hd);
      ctx.moveTo(a.x + c * r * 0.35, a.y + s * r * 0.35);
      ctx.lineTo(a.x + c * r * 1.5, a.y + s * r * 1.5);
    }
    ctx.stroke();
    // carried food
    ctx.fillStyle = '#f2d36b';
    ctx.beginPath();
    let anyCarry = false;
    for (let k = 0; k < n; k++) {
      const a = agents[vis[k]];
      if (!(a.carried > 0.5)) continue;
      anyCarry = true;
      const r = rad[k];
      const hd = Number.isFinite(a.heading) ? a.heading : 0;
      const cx = a.x - Math.cos(hd) * r * 1.05;
      const cy = a.y - Math.sin(hd) * r * 1.05;
      const cr = Math.max(0.8 * px, r * 0.38);
      ctx.moveTo(cx + cr, cy);
      ctx.arc(cx, cy, cr, 0, TAU);
    }
    if (anyCarry) ctx.fill();
    void this.bodyColorsDim;
  }

  /**
   * Screen-space pass at high zoom: action glyphs, labels, mini bars.
   * ctx is in CSS-pixel space; (cx,cy,zoom,vw,vh) describe the camera.
   */
  drawScreen(
    ctx: CanvasRenderingContext2D,
    sim: Simulation,
    zoom: number,
    camX: number,
    camY: number,
    vw: number,
    vh: number,
    time: number,
    showLabels: boolean,
    skipId: number,
  ): void {
    const n = this.visN;
    if (!n || zoom < 2.5) return;
    const agents = sim.state.agents;
    const glyphs = n < 700;
    const labels = showLabels && zoom >= 3.2 && n < 260;
    const bars = zoom >= 5 && n < 200;
    const hx = vw / 2;
    const hy = vh / 2;
    if (glyphs) {
      for (let k = 0; k < n; k++) {
        const a = agents[this.vis[k]];
        const sx = (a.x - camX) * zoom + hx;
        const sy = (a.y - camY) * zoom + hy;
        const rs = this.rad[k] * zoom;
        drawGlyph(ctx, a, sx + rs * 0.85 + 3, sy - rs * 0.85 - 4, Math.min(9, 4 + zoom * 0.5), time);
      }
    }
    if (labels) {
      ctx.font = '500 10px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let k = 0; k < n; k++) {
        const a = agents[this.vis[k]];
        if (a.id === skipId) continue;
        const sx = (a.x - camX) * zoom + hx;
        const sy = (a.y - camY) * zoom + hy + this.rad[k] * zoom + 4;
        ctx.fillStyle = 'rgba(4,7,14,0.75)';
        ctx.fillText(a.name, sx + 1, sy + 1);
        ctx.fillStyle = 'rgba(232,238,250,0.92)';
        ctx.fillText(a.name, sx, sy);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
    if (bars) {
      for (let k = 0; k < n; k++) {
        const a = agents[this.vis[k]];
        if (a.id === skipId) continue;
        const sx = (a.x - camX) * zoom + hx;
        const sy = (a.y - camY) * zoom + hy - this.rad[k] * zoom - 7;
        miniBars(ctx, a, sx, sy, Math.max(16, this.rad[k] * zoom * 2));
      }
    }
  }
}

/** Two stacked micro bars: health (green→red) and stomach (amber). */
export function miniBars(ctx: CanvasRenderingContext2D, a: Agent, cx: number, y: number, w: number): void {
  const mh = a.traits?.maxHealth || 100;
  const mf = a.traits?.maxFood || 100;
  const hp = Math.max(0, Math.min(1, a.health / mh));
  const fd = Math.max(0, Math.min(1, a.food / mf));
  const x = cx - w / 2;
  ctx.fillStyle = 'rgba(4,7,14,0.8)';
  ctx.fillRect(x - 1, y - 1, w + 2, 7);
  ctx.fillStyle = hueColor(hp * 120, 0.8, 0.5);
  ctx.fillRect(x, y, w * hp, 2.5);
  ctx.fillStyle = '#e8b84a';
  ctx.fillRect(x, y + 3.5, w * fd, 2);
}

/** Small vector glyph describing the agent's current action (screen space). */
export function drawGlyph(ctx: CanvasRenderingContext2D, a: Agent, x: number, y: number, s: number, time: number): void {
  switch (a.action) {
    case 'eat': {
      ctx.fillStyle = '#7ee08a';
      ctx.beginPath();
      ctx.ellipse(x, y, s * 0.55, s * 0.3, -0.6, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,60,25,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - s * 0.4, y + s * 0.25);
      ctx.lineTo(x + s * 0.4, y - s * 0.25);
      ctx.stroke();
      break;
    }
    case 'attack': {
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(20,0,0,0.8)';
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(x - s * 0.5, y - s * 0.5);
      ctx.lineTo(x + s * 0.5, y + s * 0.5);
      ctx.moveTo(x + s * 0.5, y - s * 0.5);
      ctx.lineTo(x - s * 0.5, y + s * 0.5);
      ctx.stroke();
      ctx.strokeStyle = '#ff4d4d';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      break;
    }
    case 'flee': {
      ctx.fillStyle = '#ffd34d';
      ctx.font = '800 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', x, y);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      break;
    }
    case 'mate': {
      const k = s * 0.5 * (1 + 0.12 * Math.sin(time * 0.01));
      ctx.fillStyle = '#ff7eb6';
      ctx.beginPath();
      ctx.moveTo(x, y + k * 0.9);
      ctx.bezierCurveTo(x - k * 1.4, y - k * 0.2, x - k * 0.6, y - k * 1.2, x, y - k * 0.45);
      ctx.bezierCurveTo(x + k * 0.6, y - k * 1.2, x + k * 1.4, y - k * 0.2, x, y + k * 0.9);
      ctx.fill();
      break;
    }
    case 'rest': {
      const f = (time * 0.0008) % 1;
      ctx.fillStyle = `rgba(170,200,255,${(1 - f).toFixed(2)})`;
      ctx.font = '700 9px system-ui, sans-serif';
      ctx.fillText('z', x - 2, y - f * 6 + 3);
      break;
    }
    case 'share': {
      ctx.strokeStyle = '#ffd36b';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x - s * 0.45, y);
      ctx.lineTo(x + s * 0.45, y);
      ctx.moveTo(x, y - s * 0.45);
      ctx.lineTo(x, y + s * 0.45);
      ctx.stroke();
      break;
    }
    case 'deposit':
    case 'withdraw': {
      const up = a.action === 'withdraw';
      ctx.strokeStyle = '#e8c45a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - s * 0.5);
      ctx.lineTo(x, y + s * 0.5);
      if (up) {
        ctx.moveTo(x - s * 0.35, y - s * 0.15);
        ctx.lineTo(x, y - s * 0.5);
        ctx.lineTo(x + s * 0.35, y - s * 0.15);
      } else {
        ctx.moveTo(x - s * 0.35, y + s * 0.15);
        ctx.lineTo(x, y + s * 0.5);
        ctx.lineTo(x + s * 0.35, y + s * 0.15);
      }
      ctx.stroke();
      break;
    }
    case 'socialize': {
      ctx.fillStyle = 'rgba(235,240,255,0.85)';
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.arc(x + i * s * 0.35, y, 1.1, 0, TAU);
        ctx.fill();
      }
      break;
    }
    default:
      break;
  }
}
