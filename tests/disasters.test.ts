import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { createAgent } from '../src/sim/lifecycle';
import { randomGenes } from '../src/sim/genetics';
import { tileCapacity } from '../src/sim/ecology';
import { DISASTER_INFO, DISASTER_TUNING, activeDisasterAt, startDisaster, updateDisasters } from '../src/sim/disasters';
import { DISASTER_KINDS, TERRAIN, type Agent, type Disaster, type ScenarioDef, type SimConfig } from '../src/sim/types';

const SCENARIO: ScenarioDef = {
  id: 'disaster-test',
  name: 'Disaster test',
  tagline: '',
  description: '',
  lookFor: [],
  config: {},
  world: {},
  populations: [],
  scheduled: [],
};

/** Sim with a uniform grass world (independent of the procedural generator). */
function makeSim(cfg: Partial<SimConfig> = {}, seed = 1): Simulation {
  const sim = Simulation.create({ scenario: SCENARIO, seed, config: { disasterRate: 0, ...cfg } });
  const w = sim.state.world;
  w.terrain.fill(TERRAIN.Grass);
  w.food.fill(5);
  w.fertility.fill(1);
  w.baseFertility.fill(1);
  w.climateMod.fill(1);
  return sim;
}

function addAgent(sim: Simulation, x: number, y: number, immunity = 0.5): Agent {
  const a = createAgent(sim, { x, y, genes: randomGenes(sim.rng) });
  a.age = a.traits.maturityAge;
  a.traits.immunity = immunity;
  a.health = a.traits.maxHealth;
  a.food = a.traits.maxFood;
  sim.addAgent(a);
  return a;
}

/** Advance only the disaster system to tick t. */
function at(sim: Simulation, t: number): void {
  sim.state.tick = t;
  updateDisasters(sim);
}

const idx = (sim: Simulation, x: number, y: number) => sim.tileIndex(x, y);

describe('disasters: climate effects', () => {
  it('drought cuts regrowth in the area, fades at the edge and is restored after expiry', () => {
    const sim = makeSim();
    const w = sim.state.world;
    const d = startDisaster(sim, 'drought', 800, 500, 200, 1, 600);
    const centre = idx(sim, 800, 500);
    const edge = idx(sim, 980, 500); // 0.9·radius → falloff band
    const outside = idx(sim, 100, 100);
    expect(w.climateMod[centre]).toBeCloseTo(0.1, 5);
    expect(w.climateMod[edge]).toBeGreaterThan(0.15);
    expect(w.climateMod[edge]).toBeLessThan(0.95);
    expect(w.climateMod[outside]).toBe(1);
    expect(sim.state.events.some((e) => e.category === 'disaster' && e.message.includes('drought') && e.x === 800)).toBe(true);

    at(sim, 300);
    expect(d.active).toBe(true);
    expect(w.climateMod[centre]).toBeCloseTo(0.1, 5);
    at(sim, 570); // gradual recovery near the end
    expect(w.climateMod[centre]).toBeGreaterThan(0.5);
    expect(w.climateMod[centre]).toBeLessThan(1);

    at(sim, 600);
    expect(d.active).toBe(false);
    for (let i = 0; i < w.climateMod.length; i++) if (w.climateMod[i] !== 1) throw new Error(`climateMod[${i}] = ${w.climateMod[i]}`);
    expect(sim.state.events.some((e) => e.message.includes('drought has broken'))).toBe(true);

    at(sim, 650);
    expect(sim.state.disasters).toContain(d); // kept for render fade-out
    at(sim, 600 + DISASTER_TUNING.fadeTicks);
    expect(sim.state.disasters).not.toContain(d);
  });

  it('climateMod recomputation is idempotent (save/load safe)', () => {
    const sim = makeSim();
    startDisaster(sim, 'drought', 800, 500, 200, 0.8, 600);
    startDisaster(sim, 'bloom', 900, 500, 150, 0.6, 400);
    at(sim, 360);
    at(sim, 575); // drought fading, bloom expired
    const before = Float32Array.from(sim.state.world.climateMod);
    const reloaded = Simulation.fromState(sim.state); // fresh module caches
    updateDisasters(reloaded);
    expect(Array.from(reloaded.state.world.climateMod)).toEqual(Array.from(before));
  });

  it('blight wipes food and damages fertility', () => {
    const sim = makeSim();
    const w = sim.state.world;
    startDisaster(sim, 'blight', 800, 500, 150, 0.5, 600);
    const c = idx(sim, 800, 500);
    const out = idx(sim, 1200, 500);
    expect(w.food[c]).toBeLessThan(0.2);
    expect(w.fertility[c]).toBeCloseTo(0.7, 5);
    expect(w.baseFertility[c]).toBeLessThan(1);
    expect(w.baseFertility[c]).toBeGreaterThan(0.9);
    expect(w.climateMod[c]).toBeLessThan(1);
    expect(w.food[out]).toBe(5);
    expect(w.fertility[out]).toBe(1);
  });

  it('bloom fills food to capacity and boosts regrowth', () => {
    const sim = makeSim();
    const w = sim.state.world;
    w.food.fill(0);
    startDisaster(sim, 'bloom', 800, 500, 150, 0.5, 600);
    const c = idx(sim, 800, 500);
    const out = idx(sim, 1200, 500);
    const cap = tileCapacity(sim, c);
    if (cap > 0) expect(w.food[c]).toBeCloseTo(cap, 4);
    expect(w.climateMod[c]).toBeCloseTo(2, 5);
    expect(w.food[out]).toBe(0);
    expect(sim.state.events.some((e) => e.severity === 'good')).toBe(true);
  });

  it('cold snaps lower temperature (combining) and halve regrowth while active', () => {
    const sim = makeSim();
    const w = sim.state.world;
    startDisaster(sim, 'coldsnap', 0, 0, 0, 1, 600);
    expect(sim.state.env.tempOffset).toBeCloseTo(-20, 5);
    startDisaster(sim, 'coldsnap', 800, 500, 200, 0.5, 600);
    const off = sim.state.env.tempOffset;
    expect(off).toBeLessThanOrEqual(-20 - 12 * 0.5);
    expect(off).toBeGreaterThanOrEqual(-20 - 20 * 0.5);
    at(sim, 300);
    expect(sim.state.env.tempOffset).toBeCloseTo(off, 5);
    expect(w.climateMod[idx(sim, 800, 500)]).toBeCloseTo(0.25, 5);
    expect(w.climateMod[idx(sim, 100, 100)]).toBeCloseTo(0.5, 5);
    at(sim, 600);
    expect(sim.state.env.tempOffset).toBe(0);
    expect(w.climateMod[idx(sim, 800, 500)]).toBe(1);
  });
});

describe('disasters: agents', () => {
  it('meteor kills inside 0.45·radius, injures the blast zone, craters terrain', () => {
    const sim = makeSim();
    const w = sim.state.world;
    const centre = addAgent(sim, 800, 500);
    const close = addAgent(sim, 830, 500); // 30 < 45 → killed
    const blast = addAgent(sim, 880, 500); // 80 → injured
    const weak = addAgent(sim, 500, 800);
    weak.x = 800;
    weak.y = 550; // 50 → injured, but too weak to survive
    weak.health = 5;
    const watcher = addAgent(sim, 950, 500); // 150 → within 2r: remembers danger
    const far = addAgent(sim, 1400, 500);
    const tv = w.terrainVersion;

    const d = startDisaster(sim, 'meteor', 800, 500, 100, 1, 9999);
    expect(d.duration).toBe(DISASTER_TUNING.meteorDuration);
    for (const a of [centre, close, weak]) {
      expect(a.alive).toBe(false);
      expect(a.deathCause).toBe('disaster');
    }
    expect(blast.alive).toBe(true);
    expect(blast.health).toBeLessThan(blast.traits.maxHealth);
    expect(blast.memory.danger.length).toBe(1);
    expect(watcher.health).toBe(watcher.traits.maxHealth);
    expect(watcher.memory.danger[0]).toMatchObject({ x: 800, y: 500 });
    expect(far.memory.danger.length).toBe(0);
    expect(far.health).toBe(far.traits.maxHealth);

    expect(w.terrain[idx(sim, 800, 500)]).toBe(TERRAIN.Rock);
    expect(w.terrain[idx(sim, 840, 500)]).toBe(TERRAIN.Sand);
    expect(w.food[idx(sim, 840, 500)]).toBe(0);
    expect(w.fertility[idx(sim, 800, 500)]).toBeLessThan(0.5);
    expect(w.terrain[idx(sim, 1000, 500)]).toBe(TERRAIN.Grass);
    expect(w.food[idx(sim, 1000, 500)]).toBe(5);
    expect(w.terrainVersion).toBeGreaterThan(tv);
    expect(sim.state.events.some((e) => e.severity === 'major' && e.message.includes('3 killed'))).toBe(true);
  });

  it('local plague infects agents in the area only', () => {
    const sim = makeSim({ diseaseVirulence: 0.5 });
    const inside: Agent[] = [];
    const outside: Agent[] = [];
    for (let i = 0; i < 30; i++) inside.push(addAgent(sim, 760 + (i % 6) * 15, 460 + Math.floor(i / 6) * 15));
    for (let i = 0; i < 10; i++) outside.push(addAgent(sim, 1300 + i * 10, 800));
    startDisaster(sim, 'plague', 800, 500, 100, 1, 600);
    const sick = inside.filter((a) => a.infection > 0);
    expect(sick.length).toBeGreaterThanOrEqual(8);
    for (const a of sick) expect(a.virulence).toBeCloseTo(0.5, 5);
    expect(outside.every((a) => a.infection === 0)).toBe(true);
    expect(sim.state.events.some((e) => e.category === 'disease' && e.message.startsWith('Plague outbreak'))).toBe(true);
  });

  it('global plague infects ~6% of agents (at least 3)', () => {
    const sim = makeSim();
    for (let i = 0; i < 100; i++) addAgent(sim, 20 + (i % 20) * 70, 20 + Math.floor(i / 20) * 150);
    startDisaster(sim, 'plague', 0, 0, 0, 0.8, 600);
    expect(sim.state.agents.filter((a) => a.infection > 0).length).toBe(6);

    const small = makeSim();
    for (let i = 0; i < 20; i++) addAgent(small, 20 + i * 70, 300);
    startDisaster(small, 'plague', 0, 0, 0, 0.8, 600);
    expect(small.state.agents.filter((a) => a.infection > 0).length).toBe(3);
  });

  it('activeDisasterAt prefers local disasters and ignores finished ones', () => {
    const sim = makeSim();
    const local = startDisaster(sim, 'drought', 800, 500, 100, 0.5, 300);
    const global = startDisaster(sim, 'coldsnap', 0, 0, 0, 1, 600);
    expect(activeDisasterAt(sim, 820, 500)).toBe(local);
    expect(activeDisasterAt(sim, 100, 100)).toBe(global);
    at(sim, 300);
    expect(activeDisasterAt(sim, 820, 500)).toBe(global);
    at(sim, 600);
    expect(activeDisasterAt(sim, 820, 500)).toBeNull();
  });
});

describe('disasters: random events & robustness', () => {
  it('no random disasters when disasterRate = 0', () => {
    const sim = makeSim({ disasterRate: 0 });
    for (let t = 0; t < 20000; t++) at(sim, t);
    expect(sim.state.disasters.length).toBe(0);
    expect(sim.state.nextDisasterId).toBe(1);
  });

  it('about one random disaster every 2 days at disasterRate = 1, with valid parameters', () => {
    const sim = makeSim({ disasterRate: 1, dayLength: 600 }, 4);
    for (let i = 0; i < 40; i++) addAgent(sim, 200 + i * 30, 500);
    const seen = new Map<number, Disaster>();
    const days = 100;
    for (let t = 0; t < days * 600; t++) {
      at(sim, t);
      for (const d of sim.state.disasters) seen.set(d.id, d);
    }
    expect(seen.size).toBeGreaterThan(30);
    expect(seen.size).toBeLessThan(75);
    const kinds = new Set<string>();
    for (const d of seen.values()) {
      kinds.add(d.kind);
      expect(DISASTER_KINDS).toContain(d.kind);
      expect(d.intensity).toBeGreaterThanOrEqual(0.4);
      expect(d.intensity).toBeLessThanOrEqual(1);
      if (d.kind === 'meteor') expect(d.radius).toBeLessThanOrEqual(130);
      else if (d.radius > 0) {
        expect(d.radius).toBeGreaterThanOrEqual(120);
        expect(d.radius).toBeLessThanOrEqual(350);
      } else expect(d.kind).toBe('coldsnap');
      if (d.kind !== 'meteor') {
        expect(d.duration).toBeGreaterThanOrEqual(600);
        expect(d.duration).toBeLessThanOrEqual(1800);
      }
    }
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    expect(sim.state.disasters.length).toBeLessThanOrEqual(DISASTER_TUNING.maxDisasters);
    const f = sim.state.world.food;
    for (let i = 0; i < f.length; i++) if (!(f[i] >= 0)) throw new Error(`bad food ${f[i]}`);
  });

  it('keeps the disaster list bounded and clamps bad inputs', () => {
    const sim = makeSim();
    for (let i = 0; i < 150; i++) startDisaster(sim, 'drought', 10 * i, 300, 20, 0.5, 100000);
    expect(sim.state.disasters.length).toBeLessThanOrEqual(DISASTER_TUNING.maxDisasters);

    const d = startDisaster(sim, 'drought', NaN, Infinity, NaN, NaN, NaN);
    for (const v of [d.x, d.y, d.radius, d.intensity, d.duration]) expect(Number.isFinite(v)).toBe(true);
    expect(d.radius).toBe(0);
    const m = startDisaster(sim, 'meteor', 5000, -100, 0, 7, 10);
    expect(m.radius).toBeGreaterThan(0);
    expect(m.intensity).toBe(1);
    expect(m.x).toBeLessThanOrEqual(sim.worldW);
    expect(m.y).toBe(0);
    const cm = sim.state.world.climateMod;
    for (let i = 0; i < cm.length; i++) if (!Number.isFinite(cm[i]) || cm[i] < 0) throw new Error(`bad climateMod ${cm[i]}`);
    expect(Object.keys(DISASTER_INFO).sort()).toEqual([...DISASTER_KINDS].sort());
  });

  it('full simulation with disasters is deterministic and NaN-free', () => {
    const scenario: ScenarioDef = {
      ...SCENARIO,
      populations: [{ x: 800, y: 500, count: 120, radius: 120, tribe: 'none' }],
    };
    const make = () => {
      const sim = Simulation.create({ scenario, seed: 21, config: { disasterRate: 2, diseaseVirulence: 1 } });
      startDisaster(sim, 'plague', 800, 500, 120, 1, 900);
      startDisaster(sim, 'meteor', 700, 450, 60, 1, 1);
      startDisaster(sim, 'drought', 900, 500, 250, 0.7, 700);
      startDisaster(sim, 'bloom', 600, 600, 150, 0.6, 500);
      startDisaster(sim, 'blight', 1000, 400, 150, 0.9, 500);
      startDisaster(sim, 'coldsnap', 0, 0, 0, 0.8, 800);
      return sim;
    };
    const a = make();
    const b = make();
    a.run(1200);
    b.run(1200);
    expect(a.hash()).toBe(b.hash());
    expect(a.state.disasters.length).toBeLessThanOrEqual(DISASTER_TUNING.maxDisasters);
    for (const ag of a.state.agents) {
      expect(Number.isFinite(ag.health) && Number.isFinite(ag.energy) && Number.isFinite(ag.virulence)).toBe(true);
    }
    const f = a.state.world.food;
    for (let i = 0; i < f.length; i++) if (!(f[i] >= 0) || !Number.isFinite(f[i])) throw new Error(`bad food ${f[i]}`);
    expect(Number.isFinite(a.state.env.tempOffset)).toBe(true);
  });
});
