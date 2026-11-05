// OWNER: Social Systems agent. STUB — replace with the real implementation.
import type { Simulation } from './simulation';
import type { Agent, AgentId, Relationship, Tribe, TribeId } from './types';

/** Periodic social systems: relationship decay/pruning, tribe formation/fission/extinction, inter-tribe relations, territory map, roles. */
export function updateSocial(sim: Simulation): void {
  void sim;
}

export function getRelationship(a: Agent, otherId: AgentId): Relationship | undefined {
  return a.relationships.find((r) => r.id === otherId);
}

/** Change a's feelings toward b by delta (creates the entry; evicts weakest when full). */
export function adjustRelationship(sim: Simulation, a: Agent, b: Agent, delta: number, kin: 0 | 1 | 2 = 0): void {
  void sim; void a; void b; void delta; void kin;
}

/** True when a would treat b as an enemy (tribal war, grudges, low affinity). */
export function isHostile(sim: Simulation, a: Agent, b: Agent): boolean {
  void sim; void a; void b;
  return false;
}

/** True when a considers b friend/kin/tribe-mate. */
export function isFriendly(sim: Simulation, a: Agent, b: Agent): boolean {
  void sim;
  return a.tribeId !== -1 && a.tribeId === b.tribeId;
}

/** One combat exchange: attacker hits defender. Handles damage, theft, deaths (cause 'combat'), grudges, counters. */
export function attack(sim: Simulation, attacker: Agent, defender: Agent): void {
  void sim; void attacker; void defender;
}

/** Give food from giver to receiver (from carried first, then stomach). Returns amount transferred. */
export function shareFood(sim: Simulation, giver: Agent, receiver: Agent, amount: number): number {
  void sim; void giver; void receiver; void amount;
  return 0;
}

/** Deposit carried food into the agent's tribe stockpile (must be near camp). Returns amount deposited. */
export function depositFood(sim: Simulation, a: Agent): number {
  void sim; void a;
  return 0;
}

/** Withdraw up to `amount` from tribe stockpile into stomach (must be near camp). Returns amount taken. */
export function withdrawFood(sim: Simulation, a: Agent, amount: number): number {
  void sim; void a; void amount;
  return 0;
}

export function joinTribe(sim: Simulation, a: Agent, tribeId: TribeId): void {
  void sim;
  a.tribeId = tribeId;
}

export function leaveTribe(sim: Simulation, a: Agent): void {
  void sim;
  a.tribeId = -1;
}

/** Found a new tribe with `founder` (and optional initial members). */
export function foundTribe(sim: Simulation, founder: Agent, members: Agent[] = [], name?: string, hue?: number): Tribe {
  const t = sim.createTribe(founder, founder.x, founder.y, name, hue);
  joinTribe(sim, founder, t.id);
  for (const m of members) joinTribe(sim, m, t.id);
  return t;
}
