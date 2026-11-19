/**
 * Regression tests (eco audit): statistics event log. Generation records are announced once, the
 * first time the ALL-TIME maximum generation reaches them (not again when the top lineage dies out
 * and the milestone is later re-reached), and every 10th generation is announced only once — by
 * genetics.reproduce at the birth — instead of a second, near-identical stats 'record' event.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { GENERATION_MILESTONES, compactSamples } from '../src/sim/stats';

const records = (sim: Simulation, gen: number) =>
  sim.state.events.filter((e) => e.category === 'record' && e.message.startsWith(`Generation ${gen} reached`)).length;

function frozenSim(): Simulation {
  const sim = Simulation.create({ scenario: SCENARIOS[0], seed: 5 });
  sim.run(61); // a couple of samples
  sim.state.config.maxAgents = sim.state.agents.length; // no births: generations change only when we say so
  sim.state.config.disasterRate = 0;
  for (const a of sim.state.agents) a.generation = 1;
  sim.run(30);
  return sim;
}

describe('stats: generation records', () => {
  it('announces a generation milestone once, even if the max generation dips and recovers', () => {
    const sim = frozenSim();
    const [a, b] = sim.state.agents;
    a.generation = 5;
    sim.run(30);
    expect(records(sim, 5)).toBe(1);
    a.generation = 4; // the only generation-5 lineage "dies out" …
    sim.run(60);
    b.generation = 5; // … and generation 5 is reached again later
    sim.run(60);
    expect(records(sim, 5)).toBe(1);
  });

  it('does not duplicate the every-10th-generation announcement made by genetics', () => {
    expect(GENERATION_MILESTONES.some((m) => m % 10 === 0)).toBe(false);
    const sim = frozenSim();
    sim.state.agents[0].generation = 10;
    sim.run(30);
    expect(records(sim, 10)).toBe(0);
  });

  it('keeps the all-time max generation through sample compaction', () => {
    const sim = frozenSim();
    sim.state.agents[0].generation = 5;
    sim.run(30);
    sim.state.agents[0].generation = 1;
    sim.run(30 * 10);
    compactSamples(sim.state.stats.samples, 4); // merge everything old
    sim.state.agents[1].generation = 5;
    sim.run(60);
    expect(records(sim, 5)).toBe(1);
  });
});
