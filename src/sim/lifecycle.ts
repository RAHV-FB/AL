// OWNER: Genetics & Evolution agent.
/**
 * Agent lifecycle: construction, growth, per-tick vitals (metabolism, stamina,
 * healing, starvation, senescence) and natural death.
 *
 * Balance notes (difficulty 1, every gene 0.5 → size 1.1, stomach ≈105, health ≈106):
 *  - idle basal burn ≈0.073 food/tick (genetics.basalBurn); walking at full stride adds
 *    ≈0.016 (∝ v²·size). A full stomach lasts ≈1250–1450 ticks, then starvation drains
 *    full health in ≈220 ticks → ≈1450–1650 ticks without food.
 *  - grazing at ~1.2 food/tick refills a stomach in <100 ticks, so a fed agent needs to
 *    spend only ~6–8 % of its time eating: a 200-agent population eats ≈16 food/tick.
 *  - longevity 3500–9000 ticks (mean 6250). Senescence from 80 % of it erodes health
 *    faster than it heals, so well-fed agents die of old age at ≈0.93–1.0 × longevity
 *    (≈4000–8000 ticks for most genomes); age ≥ longevity is always fatal.
 *  - juveniles burn less (smaller body) and grow from 50 % to 100 % size by maturityAge.
 */
import type { Simulation } from './simulation';
import { LIMITS } from './constants';
import { basalBurn, expressTraits, sanitizeGenome } from './genetics';
import { NONE, type Agent, type AgentId, type DeathCause, type TribeId } from './types';

export interface CreateAgentOpts {
  x: number;
  y: number;
  genes: number[];
  parents?: [AgentId, AgentId];
  generation?: number;
  tribeId?: TribeId;
  /** Starting age in ticks (founders start as young adults). */
  age?: number;
  /** Starting stomach food (default: 70% of max). */
  food?: number;
}

/** Tunable vitals constants (per tick unless noted). */
export const VITALS = {
  /** Food per (world-units/tick)² of velocity per unit of body size. */
  moveCost: 0.008,
  /** Resting (sleeping) lowers basal burn. */
  restBurn: 0.85,
  /** Juvenile burn = adult × (juvenileBurn + (1 - juvenileBurn) × growth progress). */
  juvenileBurn: 0.55,
  /** Below this temperature (°C) bodies pay food to keep warm. */
  coldThreshold: 8,
  /** Food per degree below threshold, divided by size × metabolic heat factor. */
  coldCost: 0.0025, // ecology winter ≈ −3 °C → +≈33 % burn for an average body, +≈65 % for the smallest
  coldMaxDelta: 20,
  /** Within this distance (world units) of the own tribe's camp, cold stress is halved (shelter). */
  shelterRadius: 40,
  /** Fraction of maxHealth lost per tick while the stomach is empty (× difficulty). */
  starveRate: 1 / 220,
  /** Fraction of maxHealth healed per tick (× metabolism) when fed & rested. */
  healRate: 0.0018,
  /** Food spent per point of health healed. */
  healFoodCost: 0.12,
  healMinFood: 0.25,
  healMinEnergy: 0.2,
  /** Senescence starts at this fraction of longevity. */
  senescenceStart: 0.8,
  /** Fraction of maxHealth lost per tick at full senescence (scales with progress²). */
  senescenceDamage: 0.006,
  /** Stamina: awake drain, movement drain at full stride, fighting drain, recovery rates. */
  energyBase: 0.0003,
  energyMove: 0.0028,
  energyFight: 0.004,
  energyRest: 0.0045,
  energyIdle: 0.0006,
  /** Daylight below which it counts as night (resting recovers 25 % faster). */
  nightDaylight: 0.35,
  /** A starving agent eats carried food at this rate (last resort). */
  carriedBite: 1.2,
};

/** Build a complete Agent object. Does NOT register it — call sim.addAgent(agent). */
export function createAgent(sim: Simulation, o: CreateAgentOpts): Agent {
  const genes = sanitizeGenome(o.genes);
  const traits = expressTraits(genes);
  const age = Number.isFinite(o.age) && (o.age as number) > 0 ? (o.age as number) : 0;
  const food = Number.isFinite(o.food) ? Math.min(traits.maxFood, Math.max(0, o.food as number)) : traits.maxFood * 0.7;
  return {
    id: sim.newAgentId(),
    name: sim.newName(),
    alive: true,
    generation: o.generation ?? 0,
    parents: o.parents ? [o.parents[0], o.parents[1]] : [NONE, NONE],
    birthTick: sim.state.tick - age,
    age,
    x: o.x,
    y: o.y,
    vx: 0,
    vy: 0,
    heading: sim.rng.next() * Math.PI * 2,
    genes,
    traits,
    health: traits.maxHealth,
    food,
    energy: 1,
    carried: 0,
    action: 'idle',
    actionTicks: 0,
    targetX: NaN,
    targetY: NaN,
    targetId: NONE,
    decisionCooldown: 0,
    utilities: {},
    thought: '',
    reproCooldown: 0,
    offspring: 0,
    children: [],
    tribeId: o.tribeId ?? NONE,
    relationships: [],
    role: 'none',
    skills: { forage: 0, combat: 0, social: 0 },
    infection: 0,
    virulence: 0,
    immuneTicks: 0,
    memory: { food: [], danger: [] },
    history: [],
    stats: { foodEaten: 0, distance: 0, kills: 0, shared: 0, received: 0, fights: 0 },
    deathTick: -1,
    deathCause: null,
    lastAttackerId: NONE,
    fear: 0,
    sinceMeal: 0,
  };
}

/** 0.5 (newborn) → 1 (adult) body growth factor. */
export function growthFactor(a: Agent): number {
  const m = a.traits.maturityAge;
  if (!(m > 0) || !(a.age < m)) return 1;
  return a.age > 0 ? 0.5 + 0.5 * (a.age / m) : 0.5;
}

export function isAdult(a: Agent): boolean {
  return a.age >= a.traits.maturityAge;
}

/** Senescence progress 0 (not yet old) → 1 (at max age). */
export function senescence(a: Agent): number {
  const L = a.traits.longevity;
  const start = L * VITALS.senescenceStart;
  if (!(a.age > start)) return 0;
  const s = (a.age - start) / (L - start);
  return s < 1 ? s : 1;
}

/** Cause for an agent found at ≤0 health without having been killed by the module that hurt it. */
function fallbackCause(a: Agent): DeathCause {
  if (a.age >= a.traits.longevity) return 'old_age';
  if (a.infection > 0) return 'disease';
  if (a.lastAttackerId !== NONE) return 'combat';
  return 'starvation';
}

function die(sim: Simulation, a: Agent, cause: DeathCause): void {
  const text =
    cause === 'old_age' ? 'Died of old age' : cause === 'starvation' ? 'Starved to death' : cause === 'disease' ? 'Succumbed to illness' : cause === 'combat' ? 'Died of wounds' : 'Died';
  addHistory(sim, a, `${text} at age ${Math.floor(a.age)}`);
  sim.killAgent(a, cause);
}

/**
 * Per-tick metabolism, aging, fatigue, healing/starvation, natural death.
 * Order: age & cooldowns → food burn (basal + movement + cold) → stamina → starvation
 * damage or healing → senescence damage → death check.
 */
export function updateVitals(sim: Simulation, a: Agent): void {
  if (!a.alive) return;
  const t = a.traits;
  const env = sim.state.env;
  const difficulty = sim.state.config.difficulty > 0 ? sim.state.config.difficulty : 0;

  // ---- sanitise (another module's bug must not poison the simulation with NaN)
  if (!Number.isFinite(a.food)) a.food = 0;
  if (!Number.isFinite(a.energy)) a.energy = 0.5;
  if (!Number.isFinite(a.health)) a.health = t.maxHealth * 0.5;
  if (!Number.isFinite(a.age)) a.age = 0;

  // ---- ageing & timers
  const prevAge = a.age;
  a.age = prevAge + 1;
  a.reproCooldown = a.reproCooldown > 1 ? a.reproCooldown - 1 : 0;
  if (a.sinceMeal !== undefined) a.sinceMeal++;
  if (prevAge < t.maturityAge && a.age >= t.maturityAge) addHistory(sim, a, 'Came of age');
  const senStart = t.longevity * VITALS.senescenceStart;
  if (prevAge < senStart && a.age >= senStart) addHistory(sim, a, 'Began to grow old');

  // Damaged to ≤0 elsewhere without being killed: attribute and remove.
  if (a.health <= 0) {
    die(sim, a, fallbackCause(a));
    return;
  }

  const sen = senescence(a);
  const growth = growthFactor(a); // 0.5..1
  const bodyScale = VITALS.juvenileBurn + (1 - VITALS.juvenileBurn) * (growth - 0.5) * 2;
  const resting = a.action === 'rest';

  // ---- food burn
  let v2 = a.vx * a.vx + a.vy * a.vy;
  if (!Number.isFinite(v2) || resting || a.action === 'eat') v2 = 0;
  let burn = basalBurn(t) * (resting ? VITALS.restBurn : 1) + VITALS.moveCost * v2 * t.size;
  burn *= bodyScale;
  const temp = env.temperature;
  if (temp < VITALS.coldThreshold) {
    // Small bodies lose heat faster (surface/volume); high metabolism generates more heat.
    let cold = (VITALS.coldCost * Math.min(VITALS.coldMaxDelta, VITALS.coldThreshold - temp)) / (t.size * (0.6 + 0.4 * t.metabolism));
    if (a.tribeId !== NONE) {
      const tr = sim.getTribe(a.tribeId);
      if (tr && tr.extinctTick === -1) {
        const dx = a.x - tr.homeX;
        const dy = a.y - tr.homeY;
        if (dx * dx + dy * dy < VITALS.shelterRadius * VITALS.shelterRadius) cold *= 0.5;
      }
    }
    if (Number.isFinite(cold)) burn += cold;
  }
  burn *= difficulty;
  a.food -= burn;

  // ---- stamina
  const effort = Math.sqrt(v2) / Math.max(0.25, t.speed); // fraction of full stride
  let dE = -VITALS.energyBase - VITALS.energyMove * effort * effort * (0.8 + 0.2 * t.size) * (1.25 - 0.25 * t.metabolism);
  const fighting = a.action === 'attack';
  if (fighting) dE -= VITALS.energyFight;
  let rec = resting ? VITALS.energyRest : v2 < 0.01 && !fighting ? VITALS.energyIdle : 0;
  if (rec > 0) {
    rec *= t.metabolism * (1 - 0.5 * sen);
    if (resting && env.daylight < VITALS.nightDaylight) rec *= 1.25;
    if (a.food <= 0) rec *= 0.5;
    dE += rec;
  }
  const e = a.energy + dE;
  a.energy = e > 1 ? 1 : e > 0 ? e : 0;

  // ---- starvation or healing
  let starveDmg = 0;
  if (a.food <= 0) {
    a.food = 0;
    if (a.carried > 0) {
      // Last resort: eat what you carry rather than starve.
      const take = Math.min(a.carried, VITALS.carriedBite);
      a.carried -= take;
      a.food += take;
      a.stats.foodEaten += take;
      if (a.sinceMeal !== undefined) a.sinceMeal = 0;
    } else {
      starveDmg = difficulty * t.maxHealth * VITALS.starveRate;
    }
  } else if (a.health < t.maxHealth && a.food > t.maxFood * VITALS.healMinFood && a.energy > VITALS.healMinEnergy) {
    let heal = t.maxHealth * VITALS.healRate * t.metabolism * (1 - 0.7 * sen);
    if (resting) heal *= 1.5;
    if (a.infection > 0) heal *= 0.5;
    heal = Math.min(heal, t.maxHealth - a.health, a.food / VITALS.healFoodCost);
    if (heal > 0) {
      a.health += heal;
      a.food -= heal * VITALS.healFoodCost;
    }
  }
  const senDmg = sen > 0 ? t.maxHealth * VITALS.senescenceDamage * sen * sen : 0;
  a.health -= starveDmg + senDmg;

  // ---- clamp
  if (a.food > t.maxFood) a.food = t.maxFood;
  else if (!(a.food > 0)) a.food = 0;
  if (a.health > t.maxHealth) a.health = t.maxHealth;

  // ---- natural death
  if (a.age >= t.longevity) {
    die(sim, a, 'old_age');
  } else if (!(a.health > 0)) {
    a.health = 0;
    die(sim, a, senDmg > 0 && senDmg >= starveDmg ? 'old_age' : starveDmg > 0 ? 'starvation' : fallbackCause(a));
  }
}

/** Append to an agent's personal life log (capped). */
export function addHistory(sim: Simulation, a: Agent, text: string): void {
  a.history.push({ tick: sim.state.tick, text });
  if (a.history.length > LIMITS.history) a.history.splice(0, a.history.length - LIMITS.history);
}
