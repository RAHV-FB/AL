/**
 * Route planning over the tile grid (pure, deterministic, allocation-free per query).
 *
 * Agents normally steer in straight lines (steering.ts). When the straight line to a goal is blocked —
 * a river crossed only at shallow fords, a mountain lake, a painted wall — steering asks for a route:
 *
 *   1. Regions: passable tiles are labelled into connected components (4-connected; a diagonal step is
 *      only allowed when both orthogonal neighbours are passable, so this matches the moves below).
 *      Goals in another region are rejected instantly — no search.
 *   2. Weighted A*: 8-connected moves; the cost of a step is its length × the mean time-cost of the two
 *      tiles (1 / TERRAIN_INFO.moveCost), so routes prefer fast ground and use slow shallows (fords)
 *      only where they must. The octile heuristic (× minimum tile cost 1) is admissible; it is weighted
 *      by NAV.heuristicWeight for speed, giving near-shortest routes.
 *   3. Smoothing: the tile path is reduced to its turning points, then turning points that can be
 *      skipped with a clear line of sight are dropped. Waypoints are tile centres; the last one is the goal.
 *
 * Cost control: every query is limited to NAV.queryBudget node expansions and all queries in one tick share
 * NAV.tickBudget; a refused query reports 'budget' and the agent retries a few ticks later. The budget is
 * reset at each tick from sim.state.tick, so it is deterministic and identical after save → load.
 * Derived data (regions, costs, search scratch) is cached per WorldState and rebuilt whenever
 * world.terrainVersion changes (painting, meteors); it is never part of SimState.
 */
import type { Simulation } from './simulation';
import type { TerrainType, WorldState } from './types';
import { TERRAIN_INFO } from './constants';

export const NAV = {
  /** A* node expansions available per tick, shared by all agents (≈ 2–3 ms at most). */
  tickBudget: 12000,
  /** Expansions allowed for one query (natural cross-map routes need ≤ ~8,000; mazes chain partial routes). */
  queryBudget: 10000,
  /** A search is only started when the tick has ≈ this many expansions per tile of octile distance left. */
  expansionsPerTile: 25,
  /** Weight on the heuristic (1 = optimal A*; higher = fewer expansions, slightly longer routes). */
  heuristicWeight: 1.35,
  /** Waypoints kept per route; a longer route is re-planned when the agent reaches its last kept waypoint. */
  maxWaypoints: 40,
  /** How far (tiles) an impassable goal tile is snapped to the nearest passable one. */
  goalSnapTiles: 2,
};

/**
 * 'ok' — pts ends at the goal; 'partial' — the search hit NAV.queryBudget, pts leads to the explored tile
 * closest to the goal (follow it, then plan again from there); 'unreachable'; 'budget' — this tick's shared
 * budget is spent, retry soon.
 */
export type RouteStatus = 'ok' | 'partial' | 'unreachable' | 'budget';

export interface RouteResult {
  status: RouteStatus;
  /** Flat waypoint list [x0, y0, x1, y1, …] in world units (status 'ok' only; the last pair is the goal). */
  pts: number[];
  /** Node expansions this query used. */
  expanded: number;
}

interface NavCache {
  version: number;
  /** world.navVersion the regions were labelled for. */
  navVer: number;
  terrain: Uint8Array;
  w: number;
  h: number;
  ts: number;
  /** Time cost per unit distance for each tile (≥ 1), 0 = impassable. */
  cost: Float32Array;
  /** Connected-component id per tile, -1 = impassable. */
  region: Int32Array;
  regions: number;
  // --- A* scratch (reused by every query)
  g: Float32Array;
  parent: Int32Array;
  seen: Uint32Array;
  closed: Uint32Array;
  gen: number;
  heapNode: Int32Array;
  heapF: Float32Array;
  heapLen: number;
  tiles: Int32Array;
}

const caches = new WeakMap<WorldState, NavCache>();
const budgets = new WeakMap<Simulation, { tick: number; used: number; over: boolean }>();

const SQRT2 = Math.SQRT2;
// neighbour offsets: 4 orthogonal then 4 diagonal
const NX = [1, -1, 0, 0, 1, 1, -1, -1];
const NY = [0, 0, 1, -1, 1, -1, 1, -1];
const NLEN = [1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2];

function build(world: WorldState): NavCache {
  const w = world.width;
  const h = world.height;
  const n = w * h;
  let c = caches.get(world);
  if (!c || c.w !== w || c.h !== h) {
    c = {
      version: -1,
      navVer: -1,
      terrain: world.terrain,
      w,
      h,
      ts: world.tileSize,
      cost: new Float32Array(n),
      region: new Int32Array(n),
      regions: 0,
      g: new Float32Array(n),
      parent: new Int32Array(n),
      seen: new Uint32Array(n),
      closed: new Uint32Array(n),
      gen: 0,
      // lazy deletion pushes at most 8 entries per expansion
      heapNode: new Int32Array(8 * NAV.queryBudget + 16),
      heapF: new Float32Array(8 * NAV.queryBudget + 16),
      heapLen: 0,
      tiles: new Int32Array(n),
    };
    caches.set(world, c);
  }
  c.terrain = world.terrain;
  c.ts = world.tileSize;
  for (let i = 0; i < n; i++) {
    const info = TERRAIN_INFO[world.terrain[i] as TerrainType];
    const mc = info && info.passable ? info.moveCost : 0;
    c.cost[i] = mc > 0 ? 1 / mc : 0;
  }
  // 4-connected components (a diagonal move needs both orthogonal tiles, so it never joins two components)
  const region = c.region;
  region.fill(-1);
  const stack = c.tiles; // scratch
  let id = 0;
  for (let i = 0; i < n; i++) {
    if (region[i] !== -1 || c.cost[i] === 0) continue;
    let top = 0;
    stack[top++] = i;
    region[i] = id;
    while (top > 0) {
      const t = stack[--top];
      const tx = t % w;
      const ty = (t - tx) / w;
      if (tx > 0 && region[t - 1] === -1 && c.cost[t - 1] > 0) { region[t - 1] = id; stack[top++] = t - 1; }
      if (tx < w - 1 && region[t + 1] === -1 && c.cost[t + 1] > 0) { region[t + 1] = id; stack[top++] = t + 1; }
      if (ty > 0 && region[t - w] === -1 && c.cost[t - w] > 0) { region[t - w] = id; stack[top++] = t - w; }
      if (ty < h - 1 && region[t + w] === -1 && c.cost[t + w] > 0) { region[t + w] = id; stack[top++] = t + w; }
    }
    id++;
  }
  c.regions = id;
  c.version = world.terrainVersion;
  c.navVer = world.navVersion ?? 0;
  return c;
}

/** Navigation data for the current terrain (rebuilt lazily after terrain changes). */
function navOf(sim: Simulation): NavCache {
  const world = sim.state.world;
  const c = caches.get(world);
  if (c && c.terrain === world.terrain && c.w === world.width && c.h === world.height) {
    if (c.version === world.terrainVersion) return c;
    if (c.navVer === (world.navVersion ?? 0)) {
      // only terrain costs changed (land repainted as other land): refresh the cost grid, keep the regions
      for (let i = 0; i < c.cost.length; i++) {
        const info = TERRAIN_INFO[world.terrain[i] as TerrainType];
        const mc = info && info.passable ? info.moveCost : 0;
        c.cost[i] = mc > 0 ? 1 / mc : 0;
      }
      c.version = world.terrainVersion;
      return c;
    }
  }
  return build(world);
}

function tileOf(nav: NavCache, x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
  const tx = Math.floor(x / nav.ts);
  const ty = Math.floor(y / nav.ts);
  if (tx < 0 || ty < 0 || tx >= nav.w || ty >= nav.h) return -1;
  return ty * nav.w + tx;
}

/** Nearest passable tile to `t` within `r` tiles (ring search, deterministic order), or -1. */
function snapPassable(nav: NavCache, t: number, r: number): number {
  if (t < 0) return -1;
  if (nav.cost[t] > 0) return t;
  const tx0 = t % nav.w;
  const ty0 = (t - tx0) / nav.w;
  for (let rr = 1; rr <= r; rr++) {
    let best = -1;
    let bestD = Infinity;
    for (let oy = -rr; oy <= rr; oy++) {
      const ty = ty0 + oy;
      if (ty < 0 || ty >= nav.h) continue;
      for (let ox = -rr; ox <= rr; ox++) {
        if (Math.abs(ox) !== rr && Math.abs(oy) !== rr) continue;
        const tx = tx0 + ox;
        if (tx < 0 || tx >= nav.w) continue;
        const i = ty * nav.w + tx;
        if (nav.cost[i] === 0) continue;
        const d = ox * ox + oy * oy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** Region id of the tile at a world position (-1 = impassable / outside). */
export function regionAt(sim: Simulation, x: number, y: number): number {
  const nav = navOf(sim);
  const t = tileOf(nav, x, y);
  return t < 0 ? -1 : nav.region[t];
}

/**
 * True when (x1,y1) can be reached on foot from (x0,y0) at all (same connected region; an impassable
 * goal within NAV.goalSnapTiles of land counts as that land). O(1) after the cache is built.
 */
export function sameRegion(sim: Simulation, x0: number, y0: number, x1: number, y1: number): boolean {
  const nav = navOf(sim);
  const s = snapPassable(nav, tileOf(nav, x0, y0), 1);
  const g = snapPassable(nav, tileOf(nav, x1, y1), NAV.goalSnapTiles);
  return s >= 0 && g >= 0 && nav.region[s] === nav.region[g];
}

/** Expansions still available in this tick. */
export function navBudgetLeft(sim: Simulation): number {
  const b = budgets.get(sim);
  if (!b || b.tick !== sim.state.tick) return NAV.tickBudget;
  return Math.max(0, NAV.tickBudget - b.used);
}

function budgetOf(sim: Simulation): { tick: number; used: number; over: boolean } {
  let b = budgets.get(sim);
  if (!b) {
    b = { tick: sim.state.tick, used: 0, over: false };
    budgets.set(sim, b);
  }
  if (b.tick !== sim.state.tick) {
    b.tick = sim.state.tick;
    b.used = 0;
    b.over = false;
  }
  return b;
}

function spend(sim: Simulation, n: number): void {
  budgetOf(sim).used += n;
}

// ---------------------------------------------------------------- binary heap (min f), lazy deletion

function heapPush(nav: NavCache, node: number, f: number): void {
  if (nav.heapLen >= nav.heapNode.length) return; // cannot happen within the query budget; never overflow
  let i = nav.heapLen++;
  const hn = nav.heapNode;
  const hf = nav.heapF;
  while (i > 0) {
    const p = (i - 1) >> 1;
    // ties broken by node index → deterministic and stable
    if (hf[p] < f || (hf[p] === f && hn[p] <= node)) break;
    hn[i] = hn[p];
    hf[i] = hf[p];
    i = p;
  }
  hn[i] = node;
  hf[i] = f;
}

function heapPop(nav: NavCache): number {
  const hn = nav.heapNode;
  const hf = nav.heapF;
  const top = hn[0];
  const n = --nav.heapLen;
  if (n > 0) {
    const node = hn[n];
    const f = hf[n];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      let m = l;
      if (r < n && (hf[r] < hf[l] || (hf[r] === hf[l] && hn[r] < hn[l]))) m = r;
      if (hf[m] > f || (hf[m] === f && hn[m] >= node)) break;
      hn[i] = hn[m];
      hf[i] = hf[m];
      i = m;
    }
    hn[i] = node;
    hf[i] = f;
  }
  return top;
}

// ---------------------------------------------------------------- line of sight (exact grid walk)

/**
 * Walk the tiles a segment touches (Amanatides–Woo). Returns the segment's time cost (Σ tile cost × length
 * inside the tile, in tile units), or Infinity when it touches an impassable tile or passes exactly
 * through a tile corner whose two side tiles are not both passable — the same no-corner-cutting rule the
 * A* moves and steering.stepDir obey.
 */
function lineCost(nav: NavCache, x0: number, y0: number, x1: number, y1: number): number {
  const ts = nav.ts;
  const w = nav.w;
  const cost = nav.cost;
  const fx = x0 / ts;
  const fy = y0 / ts;
  const gx = x1 / ts;
  const gy = y1 / ts;
  if (!Number.isFinite(fx + fy + gx + gy)) return Infinity;
  let tx = Math.floor(fx);
  let ty = Math.floor(fy);
  const ex = Math.floor(gx);
  const ey = Math.floor(gy);
  const pass = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < nav.h && cost[y * w + x] > 0;
  if (!pass(tx, ty) || !pass(ex, ey)) return Infinity;
  const dx = gx - fx;
  const dy = gy - fy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (!(len > 1e-9)) return 0;
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tdx = sx !== 0 ? Math.abs(1 / dx) : Infinity; // segment parameter per tile step in x
  const tdy = sy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tmx = sx > 0 ? (tx + 1 - fx) * tdx : sx < 0 ? (fx - tx) * tdx : Infinity;
  let tmy = sy > 0 ? (ty + 1 - fy) * tdy : sy < 0 ? (fy - ty) * tdy : Infinity;
  let t = 0;
  let total = 0;
  let guard = 2 * (Math.abs(ex - tx) + Math.abs(ey - ty)) + 4;
  while (tx !== ex || ty !== ey) {
    if (--guard < 0) return Infinity; // numeric trouble: be conservative
    const tn = tmx < tmy ? tmx : tmy;
    const tc = tn < 1 ? tn : 1;
    total += (tc - t) * len * cost[ty * w + tx];
    t = tc;
    if (Math.abs(tmx - tmy) < 1e-9) {
      if (!pass(tx + sx, ty) || !pass(tx, ty + sy)) return Infinity; // squeezing through a corner
      tx += sx;
      ty += sy;
      tmx += tdx;
      tmy += tdy;
    } else if (tmx < tmy) {
      tx += sx;
      tmx += tdx;
    } else {
      ty += sy;
      tmy += tdy;
    }
    if (!pass(tx, ty)) return Infinity;
  }
  total += (1 - t) * len * cost[ty * w + tx];
  return total;
}

/** True when the straight segment between two world points can be walked (exact; see lineCost). */
export function lineClear(sim: Simulation, x0: number, y0: number, x1: number, y1: number): boolean {
  return lineCost(navOf(sim), x0, y0, x1, y1) < Infinity;
}

/** Reset this tick's search budget (called by Simulation.step at the start of every tick). */
export function resetNavBudget(sim: Simulation): void {
  const b = budgetOf(sim);
  b.tick = sim.state.tick;
  b.used = 0;
  b.over = false;
}

// ---------------------------------------------------------------- A*

/**
 * Plan a walking route from (x0,y0) to (x1,y1).
 *  - 'unreachable': different regions, or no passable goal tile nearby;
 *  - 'budget': the tick's (or this query's) search budget ran out — retry later;
 *  - 'ok': pts holds the smoothed waypoints, ending at the goal.
 * Callers decide beforehand whether a straight line suffices (steering.clearPath); this function always
 * searches when the goal is reachable.
 */
export function planRoute(sim: Simulation, x0: number, y0: number, x1: number, y1: number, overdraft = false): RouteResult {
  const nav = navOf(sim);
  const start = snapPassable(nav, tileOf(nav, x0, y0), 1);
  const goal = snapPassable(nav, tileOf(nav, x1, y1), NAV.goalSnapTiles);
  if (start < 0 || goal < 0 || nav.region[start] !== nav.region[goal]) return { status: 'unreachable', pts: [], expanded: 0 };
  const ts = nav.ts;
  const goalPassable = goal === tileOf(nav, x1, y1);
  const gx = goalPassable ? x1 : ((goal % nav.w) + 0.5) * ts;
  const gy = goalPassable ? y1 : (Math.floor(goal / nav.w) + 0.5) * ts;
  if (start === goal) return { status: 'ok', pts: [gx, gy], expanded: 0 };

  // fairness: one agent per tick that has been refused repeatedly may search in full even when the
  // tick's budget is spent (deterministic: the flag is reset with the budget every tick)
  const b = budgetOf(sim);
  const over = overdraft && !b.over;
  const left = over ? NAV.queryBudget : navBudgetLeft(sim);
  if (over) b.over = true;
  let limit = Math.min(NAV.queryBudget, left);
  // do not start a search the tick cannot finish (it would be wasted): estimate the need from the distance
  const sdx = Math.abs((start % nav.w) - (goal % nav.w));
  const sdy = Math.abs(Math.floor(start / nav.w) - Math.floor(goal / nav.w));
  const need = Math.min(NAV.queryBudget, 64 + NAV.expansionsPerTile * (Math.max(sdx, sdy) + (SQRT2 - 1) * Math.min(sdx, sdy)));
  if (left < need) return { status: 'budget', pts: [], expanded: 0 };

  const w = nav.w;
  const gTx = goal % w;
  const gTy = (goal - gTx) / w;
  const W = NAV.heuristicWeight;
  const heur = (t: number): number => {
    const tx = t % w;
    const ty = (t - tx) / w;
    const ax = tx > gTx ? tx - gTx : gTx - tx;
    const ay = ty > gTy ? ty - gTy : gTy - ty;
    return W * (ax > ay ? ax + (SQRT2 - 1) * ay : ay + (SQRT2 - 1) * ax);
  };

  // new search generation: seen/closed stamps avoid clearing the arrays
  nav.gen = (nav.gen + 1) >>> 0;
  if (nav.gen === 0) {
    nav.seen.fill(0);
    nav.closed.fill(0);
    nav.gen = 1;
  }
  const gen = nav.gen;
  const g = nav.g;
  const parent = nav.parent;
  const seen = nav.seen;
  const closed = nav.closed;
  const cost = nav.cost;
  nav.heapLen = 0;
  g[start] = 0;
  parent[start] = -1;
  seen[start] = gen;
  heapPush(nav, start, heur(start));

  let expanded = 0;
  let found = false;
  let bestNode = start; // explored tile closest to the goal (heuristic), for partial routes
  let bestH = heur(start);
  while (nav.heapLen > 0) {
    const cur = heapPop(nav);
    if (closed[cur] === gen) continue;
    closed[cur] = gen;
    if (cur === goal) {
      found = true;
      break;
    }
    const hc = heur(cur);
    if (hc < bestH) {
      bestH = hc;
      bestNode = cur;
    }
    if (++expanded > limit) break;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    const gc = g[cur];
    const cc = cost[cur];
    for (let k = 0; k < 8; k++) {
      const nx = cx + NX[k];
      const ny = cy + NY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= nav.h) continue;
      const nb = ny * w + nx;
      const nc = cost[nb];
      if (nc === 0 || closed[nb] === gen) continue;
      if (k >= 4 && (cost[cy * w + nx] === 0 || cost[ny * w + cx] === 0)) continue; // no corner cutting
      const ng = gc + NLEN[k] * 0.5 * (cc + nc);
      if (seen[nb] === gen && !(ng < g[nb])) continue;
      seen[nb] = gen;
      g[nb] = ng;
      parent[nb] = cur;
      heapPush(nav, nb, ng + heur(nb));
    }
  }
  spend(sim, expanded);
  let end = goal;
  let status: RouteStatus = 'ok';
  if (!found) {
    if (!(expanded > limit)) return { status: 'unreachable', pts: [], expanded };
    // the shared tick budget ran short: retry soon. The query's own cap was hit (a maze, a long comb of
    // walls): follow a partial route to the explored tile nearest the goal and plan again from there.
    if (limit < NAV.queryBudget) return { status: 'budget', pts: [], expanded };
    // a full search found nothing closer to the goal than the start (a dead-end pocket): give up for now
    if (bestNode === start) return { status: 'unreachable', pts: [], expanded };
    end = bestNode;
    status = 'partial';
  }
  const ex = status === 'ok' ? gx : ((end % w) + 0.5) * ts;
  const ey = status === 'ok' ? gy : (Math.floor(end / w) + 0.5) * ts;

  // reconstruct (end → start)
  const tiles = nav.tiles;
  let len = 0;
  for (let t = end; t !== -1 && len < tiles.length; t = parent[t]) tiles[len++] = t;
  // turning points: tiles where the step direction changes (start and goal excluded)
  const turns: number[] = [];
  for (let k = len - 2; k >= 1; k--) {
    const pv = tiles[k + 1];
    const t = tiles[k];
    const nx = tiles[k - 1];
    const d1x = (t % w) - (pv % w);
    const d1y = Math.floor(t / w) - Math.floor(pv / w);
    const d2x = (nx % w) - (t % w);
    const d2y = Math.floor(nx / w) - Math.floor(t / w);
    if (d1x !== d2x || d1y !== d2y) turns.push(t);
  }
  // string-pull the turning points: a shortcut must be walkable (exact grid walk, corner rule) and must not
  // cost more time than the stretch of A* path it replaces (it may not cut across rock or shallows that the
  // search went round)
  const pts: number[] = [];
  const candX: number[] = [];
  const candY: number[] = [];
  const candG: number[] = [];
  for (const t of turns) {
    candX.push(((t % w) + 0.5) * ts);
    candY.push((Math.floor(t / w) + 0.5) * ts);
    candG.push(g[t]);
  }
  candX.push(ex);
  candY.push(ey);
  candG.push(g[end]);
  let ax = x0;
  let ay = y0;
  let ag = 0;
  let i = 0;
  const n = candX.length;
  while (i < n) {
    let j = i;
    const maxLook = Math.min(n - 1, i + 12);
    for (let k = maxLook; k > i; k--) {
      const c = lineCost(nav, ax, ay, candX[k], candY[k]);
      if (c <= (candG[k] - ag) * 1.03 + 0.75) {
        j = k;
        break;
      }
    }
    pts.push(candX[j], candY[j]);
    ax = candX[j];
    ay = candY[j];
    ag = candG[j];
    i = j + 1;
    if (pts.length >= NAV.maxWaypoints * 2) break;
  }
  return { status, pts, expanded };
}
