// OWNER: Genetics & Evolution agent.
/**
 * Genetics & evolution: genome → phenotype, inheritance, mate choice, reproduction.
 *
 * NOTHING IS FREE. Every gene that helps an agent either costs food every tick
 * (upkeep, see `basalBurn`, paid in lifecycle.updateVitals) or carries a built-in
 * drawback, so allele frequencies only move when the local environment rewards
 * the benefit more than it punishes the cost. Evolution is never scripted: it
 * emerges from who survives, and stays fed enough, to breed.
 *
 *  gene        benefit                                       cost / drawback
 *  ----------  --------------------------------------------  ----------------------------------------------
 *  speed       top speed 0.5–2.2 u/tick (reach food, flee)   muscle upkeep; movement cost ∝ v²·size; tires
 *  size        health, stomach (fasting), strength, cold     basal burn ∝ size; movement cost ∝ size;
 *              resistance (surface/volume)                   matures later (700 → 1100 ticks)
 *  perception  vision 25–140 u (food & danger from afar)     small neural upkeep
 *  metabolism  faster healing & stamina recovery, body heat, multiplies ALL basal upkeep (0.6–1.5×)
 *              less tiring movement
 *  fertility   breeds when hungrier, shorter cooldown,       each child receives less food (weaker start)
 *              cheaper children (r- vs K-strategy)
 *  longevity   max age 3500–9000 ticks                       cellular-repair upkeep every tick
 *  immunity    disease resistance (disease.ts)               immune upkeep every tick
 *  efficiency  0.5–1.5 food gained per bite                  heavier specialised gut: digestive upkeep
 *  aggression / sociability / altruism: behavioural genes read by brain/social; their costs are
 *              behavioural (injuries, food given away, crowding) rather than metabolic.
 *  hue         none — neutral marker. Drifts by mutation → visible lineages; counts in
 *              geneticDistance, so colour clusters coincide with breeding clusters (species).
 */
import type { Rng } from './rng';
import type { Simulation } from './simulation';
import { LIMITS } from './constants';
import { GENE_COUNT, GENES, G, NONE, type Agent, type GenomeTemplate, type Traits } from './types';
import { addHistory, createAgent, isAdult } from './lifecycle';
import { adjustRelationship } from './social';

// ------------------------------------------------------------------ helpers

/** Clamp to [0,1]; non-numbers / NaN → fallback. */
function unit(v: number | undefined, fallback = 0.5): number {
  if (typeof v !== 'number' || v !== v) return fallback;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Copy of a genome with exactly GENE_COUNT finite genes in [0,1] (missing/invalid → 0.5). */
export function sanitizeGenome(genes: readonly number[] | undefined): number[] {
  const out = new Array<number>(GENE_COUNT);
  for (let i = 0; i < GENE_COUNT; i++) out[i] = unit(genes ? genes[i] : undefined);
  return out;
}

// ------------------------------------------------------------------ genome

/**
 * Random genome. Without a template every gene is uniform in [0.25,0.75] (a
 * diverse but not extreme founder population). With a template, listed genes are
 * normal(mean, template.spread ?? 0.08); unlisted genes stay uniform [0.25,0.75].
 */
export function randomGenes(rng: Rng, template?: GenomeTemplate): number[] {
  const g: number[] = new Array(GENE_COUNT);
  const spread = template?.spread ?? 0.08;
  for (let i = 0; i < GENE_COUNT; i++) {
    const mean = template?.[GENES[i]];
    const v = typeof mean === 'number' && Number.isFinite(mean) ? rng.normal(mean, spread) : rng.next() * 0.5 + 0.25;
    g[i] = unit(v);
  }
  return g;
}

/** Phenotype ranges: value at gene 0 → value at gene 1. */
export const TRAIT_RANGES = {
  speed: [0.5, 2.2],
  size: [0.6, 1.6],
  perception: [25, 140],
  metabolism: [0.6, 1.5],
  longevity: [3500, 9000],
  efficiency: [0.5, 1.5],
  maturityAge: [700, 1100],
} as const;

const lerp = (r: readonly [number, number], t: number) => r[0] + (r[1] - r[0]) * t;

/**
 * Map genes (0..1) to phenotype traits in simulation units. Pure function.
 * Costs of each trait are NOT stored here; they are computed by `basalBurn`
 * (upkeep) and lifecycle.updateVitals (movement, cold) from these traits.
 */
export function expressTraits(genes: number[]): Traits {
  const g = (i: number) => unit(genes[i]);
  const sizeG = g(G.size);
  const size = lerp(TRAIT_RANGES.size, sizeG);
  return {
    speed: lerp(TRAIT_RANGES.speed, g(G.speed)),
    size,
    perception: lerp(TRAIT_RANGES.perception, g(G.perception)),
    metabolism: lerp(TRAIT_RANGES.metabolism, g(G.metabolism)),
    aggression: g(G.aggression),
    sociability: g(G.sociability),
    altruism: g(G.altruism),
    fertility: g(G.fertility),
    longevity: Math.round(lerp(TRAIT_RANGES.longevity, g(G.longevity))),
    immunity: g(G.immunity),
    efficiency: lerp(TRAIT_RANGES.efficiency, g(G.efficiency)),
    hue: g(G.hue) * 360,
    // Big bodies: more health (76..136), a bigger stomach (78..133 → longer fasting) and more
    // strength — paid for by size-proportional basal and movement costs and slower maturity.
    maxHealth: 40 + 60 * size,
    maxFood: 45 + 55 * size,
    strength: size,
    maturityAge: Math.round(lerp(TRAIT_RANGES.maturityAge, sizeG)),
  };
}

/** Per-tick upkeep coefficients (food/tick at metabolism 1), summed and scaled in `basalBurn`. */
export const UPKEEP = {
  base: 0.026, // everything alive pays this
  size: 0.022, // × body size (0.6..1.6)
  speed: 0.004, // × top speed (0.5..2.2): muscle mass
  perception: 0.003, // × perception/100 (0.25..1.4): neural tissue
  longevity: 0.008, // × normalised longevity (0..1): cellular repair
  immunity: 0.008, // × immunity (0..1): immune system
  efficiency: 0.007, // × normalised efficiency (0..1): heavier, specialised gut
};

/**
 * Food burned per tick by an awake, motionless ADULT in mild weather at difficulty 1.
 * = metabolism × (base + Σ trait upkeep). All genes 0.5 → ≈0.073 food/tick; range ≈0.025
 * (all genes 0) .. ≈0.146 (all genes 1). lifecycle.updateVitals multiplies by difficulty and
 * juvenile body scale and adds movement + cold costs.
 */
export function basalBurn(t: Traits): number {
  const lon = unit((t.longevity - TRAIT_RANGES.longevity[0]) / (TRAIT_RANGES.longevity[1] - TRAIT_RANGES.longevity[0]), 0);
  const eff = unit(t.efficiency - TRAIT_RANGES.efficiency[0], 0);
  const upkeep =
    UPKEEP.base +
    UPKEEP.size * t.size +
    UPKEEP.speed * t.speed +
    UPKEEP.perception * (t.perception / 100) +
    UPKEEP.longevity * lon +
    UPKEEP.immunity * unit(t.immunity, 0) +
    UPKEEP.efficiency * eff;
  const r = t.metabolism * upkeep;
  return Number.isFinite(r) && r > 0 ? r : UPKEEP.base;
}

/**
 * Probability that the parent providing consecutive genes switches during crossover.
 * 0.5 would be plain uniform crossover; 0.4 adds mild linkage so neighbouring genes
 * (speed/size/perception/metabolism, aggression/sociability/altruism, …) tend to be
 * inherited together as blocks.
 */
export const CROSSOVER_SWITCH = 0.4;

/** Crossover of two parent genomes: every child allele is copied from one of the parents. */
export function crossover(rng: Rng, a: number[], b: number[]): number[] {
  const c = new Array<number>(GENE_COUNT);
  let fromA = rng.next() < 0.5;
  for (let i = 0; i < GENE_COUNT; i++) {
    if (i > 0 && rng.next() < CROSSOVER_SWITCH) fromA = !fromA;
    const va = a[i];
    const vb = b[i];
    const pick = fromA ? va : vb;
    const other = fromA ? vb : va;
    c[i] = Number.isFinite(pick) ? unit(pick) : unit(other);
  }
  return c;
}

/**
 * Gaussian point mutation IN PLACE: each gene mutates with probability `rate` by
 * normal(0, size). Out-of-range values are reflected back into [0,1] (so alleles do
 * not pile up at exactly 0 or 1) and then clamped. rate 0 or size 0 ⇒ genes unchanged.
 */
export function mutate(rng: Rng, genes: number[], rate: number, size: number): number[] {
  const sd = Number.isFinite(size) && size > 0 ? size : 0;
  const p = Number.isFinite(rate) && rate > 0 ? rate : 0;
  for (let i = 0; i < genes.length; i++) {
    let v = unit(genes[i]);
    if (p > 0 && sd > 0 && rng.next() < p) {
      v += rng.normal(0, sd);
      if (v < 0) v = -v;
      if (v > 1) v = 2 - v;
      v = unit(v);
    }
    genes[i] = v;
  }
  return genes;
}

/** Normalised genetic distance in [0,1]: mean absolute difference over all genes (hue counts). */
export function geneticDistance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length, GENE_COUNT);
  if (n <= 0) return 0;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.abs(a[i] - b[i]);
    if (x === x) d += x;
  }
  const r = d / n;
  return r > 1 ? 1 : r;
}

// ------------------------------------------------------------------ reproduction

export const REPRO = {
  /** Agents older than this fraction of their longevity are past breeding age. */
  maxAgeFrac: 0.9,
  minEnergy: 0.25,
  /** Injured / very sick agents do not breed. */
  minHealthFrac: 0.3,
  /** Stamina each parent spends on a birth. */
  energyCost: 0.12,
  /** Max distance (world units) of the birth spot from the parents' midpoint. */
  spawnRadius: 6,
  /** Kin bond strengths given through social.adjustRelationship. */
  parentBond: 0.6,
  siblingBond: 0.4,
  mateBond: 0.15,
  maxSiblingLinks: 3,
};

/** Minimum stomach fraction (food / maxFood) to breed: 0.6 (fertility 0) … 0.35 (fertility 1). */
export function mateFoodThreshold(t: Traits): number {
  return 0.6 - 0.25 * unit(t.fertility);
}

/**
 * Fraction of its OWN stomach capacity a parent gives to each child: 0.28 (fertility 0) …
 * 0.10 (fertility 1). Low fertility = few, well-provisioned children (≈56% stomach from two
 * average parents); high fertility = many cheap children that start ≈20% full.
 */
export function parentalInvestment(t: Traits): number {
  return 0.28 - 0.18 * unit(t.fertility);
}

/** Ticks before a parent may breed again: (1100 … 500 with fertility) / reproductionRate. */
export function reproCooldownFor(t: Traits, reproductionRate: number): number {
  const rate = Number.isFinite(reproductionRate) && reproductionRate > 0.05 ? reproductionRate : 0.05;
  return Math.round((1100 - 600 * unit(t.fertility)) / rate);
}

/** Parent/child or (half-)siblings, from the parents arrays. */
export function areCloseKin(a: Agent, b: Agent): boolean {
  const [a0, a1] = a.parents;
  const [b0, b1] = b.parents;
  if (a0 === b.id || a1 === b.id || b0 === a.id || b1 === a.id) return true;
  if (a0 !== NONE && (a0 === b0 || a0 === b1)) return true;
  if (a1 !== NONE && (a1 === b0 || a1 === b1)) return true;
  return false;
}

/**
 * Individual readiness to breed, ignoring the partner (cheap pre-filter for the brain):
 * alive adult, not senescent (age < 0.9·longevity), cooldown over, stomach above the
 * fertility-dependent threshold, energy > 0.25, health ≥ 30%.
 */
export function isFertile(a: Agent): boolean {
  const t = a.traits;
  return (
    a.alive &&
    isAdult(a) &&
    a.age < REPRO.maxAgeFrac * t.longevity &&
    a.reproCooldown <= 0 &&
    a.food >= mateFoodThreshold(t) * t.maxFood &&
    a.energy > REPRO.minEnergy &&
    a.health >= REPRO.minHealthFrac * t.maxHealth
  );
}

/** Whether a and b can mate right now (both fertile, not close kin, genetically compatible, room to spawn). */
export function canMate(sim: Simulation, a: Agent, b: Agent): boolean {
  if (a === b || a.id === b.id) return false;
  if (!isFertile(a) || !isFertile(b)) return false;
  if (areCloseKin(a, b)) return false;
  if (geneticDistance(a.genes, b.genes) > sim.config.mateCompatibility) return false;
  return sim.canSpawn();
}

/** Passable spot within REPRO.spawnRadius of the parents' midpoint (falls back to a parent's position). */
function birthPosition(sim: Simulation, a: Agent, b: Agent): { x: number; y: number } {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  for (let tries = 0; tries < 8; tries++) {
    const ang = sim.rng.next() * Math.PI * 2;
    const r = 1 + sim.rng.next() * (REPRO.spawnRadius - 1);
    const x = sim.clampX(mx + Math.cos(ang) * r);
    const y = sim.clampY(my + Math.sin(ang) * r);
    if (sim.passableAt(x, y)) return { x, y };
  }
  if (sim.passableAt(mx, my)) return { x: sim.clampX(mx), y: sim.clampY(my) };
  if (sim.passableAt(a.x, a.y)) return { x: a.x, y: a.y };
  return { x: b.x, y: b.y };
}

/** Highest generation in the lineage registry (includes every living agent). */
function maxGenerationOnRecord(sim: Simulation): number {
  let m = 0;
  for (const rec of sim.state.lineage) if (rec.generation > m) m = rec.generation;
  for (const ag of sim.state.agents) if (ag.generation > m) m = ag.generation;
  return m;
}

/**
 * Produce a child from parents a (mother: the child joins her tribe) and b.
 * Child genes = mutate(crossover(a,b)); its starting stomach is food taken from both
 * parents (`parentalInvestment`); both parents pay stamina and get a fertility-dependent
 * cooldown. Registers kin bonds, life-history entries and the child (sim.addAgent).
 * Returns null (and changes nothing) when `canMate` fails.
 */
export function reproduce(sim: Simulation, a: Agent, b: Agent): Agent | null {
  if (!canMate(sim, a, b)) return null;
  const rng = sim.rng;
  const cfg = sim.config;

  const genes = mutate(rng, crossover(rng, a.genes, b.genes), cfg.mutationRate, cfg.mutationSize);
  const pos = birthPosition(sim, a, b);
  const generation = Math.max(a.generation, b.generation) + 1;
  const tribeId = a.tribeId !== NONE ? a.tribeId : b.tribeId;
  const child = createAgent(sim, { x: pos.x, y: pos.y, genes, parents: [a.id, b.id], generation, tribeId, age: 0, food: 0 });

  // Provisioning: each parent hands over part of its stomach; scaled down if it would overfill the child.
  let ia = Math.max(0, Math.min(a.food, parentalInvestment(a.traits) * a.traits.maxFood));
  let ib = Math.max(0, Math.min(b.food, parentalInvestment(b.traits) * b.traits.maxFood));
  const total = ia + ib;
  if (total > child.traits.maxFood) {
    const k = child.traits.maxFood / total;
    ia *= k;
    ib *= k;
  }
  a.food -= ia;
  b.food -= ib;
  child.food = ia + ib;

  // Siblings to bond with (gathered before the child is added to the parents' lists).
  const siblings: Agent[] = [];
  for (const p of [a, b]) {
    for (let i = p.children.length - 1; i >= 0 && siblings.length < REPRO.maxSiblingLinks; i--) {
      const s = sim.getAgent(p.children[i]);
      if (s && siblings.indexOf(s) < 0) siblings.push(s);
    }
  }

  const isMilestone = generation % 10 === 0 && generation > maxGenerationOnRecord(sim);
  sim.addAgent(child);

  for (const p of [a, b]) {
    p.energy = Math.max(0, p.energy - REPRO.energyCost);
    p.reproCooldown = reproCooldownFor(p.traits, cfg.reproductionRate);
    p.offspring++;
    p.children.push(child.id);
    if (p.children.length > LIMITS.children) p.children.splice(0, p.children.length - LIMITS.children);
    adjustRelationship(sim, p, child, REPRO.parentBond, 1);
    adjustRelationship(sim, child, p, REPRO.parentBond, 1);
    const mate = p === a ? b : a;
    addHistory(sim, p, `Had a child, ${child.name}, with ${mate.name}`);
    if (p.offspring % 10 === 0) {
      sim.log('record', 'good', `${p.name} has become a prolific parent: ${p.offspring} children.`, {
        x: p.x,
        y: p.y,
        agentId: p.id,
        ...(p.tribeId !== NONE ? { tribeId: p.tribeId } : {}),
      });
    }
  }
  adjustRelationship(sim, a, b, REPRO.mateBond, 0);
  adjustRelationship(sim, b, a, REPRO.mateBond, 0);
  for (const s of siblings) {
    adjustRelationship(sim, child, s, REPRO.siblingBond, 2);
    adjustRelationship(sim, s, child, REPRO.siblingBond, 2);
  }
  addHistory(sim, child, `Born to ${a.name} and ${b.name} (generation ${generation})`);

  if (isMilestone) {
    sim.log('evolution', 'good', `Generation ${generation} reached: ${child.name}, child of ${a.name} and ${b.name}, is the first of their generation.`, {
      x: child.x,
      y: child.y,
      agentId: child.id,
      ...(tribeId !== NONE ? { tribeId } : {}),
    });
  }
  return child;
}
