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
  /** A* node expansions available per tick, shared by all agents. */
  tickBudget: 30000,
  /** Expansions allowed for one query (a cross-map route rarely needs more than a few thousand). */
  queryBudget: 14000,
  /** Weight on the heuristic (1 = optimal A*; higher = fewer expansions, slightly longer routes). */
  heuristicWeight: 1.35,
  /** Waypoints kept per route; a longer route is re-planned when the agent reaches its last kept waypoint. */
  maxWaypoints: 40,
  /** How far (tiles) an impassable goal tile is snapped to the nearest passable one. */
  goalSnapTiles: 2,
  /** Line-of-sight samples per tile when smoothing. */
  losSamplesPerTile: 3,
};

export type RouteStatus = 'ok' | 'direct' | 'unreachable' | 'budget';

export interface RouteResult {
  status: RouteStatus;
  /** Flat waypoint list [x0, y0, x1, y1, …] in world units (status 'ok' only; the last pair is the goal). */
  pts: number[];
  /** Node expansions this query used. */
  expanded: number;
}

interface NavCache {
  version: number;
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
const budgets = new WeakMap<Simulation, { tick: number; used: number }>();

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
  return c;
}

/** Navigation data for the current terrain (rebuilt lazily after terrain changes). */
function navOf(sim: Simulation): NavCache {
  const world = sim.state.world;
  const c = caches.get(world);
  if (c && c.version === world.terrainVersion && c.terrain === world.terrain && c.w === world.width && c.h === world.height) return c;
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

function spend(sim: Simulation, n: number): void {
  let b = budgets.get(sim);
  if (!b) {
    b = { tick: sim.state.tick, used: 0 };
    budgets.set(sim, b);
  }
  if (b.tick !== sim.state.tick) {
    b.tick = sim.state.tick;
    b.used = 0;
  }
  b.used += n;
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

// ---------------------------------------------------------------- line of sight (strict, tile-based)

/** True when every sample along the segment between two world points lies on a passable tile. */
function los(nav: NavCache, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  const n = Math.max(1, Math.ceil((len / nav.ts) * NAV.losSamplesPerTile));
  for (let k = 1; k < n; k++) {
    const t = tileOf(nav, x0 + (dx * k) / n, y0 + (dy * k) / n);
    if (t < 0 || nav.cost[t] === 0) return false;
  }
  return true;
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
export function planRoute(sim: Simulation, x0: number, y0: number, x1: number, y1: number): RouteResult {
  const nav = navOf(sim);
  const start = snapPassable(nav, tileOf(nav, x0, y0), 1);
  const goal = snapPassable(nav, tileOf(nav, x1, y1), NAV.goalSnapTiles);
  if (start < 0 || goal < 0 || nav.region[start] !== nav.region[goal]) return { status: 'unreachable', pts: [], expanded: 0 };
  const ts = nav.ts;
  const goalPassable = goal === tileOf(nav, x1, y1);
  const gx = goalPassable ? x1 : ((goal % nav.w) + 0.5) * ts;
  const gy = goalPassable ? y1 : (Math.floor(goal / nav.w) + 0.5) * ts;
  if (start === goal) return { status: 'ok', pts: [gx, gy], expanded: 0 };

  const left = navBudgetLeft(sim);
  const limit = Math.min(NAV.queryBudget, left);
  if (limit < 64) return { status: 'budget', pts: [], expanded: 0 };

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
  while (nav.heapLen > 0) {
    const cur = heapPop(nav);
    if (closed[cur] === gen) continue;
    closed[cur] = gen;
    if (cur === goal) {
      found = true;
      break;
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
  if (!found) return { status: expanded > limit ? 'budget' : 'unreachable', pts: [], expanded };

  // reconstruct (goal → start)
  const tiles = nav.tiles;
  let len = 0;
  for (let t = goal; t !== -1 && len < tiles.length; t = parent[t]) tiles[len++] = t;
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
  const pts: number[] = [];
  // string-pull the turning points with a strict line-of-sight test
  let ax = x0;
  let ay = y0;
  const cand: number[] = [];
  for (const t of turns) cand.push(((t % w) + 0.5) * ts, (Math.floor(t / w) + 0.5) * ts);
  cand.push(gx, gy);
  let i = 0;
  while (i < cand.length) {
    // furthest candidate visible from the anchor (look ahead a bounded number of points)
    let j = i;
    const maxLook = Math.min(cand.length - 2, i + 2 * 12);
    for (let k = maxLook; k > i; k -= 2) {
      if (los(nav, ax, ay, cand[k], cand[k + 1])) {
        j = k;
        break;
      }
    }
    pts.push(cand[j], cand[j + 1]);
    ax = cand[j];
    ay = cand[j + 1];
    i = j + 2;
    if (pts.length >= NAV.maxWaypoints * 2) break;
  }
  return { status: 'ok', pts, expanded };
}
