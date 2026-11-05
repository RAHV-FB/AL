// OWNER: Analytics agent. STUB — replace (keep the exported factory signatures).
import type { Simulation } from '../sim/simulation';

export interface AnalyticsPanel {
  /** Refresh charts from sim.state.stats (called ~4×/s by the app; cheap when nothing changed). */
  update(sim: Simulation, force?: boolean): void;
}

export function createAnalyticsPanel(container: HTMLElement): AnalyticsPanel {
  container.textContent = 'Analytics (stub)';
  return { update() {} };
}
