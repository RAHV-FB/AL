import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';

describe('smoke', () => {
  it('runs every scenario for 1500 ticks without throwing or producing NaN', () => {
    for (const sc of SCENARIOS) {
      const sim = Simulation.create({ scenario: sc, seed: 42 });
      sim.run(1500);
      for (const a of sim.state.agents) {
        expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
        expect(Number.isFinite(a.health) && Number.isFinite(a.food) && Number.isFinite(a.energy)).toBe(true);
      }
      for (let i = 0; i < sim.state.world.food.length; i++) {
        const f = sim.state.world.food[i];
        if (!(f >= 0) || !Number.isFinite(f)) throw new Error(`bad food at ${i}: ${f}`);
      }
    }
  });

  it('is deterministic for identical seeds', () => {
    const a = Simulation.create({ scenario: SCENARIOS[0], seed: 7 });
    const b = Simulation.create({ scenario: SCENARIOS[0], seed: 7 });
    a.run(800);
    b.run(800);
    expect(a.hash()).toBe(b.hash());
  });
});
