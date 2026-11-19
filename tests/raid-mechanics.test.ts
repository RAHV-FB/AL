/**
 * Raid mechanics (owner: raids workstream), on small all-grass worlds: raid treks hold through the night and turn
 * for home when the raid is over, raids are valued by walking distance, old rivalries cool slowly and pass to
 * daughter tribes, raiders away from home neither drag the camp nor split off, children stay home, and raid treks
 * and rivalries are validated on load and covered by hash().
 */
import { describe, expect, it } from 'vitest';
import { act, raidLeg, walkDistance, RAID_TREK_TICKS } from '../src/sim/brain';
import { SOCIAL_TUNING, areRivals, declareRivalry, foundTribe, joinTribe, updateSocial } from '../src/sim/social';
import { Simulation } from '../src/sim/simulation';
import { getScenario } from '../src/sim/presets';
import { deserializeState, loadSim, serializeSim } from '../src/sim/persistence';
import { NONE, TERRAIN, type Agent, type Tribe } from '../src/sim/types';
import { brainTicks, decide, makeSim, paintTiles, setHunger, spawn } from './behavior-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** A tribe founded by `founder` with its camp exactly at (x,y). */
function tribeAt(sim: Simulation, founder: Agent, name: string, x: number, y: number): Tribe {
  const t = foundTribe(sim, founder, [], name);
  t.homeX = x;
  t.homeY = y;
  return t;
}

function atWar(a: Tribe, b: Tribe, rel = -0.8): void {
  a.relations[b.id] = rel;
  b.relations[a.id] = rel;
}

/** Raider tribe camp at (150,200), enemy camp at (1000,200) with a full store, on a 200×50-tile grass world. */
function raidScene(seed: number) {
  const sim = makeSim(seed, 200, 50, { aggressionBias: 1.5 });
  const r = spawn(sim, 500, 200, { aggression: 1, sociability: 0.8 });
  const own = tribeAt(sim, r, 'Raiders', 150, 200);
  const enemy = tribeAt(sim, spawn(sim, 1000, 230, { aggression: 0.1 }), 'Keepers', 1000, 200);
  enemy.stockpile = 300;
  atWar(own, enemy);
  setHunger(r, 0.1);
  r.energy = 0.75;
  return { sim, r, own, enemy };
}

/** A tribe pass (and agent updates) every 30 ticks, from `from` on. */
function socialPasses(sim: Simulation, from: number, passes: number, stop?: () => boolean): void {
  for (let k = 0; k < passes; k++) {
    sim.state.tick = from + k * 30;
    sim.spatial.rebuild(sim.state.agents);
    updateSocial(sim);
    if (stop && stop()) return;
  }
}

describe('raid treks', () => {
  it('a raider commits to the march, sleeps where it is at night instead of turning home, and marches on at dawn', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const { sim, r, enemy } = raidScene(seed);
      decide(sim, r);
      expect(r.action).toBe('explore');
      expect(Math.hypot(r.targetX - enemy.homeX, r.targetY - enemy.homeY)).toBeLessThan(1);
      expect(r.thought).toMatch(/raiding the camp of the Keepers/);
      expect(r.trek).toEqual({ x: enemy.homeX, y: enemy.homeY, until: sim.tick + RAID_TREK_TICKS, kind: 'raid', tribe: enemy.id });
      expect(raidLeg(r)).toBe('out');

      // night: a raider on the march sleeps out; an otherwise identical agent that is not on a raid walks home
      sim.state.env.daylight = 0;
      r.energy = 0.6;
      r.decisionCooldown = 0;
      decide(sim, r);
      expect(r.action, `seed ${seed}: night on the march`).toBe('rest');
      expect(r.thought).toBe('Night, sleeping on the way to raid the Keepers');
      expect(raidLeg(r)).toBe('out');
      const homebody = spawn(sim, 500, 170, { aggression: 1, sociability: 0.8 });
      joinTribe(sim, homebody, r.tribeId);
      setHunger(homebody, 0.1);
      homebody.energy = 0.6;
      decide(sim, homebody);
      expect(homebody.action, `seed ${seed}: night without a raid`).toBe('gohome');

      // dawn: the march goes on
      sim.state.env.daylight = 1;
      r.energy = 0.75;
      decide(sim, r);
      expect(r.action).toBe('explore');
      expect(Math.hypot(r.targetX - enemy.homeX, r.targetY - enemy.homeY)).toBeLessThan(1);
    }
  });

  it('a badly hurt raider gives up and heads home; the trek then names its own tribe', () => {
    const { sim, r, own } = raidScene(4);
    decide(sim, r);
    expect(raidLeg(r)).toBe('out');
    r.health = r.traits.maxHealth * 0.4;
    decide(sim, r);
    expect(raidLeg(r)).toBe('home');
    expect(r.trek!.tribe).toBe(own.id);
    expect(r.action).toBe('gohome');
    expect(r.thought).toMatch(/heading home after a raid/);
  });

  it('a raider that plunders the enemy store carries the loot home and stores it there', () => {
    const sim = makeSim(5, 200, 50, { aggressionBias: 1.5 });
    const r = spawn(sim, 995, 200, { aggression: 1 });
    const own = tribeAt(sim, r, 'Raiders', 600, 200);
    const enemy = tribeAt(sim, spawn(sim, 1000, 260, { aggression: 0.1 }), 'Keepers', 1000, 200);
    enemy.stockpile = 300;
    atWar(own, enemy);
    setHunger(r, 0.1);
    r.trek = { x: enemy.homeX, y: enemy.homeY, until: sim.tick + RAID_TREK_TICKS, kind: 'raid', tribe: enemy.id };
    r.action = 'explore';
    r.targetX = enemy.homeX;
    r.targetY = enemy.homeY;
    r.decisionCooldown = 5;
    sim.spatial.rebuild(sim.state.agents);
    act(sim, r);
    const loot = r.carried;
    expect(loot).toBeGreaterThan(5);
    expect(enemy.stockpile).toBeCloseTo(300 - loot, 6); // moved, not created
    expect(raidLeg(r), 'loaded: the raid turns for home').toBe('home');
    expect(sim.state.events.some((e) => e.message === 'Raiders of the Raiders plundered the stockpile of the Keepers.')).toBe(true);
    brainTicks(sim, [r], 3000, () => own.stockpile > 0);
    expect(own.stockpile).toBeCloseTo(loot, 6);
    expect(r.carried).toBeLessThan(0.5);
    r.decisionCooldown = 0;
    decide(sim, r);
    expect(raidLeg(r), 'home again: the way home is over (it may well set out on the next raid)').not.toBe('home');
  });

  it('raids are valued by walking distance: a camp behind a long wall loses to a farther one in the open', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const sim = makeSim(seed, 200, 50, { aggressionBias: 1.5 });
      paintTiles(sim, 100, 0, 100, 44, TERRAIN.Wall); // a wall at x 800..808 with a gap at the bottom (y > 360)
      const r = spawn(sim, 760, 60, { aggression: 1 });
      const own = tribeAt(sim, r, 'Raiders', 760, 200);
      const behind = tribeAt(sim, spawn(sim, 900, 120, { aggression: 0.1 }), 'Behind', 860, 60); // 100 away, ~700 on foot
      const open = tribeAt(sim, spawn(sim, 440, 120, { aggression: 0.1 }), 'Open', 460, 60); // 300 away, 300 on foot
      for (const e of [behind, open]) {
        e.stockpile = 300;
        atWar(own, e);
      }
      setHunger(r, 0.1);
      r.energy = 0.8;
      expect(walkDistance(sim, open, r.x, r.y)).toBeLessThan(330);
      expect(walkDistance(sim, behind, r.x, r.y)).toBeGreaterThan(600);
      decide(sim, r);
      expect(r.action, `seed ${seed}`).toBe('explore');
      expect(r.trek?.tribe, `seed ${seed}: raids the camp that is nearer on foot`).toBe(open.id);
    }
  });

  it('children stay home when their parent goes raiding', () => {
    for (const raiding of [false, true]) {
      const sim = makeSim(6);
      const mom = spawn(sim, 300, 200, { aggression: 1 });
      const tribe = tribeAt(sim, mom, 'Kin', 240, 200);
      const enemy = tribeAt(sim, spawn(sim, 600, 300), 'Far', 600, 300);
      const kid = spawn(sim, 240, 200, {}, 100);
      joinTribe(sim, kid, tribe.id);
      kid.parents = [mom.id, NONE];
      if (raiding) mom.trek = { x: enemy.homeX, y: enemy.homeY, until: sim.tick + RAID_TREK_TICKS, kind: 'raid', tribe: enemy.id };
      decide(sim, kid);
      if (raiding) {
        expect(kid.targetId).not.toBe(mom.id);
        expect(kid.thought).not.toMatch(/mother/);
      } else {
        expect(kid.targetId).toBe(mom.id);
        expect(kid.thought).toBe(`Following my mother ${mom.name}`);
      }
    }
  });

  it('raiders on a raid do not court and are not courted', () => {
    for (const raiding of [false, true]) {
      const sim = makeSim(7);
      const a = spawn(sim, 300, 200, { fertility: 1, aggression: 0.6 });
      const b = spawn(sim, 304, 200, { fertility: 1, aggression: 0.6 });
      const tribe = tribeAt(sim, a, 'Pair', 300, 200);
      joinTribe(sim, b, tribe.id);
      const enemy = tribeAt(sim, spawn(sim, 600, 300), 'Far', 600, 300);
      for (const x of [a, b]) setHunger(x, 0.05);
      if (raiding) a.trek = { x: enemy.homeX, y: enemy.homeY, until: sim.tick + RAID_TREK_TICKS, kind: 'raid', tribe: enemy.id };
      decide(sim, b);
      if (raiding) expect(b.action === 'mate' && b.targetId === a.id).toBe(false);
      else expect(b.action === 'mate' && b.targetId === a.id).toBe(true);
      if (raiding) {
        decide(sim, a);
        expect(a.action).not.toBe('mate');
      }
    }
  });
});

describe('old rivalries', () => {
  it('old rivals stay at war for days without contact, while other enmities cool within two', () => {
    const sim = makeSim(8, 200, 50);
    const a = tribeAt(sim, spawn(sim, 100, 100), 'Hill', 100, 100);
    const b = tribeAt(sim, spawn(sim, 1500, 100), 'Vale', 1500, 100);
    const c = tribeAt(sim, spawn(sim, 100, 300), 'Reed', 100, 300);
    const d = tribeAt(sim, spawn(sim, 1500, 300), 'Moor', 1500, 300);
    declareRivalry(sim, a, b, -0.6);
    expect(a.relations[b.id]).toBeCloseTo(-0.6, 9);
    expect(b.relations[a.id]).toBeCloseTo(-0.6, 9);
    expect(areRivals(sim, a.id, b.id)).toBe(true);
    expect(areRivals(sim, c.id, d.id)).toBe(false);
    expect(sim.state.events.map((e) => e.message)).toContain('War: the Hill and the Vale are now at war.');
    atWar(c, d, -0.6);
    socialPasses(sim, 30, 60); // three days
    expect(a.relations[b.id], 'old rivals').toBeLessThan(-0.45);
    expect(c.relations[d.id], 'an ordinary war').toBeGreaterThan(SOCIAL_TUNING.warHostile);
    // the rivalry ends with peace
    atWar(a, b, -0.05);
    socialPasses(sim, 30 * 61, 1);
    expect(areRivals(sim, a.id, b.id)).toBe(false);
  });

  it('a daughter tribe inherits its parent’s old rivalry', () => {
    const sim = makeSim(9, 200, 50);
    const p = tribeAt(sim, spawn(sim, 300, 200), 'Parent', 300, 200);
    const rival = tribeAt(sim, spawn(sim, 1500, 200), 'Rival', 1500, 200);
    declareRivalry(sim, p, rival, -0.7);
    for (let i = 0; i < 19; i++) joinTribe(sim, spawn(sim, 290 + (i % 5) * 4, 190 + Math.floor(i / 5) * 4), p.id);
    for (let i = 0; i < 30; i++) joinTribe(sim, spawn(sim, 700 + (i % 6) * 4, 180 + Math.floor(i / 6) * 4), p.id); // far from camp
    socialPasses(sim, 960, 60, () => sim.state.tribes.some((t) => t.parentTribeId === p.id));
    const daughter = sim.state.tribes.find((t) => t.parentTribeId === p.id);
    expect(daughter, 'the stretched tribe split').toBeDefined();
    expect(areRivals(sim, daughter!.id, rival.id)).toBe(true);
    expect(areRivals(sim, p.id, rival.id)).toBe(true);
    expect(daughter!.relations[rival.id]).toBeLessThan(SOCIAL_TUNING.warHostile);
  });
});

describe('members away on a raid', () => {
  function stretchedTribe(seed: number, raiding: boolean, awayX: number) {
    const sim = makeSim(seed, 200, 50);
    const t = tribeAt(sim, spawn(sim, 300, 200), 'Home', 300, 200);
    const enemy = tribeAt(sim, spawn(sim, 1500, 200), 'Enemy', 1500, 200);
    atWar(t, enemy);
    for (let i = 0; i < 19; i++) joinTribe(sim, spawn(sim, 290 + (i % 5) * 4, 190 + Math.floor(i / 5) * 4), t.id);
    for (let i = 0; i < 30; i++) {
      const m = spawn(sim, awayX + (i % 6) * 4, 180 + Math.floor(i / 6) * 4);
      joinTribe(sim, m, t.id);
      if (raiding) m.trek = { x: enemy.homeX, y: enemy.homeY, until: 1_000_000, kind: 'raid', tribe: enemy.id };
    }
    return { sim, t };
  }

  it('do not drag the camp after them', () => {
    for (const raiding of [false, true]) {
      const { sim, t } = stretchedTribe(10, raiding, 520); // within the camp's pull, 220 units east
      socialPasses(sim, 30, 20);
      if (raiding) expect(Math.abs(t.homeX - 300), 'raiders away: the camp stays').toBeLessThan(15);
      else expect(t.homeX - 300, 'members at home pull the camp').toBeGreaterThan(40);
    }
  });

  it('do not split off as a new tribe', () => {
    for (const raiding of [false, true]) {
      const { sim, t } = stretchedTribe(11, raiding, 700); // beyond fissionFar: a stretched tribe
      socialPasses(sim, 960, 40, () => sim.state.tribes.some((x) => x.parentTribeId === t.id));
      expect(sim.state.tribes.some((x) => x.parentTribeId === t.id), raiding ? 'raiding party' : 'settlers far away').toBe(!raiding);
    }
  });
});

describe('raid treks and rivalries in save files', () => {
  const base = (() => {
    const sim = Simulation.create({ scenario: getScenario('two-civs'), seed: 42 });
    sim.run(300);
    return sim;
  })();
  const tamper = (mutate: (f: Json) => void): string => {
    const f = JSON.parse(serializeSim(base)) as Json;
    mutate(f);
    return JSON.stringify(f);
  };
  const raiderIndex = () => base.state.agents.findIndex((a) => raidLeg(a) === 'out');

  it('a save holds raid treks and rivalries exactly', () => {
    expect(raiderIndex()).toBeGreaterThanOrEqual(0);
    const warnings: string[] = [];
    const st = deserializeState(serializeSim(base), { warnings });
    expect(warnings).toEqual([]);
    expect(st.agents.map((a) => a.trek)).toEqual(base.state.agents.map((a) => a.trek));
    expect(st.diplomacy?.rivals).toEqual(base.state.diplomacy?.rivals);
    expect(st.diplomacy?.rivals?.length).toBe(1);
  });

  it('an old migration trek (no kind) loads as a migration; damaged raid treks and rivalries are repaired', () => {
    const i = raiderIndex();
    const trek = base.state.agents[i].trek!;
    const old = tamper((f) => {
      f.state.agents[i].trek = { x: trek.x, y: trek.y, until: trek.until - RAID_TREK_TICKS + 600 };
    });
    const w1: string[] = [];
    expect(deserializeState(old, { warnings: w1 }).agents[i].trek).toEqual({ x: trek.x, y: trek.y, until: trek.until - RAID_TREK_TICKS + 600, kind: 'migrate', tribe: NONE });
    expect(w1).toEqual([]);

    const bad = (mutate: (t: Json) => void): Agent['trek'] => {
      const warnings: string[] = [];
      const st = deserializeState(tamper((f) => mutate(f.state.agents[i].trek)), { warnings });
      expect(warnings.some((w) => w.startsWith('agent.trek'))).toBe(true);
      return st.agents[i].trek;
    };
    expect(bad((t) => (t.tribe = 9999))).toBeUndefined(); // a tribe that was never allocated
    expect(bad((t) => (t.tribe = -1))).toBeUndefined(); // a raid without a camp to head for
    expect(bad((t) => (t.kind = 'pilgrimage'))).toBeUndefined();
    expect(bad((t) => (t.until = base.tick + RAID_TREK_TICKS + 1))).toBeUndefined();
    expect(bad((t) => (t.extra = 1))).toBeUndefined();

    const w2: string[] = [];
    const st = deserializeState(
      tamper((f) => {
        const k = f.state.diplomacy.rivals[0] as number;
        f.state.diplomacy.rivals = [k, k, 'x', 3 * 1048576 + 3, 2 * 1048576 + 1, 1 * 1048576 + 999];
      }),
      { warnings: w2 },
    );
    expect(st.diplomacy?.rivals).toEqual(base.state.diplomacy?.rivals);
    expect(w2.some((w) => w.startsWith('diplomacy.rivals'))).toBe(true);
  });

  it('hash() covers raid treks and rivalries', () => {
    const h0 = base.hash();
    const i = raiderIndex();
    const mutations: [string, (s: Simulation) => void][] = [
      ['trek kind', (s) => (s.state.agents[i].trek!.kind = 'migrate')],
      ['trek tribe', (s) => (s.state.agents[i].trek!.tribe = s.state.agents[i].tribeId)],
      ['rivals', (s) => (s.state.diplomacy!.rivals = [])],
    ];
    for (const [what, mutate] of mutations) {
      const s = loadSim(serializeSim(base));
      expect(s.hash(), `${what} (before)`).toBe(h0);
      mutate(s);
      expect(s.hash(), what).not.toBe(h0);
    }
  });
});
