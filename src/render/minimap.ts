// OWNER: map ground engineer (terrainLayer.ts, camera.ts, minimap.ts, overlays.ts).
/** Minimap: cached thumbnail (ground, agents by tribe colour, camps, disasters) refreshed every few frames. */
import type { Simulation } from '../sim/simulation';
import type { Camera } from './camera';
import type { TerrainLayer } from './terrainLayer';
import type { DisasterFx } from './effects';
import { hueColor } from './colors';

const C_PANEL = '#1c1b18';
const C_BORDER = '#3e3b34';
const C_VIEW = '#d6a648';
const C_LONER = 'rgba(232,227,216,0.9)';
const C_INFECTED = '#c2c46e';
const C_CAMP_EDGE = '#131210';

/** Disaster ring colours (muted palette: water, sage, ochre, rust). */
function disasterColor(kind: string): string {
  switch (kind) {
    case 'coldsnap':
      return '#6f9fc2';
    case 'bloom':
      return '#8fb573';
    case 'plague':
      return C_INFECTED;
    case 'blight':
      return '#cf5b45';
    default:
      return C_VIEW;
  }
}

export class Minimap {
  private c = document.createElement('canvas');
  private ctx = this.c.getContext('2d')!;
  private lastFrame = -1e9;
  private lastTick = -1;
  private lastRev = -1;
  private pw = 0;
  private ph = 0;
  private byTribe = new Map<number, number[]>();
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
    ctx.globalAlpha = 1;
    ctx.fillStyle = C_PANEL;
    ctx.fillRect(0, 0, pw, ph);
    terrain.drawThumb(ctx, 0, 0, pw, ph);
    const sx = pw / sim.worldW;
    const sy = ph / sim.worldH;
    // disasters: thin rings in muted colours
    fx.forEach((d, a) => {
      if (!(d.radius > 0) || a < 0.05) return;
      ctx.globalAlpha = Math.min(1, a);
      ctx.strokeStyle = disasterColor(d.kind);
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      ctx.arc(d.x * sx, d.y * sy, Math.max(2, d.radius * sx), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }, time);
    // agents as small squares in their tribe's colour (loners light, infected yellow-green)
    const s = Math.max(1, Math.round(1.2 * dpr));
    const agents = sim.state.agents;
    const groups = this.byTribe;
    for (const g of groups.values()) g.length = 0;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.alive) continue;
      const key = a.infection > 0 ? -2 : a.tribeId >= 0 ? a.tribeId : -1;
      let g = groups.get(key);
      if (!g) {
        g = [];
        groups.set(key, g);
      }
      g.push(i);
    }
    for (const [key, g] of groups) {
      if (!g.length) continue;
      if (key === -2) ctx.fillStyle = C_INFECTED;
      else if (key === -1) ctx.fillStyle = C_LONER;
      else {
        const tr = sim.getTribe(key);
        ctx.fillStyle = tr ? hueColor(tr.hue, 0.45, 0.58) : C_LONER;
      }
      ctx.beginPath();
      for (let k = 0; k < g.length; k++) {
        const a = agents[g[k]];
        ctx.rect(Math.round(a.x * sx - s / 2), Math.round(a.y * sy - s / 2), s, s);
      }
      ctx.fill();
    }
    // camps
    const cs = Math.max(3, Math.round(3.5 * dpr));
    ctx.lineWidth = 1;
    for (const t of sim.state.tribes) {
      if (t.extinctTick !== -1) continue;
      const x = Math.round(t.homeX * sx - cs / 2);
      const y = Math.round(t.homeY * sy - cs / 2);
      ctx.fillStyle = hueColor(t.hue, 0.45, 0.58);
      ctx.fillRect(x, y, cs, cs);
      ctx.strokeStyle = C_CAMP_EDGE;
      ctx.strokeRect(x + 0.5, y + 0.5, cs - 1, cs - 1);
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
    // plain frame: flat panel colour, 1 px border
    ctx.fillStyle = C_PANEL;
    ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.c, x, y, w, h);
    ctx.strokeStyle = C_BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x - 4) + 0.5, Math.round(y - 4) + 0.5, Math.round(w + 8) - 1, Math.round(h + 8) - 1);
    // camera viewport: 1 px ochre rectangle
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
      const vx = Math.round(x + rx0) + 0.5;
      const vy = Math.round(y + ry0) + 0.5;
      ctx.strokeStyle = C_VIEW;
      ctx.lineWidth = 1;
      ctx.strokeRect(vx, vy, Math.max(2, Math.round(rx1 - rx0) - 1), Math.max(2, Math.round(ry1 - ry0) - 1));
    }
  }

  /** World point under a CSS-px screen point if it is inside the minimap, else null. */
  hit(sx: number, sy: number, worldW: number, worldH: number): { x: number; y: number } | null {
    const r = this.rect;
    if (!r.visible || sx < r.x || sy < r.y || sx > r.x + r.w || sy > r.y + r.h) return null;
    return { x: ((sx - r.x) / r.w) * worldW, y: ((sy - r.y) / r.h) * worldH };
  }
}
