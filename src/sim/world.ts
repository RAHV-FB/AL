// OWNER: Simulation Core agent.
/**
 * Procedural world generation + tile-search helpers.
 *
 * Pipeline (all randomness from the supplied world Rng; arrays walked in index order):
 *   1. seeded gradient-noise fBm fields: domain-warped elevation, moisture, fine detail
 *   2. optional island falloff (deep ocean around the map edge)
 *   3. quantile thresholds → DeepWater / Water / land / Rock (coverage ≈ the option values)
 *   4. optional divide: meandering river with shallow fords, or a rock range with passes
 *   5. moisture (+ proximity to water) ranked over land → Desert / Grass / Forest; beaches → Sand
 *   6. repair: ≥ 56 % passable tiles and every passable region connected (shallow causeways)
 *   7. fertility (terrain × moisture × detail × opts.fertility) and initial food
 *
 * Only IEEE-exact arithmetic (+ − × ÷ sqrt floor) is used, so a seed yields the same
 * world on every JS engine.
 */
import type { Rng } from './rng';
import type { Simulation } from './simulation';
import { TERRAIN_INFO } from './constants';
import { TERRAIN, type SimConfig, type TerrainType, type WorldGenOptions, type WorldState } from './types';

export function createEmptyWorld(width: number, height: number, tileSize: number): WorldState {
  const n = width * height;
  return {
    width,
    height,
    tileSize,
    terrain: new Uint8Array(n).fill(TERRAIN.Grass),
    food: new Float32Array(n),
    fertility: new Float32Array(n).fill(1),
    baseFertility: new Float32Array(n).fill(1),
    elevation: new Float32Array(n).fill(0.5),
    climateMod: new Float32Array(n).fill(1),
    territory: new Int16Array(n).fill(-1),
    terrainVersion: 0,
  };
}

// ------------------------------------------------------------------ helpers

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const isWaterType = (t: number): boolean => t === TERRAIN.DeepWater || t === TERRAIN.Water;
const isPassableType = (t: number): boolean => TERRAIN_INFO[t as TerrainType].passable;

/** Largest float32 that is <= v (keeps stored food from exceeding capacity by rounding). */
function f32AtMost(v: number): number {
  const r = Math.fround(v);
  return r <= v ? r : Math.fround(v - Math.abs(v) * 1.2e-7);
}

/** Value at quantile q (0..1) of the given numbers: ≈ q·n values are strictly below it. */
function quantile(values: ArrayLike<number>, q: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  return sorted[clamp(Math.floor(q * n), 0, n - 1)];
}

// ------------------------------------------------------------------ noise

/** Seeded 2-D gradient (Perlin-style) noise with fBm. Output ≈ [-1, 1]. */
export class GradientNoise {
  private readonly perm = new Uint16Array(512);
  private readonly gx = new Float64Array(256);
  private readonly gy = new Float64Array(256);
  private readonly ox: number;
  private readonly oy: number;

  constructor(rng: Rng) {
    const p: number[] = [];
    for (let i = 0; i < 256; i++) p.push(i);
    rng.shuffle(p);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) {
      // random unit vector via rejection sampling (no trig → engine-independent)
      let x = 0;
      let y = 0;
      let l2 = 0;
      do {
        x = rng.next() * 2 - 1;
        y = rng.next() * 2 - 1;
        l2 = x * x + y * y;
      } while (l2 < 0.01 || l2 > 1);
      const inv = 1 / Math.sqrt(l2);
      this.gx[i] = x * inv;
      this.gy[i] = y * inv;
    }
    this.ox = rng.next() * 256;
    this.oy = rng.next() * 256;
  }

  noise(x: number, y: number): number {
    x += this.ox;
    y += this.oy;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const p = this.perm;
    const a = p[X] + Y;
    const b = p[X + 1] + Y;
    const h00 = p[a];
    const h01 = p[a + 1];
    const h10 = p[b];
    const h11 = p[b + 1];
    const gx = this.gx;
    const gy = this.gy;
    const n00 = gx[h00] * xf + gy[h00] * yf;
    const n10 = gx[h10] * (xf - 1) + gy[h10] * yf;
    const n01 = gx[h01] * xf + gy[h01] * (yf - 1);
    const n11 = gx[h11] * (xf - 1) + gy[h11] * (yf - 1);
    const u = fade(xf);
    const v = fade(yf);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * 1.4142135623730951;
  }

  /** Fractal Brownian motion: `octaves` layers, each at double frequency / half amplitude. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * f + o * 17.31, y * f + o * 9.73);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }
}

// ------------------------------------------------------------------ fertility

/**
 * Natural soil fertility (0..1) for a terrain type at a given moisture (0..1).
 * Used by world generation and by terrain painting.
 */
export function defaultFertility(t: TerrainType, moisture = 0.5): number {
  const m = clamp(finite(moisture, 0.5), 0, 1);
  switch (t) {
    case TERRAIN.Water:
      return 0.45 + 0.25 * m;
    case TERRAIN.Sand:
      return 0.3 + 0.25 * m;
    case TERRAIN.Grass:
      return 0.55 + 0.4 * m;
    case TERRAIN.Forest:
      return 0.6 + 0.4 * m;
    case TERRAIN.Desert:
      return 0.15 + 0.25 * m;
    case TERRAIN.Rock:
      return 0.25 + 0.3 * m;
    default:
      return 0; // DeepWater, Wall
  }
}

// ------------------------------------------------------------------ generation

interface GenOpts {
  waterLevel: number;
  forestFrac: number;
  desertFrac: number;
  mountainLevel: number;
  noiseScale: number;
  fertility: number;
  divide: 'none' | 'river' | 'mountains';
  island: boolean;
  initialFood: number;
}

function resolveOptions(o: WorldGenOptions): GenOpts {
  let forestFrac = clamp(finite(o.forestLevel, 0.5), 0, 1) * 0.6;
  let desertFrac = clamp(finite(o.desertLevel, 0.15), 0, 0.9);
  if (forestFrac + desertFrac > 0.95) {
    const k = 0.95 / (forestFrac + desertFrac);
    forestFrac *= k;
    desertFrac *= k;
  }
  return {
    waterLevel: clamp(finite(o.waterLevel, 0.3), 0, 0.85),
    forestFrac,
    desertFrac,
    mountainLevel: clamp(finite(o.mountainLevel, 0.12), 0, 0.8),
    noiseScale: clamp(finite(o.noiseScale, 40), 3, 1000),
    fertility: clamp(finite(o.fertility, 1), 0, 2),
    divide: o.divide === 'river' || o.divide === 'mountains' ? o.divide : 'none',
    island: o.island !== false,
    initialFood: clamp(finite(o.initialFood, 0.7), 0, 1),
  };
}

/** 8-neighbour BFS distance (in tiles) from source tiles, capped at `cap` (255 = unreached). */
function distanceField(W: number, H: number, isSource: (i: number) => boolean, cap: number): Uint8Array {
  const N = W * H;
  const dist = new Uint8Array(N).fill(255);
  const queue = new Int32Array(N);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < N; i++) {
    if (isSource(i)) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const d = dist[i];
    if (d >= cap) continue;
    const x = i % W;
    const y = (i - x) / W;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= W) continue;
        const j = ny * W + nx;
        if (dist[j] !== 255) continue;
        dist[j] = d + 1;
        queue[tail++] = j;
      }
    }
  }
  return dist;
}

/** Choose `count` well-spread rows (for fords / passes), preferring rows where `good(y)` holds. */
function pickRows(H: number, count: number, rng: Rng, good: (y: number) => boolean): number[] {
  const rows: number[] = [];
  const reach = Math.max(1, Math.floor(H * 0.12));
  for (let k = 0; k < count; k++) {
    const base = clamp(Math.round(((k + 1) / (count + 1)) * H + (rng.next() - 0.5) * H * 0.1), 1, Math.max(1, H - 2));
    let chosen = base;
    for (let d = 0; d <= reach; d++) {
      if (base + d < H - 1 && good(base + d)) {
        chosen = base + d;
        break;
      }
      if (base - d > 0 && good(base - d)) {
        chosen = base - d;
        break;
      }
    }
    rows.push(chosen);
  }
  return rows;
}

/**
 * Connect every passable region to the largest one by carving the cheapest
 * shallow-water causeway (0-1 BFS: passable tiles cost 0, impassable 1).
 * Tiles flagged in `blocked` are never carved. Returns the number of carved tiles.
 */
function connectRegions(T: Uint8Array, W: number, H: number, blocked: Uint8Array): number {
  const N = W * H;
  const label = new Int32Array(N).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (label[s] !== -1 || !isPassableType(T[s])) continue;
    const id = sizes.length;
    let size = 0;
    let sp = 0;
    stack[sp++] = s;
    label[s] = id;
    while (sp > 0) {
      const i = stack[--sp];
      size++;
      const x = i % W;
      const nb0 = x > 0 ? i - 1 : -1;
      const nb1 = x < W - 1 ? i + 1 : -1;
      const nb2 = i >= W ? i - W : -1;
      const nb3 = i < N - W ? i + W : -1;
      for (const j of [nb0, nb1, nb2, nb3]) {
        if (j >= 0 && label[j] === -1 && isPassableType(T[j])) {
          label[j] = id;
          stack[sp++] = j;
        }
      }
    }
    sizes.push(size);
  }
  if (sizes.length <= 1) return 0;
  let main = 0;
  for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[main]) main = c;
  const merged = new Uint8Array(sizes.length);
  merged[main] = 1;
  const INF = 0x3fffffff;
  const dist = new Int32Array(N);
  const prev = new Int32Array(N);
  let carved = 0;
  for (let c = 0; c < sizes.length; c++) {
    if (merged[c]) continue;
    dist.fill(INF);
    prev.fill(-1);
    let cur: number[] = [];
    for (let i = 0; i < N; i++) {
      if (label[i] === c) {
        dist[i] = 0;
        cur.push(i);
      }
    }
    let target = -1;
    let cost = 0;
    while (cur.length && target < 0) {
      const next: number[] = [];
      while (cur.length) {
        const i = cur.pop()!;
        if (dist[i] !== cost) continue; // stale entry
        if (label[i] >= 0 && merged[label[i]]) {
          target = i;
          break;
        }
        const x = i % W;
        const nbs = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < N - W ? i + W : -1];
        for (const j of nbs) {
          if (j < 0 || blocked[j]) continue;
          const w = isPassableType(T[j]) ? 0 : 1;
          const nd = cost + w;
          if (nd < dist[j]) {
            dist[j] = nd;
            prev[j] = i;
            (w === 0 ? cur : next).push(j);
          }
        }
      }
      cur = next;
      cost++;
    }
    merged[c] = 1;
    if (target < 0) continue; // unreachable (fully enclosed by blocked tiles)
    for (let i = target; i >= 0; i = prev[i]) {
      if (label[i] >= 0) merged[label[i]] = 1;
      else if (!isPassableType(T[i])) {
        T[i] = TERRAIN.Water;
        carved++;
      }
    }
  }
  return carved;
}

/** Generate a world deterministically from `rng` (a dedicated world RNG). */
export function generateWorld(config: SimConfig, rng: Rng, opts: WorldGenOptions): WorldState {
  const W = Math.max(1, Math.floor(finite(config.worldWidth, 200)));
  const H = Math.max(1, Math.floor(finite(config.worldHeight, 125)));
  const ts = finite(config.tileSize, 8) > 0 ? config.tileSize : 8;
  const world = createEmptyWorld(W, H, ts);
  const N = W * H;
  const o = resolveOptions(opts ?? {});
  const T = world.terrain;

  // 1. noise fields ------------------------------------------------------
  const elevN = new GradientNoise(rng);
  const warpN = new GradientNoise(rng);
  const moistN = new GradientNoise(rng);
  const detailN = new GradientNoise(rng);
  const pathN = new GradientNoise(rng);

  const elev = new Float64Array(N);
  const moist = new Float64Array(N);
  const detail = new Float64Array(N);
  const inv = 1 / o.noiseScale;
  const marginX = Math.max(2, W * 0.12);
  const marginY = Math.max(2, H * 0.12);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const sx = (x + 0.5) * inv;
      const sy = (y + 0.5) * inv;
      const wx = warpN.fbm(sx * 0.6, sy * 0.6, 3);
      const wy = warpN.fbm(sx * 0.6 + 41.3, sy * 0.6 + 17.9, 3);
      let e = 0.5 + 0.5 * elevN.fbm(sx + 0.8 * wx, sy + 0.8 * wy, 5);
      if (o.island) {
        // 2. island falloff: soft union of the distances to the vertical / horizontal edges
        const ex = 1 - Math.min(x + 0.5, W - x - 0.5) / marginX;
        const ey = 1 - Math.min(y + 0.5, H - y - 0.5) / marginY;
        const t = 1 - (1 - (ex > 0 ? ex : 0)) * (1 - (ey > 0 ? ey : 0));
        const nx = ((x + 0.5) / W) * 2 - 1;
        const ny = ((y + 0.5) / H) * 2 - 1;
        e -= 0.6 * t * t + 0.06 * (nx * nx + ny * ny);
      }
      elev[i] = e;
      moist[i] = moistN.fbm(sx * 1.25 + 7.7, sy * 1.25 + 3.1, 4);
      detail[i] = 0.5 + 0.5 * detailN.fbm(sx * 3.5, sy * 3.5, 2);
    }
  }

  // 3. thresholds ----------------------------------------------------------
  const sea = quantile(elev, o.waterLevel);
  const deep = quantile(elev, o.waterLevel * 0.62);
  const landElev: number[] = [];
  for (let i = 0; i < N; i++) if (elev[i] >= sea) landElev.push(elev[i]);
  const rockLevel = o.mountainLevel > 0 && landElev.length ? quantile(landElev, 1 - o.mountainLevel) : Infinity;

  const ring = new Uint8Array(N); // island border (always deep water)
  if (o.island) {
    for (let x = 0; x < W; x++) {
      ring[x] = 1;
      ring[(H - 1) * W + x] = 1;
    }
    for (let y = 0; y < H; y++) {
      ring[y * W] = 1;
      ring[y * W + W - 1] = 1;
    }
  }
  for (let i = 0; i < N; i++) {
    const e = elev[i];
    T[i] = ring[i] || e < deep ? TERRAIN.DeepWater : e < sea ? TERRAIN.Water : e >= rockLevel ? TERRAIN.Rock : TERRAIN.Grass;
  }

  // 4. divides -------------------------------------------------------------
  const fixed = new Uint8Array(N); // tiles the biome pass must not touch
  const pathX = new Float64Array(H);
  if (o.divide !== 'none') {
    const amp = W * 0.07;
    for (let y = 0; y < H; y++) pathX[y] = W / 2 + amp * 1.5 * pathN.fbm(3.7, (y + 0.5) / (o.noiseScale * 0.9), 3);
    for (let y = 1; y < H; y++) pathX[y] = clamp(pathX[y], pathX[y - 1] - 0.7, pathX[y - 1] + 0.7);
    for (let y = 0; y < H; y++) pathX[y] = clamp(pathX[y], W * 0.3, W * 0.7);
  }

  const riverCoreHW = Math.max(1.5, W * 0.008);
  const riverBankHW = riverCoreHW + 1.3;
  const riverCore = new Uint8Array(N);
  const riverBank = new Uint8Array(N);
  if (o.divide === 'river') {
    for (let y = 0; y < H; y++) {
      const x0 = Math.max(0, Math.floor(pathX[y] - riverBankHW - 1));
      const x1 = Math.min(W - 1, Math.ceil(pathX[y] + riverBankHW + 1));
      for (let x = x0; x <= x1; x++) {
        const d = Math.abs(x + 0.5 - pathX[y]);
        if (d < riverCoreHW) riverCore[y * W + x] = 1;
        else if (d < riverBankHW) riverBank[y * W + x] = 1;
      }
    }
  } else if (o.divide === 'mountains') {
    const hw = Math.max(2, W * 0.03);
    const passHalf = Math.max(1, Math.round(H * 0.03));
    const passes = pickRows(H, H >= 60 ? 3 : 2, rng, (y) => {
      const xi = Math.floor(pathX[y]);
      return xi >= 0 && xi < W && !isWaterType(T[y * W + xi]);
    });
    const top = Number.isFinite(rockLevel) ? rockLevel : sea + 0.25;
    for (let y = 0; y < H; y++) {
      let inPass = false;
      for (const p of passes) if (Math.abs(y - p) <= passHalf) inPass = true;
      const x0 = Math.max(0, Math.floor(pathX[y] - hw - 2));
      const x1 = Math.min(W - 1, Math.ceil(pathX[y] + hw + 2));
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (ring[i] || T[i] === TERRAIN.DeepWater) continue;
        const d = Math.abs(x + 0.5 - pathX[y]);
        if (d >= hw + (detail[i] - 0.5) * 3) continue; // ragged flanks
        if (inPass) {
          T[i] = TERRAIN.Grass;
          elev[i] = clamp(elev[i], sea + 0.02, top - 0.02);
        } else {
          T[i] = TERRAIN.Rock;
          elev[i] = Math.max(elev[i], top + 0.15 * (1 - d / hw));
        }
        fixed[i] = 1;
      }
    }
  }

  // 5. moisture → biomes ----------------------------------------------------
  const distSea = distanceField(W, H, (i) => isWaterType(T[i]), 12);
  const distAny = o.divide === 'river' ? distanceField(W, H, (i) => isWaterType(T[i]) || riverCore[i] === 1 || riverBank[i] === 1, 12) : distSea;
  const landIdx: number[] = [];
  const mAdj = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    if (isWaterType(T[i])) continue;
    landIdx.push(i);
    const d = distAny[i];
    mAdj[i] = moist[i] + (d < 8 ? 0.4 * (1 - d / 8) : 0);
  }
  landIdx.sort((a, b) => mAdj[a] - mAdj[b] || a - b);
  const mRank = new Float64Array(N).fill(1);
  const denom = Math.max(1, landIdx.length - 1);
  for (let k = 0; k < landIdx.length; k++) mRank[landIdx[k]] = k / denom;

  for (let i = 0; i < N; i++) {
    if (T[i] !== TERRAIN.Grass || fixed[i]) continue;
    const m = mRank[i];
    const ds = distSea[i];
    if (ds <= 1 || (ds === 2 && detail[i] > 0.55)) T[i] = TERRAIN.Sand;
    else if (m < o.desertFrac) T[i] = TERRAIN.Desert;
    else if (m >= 1 - o.forestFrac) T[i] = TERRAIN.Forest;
  }

  // 4b. carve the river (after biomes so its banks stay green) ---------------
  if (o.divide === 'river') {
    const reach = riverBankHW + 2;
    const fords = pickRows(H, H >= 60 ? 3 : 2, rng, (y) => {
      const xl = Math.floor(pathX[y] - reach);
      const xr = Math.floor(pathX[y] + reach);
      return xl >= 0 && xr < W && !isWaterType(T[y * W + xl]) && !isWaterType(T[y * W + xr]);
    });
    const fordHalf = H >= 60 ? 1 : 0;
    for (let y = 0; y < H; y++) {
      let inFord = false;
      for (const f of fords) if (Math.abs(y - f) <= fordHalf) inFord = true;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (ring[i] || (!riverCore[i] && !riverBank[i])) continue;
        if (riverCore[i]) T[i] = inFord ? TERRAIN.Water : TERRAIN.DeepWater;
        else if (T[i] !== TERRAIN.DeepWater) T[i] = TERRAIN.Water;
        elev[i] = Math.min(elev[i], sea - (riverCore[i] ? 0.04 : 0.01));
        fixed[i] = 1;
      }
    }
  }

  // 6. repair: passable fraction, then connectivity ------------------------
  const targetPassable = Math.ceil(N * 0.56);
  let passable = 0;
  for (let i = 0; i < N; i++) if (isPassableType(T[i])) passable++;
  if (passable < targetPassable) {
    const cand: number[] = [];
    for (let i = 0; i < N; i++) if (T[i] === TERRAIN.DeepWater && !ring[i] && !fixed[i]) cand.push(i);
    cand.sort((a, b) => elev[b] - elev[a] || a - b);
    for (let k = 0; k < cand.length && passable < targetPassable; k++) {
      T[cand[k]] = TERRAIN.Water;
      passable++;
    }
    // tiny maps: allow any deep tile
    for (let i = 0; i < N && passable < targetPassable; i++) {
      if (T[i] === TERRAIN.DeepWater) {
        T[i] = TERRAIN.Water;
        passable++;
      }
    }
  }
  connectRegions(T, W, H, ring);

  // 7. fertility, food, elevation ------------------------------------------
  const fc = Math.max(0, finite(config.foodCapacity, 1));
  let eMin = Infinity;
  let eMax = -Infinity;
  for (let i = 0; i < N; i++) {
    if (elev[i] < eMin) eMin = elev[i];
    if (elev[i] > eMax) eMax = elev[i];
  }
  const eSpan = eMax > eMin ? eMax - eMin : 1;
  for (let i = 0; i < N; i++) {
    const t = T[i] as TerrainType;
    const m = t === TERRAIN.Water ? 1 : mRank[i];
    const f = clamp(defaultFertility(t, m) * (0.85 + 0.3 * detail[i]) * o.fertility, 0, 1);
    world.baseFertility[i] = f;
    world.fertility[i] = f;
    const cap = TERRAIN_INFO[t].maxFood * world.fertility[i] * fc;
    world.food[i] = f32AtMost(cap * o.initialFood);
    world.elevation[i] = clamp((elev[i] - eMin) / eSpan, 0, 1);
  }
  return world;
}

// ------------------------------------------------------------------ tile search

/**
 * Nearest passable position to (x, y) within `maxRadius` world units, searching
 * outward ring by ring over tiles (deterministic). Returns (x, y) itself (clamped to
 * the map) when it is already passable; otherwise the point of the nearest passable
 * tile closest to (x, y), inset from the tile edges. `avoidWater` also skips shallows.
 */
export function findPassableNear(
  sim: Simulation,
  x: number,
  y: number,
  maxRadius: number,
  avoidWater = false,
): { x: number; y: number } | null {
  return findPassableInWorld(sim.state.world, x, y, maxRadius, avoidWater);
}

/** World-level variant of {@link findPassableNear} (no Simulation needed). */
export function findPassableInWorld(
  world: WorldState,
  x: number,
  y: number,
  maxRadius: number,
  avoidWater = false,
): { x: number; y: number } | null {
  const W = world.width;
  const H = world.height;
  const ts = world.tileSize;
  if (W <= 0 || H <= 0 || !(ts > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const T = world.terrain;
  const ww = W * ts;
  const wh = H * ts;
  const px = x < 0.5 ? 0.5 : x > ww - 0.5 ? ww - 0.5 : x;
  const py = y < 0.5 ? 0.5 : y > wh - 0.5 ? wh - 0.5 : y;
  const ok = (i: number): boolean => {
    const t = T[i];
    return isPassableType(t) && !(avoidWater && t === TERRAIN.Water);
  };
  const tx0 = clamp(Math.floor(px / ts), 0, W - 1);
  const ty0 = clamp(Math.floor(py / ts), 0, H - 1);
  if (ok(ty0 * W + tx0)) return { x: px, y: py };
  const maxRing = Math.min(Math.max(W, H), Math.ceil(Math.max(0, finite(maxRadius, 0)) / ts));
  let best = -1;
  let bestD = Infinity;
  for (let r = 1; r <= maxRing; r++) {
    // every tile of ring r is at least (r - 0.5) tiles away from the query point
    const lim = (r - 0.5) * ts;
    if (best >= 0 && bestD <= lim * lim) break;
    for (let dy = -r; dy <= r; dy++) {
      const ty = ty0 + dy;
      if (ty < 0 || ty >= H) continue;
      const step = dy === -r || dy === r ? 1 : 2 * r;
      for (let dx = -r; dx <= r; dx += step) {
        const tx = tx0 + dx;
        if (tx < 0 || tx >= W) continue;
        const i = ty * W + tx;
        if (!ok(i)) continue;
        const cx = (tx + 0.5) * ts - px;
        const cy = (ty + 0.5) * ts - py;
        const d = cx * cx + cy * cy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
  }
  if (best < 0) return null;
  const btx = best % W;
  const bty = (best - btx) / W;
  const inset = ts * 0.25;
  return {
    x: clamp(px, btx * ts + inset, (btx + 1) * ts - inset),
    y: clamp(py, bty * ts + inset, (bty + 1) * ts - inset),
  };
}
