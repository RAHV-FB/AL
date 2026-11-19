// OWNER: map agents engineer.
/**
 * Batched agent drawing. Visible agents are counting-sorted into colour buckets (one per tribe,
 * then hue buckets for agents without a tribe), so at far zoom the whole population costs two
 * fills per bucket: a darker outline disc and the body. From DETAIL_ZOOM on, every agent gets its
 * own outline (so a crowd stays a pile of distinct bodies) and a few marks: a heading notch in the
 * outline colour, a dot while carrying food and a thin health arc while clearly hurt. The screen
 * pass adds an action glyph and outlined labels placed where they do not collide.
 * No glows, gradients or additive blending.
 */
import type { Simulation } from '../sim/simulation';
import type { ActionKind, Agent } from '../sim/types';
import { HUE_BUCKETS, PAL, bucketPalette, hueBucket, tribeColor, tribeShade } from './colors';

const TAU = Math.PI * 2;
const NO_DASH: number[] = [];
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** CSS px per world unit from which agents get detail marks, action glyphs and labels. */
export const DETAIL_ZOOM = 2.5;
/** CSS px per world unit from which names are written (while fewer than LABEL_MAX_AGENTS are on screen). */
export const NAME_ZOOM = 3.5;
/** CSS px per world unit from which the action is written under each name (names then show in any crowd). */
export const ACTION_LABEL_ZOOM = 6;
/** Names are written while fewer agents than this are on screen (and always from ACTION_LABEL_ZOOM on). */
export const LABEL_MAX_AGENTS = 120;
const MAX_LABELS = 160;

/** Health fraction below which an agent gets a health arc at close zoom. */
const HURT = 0.75;

/** Colour of the thin ring around infected agents (muted yellow-green). */
export const INFECTED_COLOR = '#b4b35c';

/** What an agent is doing, in plain words (map labels). */
export const ACTION_TEXT: Record<ActionKind, string> = {
  idle: 'Idling',
  wander: 'Wandering',
  explore: 'Exploring',
  forage: 'Foraging',
  eat: 'Eating',
  rest: 'Resting',
  flee: 'Fleeing',
  attack: 'Attacking',
  share: 'Sharing food',
  mate: 'Courting',
  socialize: 'Socialising',
  gohome: 'Heading home',
  deposit: 'Storing food',
  withdraw: 'Taking from store',
};

/** Action label, naming the journey while an agent walks on a raid or a migration. */
export function actionText(a: Agent): string {
  const t = a.trek;
  if (t && (a.action === 'wander' || a.action === 'explore' || a.action === 'forage' || a.action === 'gohome' || a.action === 'idle')) {
    return t.kind === 'raid' ? 'On a raid' : 'Migrating';
  }
  return ACTION_TEXT[a.action] ?? a.action;
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

/** How agents are coloured: by tribe (agents without a tribe by their hue gene, paler), or all by the hue gene. */
export type AgentColorMode = 'tribe' | 'genes';

export class AgentPainter {
  /** Indices (into sim.state.agents) of visible agents, and their radii (world units). */
  vis = new Int32Array(1024);
  rad = new Float32Array(1024);
  visN = 0;
  /** Visible agents inside the viewport itself (`vis` also holds a margin around it). */
  onScreen = 0;
  /** Labels written last frame. */
  labelsDrawn = 0;
  private bucketOf = new Int16Array(1024);
  private order = new Int32Array(1024);
  private counts = new Int32Array(HUE_BUCKETS + 64);
  private pos = new Int32Array(HUE_BUCKETS + 64);
  private nb = 0;
  private fills: string[] = [];
  private lines: string[] = [];
  private slot = new Map<number, number>();
  private readonly lonerFill = bucketPalette(0.2, 0.68);
  private readonly lonerLine = bucketPalette(0.12, 0.27);
  private readonly geneFill = bucketPalette(0.45, 0.58);
  private readonly geneLine = bucketPalette(0.4, 0.26);
  // label layout (reused)
  private boxes: number[] = [];
  private lx: number[] = [];
  private ly: number[] = [];
  private lname: string[] = [];
  private lact: (string | null)[] = [];
  private widths = new Map<string, number>();

  /** Start a frame of labels: forget the boxes taken last frame. */
  beginLabels(): void {
    this.boxes.length = 0;
    this.labelsDrawn = 0;
  }

  /** True if a label box (CSS px) is free; then it is taken. */
  reserve(x0: number, y0: number, x1: number, y1: number): boolean {
    if (overlaps(this.boxes, x0, y0, x1, y1)) return false;
    this.boxes.push(x0, y0, x1, y1);
    return true;
  }

  private ensure(n: number): void {
    if (this.vis.length >= n) return;
    const m = Math.max(n, this.vis.length * 2);
    this.vis = new Int32Array(m);
    this.rad = new Float32Array(m);
    this.bucketOf = new Int16Array(m);
    this.order = new Int32Array(m);
  }

  /**
   * Cull and bucket the agents inside the world rectangle (x0,y0)-(x1,y1), which includes a margin of
   * `margin` world units around the viewport.
   */
  collect(sim: Simulation, zoom: number, x0: number, y0: number, x1: number, y1: number, margin = 0, colorBy: AgentColorMode = 'tribe'): void {
    const agents = sim.state.agents;
    this.ensure(agents.length);
    // buckets: one per tribe (colour by tribe), then HUE_BUCKETS gene-hue buckets
    const slot = this.slot;
    slot.clear();
    const fills = this.fills;
    const lines = this.lines;
    let nb = 0;
    const genes = colorBy === 'genes';
    if (!genes) {
      for (const t of sim.state.tribes) {
        if (slot.has(t.id)) continue;
        slot.set(t.id, nb);
        fills[nb] = tribeColor(t.hue);
        lines[nb] = tribeShade(t.hue);
        nb++;
      }
    }
    const base = nb;
    const pf = genes ? this.geneFill : this.lonerFill;
    const pl = genes ? this.geneLine : this.lonerLine;
    for (let i = 0; i < HUE_BUCKETS; i++) {
      fills[nb] = pf[i];
      lines[nb] = pl[i];
      nb++;
    }
    this.nb = nb;
    if (this.counts.length < nb + 1) {
      this.counts = new Int32Array(nb + 33);
      this.pos = new Int32Array(nb + 33);
    }
    const counts = this.counts;
    counts.fill(0);
    const minR = 1.6 / zoom;
    const ix0 = x0 + margin;
    const iy0 = y0 + margin;
    const ix1 = x1 - margin;
    const iy1 = y1 - margin;
    let n = 0;
    let on = 0;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.alive) continue;
      const x = a.x;
      const y = a.y;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (x >= ix0 && x <= ix1 && y >= iy0 && y <= iy1) on++;
      let r = agentRadius(a);
      if (r < minR) r = minR;
      this.vis[n] = i;
      this.rad[n] = r;
      let b = -1;
      if (!genes && a.tribeId >= 0) {
        const s = slot.get(a.tribeId);
        if (s !== undefined) b = s;
      }
      if (b < 0) b = base + hueBucket(a.traits ? a.traits.hue : 0);
      this.bucketOf[n] = b;
      counts[b + 1]++;
      n++;
    }
    this.visN = n;
    this.onScreen = on;
    for (let b = 0; b < nb; b++) counts[b + 1] += counts[b];
    const pos = this.pos;
    pos.set(counts);
    for (let k = 0; k < n; k++) this.order[pos[this.bucketOf[k]]++] = k;
  }

  /** World-space pass (ctx in world units). `diseaseMode` thickens the infected rings. */
  draw(ctx: CanvasRenderingContext2D, sim: Simulation, zoom: number, diseaseMode: boolean): void {
    const n = this.visN;
    if (!n) return;
    const agents = sim.state.agents;
    const vis = this.vis;
    const rad = this.rad;
    const order = this.order;
    const counts = this.counts;
    const px = 1 / zoom;
    const detail = zoom >= DETAIL_ZOOM;
    ctx.globalAlpha = 1;
    ctx.setLineDash(NO_DASH);

    if (!detail) {
      // far and mid zoom: per bucket, a darker outline disc then the body
      const ow = 0.85 * px;
      for (let b = 0; b < this.nb; b++) {
        const s = counts[b];
        const e = counts[b + 1];
        if (e <= s) continue;
        ctx.fillStyle = this.lines[b];
        ctx.beginPath();
        for (let j = s; j < e; j++) {
          const k = order[j];
          const a = agents[vis[k]];
          const r = rad[k] + Math.max(ow, rad[k] * 0.12);
          ctx.moveTo(a.x + r, a.y);
          ctx.arc(a.x, a.y, r, 0, TAU);
        }
        ctx.fill();
        ctx.fillStyle = this.fills[b];
        ctx.beginPath();
        for (let j = s; j < e; j++) {
          const k = order[j];
          const a = agents[vis[k]];
          const r = rad[k];
          ctx.moveTo(a.x + r, a.y);
          ctx.arc(a.x, a.y, r, 0, TAU);
        }
        ctx.fill();
      }
    } else {
      for (let b = 0; b < this.nb; b++) {
        const s = counts[b];
        const e = counts[b + 1];
        if (e <= s) continue;
        // heading notches in the outline colour, under the bodies so only the tip shows
        ctx.fillStyle = this.lines[b];
        ctx.beginPath();
        for (let j = s; j < e; j++) {
          const k = order[j];
          const a = agents[vis[k]];
          const r = rad[k];
          const hd = Number.isFinite(a.heading) ? a.heading : 0;
          const c = Math.cos(hd);
          const sn = Math.sin(hd);
          const bx = a.x + c * r * 0.7;
          const by = a.y + sn * r * 0.7;
          const w = r * 0.42;
          ctx.moveTo(a.x + c * r * 1.46, a.y + sn * r * 1.46);
          ctx.lineTo(bx - sn * w, by + c * w);
          ctx.lineTo(bx + sn * w, by - c * w);
          ctx.closePath();
        }
        ctx.fill();
        // bodies one by one so overlapping agents stay distinct
        ctx.fillStyle = this.fills[b];
        ctx.strokeStyle = this.lines[b];
        for (let j = s; j < e; j++) {
          const k = order[j];
          const a = agents[vis[k]];
          const r = rad[k];
          ctx.lineWidth = Math.max(px, r * 0.16);
          ctx.beginPath();
          ctx.arc(a.x, a.y, r, 0, TAU);
          ctx.fill();
          ctx.stroke();
        }
      }
      // carried food: a small ochre dot at the back
      ctx.beginPath();
      let carry = false;
      for (let k = 0; k < n; k++) {
        const a = agents[vis[k]];
        if (!(a.carried > 0.5)) continue;
        carry = true;
        const r = rad[k];
        const hd = Number.isFinite(a.heading) ? a.heading : 0;
        const cx = a.x - Math.cos(hd) * r * 0.42;
        const cy = a.y - Math.sin(hd) * r * 0.42;
        const cr = Math.max(1.3 * px, r * 0.3);
        ctx.moveTo(cx + cr, cy);
        ctx.arc(cx, cy, cr, 0, TAU);
      }
      if (carry) {
        ctx.fillStyle = PAL.ochre;
        ctx.fill();
        ctx.strokeStyle = PAL.ink;
        ctx.lineWidth = px;
        ctx.stroke();
      }
      // health arcs while clearly hurt: dark track, then the remaining health (light, ochre below half, rust below a quarter)
      this.healthArcs(ctx, agents, zoom);
    }

    // infected agents: a thin muted yellow-green ring
    ctx.beginPath();
    let sick = false;
    const gap = (detail ? 4.2 : 1.6) * px;
    for (let k = 0; k < n; k++) {
      const a = agents[vis[k]];
      if (!(a.infection > 0)) continue;
      sick = true;
      const r = rad[k] * (detail ? 1 : 1.12) + gap;
      ctx.moveTo(a.x + r, a.y);
      ctx.arc(a.x, a.y, r, 0, TAU);
    }
    if (sick) {
      ctx.strokeStyle = INFECTED_COLOR;
      ctx.lineWidth = (diseaseMode ? 2 : 1.25) * px;
      ctx.stroke();
    }
  }

  private healthArcs(ctx: CanvasRenderingContext2D, agents: Agent[], zoom: number): void {
    const px = 1 / zoom;
    const n = this.visN;
    const vis = this.vis;
    const rad = this.rad;
    let any = false;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const a = agents[vis[k]];
      const mh = a.traits?.maxHealth || 100;
      if (!(a.health < mh * HURT)) continue;
      any = true;
      const r = rad[k] * 1.08 + 2.2 * px;
      ctx.moveTo(a.x + r, a.y);
      ctx.arc(a.x, a.y, r, 0, TAU);
    }
    if (!any) return;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(19,18,16,0.5)';
    ctx.lineWidth = 2.4 * px;
    ctx.stroke();
    ctx.lineWidth = 1.4 * px;
    for (let level = 0; level < 3; level++) {
      ctx.beginPath();
      let drew = false;
      for (let k = 0; k < n; k++) {
        const a = agents[vis[k]];
        const mh = a.traits?.maxHealth || 100;
        const f = a.health / mh;
        if (!(f < HURT)) continue;
        const lv = f >= 0.5 ? 0 : f >= 0.25 ? 1 : 2;
        if (lv !== level) continue;
        const fr = f > 0 ? f : 0;
        if (fr <= 0.01) continue;
        drew = true;
        const r = rad[k] * 1.08 + 2.2 * px;
        const a0 = -Math.PI / 2;
        ctx.moveTo(a.x + Math.cos(a0) * r, a.y + Math.sin(a0) * r);
        ctx.arc(a.x, a.y, r, a0, a0 + fr * TAU);
      }
      if (!drew) continue;
      ctx.strokeStyle = level === 0 ? PAL.text : level === 1 ? PAL.ochre : PAL.rust;
      ctx.stroke();
    }
  }

  /**
   * Screen-space pass (ctx in CSS px; camX/camY/zoom/vw/vh describe the camera): action glyphs and labels
   * at close zoom, in the places left free (see beginLabels, reserve, drawSelectedName). `showLabels` false
   * writes no names.
   */
  drawScreen(
    ctx: CanvasRenderingContext2D,
    sim: Simulation,
    zoom: number,
    camX: number,
    camY: number,
    vw: number,
    vh: number,
    showLabels: boolean,
    selId: number,
    night = 0,
  ): void {
    const agents = sim.state.agents;
    const hx = vw / 2;
    const hy = vh / 2;
    const boxes = this.boxes;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash(NO_DASH);
    ctx.globalAlpha = 1;
    const n = this.visN;
    if (!n || zoom < DETAIL_ZOOM) return;
    if (n < 700) this.drawGlyphs(ctx, agents, zoom, camX, camY, vw, vh, night < 0.5);
    const names = showLabels && ((zoom >= NAME_ZOOM && this.onScreen < LABEL_MAX_AGENTS) || zoom >= ACTION_LABEL_ZOOM);
    if (!names) return;
    const withAction = zoom >= ACTION_LABEL_ZOOM;
    ctx.font = `500 11px ${FONT}`;
    const lx = this.lx;
    const ly = this.ly;
    const lname = this.lname;
    const lact = this.lact;
    let m = 0;
    for (let k = 0; k < n && m < MAX_LABELS; k++) {
      const a = agents[this.vis[k]];
      if (a.id === selId) continue;
      const sx = (a.x - camX) * zoom + hx;
      const sy = (a.y - camY) * zoom + hy;
      if (sx < -40 || sx > vw + 40 || sy < -20 || sy > vh + 20) continue;
      const name = a.name || `Agent ${a.id}`;
      let w = this.widths.get(name);
      if (w === undefined) {
        w = ctx.measureText(name).width;
        if (this.widths.size > 3000) this.widths.clear();
        this.widths.set(name, w);
      }
      const act = withAction ? actionText(a) : null;
      const ty = sy + this.rad[k] * zoom + 4;
      const half = Math.max(w, act ? act.length * 5.6 : 0) / 2 + 2;
      const bx0 = sx - half;
      const bx1 = sx + half;
      const by0 = ty - 1;
      const by1 = ty + (act ? 27 : 14);
      if (overlaps(boxes, bx0, by0, bx1, by1)) continue;
      boxes.push(bx0, by0, bx1, by1);
      lx[m] = sx;
      ly[m] = ty;
      lname[m] = name;
      lact[m] = act;
      m++;
    }
    this.labelsDrawn += m;
    if (!m) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 3;
    for (let i = 0; i < m; i++) ctx.strokeText(lname[i], lx[i], ly[i]);
    ctx.fillStyle = PAL.text;
    for (let i = 0; i < m; i++) ctx.fillText(lname[i], lx[i], ly[i]);
    if (withAction) {
      ctx.font = `400 11px ${FONT}`;
      for (let i = 0; i < m; i++) if (lact[i]) ctx.strokeText(lact[i]!, lx[i], ly[i] + 13);
      ctx.fillStyle = '#cbc4b4';
      for (let i = 0; i < m; i++) if (lact[i]) ctx.fillText(lact[i]!, lx[i], ly[i] + 13);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /**
   * Name (and from zoom 1.4 the action) of the selected agent, at every zoom while names are on (screen
   * space). Call it before the other labels: its place is taken first.
   */
  drawSelectedName(ctx: CanvasRenderingContext2D, sim: Simulation, zoom: number, camX: number, camY: number, vw: number, vh: number, showLabels: boolean, selId: number): void {
    const sel = selId >= 0 && showLabels ? sim.getAgent(selId) : undefined;
    if (!sel) return;
    const sx = (sel.x - camX) * zoom + vw / 2;
    const sy = (sel.y - camY) * zoom + vh / 2;
    if (sx < -80 || sx > vw + 80 || sy < -40 || sy > vh + 40) return;
    const rs = Math.max(1.6, agentRadius(sel) * zoom);
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 1;
    this.drawSelectedLabel(ctx, sel, sx, sy + rs * 1.1 + 8, zoom >= 1.4);
  }

  private drawSelectedLabel(ctx: CanvasRenderingContext2D, a: Agent, sx: number, ty: number, withAction: boolean): void {
    const name = a.name || `Agent ${a.id}`;
    const act = withAction ? actionText(a) : null;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `600 12px ${FONT}`;
    const w = ctx.measureText(name).width;
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 3.2;
    ctx.strokeText(name, sx, ty);
    ctx.fillStyle = PAL.text;
    ctx.fillText(name, sx, ty);
    let h = 15;
    if (act) {
      ctx.font = `400 11px ${FONT}`;
      ctx.strokeText(act, sx, ty + 14);
      ctx.fillStyle = '#d9d2c3';
      ctx.fillText(act, sx, ty + 14);
      h += 13;
    }
    const half = Math.max(w, act ? act.length * 5.6 : 0) / 2 + 2;
    this.boxes.push(sx - half, ty - 1, sx + half, ty + h);
    this.labelsDrawn++;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /**
   * Small vector glyphs for eating, resting, attacking, fleeing and courting, batched per kind. Resting is
   * marked by day only (at night nearly everyone sleeps, so the marks would only add clutter).
   */
  private drawGlyphs(ctx: CanvasRenderingContext2D, agents: Agent[], zoom: number, camX: number, camY: number, vw: number, vh: number, restMarks: boolean): void {
    const hx = vw / 2;
    const hy = vh / 2;
    let eat: Path2D | null = null;
    let rest: Path2D | null = null;
    let fight: Path2D | null = null;
    let flee: Path2D | null = null;
    let mate: Path2D | null = null;
    for (let k = 0; k < this.visN; k++) {
      const a = agents[this.vis[k]];
      const act = a.action;
      if (act !== 'eat' && act !== 'attack' && act !== 'flee' && act !== 'mate' && !(act === 'rest' && restMarks)) continue;
      const sx = (a.x - camX) * zoom + hx;
      const sy = (a.y - camY) * zoom + hy;
      if (sx < -20 || sx > vw + 20 || sy < -20 || sy > vh + 20) continue;
      const rs = this.rad[k] * zoom;
      // glyph half-size grows a little with the body, within 4.6 to 11 px
      const s = Math.min(11, Math.max(4.6, rs * 0.3));
      const gx = sx + rs * 0.74 + s * 0.9;
      const gy = sy - rs * 0.74 - s * 0.9;
      switch (act) {
        case 'eat': {
          const p = (eat ??= new Path2D());
          // a leaf with its midrib
          p.moveTo(gx - s * 0.8, gy + s * 0.6);
          p.quadraticCurveTo(gx - s * 0.7, gy - s * 0.7, gx + s * 0.8, gy - s * 0.6);
          p.quadraticCurveTo(gx + s * 0.7, gy + s * 0.7, gx - s * 0.8, gy + s * 0.6);
          p.lineTo(gx + s * 0.15, gy - s * 0.1);
          break;
        }
        case 'rest': {
          const p = (rest ??= new Path2D());
          // a crescent moon
          const R = s * 0.78;
          p.moveTo(gx + R * Math.cos(-1.15), gy + R * Math.sin(-1.15));
          p.arc(gx, gy, R, -1.15, 1.15, true);
          p.arc(gx + 0.75 * R, gy, 0.971 * R, 1.928, TAU - 1.928, false);
          p.closePath();
          break;
        }
        case 'attack': {
          const p = (fight ??= new Path2D());
          const q = s * 0.62;
          p.moveTo(gx - q, gy - q);
          p.lineTo(gx + q, gy + q);
          p.moveTo(gx + q, gy - q);
          p.lineTo(gx - q, gy + q);
          break;
        }
        case 'flee': {
          // speed lines trailing behind the body
          const p = (flee ??= new Path2D());
          const hd = Number.isFinite(a.heading) ? a.heading : 0;
          const c = Math.cos(hd);
          const sn = Math.sin(hd);
          for (let i = -1; i <= 1; i += 2) {
            const off = i * Math.max(2.2, rs * 0.32);
            const bx = sx - c * (rs + 3) - sn * off;
            const by = sy - sn * (rs + 3) + c * off;
            const len = s * 1.2;
            p.moveTo(bx, by);
            p.lineTo(bx - c * len, by - sn * len);
          }
          break;
        }
        case 'mate': {
          const p = (mate ??= new Path2D());
          p.moveTo(gx, gy + s * 0.72);
          p.bezierCurveTo(gx - s * 1.15, gy - s * 0.05, gx - s * 0.55, gy - s * 0.95, gx, gy - s * 0.32);
          p.bezierCurveTo(gx + s * 0.55, gy - s * 0.95, gx + s * 1.15, gy - s * 0.05, gx, gy + s * 0.72);
          p.closePath();
          break;
        }
      }
    }
    if (!eat && !rest && !fight && !flee && !mate) return;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 3.4;
    if (eat) ctx.stroke(eat);
    if (rest) ctx.stroke(rest);
    if (fight) ctx.stroke(fight);
    if (flee) ctx.stroke(flee);
    if (mate) ctx.stroke(mate);
    ctx.lineWidth = 1.5;
    if (eat) {
      ctx.strokeStyle = PAL.sage;
      ctx.stroke(eat);
    }
    if (rest) {
      ctx.strokeStyle = PAL.text;
      ctx.stroke(rest);
    }
    if (fight) {
      ctx.strokeStyle = PAL.rust;
      ctx.stroke(fight);
    }
    if (flee) {
      ctx.strokeStyle = PAL.text;
      ctx.stroke(flee);
    }
    if (mate) {
      ctx.strokeStyle = PAL.sand;
      ctx.stroke(mate);
    }
  }
}

function overlaps(boxes: number[], x0: number, y0: number, x1: number, y1: number): boolean {
  for (let i = 0; i < boxes.length; i += 4) {
    if (x0 < boxes[i + 2] && x1 > boxes[i] && y0 < boxes[i + 3] && y1 > boxes[i + 1]) return true;
  }
  return false;
}
