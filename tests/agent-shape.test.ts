import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { getScenario } from '../src/sim/presets';
import { deserializeState, serializeSim } from '../src/sim/persistence';
import { createAgent } from '../src/sim/lifecycle';
import { randomGenes } from '../src/sim/genetics';

/**
 * Performance guard: every agent — live, newborn, routed, migrating or loaded from a save — must share one
 * V8 hidden class with fast (non-dictionary) properties. Mixed shapes made every tick 30–160% slower.
 * Needs node's --allow-natives-syntax (set in vitest.config.ts); skipped if the runtime refuses it.
 */
type Native = (a: object, b?: object) => boolean;
let hasFast: Native | null = null;
let sameMap: Native | null = null;
try {
  hasFast = new Function('o', 'return %HasFastProperties(o)') as Native;
  sameMap = new Function('a', 'b', 'return %HaveSameMap(a, b)') as Native;
} catch {
  hasFast = sameMap = null;
}

describe.skipIf(!hasFast)('agent object shapes (V8)', () => {
  it('live agents, after routing and migration, and loaded agents all share createAgent’s fast map', () => {
    const sim = Simulation.create({ scenario: getScenario('plague-island'), seed: 42 });
    sim.run(2500);
    const ref = createAgent(sim, { x: 100, y: 100, genes: randomGenes(sim.rng) });
    const live = sim.state.agents;
    expect(live.some((a) => a.route !== undefined)).toBe(true);
    for (const a of live) {
      expect(hasFast!(a)).toBe(true);
      expect(sameMap!(a, ref)).toBe(true);
    }
    const loaded = Simulation.fromState(deserializeState(serializeSim(sim)));
    for (const a of loaded.state.agents) {
      expect(hasFast!(a), 'loaded agent has fast properties').toBe(true);
      expect(sameMap!(a, ref), 'loaded agent shares the live map').toBe(true);
    }
  }, 120_000);
});
