import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { act, carryCapacity, think } from '../src/sim/brain';
import { clearPath } from '../src/sim/steering';
import { createAgent } from '../src/sim/lifecycle';
import { randomGenes } from '../src/sim/genetics';
import { foundTribe } from '../src/sim/social';
import { tileCapacity } from '../src/sim/ecology';
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
    // a well-stocked home range (genetics.canMate requires food around the couple); both are sated, so
    // they do not stop to eat
    const w = sim.state.world;
    for (let i = 0; i < w.food.length; i++) w.food[i] = tileCapacity(sim, i);
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

// ------------------------------------------------------------------ think/act consistency (verifier regressions)

describe('brain: no decision that act() cancels every tick', () => {
  it('a badly wounded agent under attack breaks off and flees instead of freezing in a fight it cannot carry on', () => {
    // pre-fix: think chose "Fighting back" below 35% health, actAttack broke off at once (decisionCooldown 0),
    // so the agent re-thought every tick, never struck and never moved while being hit
    let attackTicks = 0;
    for (const aggression of [0.5, 0.8, 1]) {
      for (let seed = 1; seed <= 3; seed++) {
        const sim = makeSim(seed);
        sim.state.world.food.fill(0);
        const d = spawn(sim, 160, 120, { aggression, size: 0.9 });
        const att = spawn(sim, 166, 120, { aggression: 0.9, size: 0.05 }); // far weaker: worth fighting when healthy
        d.health = d.traits.maxHealth * 0.3;
        d.lastAttackerId = att.id;
        const d0 = dist(d, att);
        let thinks = 0;
        for (let t = 0; t < 40; t++) {
          att.action = 'attack';
          att.targetId = d.id;
          att.decisionCooldown = 1000;
          sim.spatial.rebuild(sim.state.agents);
          if (d.decisionCooldown <= 0) {
            think(sim, d);
            thinks++;
          } else d.decisionCooldown--;
          act(sim, d);
          if (d.action === 'attack') attackTicks++;
          sim.state.tick++;
        }
        expect(thinks).toBeLessThan(20);
        expect(dist(d, att)).toBeGreaterThan(d0 + 10);
      }
    }
    expect(attackTicks).toBe(0);
  });

  it('a raider does not stay rooted in an enemy camp with nothing left to plunder', () => {
    // pre-fix: the raid on an empty store was re-chosen every tick on arrival ("At war — raiding the camp")
    for (let seed = 1; seed <= 3; seed++) {
      const sim = makeSim(seed);
      sim.state.world.food.fill(0);
      const r = spawn(sim, 260, 120, { aggression: 1 });
      const own = foundTribe(sim, r, [], 'Raiders');
      own.homeX = 40;
      own.homeY = 120;
      const e = spawn(sim, 300, 220, { aggression: 0.2 });
      const enemy = foundTribe(sim, e, [], 'Keepers');
      enemy.homeX = 260;
      enemy.homeY = 120;
      enemy.stockpile = 0;
      own.relations[enemy.id] = -0.8;
      enemy.relations[own.id] = -0.8;
      let thinks = 0;
      let raiding = 0;
      for (let t = 0; t < 200; t++) {
        sim.spatial.rebuild(sim.state.agents);
        if (r.decisionCooldown <= 0) {
          think(sim, r);
          thinks++;
          if (/raiding/.test(r.thought)) raiding++;
        } else r.decisionCooldown--;
        act(sim, r);
        r.food = r.traits.maxFood * 0.9;
        r.energy = 1;
        sim.state.tick++;
      }
      expect(raiding).toBe(0);
      expect(thinks).toBeLessThan(150);
      expect(r.carried).toBe(0);
    }
  });

  it('a one-tile painted wall counts as blocking (agents are not pinned against it); rocks and short stubs do not', () => {
    const wallColumn = (sim: Simulation, tx: number, ty0: number, ty1: number) => {
      const w = sim.state.world;
      for (let ty = ty0; ty <= ty1; ty++) w.terrain[ty * w.width + tx] = TERRAIN.Wall;
      w.terrainVersion++;
    };
    const t = (v: number) => (v + 0.5) * 8; // tile centre (tileSize 8)
    const probe = makeSim(1);
    wallColumn(probe, 20, 0, 29); // across the whole map
    wallColumn(probe, 10, 5, 5); // a single rock
    wallColumn(probe, 30, 10, 12); // a three-tile stub
    expect(clearPath(probe, t(23), t(15), t(16), t(15))).toBe(false);
    expect(clearPath(probe, t(7), t(5), t(13), t(5))).toBe(true);
    expect(clearPath(probe, t(27), t(11), t(33), t(11))).toBe(true);
    // pre-fix: a hungry agent kept foraging at the wall toward food it could never reach, in 5/5 seeds
    for (let seed = 1; seed <= 5; seed++) {
      const sim = makeSim(seed);
      wallColumn(sim, 20, 0, 29);
      sim.state.world.food.fill(0);
      for (let ty = 5; ty <= 25; ty++) sim.state.world.food[ty * sim.state.world.width + 16] = 14;
      const a = spawn(sim, t(23), t(15), { perception: 0.8 });
      a.food = a.traits.maxFood * 0.4;
      const x0 = a.x;
      const y0 = a.y;
      brainTicks(sim, [a], 300);
      expect(a.action === 'forage' && a.targetX < 20 * 8).toBe(false);
      expect(Math.hypot(a.x - x0, a.y - y0)).toBeGreaterThan(20);
    }
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
