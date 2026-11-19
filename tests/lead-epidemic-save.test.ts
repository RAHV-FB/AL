import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { getScenario } from '../src/sim/presets';
import { deserializeState, serializeSim } from '../src/sim/persistence';

/** Regression: an epidemic's summary ("N died, peak M") must be the same after save → load mid-epidemic. */
describe('epidemic log survives save/load', () => {
  it('plague-island saved mid-epidemic reports the same epidemic summary and full hash', () => {
    const orig = Simulation.create({ scenario: getScenario('plague-island'), seed: 42 });
    orig.run(1950);
    const loaded = Simulation.fromState(deserializeState(serializeSim(orig)));
    orig.run(2400);
    loaded.run(2400);
    const disease = (s: Simulation) => s.state.events.filter((e) => e.category === 'disease').map((e) => `${e.tick}:${e.message}`);
    expect(disease(loaded)).toEqual(disease(orig));
    expect(loaded.hash()).toBe(orig.hash());
  }, 240_000);
});
