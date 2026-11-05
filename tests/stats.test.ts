import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { LIMITS } from '../src/sim/constants';
import { GENE_COUNT, HIST_BINS, type StatsSample } from '../src/sim/types';
import { compactSamples, createStatsState, currentSummary, mergeSamples, updateStats } from '../src/sim/stats';

function fakeSample(tick: number, pop: number, births = 1, deaths = 0): StatsSample {
  const hist = new Array<number>(GENE_COUNT * HIST_BINS).fill(0);
  for (let g = 0; g < GENE_COUNT; g++) hist[g * HIST_BINS + 5] = pop;
  return {
    tick,
    population: pop,
    births,
    deaths,
    deathsByCause: { starvation: deaths, old_age: 0, combat: 0, disease: 0, disaster: 0, removed: 0 },
    avgHealth: 0.5,
    avgEnergy: 0.5,
    avgHunger: 0.5,
    avgAge: 100,
    totalFood: 1000,
    avgFertility: 0.8,
    infected: 0,
    tribeCount: 1,
    meanGeneration: 1,
    maxGeneration: Math.floor(tick / 100),
    geneMeans: new Array(GENE_COUNT).fill(0.5),
    geneStd: new Array(GENE_COUNT).fill(0.1),
    geneHist: hist,
    tribePops: [[1, pop]],
    roles: { none: pop, forager: 0, warrior: 0, caretaker: 0, explorer: 0 },
    actions: { wander: pop },
    fights: 1,
    shares: 2,
  };
}

const newSim = (seed = 3) => Simulation.create({ scenario: SCENARIOS[0], seed });

describe('stats', () => {
  it('creates an empty, JSON-serialisable state', () => {
    const st = createStatsState();
    expect(st.sampleInterval).toBe(30);
    expect(st.samples).toEqual([]);
    expect(JSON.parse(JSON.stringify(st))).toEqual(st);
  });

  it('samples every sampleInterval ticks with consistent aggregates', () => {
    const sim = newSim();
    sim.run(301);
    const st = sim.state.stats;
    expect(st.samples.length).toBe(11); // ticks 0, 30, …, 300
    st.samples.forEach((s, i) => expect(s.tick).toBe(i * 30));
    const last = st.samples[st.samples.length - 1];
    expect(last.population).toBe(sim.state.agents.length);
    for (let g = 0; g < GENE_COUNT; g++) {
      let sum = 0;
      for (let b = 0; b < HIST_BINS; b++) sum += last.geneHist[g * HIST_BINS + b];
      expect(sum).toBe(last.population);
      expect(last.geneMeans[g]).toBeGreaterThanOrEqual(0);
      expect(last.geneMeans[g]).toBeLessThanOrEqual(1);
      expect(last.geneStd[g]).toBeGreaterThanOrEqual(0);
    }
    expect(last.avgHealth).toBeGreaterThanOrEqual(0);
    expect(last.avgHealth).toBeLessThanOrEqual(1);
    const roleSum = Object.values(last.roles).reduce((a, b) => a + b, 0);
    expect(roleSum).toBe(last.population);
    const actSum = Object.values(last.actions).reduce((a, b) => a + (b ?? 0), 0);
    expect(actSum).toBe(last.population);
    const tribeSum = last.tribePops.reduce((a, [, m]) => a + m, 0);
    expect(tribeSum).toBeLessThanOrEqual(last.population);
    expect(last.tribeCount).toBe(last.tribePops.length);
    expect(last.totalFood).toBeGreaterThan(0);
    expect(st.totals.peakPopulation).toBeGreaterThanOrEqual(last.population);
    // flows: samples + live counters account for every birth/death
    const births = st.samples.reduce((a, s) => a + s.births, 0) + st.counters.births;
    const deaths = st.samples.reduce((a, s) => a + s.deaths, 0) + st.counters.deaths;
    expect(births).toBe(st.totals.births);
    expect(deaths).toBe(st.totals.deaths);
    for (const s of st.samples) {
      const byCause = Object.values(s.deathsByCause).reduce((a, b) => a + b, 0);
      expect(byCause).toBe(s.deaths);
    }
  });

  it('never consumes the simulation RNG and is deterministic', () => {
    const sim = newSim();
    sim.run(60);
    const before = JSON.stringify(sim.rng.getState());
    updateStats(sim);
    updateStats(sim);
    expect(JSON.stringify(sim.rng.getState())).toBe(before);
    const a = newSim(9);
    const b = newSim(9);
    a.run(400);
    b.run(400);
    expect(JSON.stringify(a.state.stats)).toBe(JSON.stringify(b.state.stats));
  });

  it('merges oldest samples to stay within the cap, conserving flows', () => {
    const samples: StatsSample[] = [];
    for (let i = 0; i < 2501; i++) samples.push(fakeSample(i * 30, 100 + (i % 7), 2, 1));
    const birthsBefore = samples.reduce((a, s) => a + s.births, 0);
    const lastBefore = samples[samples.length - 1];
    compactSamples(samples, 1200);
    expect(samples.length).toBeLessThanOrEqual(1200);
    expect(samples.reduce((a, s) => a + s.births, 0)).toBe(birthsBefore);
    expect(samples[samples.length - 1]).toBe(lastBefore); // recent history untouched
    for (let i = 1; i < samples.length; i++) expect(samples[i].tick).toBeGreaterThan(samples[i - 1].tick);
    const m = mergeSamples(fakeSample(30, 100, 3, 2), fakeSample(60, 200, 4, 1));
    expect(m.tick).toBe(60);
    expect(m.births).toBe(7);
    expect(m.deathsByCause.starvation).toBe(3);
    expect(m.population).toBe(150);
    expect(m.tribePops).toEqual([[1, 150]]);
    expect(m.maxGeneration).toBe(0);
    expect(LIMITS.statSamples).toBeGreaterThan(10);
  });

  it('logs crash and extinction events', () => {
    const sim = newSim();
    sim.run(330);
    const agents = [...sim.state.agents];
    const toKill = Math.ceil(agents.length * 0.7);
    for (let i = 0; i < toKill; i++) sim.killAgent(agents[i], 'disaster');
    sim.run(31);
    const pop = sim.state.events.filter((e) => e.category === 'population');
    expect(pop.some((e) => /crash/i.test(e.message))).toBe(true);
    for (const a of [...sim.state.agents]) sim.killAgent(a, 'disaster');
    sim.run(31);
    expect(sim.state.events.some((e) => /extinction/i.test(e.message))).toBe(true);
    const crashes = sim.state.events.filter((e) => /crash/i.test(e.message)).length;
    expect(crashes).toBe(1); // debounced
  });

  it('logs an evolution event when a gene mean drifts', () => {
    const sim = newSim();
    sim.run(20 * 30 + 1);
    for (const a of sim.state.agents) a.genes[0] = Math.min(1, a.genes[0] + 0.35);
    sim.run(31);
    const evo = sim.state.events.filter((e) => e.category === 'evolution' && /speed/.test(e.message));
    expect(evo.length).toBe(1);
    expect(evo[0].message).toMatch(/risen/);
  });

  it('summarises live numbers', () => {
    const sim = newSim();
    sim.run(200);
    const s = currentSummary(sim);
    expect(s.population).toBe(sim.state.agents.length);
    expect(s.birthsPerDay).toBeGreaterThanOrEqual(0);
    expect(s.avgHealth).toBeGreaterThanOrEqual(0);
    expect(s.avgHealth).toBeLessThanOrEqual(1);
  });
});
