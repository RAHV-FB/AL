// OWNER: Analytics agent. STUB — replace (keep the exported factory signature).
import type { Simulation } from '../sim/simulation';

export interface InspectorHandlers {
  onSelect(id: number): void; // select another agent (e.g. click a relative)
  onFollow(id: number): void; // camera follows agent
  onKill(id: number): void; // enqueue killAgent
  onBoost(id: number): void; // enqueue boostAgent
}

export interface Inspector {
  update(sim: Simulation, selectedId: number): void;
}

export function createInspector(container: HTMLElement, handlers: InspectorHandlers): Inspector {
  void handlers;
  container.textContent = 'Inspector (stub)';
  return { update() {} };
}
