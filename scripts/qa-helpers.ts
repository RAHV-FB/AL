/**
 * QA helpers shared by tests/invariants, tests/longrun, tests/determinism,
 * tests/perf.bench and tests/balance.report (QA-owned).
 *
 * Pure functions over a Simulation — no Node APIs here, because tsconfig uses
 * `"types": []` and `npm run build` typechecks tests/ and scripts/ too.
 */
import type { Simulation } from '../src/sim/simulation';
import { LIMITS } from '../src/sim/constants';
import { GENE_COUNT, TERRAIN, TERRAIN_COUNT, type Intervention } from '../src/sim/types';

/** Float tolerance for range checks (values are clamped in float64 but stored in some float32 arrays). */
export const EPS = 1e-6;

// ------------------------------------------------------------------ env access (no @types/node)

type NodeLikeProcess = {
  env?: Record<string, string | undefined>;
  memoryUsage?: () => { heapUsed: number; rss: number };
};

export function nodeProcess(): NodeLikeProcess | undefined {
  return (globalThis as unknown as { process?: NodeLikeProcess }).process;
}

/** Integer from an environment variable, or `fallback`. */
export function envInt(name: string, fallback: number): number {
  const raw = nodeProcess()?.env?.[name];
  const v = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(v) ? Math.floor(v) : fallback;
}

export function envStr(name: string): string | undefined {
  return nodeProcess()?.env?.[name];
}

export function heapUsedMB(): number | null {
  const mu = nodeProcess()?.memoryUsage;
  return mu ? mu().heapUsed / (1024 * 1024) : null;
}

// ------------------------------------------------------------------ invariants

export interface InvariantOptions {
  /** Tick of the most recent terrain-painting intervention (newly impassable tiles get a grace period). */
  lastTerrainEditTick?: number;
  /** Ticks an agent may remain on an impassable tile after a terrain edit (default 60). */
  terrainGrace?: number;
  /** id → last tick the caller observed the agent alive (maintained across checkpoints, see trackAlive). */
  lastSeenAlive?: Map<number, number>;
  /**
   * Max ticks a relationship may keep pointing at a dead agent before it must be pruned.
   * Default: one in-game day (config.dayLength) — far longer than any sane social update period.
   */
  relationGrace?: number;
  /** Interval between checks (added to relationGrace because death time is only known to ±interval). */
  checkInterval?: number;
  /** Stop collecting after this many violations (default 25). */
  maxViolations?: number;
}

/** Record which agents are alive right now (call at every checkpoint before checkInvariants). */
export function trackAlive(sim: Simulation, lastSeenAlive: Map<number, number>): void {
  for (const a of sim.state.agents) lastSeenAlive.set(a.id, sim.state.tick);
}

const isNum = (x: unknown): x is number => typeof x === 'number';
const fin = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x);

/**
 * Check every structural/numeric invariant of a Simulation *between ticks*
 * (i.e. after flush). Returns human-readable violations (empty = OK).
 */
export function checkInvariants(sim: Simulation, opts: InvariantOptions = {}): string[] {
  const s = sim.state;
  const out: string[] = [];
  const max = opts.maxViolations ?? 25;
  const bad = (msg: string): void => {
    if (out.length < max) out.push(`[tick ${s.tick}] ${msg}`);
  };
  const cfg = s.config;
  const relationGrace = (opts.relationGrace ?? cfg.dayLength) + (opts.checkInterval ?? 0);
  const terrainGrace = opts.terrainGrace ?? 60;

  // ---------------- tribes (index first; agents reference them)
  const tribeIds = new Set<number>();
  let livingTribes = 0;
  for (const t of s.tribes) {
    const tag = `tribe#${t.id} "${t.name}"`;
    if (tribeIds.has(t.id)) bad(`${tag}: duplicate tribe id`);
    tribeIds.add(t.id);
    if (sim.tribeById.get(t.id) !== t) bad(`${tag}: tribeById does not map to this tribe object`);
    if (t.extinctTick === -1) livingTribes++;
    if (!fin(t.stockpile) || t.stockpile < -EPS) bad(`${tag}: stockpile ${t.stockpile} (must be finite and >= 0)`);
    if (!fin(t.members) || t.members < 0) bad(`${tag}: members ${t.members}`);
    if (!fin(t.homeX) || !fin(t.homeY) || t.homeX < 0 || t.homeY < 0 || t.homeX > sim.worldW || t.homeY > sim.worldH)
      bad(`${tag}: home (${t.homeX}, ${t.homeY}) outside world ${sim.worldW}x${sim.worldH}`);
    if (!fin(t.territory) || t.territory < 0) bad(`${tag}: territory ${t.territory}`);
    for (const [k, v] of Object.entries(t.relations)) {
      if (!fin(v) || v < -1 - EPS || v > 1 + EPS) bad(`${tag}: relation to tribe ${k} = ${v} (must be in [-1,1])`);
    }
    for (const g of t.meanGenes) if (!fin(g)) { bad(`${tag}: meanGenes contains ${g}`); break; }
  }
  if (sim.tribeById.size !== s.tribes.length) bad(`tribeById.size ${sim.tribeById.size} != state.tribes.length ${s.tribes.length}`);
  if (s.tribes.length > LIMITS.tribesKept + livingTribes)
    bad(`state.tribes has ${s.tribes.length} entries (${livingTribes} living) — extinct tribes are not being capped at ${LIMITS.tribesKept}`);

  // ---------------- agents
  const ids = new Set<number>();
  for (const a of s.agents) {
    const tag = `agent#${a.id} "${a.name}"`;
    if (ids.has(a.id)) bad(`${tag}: duplicate agent id`);
    ids.add(a.id);
  }
  for (const a of s.agents) {
    const tag = `agent#${a.id} "${a.name}"`;
    if (!a.alive) bad(`${tag}: dead agent still in state.agents after flush`);
    if (a.deathTick !== -1 || a.deathCause !== null) bad(`${tag}: living agent has deathTick ${a.deathTick} / deathCause ${a.deathCause}`);
    if (sim.agentById.get(a.id) !== a) bad(`${tag}: agentById does not map to this agent object`);
    if (!sim.lineageById.has(a.id)) bad(`${tag}: no lineage record for a living agent`);

    for (const k of ['x', 'y', 'vx', 'vy', 'heading', 'age', 'health', 'food', 'energy', 'carried', 'actionTicks',
      'decisionCooldown', 'reproCooldown', 'offspring', 'infection', 'virulence', 'immuneTicks', 'generation', 'birthTick'] as const) {
      if (!fin(a[k])) bad(`${tag}: ${k} is not finite (${a[k]})`);
    }
    // targets: NaN means "no target"; Infinity is never valid
    if (isNum(a.targetX) && !Number.isNaN(a.targetX) && !Number.isFinite(a.targetX)) bad(`${tag}: targetX ${a.targetX}`);
    if (isNum(a.targetY) && !Number.isNaN(a.targetY) && !Number.isFinite(a.targetY)) bad(`${tag}: targetY ${a.targetY}`);
    for (const [k, v] of Object.entries(a.traits)) if (!fin(v)) bad(`${tag}: traits.${k} = ${v}`);
    if (a.genes.length !== GENE_COUNT) bad(`${tag}: genes.length ${a.genes.length} != ${GENE_COUNT}`);
    for (let i = 0; i < a.genes.length; i++) {
      const g = a.genes[i];
      if (!fin(g) || g < -EPS || g > 1 + EPS) { bad(`${tag}: gene[${i}] = ${g} (must be in [0,1])`); break; }
    }
    for (const [k, v] of Object.entries(a.utilities)) if (Number.isNaN(v)) bad(`${tag}: utilities.${k} is NaN`);

    // vitals
    if (a.health < -EPS || a.health > a.traits.maxHealth + EPS) bad(`${tag}: health ${a.health} outside [0, maxHealth=${a.traits.maxHealth}]`);
    if (a.food < -EPS || a.food > a.traits.maxFood + EPS) bad(`${tag}: food ${a.food} outside [0, maxFood=${a.traits.maxFood}]`);
    if (a.energy < -EPS || a.energy > 1 + EPS) bad(`${tag}: energy ${a.energy} outside [0,1]`);
    if (a.carried < -EPS) bad(`${tag}: carried ${a.carried} < 0`);
    if (a.age < 0) bad(`${tag}: negative age ${a.age}`);
    if (a.infection < 0 || a.immuneTicks < 0) bad(`${tag}: infection ${a.infection} / immuneTicks ${a.immuneTicks} negative`);
    if (a.virulence < -EPS || a.virulence > 1 + EPS) bad(`${tag}: virulence ${a.virulence} outside [0,1]`);
    if (a.fear !== undefined && (!fin(a.fear) || a.fear < -EPS || a.fear > 1 + EPS)) bad(`${tag}: fear ${a.fear} outside [0,1]`);
    if (a.sinceMeal !== undefined && (!fin(a.sinceMeal) || a.sinceMeal < 0)) bad(`${tag}: sinceMeal ${a.sinceMeal}`);
    for (const [k, v] of Object.entries(a.skills)) if (!fin(v) || v < -EPS || v > 1 + EPS) bad(`${tag}: skills.${k} = ${v} outside [0,1]`);
    for (const [k, v] of Object.entries(a.stats)) if (!fin(v) || v < -EPS) bad(`${tag}: stats.${k} = ${v}`);

    // position
    if (a.x < 0 || a.y < 0 || a.x > sim.worldW || a.y > sim.worldH) bad(`${tag}: position (${a.x.toFixed(1)}, ${a.y.toFixed(1)}) outside world ${sim.worldW}x${sim.worldH}`);
    else if (!sim.passableAt(a.x, a.y)) {
      const sinceEdit = opts.lastTerrainEditTick === undefined ? Infinity : s.tick - opts.lastTerrainEditTick;
      if (sinceEdit > terrainGrace)
        bad(`${tag}: standing on impassable terrain ${sim.terrainAt(a.x, a.y)} at (${a.x.toFixed(1)}, ${a.y.toFixed(1)})`);
    }

    // tribe reference
    if (a.tribeId !== -1) {
      const t = sim.tribeById.get(a.tribeId);
      if (!t) bad(`${tag}: tribeId ${a.tribeId} does not exist`);
      else if (t.extinctTick !== -1) bad(`${tag}: member of tribe ${a.tribeId} which is marked extinct at tick ${t.extinctTick}`);
    }

    // relationships
    if (a.relationships.length > LIMITS.relationships) bad(`${tag}: ${a.relationships.length} relationships > cap ${LIMITS.relationships}`);
    const relIds = new Set<number>();
    for (const r of a.relationships) {
      if (r.id === a.id) bad(`${tag}: relationship with itself`);
      if (relIds.has(r.id)) bad(`${tag}: duplicate relationship entry for #${r.id}`);
      relIds.add(r.id);
      if (!fin(r.affinity) || r.affinity < -1 - EPS || r.affinity > 1 + EPS) bad(`${tag}: affinity to #${r.id} = ${r.affinity}`);
      if (r.kin !== 0 && r.kin !== 1 && r.kin !== 2) bad(`${tag}: kin ${r.kin} for #${r.id}`);
      const other = sim.agentById.get(r.id);
      if (!other || !other.alive) {
        const lastSeen = opts.lastSeenAlive?.get(r.id) ?? -Infinity;
        const aliveBound = Math.max(lastSeen, fin(r.lastTick) ? r.lastTick : -Infinity);
        if (s.tick - aliveBound > relationGrace)
          bad(`${tag}: relationship to dead/unknown agent #${r.id} not pruned (last seen alive ${Number.isFinite(aliveBound) ? `tick ${aliveBound}` : 'never'})`);
      }
    }

    // capped per-agent arrays
    if (a.children.length > LIMITS.children) bad(`${tag}: children list ${a.children.length} > cap ${LIMITS.children}`);
    if (a.history.length > LIMITS.history) bad(`${tag}: history ${a.history.length} > cap ${LIMITS.history}`);
    if (a.memory.food.length > LIMITS.foodMemory) bad(`${tag}: food memory ${a.memory.food.length} > cap ${LIMITS.foodMemory}`);
    if (a.memory.danger.length > LIMITS.dangerMemory) bad(`${tag}: danger memory ${a.memory.danger.length} > cap ${LIMITS.dangerMemory}`);
  }
  if (sim.agentById.size !== s.agents.length) bad(`agentById.size ${sim.agentById.size} != state.agents.length ${s.agents.length}`);
  if (s.agents.length > cfg.maxAgents) bad(`population ${s.agents.length} > config.maxAgents ${cfg.maxAgents}`);

  // ---------------- world
  const w = s.world;
  const n = w.width * w.height;
  for (const [k, arr] of [['terrain', w.terrain], ['food', w.food], ['fertility', w.fertility], ['baseFertility', w.baseFertility],
    ['elevation', w.elevation], ['climateMod', w.climateMod], ['territory', w.territory]] as const) {
    if (arr.length !== n) bad(`world.${k}.length ${arr.length} != ${n}`);
  }
  let badFood = 0, badFert = 0, badBase = 0, badClimate = 0, badTerrain = 0, badTerritory = 0, firstFood = -1, firstFert = -1;
  for (let i = 0; i < n; i++) {
    const f = w.food[i];
    if (!(f >= 0) || !Number.isFinite(f)) { badFood++; if (firstFood < 0) firstFood = i; }
    const fe = w.fertility[i];
    if (!(fe >= 0 && fe <= 1.2 + EPS)) { badFert++; if (firstFert < 0) firstFert = i; }
    const bf = w.baseFertility[i];
    if (!(bf >= 0 && bf <= 1.2 + EPS)) badBase++;
    const cm = w.climateMod[i];
    if (!(cm >= 0) || !Number.isFinite(cm)) badClimate++;
    if (w.terrain[i] >= TERRAIN_COUNT) badTerrain++;
    if (w.territory[i] < -1) badTerritory++;
  }
  if (badFood) bad(`world.food: ${badFood} tiles negative/non-finite (first #${firstFood} = ${w.food[firstFood]})`);
  if (badFert) bad(`world.fertility: ${badFert} tiles outside [0,1.2] (first #${firstFert} = ${w.fertility[firstFert]})`);
  if (badBase) bad(`world.baseFertility: ${badBase} tiles outside [0,1.2]`);
  if (badClimate) bad(`world.climateMod: ${badClimate} tiles negative/non-finite`);
  if (badTerrain) bad(`world.terrain: ${badTerrain} tiles with unknown terrain id`);
  if (badTerritory) bad(`world.territory: ${badTerritory} tiles < -1`);

  // ---------------- environment
  const e = s.env;
  for (const k of ['timeOfDay', 'daylight', 'day', 'seasonProgress', 'year', 'temperature', 'tempOffset', 'seasonGrowth'] as const) {
    if (!fin(e[k])) bad(`env.${k} not finite (${e[k]})`);
  }
  if (e.timeOfDay < 0 || e.timeOfDay > 1 + EPS) bad(`env.timeOfDay ${e.timeOfDay} outside [0,1]`);
  if (e.daylight < -EPS || e.daylight > 1 + EPS) bad(`env.daylight ${e.daylight} outside [0,1]`);
  if (e.seasonProgress < -EPS || e.seasonProgress > 1 + EPS) bad(`env.seasonProgress ${e.seasonProgress} outside [0,1]`);
  if (![0, 1, 2, 3].includes(e.season)) bad(`env.season ${e.season}`);
  if (e.seasonGrowth < 0) bad(`env.seasonGrowth ${e.seasonGrowth} < 0`);

  // ---------------- bounded logs & bookkeeping
  if (s.events.length > LIMITS.events) bad(`events ${s.events.length} > cap ${LIMITS.events}`);
  for (let i = 1; i < s.events.length; i++) {
    if (s.events[i].id <= s.events[i - 1].id) { bad(`event ids not increasing at index ${i}`); break; }
  }
  if (s.lineage.length > LIMITS.lineage) bad(`lineage ${s.lineage.length} > cap ${LIMITS.lineage}`);
  if (sim.lineageById.size !== s.lineage.length) bad(`lineageById.size ${sim.lineageById.size} != lineage.length ${s.lineage.length}`);
  if (s.stats.samples.length > LIMITS.statSamples) bad(`stats.samples ${s.stats.samples.length} > cap ${LIMITS.statSamples}`);
  if (s.interventionLog.length > LIMITS.interventionLog) bad(`interventionLog ${s.interventionLog.length} > cap ${LIMITS.interventionLog}`);
  if (s.disasters.length > 256) bad(`disasters array has ${s.disasters.length} entries (expired disasters not pruned?)`);
  for (const d of s.disasters) {
    if (!fin(d.x) || !fin(d.y) || !fin(d.radius) || !fin(d.intensity) || !fin(d.duration)) bad(`disaster#${d.id} has non-finite fields`);
    if (d.active && s.tick > d.startTick + d.duration + 5) bad(`disaster#${d.id} (${d.kind}) still active ${s.tick - d.startTick - d.duration} ticks after it should have ended`);
  }
  const last = s.stats.samples[s.stats.samples.length - 1];
  if (last) {
    for (const [k, v] of Object.entries(last)) if (isNum(v) && !Number.isFinite(v)) bad(`stats sample @${last.tick}: ${k} = ${v}`);
    for (const g of last.geneMeans) if (!fin(g)) { bad(`stats sample @${last.tick}: geneMeans has ${g}`); break; }
  }
  if (s.rngState.length !== 4 || s.rngState.some((v) => !Number.isInteger(v) || v < 0 || v > 0xffffffff)) bad(`rngState malformed: ${JSON.stringify(s.rngState)}`);
  if (!Number.isInteger(s.tick) || s.tick < 0) bad(`tick ${s.tick}`);
  return out;
}

// ------------------------------------------------------------------ footprint (memory-boundedness proxy)

export interface Footprint {
  agents: number;
  lineage: number;
  events: number;
  samples: number;
  tribes: number;
  disasters: number;
  scheduled: number;
  interventionLog: number;
  /** Largest per-agent array (relationships / children / history / memory). */
  maxPerAgent: number;
  /** Sum of every array element above (+ per-agent arrays). */
  total: number;
}

export function footprint(sim: Simulation): Footprint {
  const s = sim.state;
  let perAgent = 0;
  let maxPerAgent = 0;
  for (const a of s.agents) {
    const m = Math.max(a.relationships.length, a.children.length, a.history.length, a.memory.food.length + a.memory.danger.length);
    if (m > maxPerAgent) maxPerAgent = m;
    perAgent += a.relationships.length + a.children.length + a.history.length + a.memory.food.length + a.memory.danger.length;
  }
  const f = {
    agents: s.agents.length,
    lineage: s.lineage.length,
    events: s.events.length,
    samples: s.stats.samples.length,
    tribes: s.tribes.length,
    disasters: s.disasters.length,
    scheduled: s.scheduled.length,
    interventionLog: s.interventionLog.length,
    maxPerAgent,
    total: 0,
  };
  f.total = f.agents + f.lineage + f.events + f.samples + f.tribes + f.disasters + f.scheduled + f.interventionLog + perAgent;
  return f;
}

// ------------------------------------------------------------------ scripted interventions

export interface PlannedIntervention {
  tick: number;
  /** Built at enqueue time (may depend on current state, e.g. "kill the first agent"). null = skip. */
  make: (sim: Simulation) => Intervention | null;
}

/**
 * A deterministic script exercising every intervention kind. Coordinates are
 * fractions of the world so it works for any world size.
 */
export function interventionPlan(sim: Simulation, opts: { edgeCases?: boolean } = {}): PlannedIntervention[] {
  const W = sim.worldW;
  const H = sim.worldH;
  const at = (fx: number, fy: number) => ({ x: W * fx, y: H * fy });
  const plan: PlannedIntervention[] = [
    { tick: 5, make: () => ({ kind: 'spawn', ...at(0.5, 0.5), count: 20, radius: 60, tribe: 'new', tribeName: 'Testers', template: { speed: 0.7, aggression: 0.2, sociability: 0.8 } }) },
    { tick: 15, make: () => ({ kind: 'addFood', ...at(0.45, 0.5), radius: 60, amount: 8 }) },
    { tick: 30, make: () => ({ kind: 'paintTerrain', ...at(0.55, 0.45), radius: 20, terrain: TERRAIN.Wall }) },
    { tick: 45, make: () => ({ kind: 'fertilize', ...at(0.4, 0.4), radius: 80, amount: 0.5 }) },
    { tick: 60, make: () => ({ kind: 'disaster', disaster: 'drought', ...at(0.3, 0.3), radius: 150, intensity: 0.7, duration: 400 }) },
    { tick: 90, make: () => ({ kind: 'setConfig', patch: { mutationRate: 0.15, foodRegen: 1.25, aggressionBias: 1.4 } }) },
    { tick: 120, make: () => ({ kind: 'disaster', disaster: 'plague', ...at(0.5, 0.5), radius: 140, intensity: 0.6, duration: 300 }) },
    { tick: 160, make: () => ({ kind: 'spawn', ...at(0.3, 0.6), count: 15, radius: 50, tribe: 'none' }) },
    { tick: 200, make: () => ({ kind: 'removeFood', ...at(0.6, 0.6), radius: 50 }) },
    { tick: 240, make: (s) => (s.state.agents[0] ? { kind: 'killAgent', id: s.state.agents[0].id } : null) },
    { tick: 260, make: (s) => (s.state.agents.length ? { kind: 'boostAgent', id: s.state.agents[s.state.agents.length - 1].id } : null) },
    { tick: 300, make: () => ({ kind: 'disaster', disaster: 'meteor', ...at(0.65, 0.35), radius: 40, intensity: 0.9, duration: 30 }) },
    { tick: 340, make: () => ({ kind: 'remove', ...at(0.52, 0.52), radius: 25 }) },
    { tick: 380, make: () => ({ kind: 'disaster', disaster: 'coldsnap', x: 0, y: 0, radius: 0, intensity: 0.5, duration: 300 }) },
    { tick: 420, make: () => ({ kind: 'disaster', disaster: 'bloom', ...at(0.5, 0.5), radius: 120, intensity: 0.8, duration: 200 }) },
    { tick: 460, make: () => ({ kind: 'disaster', disaster: 'blight', ...at(0.35, 0.65), radius: 90, intensity: 0.6, duration: 200 }) },
    { tick: 500, make: () => ({ kind: 'paintTerrain', ...at(0.55, 0.45), radius: 20, terrain: TERRAIN.Grass }) },
    { tick: 520, make: () => ({ kind: 'setConfig', patch: { foodRegen: 1, aggressionBias: 1 } }) },
  ];
  if (opts.edgeCases) {
    plan.push(
      { tick: 10, make: () => ({ kind: 'killAgent', id: 987654321 }) }, // unknown id
      { tick: 11, make: () => ({ kind: 'boostAgent', id: -1 }) }, // NONE
      { tick: 12, make: () => ({ kind: 'spawn', x: -500, y: -500, count: 5, radius: 30, tribe: 'none' }) }, // off-map
      { tick: 13, make: () => ({ kind: 'spawn', ...at(0.5, 0.5), count: 5000, radius: 300, tribe: 'none' }) }, // beyond maxAgents
      { tick: 14, make: () => ({ kind: 'spawn', ...at(0.5, 0.5), count: 3, radius: 10, tribe: 424242 }) }, // unknown tribe id
      { tick: 70, make: () => ({ kind: 'paintTerrain', ...at(0.45, 0.55), radius: 40, terrain: TERRAIN.DeepWater }) }, // drown area under agents
      { tick: 75, make: () => ({ kind: 'addFood', x: W * 2, y: H * 2, radius: 50, amount: 5 }) }, // off-map
      { tick: 80, make: () => ({ kind: 'removeFood', ...at(0.5, 0.5), radius: 0 }) },
      { tick: 85, make: () => ({ kind: 'disaster', disaster: 'meteor', ...at(0.5, 0.5), radius: 0.5, intensity: 1, duration: 1 }) },
      { tick: 95, make: () => ({ kind: 'setConfig', patch: { disasterRate: 3, diseaseVirulence: 2 } }) },
      { tick: 700, make: () => ({ kind: 'setConfig', patch: { disasterRate: 0.3, diseaseVirulence: 0.5 } }) },
      { tick: 720, make: () => ({ kind: 'paintTerrain', ...at(0.45, 0.55), radius: 40, terrain: TERRAIN.Grass }) },
    );
  }
  return plan.sort((p, q) => p.tick - q.tick);
}

/** Tick of the last terrain edit in a plan at or before `tick` (for the passability grace window). */
export function lastTerrainEdit(sim: Simulation, plan: PlannedIntervention[], tick: number): number | undefined {
  let t: number | undefined;
  for (const p of plan) {
    if (p.tick > tick) break;
    const iv = p.make(sim);
    if (iv && iv.kind === 'paintTerrain') t = p.tick;
  }
  return t;
}

/** Enqueue every planned intervention due at the current tick (call before sim.step()). */
export function enqueueDue(sim: Simulation, plan: PlannedIntervention[]): void {
  const now = sim.state.tick;
  for (const p of plan) {
    if (p.tick === now) {
      const iv = p.make(sim);
      if (iv) sim.enqueue(iv);
    }
  }
}

/** Step `sim` until `untilTick`, enqueueing planned interventions; calls onTick after every step. */
export function drive(sim: Simulation, plan: PlannedIntervention[], untilTick: number, onTick?: (sim: Simulation) => void): void {
  while (sim.state.tick < untilTick) {
    enqueueDue(sim, plan);
    sim.step();
    onTick?.(sim);
  }
}
