import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { createAgent } from '../src/sim/lifecycle';
import { randomGenes } from '../src/sim/genetics';
import { DISEASE, infect, infectedCount, updateDisease } from '../src/sim/disease';
import { TERRAIN, type Agent, type ScenarioDef, type SimConfig } from '../src/sim/types';

const SCENARIO: ScenarioDef = {
  id: 'disease-test',
  name: 'Disease test',
  tagline: '',
  description: '',
  lookFor: [],
  config: {},
  world: {},
  populations: [],
  scheduled: [],
};

function makeSim(cfg: Partial<SimConfig> = {}, seed = 1): Simulation {
  const sim = Simulation.create({ scenario: SCENARIO, seed, config: { disasterRate: 0, ...cfg } });
  const w = sim.state.world;
  w.terrain.fill(TERRAIN.Grass);
  w.food.fill(5);
  return sim;
}

/** Healthy, well-fed adult at (x,y) with the given immunity trait. */
function addAgent(sim: Simulation, x: number, y: number, immunity = 0.5): Agent {
  const a = createAgent(sim, { x, y, genes: randomGenes(sim.rng) });
  a.age = a.traits.maturityAge;
  a.traits.immunity = immunity;
  a.health = a.traits.maxHealth;
  a.food = a.traits.maxFood;
  sim.addAgent(a);
  return a;
}

/** Advance only the disease system (agents stay put; other modules are not involved). */
function diseaseTick(sim: Simulation): void {
  sim.spatial.rebuild(sim.state.agents);
  updateDisease(sim);
  sim.state.tick++;
}

describe('disease: infection', () => {
  it('respects acquired immunity and current infection', () => {
    const sim = makeSim();
    const a = addAgent(sim, 100, 100);
    a.immuneTicks = 50;
    expect(infect(sim, a, 0.5)).toBe(false);
    expect(a.infection).toBe(0);

    a.immuneTicks = 0;
    expect(infect(sim, a, 0.5)).toBe(true);
    expect(a.infection).toBeGreaterThan(0);
    expect(a.infection).toBeLessThanOrEqual(DISEASE.durationMax);
    expect(a.virulence).toBeCloseTo(0.5);

    const remaining = a.infection;
    expect(infect(sim, a, 0.9)).toBe(false);
    expect(a.infection).toBe(remaining);
    expect(a.virulence).toBeCloseTo(0.5);

    const b = addAgent(sim, 300, 300);
    expect(infect(sim, b, 0)).toBe(false);
    expect(infect(sim, b, NaN)).toBe(false);
    expect(infect(sim, b, 7)).toBe(true);
    expect(b.virulence).toBe(1);
  });

  it('immunity shortens infections', () => {
    const sim = makeSim();
    let low = 0;
    let high = 0;
    for (let i = 0; i < 60; i++) {
      const a = addAgent(sim, 20 + i * 20, 100, 0);
      const b = addAgent(sim, 20 + i * 20, 300, 1);
      infect(sim, a, 0.5);
      infect(sim, b, 0.5);
      low += a.infection;
      high += b.infection;
    }
    expect(high).toBeLessThan(low * 0.8);
  });
});

describe('disease: transmission', () => {
  it('spreads between close agents but not to distant ones', () => {
    const sim = makeSim({ diseaseVirulence: 2 });
    const src = addAgent(sim, 400, 400);
    const near = addAgent(sim, 404, 400, 0);
    const far = addAgent(sim, 460, 400, 0);
    infect(sim, src, 1);
    src.infection = 1e6;
    for (let t = 0; t < 400 && near.infection === 0; t++) {
      src.health = src.traits.maxHealth;
      diseaseTick(sim);
    }
    expect(near.infection).toBeGreaterThan(0);
    expect(near.virulence).toBeGreaterThanOrEqual(1 - DISEASE.mutation - 1e-9);
    expect(far.infection).toBe(0);
  });

  it('does not spread when config.diseaseVirulence is 0', () => {
    const sim = makeSim({ diseaseVirulence: 0 });
    const src = addAgent(sim, 400, 400);
    const near = addAgent(sim, 403, 400, 0);
    src.infection = 1e6;
    src.virulence = 1;
    for (let t = 0; t < 300; t++) {
      src.health = src.traits.maxHealth;
      diseaseTick(sim);
    }
    expect(near.infection).toBe(0);
  });

  it('mutates strain virulence slightly on each transmission', () => {
    const sim = makeSim({ diseaseVirulence: 2 }, 5);
    const src = addAgent(sim, 800, 500);
    src.infection = 1e6;
    src.virulence = 0.5;
    const targets: Agent[] = [];
    for (let i = 0; i < 24; i++) {
      const ang = (i / 24) * Math.PI * 2;
      targets.push(addAgent(sim, 800 + Math.cos(ang) * 5, 500 + Math.sin(ang) * 5, 0));
    }
    const strains: number[] = [];
    for (let t = 0; t < 600 && strains.length < 15; t++) {
      src.health = src.traits.maxHealth;
      diseaseTick(sim);
      for (const a of targets) {
        if (a.infection > 0) {
          // record first-generation strain, then isolate it (no onward chains)
          strains.push(a.virulence);
          a.infection = 0;
          a.virulence = 0;
          a.immuneTicks = 1e9;
        }
      }
    }
    expect(strains.length).toBeGreaterThanOrEqual(10);
    for (const v of strains) expect(Math.abs(v - 0.5)).toBeLessThanOrEqual(DISEASE.mutation + 1e-9);
    expect(new Set(strains.map((v) => v.toFixed(6))).size).toBeGreaterThan(1);
  });
});

describe('disease: progression', () => {
  it('recovery grants temporary immunity', () => {
    const sim = makeSim();
    const a = addAgent(sim, 500, 500);
    expect(infect(sim, a, 0.3)).toBe(true);
    a.infection = 1;
    diseaseTick(sim);
    expect(a.alive).toBe(true);
    expect(a.infection).toBe(0);
    expect(a.virulence).toBe(0);
    expect(a.immuneTicks).toBeGreaterThanOrEqual(DISEASE.immuneMin);
    expect(a.immuneTicks).toBeLessThanOrEqual(DISEASE.immuneMax);
    expect(infect(sim, a, 0.5)).toBe(false);
    const it0 = a.immuneTicks;
    diseaseTick(sim);
    expect(a.immuneTicks).toBe(it0 - 1);
    expect(a.history.some((h) => h.text.includes('Recovered'))).toBe(true);
  });

  it('disease deaths use cause "disease"', () => {
    const sim = makeSim();
    const a = addAgent(sim, 500, 500);
    infect(sim, a, 1);
    a.health = 0.01;
    const before = sim.state.stats.counters.deathsByCause.disease ?? 0;
    diseaseTick(sim);
    expect(a.alive).toBe(false);
    expect(a.deathCause).toBe('disease');
    expect(sim.state.stats.counters.deathsByCause.disease).toBe(before + 1);
    expect(sim.state.agents.includes(a)).toBe(false);
  });

  it('untreated mortality at virulence 0.6 / average immunity is moderate', () => {
    const sim = makeSim({ diseaseVirulence: 0.5 }, 3);
    const pop: Agent[] = [];
    for (let i = 0; i < 300; i++) {
      const a = addAgent(sim, 20 + (i % 20) * 60, 20 + Math.floor(i / 20) * 60, 0.5);
      infect(sim, a, 0.6);
      pop.push(a);
    }
    for (let t = 0; t < 1000; t++) diseaseTick(sim);
    const dead = pop.filter((a) => !a.alive);
    const mortality = dead.length / pop.length;
    expect(mortality).toBeGreaterThan(0.15);
    expect(mortality).toBeLessThan(0.55);
    for (const a of dead) expect(a.deathCause).toBe('disease');
    for (const a of pop.filter((p) => p.alive)) {
      expect(a.infection).toBe(0);
      expect(a.immuneTicks).toBeGreaterThan(0);
      expect(Number.isFinite(a.health) && Number.isFinite(a.energy)).toBe(true);
      expect(a.energy).toBeGreaterThanOrEqual(0);
    }
    expect(infectedCount(sim)).toBe(0);
  });

  it('higher immunity means fewer deaths', () => {
    const sim = makeSim({ diseaseVirulence: 0.5 }, 9);
    const weak: Agent[] = [];
    const strong: Agent[] = [];
    for (let i = 0; i < 150; i++) {
      const a = addAgent(sim, 20 + (i % 20) * 60, 20 + Math.floor(i / 20) * 60, 0.1);
      const b = addAgent(sim, 50 + (i % 20) * 60, 50 + Math.floor(i / 20) * 60, 0.9);
      infect(sim, a, 0.7);
      infect(sim, b, 0.7);
      weak.push(a);
      strong.push(b);
    }
    for (let t = 0; t < 1000; t++) diseaseTick(sim);
    const deadWeak = weak.filter((a) => !a.alive).length;
    const deadStrong = strong.filter((a) => !a.alive).length;
    expect(deadStrong).toBeLessThan(deadWeak);
  });

  it('is NaN-safe with corrupt inputs', () => {
    const sim = makeSim();
    const a = addAgent(sim, 500, 500);
    a.infection = 100;
    a.virulence = NaN;
    a.traits.immunity = NaN;
    a.immuneTicks = NaN;
    const b = addAgent(sim, 503, 500);
    b.immuneTicks = -5;
    for (let t = 0; t < 20; t++) diseaseTick(sim);
    for (const x of [a, b]) {
      expect(Number.isFinite(x.health)).toBe(true);
      expect(Number.isFinite(x.energy)).toBe(true);
      expect(Number.isFinite(x.virulence)).toBe(true);
      expect(Number.isFinite(x.immuneTicks)).toBe(true);
    }
    expect(a.virulence).toBeGreaterThanOrEqual(DISEASE.minVirulence);
    expect(b.immuneTicks).toBe(0);
  });
});

describe('disease: epidemic tracking', () => {
  it('logs when an epidemic takes off and when it burns out', () => {
    const sim = makeSim();
    const pop: Agent[] = [];
    for (let i = 0; i < 15; i++) {
      const a = addAgent(sim, 30 + i * 80, 300);
      infect(sim, a, 0.3);
      pop.push(a);
    }
    expect(infectedCount(sim)).toBe(15);
    diseaseTick(sim);
    expect(sim.state.events.some((e) => e.category === 'disease' && e.message.startsWith('Epidemic spreading: 15'))).toBe(true);
    for (const a of pop) a.infection = 1;
    diseaseTick(sim);
    expect(infectedCount(sim)).toBe(0);
    expect(sim.state.events.some((e) => e.category === 'disease' && e.message.includes('burned out — 0 died'))).toBe(true);
  });

  it('is deterministic for identical seeds', () => {
    const run = () => {
      const sim = makeSim({ diseaseVirulence: 1 }, 11);
      for (let i = 0; i < 80; i++) addAgent(sim, 700 + (i % 10) * 6, 450 + Math.floor(i / 10) * 6, (i % 7) / 7);
      infect(sim, sim.state.agents[0], 0.6);
      for (let t = 0; t < 600; t++) diseaseTick(sim);
      return sim.state.agents.map((a) => `${a.id}:${a.infection}:${a.virulence.toFixed(6)}:${a.health.toFixed(4)}:${a.immuneTicks}`).join('|');
    };
    expect(run()).toBe(run());
  });
});
