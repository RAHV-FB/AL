import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { act, carryCapacity, think } from '../src/sim/brain';
import { createAgent } from '../src/sim/lifecycle';
import { randomGenes } from '../src/sim/genetics';
import { foundTribe } from '../src/sim/social';
import { ACTIONS, TERRAIN, type Agent, type GenomeTemplate, type ScenarioDef } from '../src/sim/types';

// ------------------------------------------------------------------ helpers

/** Small all-grass world with no scheduled events / random disasters. */
function makeSim(seed = 1, populations: ScenarioDef['populations'] = []): Simulation {
  const scenario: ScenarioDef = {
    id: 'brain-test',
    name: 'Brain test',
    tagline: '',
    description: '',
    lookFor: [],
    config: { worldWidth: 40, worldHeight: 30, tileSize: 8, disasterRate: 0, maxAgents: 300 },
    world: { island: false, waterLevel: 0, mountainLevel: 0, desertLevel: 0, divide: 'none', initialFood: 0.8 },
    populations,
    scheduled: [],
  };
  const sim = Simulation.create({ scenario, seed });
  sim.state.world.terrain.fill(TERRAIN.Grass);
  sim.state.world.terrainVersion++;
  return sim;
}

const BASE: GenomeTemplate = {
  speed: 0.5, size: 0.5, perception: 0.5, metabolism: 0.5, aggression: 0.3, sociability: 0.5,
  altruism: 0.5, fertility: 0.5, longevity: 0.5, immunity: 0.5, efficiency: 0.5, hue: 0.5, spread: 0,
};

function spawn(sim: Simulation, x: number, y: number, genes: GenomeTemplate = {}, age = 1500): Agent {
  const a = createAgent(sim, { x, y, genes: randomGenes(sim.rng, { ...BASE, ...genes, spread: 0 }), age });
  sim.addAgent(a);
  return a;
}

/** Brain-only ticks (think/act with the orchestrator's cooldown rule; no metabolism). */
function brainTicks(sim: Simulation, agents: Agent[], n: number, until?: () => boolean): void {
  for (let t = 0; t < n; t++) {
    sim.spatial.rebuild(sim.state.agents);
    for (const a of agents) {
      if (!a.alive) continue;
      if (a.decisionCooldown <= 0) think(sim, a);
      else a.decisionCooldown--;
      act(sim, a);
    }
    sim.state.tick++;
    if (until && until()) return;
  }
}

function dist(a: Agent, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function tileCentre(sim: Simulation, tx: number, ty: number): { x: number; y: number; idx: number } {
  const w = sim.state.world;
  return { x: (tx + 0.5) * w.tileSize, y: (ty + 0.5) * w.tileSize, idx: ty * w.width + tx };
}

// ------------------------------------------------------------------ decisions (think)

describe('brain: decisions', () => {
  it('a starving agent heads for visible food and eats it', () => {
    const sim = makeSim(2);
    sim.state.world.food.fill(0);
    const a = spawn(sim, 84, 84); // tile (10,10)
    const spot = tileCentre(sim, 15, 10); // 40 units east
    sim.state.world.food[spot.idx] = 9;
    a.food = a.traits.maxFood * 0.15;
    sim.spatial.rebuild(sim.state.agents);
    think(sim, a);
    expect(a.action).toBe('forage');
    expect(Math.hypot(a.targetX - spot.x, a.targetY - spot.y)).toBeLessThan(1);
    expect(a.thought).toMatch(/Starving|hungry/i);
    const before = a.food;
    brainTicks(sim, [a], 200, () => a.stats.foodEaten > 5);
    expect(a.stats.foodEaten).toBeGreaterThan(0);
    expect(a.food).toBeGreaterThan(before);
    expect(sim.state.world.food[spot.idx]).toBeLessThan(9);
    expect(a.sinceMeal).toBe(0);
    expect(a.memory.food.length).toBeLessThanOrEqual(4);
  });

  it('flees from a much stronger attacker and gets farther away', () => {
    const sim = makeSim(3);
    sim.state.world.food.fill(0);
    const weak = spawn(sim, 160, 120, { size: 0.05, aggression: 0.02 });
    const brute = spawn(sim, 172, 120, { size: 1, aggression: 1 });
    brute.action = 'attack';
    brute.targetId = weak.id;
    weak.lastAttackerId = brute.id;
    sim.spatial.rebuild(sim.state.agents);
    think(sim, weak);
    expect(weak.action).toBe('flee');
    expect(weak.targetId).toBe(brute.id);
    expect(weak.fear ?? 0).toBeGreaterThan(0);
    expect(weak.decisionCooldown).toBeLessThan(6); // reacts faster when threatened
    const d0 = dist(weak, brute);
    for (let i = 0; i < 20; i++) act(sim, weak);
    expect(dist(weak, brute)).toBeGreaterThan(d0 + 5);
  });

  it('sleeps when exhausted at night', () => {
    const sim = makeSim(4);
    sim.state.world.food.fill(0);
    const a = spawn(sim, 160, 120);
    a.energy = 0.05;
    a.food = a.traits.maxFood;
    sim.state.env.daylight = 0;
    sim.spatial.rebuild(sim.state.agents);
    think(sim, a);
    expect(a.action).toBe('rest');
    act(sim, a);
    expect(a.vx).toBe(0);
    expect(a.vy).toBe(0);
  });

  it('a tribe member carrying a full load deposits it at camp', () => {
    const sim = makeSim(5);
    sim.state.world.food.fill(0);
    const a = spawn(sim, 100, 100);
    const tribe = foundTribe(sim, a, [], 'Testers');
    tribe.homeX = 100;
    tribe.homeY = 100;
    a.x = 200;
    a.y = 160;
    a.carried = carryCapacity(a);
    a.food = a.traits.maxFood;
    sim.state.env.daylight = 1;
    sim.spatial.rebuild(sim.state.agents);
    think(sim, a);
    expect(a.action).toBe('deposit');
    expect(a.thought).toMatch(/stockpile/);
    const carried0 = a.carried;
    brainTicks(sim, [a], 800, () => a.carried < carried0);
    expect(dist(a, { x: tribe.homeX, y: tribe.homeY })).toBeLessThan(25);
    expect(a.carried).toBeLessThan(carried0);
    expect(tribe.stockpile).toBeGreaterThan(0);
  });

  it('a hungry tribe member withdraws from the stockpile when no food is around', () => {
    const sim = makeSim(6);
    sim.state.world.food.fill(0);
    const a = spawn(sim, 100, 100);
    const tribe = foundTribe(sim, a, [], 'Testers');
    tribe.homeX = 100;
    tribe.homeY = 100;
    tribe.stockpile = 100;
    a.x = 190;
    a.y = 140;
    a.food = a.traits.maxFood * 0.15;
    sim.state.env.daylight = 1;
    sim.spatial.rebuild(sim.state.agents);
    think(sim, a);
    expect(a.action).toBe('withdraw');
    const food0 = a.food;
    brainTicks(sim, [a], 800, () => a.food > food0 + 1);
    expect(a.food).toBeGreaterThan(food0);
    expect(tribe.stockpile).toBeLessThan(100);
  });

  it('two compatible fertile adults court each other and have a child', () => {
    const sim = makeSim(7);
    sim.state.world.food.fill(0);
    const a = spawn(sim, 150, 120, { fertility: 0.9 });
    const b = spawn(sim, 175, 120, { fertility: 0.9 });
    for (const x of [a, b]) {
      x.food = x.traits.maxFood;
      x.energy = 1;
      x.reproCooldown = 0;
    }
    sim.state.env.daylight = 1;
    const pop0 = sim.state.agents.length;
    brainTicks(sim, [a, b], 300, () => a.offspring + b.offspring > 0);
    expect(a.offspring + b.offspring).toBeGreaterThan(0);
    expect(sim.state.agents.length).toBeGreaterThan(pop0);
  });

  it('records utilities for every action and a readable thought', () => {
    const sim = makeSim(8);
    const a = spawn(sim, 160, 120);
    sim.spatial.rebuild(sim.state.agents);
    think(sim, a);
    for (const k of ACTIONS) {
      const u = a.utilities[k];
      expect(typeof u).toBe('number');
      expect(Number.isFinite(u)).toBe(true);
    }
    expect(a.thought.length).toBeGreaterThan(3);
    expect(a.decisionCooldown).toBeGreaterThanOrEqual(3);
    expect(a.decisionCooldown).toBeLessThanOrEqual(14);
  });
});

// ------------------------------------------------------------------ movement / orchestrator

describe('brain: movement with the real orchestrator', () => {
  it('agents move, and never stand on impassable tiles (even with walls painted around them)', () => {
    const sim = Simulation.create({ scenario: SCENARIOS[0], seed: 11 });
    const w = sim.state.world;
    // paint a wall cross through the middle of the starting population and a lake
    const cx = Math.floor(sim.state.agents[0].x / w.tileSize);
    const cy = Math.floor(sim.state.agents[0].y / w.tileSize);
    for (let t = -12; t <= 12; t++) {
      for (const [tx, ty] of [[cx + t, cy], [cx, cy + t]]) {
        if (tx >= 0 && ty >= 0 && tx < w.width && ty < w.height) w.terrain[ty * w.width + tx] = TERRAIN.Wall;
      }
    }
    for (let oy = 3; oy <= 7; oy++) for (let ox = 3; ox <= 7; ox++) {
      const tx = cx + ox, ty = cy + oy;
      if (tx < w.width && ty < w.height) w.terrain[ty * w.width + tx] = TERRAIN.DeepWater;
    }
    w.terrainVersion++;
    const start = new Map(sim.state.agents.map((a) => [a.id, { x: a.x, y: a.y }]));
    for (let t = 0; t < 400; t++) {
      sim.step();
      for (const a of sim.state.agents) {
        if (!sim.passableAt(a.x, a.y)) throw new Error(`agent ${a.id} on impassable tile at tick ${t} (${a.x},${a.y}) doing ${a.action}`);
        expect(a.x >= 0 && a.y >= 0 && a.x <= sim.worldW && a.y <= sim.worldH).toBe(true);
      }
    }
    let moved = 0;
    let n = 0;
    for (const a of sim.state.agents) {
      const s = start.get(a.id);
      if (!s) continue;
      n++;
      if (Math.hypot(a.x - s.x, a.y - s.y) > 5) moved++;
      expect(a.stats.distance).toBeGreaterThanOrEqual(0);
    }
    expect(n).toBeGreaterThan(0);
    expect(moved / n).toBeGreaterThan(0.6);
  });

  it('moves an agent out when terrain is painted underneath it', () => {
    const sim = makeSim(12, [{ x: 160, y: 120, count: 6, radius: 30, tribe: 'none' }]);
    const a = sim.state.agents[0];
    const w = sim.state.world;
    const tx = Math.floor(a.x / w.tileSize);
    const ty = Math.floor(a.y / w.tileSize);
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) w.terrain[(ty + oy) * w.width + tx + ox] = TERRAIN.Wall;
    w.terrainVersion++;
    expect(sim.passableAt(a.x, a.y)).toBe(false);
    sim.step();
    expect(a.alive).toBe(true);
    expect(sim.passableAt(a.x, a.y)).toBe(true);
    expect(Math.hypot(a.x - (tx + 0.5) * w.tileSize, a.y - (ty + 0.5) * w.tileSize)).toBeLessThan(3 * w.tileSize);
  });

  it('hungry agents eat when food is present', () => {
    const sim = makeSim(13, [{ x: 160, y: 120, count: 20, radius: 60, tribe: 'none' }]);
    sim.state.world.food.fill(8);
    for (const a of sim.state.agents) a.food = a.traits.maxFood * 0.2;
    const totalFood0 = sim.state.world.food.reduce((s, v) => s + v, 0);
    sim.run(150);
    const living = sim.state.agents.filter((a) => a.alive);
    const eaten = living.reduce((s, a) => s + a.stats.foodEaten, 0);
    expect(eaten).toBeGreaterThan(20);
    const avgFrac = living.reduce((s, a) => s + a.food / a.traits.maxFood, 0) / living.length;
    expect(avgFrac).toBeGreaterThan(0.35);
    expect(sim.state.world.food.reduce((s, v) => s + v, 0)).toBeLessThan(totalFood0 + 1e6);
  });

  it('produces no NaN / invalid state after 2000 ticks', () => {
    const sim = Simulation.create({ scenario: SCENARIOS[0], seed: 5 });
    sim.run(2000);
    expect(sim.state.agents.length).toBeGreaterThan(0);
    for (const a of sim.state.agents) {
      for (const v of [a.x, a.y, a.vx, a.vy, a.heading, a.fear ?? 0, a.decisionCooldown, a.actionTicks, a.carried, a.stats.distance]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(Number.isNaN(a.targetX) || Number.isFinite(a.targetX)).toBe(true);
      expect(Number.isNaN(a.targetY) || Number.isFinite(a.targetY)).toBe(true);
      expect(ACTIONS).toContain(a.action);
      expect(typeof a.thought).toBe('string');
      for (const k of Object.keys(a.utilities)) expect(Number.isFinite(a.utilities[k as keyof typeof a.utilities])).toBe(true);
      expect(a.memory.food.length).toBeLessThanOrEqual(4);
      expect(a.memory.danger.length).toBeLessThanOrEqual(3);
      expect(a.carried).toBeGreaterThanOrEqual(0);
      expect(sim.passableAt(a.x, a.y)).toBe(true);
    }
  });

  it('is deterministic for identical seeds', () => {
    const a = Simulation.create({ scenario: SCENARIOS[0], seed: 9 });
    const b = Simulation.create({ scenario: SCENARIOS[0], seed: 9 });
    a.run(600);
    b.run(600);
    expect(a.hash()).toBe(b.hash());
    expect(a.state.agents.map((x) => `${x.id}:${x.action}:${x.targetId}:${x.thought}`)).toEqual(
      b.state.agents.map((x) => `${x.id}:${x.action}:${x.targetId}:${x.thought}`),
    );
  });
});
