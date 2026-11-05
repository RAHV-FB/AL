// OWNER: Disasters & Disease agent. STUB — replace with the real implementation.
import type { Simulation } from './simulation';
import type { Agent } from './types';

/** Infect an agent (respecting immunity). Returns true if newly infected. */
export function infect(sim: Simulation, agent: Agent, virulence: number): boolean {
  void sim;
  if (agent.infection > 0 || agent.immuneTicks > 0) return false;
  agent.infection = 600;
  agent.virulence = virulence;
  return true;
}

/** Transmission, progression, recovery, immunity, disease deaths. */
export function updateDisease(sim: Simulation): void {
  void sim;
}
