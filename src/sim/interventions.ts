// OWNER: Simulation Core agent. STUB — replace with the full implementation.
import type { Simulation } from './simulation';
import type { Intervention } from './types';
import { randomGenes } from './genetics';
import { createAgent } from './lifecycle';
import { foundTribe } from './social';

/** Apply one intervention immediately (called by Simulation at tick start). Must be deterministic. */
export function applyIntervention(sim: Simulation, iv: Intervention): void {
  switch (iv.kind) {
    case 'spawn': {
      const made = [];
      for (let i = 0; i < iv.count && sim.canSpawn(); i++) {
        const ang = sim.rng.next() * Math.PI * 2;
        const r = Math.sqrt(sim.rng.next()) * iv.radius;
        const x = sim.clampX(iv.x + Math.cos(ang) * r);
        const y = sim.clampY(iv.y + Math.sin(ang) * r);
        if (!sim.passableAt(x, y)) continue;
        const a = createAgent(sim, { x, y, genes: randomGenes(sim.rng, iv.template), age: 700 });
        sim.addAgent(a);
        made.push(a);
      }
      if (iv.tribe === 'new' && made.length) foundTribe(sim, made[0], made.slice(1), iv.tribeName);
      break;
    }
    default:
      break;
  }
}
