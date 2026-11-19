/**
 * Competition emerges from traits × needs × odds × relations (no scripting): robbery and patch contests
 * by hungry, aggressive agents; territorial defence near camp; joining a friend's fight; raids between
 * tribes at war; timid agents keeping clear; numbers deterring attackers; bounded escalation.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { getScenario } from '../src/sim/presets';
import { SOCIAL_TUNING, adjustRelationship, attack, foundTribe, raidStockpile, updateSocial } from '../src/sim/social';
import { NONE, type Agent } from '../src/sim/types';
import { brainTicks, claimLand, decide, makeSim, setHunger, spawn } from './behavior-helpers';

/** Genes that make an agent look like a stranger to BASE agents (other hue / lineage, other temperament). */
const STRANGER = { hue: 0.95, sociability: 0.9, altruism: 0.9, perception: 0.2, fertility: 0.8 };

/** A hungry robber and a weaker stranger carrying a load, in a world with no food on the ground. */
function robberyScene(seed: number, robberAggression: number, robberHunger: number) {
  const sim = makeSim(seed);
  sim.state.world.food.fill(0);
  const robber = spawn(sim, 200, 200, { aggression: robberAggression, size: 0.6, speed: 0.8, hue: 0.05 });
  const victim = spawn(sim, 215, 200, { ...STRANGER, aggression: 0.1, size: 0.4, speed: 0.3 });
  setHunger(robber, robberHunger);
  setHunger(victim, 0.3);
  victim.carried = 20;
  victim.action = 'wander';
  return { sim, robber, victim };
}

describe('food competition', () => {
  it('a hungry, aggressive agent robs a weaker out-group carrier when there is nothing else to eat', () => {
    let robbed = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const { sim, robber, victim } = robberyScene(seed, 0.9, 0.7);
      decide(sim, robber);
      expect(robber.action).toBe('attack');
      expect(robber.targetId).toBe(victim.id);
      expect(robber.thought).toMatch(/robbing/);
      const total0 = robber.food + robber.carried + victim.food + victim.carried;
      const fights0 = sim.state.stats.counters.fights;
      brainTicks(sim, [robber, victim], 400, () => victim.carried < 20 - 1e-6);
      if (victim.carried < 20) robbed++;
      expect(sim.state.stats.counters.fights).toBeGreaterThan(fights0);
      // theft moves food, it never creates any
      expect(robber.food + robber.carried + victim.food + victim.carried).toBeLessThanOrEqual(total0 + 1e-6);
    }
    expect(robbed).toBeGreaterThanOrEqual(4);
  });

  it('a gentle agent in the same spot does not start a fight', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { sim, robber } = robberyScene(seed, 0.05, 0.7);
      decide(sim, robber);
      expect(robber.action).not.toBe('attack');
    }
  });

  it('a sated aggressive agent leaves the carrier alone', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { sim, robber } = robberyScene(seed, 0.9, 0.05);
      decide(sim, robber);
      expect(robber.action).not.toBe('attack');
    }
  });

  it('a robber picks the stranger over a look-alike of its own kind', () => {
    let stranger = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { sim, robber, victim } = robberyScene(seed, 0.9, 0.7);
      const kin = spawn(sim, 200, 215, { aggression: 0.9, size: 0.4, speed: 0.8, hue: 0.05 }); // same lineage look
      kin.carried = 20;
      setHunger(kin, 0.3);
      kin.action = 'wander';
      decide(sim, robber);
      expect(robber.targetId).not.toBe(kin.id);
      if (robber.action === 'attack' && robber.targetId === victim.id) stranger++;
    }
    expect(stranger).toBeGreaterThanOrEqual(5);
  });

  it('a carrier backed by its band is not attacked (numbers deter)', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { sim, robber, victim } = robberyScene(seed, 0.9, 0.7);
      const band = Array.from({ length: 6 }, (_, i) => spawn(sim, 222 + (i % 3) * 5, 194 + Math.floor(i / 3) * 10, { ...STRANGER, size: 0.4, aggression: 0.1 }));
      foundTribe(sim, victim, band);
      decide(sim, robber);
      expect(robber.action).not.toBe('attack');
    }
  });

  it('a starving aggressive agent contests a scarce patch with an out-group forager', () => {
    let contested = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const sim = makeSim(seed);
      sim.state.world.food.fill(0);
      const a = spawn(sim, 200, 200, { aggression: 0.9, size: 0.7, hue: 0.05 });
      const rival = spawn(sim, 216, 200, { ...STRANGER, aggression: 0.2, size: 0.4 });
      sim.state.world.food[sim.tileIndex(rival.x, rival.y)] = 6; // the only food around
      rival.action = 'eat';
      setHunger(a, 0.85);
      decide(sim, a);
      if (a.action === 'attack' && a.targetId === rival.id) contested++;
    }
    expect(contested).toBeGreaterThanOrEqual(4);
  });
});

describe('territory', () => {
  function territoryScene(seed: number, intruderDist: number) {
    const sim = makeSim(seed);
    sim.state.world.food.fill(0);
    const d = spawn(sim, 300, 200, { aggression: 0.95, size: 0.6, hue: 0.05 });
    const t = foundTribe(sim, d, [], 'Holders');
    t.homeX = 300;
    t.homeY = 200;
    claimLand(sim, 300, 200, 170, t.id);
    const intruder = spawn(sim, 300 + intruderDist, 200, { ...STRANGER, aggression: 0.1, size: 0.4 });
    sim.state.world.food[sim.tileIndex(intruder.x, intruder.y)] = 5;
    intruder.action = 'eat';
    d.x = intruder.x - 40;
    setHunger(d, 0.1);
    return { sim, d, intruder };
  }

  it('a bold member drives an outsider off the tribe land near camp', () => {
    let drove = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { sim, d, intruder } = territoryScene(seed, 40);
      decide(sim, d);
      if (d.action === 'attack' && d.targetId === intruder.id) {
        drove++;
        expect(d.thought).toMatch(/off our land/);
      }
    }
    expect(drove).toBeGreaterThanOrEqual(5);
  });

  it('…but leaves the same outsider alone far from camp', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { sim, d } = territoryScene(seed, 400);
      decide(sim, d);
      expect(d.action).not.toBe('attack');
    }
  });
});

describe('group fights', () => {
  it('a bold tribe-mate joins a friend’s fight', () => {
    let joined = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const sim = makeSim(seed);
      sim.state.world.food.fill(0);
      const m1 = spawn(sim, 200, 200, { aggression: 0.8 });
      const m2 = spawn(sim, 190, 200, { aggression: 0.8 });
      const t = foundTribe(sim, m1, [m2], 'Pack');
      t.homeX = 600;
      t.homeY = 380;
      const outsider = spawn(sim, 212, 200, { aggression: 0.3, size: 0.3 });
      setHunger(m2, 0.1);
      m1.action = 'attack';
      m1.targetId = outsider.id;
      decide(sim, m2);
      if (m2.action === 'attack' && m2.targetId === outsider.id) {
        joined++;
        expect(m2.thought).toMatch(/Joining the fight/);
      }
      // control: nobody fighting → no reason to attack
      m1.action = 'wander';
      m1.targetId = NONE;
      m2.action = 'idle';
      decide(sim, m2);
      expect(m2.action).not.toBe('attack');
    }
    expect(joined).toBeGreaterThanOrEqual(4);
  });
});

describe('war and raids', () => {
  function warScene(seed: number) {
    const sim = makeSim(seed, 80, 50, { aggressionBias: 1.5 });
    sim.state.world.food.fill(0);
    const r = spawn(sim, 150, 200, { aggression: 1 });
    const a = foundTribe(sim, r, [], 'Raiders');
    a.homeX = 150;
    a.homeY = 200;
    const e = spawn(sim, 450, 300, { aggression: 0.2 });
    const b = foundTribe(sim, e, [], 'Keepers');
    b.homeX = 450;
    b.homeY = 200;
    b.stockpile = 200;
    a.relations[b.id] = -0.8;
    b.relations[a.id] = -0.8;
    setHunger(r, 0.1);
    return { sim, r, a, b };
  }

  it('a bold member of a tribe at war raids the enemy camp and carries off part of its stockpile', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const { sim, r, a, b } = warScene(seed);
      decide(sim, r);
      expect(r.action).toBe('explore');
      expect(Math.hypot(r.targetX - b.homeX, r.targetY - b.homeY)).toBeLessThan(1);
      expect(r.thought).toMatch(/raiding/);
      const rel0 = a.relations[b.id];
      const store0 = b.stockpile;
      brainTicks(sim, [r], 900, () => r.carried > 0);
      expect(r.carried).toBeGreaterThan(0);
      expect(b.stockpile).toBeCloseTo(store0 - r.carried, 6); // moved, not created
      expect(a.relations[b.id]).toBeLessThan(rel0);
      expect(sim.state.events.some((ev) => ev.category === 'conflict' && /plundered the stockpile/.test(ev.message))).toBe(true);
    }
  });

  it('no raids without war, and raidStockpile refuses tribes at peace or raiders away from the camp', () => {
    const { sim, r, a, b } = warScene(1);
    a.relations[b.id] = 0;
    b.relations[a.id] = 0;
    decide(sim, r);
    expect(r.thought).not.toMatch(/raiding/);
    r.x = b.homeX;
    r.y = b.homeY;
    expect(raidStockpile(sim, r, b)).toBe(0); // at peace
    a.relations[b.id] = -0.8;
    b.relations[a.id] = -0.8;
    r.x = b.homeX + 200;
    expect(raidStockpile(sim, r, b)).toBe(0); // not at their camp
    r.x = b.homeX;
    r.carried = 0;
    const got = raidStockpile(sim, r, b);
    expect(got).toBeGreaterThan(0);
    expect(r.carried).toBeLessThanOrEqual(25 * r.traits.size + 1e-9);
  });

  it('hostility saturates: each new clash deepens a war less than the first one did', () => {
    const sim = makeSim(4);
    const x = spawn(sim, 100, 100);
    const y = spawn(sim, 104, 100);
    const tx = foundTribe(sim, x, []);
    const ty = foundTribe(sim, y, []);
    sim.spatial.rebuild(sim.state.agents);
    attack(sim, x, y);
    const first = -tx.relations[ty.id];
    tx.relations[ty.id] = -0.85;
    ty.relations[tx.id] = -0.85;
    sim.state.tick += 100;
    x.health = x.traits.maxHealth;
    y.health = y.traits.maxHealth;
    attack(sim, x, y);
    const later = -0.85 - tx.relations[ty.id];
    expect(first).toBeGreaterThan(0);
    expect(later).toBeGreaterThan(0);
    expect(later).toBeLessThan(first * 0.5);
  });

  it('a war without contact cools down to peace', () => {
    const sim = makeSim(5);
    const x = spawn(sim, 100, 100);
    const y = spawn(sim, 500, 300);
    const tx = foundTribe(sim, x, []);
    const ty = foundTribe(sim, y, []);
    tx.relations[ty.id] = -0.9;
    ty.relations[tx.id] = -0.9;
    for (let t = 0; t < 4 * 600; t++) {
      sim.spatial.rebuild(sim.state.agents);
      updateSocial(sim);
      sim.state.tick++;
    }
    // relDrift alone: -0.9 × 0.985^80 ≈ -0.27 — no longer hostile (warHostile -0.35)
    expect(tx.relations[ty.id]).toBeGreaterThan(SOCIAL_TUNING.warHostile);
  });
});

describe('avoidance', () => {
  function avoidScene(seed: number, aggression: number) {
    const sim = makeSim(seed);
    sim.state.world.food.fill(0);
    const t = spawn(sim, 200, 200, { aggression, size: 0.3 });
    sim.state.world.food[sim.tileIndex(t.x, t.y)] = 5;
    setHunger(t, 0.3);
    const s = spawn(sim, 220, 200, { aggression: 1, size: 1 });
    s.action = 'wander';
    return { sim, t, s };
  }

  it('a timid agent gives a fierce, much stronger stranger a wide berth', () => {
    let fled = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const { sim, t, s } = avoidScene(seed, 0.05);
      decide(sim, t);
      if (t.action === 'flee') {
        fled++;
        expect(t.targetId).toBe(s.id);
      }
    }
    expect(fled).toBeGreaterThanOrEqual(4);
  });

  it('a bold agent keeps eating', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { sim, t } = avoidScene(seed, 0.8);
      decide(sim, t);
      expect(t.action).toBe('eat');
    }
  });
});

describe('tribe formation and fission', () => {
  function stepSocial(sim: Simulation, ticks: number): void {
    for (let i = 0; i < ticks; i++) {
      sim.spatial.rebuild(sim.state.agents);
      updateSocial(sim);
      sim.flush();
      sim.state.tick++;
    }
  }
  function sociable(sim: Simulation, x: number, y: number): Agent {
    const a = spawn(sim, x, y, { sociability: 0.9 });
    a.food = a.traits.maxFood * 0.8;
    return a;
  }

  it('four friends are too few to found a tribe; five do', () => {
    const sim = makeSim(3);
    const small = Array.from({ length: 4 }, (_, i) => sociable(sim, 100 + i * 4, 100));
    const big = Array.from({ length: 5 }, (_, i) => sociable(sim, 500 + i * 4, 300));
    for (const grp of [small, big]) for (const p of grp) for (const q of grp) if (p !== q) adjustRelationship(sim, p, q, 0.5);
    stepSocial(sim, 900);
    expect(small.every((a) => a.tribeId === NONE)).toBe(true);
    expect(big.filter((a) => a.tribeId !== NONE).length).toBeGreaterThanOrEqual(5);
  });

  it('a compact tribe of 100 stays whole; one of 130 splits into two sizeable tribes', () => {
    for (const n of [100, 130]) {
      const sim = makeSim(8, 120, 80);
      const members = Array.from({ length: n }, (_, i) => sociable(sim, 400 + (i % 12) * 6, 300 + Math.floor(i / 12) * 6));
      const t = foundTribe(sim, members[0], members.slice(1), 'Big');
      t.homeX = 433;
      t.homeY = 330;
      t.foundedTick = -5000;
      stepSocial(sim, 900);
      const daughters = sim.state.tribes.filter((x) => x.parentTribeId === t.id);
      if (n === 100) expect(daughters.length).toBe(0);
      else {
        expect(daughters.length).toBeGreaterThanOrEqual(1);
        for (const d of daughters) expect(d.members).toBeGreaterThanOrEqual(10);
        expect(t.members).toBeGreaterThanOrEqual(10);
        // sister tribes part as friends
        expect(t.relations[daughters[0].id]).toBeGreaterThan(0.3);
      }
    }
  });
});

describe('presets (headless)', () => {
  it('fittest: hungry, aggressive loners fight from the start, without wiping each other out', () => {
    const sim = Simulation.create({ scenario: getScenario('fittest'), seed: 42 });
    const pop0 = sim.state.agents.length;
    sim.run(1500);
    let fights = 0;
    let combat = 0;
    for (const smp of sim.state.stats.samples) {
      fights += smp.fights;
      combat += smp.deathsByCause.combat;
    }
    expect(fights).toBeGreaterThanOrEqual(60); // pre-audit: 16 fights in 3000 ticks
    expect(combat).toBeLessThan(pop0 * 0.1);
    expect(sim.state.agents.length).toBeGreaterThan(pop0 * 0.3);
  }, 120_000);

  it('eden: gentle bands stay peaceful and form a handful of sizeable tribes', () => {
    const sim = Simulation.create({ scenario: getScenario('eden'), seed: 42 });
    sim.run(2400);
    let fights = 0;
    for (const smp of sim.state.stats.samples) fights += smp.fights;
    expect(fights).toBeLessThanOrEqual(10);
    const live = sim.state.tribes.filter((t) => t.extinctTick === -1);
    expect(live.length).toBeGreaterThanOrEqual(3);
    expect(live.length).toBeLessThanOrEqual(15);
    const sizes = live.map((t) => sim.state.agents.filter((a) => a.tribeId === t.id).length);
    expect(sizes.reduce((s, v) => s + v, 0) / sizes.length).toBeGreaterThanOrEqual(30);
  }, 120_000);
});

