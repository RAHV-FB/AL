// OWNER: Agent Intelligence agent.
/**
 * Low-level locomotion for agents: terrain-aware stepping with obstacle
 * avoidance, arrival, and recovery when terrain is painted underneath an agent.
 * Allocation-free; called every tick from brain.act().
 */
import type { Simulation } from './simulation';
import type { Agent, TerrainType } from './types';
import { TERRAIN_INFO } from './constants';
import { growthFactor } from './lifecycle';

/** Deflection angles tried around obstacles: 0, ±30°, ±60°, ±90°, ±120°, ±150°, 180°. */
const N_DEFLECT = 7;
const DCOS = new Float64Array(N_DEFLECT);
const DSIN = new Float64Array(N_DEFLECT);
for (let k = 0; k < N_DEFLECT; k++) {
  DCOS[k] = Math.cos((k * Math.PI) / 6);
  DSIN[k] = Math.sin((k * Math.PI) / 6);
}

export function halt(a: Agent): void {
  a.vx = 0;
  a.vy = 0;
}

/** Full stride (world units/tick) right now: speed × terrain × stamina × growth. */
export function stride(sim: Simulation, a: Agent): number {
  const cost = sim.moveCostAt(a.x, a.y);
  const e = a.energy > 1 ? 1 : a.energy > 0 ? a.energy : 0;
  const s = a.traits.speed * cost * (0.35 + 0.65 * e) * growthFactor(a);
  return s > 0 && Number.isFinite(s) ? s : 0;
}

function commit(sim: Simulation, a: Agent, nx: number, ny: number, cx: number, cy: number): number {
  const ox = a.x;
  const oy = a.y;
  a.x = sim.clampX(nx);
  a.y = sim.clampY(ny);
  a.vx = a.x - ox;
  a.vy = a.y - oy;
  a.heading = Math.atan2(cy, cx);
  const m = Math.sqrt(a.vx * a.vx + a.vy * a.vy);
  if (Number.isFinite(m)) a.stats.distance += m;
  return m;
}

/**
 * Take one step along (dx,dy) at `factor` × stride, never further than `maxDist`.
 * Probes ahead and, when blocked by impassable terrain or the map edge, tries
 * deflections of ±30/60/90/120/150/180°, preferring the side nearest the current
 * heading (gives smooth wall-following). Returns the distance moved.
 */
export function stepDir(sim: Simulation, a: Agent, dx: number, dy: number, factor: number, maxDist = Infinity): number {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (!(len > 1e-9) || !(factor > 0)) {
    halt(a);
    return 0;
  }
  let step = stride(sim, a) * factor;
  if (step > maxDist) step = maxDist;
  if (!(step > 1e-4)) {
    halt(a);
    return 0;
  }
  const ux = dx / len;
  const uy = dy / len;
  let probe = step * 2.5;
  const minProbe = sim.state.world.tileSize * 0.8;
  if (probe < minProbe) probe = minProbe;
  if (probe > maxDist) probe = maxDist > step ? maxDist : step;
  let h = a.heading;
  if (!Number.isFinite(h)) h = 0;
  const side = ux * Math.sin(h) - uy * Math.cos(h) >= 0 ? 1 : -1;
  // pass 0: step and look-ahead probe must be clear; pass 1: only the step itself
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < N_DEFLECT; k++) {
      const tries = k === 0 || k === N_DEFLECT - 1 ? 1 : 2;
      for (let t = 0; t < tries; t++) {
        const sn = (t === 0 ? side : -side) * DSIN[k];
        const c = DCOS[k];
        const cx = ux * c - uy * sn;
        const cy = ux * sn + uy * c;
        const nx = a.x + cx * step;
        const ny = a.y + cy * step;
        if (!sim.passableAt(nx, ny)) continue;
        if (pass === 0 && !sim.passableAt(a.x + cx * probe, a.y + cy * probe)) continue;
        return commit(sim, a, nx, ny, cx, cy);
      }
    }
  }
  halt(a);
  a.heading = h + Math.PI * 0.5;
  return 0;
}

/**
 * Steer toward (tx,ty). Returns true (and stops) when within `arriveDist`.
 * Callers must pass finite coordinates.
 */
export function moveToward(sim: Simulation, a: Agent, tx: number, ty: number, factor: number, arriveDist: number): boolean {
  const dx = tx - a.x;
  const dy = ty - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (!(d > arriveDist)) {
    halt(a);
    return true;
  }
  const lim = d - arriveDist * 0.5;
  stepDir(sim, a, dx, dy, factor, lim > 0.05 ? lim : 0.05);
  return false;
}

/**
 * If the agent stands on an impassable tile (terrain painted under it, or out of
 * bounds), relocate it to the centre of the nearest passable tile. Returns true
 * if it had to be moved.
 */
export function escapeImpassable(sim: Simulation, a: Agent): boolean {
  if (sim.passableAt(a.x, a.y)) return false;
  const w = sim.state.world;
  const ts = w.tileSize;
  let tx0 = Math.floor(a.x / ts);
  let ty0 = Math.floor(a.y / ts);
  if (!Number.isFinite(tx0)) tx0 = 0;
  if (!Number.isFinite(ty0)) ty0 = 0;
  if (tx0 < 0) tx0 = 0; else if (tx0 >= w.width) tx0 = w.width - 1;
  if (ty0 < 0) ty0 = 0; else if (ty0 >= w.height) ty0 = w.height - 1;
  const maxR = Math.max(w.width, w.height);
  for (let r = 0; r <= maxR; r++) {
    let best = -1;
    let bestD = Infinity;
    for (let oy = -r; oy <= r; oy++) {
      const ty = ty0 + oy;
      if (ty < 0 || ty >= w.height) continue;
      const edgeRow = oy === -r || oy === r;
      for (let ox = -r; ox <= r; ox += edgeRow ? 1 : 2 * r || 1) {
        const tx = tx0 + ox;
        if (tx < 0 || tx >= w.width) continue;
        const idx = ty * w.width + tx;
        if (!TERRAIN_INFO[w.terrain[idx] as TerrainType].passable) continue;
        const cx = (tx + 0.5) * ts - a.x;
        const cy = (ty + 0.5) * ts - a.y;
        const d = cx * cx + cy * cy;
        if (d < bestD) {
          bestD = d;
          best = idx;
        }
      }
    }
    if (best >= 0) {
      const bx = best % w.width;
      const by = (best - bx) / w.width;
      a.x = sim.clampX((bx + 0.5) * ts);
      a.y = sim.clampY((by + 0.5) * ts);
      halt(a);
      return true;
    }
    if (r > 24) break; // no passable land nearby: give up (stay put)
  }
  a.x = sim.clampX(Number.isFinite(a.x) ? a.x : 0);
  a.y = sim.clampY(Number.isFinite(a.y) ? a.y : 0);
  halt(a);
  return false;
}
