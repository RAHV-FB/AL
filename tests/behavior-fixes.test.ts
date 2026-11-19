/**
 * Regression tests for defects found in the agent-intelligence / social audit. Tests whose name says
 * "(was: …)" or whose comment says "pre-fix" failed on the pre-audit code; the others pin behaviour
 * around those fixes (e.g. a sated parent must still feed its child after the share-ping-pong fix).
 */
import { describe, expect, it } from 'vitest';
import { think } from '../src/sim/brain';
import { clearPath } from '../src/sim/steering';
import {
  adjustRelationship,
  attack,
  carryCapacity,
  foundTribe,
  shareFood,
  stockpileCapacity,
  updateSocial,
} from '../src/sim/social';
import { NONE, TERRAIN } from '../src/sim/types';
import { brainTicks, decide, makeSim, paintTiles, setHunger, spawn } from './behavior-helpers';

describe('camp logistics', () => {
  it('a loaded gatherer does not loop on "deposit" at a full stockpile (was: stood at camp re-deciding every tick)', () => {
    const sim = makeSim(5);
    sim.state.world.food.fill(0);
    const a = spawn(sim, 200, 200);
    const tribe = foundTribe(sim, a, [], 'Testers');
    tribe.homeX = 200;
    tribe.homeY = 200;
    tribe.stockpile = stockpileCapacity(tribe);
    a.carried = carryCapacity(a);
    a.food = a.traits.maxFood;
    decide(sim, a);
    expect(a.action).not.toBe('deposit');
    // over a while it never gets stuck in the deposit loop (pre-fix: ~11% of all eden agent-samples)
    let depositTicks = 0;
    for (let i = 0; i < 300; i++) {
      brainTicks(sim, [a], 1);
      tribe.stockpile = stockpileCapacity(tribe);
      if (a.action === 'deposit') depositTicks++;
    }
    expect(depositTicks).toBe(0);
    // with room in the store it does deposit
    tribe.stockpile = 0;
    a.carried = carryCapacity(a);
    a.x = 260;
    decide(sim, a);
    expect(a.action).toBe('deposit');
  });
});

describe('reachability (rivers and walls)', () => {
  /** World with a 4-tile-wide deep-water channel at tiles x = 30..33. */
  function riverSim(seed: number) {
    const sim = makeSim(seed);
    paintTiles(sim, 30, 0, 33, sim.state.world.height - 1, TERRAIN.DeepWater);
    sim.state.world.food.fill(0);
    return sim;
  }
  const tile = (sim: ReturnType<typeof makeSim>, tx: number, ty: number) => ty * sim.state.world.width + tx;

  it('clearPath rejects a line across the channel and accepts one along the bank', () => {
    const sim = riverSim(1);
    expect(clearPath(sim, 36 * 8, 20 * 8, 26 * 8, 20 * 8)).toBe(false);
    expect(clearPath(sim, 36 * 8, 20 * 8, 36 * 8, 30 * 8)).toBe(true);
    expect(clearPath(sim, 36 * 8, 20 * 8, 31 * 8, 20 * 8)).toBe(false); // ends in deep water
  });

  it('a hungry agent prefers reachable food on its own bank over richer food across the river', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const sim = riverSim(seed);
      const a = spawn(sim, 35.5 * 8, 20.5 * 8, { perception: 0.8 });
      sim.state.world.food[tile(sim, 28, 20)] = 14; // just across the channel
      sim.state.world.food[tile(sim, 39, 26)] = 4; // poorer, but on this bank
      setHunger(a, 0.7);
      decide(sim, a);
      expect(a.action).toBe('forage');
      expect(a.targetX).toBeGreaterThan(34 * 8); // east bank
    }
  });

  it('with food only across the river, agents do not pin themselves against the bank (was: 3,200 stuck samples in two-civs)', () => {
    let pinned = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const sim = riverSim(seed);
      const a = spawn(sim, 35.5 * 8, 20.5 * 8, { perception: 0.8 });
      for (let ty = 10; ty <= 30; ty++) sim.state.world.food[tile(sim, 27, ty)] = 14;
      setHunger(a, 0.6);
      const x0 = a.x;
      const y0 = a.y;
      brainTicks(sim, [a], 200);
      if (a.action === 'forage' && a.targetX < 30 * 8) pinned++;
      expect(a.stats.distance).toBeGreaterThan(20);
      expect(Math.hypot(a.x - x0, a.y - y0)).toBeGreaterThan(5);
    }
    expect(pinned).toBe(0);
  });

  it('a fleeing agent with its back to the water runs for open ground', () => {
    const sim = riverSim(3);
    const a = spawn(sim, 34.5 * 8, 20.5 * 8, { size: 0.1, aggression: 0.02 });
    const brute = spawn(sim, 37.5 * 8, 20.5 * 8, { size: 1, aggression: 1 });
    brute.action = 'attack';
    brute.targetId = a.id;
    a.lastAttackerId = brute.id;
    decide(sim, a);
    expect(a.action).toBe('flee');
    expect(sim.passableAt(a.targetX, a.targetY)).toBe(true);
    expect(clearPath(sim, a.x, a.y, a.targetX, a.targetY)).toBe(true);
  });
});

describe('needs', () => {
  it('an exhausted but starving agent standing on food eats before resting', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const sim = makeSim(seed);
      sim.state.world.food.fill(0);
      const a = spawn(sim, 100, 100);
      sim.state.world.food[sim.tileIndex(a.x, a.y)] = 6;
      a.energy = 0.08;
      setHunger(a, 0.85);
      decide(sim, a);
      expect(a.action).toBe('eat');
    }
  });
});

describe('grudges and sharing', () => {
  it('an old attacker who has since become a close friend and tribe-mate is not attacked again (lastAttackerId is never cleared)', () => {
    let attacks = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const sim = makeSim(seed);
      sim.state.world.food.fill(5);
      const a = spawn(sim, 100, 100, { aggression: 0.6 });
      const b = spawn(sim, 115, 100, { aggression: 0.3 });
      foundTribe(sim, a, [b]);
      sim.spatial.rebuild(sim.state.agents);
      attack(sim, b, a);
      expect(a.lastAttackerId).toBe(b.id);
      a.health = a.traits.maxHealth;
      b.health = b.traits.maxHealth;
      adjustRelationship(sim, a, b, 1.5); // reconciled since
      sim.state.tick += 5000;
      b.action = 'eat';
      decide(sim, a);
      if (a.action === 'attack' && a.targetId === b.id) attacks++;
    }
    expect(attacks).toBe(0); // pre-fix: 20/20 seeds
  });

  it('the attacker is still fought back while it keeps attacking', () => {
    const sim = makeSim(4);
    const a = spawn(sim, 100, 100, { aggression: 0.8, size: 0.7 });
    const b = spawn(sim, 106, 100, { aggression: 0.3, size: 0.4 });
    sim.spatial.rebuild(sim.state.agents);
    attack(sim, b, a);
    b.action = 'attack';
    b.targetId = a.id;
    decide(sim, a);
    expect(a.action === 'attack' || a.action === 'flee').toBe(true);
    if (a.action === 'attack') expect(a.targetId).toBe(b.id);
  });

  it('two hungry kin carrying food do not just swap loads (share ping-pong)', () => {
    let mutual = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const sim = makeSim(seed);
      sim.state.world.food.fill(0);
      const a = spawn(sim, 100, 100, { altruism: 0.9 });
      const b = spawn(sim, 104, 100, { altruism: 0.9 });
      adjustRelationship(sim, a, b, 0.5, 2);
      adjustRelationship(sim, b, a, 0.5, 2);
      for (const x of [a, b]) {
        setHunger(x, 0.58);
        x.carried = 12;
      }
      sim.spatial.rebuild(sim.state.agents);
      think(sim, a);
      think(sim, b);
      if (a.action === 'share' && b.action === 'share') mutual++;
    }
    expect(mutual).toBe(0); // pre-fix: 3/20 seeds
  });

  it('a sated parent still feeds its hungry child', () => {
    const sim = makeSim(9);
    sim.state.world.food.fill(0);
    const p = spawn(sim, 100, 100, { altruism: 0.7 });
    const c = spawn(sim, 106, 100, {}, 100); // juvenile
    c.parents = [p.id, NONE];
    adjustRelationship(sim, p, c, 0.6, 1);
    p.food = p.traits.maxFood;
    p.carried = 10;
    setHunger(c, 0.7);
    decide(sim, p);
    expect(p.action).toBe('share');
    expect(p.targetId).toBe(c.id);
  });
});

describe('carried food stays within carry capacity', () => {
  it('looting a big load does not overfill the attacker (was: 65 carried vs capacity 27.5); food is conserved', () => {
    const sim = makeSim(3);
    const att = spawn(sim, 100, 100, { aggression: 1 });
    const def = spawn(sim, 104, 100);
    def.carried = 60;
    def.health = 0.5; // dies from the blow → full loot
    sim.spatial.rebuild(sim.state.agents);
    const before = att.food + att.carried + def.food + def.carried;
    attack(sim, att, def);
    expect(def.alive).toBe(false);
    expect(att.carried).toBeLessThanOrEqual(carryCapacity(att) + 1e-9);
    expect(att.food).toBeLessThanOrEqual(att.traits.maxFood + 1e-9);
    expect(att.food + att.carried + def.food + def.carried).toBeCloseTo(before, 6);
  });

  it('shareFood never gives more than the receiver can hold', () => {
    const sim = makeSim(2);
    const g = spawn(sim, 100, 100);
    const r = spawn(sim, 104, 100);
    g.carried = 25;
    g.food = g.traits.maxFood;
    r.food = r.traits.maxFood - 2;
    r.carried = carryCapacity(r) - 3;
    const before = g.food + g.carried + r.food + r.carried;
    const given = shareFood(sim, g, r, 100);
    expect(given).toBeCloseTo(5, 6);
    expect(r.carried).toBeLessThanOrEqual(carryCapacity(r) + 1e-9);
    expect(g.food + g.carried + r.food + r.carried).toBeCloseTo(before, 6);
  });
});

describe('relationships after deaths', () => {
  it('no living agent keeps a relationship to a dead agent after one social period', () => {
    const sim = makeSim(6);
    const group = Array.from({ length: 12 }, (_, i) => spawn(sim, 100 + (i % 4) * 6, 100 + Math.floor(i / 4) * 6));
    for (const a of group) for (const b of group) if (a !== b) adjustRelationship(sim, a, b, 0.2);
    // one-sided links (dead agent never recorded its admirer) must be pruned too
    const admirer = spawn(sim, 300, 300);
    adjustRelationship(sim, admirer, group[0], 0.5);
    group[0].relationships = group[0].relationships.filter((r) => r.id !== admirer.id);
    for (const d of group.slice(0, 4)) sim.killAgent(d, 'removed');
    for (let t = 0; t < 61; t++) {
      sim.spatial.rebuild(sim.state.agents);
      updateSocial(sim);
      sim.flush();
      sim.state.tick++;
    }
    for (const a of sim.state.agents) for (const r of a.relationships) expect(sim.getAgent(r.id)).toBeDefined();
  });
});
