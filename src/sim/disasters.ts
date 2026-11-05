// OWNER: Disasters & Disease agent. STUB — replace with the real implementation.
import type { Simulation } from './simulation';
import type { Disaster, DisasterKind } from './types';

/** Human-readable explanations (shown in the UI). */
export const DISASTER_INFO: Record<DisasterKind, { label: string; icon: string; help: string }> = {
  drought: { label: 'Drought', icon: '☀', help: 'Plant regrowth collapses inside the area for the duration.' },
  blight: { label: 'Blight', icon: '☣', help: 'Resource collapse: destroys standing food and damages soil fertility.' },
  bloom: { label: 'Abundance', icon: '✿', help: 'Food bursts to capacity and regrowth is boosted for a while.' },
  plague: { label: 'Plague', icon: '✚', help: 'Infects agents in the area with a contagious disease.' },
  meteor: { label: 'Meteor', icon: '☄', help: 'Kills agents at the impact point, scorches terrain and food.' },
  coldsnap: { label: 'Cold snap', icon: '❄', help: 'Temperature plunges: higher metabolic cost and stunted growth.' },
};

/** Start a disaster (from interventions or random events). radius 0 = global. */
export function startDisaster(
  sim: Simulation,
  kind: DisasterKind,
  x: number,
  y: number,
  radius: number,
  intensity: number,
  duration: number,
): Disaster {
  const d: Disaster = { id: sim.state.nextDisasterId++, kind, x, y, radius, startTick: sim.state.tick, duration, intensity, active: true };
  sim.state.disasters.push(d);
  return d;
}

/** Progress active disasters, maintain world.climateMod, spawn random disasters. */
export function updateDisasters(sim: Simulation): void {
  void sim;
}
