// OWNER: Genetics & Evolution agent. STUB — replace with the real implementation.
import type { Simulation } from './simulation';
import { expressTraits } from './genetics';
import { NONE, type Agent, type AgentId, type TribeId } from './types';

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

/** Build a complete Agent object. Does NOT register it — call sim.addAgent(agent). */
export function createAgent(sim: Simulation, o: CreateAgentOpts): Agent {
  const traits = expressTraits(o.genes);
  return {
    id: sim.newAgentId(),
    name: sim.newName(),
    alive: true,
    generation: o.generation ?? 0,
    parents: o.parents ?? [NONE, NONE],
    birthTick: sim.state.tick - (o.age ?? 0),
    age: o.age ?? 0,
    x: o.x,
    y: o.y,
    vx: 0,
    vy: 0,
    heading: sim.rng.next() * Math.PI * 2,
    genes: o.genes,
    traits,
    health: traits.maxHealth,
    food: o.food ?? traits.maxFood * 0.7,
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
  };
}

/** 0.5 (newborn) → 1 (adult) body growth factor. */
export function growthFactor(a: Agent): number {
  return Math.min(1, 0.5 + 0.5 * (a.age / a.traits.maturityAge));
}

export function isAdult(a: Agent): boolean {
  return a.age >= a.traits.maturityAge;
}

/** Per-tick metabolism, aging, fatigue, healing/starvation, natural death. */
export function updateVitals(sim: Simulation, a: Agent): void {
  void sim;
  a.age++;
}

/** Append to an agent's personal life log (capped). */
export function addHistory(sim: Simulation, a: Agent, text: string): void {
  a.history.push({ tick: sim.state.tick, text });
  if (a.history.length > 20) a.history.shift();
}
