import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { applyIntervention, INTERVENTION_HELP } from '../src/sim/interventions';
import { findPassableNear } from '../src/sim/world';
import { TERRAIN_INFO } from '../src/sim/constants';
import { DEFAULT_CONFIG, PARAM_SPECS } from '../src/sim/config';
import { SCENARIOS } from '../src/sim/presets';
import { NONE, TERRAIN, type Intervention, type ScenarioDef, type TerrainType } from '../src/sim/types';

const SCENARIO: ScenarioDef = {
  id: 'iv-test',
  name: 'Intervention test',
  tagline: '',
  description: '',
  lookFor: [],
  config: { disasterRate: 0 },
  world: {},
  populations: [],
  scheduled: [],
};

const makeSim = (seed = 3): Simulation => Simulation.create({ scenario: SCENARIO, seed });

/** A dry-land point near (fx·W, fy·H), snapped to the centre of its tile. */
function landPoint(sim: Simulation, fx = 0.5, fy = 0.5): { x: number; y: number; i: number } {
  const p = findPassableNear(sim, sim.worldW * fx, sim.worldH * fy, 4000, true);
  if (!p) throw new Error('no land');
  const ts = sim.state.world.tileSize;
  const x = (Math.floor(p.x / ts) + 0.5) * ts;
  const y = (Math.floor(p.y / ts) + 0.5) * ts;
  return { x, y, i: sim.tileIndex(x, y) };
}

const capacity = (sim: Simulation, i: number): number => {
  const w = sim.state.world;
  return TERRAIN_INFO[w.terrain[i] as TerrainType].maxFood * w.fertility[i] * sim.config.foodCapacity;
};

const lastEvent = (sim: Simulation) => sim.state.events[sim.state.events.length - 1];

const ALL_KINDS: Intervention['kind'][] = [
  'spawn', 'remove', 'killAgent', 'addFood', 'removeFood', 'paintTerrain', 'fertilize', 'disaster', 'setConfig', 'boostAgent',
];

describe('spawn', () => {
  it('creates young-adult founders on passable ground inside the brush', () => {
    const sim = makeSim();
    const p = landPoint(sim);
    applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 25, radius: 60, tribe: 'none' });
    const agents = sim.state.agents;
    expect(agents.length).toBe(25);
    let inside = 0;
    for (const a of agents) {
      expect(a.alive).toBe(true);
      expect(sim.passableAt(a.x, a.y)).toBe(true);
      expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
      expect(a.age).toBeGreaterThanOrEqual(Math.min(a.traits.maturityAge, a.traits.longevity * 0.5) - 1);
      expect(a.food).toBeGreaterThan(0);
      expect(a.food).toBeLessThanOrEqual(a.traits.maxFood);
      expect(a.tribeId).toBe(NONE);
      expect(sim.lineageById.has(a.id)).toBe(true);
      if (Math.hypot(a.x - p.x, a.y - p.y) <= 60 + sim.state.world.tileSize) inside++;
    }
    expect(inside).toBeGreaterThanOrEqual(20);
    const ev = lastEvent(sim);
    expect(ev.category).toBe('intervention');
    expect(ev.message).toContain('Spawned 25 agents');
    expect(ev.x).toBe(p.x);
  });

  it('founds a named tribe with the template hue, and can reinforce it', () => {
    const sim = makeSim();
    const p = landPoint(sim);
    applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 12, radius: 40, tribe: 'new', tribeName: 'Testers', template: { hue: 0.5, sociability: 0.9, spread: 0.02 } });
    const living = sim.state.tribes.filter((t) => t.extinctTick === -1);
    expect(living.length).toBe(1);
    const t = living[0];
    expect(t.name).toContain('Testers');
    expect(t.hue).toBeCloseTo(180, 5);
    expect(sim.passableAt(t.homeX, t.homeY)).toBe(true);
    for (const a of sim.state.agents) {
      expect(a.tribeId).toBe(t.id);
      expect(sim.lineageById.get(a.id)!.tribeId).toBe(t.id);
      expect(a.genes[11]).toBeGreaterThan(0.35); // hue gene follows the template
    }
    applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 5, radius: 40, tribe: t.id });
    expect(sim.state.agents.filter((a) => a.tribeId === t.id).length).toBe(17);
    // unknown tribe id → unaffiliated
    applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 3, radius: 40, tribe: 9999 });
    expect(sim.state.agents.filter((a) => a.tribeId === NONE).length).toBe(3);
  });

  it('respects the population cap and still lands agents when clicked on open sea', () => {
    const sim = makeSim();
    applyIntervention(sim, { kind: 'setConfig', patch: { maxAgents: 10 } });
    expect(sim.config.maxAgents).toBe(50); // clamped to the slider minimum
    const p = landPoint(sim);
    applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 80, radius: 50 });
    expect(sim.state.agents.length).toBe(50);
    expect(lastEvent(sim).message).toContain('population cap');
    applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 5, radius: 50 });
    expect(sim.state.agents.length).toBe(50);
    expect(lastEvent(sim).severity).toBe('bad');

    const sea = makeSim();
    applyIntervention(sea, { kind: 'spawn', x: 4, y: 4, count: 6, radius: 0 }); // map corner = deep ocean
    expect(sea.state.agents.length).toBe(6);
    for (const a of sea.state.agents) expect(sea.passableAt(a.x, a.y)).toBe(true);
  });

  it('ignores invalid spawn requests', () => {
    const sim = makeSim();
    applyIntervention(sim, { kind: 'spawn', x: NaN, y: 10, count: 5, radius: 10 });
    applyIntervention(sim, { kind: 'spawn', x: 100, y: 100, count: -4, radius: 10 });
    applyIntervention(sim, { kind: 'spawn', x: 100, y: 100, count: NaN, radius: NaN });
    expect(sim.state.agents.length).toBe(0);
  });

  it('is deterministic', () => {
    const run = () => {
      const sim = makeSim(17);
      const p = landPoint(sim, 0.4, 0.5);
      applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 30, radius: 80, tribe: 'new', template: { aggression: 0.8 } });
      applyIntervention(sim, { kind: 'spawn', x: p.x + 50, y: p.y, count: 10, radius: 30 });
      applyIntervention(sim, { kind: 'paintTerrain', x: p.x, y: p.y, radius: 24, terrain: TERRAIN.Wall });
      applyIntervention(sim, { kind: 'remove', x: p.x + 50, y: p.y, radius: 15 });
      return sim;
    };
    const a = run();
    const b = run();
    expect(a.hash()).toBe(b.hash());
    expect(a.state.agents.map((x) => [x.id, x.x, x.y, x.tribeId])).toEqual(b.state.agents.map((x) => [x.id, x.x, x.y, x.tribeId]));
  });
});

describe('agent interventions', () => {
  it('remove kills only agents inside the radius', () => {
    const sim = makeSim();
    const a = landPoint(sim, 0.3, 0.5);
    const b = landPoint(sim, 0.7, 0.5);
    applyIntervention(sim, { kind: 'spawn', x: a.x, y: a.y, count: 20, radius: 30 });
    const groupA = sim.state.agents.slice();
    applyIntervention(sim, { kind: 'spawn', x: b.x, y: b.y, count: 20, radius: 30 });
    const groupB = sim.state.agents.slice(20);
    const reach = Math.max(...groupA.map((g) => Math.hypot(g.x - a.x, g.y - a.y))) + 1;
    applyIntervention(sim, { kind: 'remove', x: a.x, y: a.y, radius: reach });
    expect(groupA.every((g) => !g.alive && g.deathCause === 'removed')).toBe(true);
    expect(groupB.every((g) => g.alive)).toBe(true);
    expect(sim.state.agents.length).toBe(20);
    expect(sim.state.stats.counters.deathsByCause.removed).toBe(20);
    expect(lastEvent(sim).message).toBe('Removed 20 agents');
  });

  it('killAgent removes one agent; boostAgent restores vitals; missing ids are ignored', () => {
    const sim = makeSim();
    const p = landPoint(sim);
    applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 3, radius: 20 });
    const [a, b] = sim.state.agents;
    applyIntervention(sim, { kind: 'killAgent', id: a.id });
    expect(a.alive).toBe(false);
    expect(sim.getAgent(a.id)).toBeUndefined();
    expect(sim.state.agents.length).toBe(2);
    b.health = 1;
    b.food = 0;
    b.energy = 0.05;
    applyIntervention(sim, { kind: 'boostAgent', id: b.id });
    expect(b.health).toBe(b.traits.maxHealth);
    expect(b.food).toBe(b.traits.maxFood);
    expect(b.energy).toBe(1);
    expect(lastEvent(sim).agentId).toBe(b.id);
    for (const id of [a.id, 99999, NONE]) {
      applyIntervention(sim, { kind: 'killAgent', id });
      applyIntervention(sim, { kind: 'boostAgent', id });
    }
    expect(sim.state.agents.length).toBe(2);
  });
});

describe('food and soil', () => {
  it('addFood adds up to 1.5x capacity, removeFood clears, others untouched', () => {
    const sim = makeSim();
    const p = landPoint(sim);
    const w = sim.state.world;
    const far = landPoint(sim, 0.2, 0.3).i;
    const farFood = w.food[far];
    w.food[p.i] = 0;
    applyIntervention(sim, { kind: 'addFood', x: p.x, y: p.y, radius: 20, amount: 0.5 });
    expect(w.food[p.i]).toBeCloseTo(Math.min(0.5, capacity(sim, p.i) * 1.5), 5);
    applyIntervention(sim, { kind: 'addFood', x: p.x, y: p.y, radius: 20, amount: 1e9 });
    expect(w.food[p.i]).toBeCloseTo(capacity(sim, p.i) * 1.5, 4);
    expect(w.food[p.i]).toBeLessThanOrEqual(capacity(sim, p.i) * 1.5);
    expect(lastEvent(sim).category).toBe('intervention');
    applyIntervention(sim, { kind: 'removeFood', x: p.x, y: p.y, radius: 20 });
    expect(w.food[p.i]).toBe(0);
    expect(w.food[far]).toBe(farFood);
    applyIntervention(sim, { kind: 'addFood', x: p.x, y: p.y, radius: 20, amount: -50 });
    expect(w.food[p.i]).toBe(0);
  });

  it('fertilize raises fertility and base fertility up to 1.2 (and can deplete)', () => {
    const sim = makeSim();
    const p = landPoint(sim);
    const w = sim.state.world;
    const f0 = w.fertility[p.i];
    const b0 = w.baseFertility[p.i];
    applyIntervention(sim, { kind: 'fertilize', x: p.x, y: p.y, radius: 10, amount: 0.1 });
    expect(w.fertility[p.i]).toBeCloseTo(Math.min(1.2, f0 + 0.1), 5);
    expect(w.baseFertility[p.i]).toBeCloseTo(Math.min(1.2, b0 + 0.1), 5);
    for (let k = 0; k < 20; k++) applyIntervention(sim, { kind: 'fertilize', x: p.x, y: p.y, radius: 10, amount: 0.5 });
    expect(w.fertility[p.i]).toBeCloseTo(1.2, 5);
    expect(w.baseFertility[p.i]).toBeCloseTo(1.2, 5);
    expect(w.fertility[p.i]).toBeLessThanOrEqual(1.2);
    expect(w.baseFertility[p.i]).toBeLessThanOrEqual(1.2);
    applyIntervention(sim, { kind: 'fertilize', x: p.x, y: p.y, radius: 10, amount: -5 });
    expect(w.fertility[p.i]).toBe(0);
    expect(w.food[p.i]).toBe(0);
  });
});

describe('paintTerrain', () => {
  it('paints walls, clears food, displaces trapped agents and bumps terrainVersion', () => {
    const sim = makeSim();
    const p = landPoint(sim);
    const w = sim.state.world;
    applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 15, radius: 20 });
    const v0 = w.terrainVersion;
    applyIntervention(sim, { kind: 'paintTerrain', x: p.x, y: p.y, radius: 40, terrain: TERRAIN.Wall });
    expect(w.terrainVersion).toBe(v0 + 1);
    expect(w.terrain[p.i]).toBe(TERRAIN.Wall);
    expect(w.food[p.i]).toBe(0);
    expect(w.fertility[p.i]).toBe(0);
    expect(w.baseFertility[p.i]).toBe(0);
    const killed = sim.state.stats.counters.deathsByCause.disaster;
    expect(sim.state.agents.length + killed).toBe(15);
    expect(sim.state.agents.length).toBe(15); // open land around: everyone is pushed out
    for (const a of sim.state.agents) expect(sim.passableAt(a.x, a.y)).toBe(true);
    expect(lastEvent(sim).message).toContain('displaced');

    // painting the same terrain again changes nothing
    applyIntervention(sim, { kind: 'paintTerrain', x: p.x, y: p.y, radius: 40, terrain: TERRAIN.Wall });
    expect(w.terrainVersion).toBe(v0 + 1);
    // invalid terrain is ignored
    applyIntervention(sim, { kind: 'paintTerrain', x: p.x, y: p.y, radius: 40, terrain: 42 as TerrainType });
    applyIntervention(sim, { kind: 'paintTerrain', x: p.x, y: p.y, radius: 40, terrain: 1.5 as TerrainType });
    expect(w.terrainVersion).toBe(v0 + 1);
  });

  it('turns ocean into fertile land with food within capacity', () => {
    const sim = makeSim();
    const w = sim.state.world;
    const ts = w.tileSize;
    const x = 1.5 * ts;
    const y = 1.5 * ts;
    const i = sim.tileIndex(x, y);
    expect(w.terrain[i]).toBe(TERRAIN.DeepWater);
    applyIntervention(sim, { kind: 'paintTerrain', x, y, radius: 0, terrain: TERRAIN.Grass });
    expect(w.terrain[i]).toBe(TERRAIN.Grass);
    expect(w.fertility[i]).toBeGreaterThan(0.5);
    expect(w.baseFertility[i]).toBe(w.fertility[i]);
    expect(w.food[i]).toBeGreaterThanOrEqual(0);
    expect(w.food[i]).toBeLessThanOrEqual(capacity(sim, i));
    // only the tile under the cursor was painted
    expect(w.terrain[i + 2]).toBe(TERRAIN.DeepWater);
  });

  it('kills agents that have nowhere to go', () => {
    const sim = makeSim();
    const p = landPoint(sim);
    applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 4, radius: 10 });
    applyIntervention(sim, { kind: 'paintTerrain', x: p.x, y: p.y, radius: 5000, terrain: TERRAIN.DeepWater });
    expect(sim.state.agents.length).toBe(0);
    expect(sim.state.stats.counters.deathsByCause.disaster).toBe(4);
    for (let i = 0; i < sim.state.world.food.length; i++) expect(sim.state.world.food[i]).toBe(0);
  });
});

describe('disaster', () => {
  it('starts a disaster with clamped parameters and ignores unknown kinds', () => {
    const sim = makeSim();
    const p = landPoint(sim);
    const n0 = sim.state.disasters.length;
    applyIntervention(sim, { kind: 'disaster', disaster: 'drought', x: p.x, y: p.y, radius: 1e9, intensity: 7, duration: -5 });
    expect(sim.state.disasters.length).toBe(n0 + 1);
    const d = sim.state.disasters[sim.state.disasters.length - 1];
    expect(d.kind).toBe('drought');
    expect(d.radius).toBeLessThanOrEqual(Math.max(sim.worldW, sim.worldH));
    expect(d.intensity).toBeLessThanOrEqual(1);
    expect(d.duration).toBeGreaterThanOrEqual(1);
    expect(sim.state.events.some((e) => e.category === 'intervention' && e.message.includes('Drought'))).toBe(true);
    applyIntervention(sim, { kind: 'disaster', disaster: 'volcano' as never, x: p.x, y: p.y, radius: 10, intensity: 1, duration: 10 });
    expect(sim.state.disasters.length).toBe(n0 + 1);
  });
});

describe('setConfig', () => {
  it('applies known keys with clamping and rejects everything else', () => {
    const sim = makeSim();
    const before = { ...sim.config };
    applyIntervention(sim, {
      kind: 'setConfig',
      patch: {
        mutationRate: 5,
        foodRegen: NaN,
        reproductionRate: 1.5,
        seed: 999,
        worldWidth: 10,
        worldHeight: 10,
        tileSize: 2,
        overgrazing: false,
        dayNight: 1 as unknown as boolean,
        difficulty: 'hard' as unknown as number,
        dayLength: 5,
        bogus: 3,
      } as never,
    });
    const c = sim.config;
    const mutSpec = PARAM_SPECS.find((s) => s.key === 'mutationRate')!;
    expect(c.mutationRate).toBe(mutSpec.max);
    expect(c.foodRegen).toBe(before.foodRegen);
    expect(c.reproductionRate).toBe(1.5);
    expect(c.seed).toBe(before.seed);
    expect(c.worldWidth).toBe(before.worldWidth);
    expect(c.worldHeight).toBe(before.worldHeight);
    expect(c.tileSize).toBe(before.tileSize);
    expect(c.overgrazing).toBe(false);
    expect(c.dayNight).toBe(before.dayNight);
    expect(c.difficulty).toBe(before.difficulty);
    expect(c.dayLength).toBe(60);
    expect('bogus' in c).toBe(false);
    expect(Object.keys(c).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());
    expect(lastEvent(sim).message).toContain('Mutation rate');
  });
});

describe('robustness & help', () => {
  it('survives garbage input for every kind without NaN', () => {
    const sim = makeSim();
    const p = landPoint(sim);
    applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 10, radius: 30 });
    const junk = [
      { kind: 'remove', x: NaN, y: 0, radius: 10 },
      { kind: 'remove', x: p.x, y: p.y, radius: NaN },
      { kind: 'addFood', x: p.x, y: p.y, radius: Infinity, amount: NaN },
      { kind: 'removeFood', x: undefined, y: p.y, radius: 10 },
      { kind: 'fertilize', x: p.x, y: p.y, radius: -10, amount: Infinity },
      { kind: 'paintTerrain', x: p.x, y: p.y, radius: NaN, terrain: undefined },
      { kind: 'disaster', disaster: 'meteor', x: NaN, y: NaN, radius: NaN, intensity: NaN, duration: NaN },
      { kind: 'setConfig', patch: null },
      { kind: 'killAgent', id: 'x' },
      { kind: 'boostAgent' },
      { kind: 'nonsense' },
      null,
    ] as unknown as Intervention[];
    for (const iv of junk) expect(() => applyIntervention(sim, iv)).not.toThrow();
    const w = sim.state.world;
    for (let i = 0; i < w.food.length; i++) {
      if (!(w.food[i] >= 0) || !Number.isFinite(w.fertility[i])) throw new Error(`bad tile ${i}`);
    }
    for (const a of sim.state.agents) expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
  });

  it('documents every intervention kind', () => {
    for (const k of ALL_KINDS) {
      expect(typeof INTERVENTION_HELP[k]).toBe('string');
      expect(INTERVENTION_HELP[k].length).toBeGreaterThan(20);
    }
    expect(Object.keys(INTERVENTION_HELP).sort()).toEqual([...ALL_KINDS].sort());
  });

  it('queued interventions replay deterministically through step()', () => {
    const run = () => {
      const sim = makeSim(23);
      const p = landPoint(sim);
      sim.enqueue({ kind: 'spawn', x: p.x, y: p.y, count: 20, radius: 60, tribe: 'new' });
      sim.run(5);
      sim.enqueue({ kind: 'addFood', x: p.x, y: p.y, radius: 50, amount: 3 });
      sim.enqueue({ kind: 'paintTerrain', x: p.x + 30, y: p.y, radius: 16, terrain: TERRAIN.Water });
      sim.enqueue({ kind: 'setConfig', patch: { aggressionBias: 2 } });
      sim.run(10);
      return sim;
    };
    const a = run();
    const b = run();
    expect(a.hash()).toBe(b.hash());
    expect(a.state.interventionLog.length).toBe(4);
    expect(a.config.aggressionBias).toBe(2);
  });
});

describe('scenario setup', () => {
  it('every preset lands its populations on dry land near the requested spots', () => {
    for (const sc of SCENARIOS) {
      const sim = Simulation.create({ scenario: sc, seed: 42 });
      const ts = sim.state.world.tileSize;
      const wanted = sc.populations.reduce((n, p) => n + p.count, 0);
      expect(sim.state.agents.length, sc.id).toBe(Math.min(wanted, sim.config.maxAgents));
      let k = 0;
      let near = 0;
      for (const pop of sc.populations) {
        for (const a of sim.state.agents.slice(k, k + pop.count)) {
          expect(sim.passableAt(a.x, a.y)).toBe(true);
          if (Math.hypot(a.x - pop.x, a.y - pop.y) <= pop.radius + 3 * ts) near++;
        }
        k += pop.count;
      }
      expect(near / Math.max(1, sim.state.agents.length), sc.id).toBeGreaterThan(0.8);
    }
  });
});
