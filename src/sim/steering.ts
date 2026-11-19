// OWNER: Agent Intelligence agent.
/**
 * Low-level locomotion for agents: terrain-aware stepping with obstacle
 * avoidance, arrival, straight-line reachability checks (clearPath), route following
 * around rivers, lakes and walls (moveToward plans with pathfinding.planRoute when the
 * straight line is blocked), and recovery when terrain is painted underneath an agent.
 * Called every tick from brain.act(); per-tick work is allocation-free except when a
 * new route is planned.
 */
import type { Simulation } from './simulation';
import type { Agent, AgentRoute, TerrainType } from './types';
import { TERRAIN_INFO } from './constants';
import { growthFactor } from './lifecycle';
import { planRoute } from './pathfinding';

/** Route following (see pathfinding.ts). Distances in tiles, times in ticks. */
export const ROUTE = {
  /** Goals closer than this are always steered to directly. */
  minDistTiles: 2.5,
  /** A goal that moved more than this (or 10% of the distance) from the planned goal triggers a re-plan. */
  goalTolTiles: 1.5,
  /** A straight line verified clear is trusted for this long before it is checked again. */
  directRecheck: 40,
  /** After "unreachable", steer directly (wall-following) and try again after this long. */
  failRetry: 90,
  /** After the tick's search budget ran out, retry after this long (+ id % 4 to spread the load). */
  budgetRetry: 3,
};

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

/** Impassable samples in a row (half a tile apart) that make clearPath() report a blocked line. */
const BLOCKED_RUN = 3;
/** Impassable tiles among the 5×5 around a thin crossing that make it a wall or channel, not a rock to step round. */
const WALL_TILES = 5;

/** True when the obstacle at (x,y) extends well beyond one tile (≥ WALL_TILES impassable tiles in the 5×5 around it). */
function wallLike(sim: Simulation, x: number, y: number): boolean {
  const w = sim.state.world;
  const ts = w.tileSize;
  const tx0 = Math.floor(x / ts);
  const ty0 = Math.floor(y / ts);
  let n = 0;
  for (let oy = -2; oy <= 2; oy++) {
    const ty = ty0 + oy;
    if (ty < 0 || ty >= w.height) continue;
    for (let ox = -2; ox <= 2; ox++) {
      const tx = tx0 + ox;
      if (tx < 0 || tx >= w.width) continue;
      if (!TERRAIN_INFO[w.terrain[ty * w.width + tx] as TerrainType].passable && ++n >= WALL_TILES) return true;
    }
  }
  return false;
}

/**
 * True when the straight line (x0,y0)→(x1,y1) can be walked: it never crosses a stretch of impassable
 * terrain thicker than about a tile (deep water, walls), nor a thin one that runs on to the sides (a wall
 * painted with a one-tile brush), and ends on passable ground. Small obstacles (a rock, a short stub of
 * wall) are left to stepDir's wall-following, but a river or a painted wall between an agent and its goal
 * would otherwise pin it against the bank (see brain.ts: targets are chosen with this check). Samples every
 * half tile, so the cost is ≈ 2 × length / tileSize tile lookups; allocation-free.
 */
export function clearPath(sim: Simulation, x0: number, y0: number, x1: number, y1: number): boolean {
  if (!sim.passableAt(x1, y1)) return false;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (!(d > 0)) return Number.isFinite(d);
  const n = Math.ceil(d / (sim.state.world.tileSize * 0.5));
  let run = 0;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const sx = x0 + dx * t;
    const sy = y0 + dy * t;
    if (sim.passableAt(sx, sy)) run = 0;
    // two samples in a row: the line crosses the obstacle (not just a clipped corner) — blocked when it is
    // wall-like there, since stepDir cannot get round a long one-tile wall
    else if (++run >= BLOCKED_RUN || (run === 2 && wallLike(sim, sx, sy))) return false;
  }
  return true;
}

/**
 * Steer toward (tx,ty), following a planned route when the straight line is blocked (a river crossed at a
 * ford, a lake, a painted wall). Returns true (and stops) when within `arriveDist`.
 * Callers must pass finite coordinates.
 */
export function moveToward(sim: Simulation, a: Agent, tx: number, ty: number, factor: number, arriveDist: number): boolean {
  const dx = tx - a.x;
  const dy = ty - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (!(d > arriveDist)) {
    halt(a);
    if (a.route) a.route = undefined;
    return true;
  }
  const wp = routeWaypoint(sim, a, tx, ty, d);
  if (wp >= 0) {
    const r = a.route as AgentRoute;
    const wx = r.pts[wp] - a.x;
    const wy = r.pts[wp + 1] - a.y;
    const wd = Math.sqrt(wx * wx + wy * wy);
    // stop at the waypoint (it may sit at a corner of the obstacle); the next tick turns toward the next one
    stepDir(sim, a, wx, wy, factor, wd > 0.05 ? wd : 0.05);
    return false;
  }
  const lim = d - arriveDist * 0.5;
  stepDir(sim, a, dx, dy, factor, lim > 0.05 ? lim : 0.05);
  return false;
}

/** Plan how to reach (tx,ty) from where the agent stands: straight line, waypoints, or (for now) no route. */
function makeRoute(sim: Simulation, a: Agent, tx: number, ty: number, tick: number): AgentRoute {
  const v = sim.state.world.terrainVersion;
  if (clearPath(sim, a.x, a.y, tx, ty)) return { gx: tx, gy: ty, pts: [], i: 0, t: tick + ROUTE.directRecheck, v };
  const res = planRoute(sim, a.x, a.y, tx, ty);
  if (res.status === 'ok' && res.pts.length >= 2) return { gx: tx, gy: ty, pts: res.pts, i: 0, t: tick, v };
  const retry = res.status === 'budget' ? ROUTE.budgetRetry + (a.id % 4) : ROUTE.failRetry;
  return { gx: tx, gy: ty, pts: [], i: 0, t: tick + retry, v, fail: true };
}

/**
 * The waypoint index (into a.route.pts) to steer to this tick, or -1 to steer straight at the goal.
 * Keeps a.route up to date: re-plans when the goal moved, the terrain changed, a re-check or retry is due,
 * or a truncated route ran out; advances past waypoints the agent has reached.
 */
function routeWaypoint(sim: Simulation, a: Agent, tx: number, ty: number, d: number): number {
  const world = sim.state.world;
  const ts = world.tileSize;
  if (d < ts * ROUTE.minDistTiles) return -1;
  const tick = sim.state.tick;
  let r = a.route;
  if (r) {
    const tol = Math.max(ts * ROUTE.goalTolTiles, d * 0.1);
    if (Math.abs(r.gx - tx) > tol || Math.abs(r.gy - ty) > tol || r.v !== world.terrainVersion) r = undefined;
    else if (r.pts.length === 0) {
      if (tick < r.t) return -1; // straight line verified (or no route yet): steer directly until the re-check
      r = undefined;
    }
  }
  if (!r) {
    r = makeRoute(sim, a, tx, ty, tick);
    a.route = r;
    if (r.pts.length === 0) return -1;
  }
  const pts = r.pts;
  const last = pts.length - 2;
  const st = stride(sim, a);
  const reach = Math.max(ts * 0.5, st * 1.1);
  let i = r.i;
  while (i < last) {
    const ex = pts[i] - a.x;
    const ey = pts[i + 1] - a.y;
    if (ex * ex + ey * ey > reach * reach) break;
    i += 2;
  }
  r.i = i;
  if (i >= last) {
    // final leg. If the route ends at the goal, head straight for the (possibly moving) goal; a route that
    // was cut short at NAV.maxWaypoints is re-planned once its last waypoint is reached.
    const ex = pts[last] - r.gx;
    const ey = pts[last + 1] - r.gy;
    if (ex * ex + ey * ey <= ts * ts) return -1;
    const fx = pts[last] - a.x;
    const fy = pts[last + 1] - a.y;
    if (fx * fx + fy * fy <= reach * reach) {
      a.route = undefined;
      return -1;
    }
  }
  return i;
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
