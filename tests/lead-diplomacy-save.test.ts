import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { getScenario } from '../src/sim/presets';
import { deserializeState, serializeSim } from '../src/sim/persistence';

const diplomacyEvents = (sim: Simulation) =>
  sim.state.events.filter((e) => e.category === 'conflict' || e.category === 'tribe').map((e) => `${e.tick}:${e.message}`);

/** Regression: war / alliance / first-blood announcements must not repeat or vanish after save → load. */
describe('diplomacy log survives save/load', () => {
  it('a loaded two-civs run announces exactly the same conflicts as the original', () => {
    const orig = Simulation.create({ scenario: getScenario('two-civs'), seed: 42 });
    orig.run(2700);
    const loaded = Simulation.fromState(deserializeState(serializeSim(orig)));
    orig.run(1500);
    loaded.run(1500);
    expect(loaded.hash({ events: false })).toBe(orig.hash({ events: false }));
    expect(diplomacyEvents(loaded)).toEqual(diplomacyEvents(orig));
    expect(loaded.state.diplomacy).toEqual(orig.state.diplomacy);
  }, 180_000);
});
