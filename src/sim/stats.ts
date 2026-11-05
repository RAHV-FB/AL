/**
 * Statistics sampling (OWNER: Analytics).
 *
 * Simulation code: deterministic, no DOM, no wall clock, never touches sim.rng.
 * Every `sampleInterval` ticks a StatsSample is built from the living agents and
 * the world arrays; flow counters (births, deaths, fights, shares) are moved into
 * the sample and reset. Peak population is tracked every tick. Notable changes
 * (population milestones, crashes, extinction, gene-mean drift, generation
 * records) are written to the event log.
 *
 * History is bounded by LIMITS.statSamples: when full, the oldest half is merged
 * pairwise (flows summed, snapshots averaged by time span, later tick kept), so
 * recent history stays at full resolution while old history coarsens gradually.
 */
import type { Simulation } from './simulation';
import { LIMITS, TERRAIN_INFO } from './constants';
import {
  DEATH_CAUSES,
  GENE_COUNT,
  GENES,
  HIST_BINS,
  NONE,
  TERRAIN_COUNT,
  type ActionKind,
  type DeathCause,
  type Role,
  type StatsSample,
  type StatsState,
  type TerrainType,
  type TribeId,
} from './types';

export const ROLES: Role[] = ['none', 'forager', 'warrior', 'caretaker', 'explorer'];

/** Population thresholds announced the first time the all-time peak crosses them. */
export const POP_MILESTONES = [100, 250, 500, 750, 1000, 1500, 2000];
/** Max-generation records announced when first reached. */
export const GENERATION_MILESTONES = [5, 10, 25, 50, 100, 200, 500];

const CRASH_WINDOW = 10; // samples
const CRASH_DROP = 0.4; // fraction lost
const CRASH_MIN_POP = 20; // ignore tiny populations
const DRIFT_LOOKBACK = 20; // samples
const DRIFT_THRESHOLD = 0.15; // absolute change of a gene mean (0..1 units)
const DRIFT_MIN_POP = 8;
const SMALL_POP = 40; // below this, drift is attributed to chance rather than selection

/** Terrain types that can grow food (fertility is averaged over these only). */
const FOOD_TERRAIN = new Uint8Array(TERRAIN_COUNT);
for (let t = 0; t < TERRAIN_COUNT; t++) FOOD_TERRAIN[t] = (TERRAIN_INFO[t as TerrainType]?.maxFood ?? 0) > 0 ? 1 : 0;

export function emptyCauses(): Record<DeathCause, number> {
  return { starvation: 0, old_age: 0, combat: 0, disease: 0, disaster: 0, removed: 0 };
}

export function emptyRoles(): Record<Role, number> {
  return { none: 0, forager: 0, warrior: 0, caretaker: 0, explorer: 0 };
}

export function createStatsState(): StatsState {
  return {
    sampleInterval: 30,
    samples: [],
    counters: { births: 0, deaths: 0, deathsByCause: emptyCauses(), fights: 0, shares: 0 },
    totals: { births: 0, deaths: 0, peakPopulation: 0, peakTick: 0 },
  };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0); // NaN → 0

/** Called once per tick (after births/deaths are flushed). */
export function updateStats(sim: Simulation): void {
  const s = sim.state;
  const st = s.stats;
  const pop = s.agents.length;

  // Peak population + milestones (checked every tick; cheap).
  const prevPeak = st.totals.peakPopulation;
  if (pop > prevPeak) {
    st.totals.peakPopulation = pop;
    st.totals.peakTick = s.tick;
    // prevPeak === 0 means this is the initial population, not growth.
    if (prevPeak > 0) {
      for (const m of POP_MILESTONES) {
        if (prevPeak < m && pop >= m) {
          sim.log('population', 'good', `Population milestone: ${m} living agents — a new all-time high.`);
        }
      }
    }
  }

  const interval = Math.max(1, Math.floor(st.sampleInterval) || 30);
  if (s.tick % interval !== 0) return;

  const sample = takeSample(sim);
  resetCounters(st);
  detectEvents(sim, st.samples, sample);
  st.samples.push(sample);
  if (st.samples.length > LIMITS.statSamples) compactSamples(st.samples, LIMITS.statSamples);
}

function resetCounters(st: StatsState): void {
  const c = st.counters;
  c.births = 0;
  c.deaths = 0;
  c.fights = 0;
  c.shares = 0;
  for (const k of DEATH_CAUSES) c.deathsByCause[k] = 0;
}

/** Build a snapshot of the current state (pure read; consumes the flow counters' values but does not reset them). */
export function takeSample(sim: Simulation): StatsSample {
  const s = sim.state;
  const c = s.stats.counters;
  const geneSum = new Float64Array(GENE_COUNT);
  const geneSq = new Float64Array(GENE_COUNT);
  const hist: number[] = new Array<number>(GENE_COUNT * HIST_BINS).fill(0);
  const roles = emptyRoles();
  const actions: Partial<Record<ActionKind, number>> = {};
  const tribeCounts = new Map<TribeId, number>();
  let n = 0;
  let hSum = 0;
  let eSum = 0;
  let hungerSum = 0;
  let ageSum = 0;
  let infected = 0;
  let genSum = 0;
  let genMax = 0;

  for (const a of s.agents) {
    if (!a.alive) continue;
    n++;
    const tr = a.traits;
    hSum += clamp01(a.health / (tr.maxHealth > 0 ? tr.maxHealth : 1));
    eSum += clamp01(a.energy);
    hungerSum += clamp01(1 - a.food / (tr.maxFood > 0 ? tr.maxFood : 1));
    ageSum += a.age > 0 ? a.age : 0;
    if (a.infection > 0) infected++;
    genSum += a.generation;
    if (a.generation > genMax) genMax = a.generation;
    const g = a.genes;
    for (let i = 0; i < GENE_COUNT; i++) {
      const v = clamp01(g[i]);
      geneSum[i] += v;
      geneSq[i] += v * v;
      let b = Math.floor(v * HIST_BINS);
      if (b >= HIST_BINS) b = HIST_BINS - 1;
      hist[i * HIST_BINS + b]++;
    }
    roles[a.role] = (roles[a.role] ?? 0) + 1;
    actions[a.action] = (actions[a.action] ?? 0) + 1;
    if (a.tribeId !== NONE) tribeCounts.set(a.tribeId, (tribeCounts.get(a.tribeId) ?? 0) + 1);
  }

  const geneMeans: number[] = new Array<number>(GENE_COUNT);
  const geneStd: number[] = new Array<number>(GENE_COUNT);
  for (let i = 0; i < GENE_COUNT; i++) {
    const m = n ? geneSum[i] / n : 0;
    geneMeans[i] = r4(m);
    geneStd[i] = r4(n ? Math.sqrt(Math.max(0, geneSq[i] / n - m * m)) : 0);
  }

  // World resources.
  const w = s.world;
  let totalFood = 0;
  let fert = 0;
  let land = 0;
  const food = w.food;
  const terrain = w.terrain;
  const fertility = w.fertility;
  for (let i = 0; i < food.length; i++) {
    const f = food[i];
    if (f > 0) totalFood += f;
    if (FOOD_TERRAIN[terrain[i]]) {
      fert += fertility[i];
      land++;
    }
  }

  const tribePops = [...tribeCounts.entries()].sort((x, y) => x[0] - y[0]);
  const deathsByCause = emptyCauses();
  for (const k of DEATH_CAUSES) deathsByCause[k] = c.deathsByCause[k] ?? 0;

  return {
    tick: s.tick,
    population: n,
    births: c.births,
    deaths: c.deaths,
    deathsByCause,
    avgHealth: r4(n ? hSum / n : 0),
    avgEnergy: r4(n ? eSum / n : 0),
    avgHunger: r4(n ? hungerSum / n : 0),
    avgAge: r1(n ? ageSum / n : 0),
    totalFood: r1(totalFood),
    avgFertility: r4(land ? fert / land : 0),
    infected,
    tribeCount: tribePops.length,
    meanGeneration: r2(n ? genSum / n : 0),
    maxGeneration: genMax,
    geneMeans,
    geneStd,
    geneHist: hist,
    tribePops,
    roles,
    actions,
    fights: c.fights,
    shares: c.shares,
  };
}

// ------------------------------------------------------------------ events

function detectEvents(sim: Simulation, prev: StatsSample[], cur: StatsSample): void {
  const n = prev.length;
  if (n === 0) return;
  const last = prev[n - 1];
  const dayLength = Math.max(1, sim.config.dayLength || 600);

  // Extinction.
  if (cur.population === 0) {
    if (last.population > 0) {
      sim.log('population', 'major', 'Extinction: the last living agent has died. Spawn new life to begin again.');
    }
    return;
  }

  // Population crash (edge-triggered, with a cooldown of one window).
  const popAt = (i: number) => (i === n ? cur.population : prev[i].population);
  const crashAt = (i: number): number => {
    // returns the window max when sample i is a crash, else 0
    if (i < 1) return 0;
    let mx = 0;
    for (let j = Math.max(0, i - CRASH_WINDOW); j < i; j++) if (popAt(j) > mx) mx = popAt(j);
    return mx >= CRASH_MIN_POP && popAt(i) < (1 - CRASH_DROP) * mx ? mx : 0;
  };
  const crashMax = crashAt(n);
  if (crashMax > 0) {
    let recent = false;
    for (let j = Math.max(1, n - CRASH_WINDOW); j < n && !recent; j++) if (crashAt(j) > 0) recent = true;
    if (!recent) {
      const causes = emptyCauses();
      for (let j = Math.max(0, n - CRASH_WINDOW); j <= n; j++) {
        const sm = j === n ? cur : prev[j];
        for (const k of DEATH_CAUSES) causes[k] += sm.deathsByCause[k] ?? 0;
      }
      let top: DeathCause | null = null;
      for (const k of DEATH_CAUSES) if (causes[k] > 0 && (top === null || causes[k] > causes[top])) top = k;
      const pct = Math.round((1 - cur.population / crashMax) * 100);
      const why = top ? ` Most deaths: ${CAUSE_LABEL[top]}.` : '';
      sim.log('population', pct >= 70 ? 'major' : 'bad', `Population crash: ${crashMax} → ${cur.population} (−${pct}%).${why}`);
    }
  }

  // Generation records.
  for (const m of GENERATION_MILESTONES) {
    if (last.maxGeneration < m && cur.maxGeneration >= m) {
      sim.log('record', 'good', `Generation ${m} reached — ${m} generations of descent since the founders.`);
    }
  }

  // Gene-mean drift.
  if (n < DRIFT_LOOKBACK) return;
  const driftAt = (i: number, g: number): number => {
    // signed drift of gene g at sample i vs DRIFT_LOOKBACK samples earlier (0 if not significant)
    const j = i - DRIFT_LOOKBACK;
    if (j < 0) return 0;
    const a = prev[j];
    const b = i === n ? cur : prev[i];
    if (a.population < DRIFT_MIN_POP || b.population < DRIFT_MIN_POP) return 0;
    const d = (b.geneMeans[g] ?? 0) - (a.geneMeans[g] ?? 0);
    return Math.abs(d) >= DRIFT_THRESHOLD ? d : 0;
  };
  for (let g = 0; g < GENE_COUNT; g++) {
    const d = driftAt(n, g);
    if (d === 0) continue;
    let recent = false;
    for (let i = n - 1; i > n - DRIFT_LOOKBACK && !recent; i--) if (driftAt(i, g) !== 0) recent = true;
    if (recent) continue;
    const old = prev[n - DRIFT_LOOKBACK];
    const from = old.geneMeans[g];
    const to = cur.geneMeans[g];
    const pct = Math.round((Math.abs(d) / Math.max(0.05, from)) * 100);
    const days = (cur.tick - old.tick) / dayLength;
    const gene = GENES[g];
    const why =
      gene === 'hue'
        ? 'neutral drift of lineage colours'
        : cur.population < SMALL_POP
          ? 'genetic drift in a small population'
          : 'selection at work';
    sim.log(
      'evolution',
      'info',
      `Average ${gene} has ${d > 0 ? 'risen' : 'fallen'} ${pct}% in ${days < 1 ? days.toFixed(1) : Math.round(days)} day${days === 1 ? '' : 's'} (${from.toFixed(2)} → ${to.toFixed(2)}) — ${why}.`,
    );
  }
}

const CAUSE_LABEL: Record<DeathCause, string> = {
  starvation: 'starvation',
  old_age: 'old age',
  combat: 'combat',
  disease: 'disease',
  disaster: 'disasters',
  removed: 'divine intervention',
};

// ------------------------------------------------------------------ compaction

/** Keep `samples.length <= cap` by merging the oldest half pairwise (in place). */
export function compactSamples(samples: StatsSample[], cap: number): void {
  const limit = Math.max(2, Math.floor(cap));
  while (samples.length > limit) {
    let k = Math.floor(limit / 2);
    if (k % 2) k--;
    if (k < 2) k = 2;
    if (k > samples.length) k = samples.length - (samples.length % 2);
    const merged: StatsSample[] = [];
    for (let i = 0; i + 1 < k; i += 2) {
      const a = samples[i];
      const b = samples[i + 1];
      const wb = b.tick - a.tick;
      const wa = i > 0 ? a.tick - samples[i - 1].tick : wb;
      merged.push(mergeSamples(a, b, wa, wb));
    }
    samples.splice(0, k, ...merged);
  }
}

/** Merge two consecutive samples: flows summed, snapshots averaged (weighted by time span), later tick kept. */
export function mergeSamples(a: StatsSample, b: StatsSample, wa = 1, wb = 1): StatsSample {
  const tw = wa + wb;
  const fa = tw > 0 && wa >= 0 && wb >= 0 ? wa / tw : 0.5;
  const fb = 1 - fa;
  const avg = (x: number, y: number) => (x ?? 0) * fa + (y ?? 0) * fb;
  const deathsByCause = emptyCauses();
  for (const k of DEATH_CAUSES) deathsByCause[k] = (a.deathsByCause[k] ?? 0) + (b.deathsByCause[k] ?? 0);
  const roles = emptyRoles();
  for (const k of ROLES) roles[k] = r2(avg(a.roles[k] ?? 0, b.roles[k] ?? 0));
  const actions: Partial<Record<ActionKind, number>> = {};
  for (const k of Object.keys(a.actions) as ActionKind[]) actions[k] = 0;
  for (const k of Object.keys(b.actions) as ActionKind[]) actions[k] = 0;
  for (const k of Object.keys(actions) as ActionKind[]) actions[k] = r2(avg(a.actions[k] ?? 0, b.actions[k] ?? 0));
  const tp = new Map<TribeId, [number, number]>();
  for (const [id, m] of a.tribePops) tp.set(id, [m, 0]);
  for (const [id, m] of b.tribePops) {
    const e = tp.get(id);
    if (e) e[1] = m;
    else tp.set(id, [0, m]);
  }
  const tribePops: [TribeId, number][] = [...tp.entries()]
    .map(([id, [x, y]]) => [id, r2(avg(x, y))] as [TribeId, number])
    .filter((e) => e[1] > 0)
    .sort((x, y) => x[0] - y[0]);
  const mapArr = (x: number[], y: number[], round: (v: number) => number) => {
    const len = Math.max(x.length, y.length);
    const out = new Array<number>(len);
    for (let i = 0; i < len; i++) out[i] = round(avg(x[i] ?? 0, y[i] ?? 0));
    return out;
  };
  return {
    tick: b.tick,
    population: r2(avg(a.population, b.population)),
    births: a.births + b.births,
    deaths: a.deaths + b.deaths,
    deathsByCause,
    avgHealth: r4(avg(a.avgHealth, b.avgHealth)),
    avgEnergy: r4(avg(a.avgEnergy, b.avgEnergy)),
    avgHunger: r4(avg(a.avgHunger, b.avgHunger)),
    avgAge: r1(avg(a.avgAge, b.avgAge)),
    totalFood: r1(avg(a.totalFood, b.totalFood)),
    avgFertility: r4(avg(a.avgFertility, b.avgFertility)),
    infected: r2(avg(a.infected, b.infected)),
    tribeCount: r2(avg(a.tribeCount, b.tribeCount)),
    meanGeneration: r2(avg(a.meanGeneration, b.meanGeneration)),
    maxGeneration: Math.max(a.maxGeneration, b.maxGeneration),
    geneMeans: mapArr(a.geneMeans, b.geneMeans, r4),
    geneStd: mapArr(a.geneStd, b.geneStd, r4),
    geneHist: mapArr(a.geneHist, b.geneHist, r2),
    tribePops,
    roles,
    actions,
    fights: a.fights + b.fights,
    shares: a.shares + b.shares,
  };
}

// ------------------------------------------------------------------ summaries

export interface StatsSummary {
  tick: number;
  day: number;
  population: number;
  peakPopulation: number;
  peakTick: number;
  totalBirths: number;
  totalDeaths: number;
  /** Births / deaths per day over (up to) the last day. */
  birthsPerDay: number;
  deathsPerDay: number;
  infected: number;
  tribes: number;
  /** 0..1 fraction of max health. */
  avgHealth: number;
  meanGeneration: number;
  maxGeneration: number;
  /** Latest sampled total food (world). */
  totalFood: number;
}

/** Live headline numbers (one pass over agents + the last day of samples). Read-only. */
export function currentSummary(sim: Simulation): StatsSummary {
  const s = sim.state;
  const st = s.stats;
  const dayLength = Math.max(1, s.config.dayLength || 600);
  let n = 0;
  let infected = 0;
  let hSum = 0;
  let genSum = 0;
  let genMax = 0;
  const tribes = new Set<TribeId>();
  for (const a of s.agents) {
    if (!a.alive) continue;
    n++;
    if (a.infection > 0) infected++;
    hSum += clamp01(a.health / (a.traits.maxHealth > 0 ? a.traits.maxHealth : 1));
    genSum += a.generation;
    if (a.generation > genMax) genMax = a.generation;
    if (a.tribeId !== NONE) tribes.add(a.tribeId);
  }
  const rates = recentRates(sim, dayLength);
  const samples = st.samples;
  return {
    tick: s.tick,
    day: s.tick / dayLength,
    population: n,
    peakPopulation: Math.max(st.totals.peakPopulation, n),
    peakTick: st.totals.peakTick,
    totalBirths: st.totals.births,
    totalDeaths: st.totals.deaths,
    birthsPerDay: rates.births,
    deathsPerDay: rates.deaths,
    infected,
    tribes: tribes.size,
    avgHealth: n ? hSum / n : 0,
    meanGeneration: n ? genSum / n : 0,
    maxGeneration: genMax,
    totalFood: samples.length ? samples[samples.length - 1].totalFood : 0,
  };
}

/** Births/deaths per day over the trailing `window` ticks (samples + live counters). */
export function recentRates(sim: Simulation, window: number): { births: number; deaths: number } {
  const s = sim.state;
  const st = s.stats;
  const now = s.tick;
  const dayLength = Math.max(1, s.config.dayLength || 600);
  const samples = st.samples;
  let births = st.counters.births;
  let deaths = st.counters.deaths;
  let from = samples.length ? samples[samples.length - 1].tick : 0;
  const cutoff = now - window;
  for (let i = samples.length - 1; i >= 0; i--) {
    const sm = samples[i];
    if (sm.tick <= cutoff) break;
    births += sm.births;
    deaths += sm.deaths;
    from = i > 0 ? samples[i - 1].tick : Math.max(0, sm.tick - st.sampleInterval);
  }
  const span = Math.max(1, now - from);
  return { births: (births / span) * dayLength, deaths: (deaths / span) * dayLength };
}
