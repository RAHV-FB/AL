// OWNER: Rendering agent.
/**
 * World renderer (Canvas 2D). Frame order:
 *   ground (terrain · vegetation · hillshade) → season tint → night tint (multiply)
 *   → data overlay → disasters → camps → selection extras (vision, trail, relations)
 *   → agents (batched, LOD) → brush → screen pass (labels, glyphs, rings, vignettes,
 *   legend, minimap).
 * The simulation is read-only here; every cache is renderer-side and rebuilt lazily.
 */
import type { Simulation } from '../sim/simulation';
import type { Agent, EnvState } from '../sim/types';
import { Camera } from './camera';
import { TerrainLayer } from './terrainLayer';
import { OverlayLayer } from './overlays';
import { DisasterFx } from './effects';
import { AgentPainter, agentRadius, miniBars } from './agents';
import { Minimap } from './minimap';
import { hueColor } from './colors';

export type OverlayKind = 'none' | 'food' | 'fertility' | 'density' | 'territory' | 'disease' | 'climate';

export interface ViewOptions {
  overlay: OverlayKind;
  selectedId: number; // -1 none
  hoverId: number; // -1 none
  showVision: boolean; // draw selected agent's perception radius
  showTrails: boolean; // motion trails for selected/followed agent
  showRelations: boolean; // lines from selected agent to friends/enemies/kin
  showCamps: boolean; // tribe camp markers
  showLabels: boolean; // names at high zoom
  /** Brush preview circle (world coords & radius) for the active tool, or null. */
  brush: { x: number; y: number; radius: number; color: string } | null;
  /** Minimap in the bottom-left corner (default true). */
  showMinimap?: boolean;
  /** Overlay legend in the bottom-right corner (default true). */
  showLegend?: boolean;
  /** Screen areas (CSS px) covered by UI panels; minimap & legend stay clear of them. */
  insets?: { top: number; right: number; bottom: number; left: number };
}

export interface RenderStats {
  /** Smoothed frames per second (from the `time` passed to render). */
  fps: number;
  /** Smoothed CPU time spent inside render() in ms. */
  drawMs: number;
  /** Agents drawn last frame (after culling). */
  agentsDrawn: number;
}

const TAU = Math.PI * 2;
const TRAIL_N = 240;
const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly camera = new Camera();
  readonly stats: RenderStats = { fps: 0, drawMs: 0, agentsDrawn: 0 };
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
  private tmp = { x: 0, y: 0 };
  private dash = [0, 0];
  private noDash: number[] = [];
  private bgPattern: CanvasPattern | null = null;
  private ro: ResizeObserver | null = null;
  // selected-agent trail ring buffer
  private trail = new Float32Array(TRAIL_N * 2);
  private trailHead = 0;
  private trailLen = 0;
  private trailId = -1;
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
    const pc = document.createElement('canvas');
    pc.width = 28;
    pc.height = 28;
    const p = pc.getContext('2d');
    if (p) {
      p.fillStyle = 'rgba(120,150,220,0.13)';
      p.fillRect(0, 0, 1.5, 1.5);
      this.bgPattern = ctx.createPattern(pc, 'repeat');
    }
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

    // ---- background
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.bgPattern) {
      ctx.fillStyle = this.bgPattern;
      ctx.fillRect(0, 0, vw, vh);
    }

    // ---- world space
    const ox = vw / 2 - cam.x * z;
    const oy = vh / 2 - cam.y * z;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * ox, dpr * oy);
    const b = cam.visibleBounds(10, this.bounds);
    const px = 1 / z;

    // soft halo around the world edge (cheap stacked strokes, no shadowBlur)
    ctx.strokeStyle = 'rgba(70,110,200,0.07)';
    for (let k = 1; k <= 3; k++) {
      ctx.lineWidth = k * 7 * px;
      ctx.strokeRect(0, 0, WW, WH);
    }

    this.terrain.draw(ctx, WW, WH);
    this.drawSeason(ctx, env, WW, WH);
    const night = this.drawNight(ctx, env, sim, WW, WH);

    ctx.strokeStyle = 'rgba(130,165,255,0.35)';
    ctx.lineWidth = px;
    ctx.strokeRect(0, 0, WW, WH);

    this.overlays.draw(ctx, sim, view.overlay, z);
    this.fx.drawWorld(ctx, time, z, b.x0, b.y0, b.x1, b.y1);
    if (view.showCamps) this.drawCampsWorld(ctx, sim, z, time, false);

    const sel = view.selectedId >= 0 ? sim.getAgent(view.selectedId) : undefined;
    this.updateTrail(sel);
    if (sel) this.drawSelectionWorld(ctx, sim, sel, view, z, time);

    this.painter.collect(sim, z, b.x0, b.y0, b.x1, b.y1);
    this.painter.draw(ctx, sim, z, night, view.overlay === 'disease', time);
    this.stats.agentsDrawn = this.painter.visN;
    if (view.showCamps) this.drawCampsWorld(ctx, sim, z, time, true);

    if (view.brush) this.drawBrush(ctx, view.brush, z, time);

    // ---- screen space (CSS px)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    if (view.showCamps) this.drawCampLabels(ctx, sim, z, vw, vh);
    this.painter.drawScreen(ctx, sim, z, cam.x, cam.y, vw, vh, time, view.showLabels, sel ? sel.id : -1);
    this.fx.drawLabels(ctx, time, this.toSX, this.toSY, z, vw, vh);
    const hov = view.hoverId >= 0 && view.hoverId !== view.selectedId ? sim.getAgent(view.hoverId) : undefined;
    if (hov) this.drawAgentFocus(ctx, sim, hov, false, time);
    if (sel) this.drawAgentFocus(ctx, sim, sel, true, time);
    this.fx.drawScreen(ctx, time, vw, vh, this.toSX, this.toSY);

    const ins = view.insets ?? NO_INSETS;
    if (view.showLegend !== false && view.overlay !== 'none') {
      this.overlays.drawLegend(ctx, sim, view.overlay, vw - ins.right - 12, vh - ins.bottom - 12);
    }
    if (view.showMinimap !== false && vw > 480 && vh > 320) {
      const mw = Math.round(Math.max(130, Math.min(220, vw * 0.15)));
      const mh = Math.round((mw * WH) / WW);
      this.minimap.update(sim, this.terrain, this.fx, this.frame, time, mw, mh, dpr);
      this.minimap.draw(ctx, cam, sim, ins.left + 14, vh - ins.bottom - 14 - mh, mw, mh);
    } else this.minimap.rect.visible = false;

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

  private seasonWeights(env: EnvState | undefined): [number, number, number, number] {
    const w: [number, number, number, number] = [0, 0, 0, 0];
    const s = env ? env.season & 3 : 0;
    const p = env ? Math.max(0, Math.min(1, env.seasonProgress || 0)) : 0;
    let blend = (p - 0.7) / 0.3;
    blend = blend < 0 ? 0 : blend > 1 ? 1 : blend * blend * (3 - 2 * blend);
    w[s] = 1 - blend;
    w[(s + 1) & 3] += blend;
    return w;
  }

  private drawSeason(ctx: CanvasRenderingContext2D, env: EnvState | undefined, WW: number, WH: number): void {
    if (!env) return;
    const w = this.seasonWeights(env);
    const frost = w[3] * 0.14 + (env.tempOffset < -2 ? Math.min(0.14, -env.tempOffset * 0.012) : 0);
    if (frost > 0.005) {
      ctx.globalAlpha = frost;
      ctx.fillStyle = '#d4e6ff';
      ctx.fillRect(0, 0, WW, WH);
    }
    if (w[2] > 0.01) {
      ctx.globalAlpha = w[2] * 0.08;
      ctx.fillStyle = '#ff9a3c';
      ctx.fillRect(0, 0, WW, WH);
    }
    if (w[1] > 0.01) {
      ctx.globalAlpha = w[1] * 0.035;
      ctx.fillStyle = '#ffe6a0';
      ctx.fillRect(0, 0, WW, WH);
    }
    ctx.globalAlpha = 1;
  }

  /** Multiply night/twilight tint over the world. Returns night amount 0..1. */
  private drawNight(ctx: CanvasRenderingContext2D, env: EnvState | undefined, sim: Simulation, WW: number, WH: number): number {
    if (!env || sim.state.config?.dayNight === false) return 0;
    const day = Number.isFinite(env.daylight) ? Math.max(0, Math.min(1, env.daylight)) : 1;
    let n = 1 - day;
    n = n * n * (3 - 2 * n);
    const tw = Math.max(0, 1 - Math.abs(day - 0.5) / 0.32);
    if (n < 0.01 && tw < 0.01) return 0;
    const r = Math.round(255 - n * 178);
    const g = Math.round(255 - n * 152 - tw * 26);
    const bl = Math.round(255 - n * 84 - tw * 72);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgb(${r},${g},${bl})`;
    ctx.fillRect(0, 0, WW, WH);
    ctx.globalCompositeOperation = 'source-over';
    return n;
  }

  // ------------------------------------------------------------ camps

  /** Camp ground ring (`marker` false, drawn under agents) or hexagon marker + stockpile gauge (`marker` true, over agents). */
  private drawCampsWorld(ctx: CanvasRenderingContext2D, sim: Simulation, z: number, time: number, marker: boolean): void {
    const b = this.bounds;
    const px = 1 / z;
    for (const t of sim.state.tribes) {
      if (t.extinctTick !== -1) continue;
      const x = t.homeX;
      const y = t.homeY;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < b.x0 - 40 || x > b.x1 + 40 || y < b.y0 - 40 || y > b.y1 + 40) continue;
      const hue = t.hue;
      if (!marker) {
        const R = 16;
        ctx.fillStyle = hueColor(hue, 0.7, 0.5, 0.13);
        ctx.beginPath();
        ctx.arc(x, y, R, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = hueColor(hue, 0.85, 0.66, 0.7);
        ctx.lineWidth = 1.2 * px;
        this.dash[0] = 4 * px;
        this.dash[1] = 3 * px;
        ctx.setLineDash(this.dash);
        ctx.lineDashOffset = -time * 0.004 * px;
        ctx.stroke();
        ctx.setLineDash(this.noDash);
        ctx.lineDashOffset = 0;
        continue;
      }
      // hexagon marker (min ~9px on screen)
      const s = Math.max(4.5, 9 * px);
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU - Math.PI / 2;
        const hx = x + Math.cos(a) * s;
        const hy = y + Math.sin(a) * s;
        if (i === 0) ctx.moveTo(hx, hy);
        else ctx.lineTo(hx, hy);
      }
      ctx.closePath();
      ctx.fillStyle = hueColor(hue, 0.75, 0.42, 0.95);
      ctx.fill();
      ctx.strokeStyle = 'rgba(5,8,16,0.9)';
      ctx.lineWidth = 1.6 * px;
      ctx.stroke();
      ctx.strokeStyle = hueColor(hue, 0.9, 0.72, 1);
      ctx.lineWidth = 0.9 * px;
      ctx.stroke();
      // campfire
      const fl = 0.85 + 0.15 * Math.sin(time * 0.012 + t.id * 1.7);
      ctx.fillStyle = 'rgba(255,214,120,0.95)';
      ctx.beginPath();
      ctx.arc(x, y, s * 0.32 * fl, 0, TAU);
      ctx.fill();
      // stockpile gauge (log scale, full at ~1000)
      const stock = Math.max(0, t.stockpile || 0);
      const frac = Math.min(1, Math.log10(1 + stock) / 3);
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(5,8,16,0.6)';
      ctx.lineWidth = 2.6 * px;
      ctx.beginPath();
      ctx.arc(x, y, s * 1.5, 0, TAU);
      ctx.stroke();
      if (frac > 0.005) {
        ctx.strokeStyle = '#f2c94c';
        ctx.lineWidth = 1.8 * px;
        ctx.beginPath();
        ctx.arc(x, y, s * 1.5, -Math.PI / 2, -Math.PI / 2 + frac * TAU);
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }
  }

  private drawCampLabels(ctx: CanvasRenderingContext2D, sim: Simulation, z: number, vw: number, vh: number): void {
    if (z < 0.33) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const px = 1 / z;
    for (const t of sim.state.tribes) {
      if (t.extinctTick !== -1) continue;
      const sx = this.toSX(t.homeX);
      const s = Math.max(4.5, 9 * px) * 1.5 * z;
      const sy = this.toSY(t.homeY) + s + 4;
      if (sx < -100 || sx > vw + 100 || sy < -30 || sy > vh + 30) continue;
      ctx.font = '700 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = 'rgba(4,7,14,0.8)';
      ctx.fillText(t.name, sx + 1, sy + 1);
      ctx.fillStyle = hueColor(t.hue, 0.9, 0.74);
      ctx.fillText(t.name, sx, sy);
      if (z >= 1.1) {
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        const line = `▣ ${Math.round(t.stockpile || 0)}  ☺ ${t.members || 0}`;
        ctx.fillStyle = 'rgba(4,7,14,0.8)';
        ctx.fillText(line, sx + 1, sy + 15);
        ctx.fillStyle = 'rgba(214,224,242,0.85)';
        ctx.fillText(line, sx, sy + 14);
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
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

  private drawSelectionWorld(ctx: CanvasRenderingContext2D, sim: Simulation, a: Agent, view: ViewOptions, z: number, time: number): void {
    const px = 1 / z;
    if (view.showVision && a.traits && a.traits.perception > 0) {
      const R = a.traits.perception;
      ctx.fillStyle = 'rgba(120,180,255,0.07)';
      ctx.beginPath();
      ctx.arc(a.x, a.y, R, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(160,205,255,0.6)';
      ctx.lineWidth = 1.2 * px;
      this.dash[0] = 5 * px;
      this.dash[1] = 4 * px;
      ctx.setLineDash(this.dash);
      ctx.lineDashOffset = -time * 0.006 * px;
      ctx.stroke();
      ctx.setLineDash(this.noDash);
      ctx.lineDashOffset = 0;
    }
    if (view.showTrails && this.trailLen > 1) {
      const tr = this.trail;
      const n = this.trailLen;
      const start = (this.trailHead - n + TRAIL_N) % TRAIL_N;
      ctx.strokeStyle = hueColor(a.traits?.hue ?? 200, 0.9, 0.72);
      ctx.lineWidth = 2 * px;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const chunks = 8;
      for (let c = 0; c < chunks; c++) {
        const i0 = Math.floor((c * (n - 1)) / chunks);
        const i1 = Math.floor(((c + 1) * (n - 1)) / chunks);
        if (i1 <= i0) continue;
        ctx.globalAlpha = 0.08 + 0.8 * ((c + 1) / chunks) ** 1.5;
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
    if (view.showRelations && a.relationships && a.relationships.length) {
      ctx.lineCap = 'round';
      for (const r of a.relationships) {
        const o = sim.getAgent(r.id);
        if (!o) continue;
        const aff = Number.isFinite(r.affinity) ? r.affinity : 0;
        let col: string;
        let alpha: number;
        if (r.kin > 0) {
          col = '#f2c14e';
          alpha = 0.55 + 0.35 * Math.max(0, aff);
        } else if (aff >= 0.12) {
          col = '#5fe08f';
          alpha = 0.3 + 0.6 * aff;
        } else if (aff <= -0.12) {
          col = '#ff5a5a';
          alpha = 0.3 + 0.6 * -aff;
        } else continue;
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.strokeStyle = col;
        ctx.lineWidth = (r.kin > 0 ? 1.8 : 1.4) * px;
        if (r.kin > 0) {
          this.dash[0] = 4 * px;
          this.dash[1] = 3 * px;
          ctx.setLineDash(this.dash);
        }
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(o.x, o.y);
        ctx.stroke();
        if (r.kin > 0) ctx.setLineDash(this.noDash);
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(o.x, o.y, agentRadius(o) + 2.5 * px, 0, TAU);
        ctx.lineWidth = 1.4 * px;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  /** Highlight ring, name tag and vitals for the hovered/selected agent (screen space). */
  private drawAgentFocus(ctx: CanvasRenderingContext2D, sim: Simulation, a: Agent, selected: boolean, time: number): void {
    const sx = this.toSX(a.x);
    const sy = this.toSY(a.y);
    const vw = this.camera.viewW;
    const vh = this.camera.viewH;
    if (sx < -60 || sy < -60 || sx > vw + 60 || sy > vh + 60) return;
    const rs = Math.max(2, agentRadius(a) * this.camZ);
    if (selected) {
      const pulse = 1 + 0.12 * Math.sin(time * 0.006);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, rs + 4 * pulse, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = hueColor(a.traits?.hue ?? 200, 0.9, 0.7, 0.9);
      ctx.lineWidth = 1.5;
      this.dash[0] = 5;
      this.dash[1] = 4;
      ctx.setLineDash(this.dash);
      ctx.lineDashOffset = -time * 0.02;
      ctx.beginPath();
      ctx.arc(sx, sy, rs + 10, 0, TAU);
      ctx.stroke();
      ctx.setLineDash(this.noDash);
      ctx.lineDashOffset = 0;
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, rs + 3.5, 0, TAU);
      ctx.stroke();
    }
    // name tag
    const tribe = a.tribeId >= 0 ? sim.getTribe(a.tribeId) : undefined;
    ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const name = a.name || `#${a.id}`;
    const sub = `${tribe ? tribe.name : 'loner'} · ${a.action}`;
    const nw = ctx.measureText(name).width;
    ctx.font = '10px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const sw = ctx.measureText(sub).width;
    const w = Math.max(nw, sw, 44) + 14;
    const h = 38;
    let x = sx - w / 2;
    let y = sy - rs - (selected ? 16 : 12) - h;
    if (y < 4) y = sy + rs + 16;
    x = Math.max(4, Math.min(vw - w - 4, x));
    ctx.fillStyle = 'rgba(7,11,22,0.85)';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, h, 6) : ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.strokeStyle = tribe ? hueColor(tribe.hue, 0.8, 0.6, 0.7) : 'rgba(140,170,255,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = hueColor(a.traits?.hue ?? 200, 0.75, 0.72);
    ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(name, x + 7, y + 4);
    ctx.fillStyle = 'rgba(200,212,235,0.75)';
    ctx.font = '10px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(sub, x + 7, y + 17);
    ctx.textBaseline = 'alphabetic';
    miniBars(ctx, a, x + w / 2, y + h - 7, w - 14);
  }

  private drawBrush(ctx: CanvasRenderingContext2D, br: NonNullable<ViewOptions['brush']>, z: number, time: number): void {
    if (!Number.isFinite(br.x) || !Number.isFinite(br.y)) return;
    const px = 1 / z;
    const R = Math.max(0.5, br.radius || 0);
    ctx.fillStyle = br.color || '#ffffff';
    ctx.strokeStyle = br.color || '#ffffff';
    ctx.globalAlpha = 0.13;
    ctx.beginPath();
    ctx.arc(br.x, br.y, R, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 1.6 * px;
    this.dash[0] = 6 * px;
    this.dash[1] = 4 * px;
    ctx.setLineDash(this.dash);
    ctx.lineDashOffset = -time * 0.012 * px;
    ctx.stroke();
    ctx.setLineDash(this.noDash);
    ctx.lineDashOffset = 0;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    const c = 5 * px;
    ctx.moveTo(br.x - c, br.y);
    ctx.lineTo(br.x + c, br.y);
    ctx.moveTo(br.x, br.y - c);
    ctx.lineTo(br.x, br.y + c);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
