/**
 * Panel labels must agree with the top-bar clock (headless: the panels' helpers are pure).
 * The clock shows `Day ${env.day + 1}`; the event log, inspector life story / death banner and
 * the population KPI label ticks with dayOfTick().
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { dayOfTick } from '../src/ui/analytics';

describe('day labels', () => {
  it('dayOfTick(tick) is the day the clock showed at that tick, across several days', () => {
    const eden = SCENARIOS.find((s) => s.id === 'eden') ?? SCENARIOS[0];
    const sim = Simulation.create({ scenario: eden, seed: 7, config: { dayLength: 60 } });
    let crossed = 0;
    let prev = Math.floor(sim.state.env.day);
    for (let i = 0; i < 300; i++) {
      const t = sim.tick;
      sim.step(); // the environment clock is computed for tick t at the start of the step
      const clockDay = Math.floor(sim.state.env.day) + 1;
      expect(dayOfTick(sim, t), `tick ${t}`).toBe(clockDay);
      if (clockDay - 1 !== prev) crossed++;
      prev = clockDay - 1;
    }
    expect(crossed).toBeGreaterThanOrEqual(4); // the check spanned several midnights
  });

  it('the first moment of an experiment is Day 1, like the clock', () => {
    const sim = Simulation.create({ scenario: SCENARIOS[0], seed: 1 });
    expect(dayOfTick(sim, 0)).toBe(1);
  });
});
