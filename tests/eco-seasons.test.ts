/**
 * Regression test (eco audit): a population on ordinary land grows, becomes food-limited and gets
 * through its first winter with a seasonal dip instead of the old boom-and-crash. Previously every
 * preset boomed to its population cap and then lost 80–95 % of its members in the first winter
 * (e.g. predators 1000 → 68, evolab 900 → 56), because births ignored the shrinking food supply
 * and land grazed bare stopped regrowing. A small world keeps this test fast.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import type { GenomeTemplate, ScenarioDef } from '../src/sim/types';

const folk = (hue: number): GenomeTemplate => ({
  speed: 0.5, size: 0.5, perception: 0.55, metabolism: 0.5, aggression: 0.2, sociability: 0.7,
  altruism: 0.55, fertility: 0.6, longevity: 0.5, immunity: 0.5, efficiency: 0.55, hue, spread: 0.07,
});

const SMALL_WORLD: ScenarioDef = {
  id: 'eco-seasons',
  name: 'Seasons regression',
  tagline: '',
  description: '',
  lookFor: [],
  config: { worldWidth: 110, worldHeight: 70, maxAgents: 700, disasterRate: 0 },
  world: { waterLevel: 0.25, desertLevel: 0.1, mountainLevel: 0.08 },
  populations: [
    { x: 260, y: 280, count: 45, radius: 60, template: folk(0.3), tribe: 'new', tribeName: 'West' },
    { x: 620, y: 280, count: 45, radius: 60, template: folk(0.6), tribe: 'new', tribeName: 'East' },
  ],
  scheduled: [],
};

describe('seasonal population dynamics', () => {
  it('stays food-limited below the cap and survives the first winter without a crash', () => {
    const sim = Simulation.create({ scenario: SMALL_WORLD, seed: 7 });
    const day = sim.config.dayLength;
    const pop: number[] = [sim.state.agents.length];
    let lowest = Infinity;
    let births = 0;
    for (let d = 1; d <= 13; d++) {
      for (let t = 0; t < day; t++) {
        sim.step();
        if (d >= 9 && sim.state.agents.length < lowest) lowest = sim.state.agents.length;
      }
      if (d === 12) births = sim.state.stats.totals.births;
      pop.push(sim.state.agents.length);
    }
    const peak = Math.max(...pop.slice(0, 10)); // spring → end of autumn / early winter
    const lateBirths = sim.state.stats.totals.births - births;
    // eslint-disable-next-line no-console
    console.log(`eco-seasons: daily population ${pop.join(' ')}; peak ${peak}, winter low ${lowest}, day-13 births ${lateBirths}`);
    expect(peak).toBeGreaterThan(pop[0]); // it does grow
    expect(peak).toBeLessThan(sim.config.maxAgents); // limited by food, not by the cap
    expect(lowest).toBeGreaterThanOrEqual(0.5 * peak); // a seasonal dip, not a crash
    expect(lateBirths).toBeGreaterThan(0); // and it breeds again in spring
  }, 120_000);
});
