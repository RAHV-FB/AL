// OWNER: Persistence & Experiments agent. STUB — replace with full save/load + validation.
import type { Simulation } from './simulation';
import type { SimState } from './types';

/** Serialise a simulation to a JSON string (typed arrays → base64). */
export function serializeSim(sim: Simulation): string {
  void sim;
  throw new Error('not implemented');
}

/** Parse + validate a save file. Throws Error with a human-readable message on invalid input. */
export function deserializeState(json: string): SimState {
  void json;
  throw new Error('not implemented');
}
