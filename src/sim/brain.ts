// OWNER: Agent Intelligence agent. STUB — replace with the real implementation.
import type { Simulation } from './simulation';
import type { Agent } from './types';

/** Perceive + choose an action (utility AI). Sets action/target/utilities/thought/decisionCooldown. */
export function think(sim: Simulation, a: Agent): void {
  a.decisionCooldown = 8 + (a.id % 4);
  if (a.action === 'idle') {
    a.action = 'wander';
    a.heading = sim.rng.next() * Math.PI * 2;
  }
}

/** Execute the current action for one tick (movement, eating, interactions). */
export function act(sim: Simulation, a: Agent): void {
  const sp = a.traits.speed * 0.5;
  const nx = a.x + Math.cos(a.heading) * sp;
  const ny = a.y + Math.sin(a.heading) * sp;
  if (sim.passableAt(nx, ny)) {
    a.vx = nx - a.x;
    a.vy = ny - a.y;
    a.x = nx;
    a.y = ny;
  } else {
    a.heading += Math.PI * 0.75;
  }
  a.actionTicks++;
}
