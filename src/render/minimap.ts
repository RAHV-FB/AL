// OWNER: Rendering agent.
/** Minimap: cached thumbnail (terrain + agents + camps + disasters) refreshed every few frames. */
import type { Simulation } from '../sim/simulation';
import type { Camera } from './camera';
import type { TerrainLayer } from './terrainLayer';
import type { DisasterFx } from './effects';
import { hueColor } from './colors';

export class Minimap {
  private c = document.createElement('canvas');
  private ctx = this.c.getContext('2d')!;
  private lastFrame = -1e9;
  private lastTick = -1;
  private lastRev = -1;
  private pw = 0;
  private ph = 0;
  /** Placement in CSS px (valid after draw). */
  readonly rect = { x: 0, y: 0, w: 0, h: 0, visible: false };

  update(sim: Simulation, terrain: TerrainLayer, fx: DisasterFx, frame: number, time: number, w: number, h: number, dpr: number): void {
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    const resized = pw !== this.pw || ph !== this.ph;
    if (!resized && frame - this.lastFrame < 10) return;
    if (!resized && sim.state.tick === this.lastTick && terrain.revision === this.lastRev && frame - this.lastFrame < 60) return;
    this.lastFrame = frame;
    this.lastTick = sim.state.tick;
    this.lastRev = terrain.revision;
    if (resized) {
      this.c.width = pw;
      this.c.height = ph;
      this.pw = pw;
      this.ph = ph;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    terrain.drawThumb(ctx, 0, 0, pw, ph);
    const sx = pw / sim.worldW;
    const sy = ph / sim.worldH;
    // disasters
    fx.forEach((d, a) => {
      if (!(d.radius > 0) || a < 0.05) return;
      ctx.globalAlpha = Math.min(1, a);
      ctx.strokeStyle = d.kind === 'coldsnap' ? '#bfe0ff' : d.kind === 'bloom' ? '#b8ff8a' : d.kind === 'plague' ? '#9be060' : d.kind === 'blight' ? '#b58af0' : '#ffb070';
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      ctx.arc(d.x * sx, d.y * sy, Math.max(2, d.radius * sx), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }, time);
    // agents
    const s = Math.max(1, Math.round(1.2 * dpr));
    const agents = sim.state.agents;
    ctx.fillStyle = 'rgba(255,246,220,0.9)';
    ctx.beginPath();
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.alive || a.infection > 0) continue;
      ctx.rect(a.x * sx - s / 2, a.y * sy - s / 2, s, s);
    }
    ctx.fill();
    ctx.fillStyle = '#9dff5c';
    ctx.beginPath();
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.alive || !(a.infection > 0)) continue;
      ctx.rect(a.x * sx - s / 2, a.y * sy - s / 2, s, s);
    }
    ctx.fill();
    // camps
    const cs = Math.max(3, Math.round(3 * dpr));
    for (const t of sim.state.tribes) {
      if (t.extinctTick !== -1) continue;
      ctx.fillStyle = hueColor(t.hue, 0.9, 0.6);
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 1;
      ctx.fillRect(t.homeX * sx - cs / 2, t.homeY * sy - cs / 2, cs, cs);
      ctx.strokeRect(t.homeX * sx - cs / 2, t.homeY * sy - cs / 2, cs, cs);
    }
  }

  /** Draw at (x,y) with size (w,h) in CSS px; ctx in CSS-px space. */
  draw(ctx: CanvasRenderingContext2D, cam: Camera, sim: Simulation, x: number, y: number, w: number, h: number): void {
    const r = this.rect;
    r.x = x;
    r.y = y;
    r.w = w;
    r.h = h;
    r.visible = true;
    ctx.fillStyle = 'rgba(7,11,22,0.82)';
    ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.c, x, y, w, h);
    ctx.strokeStyle = 'rgba(140,170,255,0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 3.5, y - 3.5, w + 7, h + 7);
    // camera viewport
    const sx = w / sim.worldW;
    const sy = h / sim.worldH;
    const hw = cam.viewW / 2 / cam.zoom;
    const hh = cam.viewH / 2 / cam.zoom;
    let rx0 = (cam.x - hw) * sx;
    let ry0 = (cam.y - hh) * sy;
    let rx1 = (cam.x + hw) * sx;
    let ry1 = (cam.y + hh) * sy;
    rx0 = Math.max(0, rx0);
    ry0 = Math.max(0, ry0);
    rx1 = Math.min(w, rx1);
    ry1 = Math.min(h, ry1);
    if (rx1 > rx0 && ry1 > ry0) {
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(x + rx0, y + ry0, rx1 - rx0, ry1 - ry0);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x + rx0 + 0.5, y + ry0 + 0.5, Math.max(1, rx1 - rx0 - 1), Math.max(1, ry1 - ry0 - 1));
    }
  }

  /** World point under a CSS-px screen point if it is inside the minimap, else null. */
  hit(sx: number, sy: number, worldW: number, worldH: number): { x: number; y: number } | null {
    const r = this.rect;
    if (!r.visible || sx < r.x || sy < r.y || sx > r.x + r.w || sy > r.y + r.h) return null;
    return { x: ((sx - r.x) / r.w) * worldW, y: ((sy - r.y) / r.h) * worldH };
  }
}
