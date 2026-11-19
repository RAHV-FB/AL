/**
 * UI verifier regression tests (headless). The Stats charts' "Day N" x axis must use the same
 * calendar as the top-bar clock and the event log (it used tick / dayLength: 0-based and without
 * the clock's DAY_START offset, so an event the log dated "Day 7" was plotted at "Day 6.6").
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { dayOfTick, dayPosOfTick } from '../src/ui/analytics';

describe('chart day axis', () => {
  it('floor(dayPosOfTick) is the day the clock showed, across several midnights', () => {
    const eden = SCENARIOS.find((s) => s.id === 'eden') ?? SCENARIOS[0];
    const sim = Simulation.create({ scenario: eden, seed: 11, config: { dayLength: 50 } });
    let midnights = 0;
    let prev = -1;
    for (let i = 0; i < 260; i++) {
      const t = sim.tick;
      sim.step(); // the clock (env) is computed for tick t during this step
      const clockDay = Math.floor(sim.state.env.day) + 1;
      const pos = dayPosOfTick(sim, t);
      expect(Math.floor(pos), `tick ${t}`).toBe(clockDay);
      expect(Math.floor(pos)).toBe(dayOfTick(sim, t));
      // the fraction is the clock's time of day
      expect(pos - Math.floor(pos)).toBeCloseTo(sim.state.env.timeOfDay, 9);
      if (prev !== -1 && clockDay !== prev) midnights++;
      prev = clockDay;
    }
    expect(midnights).toBeGreaterThanOrEqual(4);
  });

  it('is monotonic and exact at day boundaries for the default day length', () => {
    const sim = Simulation.create({ scenario: SCENARIOS[0], seed: 3 });
    const dl = sim.config.dayLength;
    let last = -Infinity;
    for (let t = 0; t < dl * 5; t++) {
      const p = dayPosOfTick(sim, t);
      expect(p).toBeGreaterThan(last);
      expect(Math.floor(p)).toBe(dayOfTick(sim, t));
      last = p;
    }
    expect(dayPosOfTick(sim, 0)).toBeGreaterThanOrEqual(1); // the experiment starts on Day 1, like the clock
  });
});
