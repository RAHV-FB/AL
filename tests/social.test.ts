import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { createAgent } from '../src/sim/lifecycle';
import { randomGenes } from '../src/sim/genetics';
import { LIMITS } from '../src/sim/constants';
import {
  CAMP_RADIUS,
  SOCIAL_TUNING,
  adjustRelationship,
  attack,
  depositFood,
  foundTribe,
  getRelationship,
  isFriendly,
  isHostile,
  joinTribe,
  shareFood,
  stockpileCapacity,
  updateSocial,
  withdrawFood,
} from '../src/sim/social';
import { G, NONE, TERRAIN, type Agent, type ScenarioDef } from '../src/sim/types';

const EMPTY: ScenarioDef = {
  id: 'social-test',
  name: 'Social test',
  tagline: '',
  description: '',
  lookFor: [],
  config: {},
  world: {},
  populations: [],
  scheduled: [],
};

function makeSim(seed = 1): Simulation {
  const sim = Simulation.create({ scenario: EMPTY, seed, config: { worldWidth: 100, worldHeight: 100, disasterRate: 0 } });
  sim.state.world.terrain.fill(TERRAIN.Grass);
  return sim;
}

interface SpawnOpts {
  sociability?: number;
  aggression?: number;
}

/** Adult agent with predictable traits, added immediately (outside a tick). */
function spawn(sim: Simulation, x: number, y: number, o: SpawnOpts = {}): Agent {
  const genes = randomGenes(sim.rng);
  genes[G.size] = 0.5;
  if (o.sociability !== undefined) genes[G.sociability] = o.sociability;
  if (o.aggression !== undefined) genes[G.aggression] = o.aggression;
  const a = createAgent(sim, { x, y, genes });
  a.age = a.traits.maturityAge + 200;
  a.traits.sociability = o.sociability ?? a.traits.sociability;
  a.traits.aggression = o.aggression ?? a.traits.aggression;
  a.health = a.traits.maxHealth;
  a.food = a.traits.maxFood * 0.7;
  sim.addAgent(a);
  return a;
}

/** Advance only the social system (no brain/ecology), keeping the spatial index fresh. */
function stepSocial(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    sim.spatial.rebuild(sim.state.agents);
    updateSocial(sim);
    sim.flush();
    sim.state.tick++;
  }
}

/** Run updateSocial once at a tick where `a` gets its staggered per-agent update. */
function agentTurn(sim: Simulation, a: Agent): void {
  const P = SOCIAL_TUNING.agentPeriod;
  sim.state.tick = Math.ceil((sim.state.tick + 1) / P) * P + ((P - (a.id % P)) % P);
  sim.spatial.rebuild(sim.state.agents);
  updateSocial(sim);
  sim.flush();
}

const totalFood = (...xs: Agent[]) => xs.reduce((s, a) => s + a.food + a.carried, 0);

describe('relationships', () => {
  it('creates entries, clamps affinity to [-1,1] and keeps the kin flag', () => {
    const sim = makeSim();
    const a = spawn(sim, 100, 100);
    const b = spawn(sim, 110, 100);
    adjustRelationship(sim, a, b, 5);
    expect(getRelationship(a, b.id)!.affinity).toBe(1);
    adjustRelationship(sim, a, b, -10);
    expect(getRelationship(a, b.id)!.affinity).toBe(-1);
    adjustRelationship(sim, a, b, 0.5, 1);
    adjustRelationship(sim, a, b, 0.1); // a later non-kin interaction must not clear the kin flag
    expect(getRelationship(a, b.id)!.kin).toBe(1);
    adjustRelationship(sim, a, b, NaN);
    expect(Number.isFinite(getRelationship(a, b.id)!.affinity)).toBe(true);
    adjustRelationship(sim, a, a, 1); // self is ignored
    expect(getRelationship(a, a.id)).toBeUndefined();
    expect(a.relationships.length).toBe(1);
  });

  it('caps the list, evicting the weakest non-kin tie and never kin', () => {
    const sim = makeSim();
    const a = spawn(sim, 100, 100);
    const kin = [0, 1, 2].map((i) => spawn(sim, 120 + i, 100));
    for (const k of kin) adjustRelationship(sim, a, k, 0.01, 2);
    const others = Array.from({ length: 20 }, (_, i) => spawn(sim, 100 + i, 130));
    others.forEach((o, i) => adjustRelationship(sim, a, o, 0.2 + i * 0.03));
    expect(a.relationships.length).toBe(LIMITS.relationships);
    for (const k of kin) expect(getRelationship(a, k.id)?.kin).toBe(2);
    // the strongest non-kin ties survive, the weakest were evicted
    expect(getRelationship(a, others[19].id)).toBeDefined();
    expect(getRelationship(a, others[0].id)).toBeUndefined();
    const ids = a.relationships.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('decays toward 0 (kin slower) and prunes dead partners', () => {
    const sim = makeSim();
    const a = spawn(sim, 100, 100);
    const friend = spawn(sim, 400, 400);
    const kin = spawn(sim, 420, 400);
    const doomed = spawn(sim, 440, 400);
    adjustRelationship(sim, a, friend, 0.8);
    adjustRelationship(sim, a, kin, 0.8, 1);
    adjustRelationship(sim, a, doomed, 0.5);
    sim.killAgent(doomed, 'removed');
    agentTurn(sim, a);
    const fr = getRelationship(a, friend.id)!.affinity;
    const kr = getRelationship(a, kin.id)!.affinity;
    expect(fr).toBeLessThan(0.8);
    expect(fr).toBeGreaterThan(0);
    expect(kr).toBeGreaterThan(fr);
    expect(getRelationship(a, doomed.id)).toBeUndefined();
  });

  it('drops links to an agent the tick it dies (death hook), not only on the sweep', () => {
    const sim = makeSim();
    const a = spawn(sim, 100, 100);
    const b = spawn(sim, 110, 100);
    adjustRelationship(sim, a, b, 0.5);
    adjustRelationship(sim, b, a, 0.5);
    b.alive = false; // as during a tick: dead but not yet flushed
    sim.state.tick = 7 + ((SOCIAL_TUNING.agentPeriod - ((7 + a.id) % SOCIAL_TUNING.agentPeriod)) % SOCIAL_TUNING.agentPeriod) + 1; // not a's turn
    expect((sim.state.tick + a.id) % SOCIAL_TUNING.agentPeriod).not.toBe(0);
    updateSocial(sim);
    expect(getRelationship(a, b.id)).toBeUndefined();
  });
});

describe('attitudes', () => {
  it('isHostile: grudges and tribes at war; isFriendly: tribe-mates, kin, friends, allies', () => {
    const sim = makeSim();
    const a = spawn(sim, 100, 100);
    const b = spawn(sim, 110, 100);
    expect(isHostile(sim, a, b)).toBe(false);
    expect(isFriendly(sim, a, b)).toBe(false);
    adjustRelationship(sim, a, b, 0.5);
    expect(isFriendly(sim, a, b)).toBe(true);
    adjustRelationship(sim, a, b, -1);
    expect(isHostile(sim, a, b)).toBe(true);
    expect(isFriendly(sim, a, b)).toBe(false);

    const c = spawn(sim, 300, 300);
    const d = spawn(sim, 310, 300);
    const e = spawn(sim, 600, 600);
    const tc = foundTribe(sim, c, []);
    const te = foundTribe(sim, e, []);
    joinTribe(sim, d, tc.id);
    expect(isFriendly(sim, c, d)).toBe(true);
    expect(isHostile(sim, c, e)).toBe(false);
    tc.relations[te.id] = -0.6;
    te.relations[tc.id] = -0.6;
    expect(isHostile(sim, c, e)).toBe(true);
    tc.relations[te.id] = 0.7;
    te.relations[tc.id] = 0.7;
    expect(isFriendly(sim, c, e)).toBe(true);
    expect(isHostile(sim, c, e)).toBe(false);
  });
});

describe('combat', () => {
  it('deals damage, records the fight, creates a grudge and danger memory', () => {
    const sim = makeSim();
    const att = spawn(sim, 100, 100, { aggression: 0.8 });
    const def = spawn(sim, 104, 100);
    const h0 = def.health;
    const fights0 = sim.state.stats.counters.fights;
    sim.spatial.rebuild(sim.state.agents);
    attack(sim, att, def);
    expect(def.health).toBeLessThan(h0);
    expect(def.health).toBeGreaterThan(0);
    expect(att.health).toBeLessThan(att.traits.maxHealth); // retaliation
    expect(sim.state.stats.counters.fights).toBe(fights0 + 1);
    expect(att.stats.fights).toBe(1);
    expect(def.stats.fights).toBe(1);
    expect(def.lastAttackerId).toBe(att.id);
    expect(getRelationship(def, att.id)!.affinity).toBeLessThanOrEqual(SOCIAL_TUNING.attackGrudge + 1e-9);
    expect(isHostile(sim, def, att)).toBe(true);
    expect(def.memory.danger.length).toBe(1);
    expect(att.skills.combat).toBeGreaterThan(0);
    for (let i = 0; i < 6 && def.alive && att.alive; i++) {
      def.x += 30; // move so new danger spots are recorded
      sim.state.tick += 5;
      attack(sim, att, def);
    }
    expect(def.memory.danger.length).toBeLessThanOrEqual(LIMITS.dangerMemory);
    for (const x of [att, def]) {
      expect(Number.isFinite(x.health)).toBe(true);
      expect(x.health).toBeGreaterThanOrEqual(0);
    }
  });

  it('kills with cause "combat", credits the killer and loots carried food', () => {
    const sim = makeSim();
    const att = spawn(sim, 100, 100);
    const def = spawn(sim, 104, 100);
    def.carried = 12;
    def.health = 0.5;
    sim.spatial.rebuild(sim.state.agents);
    const deaths0 = sim.state.stats.counters.deathsByCause.combat;
    const before = totalFood(att, def);
    attack(sim, att, def);
    expect(def.alive).toBe(false);
    expect(def.deathCause).toBe('combat');
    expect(att.stats.kills).toBe(1);
    expect(sim.state.stats.counters.deathsByCause.combat).toBe(deaths0 + 1);
    expect(att.carried).toBeGreaterThanOrEqual(12 - 1e-9); // all carried food (+ stomach overflow)
    expect(def.carried).toBeCloseTo(0, 6);
    expect(totalFood(att, def)).toBeCloseTo(before, 6); // looting moves food, never creates it
    expect(att.history.some((h) => h.text.includes(def.name))).toBe(true);
  });

  it('theft conserves food (no food is created)', () => {
    const sim = makeSim();
    const att = spawn(sim, 100, 100, { aggression: 1 });
    const def = spawn(sim, 104, 100);
    def.carried = 30;
    // a blow does ~5.5–12.8 damage here: the defender survives but ends below 30 % health,
    // so besides carried food it also loses a little stomach food
    def.health = def.traits.maxHealth * 0.2 + 13;
    const food0 = def.food;
    sim.spatial.rebuild(sim.state.agents);
    const before = totalFood(att, def);
    attack(sim, att, def);
    expect(def.alive).toBe(true);
    expect(def.health).toBeLessThan(def.traits.maxHealth * 0.3);
    expect(def.food).toBeLessThan(food0);
    expect(totalFood(att, def)).toBeCloseTo(before, 6);
    expect(att.carried).toBeGreaterThan(0);
    expect(def.carried).toBeLessThan(30);
    expect(def.carried).toBeGreaterThanOrEqual(0);
    expect(def.food).toBeGreaterThanOrEqual(0);
  });

  it('group defence: nearby tribe-mates strike back and hold a grudge; tribe relations worsen', () => {
    const sim = makeSim();
    const att = spawn(sim, 100, 100);
    const def = spawn(sim, 106, 100);
    const mate = spawn(sim, 110, 104);
    const far = spawn(sim, 400, 400);
    const ta = foundTribe(sim, att, []);
    const td = foundTribe(sim, def, [mate, far]);
    sim.spatial.rebuild(sim.state.agents);
    attack(sim, att, def);
    expect(getRelationship(mate, att.id)!.affinity).toBeLessThan(0);
    expect(mate.stats.fights).toBe(1);
    expect(getRelationship(far, att.id)).toBeUndefined(); // too far to help
    expect(ta.relations[td.id]).toBeLessThan(0);
    expect(td.relations[ta.id]).toBeLessThan(0);
  });

  it('kin of the defender bear a grudge against the attacker', () => {
    const sim = makeSim();
    const att = spawn(sim, 100, 100);
    const def = spawn(sim, 104, 100);
    const mother = spawn(sim, 700, 700);
    adjustRelationship(sim, def, mother, 0.5, 1);
    adjustRelationship(sim, mother, def, 0.5, 1);
    sim.spatial.rebuild(sim.state.agents);
    attack(sim, att, def);
    expect(getRelationship(mother, att.id)!.affinity).toBeLessThan(SOCIAL_TUNING.grudge);
  });

  it('ignores dead or identical participants', () => {
    const sim = makeSim();
    const a = spawn(sim, 100, 100);
    const h = a.health;
    attack(sim, a, a);
    expect(a.health).toBe(h);
    expect(a.stats.fights).toBe(0);
  });
});

describe('food sharing', () => {
  it('moves food from carried first, then stomach above 50 %, conserving the total', () => {
    const sim = makeSim();
    const g = spawn(sim, 100, 100);
    const r = spawn(sim, 104, 100);
    g.carried = 10;
    g.food = g.traits.maxFood * 0.8;
    r.food = r.traits.maxFood * 0.1;
    const before = totalFood(g, r);
    const shares0 = sim.state.stats.counters.shares;
    const given = shareFood(sim, g, r, 1000);
    expect(given).toBeCloseTo(10 + g.traits.maxFood * 0.3, 6);
    expect(totalFood(g, r)).toBeCloseTo(before, 6);
    expect(g.carried).toBe(0);
    expect(g.food).toBeCloseTo(g.traits.maxFood * 0.5, 6);
    expect(r.food).toBeLessThanOrEqual(r.traits.maxFood + 1e-9);
    expect(g.stats.shared).toBeCloseTo(given, 6);
    expect(r.stats.received).toBeCloseTo(given, 6);
    expect(sim.state.stats.counters.shares).toBe(shares0 + 1);
    expect(getRelationship(r, g.id)!.affinity).toBeCloseTo(SOCIAL_TUNING.giftAffinityReceiver, 6);
    expect(getRelationship(g, r.id)!.affinity).toBeCloseTo(SOCIAL_TUNING.giftAffinityGiver, 6);
  });

  it('overflows into the receiver’s carried food when the stomach is full', () => {
    const sim = makeSim();
    const g = spawn(sim, 100, 100);
    const r = spawn(sim, 104, 100);
    g.carried = 8;
    r.food = r.traits.maxFood;
    const before = totalFood(g, r);
    expect(shareFood(sim, g, r, 8)).toBeCloseTo(8, 6);
    expect(r.food).toBe(r.traits.maxFood);
    expect(r.carried).toBeCloseTo(8, 6);
    expect(totalFood(g, r)).toBeCloseTo(before, 6);
  });

  it('never goes below zero and refuses invalid amounts', () => {
    const sim = makeSim();
    const g = spawn(sim, 100, 100);
    const r = spawn(sim, 104, 100);
    g.carried = 0;
    g.food = g.traits.maxFood * 0.4; // nothing spare
    expect(shareFood(sim, g, r, 10)).toBe(0);
    expect(shareFood(sim, g, r, NaN)).toBe(0);
    expect(shareFood(sim, g, r, -5)).toBe(0);
    expect(g.food).toBeCloseTo(g.traits.maxFood * 0.4, 9);
  });

  it('cross-tribe gifts improve tribe relations', () => {
    const sim = makeSim();
    const g = spawn(sim, 100, 100);
    const r = spawn(sim, 104, 100);
    const tg = foundTribe(sim, g, []);
    const tr = foundTribe(sim, r, []);
    g.carried = 20;
    shareFood(sim, g, r, 20);
    expect(tg.relations[tr.id]).toBeGreaterThan(0);
    expect(tr.relations[tg.id]).toBeGreaterThan(0);
  });
});

describe('tribe stockpile', () => {
  it('deposit / withdraw only near camp, conserving food', () => {
    const sim = makeSim();
    const a = spawn(sim, 200, 200);
    const b = spawn(sim, 204, 200);
    const t = foundTribe(sim, a, [b]);
    t.homeX = 200;
    t.homeY = 200;

    a.carried = 20;
    a.x = 200 + CAMP_RADIUS + 10;
    expect(depositFood(sim, a)).toBe(0);
    expect(a.carried).toBe(20);
    expect(t.stockpile).toBe(0);

    a.x = 200 + CAMP_RADIUS - 2;
    expect(depositFood(sim, a)).toBeCloseTo(20, 9);
    expect(a.carried).toBe(0);
    expect(t.stockpile).toBeCloseTo(20, 9);

    b.food = 0;
    b.x = 500;
    expect(withdrawFood(sim, b, 50)).toBe(0); // too far
    b.x = 205;
    const before = b.food + t.stockpile;
    const got = withdrawFood(sim, b, 50);
    expect(got).toBeCloseTo(20, 9); // limited by the stockpile
    expect(t.stockpile).toBe(0);
    expect(b.food + t.stockpile).toBeCloseTo(before, 9);
    expect(withdrawFood(sim, b, 10)).toBe(0); // empty

    // stomach room limits withdrawal too
    t.stockpile = 100;
    b.food = b.traits.maxFood - 5;
    expect(withdrawFood(sim, b, 50)).toBeCloseTo(5, 9);
    expect(t.stockpile).toBeCloseTo(95, 9);
  });

  it('unaffiliated agents cannot use stockpiles; deposits respect the cap', () => {
    const sim = makeSim();
    const loner = spawn(sim, 100, 100);
    loner.carried = 10;
    expect(depositFood(sim, loner)).toBe(0);
    expect(withdrawFood(sim, loner, 10)).toBe(0);

    const a = spawn(sim, 300, 300);
    const t = foundTribe(sim, a, []);
    a.x = t.homeX;
    a.y = t.homeY;
    const cap = stockpileCapacity(t);
    t.stockpile = cap - 3;
    a.carried = 10;
    expect(depositFood(sim, a)).toBeCloseTo(3, 9);
    expect(a.carried).toBeCloseTo(7, 9);
    expect(t.stockpile).toBeCloseTo(cap, 9);
  });

  it('spoils slowly and stays non-negative', () => {
    const sim = makeSim();
    const a = spawn(sim, 300, 300);
    const t = foundTribe(sim, a, []);
    t.stockpile = 100;
    stepSocial(sim, 301);
    expect(t.stockpile).toBeLessThan(100);
    expect(t.stockpile).toBeGreaterThan(85);
  });
});

describe('tribe dynamics', () => {
  it('a cluster of sociable agents that socialised founds a tribe and logs it', () => {
    const sim = makeSim(3);
    const cluster = Array.from({ length: 10 }, (_, i) =>
      spawn(sim, 300 + Math.cos(i) * 12, 300 + Math.sin(i) * 12, { sociability: 0.9 }),
    );
    // what the brain's 'socialize' action produces: mutual warm ties
    for (const a of cluster) for (const b of cluster) if (a !== b) adjustRelationship(sim, a, b, 0.25);
    expect(sim.state.tribes.length).toBe(0);
    stepSocial(sim, 600);
    const living = sim.state.tribes.filter((t) => t.extinctTick === -1);
    expect(living.length).toBeGreaterThanOrEqual(1);
    const inTribe = cluster.filter((a) => a.tribeId !== NONE).length;
    expect(inTribe).toBeGreaterThanOrEqual(8);
    const t = sim.getTribe(cluster.find((a) => a.tribeId !== NONE)!.tribeId)!;
    expect(t.members).toBeGreaterThanOrEqual(3);
    expect(t.peakMembers).toBeGreaterThanOrEqual(t.members);
    expect(t.meanGenes.length).toBe(cluster[0].genes.length);
    expect(sim.state.events.some((e) => e.category === 'tribe' && e.tribeId === t.id)).toBe(true);
  });

  it('sociable strangers living side by side bond through familiarity and eventually form a tribe', () => {
    const sim = makeSim(13);
    const cluster = Array.from({ length: 10 }, (_, i) =>
      spawn(sim, 300 + Math.cos(i) * 12, 300 + Math.sin(i) * 12, { sociability: 0.9 }),
    );
    stepSocial(sim, 120);
    expect(sim.state.tribes.length).toBe(0); // no instant tribes between strangers
    stepSocial(sim, 2400);
    expect(cluster.filter((a) => a.tribeId !== NONE).length).toBeGreaterThanOrEqual(5);
    expect(sim.state.events.some((e) => e.category === 'tribe' && /first tribe/.test(e.message))).toBe(true);
  });

  it('loners (low sociability) do not found tribes', () => {
    const sim = makeSim(4);
    for (let i = 0; i < 8; i++) spawn(sim, 300 + i * 4, 300, { sociability: 0.1 });
    stepSocial(sim, 600);
    expect(sim.state.tribes.length).toBe(0);
  });

  it('unaffiliated sociable agents join a nearby tribe', () => {
    const sim = makeSim(5);
    const members = Array.from({ length: 5 }, (_, i) => spawn(sim, 300 + i * 3, 300, { sociability: 0.8 }));
    const t = foundTribe(sim, members[0], members.slice(1));
    const newcomer = spawn(sim, 305, 310, { sociability: 0.9 });
    stepSocial(sim, 900);
    expect(newcomer.tribeId).toBe(t.id);
    expect(t.members).toBe(6);
  });

  it('members of a dwindling band drift into a larger, well-liked neighbouring tribe', () => {
    const sim = makeSim(12);
    const big = Array.from({ length: 8 }, (_, i) => spawn(sim, 300 + i * 3, 300, { sociability: 0.9 }));
    const tb = foundTribe(sim, big[0], big.slice(1));
    const small = [spawn(sim, 305, 306, { sociability: 0.9 }), spawn(sim, 310, 306, { sociability: 0.9 })];
    const ts = foundTribe(sim, small[0], [small[1]]);
    for (const a of small) for (const b of big) adjustRelationship(sim, a, b, 0.5);
    stepSocial(sim, 1500);
    expect(small.every((a) => a.tribeId === tb.id)).toBe(true);
    expect(ts.extinctTick).not.toBe(-1);
  });

  it('marks extinction when the last member dies and frees the territory', () => {
    const sim = makeSim();
    const a = spawn(sim, 300, 300);
    const b = spawn(sim, 305, 300);
    const t = foundTribe(sim, a, [b]);
    stepSocial(sim, 121); // territory claimed
    expect(t.territory).toBeGreaterThan(0);
    sim.killAgent(a, 'removed');
    sim.killAgent(b, 'removed');
    stepSocial(sim, SOCIAL_TUNING.tribePeriod + 1);
    expect(t.extinctTick).not.toBe(-1);
    expect(t.members).toBe(0);
    expect(t.stockpile).toBe(0);
    expect(Array.from(sim.state.world.territory).some((v) => v === t.id)).toBe(false);
    expect(sim.state.events.some((e) => e.category === 'tribe' && e.tribeId === t.id && /died out/.test(e.message))).toBe(true);
  });

  it('oversized, stretched tribes split into a daughter tribe', () => {
    const sim = makeSim(6);
    const near = Array.from({ length: 26 }, (_, i) => spawn(sim, 150 + (i % 6) * 5, 150 + Math.floor(i / 6) * 5, { sociability: 0.7 }));
    const away = Array.from({ length: 26 }, (_, i) => spawn(sim, 600 + (i % 6) * 5, 600 + Math.floor(i / 6) * 5, { sociability: 0.7 }));
    const t = foundTribe(sim, near[0], [...near.slice(1), ...away]);
    t.homeX = 160;
    t.homeY = 160;
    t.foundedTick = -5000;
    stepSocial(sim, 900);
    const daughter = sim.state.tribes.find((x) => x.parentTribeId === t.id);
    expect(daughter).toBeDefined();
    expect(daughter!.members).toBeGreaterThanOrEqual(5);
    expect(sim.state.events.some((e) => e.category === 'tribe' && /split from/.test(e.message))).toBe(true);
    const hueGap = Math.min(Math.abs(daughter!.hue - t.hue), 360 - Math.abs(daughter!.hue - t.hue));
    expect(hueGap).toBeGreaterThanOrEqual(20);
    expect(hueGap).toBeLessThanOrEqual(55);
  });

  it('territory map has the right size and only valid owners', () => {
    const sim = makeSim(7);
    const group = Array.from({ length: 6 }, (_, i) => spawn(sim, 200 + i * 4, 200, { sociability: 0.8 }));
    const t = foundTribe(sim, group[0], group.slice(1));
    const rivals = Array.from({ length: 6 }, (_, i) => spawn(sim, 560 + i * 4, 560, { sociability: 0.8 }));
    const r = foundTribe(sim, rivals[0], rivals.slice(1));
    stepSocial(sim, SOCIAL_TUNING.territoryPeriod + 1);
    const w = sim.state.world;
    expect(w.territory.length).toBe(w.width * w.height);
    const valid = new Set([-1, t.id, r.id]);
    let owned = 0;
    for (const v of w.territory) {
      expect(valid.has(v)).toBe(true);
      if (v === t.id) owned++;
    }
    expect(owned).toBe(t.territory);
    expect(t.territory).toBeGreaterThan(0);
    expect(r.territory).toBeGreaterThan(0);
    expect(w.territory[sim.tileIndex(t.homeX, t.homeY)]).toBe(t.id);
    expect(w.territory[sim.tileIndex(r.homeX, r.homeY)]).toBe(r.id);
  });

  it('assigns roles from skills and traits and counts them per tribe', () => {
    const sim = makeSim(8);
    const group = Array.from({ length: 6 }, (_, i) => spawn(sim, 200 + i * 4, 200, { sociability: 0.8 }));
    const t = foundTribe(sim, group[0], group.slice(1));
    group[1].skills.combat = 0.9;
    group[1].traits.aggression = 0.9;
    group[1].genes[G.aggression] = 0.9;
    group[2].skills.forage = 0.9;
    group[3].skills.social = 0.9;
    group[3].genes[G.altruism] = 0.9;
    stepSocial(sim, SOCIAL_TUNING.agentPeriod + SOCIAL_TUNING.tribePeriod + 1);
    expect(group[1].role).toBe('warrior');
    expect(group[2].role).toBe('forager');
    expect(group[3].role).toBe('caretaker');
    const total = Object.values(t.roles).reduce((s, v) => s + v, 0);
    expect(total).toBe(t.members);
    expect(group[1].skills.combat).toBeLessThan(0.9); // unused skills decay
  });

  it('war and peace are logged when relations cross the thresholds', () => {
    const sim = makeSim(9);
    const a = spawn(sim, 200, 200);
    const b = spawn(sim, 600, 600);
    const ta = foundTribe(sim, a, []);
    const tb = foundTribe(sim, b, []);
    for (let i = 0; i < 12; i++) {
      sim.state.tick += SOCIAL_TUNING.incidentGap + 1;
      a.x = b.x + 3;
      a.y = b.y;
      a.health = a.traits.maxHealth;
      b.health = b.traits.maxHealth;
      sim.spatial.rebuild(sim.state.agents);
      attack(sim, a, b);
    }
    expect(ta.relations[tb.id]).toBeLessThan(SOCIAL_TUNING.warDeclare);
    expect(sim.state.events.some((e) => e.category === 'conflict' && /at war/.test(e.message))).toBe(true);
    ta.relations[tb.id] = 0;
    tb.relations[ta.id] = 0;
    sim.state.tick = Math.ceil(sim.state.tick / SOCIAL_TUNING.tribePeriod) * SOCIAL_TUNING.tribePeriod;
    stepSocial(sim, 1);
    expect(sim.state.events.some((e) => e.category === 'conflict' && /Peace/.test(e.message))).toBe(true);
  });
});

describe('integration', () => {
  it('a full simulation with tribes keeps social state valid', () => {
    const scenario: ScenarioDef = {
      ...EMPTY,
      populations: [
        { x: 400, y: 400, count: 60, radius: 80, tribe: 'none', template: { sociability: 0.8 } },
        { x: 900, y: 600, count: 30, radius: 60, tribe: 'new', template: { aggression: 0.8 } },
      ],
    };
    const sim = Simulation.create({ scenario, seed: 11 });
    sim.run(700);
    const s = sim.state;
    for (const a of s.agents) {
      if (a.tribeId !== NONE) {
        const t = sim.getTribe(a.tribeId);
        expect(t && t.extinctTick === -1).toBe(true);
      }
      expect(a.relationships.length).toBeLessThanOrEqual(LIMITS.relationships);
      for (const r of a.relationships) {
        expect(r.id).not.toBe(a.id);
        expect(Number.isFinite(r.affinity) && r.affinity >= -1 && r.affinity <= 1).toBe(true);
      }
      expect(['none', 'forager', 'warrior', 'caretaker', 'explorer']).toContain(a.role);
    }
    for (const t of s.tribes) {
      expect(Number.isFinite(t.stockpile) && t.stockpile >= 0).toBe(true);
      for (const v of Object.values(t.relations)) expect(Number.isFinite(v) && v >= -1 && v <= 1).toBe(true);
      expect(t.homeX >= 0 && t.homeX <= sim.worldW && t.homeY >= 0 && t.homeY <= sim.worldH).toBe(true);
    }
    expect(s.world.territory.length).toBe(s.world.width * s.world.height);
  });
});
