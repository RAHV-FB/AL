// OWNER: Ecology agent.
/**
 * Ecology — the living backdrop of the world.
 *
 *  • Environment clock: time of day, daylight, days, seasons, years, temperature and the
 *    global season growth multiplier. A pure function of `state.tick` + config, so it is
 *    identical after save/load and on replays.
 *  • Plant resources: per-tile logistic regrowth plus "seed rain" (bare soil re-seeds in
 *    proportion to its fertility, faster next to lush tiles, so regrowth spreads from
 *    edges), excess food decaying back to capacity, and soil fertility that erodes on
 *    tiles grazed bare (desertification) and recovers under lush cover.
 *
 * No hidden state and no randomness: everything is derived from SimState, so this module
 * is deterministic and needs nothing extra persisted.
 */
import type { Simulation } from './simulation';
import { SEASON_NAMES, TERRAIN_INFO } from './constants';
import { TERRAIN_COUNT, type EnvState, type SimConfig, type TerrainType } from './types';

// ------------------------------------------------------------------ tunables

/** Time of day at tick 0 (0 = midnight, 0.5 = noon): experiments start in the morning. */
export const DAY_START = 0.3;
/** Mean temperature (°C-ish) through each season: spring, summer, autumn, winter. */
export const SEASON_TEMPERATURE: readonly number[] = [14, 26, 12, -3];
/** Plant-growth multiplier through each season: spring, summer, autumn, winter. */
export const SEASON_GROWTH: readonly number[] = [1.3, 1.0, 0.8, 0.35];
/** Year-round mean of the seasonal growth curve. */
export const MEAN_SEASON_GROWTH = (1.3 + 1.0 + 0.8 + 0.35) / 4;
/** Half-width (in seasons) of the smooth blend centred on each season boundary. */
const SEASON_BLEND = 0.25;
/** Daily temperature swing (± °C) when the day/night cycle is on; coldest ≈ 03:30, warmest ≈ 15:30. */
export const DAILY_TEMP_SWING = 4;

/** Logistic regrowth rate r per tick. Grass (maxFood 10) at half capacity: r·5·0.5 ≈ 0.008 food/tick at seasonGrowth 1. */
export const REGROWTH_RATE = 0.0055;
/** Seed rain on bare soil: food/tick per unit fertility (× growth modifiers × (1 − food/cap)). */
export const SEED_RAIN = 0.0012;
/** Seed rain is multiplied by (1 + SEED_SPREAD·n), n = 0..1 richness of the 4 neighbours. */
export const SEED_SPREAD = 3;
/** Fraction of any excess above capacity lost per tick (overfilled tiles decay back to capacity). */
export const OVERFILL_DECAY = 0.003;
/** Hard ceiling on tile food as a multiple of capacity (interventions may overfill up to this). */
export const MAX_OVERFILL = 1.5;
export const FERTILITY_MIN = 0.02;
export const FERTILITY_MAX = 1.2;
/** Below this food/capacity a tile counts as grazed bare and its soil erodes (when config.overgrazing). */
export const BARE_FRACTION = 0.08;
/** At or below this food/capacity erosion runs at full speed (linear ramp up to BARE_FRACTION). */
const BARE_FULL = 0.02;
/** Above this food/capacity fertility recovers toward baseFertility (full speed from LUSH_FULL). */
export const LUSH_FRACTION = 0.5;
const LUSH_FULL = 0.8;
/** Erosion: fraction of (fertility − FERTILITY_MIN) lost per tick on fully bare soil. */
export const FERTILITY_DECAY = 0.0004;
/** Recovery: fraction of the gap to baseFertility closed per tick under lush cover (× growth conditions, ≤ 2). */
export const FERTILITY_RECOVERY = 0.0006;
/** updateResources processes every RESOURCE_STAGGER-th row per tick, each with a RESOURCE_STAGGER× time step. */
export const RESOURCE_STAGGER = 4;
/**
 * Assumed average food eaten per agent per tick, used by estimateCarryingCapacity. Assumption:
 * an adult's basal burn (~0.06–0.12/tick depending on size/metabolism/difficulty) averaged over
 * a mixed population incl. juveniles ≈ 0.09.
 */
export const AGENT_FOOD_PER_TICK = 0.09;
/** findFood ignores tiles holding less food than this. */
export const MIN_FORAGE_FOOD = 0.5;
/** findFood reads at most ≈ this many tiles; larger radii are sampled on a coarser lattice. */
const FIND_MAX_READS = 150;
/** Tile radius up to which findFood scans every tile (π·r² ≈ FIND_MAX_READS). */
const FIND_FULL_RES = Math.sqrt(FIND_MAX_READS / Math.PI);

const OVERFILL_KEEP = Math.pow(1 - OVERFILL_DECAY, RESOURCE_STAGGER);

// Per-terrain lookups (256 entries so corrupt terrain bytes read as barren instead of crashing).
const MAX_FOOD = new Float64Array(256);
const REGEN = new Float64Array(256);
const PASSABLE = new Uint8Array(256);
for (let t = 0; t < TERRAIN_COUNT; t++) {
  const info = TERRAIN_INFO[t as TerrainType];
  if (!info) continue;
  MAX_FOOD[t] = info.maxFood > 0 ? info.maxFood : 0;
  REGEN[t] = info.regen > 0 ? info.regen : 0;
  PASSABLE[t] = info.passable ? 1 : 0;
}
/** Lattice offsets scratch for findFood (allocation-free). */
const OFFS = new Int32Array(32);

// ------------------------------------------------------------------ helpers

/** Clamp to [lo, hi]; NaN → fallback. */
function num(v: number, lo: number, hi: number, fallback: number): number {
  return v >= lo ? (v <= hi ? v : hi) : v < lo ? lo : fallback;
}

function smooth01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * Value of a per-season table at continuous season position `pos` ∈ [0,4) (season index +
 * progress): each season's value holds through its middle, with a smooth blend centred on
 * each boundary.
 */
function seasonal(table: readonly number[], pos: number): number {
  let s = Math.floor(pos);
  const p = pos - s;
  s &= 3;
  if (p < SEASON_BLEND) {
    const prev = (s + 3) & 3;
    return table[prev] + (table[s] - table[prev]) * smooth01((p + SEASON_BLEND) / (2 * SEASON_BLEND));
  }
  if (p > 1 - SEASON_BLEND) {
    const next = (s + 1) & 3;
    return table[s] + (table[next] - table[s]) * smooth01((p - (1 - SEASON_BLEND)) / (2 * SEASON_BLEND));
  }
  return table[s];
}

/** Daylight 0..1 for a time of day: 0 at night, 1 through the middle of the day, smooth dawn and dusk. */
export function daylightAt(timeOfDay: number): number {
  const sun = -Math.cos(2 * Math.PI * timeOfDay); // −1 at midnight … +1 at noon
  return smooth01((sun + 0.45) / 0.7); // dawn ≈ 0.18–0.29, dusk ≈ 0.71–0.82
}

/** Fill every derived clock field of `env` for `tick` (reads env.tempOffset). */
function computeClock(env: EnvState, config: SimConfig, tick: number): void {
  const dayLength = Math.round(num(config.dayLength, 1, 1e7, 600));
  const daysPerSeason = Math.round(num(config.daysPerSeason, 1, 1e5, 3));
  const daysPerYear = daysPerSeason * 4;
  // integer ticks since the (virtual) midnight before the experiment started
  const t = Math.floor(num(tick, 0, Number.MAX_SAFE_INTEGER, 0)) + Math.round(DAY_START * dayLength);
  const day = Math.floor(t / dayLength);
  const timeOfDay = (t - day * dayLength) / dayLength;

  env.timeOfDay = timeOfDay;
  env.daylight = config.dayNight ? daylightAt(timeOfDay) : 1;
  env.day = day;
  env.year = Math.floor(day / daysPerYear);

  let pos: number; // continuous season position 0..4
  if (config.seasons) {
    pos = ((day % daysPerYear) + timeOfDay) / daysPerSeason;
    let season = Math.floor(pos);
    if (season > 3) season = 3;
    env.season = season as EnvState['season'];
    env.seasonProgress = pos - season;
    env.seasonGrowth = seasonal(SEASON_GROWTH, pos);
  } else {
    pos = 0.5; // perpetual mid-spring
    env.season = 0;
    env.seasonProgress = 0.5;
    env.seasonGrowth = 1;
  }
  const swing = config.dayNight ? -DAILY_TEMP_SWING * Math.cos(2 * Math.PI * (timeOfDay - 0.15)) : 0;
  const offset = Number.isFinite(env.tempOffset) ? env.tempOffset : 0;
  env.temperature = seasonal(SEASON_TEMPERATURE, pos) + swing + offset;
}

const SEASON_EVENTS: { severity: 'info' | 'good' | 'bad'; text: string }[] = [
  { severity: 'good', text: 'Spring has arrived — plants burst back into growth.' },
  { severity: 'info', text: 'Summer has arrived — long warm days and steady plant growth.' },
  { severity: 'info', text: 'Autumn has arrived — plant growth is slowing.' },
  { severity: 'bad', text: 'Winter has come — plant growth slows to a crawl.' },
];

// ------------------------------------------------------------------ environment

/** Initial environment state for a new simulation (the clock at tick 0: a spring morning). */
export function initEnvironment(config: SimConfig): EnvState {
  const env: EnvState = {
    timeOfDay: DAY_START,
    daylight: 1,
    day: 0,
    season: 0,
    seasonProgress: 0,
    year: 0,
    temperature: SEASON_TEMPERATURE[0],
    tempOffset: 0,
    seasonGrowth: 1,
  };
  computeClock(env, config, 0);
  return env;
}

/**
 * Advance clock: time of day, daylight, season, temperature, seasonGrowth. Derived from
 * state.tick (tick 0 ≈ 0.3 of the first day). env.year and env.day are 0-based counts of
 * elapsed years/days. Logs an 'environment' event on each season change and new year.
 */
export function updateEnvironment(sim: Simulation): void {
  const env = sim.state.env;
  const prevSeason = env.season;
  const prevYear = env.year;
  computeClock(env, sim.state.config, sim.state.tick);
  if (env.year > prevYear) {
    sim.log('environment', 'info', `Year ${env.year + 1} begins — the seasons have come full circle.`);
  }
  if (env.season !== prevSeason) {
    const ev = SEASON_EVENTS[env.season];
    sim.log('environment', ev.severity, ev.text);
  }
}

/** Display name of the current season ("Spring" … "Winter"). */
export function seasonName(env: EnvState): string {
  return SEASON_NAMES[env.season] ?? SEASON_NAMES[0];
}

// ------------------------------------------------------------------ resources

/**
 * Plant regrowth + fertility dynamics, staggered: each tick processes every
 * RESOURCE_STAGGER-th row (phase = tick % RESOURCE_STAGGER) with a RESOURCE_STAGGER× step.
 *
 * Per tile (cap = tileCapacity, q = food/cap, mod = foodRegen·terrain.regen·seasonGrowth·climateMod):
 *   food < cap:  food += dt·mod·(REGROWTH_RATE·food + SEED_RAIN·fertility·(1 + SEED_SPREAD·n))·(1 − q)
 *   food > cap:  excess decays by OVERFILL_DECAY/tick; hard ceiling MAX_OVERFILL·cap
 *   q < BARE_FRACTION && overgrazing:  fertility erodes toward FERTILITY_MIN (desertification)
 *   q > LUSH_FRACTION:  fertility recovers toward baseFertility (speed ∝ growth conditions)
 * Allocation-free; repairs NaN/out-of-range food and fertility on the way.
 */
export function updateResources(sim: Simulation): void {
  const s = sim.state;
  const w = s.world;
  const cfg = s.config;
  const W = w.width;
  const H = w.height;
  const n = W * H;
  const food = w.food;
  const fert = w.fertility;
  const terr = w.terrain;
  if (!food || !fert || !terr || food.length !== n || fert.length !== n || terr.length !== n) return;
  const base = w.baseFertility && w.baseFertility.length === n ? w.baseFertility : null;
  const cm = w.climateMod && w.climateMod.length === n ? w.climateMod : null;

  const dt = RESOURCE_STAGGER;
  const fc = num(cfg.foodCapacity, 0, 1000, 1);
  const growth = num(cfg.foodRegen, 0, 1000, 1) * num(s.env.seasonGrowth, 0, 100, 1);
  const overgrazing = !!cfg.overgrazing;
  const nbrFull = 4 * Math.max(0.05, 2 * fc); // neighbour food (sum of 4) that gives full spreading
  const bareSpan = BARE_FRACTION - BARE_FULL;
  const lushSpan = LUSH_FULL - LUSH_FRACTION;
  let phase = Math.floor(s.tick) % dt;
  if (!(phase >= 0)) phase = 0;

  for (let y = phase; y < H; y += dt) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const t = terr[i];
      const maxFood = MAX_FOOD[t];
      let f = food[i];
      if (!(f > 0)) f = 0; // NaN / negative repair
      let fe = fert[i];
      if (!(fe >= FERTILITY_MIN)) fe = fe < FERTILITY_MIN ? FERTILITY_MIN : base ? num(base[i], FERTILITY_MIN, FERTILITY_MAX, 0.5) : 0.5;
      else if (fe > FERTILITY_MAX) fe = FERTILITY_MAX;
      const cap = maxFood * fe * fc;
      if (!(cap > 0)) {
        // barren terrain (deep water, walls) holds nothing
        food[i] = 0;
        continue;
      }
      let c = cm ? cm[i] : 1;
      if (!(c >= 0)) c = c < 0 ? 0 : 1;
      else if (c > 20) c = 20;
      const mod = growth * REGEN[t] * c;

      if (f < cap) {
        let nb = 0;
        if (x > 0) nb += food[i - 1];
        if (x < W - 1) nb += food[i + 1];
        if (y > 0) nb += food[i - W];
        if (y < H - 1) nb += food[i + W];
        let nr = nb / nbrFull;
        if (!(nr > 0)) nr = 0;
        else if (nr > 1) nr = 1;
        f += dt * mod * (REGROWTH_RATE * f + SEED_RAIN * fe * (1 + SEED_SPREAD * nr)) * (1 - f / cap);
        if (f > cap) f = cap;
      } else if (f > cap) {
        f = cap + (f - cap) * OVERFILL_KEEP;
      }

      // soil: erosion when grazed bare, recovery under lush cover
      const q = f / cap;
      if (q < BARE_FRACTION) {
        if (overgrazing) {
          const bare = q <= BARE_FULL ? 1 : (BARE_FRACTION - q) / bareSpan;
          fe -= (fe - FERTILITY_MIN) * FERTILITY_DECAY * dt * bare;
        }
      } else if (q > LUSH_FRACTION) {
        const lush = q >= LUSH_FULL ? 1 : (q - LUSH_FRACTION) / lushSpan;
        const target = base ? num(base[i], FERTILITY_MIN, FERTILITY_MAX, fe) : fe;
        const rate = mod < 2 ? mod : 2;
        fe += (target - fe) * FERTILITY_RECOVERY * dt * lush * rate;
      }
      if (fe < FERTILITY_MIN) fe = FERTILITY_MIN;
      else if (fe > FERTILITY_MAX) fe = FERTILITY_MAX;
      const ceiling = maxFood * fe * fc * MAX_OVERFILL;
      if (f > ceiling) f = ceiling;
      fert[i] = fe;
      food[i] = f;
    }
  }
}

/** Max food a tile can currently hold (terrain maxFood × fertility × config.foodCapacity). */
export function tileCapacity(sim: Simulation, idx: number): number {
  const w = sim.state.world;
  if (!(idx >= 0 && idx < w.terrain.length)) return 0;
  const c = MAX_FOOD[w.terrain[idx]] * w.fertility[idx] * sim.state.config.foodCapacity;
  return c > 0 ? c : 0;
}

/** Food at a world position (0 outside map). */
export function foodAt(sim: Simulation, x: number, y: number): number {
  const i = sim.tileIndex(x, y);
  if (!(i >= 0)) return 0;
  const f = sim.state.world.food[i];
  return f > 0 ? f : 0;
}

/**
 * Remove up to `amount` food from the tile at (x,y). Returns the amount actually
 * removed (never negative, never more than present; exactly the decrease of the stored
 * value, so food is conserved). Overgrazing effects follow from the tile staying bare
 * (see updateResources).
 */
export function consumeFood(sim: Simulation, x: number, y: number, amount: number): number {
  if (!(amount > 0)) return 0;
  const i = sim.tileIndex(x, y);
  if (!(i >= 0)) return 0;
  const f = sim.state.world.food;
  const have = f[i];
  if (!(have > 0)) {
    f[i] = 0;
    return 0;
  }
  if (amount >= have) {
    f[i] = 0;
    return have;
  }
  f[i] = have - amount; // stored as float32
  return have - f[i];
}

export interface FoodSpot { x: number; y: number; food: number; }

/** Score of tile (tx,ty) for findFood, or -1 when out of range / unusable. */
function forageScore(sim: Simulation, tx: number, ty: number, x: number, y: number, r2: number, inv: number): number {
  const w = sim.state.world;
  if (tx < 0 || ty < 0 || tx >= w.width || ty >= w.height) return -1;
  const ts = w.tileSize;
  const dx = (tx + 0.5) * ts - x;
  const dy = (ty + 0.5) * ts - y;
  const d2 = dx * dx + dy * dy;
  if (d2 > r2) return -1;
  const idx = ty * w.width + tx;
  const f = w.food[idx];
  if (!(f >= MIN_FORAGE_FOOD) || !PASSABLE[w.terrain[idx]]) return -1;
  return f / (1 + Math.sqrt(d2) * inv);
}

/**
 * Best food tile visible from (x,y) within `radius` (world units), scoring
 * food / (1 + dist / (radius/2)) and ignoring tiles with < MIN_FORAGE_FOOD food or that are
 * impassable. Radii up to ≈ 6.9 tiles scan every tile; larger radii sample a lattice with a
 * fractional stride (≈ 150 reads) and then refine around the best hit. Deterministic.
 * Returns world-centre coords of the tile, or null.
 */
export function findFood(sim: Simulation, x: number, y: number, radius: number): FoodSpot | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const w = sim.state.world;
  const ts = w.tileSize;
  const W = w.width;
  const H = w.height;
  const food = w.food;
  const terr = w.terrain;
  let r = Number.isFinite(radius) ? radius : ts;
  if (r < ts) r = ts;
  const maxR = (W + H) * ts;
  if (r > maxR) r = maxR;
  const rt = r / ts;
  const step = rt > FIND_FULL_RES ? rt / FIND_FULL_RES : 1;
  const k = Math.min(15, Math.ceil(rt / step));
  const span = 2 * k;
  for (let j = 0; j <= span; j++) {
    const o = j - k;
    OFFS[j] = o < 0 ? -Math.round(-o * step) : Math.round(o * step);
  }
  const cx = Math.floor(x / ts);
  const cy = Math.floor(y / ts);
  const r2 = r * r;
  const inv = 2 / r;
  let best = 0;
  let bestIdx = -1;
  for (let a = 0; a <= span; a++) {
    const ty = cy + OFFS[a];
    if (ty < 0 || ty >= H) continue;
    const dy = (ty + 0.5) * ts - y;
    const dy2 = dy * dy;
    if (dy2 > r2) continue;
    const row = ty * W;
    for (let b = 0; b <= span; b++) {
      const tx = cx + OFFS[b];
      if (tx < 0 || tx >= W) continue;
      const dx = (tx + 0.5) * ts - x;
      const d2 = dx * dx + dy2;
      if (d2 > r2) continue;
      const idx = row + tx;
      const f = food[idx];
      if (!(f >= MIN_FORAGE_FOOD) || !PASSABLE[terr[idx]]) continue;
      const score = f / (1 + Math.sqrt(d2) * inv);
      if (score > best) {
        best = score;
        bestIdx = idx;
      }
    }
  }
  if (bestIdx < 0) return null;
  if (step > 1) {
    // the lattice skips tiles: check the best hit's immediate neighbours too
    const bx = bestIdx % W;
    const by = (bestIdx - bx) / W;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const sc = forageScore(sim, bx + ox, by + oy, x, y, r2, inv);
        if (sc > best) {
          best = sc;
          bestIdx = (by + oy) * W + bx + ox;
        }
      }
    }
  }
  const bx = bestIdx % W;
  const by = (bestIdx - bx) / W;
  return { x: (bx + 0.5) * ts, y: (by + 0.5) * ts, food: food[bestIdx] };
}

// ------------------------------------------------------------------ aggregates

/** Total standing food on the map. */
export function totalFood(sim: Simulation): number {
  const f = sim.state.world.food;
  let sum = 0;
  for (let i = 0; i < f.length; i++) {
    const v = f[i];
    if (v > 0) sum += v;
  }
  return sum;
}

/** Mean soil fertility over tiles whose terrain can hold food (excludes deep water / walls). */
export function averageFertility(sim: Simulation): number {
  const w = sim.state.world;
  const t = w.terrain;
  const fe = w.fertility;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < t.length; i++) {
    if (MAX_FOOD[t[i]] <= 0) continue;
    const v = fe[i];
    if (v > 0) sum += v;
    count++;
  }
  return count ? sum / count : 0;
}

/**
 * Rough number of agents the land could feed indefinitely under current conditions:
 * Σ_tiles logistic maximum sustainable yield (REGROWTH_RATE·mods·cap/4, i.e. harvesting each
 * tile at half capacity; seed rain ignored) ÷ AGENT_FOOD_PER_TICK (0.09 food/tick/agent).
 * Uses current fertility, climateMod and seasonGrowth (or the year-round mean seasonal growth
 * when `annualAverage`). An upper bound — real foragers don't graze optimally. Rounded.
 */
export function estimateCarryingCapacity(sim: Simulation, annualAverage = false): number {
  const s = sim.state;
  const w = s.world;
  const cfg = s.config;
  const terr = w.terrain;
  const fert = w.fertility;
  const cm = w.climateMod && w.climateMod.length === terr.length ? w.climateMod : null;
  let sum = 0;
  for (let i = 0; i < terr.length; i++) {
    const t = terr[i];
    const mf = MAX_FOOD[t];
    if (mf <= 0) continue;
    const fe = num(fert[i], 0, FERTILITY_MAX, 0);
    let c = cm ? cm[i] : 1;
    if (!(c >= 0)) c = c < 0 ? 0 : 1;
    else if (c > 20) c = 20;
    sum += REGEN[t] * mf * fe * c;
  }
  const season = annualAverage ? (cfg.seasons ? MEAN_SEASON_GROWTH : 1) : num(s.env.seasonGrowth, 0, 100, 1);
  const yieldPerTick =
    (REGROWTH_RATE * num(cfg.foodRegen, 0, 1000, 1) * season * num(cfg.foodCapacity, 0, 1000, 1) * sum) / 4;
  return Math.round(yieldPerTick / AGENT_FOOD_PER_TICK);
}
