// OWNER: Rendering agent. STUB — replace with the real renderer (keep the public API).
import type { Simulation } from '../sim/simulation';
import type { Agent } from '../sim/types';
import { Camera } from './camera';

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
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly camera = new Camera();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not supported');
    this.ctx = ctx;
  }

  /** Match the backing store to the element size × devicePixelRatio. */
  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(r.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(r.height * dpr));
    this.camera.viewW = r.width;
    this.camera.viewH = r.height;
  }

  /** Draw one frame. `time` is a monotonically increasing ms clock for animation only. */
  render(sim: Simulation, view: ViewOptions, time: number): void {
    void time; void view;
    const { ctx } = this;
    const dpr = this.canvas.width / Math.max(1, this.camera.viewW);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b1020';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * this.camera.zoom, 0, 0, dpr * this.camera.zoom, dpr * (this.camera.viewW / 2 - this.camera.x * this.camera.zoom), dpr * (this.camera.viewH / 2 - this.camera.y * this.camera.zoom));
    ctx.fillStyle = '#244';
    ctx.fillRect(0, 0, sim.worldW, sim.worldH);
    for (const a of sim.state.agents) {
      ctx.fillStyle = `hsl(${a.traits.hue},70%,60%)`;
      ctx.beginPath();
      ctx.arc(a.x, a.y, 3 * a.traits.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Agent under a screen point (CSS px), or null. */
  pickAgent(sim: Simulation, sx: number, sy: number): Agent | null {
    const w = this.camera.screenToWorld(sx, sy);
    const r = Math.max(6, 10 / this.camera.zoom);
    return sim.spatial.nearest(w.x, w.y, r, () => true);
  }
}
