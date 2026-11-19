// OWNER: map agents engineer (renderer.ts, agents.ts, effects.ts, colors.ts).
/**
 * World renderer (Canvas 2D). Frame order:
 *   ground (terrain layer) → winter frost → night (flat darkening) → data overlay → disasters
 *   → territory edges (close zoom) → selection extras (vision, trail, route) → connections
 *   → agents (batched; detail at close zoom) → partner rings → camps → brush
 *   → screen pass (camp labels, disaster labels, rings, agent glyphs and labels, tie markers,
 *     whole-map disaster notes, overlay legend, minimap, connections legend).
 * Flat colours only: no gradients, glows, shadows or additive blending.
 * The simulation is read-only here; every cache is renderer-side and rebuilt lazily.
 */
import type { Simulation } from '../sim/simulation';
import type { Agent, EnvState } from '../sim/types';
import { SOCIAL_TUNING } from '../sim/social';
import { Camera } from './camera';
import { TerrainLayer } from './terrainLayer';
import { LEGEND_WIDTH, OverlayLayer } from './overlays';
import { DisasterFx } from './effects';
import { AgentPainter, DETAIL_ZOOM, agentRadius, type AgentColorMode } from './agents';
import { Minimap } from './minimap';
import { PAL, TIE, flatPanel, tribeColor, tribeShade } from './colors';

export type OverlayKind = 'none' | 'food' | 'fertility' | 'density' | 'territory' | 'disease' | 'climate';

export interface ViewOptions {
  overlay: OverlayKind;
  selectedId: number; // -1 none
  hoverId: number; // -1 none
  showVision: boolean; // draw selected agent's perception radius
  showTrails: boolean; // trail and planned route of the selected agent
  /** Lines from the selected agent to its family, friends and enemies (default true; showConnections false hides them too). */
  showRelations?: boolean;
  /**
   * Connections between agents (default true when undefined): at close zoom, lines between visible agents
   * with strong ties (mother and child, friends, enemies); the selected agent's ties at every zoom.
   */
  showConnections?: boolean;
  showCamps: boolean; // tribe camp markers (and territory edges at close zoom)
  showLabels: boolean; // names at close zoom
  /** Colour agents by tribe (default) or every agent by its hue gene, which shows lineages. */
  colorBy?: AgentColorMode;
  /** Brush preview circle (world coords & radius) for the active tool, or null. */
  brush: { x: number; y: number; radius: number; color: string } | null;
  /** Minimap in the bottom-left corner (default true). */
  showMinimap?: boolean;
  /** Overlay legend in the bottom-right corner (default true). */
  showLegend?: boolean;
  /** Screen areas (CSS px) covered by UI panels; minimap & legends stay clear of them. */
  insets?: { top: number; right: number; bottom: number; left: number };
}

export interface RenderStats {
  /** Smoothed frames per second (from the `time` passed to render). */
  fps: number;
  /** Smoothed CPU time spent inside render() in ms. */
  drawMs: number;
  /** Agents drawn last frame (after culling). */
  agentsDrawn: number;
  /** Connection lines drawn last frame. */
  connections: number;
  /** Agent labels written last frame. */
  labels: number;
}

/** Visible world rectangle and zoom (CSS px per world unit), passed to the terrain layer. */
export interface GroundView {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  zoom: number;
}

type TerrainDraw = (ctx: CanvasRenderingContext2D, worldW: number, worldH: number, view?: GroundView) => void;

const TAU = Math.PI * 2;
const TRAIL_N = 240;
const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Lines between agents per frame at most (the selected agent's ties come on top). */
const MAX_LINES = 600;
/** Personal affinity from which two agents count as friends / enemies (the simulation's own thresholds). */
const FRIEND = SOCIAL_TUNING.friend;
const ENEMY = SOCIAL_TUNING.grudge;

/** Kinds of ties between agents (index into TIE_COLOR). */
const FAMILY = 0;
const FRIENDS = 1;
const ENEMIES = 2;
type TieKind = typeof FAMILY | typeof FRIENDS | typeof ENEMIES;
const TIE_COLOR = [TIE.family, TIE.friend, TIE.enemy];

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly camera = new Camera();
  readonly stats: RenderStats = { fps: 0, drawMs: 0, agentsDrawn: 0, connections: 0, labels: 0 };
  /** Effective device pixel ratio (capped at 2). */
  dpr = 1;

  private terrain = new TerrainLayer();
  private overlays = new OverlayLayer();
  private fx = new DisasterFx();
  private painter = new AgentPainter();
  private minimap = new Minimap();
  private frame = 0;
  private lastTime = -1;
  private lastSim: Simulation | null = null;
  private bounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private viewRect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private ground: GroundView = { x0: 0, y0: 0, x1: 0, y1: 0, zoom: 1 };
  private tmp = { x: 0, y: 0 };
  private dash = [0, 0];
  private noDash: number[] = [];
  private ro: ResizeObserver | null = null;
  // selected-agent trail ring buffer
  private trail = new Float32Array(TRAIL_N * 2);
  private trailHead = 0;
  private trailLen = 0;
  private trailId = -1;
  // the selected agent's ties (filled while drawing its lines; used for rings and edge markers)
  private tieAgents: Agent[] = [];
  private tieKinds: number[] = [];
  private tieSeen = new Set<number>();
  // territory edges per tribe (reused segment lists)
  private edgeSegs = new Map<number, number[]>();
  // camera snapshot for screen-space helpers
  private camX = 0;
  private camY = 0;
  private camZ = 1;
  private readonly toSX = (x: number) => (x - this.camX) * this.camZ + this.camera.viewW / 2;
  private readonly toSY = (y: number) => (y - this.camY) * this.camZ + this.camera.viewH / 2;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D not supported');
    this.ctx = ctx;
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);
    }
  }

  /** Stop observing canvas size changes. */
  destroy(): void {
    this.ro?.disconnect();
    this.ro = null;
  }

  /** Match the backing store to the element size × devicePixelRatio (capped at 2). */
  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width * dpr));
    const h = Math.max(1, Math.floor(r.height * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.dpr = dpr;
    this.camera.viewW = Math.max(1, r.width);
    this.camera.viewH = Math.max(1, r.height);
  }

  /** World point under a screen point (CSS px) if it lies on the minimap, else null. */
  minimapToWorld(sx: number, sy: number): { x: number; y: number } | null {
    const sim = this.lastSim;
    if (!sim) return null;
    return this.minimap.hit(sx, sy, sim.worldW, sim.worldH);
  }

  /** Alias of minimapToWorld (UI feature detection looks for this name). */
  minimapHit(sx: number, sy: number): { x: number; y: number } | null {
    return this.minimapToWorld(sx, sy);
  }

  /** Minimap placement in CSS px (visible=false when hidden). */
  get minimapRect(): { x: number; y: number; w: number; h: number; visible: boolean } {
    return this.minimap.rect;
  }

  /** Overlay legend placement in CSS px from the last frame (visible=false when not drawn). */
  readonly legendRect = { x: 0, y: 0, w: 0, h: 0, visible: false };

  /** Connections legend placement in CSS px from the last frame (visible while connection lines are drawn). */
  readonly connectionsLegendRect = { x: 0, y: 0, w: 0, h: 0, visible: false };

  /** Draw one frame. `time` is a monotonically increasing ms clock for animation only. */
  render(sim: Simulation, view: ViewOptions, time: number): void {
    const t0 = performance.now();
    const ctx = this.ctx;
    const cam = this.camera;
    if (sim !== this.lastSim) {
      this.lastSim = sim;
      this.terrain.reset();
      this.trailId = -1;
      this.trailLen = 0;
    }
    const dt = this.lastTime < 0 ? 16 : Math.max(0, Math.min(250, time - this.lastTime));
    this.lastTime = time;
    if (dt > 0) {
      const inst = 1000 / dt;
      this.stats.fps = this.stats.fps > 0 ? this.stats.fps * 0.93 + inst * 0.07 : inst;
    }
    this.frame++;
    if (cam.viewW <= 1 || this.canvas.width <= 1) this.resize();

    cam.setWorld(sim.worldW, sim.worldH);
    cam.update(dt);
    const dpr = this.canvas.width / Math.max(1, cam.viewW);
    const z = cam.zoom;
    const vw = cam.viewW;
    const vh = cam.viewH;
    this.camX = cam.x;
    this.camY = cam.y;
    this.camZ = z;
    const state = sim.state;
    const world = state.world;
    const env = state.env;
    const WW = sim.worldW;
    const WH = sim.worldH;

    // ---- caches
    this.terrain.syncTerrain(world);
    if (this.frame % 8 === 0 || this.terrain.vegTick < 0) this.terrain.updateVegetation(world, env, state.config?.foodCapacity ?? 1, state.tick);
    this.overlays.update(sim, view.overlay, this.frame);
    this.fx.sync(sim, time);

    // ---- background: flat, no pattern
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = PAL.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // ---- world space
    const ox = vw / 2 - cam.x * z;
    const oy = vh / 2 - cam.y * z;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * ox, dpr * oy);
    const b = cam.visibleBounds(10, this.bounds);
    const vr = cam.visibleBounds(0, this.viewRect);
    const px = 1 / z;

    const g = this.ground;
    g.x0 = vr.x0;
    g.y0 = vr.y0;
    g.x1 = vr.x1;
    g.y1 = vr.y1;
    g.zoom = z;
    (this.terrain.draw as TerrainDraw).call(this.terrain, ctx, WW, WH, g);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.drawFrost(ctx, env, WW, WH);
    this.drawNight(ctx, env, sim, WW, WH);
    ctx.strokeStyle = PAL.border2;
    ctx.lineWidth = px;
    ctx.strokeRect(0, 0, WW, WH);

    this.overlays.draw(ctx, sim, view.overlay, z);
    ctx.globalAlpha = 1;
    this.fx.drawWorld(ctx, time, z, b.x0, b.y0, b.x1, b.y1, WW, WH);
    if (view.showCamps && z >= DETAIL_ZOOM && view.overlay !== 'territory') this.drawTerritoryEdges(ctx, sim, z);

    const sel = view.selectedId >= 0 ? sim.getAgent(view.selectedId) : undefined;
    this.updateTrail(sel);
    if (sel) this.drawSelectionWorld(ctx, sel, view, z);

    this.painter.collect(sim, z, b.x0, b.y0, b.x1, b.y1, 10, view.colorBy ?? 'tribe');
    const lines = this.drawConnections(ctx, sim, view, sel, z);
    this.painter.draw(ctx, sim, z, view.overlay === 'disease');
    this.stats.agentsDrawn = this.painter.visN;
    this.stats.connections = lines;
    if (sel && this.tieAgents.length) this.drawPartnerRings(ctx, z);
    if (view.showCamps) this.drawCamps(ctx, sim, z);
    if (view.brush) this.drawBrush(ctx, view.brush, z);

    // ---- screen space (CSS px)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    if (view.showCamps) this.drawCampLabels(ctx, sim, z, vw, vh);
    this.fx.drawLabels(ctx, time, this.toSX, this.toSY, z, vw, vh);
    const hov = view.hoverId >= 0 && view.hoverId !== view.selectedId ? sim.getAgent(view.hoverId) : undefined;
    if (hov) this.drawRing(ctx, hov, false);
    if (sel) this.drawRing(ctx, sel, true);
    this.painter.drawScreen(ctx, sim, z, cam.x, cam.y, vw, vh, view.showLabels, sel ? sel.id : -1);
    this.stats.labels = this.painter.labelsDrawn;
    if (sel && this.tieAgents.length) this.drawTieMarkers(ctx, sel, vw, vh);
    const ins = view.insets ?? NO_INSETS;
    this.fx.drawScreen(ctx, time, vw, vh, ins);

    const lr = this.legendRect;
    lr.visible = false;
    if (view.showLegend !== false && view.overlay !== 'none') {
      const right = vw - ins.right - 12;
      const bottom = vh - ins.bottom - 12;
      lr.h = this.overlays.drawLegend(ctx, sim, view.overlay, right, bottom);
      lr.w = LEGEND_WIDTH;
      lr.x = right - lr.w;
      lr.y = bottom - lr.h;
      lr.visible = lr.h > 0;
    }
    if (view.showMinimap !== false && vw > 480 && vh > 320) {
      const mw = Math.round(Math.max(130, Math.min(220, vw * 0.15)));
      const mh = Math.round((mw * WH) / WW);
      this.minimap.update(sim, this.terrain, this.fx, this.frame, time, mw, mh, dpr);
      this.minimap.draw(ctx, cam, sim, ins.left + 14, vh - ins.bottom - 14 - mh, mw, mh);
    } else this.minimap.rect.visible = false;
    this.drawConnectionsLegend(ctx, lines > 0, ins, vh);

    const ms = performance.now() - t0;
    this.stats.drawMs = this.stats.drawMs > 0 ? this.stats.drawMs * 0.9 + ms * 0.1 : ms;
  }

  /** Agent under a screen point (CSS px), or null. Generous hit radius for small agents. */
  pickAgent(sim: Simulation, sx: number, sy: number): Agent | null {
    const w = this.camera.screenToWorld(sx, sy, this.tmp);
    const hit = Math.max(2.5, 11 / this.camera.zoom);
    let best: Agent | null = null;
    let bestD = Infinity;
    const agents = sim.state.agents;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.alive) continue;
      const dx = a.x - w.x;
      const dy = a.y - w.y;
      if (Math.abs(dx) > 40 || Math.abs(dy) > 40) continue;
      const d = Math.sqrt(dx * dx + dy * dy) - agentRadius(a);
      if (d < hit && d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ lighting

  /** Light frost in winter and during strong cold (flat, very faint). */
  private drawFrost(ctx: CanvasRenderingContext2D, env: EnvState | undefined, WW: number, WH: number): void {
    if (!env) return;
    const s = env.season & 3;
    const p = Math.max(0, Math.min(1, env.seasonProgress || 0));
    let w = 0;
    if (s === 3) w = p > 0.7 ? 1 - (p - 0.7) / 0.3 : 1;
    else if (s === 2 && p > 0.7) w = (p - 0.7) / 0.3;
    const cold = env.tempOffset < -2 ? Math.min(0.06, -env.tempOffset * 0.005) : 0;
    const a = w * 0.05 + cold;
    if (a < 0.004) return;
    ctx.globalAlpha = a;
    ctx.fillStyle = PAL.text;
    ctx.fillRect(0, 0, WW, WH);
    ctx.globalAlpha = 1;
  }

  /** Flat darkening of the world at night (no tint, vignette or gradient). Returns the night amount 0..1. */
  private drawNight(ctx: CanvasRenderingContext2D, env: EnvState | undefined, sim: Simulation, WW: number, WH: number): number {
    if (!env || sim.state.config?.dayNight === false) return 0;
    const day = Number.isFinite(env.daylight) ? Math.max(0, Math.min(1, env.daylight)) : 1;
    let n = 1 - day;
    n = n * n * (3 - 2 * n);
    if (n < 0.01) return 0;
    ctx.fillStyle = `rgba(10,11,14,${(n * 0.52).toFixed(3)})`;
    ctx.fillRect(0, 0, WW, WH);
    return n;
  }

  // ------------------------------------------------------------ camps and territory

  /** Half-size of a camp marker in world units (about 7 px on screen, growing with the land up close). */
  private campSize(z: number): number {
    return Math.max(7 / z, 4.5);
  }

  /** A small hut in the tribe colour at each camp (world space, over the agents). */
  private drawCamps(ctx: CanvasRenderingContext2D, sim: Simulation, z: number): void {
    const b = this.bounds;
    const px = 1 / z;
    const s = this.campSize(z);
    ctx.lineJoin = 'round';
    ctx.setLineDash(this.noDash);
    for (const t of sim.state.tribes) {
      if (t.extinctTick !== -1) continue;
      const x = t.homeX;
      const y = t.homeY;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < b.x0 - s || x > b.x1 + s || y < b.y0 - s || y > b.y1 + s) continue;
      ctx.beginPath();
      ctx.moveTo(x - s * 0.8, y + s * 0.72);
      ctx.lineTo(x - s * 0.8, y - s * 0.12);
      ctx.lineTo(x, y - s * 0.88);
      ctx.lineTo(x + s * 0.8, y - s * 0.12);
      ctx.lineTo(x + s * 0.8, y + s * 0.72);
      ctx.closePath();
      ctx.fillStyle = tribeColor(t.hue);
      ctx.fill();
      ctx.strokeStyle = tribeShade(t.hue);
      ctx.lineWidth = Math.max(1.5 * px, s * 0.13);
      ctx.stroke();
      ctx.fillStyle = tribeShade(t.hue);
      ctx.fillRect(x - s * 0.2, y + s * 0.18, s * 0.4, s * 0.54);
    }
  }

  /** Tribe name and stored food under each camp (screen space). */
  private drawCampLabels(ctx: CanvasRenderingContext2D, sim: Simulation, z: number, vw: number, vh: number): void {
    if (z < 0.33) return;
    const s = this.campSize(z) * z;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = PAL.ink;
    for (const t of sim.state.tribes) {
      if (t.extinctTick !== -1) continue;
      const sx = this.toSX(t.homeX);
      const sy = this.toSY(t.homeY) + s * 0.72 + 5;
      if (sx < -120 || sx > vw + 120 || sy < -40 || sy > vh + 20) continue;
      ctx.font = `600 12px ${FONT}`;
      ctx.lineWidth = 3.2;
      ctx.strokeText(t.name, sx, sy);
      ctx.fillStyle = PAL.text;
      ctx.fillText(t.name, sx, sy);
      if (z >= 0.9) {
        const stock = Math.round(Math.max(0, t.stockpile || 0));
        const line = stock > 0 ? `${stock.toLocaleString('en-US')} food stored` : 'No food stored';
        ctx.font = `400 11px ${FONT}`;
        ctx.lineWidth = 3;
        ctx.strokeText(line, sx, sy + 15);
        ctx.fillStyle = '#cbc4b4';
        ctx.fillText(line, sx, sy + 15);
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /**
   * Territory edges of the visible tiles (close zoom, without the territory overlay): a thin dashed line in
   * each tribe's colour on its own side of the border.
   */
  private drawTerritoryEdges(ctx: CanvasRenderingContext2D, sim: Simulation, z: number): void {
    const world = sim.state.world;
    const W = world.width;
    const H = world.height;
    const ter = world.territory;
    if (!ter || ter.length !== W * H) return;
    const ts = world.tileSize;
    const vr = this.viewRect;
    const tx0 = Math.max(0, Math.floor(vr.x0 / ts) - 1);
    const ty0 = Math.max(0, Math.floor(vr.y0 / ts) - 1);
    const tx1 = Math.min(W - 1, Math.floor(vr.x1 / ts) + 1);
    const ty1 = Math.min(H - 1, Math.floor(vr.y1 / ts) + 1);
    if (tx1 < tx0 || ty1 < ty0) return;
    const segs = this.edgeSegs;
    for (const v of segs.values()) v.length = 0;
    const off = 1.6 / z;
    const push = (id: number, x0: number, y0: number, x1: number, y1: number) => {
      let v = segs.get(id);
      if (!v) {
        v = [];
        segs.set(id, v);
      }
      v.push(x0, y0, x1, y1);
    };
    let any = false;
    for (let ty = ty0; ty <= ty1; ty++) {
      const row = ty * W;
      for (let tx = tx0; tx <= tx1; tx++) {
        const id = ter[row + tx];
        if (tx + 1 < W) {
          const r = ter[row + tx + 1];
          if (r !== id) {
            const ex = (tx + 1) * ts;
            if (id >= 0) push(id, ex - off, ty * ts, ex - off, (ty + 1) * ts);
            if (r >= 0) push(r, ex + off, ty * ts, ex + off, (ty + 1) * ts);
            any = true;
          }
        }
        if (ty + 1 < H) {
          const d = ter[row + W + tx];
          if (d !== id) {
            const ey = (ty + 1) * ts;
            if (id >= 0) push(id, tx * ts, ey - off, (tx + 1) * ts, ey - off);
            if (d >= 0) push(d, tx * ts, ey + off, (tx + 1) * ts, ey + off);
            any = true;
          }
        }
      }
    }
    if (!any) return;
    ctx.lineCap = 'butt';
    ctx.lineWidth = 1.2 / z;
    this.dash[0] = 5 / z;
    this.dash[1] = 4 / z;
    ctx.setLineDash(this.dash);
    ctx.globalAlpha = 0.75;
    for (const [id, v] of segs) {
      if (!v.length) continue;
      const tr = sim.getTribe(id);
      if (!tr) continue;
      ctx.strokeStyle = tribeColor(tr.hue);
      ctx.beginPath();
      for (let i = 0; i < v.length; i += 4) {
        ctx.moveTo(v[i], v[i + 1]);
        ctx.lineTo(v[i + 2], v[i + 3]);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash(this.noDash);
  }

  // ------------------------------------------------------------ connections

  /**
   * Lines between agents with strong ties (world space, under the bodies). At close zoom: every mother and
   * child, friends and enemies among the visible agents (capped). At every zoom: the selected agent's ties,
   * drawn wider; the others are dimmed while an agent is selected. Returns the number of lines drawn.
   */
  private drawConnections(ctx: CanvasRenderingContext2D, sim: Simulation, view: ViewOptions, sel: Agent | undefined, z: number): number {
    this.tieAgents.length = 0;
    this.tieKinds.length = 0;
    if (view.showConnections === false) return 0;
    const px = 1 / z;
    let count = 0;
    ctx.lineCap = 'round';
    ctx.setLineDash(this.noDash);
    if (z >= DETAIL_ZOOM) {
      const b = this.bounds;
      const agents = sim.state.agents;
      const vis = this.painter.vis;
      const n = this.painter.visN;
      const fam = new Path2D();
      const fr = new Path2D();
      const en = new Path2D();
      let nf = 0;
      let nr = 0;
      let ne = 0;
      for (let k = 0; k < n && count < MAX_LINES; k++) {
        const a = agents[vis[k]];
        const mid = a.parents ? a.parents[0] : -1;
        if (mid >= 0) {
          const m = sim.getAgent(mid);
          if (m && m.x >= b.x0 && m.x <= b.x1 && m.y >= b.y0 && m.y <= b.y1) {
            fam.moveTo(a.x, a.y);
            fam.lineTo(m.x, m.y);
            nf++;
            count++;
          }
        }
        const rels = a.relationships;
        if (!rels) continue;
        for (let i = 0; i < rels.length; i++) {
          const r = rels[i];
          const aff = r.affinity;
          const enemy = aff <= ENEMY;
          if (!enemy && !(r.kin === 0 && aff >= FRIEND)) continue;
          const o = sim.getAgent(r.id);
          if (!o || o.x < b.x0 || o.x > b.x1 || o.y < b.y0 || o.y > b.y1) continue;
          // a pair both sides list is drawn once, from the lower id
          if (a.id > o.id && strongTie(o, a.id)) continue;
          if (enemy) {
            en.moveTo(a.x, a.y);
            en.lineTo(o.x, o.y);
            ne++;
          } else {
            fr.moveTo(a.x, a.y);
            fr.lineTo(o.x, o.y);
            nr++;
          }
          count++;
        }
      }
      const dim = sel ? 0.45 : 1;
      if (nf) {
        ctx.globalAlpha = 0.8 * dim;
        ctx.strokeStyle = TIE.family;
        ctx.lineWidth = 1.3 * px;
        ctx.stroke(fam);
      }
      if (nr) {
        ctx.globalAlpha = 0.8 * dim;
        ctx.strokeStyle = TIE.friend;
        ctx.lineWidth = 1 * px;
        ctx.stroke(fr);
      }
      if (ne) {
        ctx.globalAlpha = 0.9 * dim;
        ctx.strokeStyle = TIE.enemy;
        ctx.lineWidth = 1.3 * px;
        ctx.lineCap = 'butt';
        this.dash[0] = 4 * px;
        this.dash[1] = 3 * px;
        ctx.setLineDash(this.dash);
        ctx.stroke(en);
        ctx.setLineDash(this.noDash);
        ctx.lineCap = 'round';
      }
      ctx.globalAlpha = 1;
    }
    if (sel && view.showRelations !== false) count += this.drawSelectedTies(ctx, sim, sel, z);
    return count;
  }

  /** The selected agent's family, friends and enemies: wide lines, flat lower alpha toward agents off screen. */
  private drawSelectedTies(ctx: CanvasRenderingContext2D, sim: Simulation, a: Agent, z: number): number {
    const ta = this.tieAgents;
    const tk = this.tieKinds;
    const seen = this.tieSeen;
    seen.clear();
    seen.add(a.id);
    const add = (id: number, kind: TieKind) => {
      if (id < 0 || seen.has(id)) return;
      const o = sim.getAgent(id);
      if (!o) return;
      seen.add(id);
      ta.push(o);
      tk.push(kind);
    };
    // personal grudges first (an enemy sibling is shown as an enemy), then family, then friends
    const rels = a.relationships ?? [];
    for (const r of rels) if (r.affinity <= ENEMY) add(r.id, ENEMIES);
    if (a.parents) {
      add(a.parents[0], FAMILY);
      add(a.parents[1], FAMILY);
    }
    if (a.children) for (const c of a.children) add(c, FAMILY);
    for (const r of rels) if (r.kin > 0) add(r.id, FAMILY);
    for (const r of rels) if (r.kin === 0 && r.affinity >= FRIEND) add(r.id, FRIENDS);
    if (!ta.length) return 0;
    const px = 1 / z;
    const vr = this.viewRect;
    for (let pass = 0; pass < 2; pass++) {
      // pass 0: ties to agents off screen (flat, lower alpha); pass 1: ties on screen
      for (let kind = 0; kind < 3; kind++) {
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < ta.length; i++) {
          if (tk[i] !== kind) continue;
          const o = ta[i];
          const on = o.x >= vr.x0 && o.x <= vr.x1 && o.y >= vr.y0 && o.y <= vr.y1;
          if ((pass === 1) !== on) continue;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(o.x, o.y);
          any = true;
        }
        if (!any) continue;
        ctx.globalAlpha = pass === 0 ? 0.5 : 1;
        ctx.strokeStyle = TIE_COLOR[kind];
        ctx.lineWidth = (kind === FRIENDS ? 1.6 : 2) * px;
        if (kind === ENEMIES) {
          ctx.lineCap = 'butt';
          this.dash[0] = 5 * px;
          this.dash[1] = 3.5 * px;
          ctx.setLineDash(this.dash);
        }
        ctx.stroke();
        if (kind === ENEMIES) {
          ctx.setLineDash(this.noDash);
          ctx.lineCap = 'round';
        }
      }
    }
    ctx.globalAlpha = 1;
    return ta.length;
  }

  /** Rings around the selected agent's partners that are on screen (world space, over the bodies). */
  private drawPartnerRings(ctx: CanvasRenderingContext2D, z: number): void {
    const px = 1 / z;
    const ta = this.tieAgents;
    const tk = this.tieKinds;
    const vr = this.viewRect;
    ctx.setLineDash(this.noDash);
    for (let kind = 0; kind < 3; kind++) {
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < ta.length; i++) {
        if (tk[i] !== kind) continue;
        const o = ta[i];
        if (o.x < vr.x0 || o.x > vr.x1 || o.y < vr.y0 || o.y > vr.y1) continue;
        const r = Math.max(agentRadius(o), 1.6 * px) * 1.1 + 3 * px;
        ctx.moveTo(o.x + r, o.y);
        ctx.arc(o.x, o.y, r, 0, TAU);
        any = true;
      }
      if (!any) continue;
      ctx.strokeStyle = PAL.ink;
      ctx.lineWidth = 3.2 * px;
      ctx.stroke();
      ctx.strokeStyle = TIE_COLOR[kind];
      ctx.lineWidth = 1.6 * px;
      ctx.stroke();
    }
  }

  /** Small dots at the screen edge where a tie of the selected agent leaves the view (screen space). */
  private drawTieMarkers(ctx: CanvasRenderingContext2D, a: Agent, vw: number, vh: number): void {
    const ax = this.toSX(a.x);
    const ay = this.toSY(a.y);
    const m = 8;
    if (ax < m || ay < m || ax > vw - m || ay > vh - m) return;
    const ta = this.tieAgents;
    const tk = this.tieKinds;
    for (let i = 0; i < ta.length; i++) {
      const o = ta[i];
      const ox = this.toSX(o.x);
      const oy = this.toSY(o.y);
      if (ox >= 0 && oy >= 0 && ox <= vw && oy <= vh) continue;
      // clip the segment a→o to the inset viewport
      const dx = ox - ax;
      const dy = oy - ay;
      let t = 1;
      if (dx > 0) t = Math.min(t, (vw - m - ax) / dx);
      else if (dx < 0) t = Math.min(t, (m - ax) / dx);
      if (dy > 0) t = Math.min(t, (vh - m - ay) / dy);
      else if (dy < 0) t = Math.min(t, (m - ay) / dy);
      const ex = ax + dx * t;
      const ey = ay + dy * t;
      ctx.beginPath();
      ctx.arc(ex, ey, 3.5, 0, TAU);
      ctx.fillStyle = TIE_COLOR[tk[i]];
      ctx.fill();
      ctx.strokeStyle = PAL.ink;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  /** Legend for the line styles, above the minimap, while connection lines are on the map (screen space). */
  private drawConnectionsLegend(ctx: CanvasRenderingContext2D, show: boolean, ins: { top: number; right: number; bottom: number; left: number }, vh: number): void {
    const r = this.connectionsLegendRect;
    r.visible = false;
    if (!show) return;
    const pad = 8;
    const row = 17;
    const w = 112;
    const h = pad * 2 + 14 + row * 3;
    const mm = this.minimap.rect;
    const bottom = mm.visible ? mm.y - 4 - 8 : vh - ins.bottom - 14;
    const x = ins.left + 14 - (mm.visible ? 4 : 0);
    const y = bottom - h;
    if (y < ins.top + 8) return;
    flatPanel(ctx, x, y, w, h);
    ctx.font = `600 11px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = PAL.text;
    ctx.fillText('Connections', x + pad, y + pad + 6);
    const labels = ['Family', 'Friends', 'Enemies'];
    ctx.font = `400 11px ${FONT}`;
    for (let i = 0; i < 3; i++) {
      const yy = y + pad + 14 + row * i + row / 2 + 1;
      ctx.beginPath();
      ctx.moveTo(x + pad, yy);
      ctx.lineTo(x + pad + 22, yy);
      ctx.strokeStyle = TIE_COLOR[i];
      ctx.lineWidth = i === FRIENDS ? 1.2 : 1.8;
      if (i === ENEMIES) {
        ctx.lineCap = 'butt';
        this.dash[0] = 4;
        this.dash[1] = 3;
        ctx.setLineDash(this.dash);
      } else ctx.lineCap = 'round';
      ctx.stroke();
      ctx.setLineDash(this.noDash);
      ctx.fillStyle = PAL.muted;
      ctx.fillText(labels[i], x + pad + 30, yy);
    }
    ctx.textBaseline = 'alphabetic';
    r.x = x;
    r.y = y;
    r.w = w;
    r.h = h;
    r.visible = true;
  }

  // ------------------------------------------------------------ selection

  private updateTrail(sel: Agent | undefined): void {
    if (!sel) {
      this.trailId = -1;
      this.trailLen = 0;
      return;
    }
    const tr = this.trail;
    if (sel.id !== this.trailId) {
      this.trailId = sel.id;
      this.trailLen = 0;
      this.trailHead = 0;
    }
    if (this.trailLen > 0) {
      const li = ((this.trailHead - 1 + TRAIL_N) % TRAIL_N) * 2;
      const dx = sel.x - tr[li];
      const dy = sel.y - tr[li + 1];
      const d2 = dx * dx + dy * dy;
      if (d2 > 80 * 80) this.trailLen = 0; // teleported
      else if (d2 < 1.5 * 1.5) return;
    }
    tr[this.trailHead * 2] = sel.x;
    tr[this.trailHead * 2 + 1] = sel.y;
    this.trailHead = (this.trailHead + 1) % TRAIL_N;
    if (this.trailLen < TRAIL_N) this.trailLen++;
  }

  /** Vision radius, trail and planned route of the selected agent (world space, under the agents). */
  private drawSelectionWorld(ctx: CanvasRenderingContext2D, a: Agent, view: ViewOptions, z: number): void {
    const px = 1 / z;
    if (view.showVision && a.traits && a.traits.perception > 0) {
      const R = a.traits.perception;
      ctx.beginPath();
      ctx.arc(a.x, a.y, R, 0, TAU);
      ctx.globalAlpha = 0.05;
      ctx.fillStyle = PAL.text;
      ctx.fill();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = PAL.text;
      ctx.lineWidth = px;
      this.dash[0] = 5 * px;
      this.dash[1] = 4 * px;
      ctx.setLineDash(this.dash);
      ctx.stroke();
      ctx.setLineDash(this.noDash);
      ctx.globalAlpha = 1;
    }
    if (view.showTrails && this.trailLen > 1) {
      // where it has been: a light line, fainter toward the older end (flat steps)
      const tr = this.trail;
      const n = this.trailLen;
      const start = (this.trailHead - n + TRAIL_N) % TRAIL_N;
      ctx.strokeStyle = PAL.text;
      ctx.lineWidth = 1.5 * px;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const chunks = 4;
      for (let c = 0; c < chunks; c++) {
        const i0 = Math.floor((c * (n - 1)) / chunks);
        const i1 = Math.floor(((c + 1) * (n - 1)) / chunks);
        if (i1 <= i0) continue;
        ctx.globalAlpha = 0.18 + 0.14 * c;
        ctx.beginPath();
        for (let i = i0; i <= i1; i++) {
          const k = ((start + i) % TRAIL_N) * 2;
          if (i === i0) ctx.moveTo(tr[k], tr[k + 1]);
          else ctx.lineTo(tr[k], tr[k + 1]);
        }
        if (c === chunks - 1) ctx.lineTo(a.x, a.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // planned route (around a river via a ford, round a lake or wall): the remaining waypoints, then the goal
    const rt = a.route;
    // (only while the agent is actually on the move: a route left over after arriving is not shown)
    if (view.showTrails && rt && !rt.fail && rt.pts.length >= 2 && rt.i < rt.pts.length && (a.vx !== 0 || a.vy !== 0)) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      for (let k = rt.i; k + 1 < rt.pts.length; k += 2) ctx.lineTo(rt.pts[k], rt.pts[k + 1]);
      ctx.lineTo(rt.gx, rt.gy);
      ctx.strokeStyle = PAL.ink;
      ctx.lineWidth = 3.2 * px;
      ctx.globalAlpha = 0.45;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = PAL.ochre;
      ctx.lineWidth = 1.6 * px;
      this.dash[0] = 6 * px;
      this.dash[1] = 4 * px;
      ctx.setLineDash(this.dash);
      ctx.stroke();
      ctx.setLineDash(this.noDash);
      ctx.fillStyle = PAL.ochre;
      ctx.beginPath();
      for (let k = rt.i; k + 1 < rt.pts.length - 2; k += 2) {
        ctx.moveTo(rt.pts[k] + 2.4 * px, rt.pts[k + 1]);
        ctx.arc(rt.pts[k], rt.pts[k + 1], 2.4 * px, 0, TAU);
      }
      ctx.fill();
      ctx.beginPath(); // goal marker
      ctx.arc(rt.gx, rt.gy, 4.5 * px, 0, TAU);
      ctx.strokeStyle = PAL.ochre;
      ctx.lineWidth = 1.6 * px;
      ctx.stroke();
    }
  }

  /** Ring around the hovered (light) or selected (ochre) agent (screen space). */
  private drawRing(ctx: CanvasRenderingContext2D, a: Agent, selected: boolean): void {
    const sx = this.toSX(a.x);
    const sy = this.toSY(a.y);
    const vw = this.camera.viewW;
    const vh = this.camera.viewH;
    if (sx < -40 || sy < -40 || sx > vw + 40 || sy > vh + 40) return;
    const rs = Math.max(1.6, agentRadius(a) * this.camZ) * 1.1;
    ctx.setLineDash(this.noDash);
    ctx.beginPath();
    ctx.arc(sx, sy, rs + (selected ? 4.5 : 3.5), 0, TAU);
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = selected ? 4.4 : 3.4;
    ctx.stroke();
    ctx.strokeStyle = selected ? PAL.ochre : PAL.text;
    ctx.lineWidth = selected ? 2.2 : 1.4;
    ctx.stroke();
  }

  private drawBrush(ctx: CanvasRenderingContext2D, br: NonNullable<ViewOptions['brush']>, z: number): void {
    if (!Number.isFinite(br.x) || !Number.isFinite(br.y)) return;
    const px = 1 / z;
    const R = Math.max(0.5, br.radius || 0);
    ctx.setLineDash(this.noDash);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(br.x, br.y, R, 0, TAU);
    const c = 4 * px;
    ctx.moveTo(br.x - c, br.y);
    ctx.lineTo(br.x + c, br.y);
    ctx.moveTo(br.x, br.y - c);
    ctx.lineTo(br.x, br.y + c);
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 3 * px;
    ctx.stroke();
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = PAL.text;
    ctx.lineWidth = px;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

/** True when `o` counts `id` as a friend (not kin) or an enemy. */
function strongTie(o: Agent, id: number): boolean {
  const rels = o.relationships;
  if (!rels) return false;
  for (let i = 0; i < rels.length; i++) {
    const r = rels[i];
    if (r.id !== id) continue;
    return r.affinity <= ENEMY || (r.kin === 0 && r.affinity >= FRIEND);
  }
  return false;
}
