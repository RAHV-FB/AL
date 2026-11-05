import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { LIMITS } from '../src/sim/constants';
import { basalBurn, expressTraits } from '../src/sim/genetics';
import { addHistory, createAgent, growthFactor, isAdult, senescence, updateVitals, VITALS, type CreateAgentOpts } from '../src/sim/lifecycle';
import { GENE_COUNT, G, NONE, TERRAIN, type Agent, type GeneName, type ScenarioDef, type SimConfig } from '../src/sim/types';

const TEST_SCENARIO: ScenarioDef = {
  id: 'lifecycle-test',
  name: 'Lifecycle test',
  tagline: '',
  description: '',
  lookFor: [],
  config: { worldWidth: 60, worldHeight: 40, disasterRate: 0 },
  world: { island: false, divide: 'none' },
  populations: [],
  scheduled: [],
};

function makeSim(config: Partial<SimConfig> = {}): Simulation {
  const sim = Simulation.create({ scenario: TEST_SCENARIO, seed: 2, config });
  sim.state.world.terrain.fill(TERRAIN.Grass);
  sim.state.env.temperature = 15;
  sim.state.env.daylight = 1;
  return sim;
}

function genome(v = 0.5, overrides: Partial<Record<GeneName, number>> = {}): number[] {
  const g = new Array<number>(GENE_COUNT).fill(v);
  for (const [k, val] of Object.entries(overrides)) g[G[k as GeneName]] = val as number;
  return g;
}

function spawnAdult(sim: Simulation, genes = genome(), extra: Partial<CreateAgentOpts> = {}): Agent {
  const a = createAgent(sim, { x: 200, y: 160, genes, age: 1500, food: 1e9, ...extra });
  sim.addAgent(a);
  return a;
}

/** Run updateVitals until death (or maxTicks); `each` runs before every tick. Returns ticks survived. */
function liveOut(sim: Simulation, a: Agent, maxTicks: number, each?: (a: Agent) => void): number {
  let n = 0;
  while (a.alive && n < maxTicks) {
    each?.(a);
    updateVitals(sim, a);
    n++;
  }
  return n;
}

/** Food burned in one tick under the given conditions. */
function burnOnce(sim: Simulation, a: Agent): number {
  const before = a.food;
  updateVitals(sim, a);
  return before - a.food;
}

describe('createAgent / growth', () => {
  it('initialises every field with finite, valid values', () => {
    const sim = makeSim();
    const a = createAgent(sim, { x: 10, y: 20, genes: genome(0.5) });
    expect(a.alive).toBe(true);
    expect(a.age).toBe(0);
    expect(a.parents).toEqual([NONE, NONE]);
    expect(a.health).toBe(a.traits.maxHealth);
    expect(a.food).toBeCloseTo(a.traits.maxFood * 0.7);
    expect(a.energy).toBe(1);
    expect(a.reproCooldown).toBe(0);
    expect(a.sinceMeal).toBe(0);
    expect(a.deathTick).toBe(-1);
    expect(a.deathCause).toBeNull();
    expect(Number.isNaN(a.targetX)).toBe(true);
    for (const [k, v] of Object.entries(a)) if (typeof v === 'number' && k !== 'targetX' && k !== 'targetY') expect(Number.isFinite(v), k).toBe(true);
  });

  it('sanitises genes and options; founders can start older', () => {
    const sim = makeSim();
    sim.state.tick = 50;
    const a = createAgent(sim, { x: 1, y: 1, genes: [2, -1, NaN], age: 900, food: 1e6, tribeId: 3, generation: 2 });
    expect(a.genes).toHaveLength(GENE_COUNT);
    expect(a.genes.slice(0, 3)).toEqual([1, 0, 0.5]);
    expect(a.food).toBe(a.traits.maxFood);
    expect(a.age).toBe(900);
    expect(a.birthTick).toBe(50 - 900);
    expect(a.tribeId).toBe(3);
    expect(a.generation).toBe(2);
  });

  it('grows from half size to adult over maturityAge', () => {
    const sim = makeSim();
    const a = createAgent(sim, { x: 1, y: 1, genes: genome(0.5) });
    expect(growthFactor(a)).toBe(0.5);
    expect(isAdult(a)).toBe(false);
    a.age = a.traits.maturityAge / 2;
    expect(growthFactor(a)).toBeCloseTo(0.75);
    a.age = a.traits.maturityAge;
    expect(growthFactor(a)).toBe(1);
    expect(isAdult(a)).toBe(true);
    a.age = 1e6;
    expect(growthFactor(a)).toBe(1);
  });

  it('caps the life history', () => {
    const sim = makeSim();
    const a = createAgent(sim, { x: 1, y: 1, genes: genome() });
    for (let i = 0; i < 50; i++) addHistory(sim, a, `e${i}`);
    expect(a.history).toHaveLength(LIMITS.history);
    expect(a.history.at(-1)?.text).toBe('e49');
  });
});

describe('updateVitals', () => {
  it('ages, counts down cooldowns and time since last meal', () => {
    const sim = makeSim();
    const a = spawnAdult(sim);
    a.reproCooldown = 2;
    a.sinceMeal = 5;
    updateVitals(sim, a);
    expect(a.age).toBe(1501);
    expect(a.reproCooldown).toBe(1);
    expect(a.sinceMeal).toBe(6);
    updateVitals(sim, a);
    updateVitals(sim, a);
    expect(a.reproCooldown).toBe(0);
  });

  it('logs coming of age', () => {
    const sim = makeSim();
    const a = spawnAdult(sim, genome(), { age: 0 });
    a.age = a.traits.maturityAge - 1;
    updateVitals(sim, a);
    expect(a.history.some((h) => h.text.includes('Came of age'))).toBe(true);
  });

  it('an average adult with a full stomach starves after ~1200–1800 ticks without food', () => {
    const sim = makeSim();
    const idle = spawnAdult(sim);
    const tIdle = liveOut(sim, idle, 5000);
    expect(idle.alive).toBe(false);
    expect(idle.deathCause).toBe('starvation');
    expect(tIdle).toBeGreaterThan(1200);
    expect(tIdle).toBeLessThan(1800);

    const walker = spawnAdult(sim);
    const tWalk = liveOut(sim, walker, 5000, (a) => {
      a.action = 'wander';
      a.vx = a.traits.speed * 0.7;
      a.vy = 0;
    });
    expect(walker.deathCause).toBe('starvation');
    expect(tWalk).toBeGreaterThan(1200);
    expect(tWalk).toBeLessThan(tIdle);
  });

  it('starvation takes ~220 ticks from full health once the stomach is empty', () => {
    const sim = makeSim();
    const a = spawnAdult(sim);
    a.food = 0;
    const t = liveOut(sim, a, 1000);
    expect(a.deathCause).toBe('starvation');
    expect(t).toBeGreaterThan(180);
    expect(t).toBeLessThan(260);
  });

  it('harsher difficulty starves agents faster', () => {
    const easy = makeSim({ difficulty: 0.5 });
    const hard = makeSim({ difficulty: 2 });
    const tEasy = liveOut(easy, spawnAdult(easy), 10000);
    const tHard = liveOut(hard, spawnAdult(hard), 10000);
    expect(tHard).toBeLessThan(tEasy / 3);
  });

  it('charges basal burn, movement ∝ v²·size and less while resting', () => {
    const sim = makeSim();
    const a = spawnAdult(sim);
    a.action = 'idle';
    expect(burnOnce(sim, a)).toBeCloseTo(basalBurn(a.traits), 6);
    a.action = 'rest';
    expect(burnOnce(sim, a)).toBeCloseTo(basalBurn(a.traits) * VITALS.restBurn, 6);
    a.action = 'wander';
    a.vx = 1;
    a.vy = 0;
    const slow = burnOnce(sim, a);
    a.vx = 2;
    const fast = burnOnce(sim, a);
    expect(fast - basalBurn(a.traits)).toBeCloseTo(4 * (slow - basalBurn(a.traits)), 6);
    const big = spawnAdult(sim, genome(0.5, { size: 1 }));
    big.action = 'wander';
    big.vx = 2;
    expect(burnOnce(sim, big) - basalBurn(big.traits)).toBeGreaterThan(fast - basalBurn(a.traits));
  });

  it('juveniles burn less than adults of the same genome', () => {
    const sim = makeSim();
    const adult = spawnAdult(sim);
    const baby = spawnAdult(sim, genome(), { age: 0 });
    expect(burnOnce(sim, baby)).toBeLessThan(burnOnce(sim, adult) * 0.6);
  });

  it('cold costs food; big bodies, high metabolism and the tribe camp resist it', () => {
    const sim = makeSim();
    const warm = burnOnce(sim, spawnAdult(sim));
    sim.state.env.temperature = -2;
    const avg = spawnAdult(sim);
    const cold = burnOnce(sim, avg);
    expect(cold).toBeGreaterThan(warm * 1.2);
    const extraFor = (genes: number[]) => {
      const a = spawnAdult(sim, genes);
      return burnOnce(sim, a) - basalBurn(a.traits);
    };
    expect(extraFor(genome(0.5, { size: 1 }))).toBeLessThan(extraFor(genome(0.5, { size: 0 })));
    expect(extraFor(genome(0.5, { metabolism: 1 }))).toBeLessThan(extraFor(genome(0.5, { metabolism: 0 })));
    const tribe = sim.createTribe(null, 200, 160);
    const sheltered = spawnAdult(sim, genome(), { tribeId: tribe.id });
    expect(burnOnce(sim, sheltered) - basalBurn(sheltered.traits)).toBeCloseTo((cold - basalBurn(avg.traits)) / 2, 6);
  });

  it('stamina drains with movement and fighting, recovers with rest (faster at night and with metabolism)', () => {
    const sim = makeSim();
    const a = spawnAdult(sim);
    a.action = 'flee';
    a.vx = a.traits.speed;
    for (let i = 0; i < 100; i++) updateVitals(sim, a);
    const afterRun = a.energy;
    expect(afterRun).toBeLessThan(0.8);
    const f = spawnAdult(sim);
    f.action = 'attack';
    updateVitals(sim, f);
    expect(f.energy).toBeLessThan(1 - VITALS.energyFight);

    const recover = (genes: number[], daylight: number) => {
      sim.state.env.daylight = daylight;
      const r = spawnAdult(sim, genes);
      r.energy = 0.3;
      r.action = 'rest';
      updateVitals(sim, r);
      return r.energy - 0.3;
    };
    const day = recover(genome(), 1);
    expect(day).toBeGreaterThan(0.003);
    expect(recover(genome(), 0)).toBeGreaterThan(day);
    expect(recover(genome(0.5, { metabolism: 1 }), 1)).toBeGreaterThan(recover(genome(0.5, { metabolism: 0 }), 1));
  });

  it('heals when fed and rested (faster with metabolism), not when hungry', () => {
    const sim = makeSim();
    const healOnce = (genes: number[], foodFrac: number) => {
      const a = spawnAdult(sim, genes);
      a.health = a.traits.maxHealth * 0.5;
      a.food = a.traits.maxFood * foodFrac;
      updateVitals(sim, a);
      return a.health / a.traits.maxHealth - 0.5;
    };
    expect(healOnce(genome(), 0.9)).toBeGreaterThan(0.001);
    expect(healOnce(genome(), 0.2)).toBeLessThanOrEqual(0);
    expect(healOnce(genome(0.5, { metabolism: 1 }), 0.9)).toBeGreaterThan(healOnce(genome(0.5, { metabolism: 0 }), 0.9));
  });

  it('a starving agent eats the food it carries before taking damage', () => {
    const sim = makeSim();
    const a = spawnAdult(sim);
    a.food = 0;
    a.carried = 5;
    updateVitals(sim, a);
    expect(a.health).toBe(a.traits.maxHealth);
    expect(a.carried).toBeLessThan(5);
    expect(a.food).toBeGreaterThan(0);
  });

  it('well-fed agents die of old age between 85% and 100% of longevity', () => {
    for (const lon of [0, 0.5, 1]) {
      const sim = makeSim();
      const a = spawnAdult(sim, genome(0.5, { longevity: lon }));
      liveOut(sim, a, 20000, (x) => {
        x.food = x.traits.maxFood;
      });
      expect(a.deathCause).toBe('old_age');
      expect(a.age).toBeGreaterThanOrEqual(a.traits.longevity * 0.85);
      expect(a.age).toBeLessThanOrEqual(a.traits.longevity);
      expect(a.history.some((h) => h.text.includes('old age'))).toBe(true);
    }
  });

  it('typical lifespan of an average, fed genome is 4000–8000 ticks', () => {
    const sim = makeSim();
    const a = spawnAdult(sim, genome(), { age: 0 });
    const t = liveOut(sim, a, 20000, (x) => {
      x.food = x.traits.maxFood;
    });
    expect(t).toBeGreaterThan(4000);
    expect(t).toBeLessThan(8000);
  });

  it('senescence ramps from 80% of longevity', () => {
    const sim = makeSim();
    const a = spawnAdult(sim);
    a.age = a.traits.longevity * 0.79;
    expect(senescence(a)).toBe(0);
    a.age = a.traits.longevity * 0.9;
    expect(senescence(a)).toBeCloseTo(0.5);
    a.age = a.traits.longevity;
    expect(senescence(a)).toBe(1);
  });

  it('an old agent killed by hunger is recorded by the dominant cause', () => {
    const sim = makeSim();
    const young = spawnAdult(sim);
    young.food = 0;
    young.health = 0.1;
    updateVitals(sim, young);
    expect(young.deathCause).toBe('starvation');
    const old = spawnAdult(sim);
    old.age = old.traits.longevity - 2;
    old.health = 0.1;
    updateVitals(sim, old);
    expect(old.deathCause).toBe('old_age');
    const ancient = spawnAdult(sim);
    ancient.age = ancient.traits.longevity - 1;
    updateVitals(sim, ancient);
    expect(ancient.deathCause).toBe('old_age');
  });

  it('attributes externally-inflicted lethal damage that was not resolved', () => {
    const sim = makeSim();
    const sick = spawnAdult(sim);
    sick.health = 0;
    sick.infection = 100;
    updateVitals(sim, sick);
    expect(sick.deathCause).toBe('disease');
    const hurt = spawnAdult(sim);
    hurt.health = -5;
    hurt.lastAttackerId = 42;
    updateVitals(sim, hurt);
    expect(hurt.deathCause).toBe('combat');
  });

  it('never produces NaN or out-of-range vitals, even from corrupted inputs and extreme genomes', () => {
    const sim = makeSim();
    const agents = [genome(0), genome(1), genome(0.5)].map((g) => spawnAdult(sim, g));
    const broken = spawnAdult(sim);
    broken.food = NaN;
    broken.energy = Infinity;
    broken.vx = NaN;
    broken.reproCooldown = NaN;
    agents.push(broken);
    const temps = [30, 5, -20];
    for (let i = 0; i < 3000; i++) {
      sim.state.env.temperature = temps[i % 3];
      sim.state.env.daylight = (i % 600) / 600;
      for (const a of agents) {
        if (!a.alive) continue;
        a.action = i % 7 === 0 ? 'rest' : i % 11 === 0 ? 'attack' : 'wander';
        if (i % 13 !== 0) a.vx = a.traits.speed * ((i % 5) / 4);
        if (i % 400 === 0) a.food = a.traits.maxFood;
        updateVitals(sim, a);
        for (const v of [a.food, a.health, a.energy, a.age, a.reproCooldown]) expect(Number.isFinite(v)).toBe(true);
        expect(a.food).toBeGreaterThanOrEqual(0);
        expect(a.food).toBeLessThanOrEqual(a.traits.maxFood);
        expect(a.health).toBeGreaterThanOrEqual(0);
        expect(a.health).toBeLessThanOrEqual(a.traits.maxHealth);
        expect(a.energy).toBeGreaterThanOrEqual(0);
        expect(a.energy).toBeLessThanOrEqual(1);
      }
    }
  });

  it('expressTraits and createAgent agree', () => {
    const sim = makeSim();
    const g = genome(0.3, { size: 0.9 });
    expect(createAgent(sim, { x: 1, y: 1, genes: g }).traits).toEqual(expressTraits(g));
  });
});
