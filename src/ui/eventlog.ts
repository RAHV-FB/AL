// OWNER: Analytics agent. STUB — replace (keep the exported factory signature).
import type { Simulation } from '../sim/simulation';

export interface EventLogPanel {
  update(sim: Simulation): void;
}

/** onJump(x,y) pans the camera to an event location. */
export function createEventLog(container: HTMLElement, onJump: (x: number, y: number) => void): EventLogPanel {
  void onJump;
  container.textContent = 'Events (stub)';
  return { update() {} };
}
