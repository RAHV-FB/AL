/**
 * Simulation-core audit regressions (orchestration, interventions, persistence). Every test here
 * reproduces a defect that was found and fixed in the audit; see the comment above each block.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { applyIntervention, normalizeIntervention } from '../src/sim/interventions';
import { findPassableNear } from '../src/sim/world';
import { deserializeState, loadSim, serializeSim } from '../src/sim/persistence';
import { isAdult } from '../src/sim/lifecycle';
import { DEFAULT_CONFIG } from '../src/sim/config';
import { LIMITS, TERRAIN_INFO } from '../src/sim/constants';
import { SCENARIOS, getScenario } from '../src/sim/presets';
import { checkInvariants } from '../scripts/qa-helpers';
import { TERRAIN, type Intervention, type InterventionRecord, type ScenarioDef, type TerrainType } from '../src/sim/types';

const EMPTY: ScenarioDef = {
  id: 'core-audit', name: 'Core audit', tagline: '', description: '', lookFor: [],
  config: { disasterRate: 0 }, world: {}, populations: [], scheduled: [],
};
const makeSim = (seed = 3, sc: ScenarioDef = EMPTY): Simulation => Simulation.create({ scenario: sc, seed });

function land(sim: Simulation, fx = 0.5, fy = 0.5): { x: number; y: number } {
  const p = findPassableNear(sim, sim.worldW * fx, sim.worldH * fy, 4000, true);
  if (!p) throw new Error('no land');
  return p;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

describe('population accounting (deadThisTick was never reset by flush)', () => {
  it('killing outside step() keeps population exact, so spawns cannot exceed maxAgents', () => {
    const sim = makeSim();
    applyIntervention(sim, { kind: 'setConfig', patch: { maxAgents: 50 } });
    const p = land(sim);
    applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 50, radius: 50 });
    expect(sim.state.agents.length).toBe(50);
    applyIntervention(sim, { kind: 'killAgent', id: sim.state.agents[0].id });
    expect(sim.state.agents.length).toBe(49);
    expect(sim.population).toBe(49); // was 48
    applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 10, radius: 50 });
    expect(sim.state.agents.length).toBe(50); // was 51
    expect(sim.population).toBe(50);
    expect(sim.canSpawn()).toBe(false);
  });

  it('between ticks population equals the number of living agents after deaths', () => {
    const sim = makeSim();
    const p = land(sim);
    applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 30, radius: 50 });
    sim.enqueue({ kind: 'remove', x: p.x, y: p.y, radius: 60 });
    sim.step();
    expect(sim.state.stats.totals.deaths).toBeGreaterThan(0);
    expect(sim.population).toBe(sim.state.agents.length);
  });
});

describe('intervention spawns join the world at once (they used to wait for the end-of-tick flush)', () => {
  it('a tribe founded by a scheduled spawn on a tribe-recount tick reports its members', () => {
    const sc = getScenario('predators');
    sc.scheduled[0].tick = 30; // tribe recount ticks are multiples of 30 (social.tribePeriod)
    const sim = makeSim(3, sc);
    sim.run(31);
    const t = sim.state.tribes.find((x) => x.name === 'The Second Pack')!;
    expect(t).toBeDefined();
    const actual = sim.state.agents.filter((a) => a.tribeId === t.id).length;
    expect(actual).toBeGreaterThan(0);
    expect(t.members).toBe(actual); // was 0 until the next recount, 30 ticks later
    expect(t.extinctTick).toBe(-1);
  });

  it('a later intervention of the same tick sees them (paint, remove)', () => {
    const sim = makeSim(3);
    const p = land(sim);
    sim.enqueue({ kind: 'spawn', x: p.x, y: p.y, count: 10, radius: 20, tribe: 'none' });
    sim.enqueue({ kind: 'paintTerrain', x: p.x, y: p.y, radius: 400, terrain: TERRAIN.DeepWater });
    sim.step();
    expect(sim.state.agents.length).toBeGreaterThan(0);
    for (const a of sim.state.agents) expect(sim.passableAt(a.x, a.y)).toBe(true); // were left stranded in deep water

    const s2 = makeSim(4);
    const q = land(s2);
    s2.enqueue({ kind: 'spawn', x: q.x, y: q.y, count: 8, radius: 20 });
    s2.enqueue({ kind: 'remove', x: q.x, y: q.y, radius: 200 });
    s2.step();
    expect(s2.state.stats.totals.deaths).toBe(8); // they used to survive a same-tick removal
    expect(s2.state.agents).toHaveLength(0);
    expect(s2.population).toBe(0);
  });
});

describe('replay & recorded interventions', () => {
  it('replays a spawn whose template spread was not finite exactly (NaN used to differ from its JSON copy)', () => {
    const run = (replay?: InterventionRecord[]) => {
      const sim = Simulation.create({ scenario: EMPTY, seed: 5, replay });
      if (!replay) {
        const p = land(sim);
        sim.enqueue({ kind: 'spawn', x: p.x, y: p.y, count: 10, radius: 40, template: { speed: 0.9, size: 0.2, spread: NaN } });
      }
      sim.run(20);
      return sim;
    };
    const a = run();
    const b = run(a.state.interventionLog);
    expect(b.hash()).toBe(a.hash());
    expect(a.state.agents[0].genes[0]).not.toBe(0.5); // NaN spread used to collapse every template gene to 0.5
  });

  it('a log that went through a save file replays exactly, even for inputs with invalid numbers', () => {
    const sim = makeSim(6);
    const p = land(sim);
    sim.enqueue({ kind: 'spawn', x: p.x, y: p.y, count: 10, radius: NaN });
    sim.enqueue({ kind: 'addFood', x: p.x, y: p.y, radius: Infinity, amount: 3 });
    sim.enqueue({ kind: 'disaster', disaster: 'bloom', x: p.x, y: p.y, radius: 60, intensity: NaN, duration: Infinity });
    sim.run(10);
    expect(sim.state.interventionLog).toHaveLength(3);
    const warnings: string[] = [];
    const st = deserializeState(serializeSim(sim), { warnings });
    expect(warnings).toEqual([]); // the recorded (canonical) entries need no repair
    expect(st.interventionLog).toEqual(sim.state.interventionLog); // used to drop all of them
    const replay = Simulation.create({ scenario: EMPTY, seed: 6, replay: st.interventionLog });
    replay.run(10);
    expect(replay.hash()).toBe(sim.hash());
    expect(sim.state.agents.length).toBeGreaterThanOrEqual(10); // the NaN-radius spawn was applied
    expect(replay.state.agents.length).toBe(sim.state.agents.length);
  });

  it('applies an out-of-order replay log at the recorded ticks', () => {
    const sim = makeSim(8);
    const p = land(sim);
    const log: InterventionRecord[] = [
      { tick: 5, intervention: { kind: 'addFood', x: p.x, y: p.y, radius: 20, amount: 3 } },
      { tick: 2, intervention: { kind: 'spawn', x: p.x, y: p.y, count: 5, radius: 20 } },
      { tick: NaN, intervention: { kind: 'removeFood', x: p.x, y: p.y, radius: 20 } }, // unusable tick: skipped
    ];
    const r = Simulation.create({ scenario: EMPTY, seed: 8, replay: log });
    r.run(10);
    expect(r.state.interventionLog.map((e) => e.tick)).toEqual([2, 5]); // was [5, 5]
  });

  it('says so (once, in the event log) and counts it when the capped intervention log starts dropping entries', () => {
    // dropping used to be silent, so "Replay my interventions" quietly stopped reproducing the run
    const sim = makeSim();
    for (let i = 0; i < LIMITS.interventionLog + 2; i++) sim.enqueue({ kind: 'setConfig', patch: { foodRegen: 1 + (i % 2) * 0.5 } });
    sim.step();
    sim.enqueue({ kind: 'setConfig', patch: { foodRegen: 1.25 } });
    sim.step();
    expect(sim.state.interventionLog).toHaveLength(LIMITS.interventionLog);
    expect(sim.state.interventionLogDropped).toBe(3);
    expect(sim.state.events.filter((e) => e.message.includes('intervention log is full'))).toHaveLength(1);
    const st = deserializeState(serializeSim(sim));
    expect(st.interventionLogDropped).toBe(3);
    expect(st.interventionLog).toEqual(sim.state.interventionLog);
    const fresh = deserializeState(serializeSim(makeSim()));
    expect('interventionLogDropped' in fresh).toBe(false);
  });

  it('does not record interventions that cannot do anything', () => {
    const sim = makeSim();
    const junk = [
      { kind: 'spawn', x: NaN, y: 1, count: 3, radius: 1 },
      { kind: 'spawn', x: 10, y: 10, count: 0, radius: 1 },
      { kind: 'killAgent', id: 'x' },
      { kind: 'boostAgent', id: -1 },
      { kind: 'addFood', x: 10, y: 10, radius: 5, amount: -2 },
      { kind: 'fertilize', x: 10, y: 10, radius: 5, amount: 0 },
      { kind: 'paintTerrain', x: 10, y: 10, radius: 5, terrain: 99 },
      { kind: 'disaster', disaster: 'volcano', x: 1, y: 1, radius: 5, intensity: 1, duration: 5 },
      { kind: 'setConfig', patch: { seed: 7, bogus: 1, foodRegen: 'lots' } },
      { kind: 'nonsense' },
      null,
    ] as unknown as Intervention[];
    for (const iv of junk) sim.enqueue(iv);
    expect(() => sim.step()).not.toThrow();
    expect(sim.state.interventionLog).toEqual([]);
  });
});

describe('normalizeIntervention (canonical form shared by recording, applying and loading)', () => {
  const bounds = { worldW: 1600, worldH: 1000 };
  it('is the identity on valid inputs, including every preset population and scheduled event', () => {
    const valid: Intervention[] = [
      { kind: 'spawn', x: 400, y: 300, count: 20, radius: 40, template: { speed: 0.7, spread: 0.06 }, tribe: 'new', tribeName: 'Testers' },
      { kind: 'spawn', x: 400, y: 300, count: 3, radius: 4, tribe: 7 },
      { kind: 'remove', x: 1, y: 2, radius: 3 },
      { kind: 'killAgent', id: 4 },
      { kind: 'boostAgent', id: 9 },
      { kind: 'addFood', x: 1, y: 2, radius: 3, amount: 4 },
      { kind: 'removeFood', x: 1, y: 2, radius: 0 },
      { kind: 'paintTerrain', x: 1, y: 2, radius: 3, terrain: TERRAIN.Wall },
      { kind: 'fertilize', x: 1, y: 2, radius: 3, amount: -0.5 },
      { kind: 'disaster', disaster: 'coldsnap', x: 800, y: 500, radius: 0, intensity: 0.6, duration: 900 },
      { kind: 'setConfig', patch: { mutationRate: 0.2, overgrazing: false, maxAgents: 600 } },
    ];
    for (const sc of SCENARIOS) {
      for (const pop of sc.populations) valid.push({ kind: 'spawn', ...pop });
      for (const ev of sc.scheduled) valid.push(ev.intervention);
    }
    for (const iv of valid) expect(normalizeIntervention(iv, bounds), JSON.stringify(iv)).toEqual(iv);
  });

  it('returns finite, JSON-safe, idempotent values for hostile inputs', () => {
    const hostile = [
      { kind: 'spawn', x: 5, y: 5, count: 1e12, radius: -4, template: { speed: Infinity, size: 0.3, spread: NaN, bogus: 1 }, tribe: 2.5, tribeName: `  ${'n'.repeat(39)} x ` },
      { kind: 'remove', x: 5, y: 5, radius: Infinity },
      { kind: 'addFood', x: 5, y: 5, radius: NaN, amount: 1e30 },
      { kind: 'fertilize', x: 5, y: 5, radius: 1e30, amount: -9 },
      { kind: 'disaster', disaster: 'drought', x: NaN, y: Infinity, radius: -5, intensity: 99, duration: -1 },
      { kind: 'setConfig', patch: { mutationRate: 9, dayLength: 5, maxAgents: 77.7, seed: 1, worldWidth: 3, dayNight: 1 } },
    ];
    for (const iv of hostile) {
      const n = normalizeIntervention(iv, bounds)!;
      expect(n, JSON.stringify(iv)).not.toBeNull();
      expect(JSON.parse(JSON.stringify(n))).toEqual(n); // JSON-safe: no NaN / Infinity / undefined
      expect(normalizeIntervention(n, bounds)).toEqual(n); // idempotent
    }
    const d = normalizeIntervention(hostile[4], bounds) as Extract<Intervention, { kind: 'disaster' }>;
    expect(d.radius).toBe(80); // a negative radius used to become 0 = a WORLDWIDE disaster
    expect([d.x, d.y, d.intensity, d.duration]).toEqual([800, 500, 1, 1]);
    const s = normalizeIntervention(hostile[0], bounds) as Extract<Intervention, { kind: 'spawn' }>;
    expect(s.count).toBe(5000);
    expect(s.radius).toBe(0);
    expect(s.template).toEqual({ size: 0.3 });
    expect(s.tribe).toBeUndefined();
    expect(s.tribeName).toBe('n'.repeat(39));
    const c = normalizeIntervention(hostile[5], bounds) as Extract<Intervention, { kind: 'setConfig' }>;
    expect(c.patch).toEqual({ mutationRate: 0.5, dayLength: 60, maxAgents: 78 });
  });

  it('a disaster with a negative radius stays local', () => {
    const sim = makeSim();
    const p = land(sim);
    applyIntervention(sim, { kind: 'disaster', disaster: 'drought', x: p.x, y: p.y, radius: -5, intensity: 0.5, duration: 100 });
    expect(sim.state.disasters).toHaveLength(1);
    expect(sim.state.disasters[0].radius).toBeGreaterThan(0);
  });
});

describe('spawn', () => {
  it('founders are young adults (age >= their own maturityAge) with 85% of a full stomach, for any body size', () => {
    const sim = makeSim();
    const p = land(sim);
    for (const size of [0, 0.5, 1]) applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 40, radius: 60, template: { size, spread: 0.02 } });
    expect(sim.state.agents.length).toBe(120);
    for (const a of sim.state.agents) {
      expect(isAdult(a)).toBe(true);
      expect(a.age).toBeGreaterThanOrEqual(a.traits.maturityAge);
      expect(a.age).toBeLessThanOrEqual(Math.ceil(a.traits.maturityAge * 1.2));
      expect(a.food).toBeCloseTo(a.traits.maxFood * 0.85, 6);
      expect(a.health).toBe(a.traits.maxHealth);
    }
  });

  it('reinforcing an extinct tribe revives it and moves its abandoned camp to the newcomers', () => {
    const sim = makeSim(4);
    const p1 = land(sim, 0.3, 0.5);
    const p2 = land(sim, 0.75, 0.5);
    sim.enqueue({ kind: 'spawn', x: p1.x, y: p1.y, count: 10, radius: 30, tribe: 'new', tribeName: 'Old Ones' });
    sim.run(5);
    const t = sim.state.tribes[0];
    sim.enqueue({ kind: 'remove', x: p1.x, y: p1.y, radius: 300 });
    sim.run(70);
    expect(t.extinctTick).toBeGreaterThan(0);
    sim.enqueue({ kind: 'paintTerrain', x: t.homeX, y: t.homeY, radius: 60, terrain: TERRAIN.DeepWater });
    sim.run(2);
    expect(sim.passableAt(t.homeX, t.homeY)).toBe(false);
    sim.enqueue({ kind: 'spawn', x: p2.x, y: p2.y, count: 12, radius: 30, tribe: t.id });
    sim.step();
    expect(t.extinctTick).toBe(-1);
    expect(t.members).toBe(12);
    expect(sim.passableAt(t.homeX, t.homeY)).toBe(true);
    expect(Math.hypot(t.homeX - p2.x, t.homeY - p2.y)).toBeLessThan(60);
    expect(sim.state.events.some((e) => e.message.includes('reviving the extinct Old Ones'))).toBe(true);
  });
});

describe('hash() covers the whole state', () => {
  it('changes when config, disasters, events, tribe relations, schedules or relationships change', () => {
    const base = Simulation.create({ scenario: getScenario('two-civs'), seed: 2 });
    base.run(3);
    const h0 = base.hash();
    const mutations: [string, (s: Simulation) => void][] = [
      ['config', (s) => (s.state.config.mutationRate += 0.01)],
      ['env', (s) => (s.state.env.tempOffset -= 1)],
      ['event', (s) => s.log('environment', 'info', 'x')],
      ['tribe relation', (s) => (s.state.tribes[0].relations[s.state.tribes[1].id] = -0.4)],
      ['scheduled', (s) => (s.state.scheduled[0].tick += 1)],
      ['disaster', (s) => applyIntervention(s, { kind: 'disaster', disaster: 'drought', x: 50, y: 50, radius: 20, intensity: 0.3, duration: 20 })],
      ['relationship', (s) => s.state.agents[0].relationships.push({ id: s.state.agents[1].id, affinity: 0.1, kin: 0, lastTick: 0, interactions: 1 })],
      ['infection', (s) => (s.state.agents[0].infection = 5)],
      ['action', (s) => (s.state.agents[0].action = s.state.agents[0].action === 'rest' ? 'idle' : 'rest')],
      ['territory', (s) => (s.state.world.territory[100] = 1)],
      ['lineage', (s) => (s.state.lineage[0].offspring += 1)],
    ];
    for (const [what, mutate] of mutations) {
      const s = loadSim(serializeSim(base));
      expect(s.hash(), `${what} (before)`).toBe(h0);
      mutate(s);
      expect(s.hash(), what).not.toBe(h0);
    }
  });
});

describe('hash() fingerprints the live generator', () => {
  it('a save taken before the first tick (founders spawned, RNG advanced) loads with the same hash', () => {
    for (const sc of SCENARIOS.slice(0, 3)) {
      const a = Simulation.create({ scenario: sc, seed: 15 });
      expect(loadSim(serializeSim(a)).hash(), sc.id).toBe(a.hash()); // state.rngState used to be stale here
      applyIntervention(a, { kind: 'spawn', x: 800, y: 500, count: 3, radius: 30 }); // RNG use outside a tick
      expect(loadSim(serializeSim(a)).hash(), sc.id).toBe(a.hash());
    }
  });
});

describe('save → load → continue is identical to an uninterrupted run', () => {
  /** Run `make()` to `saveAt`, save, then continue both copies to `end` and compare. */
  function roundTrip(
    make: () => Simulation,
    saveAt: number,
    end: number,
    drive?: (s: Simulation) => void,
    events = true,
    atSave?: (s: Simulation) => void,
  ): { a: Simulation; b: Simulation } {
    const a = make();
    while (a.tick < saveAt) {
      drive?.(a);
      a.step();
    }
    atSave?.(a);
    const b = loadSim(serializeSim(a));
    expect(b.hash()).toBe(a.hash());
    while (a.tick < end) {
      drive?.(a);
      a.step();
    }
    while (b.tick < end) {
      drive?.(b);
      b.step();
    }
    expect(b.hash({ events }), `diverged after loading at tick ${saveAt}`).toBe(a.hash({ events }));
    return { a, b };
  }

  it('mid-disaster (several overlapping disasters active and fading)', () => {
    const make = () => {
      const s = Simulation.create({ scenario: getScenario('evolab'), seed: 21 });
      return s;
    };
    const drive = (s: Simulation) => {
      if (s.tick === 20) {
        s.enqueue({ kind: 'disaster', disaster: 'drought', x: 500, y: 400, radius: 300, intensity: 0.8, duration: 200 });
        s.enqueue({ kind: 'disaster', disaster: 'coldsnap', x: 1100, y: 600, radius: 250, intensity: 0.9, duration: 160 });
        s.enqueue({ kind: 'disaster', disaster: 'meteor', x: 800, y: 500, radius: 60, intensity: 1, duration: 1 });
        s.enqueue({ kind: 'disaster', disaster: 'bloom', x: 0, y: 0, radius: 0, intensity: 0.5, duration: 120 });
      }
    };
    roundTrip(make, 140, 400, drive, true, (s) => {
      expect(s.state.disasters.filter((d) => d.active).length).toBeGreaterThanOrEqual(3);
      expect(s.state.disasters.some((d) => !d.active)).toBe(true); // the meteor is fading out
    });
  });

  it('with pending scheduled repeats (evolab climate cycle, schedule compressed)', () => {
    const make = () => {
      const sc = getScenario('evolab');
      sc.scheduled.forEach((e, i) => {
        e.tick = 10 + 15 * i;
        e.repeat = 70;
      });
      return Simulation.create({ scenario: sc, seed: 22 });
    };
    const end = 260;
    const { a, b } = roundTrip(make, 60, end);
    // every climate shift fired at its first tick and then again every 70 ticks, also in the loaded copy
    for (const [i, ev] of getScenario('evolab').scheduled.entries()) {
      const want = [0, 1, 2, 3].map((k) => 10 + 15 * i + 70 * k).filter((t) => t < end);
      for (const s of [a, b]) expect(s.state.events.filter((e) => e.message === ev.note).map((e) => e.tick), ev.note).toEqual(want);
    }
  });

  it('after every kind of intervention (and with more queued after the load)', () => {
    const plan = (s: Simulation) => {
      const W = s.worldW;
      const H = s.worldH;
      const at: Record<number, Intervention> = {
        3: { kind: 'spawn', x: W * 0.5, y: H * 0.5, count: 25, radius: 60, tribe: 'new', tribeName: 'Planners', template: { aggression: 0.7, spread: 0.05 } },
        6: { kind: 'paintTerrain', x: W * 0.45, y: H * 0.5, radius: 30, terrain: TERRAIN.Wall },
        9: { kind: 'setConfig', patch: { foodRegen: 1.4, aggressionBias: 2 } },
        12: { kind: 'fertilize', x: W * 0.4, y: H * 0.4, radius: 60, amount: 0.4 },
        15: { kind: 'addFood', x: W * 0.5, y: H * 0.5, radius: 80, amount: 6 },
        18: { kind: 'removeFood', x: W * 0.6, y: H * 0.6, radius: 40 },
        21: { kind: 'disaster', disaster: 'plague', x: W * 0.5, y: H * 0.5, radius: 120, intensity: 0.8, duration: 200 },
        80: { kind: 'remove', x: W * 0.52, y: H * 0.52, radius: 20 },
        90: { kind: 'spawn', x: W * 0.3, y: H * 0.6, count: 10, radius: 40, tribe: 'none' },
      };
      const iv = at[s.tick];
      if (iv) s.enqueue(iv);
      if (s.tick === 100 && s.state.agents.length > 2) {
        s.enqueue({ kind: 'killAgent', id: s.state.agents[1].id });
        s.enqueue({ kind: 'boostAgent', id: s.state.agents[2].id });
      }
    };
    roundTrip(() => Simulation.create({ scenario: getScenario('eden'), seed: 23 }), 50, 300, plan);
  });

  it('mid-epidemic (trajectory; the disease event log is checked separately, see cross-area note)', () => {
    const make = () => {
      const sc = getScenario('plague-island');
      sc.scheduled[0].tick = 40;
      sc.scheduled[1].tick = 400;
      return Simulation.create({ scenario: sc, seed: 31 });
    };
    const { a } = roundTrip(make, 260, 700, undefined, false);
    expect(a.state.stats.totals.deaths).toBeGreaterThan(0);
  });
});

describe('loading damaged / hostile files', () => {
  const base = (() => {
    const sim = Simulation.create({ scenario: getScenario('two-civs'), seed: 9 });
    sim.enqueue({ kind: 'disaster', disaster: 'plague', x: 400, y: 500, radius: 200, intensity: 1, duration: 300 });
    sim.run(120);
    return sim;
  })();
  const tamper = (mutate: (f: Json) => void): string => {
    const f = JSON.parse(serializeSim(base)) as Json;
    mutate(f);
    return JSON.stringify(f);
  };

  it('validates the optional disease extension field (diseaseHp)', () => {
    const sick = base.state.agents.find((a) => a.infection > 0 && a.diseaseHp !== undefined);
    expect(sick, 'scenario should have an infected agent').toBeDefined();
    const ok = deserializeState(serializeSim(base));
    expect(ok.agents.find((a) => a.id === sick!.id)!.diseaseHp).toBe(sick!.diseaseHp); // valid values untouched
    const others = base.state.agents.filter((a) => a !== sick).slice(0, 3).map((a) => a.id);
    const warnings: string[] = [];
    const st = deserializeState(
      tamper((f) => {
        const byId = (id: number) => f.state.agents.find((a: Json) => a.id === id);
        byId(others[0]).diseaseHp = 'evil';
        byId(others[1]).diseaseHp = { $num: 'NaN' };
        byId(others[2]).infection = 0;
        byId(others[2]).diseaseHp = 12;
        byId(sick!.id).diseaseHp = 1e9;
      }),
      { warnings },
    );
    for (const id of others) expect(st.agents.find((a) => a.id === id)!.diseaseHp).toBeUndefined();
    const s = st.agents.find((a) => a.id === sick!.id)!;
    expect(s.diseaseHp).toBe(s.traits.maxHealth);
    expect(warnings.join('\n')).toMatch(/diseaseHp/);
  });

  it('puts agents stranded on impassable terrain back on open ground', () => {
    const w = base.state.world;
    let deep = -1;
    for (let i = 0; i < w.terrain.length && deep < 0; i++) if (w.terrain[i] === TERRAIN.DeepWater) deep = i;
    const x = ((deep % w.width) + 0.5) * w.tileSize;
    const y = (Math.floor(deep / w.width) + 0.5) * w.tileSize;
    const st = deserializeState(tamper((f) => ((f.state.agents[0].x = x), (f.state.agents[0].y = y))));
    const sim = Simulation.fromState(st);
    expect(sim.passableAt(st.agents[0].x, st.agents[0].y)).toBe(true);
  });

  it('drops out-of-order / duplicate event ids, NaN utilities and future disaster starts', () => {
    const st = deserializeState(
      tamper((f) => {
        const ev = f.state.events;
        ev.push({ ...ev[ev.length - 1] }); // duplicate id
        ev.push({ ...ev[0], id: 1 }); // older id at the end
        f.state.agents[0].utilities = { eat: { $num: 'NaN' }, rest: 0.4 };
        f.state.disasters[0].startTick = 1e9;
      }),
    );
    for (let i = 1; i < st.events.length; i++) expect(st.events[i].id).toBeGreaterThan(st.events[i - 1].id);
    expect(st.agents[0].utilities).toEqual({ rest: 0.4 });
    expect(st.disasters[0].startTick).toBeLessThanOrEqual(st.tick);
  });

  it('every mutation in a battery of hostile edits loads cleanly (or is rejected) and then runs with all invariants', () => {
    const a0 = (f: Json) => f.state.agents[0];
    const t0 = (f: Json) => f.state.tribes[0];
    const battery: [string, (f: Json) => void][] = [
      ['prototype keys', (f) => (f.state.agents[0].__proto__ = { alive: false })],
      ['huge relationship list', (f) => (a0(f).relationships = Array.from({ length: 50_000 }, (_, i) => ({ id: (i % 300) + 1, affinity: 2, kin: 9, lastTick: 'x', interactions: -1 })))],
      ['wrong types everywhere', (f) => Object.assign(a0(f), { name: 5, generation: 'old', parents: 'none', skills: [1, 2], memory: 7, stats: null, children: { a: 1 }, history: 'long ago', role: 42, action: null })],
      ['memory spots far outside the world', (f) => (a0(f).memory = { food: [{ x: 1e300, y: -1e300, value: 3, tick: 1 }], danger: [{ x: NaN, y: 1 }] })],
      ['duplicate tribe ids', (f) => f.state.tribes.push({ ...t0(f) })],
      ['tribe referencing missing tribes', (f) => Object.assign(t0(f), { relations: { 999: -1, 1: 'war' }, parentTribeId: 777, meanGenes: [1, 2, 3], roles: 'all' })],
      ['agents in unknown and extinct tribes', (f) => {
        f.state.agents[1].tribeId = 999;
        if (f.state.tribes[1]) {
          f.state.tribes[1].extinctTick = 5;
          f.state.agents[2].tribeId = f.state.tribes[1].id;
        }
      }],
      ['references to missing agents', (f) => Object.assign(a0(f), { targetId: 999_999, lastAttackerId: -7, parents: [999_999, 0.5] })],
      ['NaN / Infinity vitals', (f) => Object.assign(a0(f), { health: { $num: 'NaN' }, food: { $num: 'Infinity' }, energy: -5, carried: { $num: '-Infinity' }, age: -1, infection: { $num: 'NaN' } })],
      ['bad lineage', (f) => f.state.lineage.push({ id: 5, name: null }, { id: -1 }, 'x')],
      ['bad disasters', (f) => f.state.disasters.push({ id: 1, kind: 'plague', x: 1, y: 1, radius: -1, startTick: 'now', duration: 1e30, intensity: 7, active: 'yes' }, { id: 2, kind: 'zombies', x: 0, y: 0 })],
      ['scheduled junk', (f) => f.state.scheduled.push({ tick: 200, repeat: 0.5, intervention: { kind: 'spawn', x: 800, y: 500, count: 1e9, radius: -1, template: 'gentle' } }, { tick: -1, intervention: { kind: 'remove' } })],
      ['intervention log junk', (f) => (f.state.interventionLog = [{ tick: 3, intervention: { kind: 'disaster', disaster: 'meteor', x: 'a', y: 1 } }, { tick: 'x' }, null])],
      ['config junk', (f) => Object.assign(f.state.config, { maxAgents: 1e9, dayLength: 0, seasons: 'no', worldWidth: 5, mutationRate: { $num: 'NaN' } })],
      ['env junk', (f) => Object.assign(f.state.env, { season: 7, timeOfDay: { $num: 'Infinity' }, temperature: 'hot' })],
      ['stats junk', (f) => Object.assign(f.state.stats, { sampleInterval: 0, samples: [{ tick: 'x', geneMeans: [1] }, 5], counters: null, totals: [] })],
      ['agent list not an array', (f) => (f.state.agents = { 0: 1 })],
      ['missing rng state', (f) => delete f.state.rngState],
    ];
    for (const [what, mutate] of battery) {
      let sim: Simulation;
      try {
        sim = loadSim(tamper(mutate));
      } catch (e) {
        expect(String(e), what).toMatch(/^Error: Cannot load: /);
        continue;
      }
      expect(() => sim.run(60), what).not.toThrow();
      // relationGrace: social prunes ties to the dead every 60 ticks, whatever (repaired) dayLength the file has
      const v = checkInvariants(sim, { checkInterval: 60, relationGrace: 600 });
      expect(v, `${what}:\n${v.join('\n')}`).toEqual([]);
      expect(() => loadSim(serializeSim(sim)).run(5), `${what} (re-save)`).not.toThrow();
    }
  });
});

describe('tribe and lineage registries stay consistent when capped', () => {
  it('dropping the oldest extinct tribes leaves no dangling references', () => {
    const sim = makeSim(12);
    const p = land(sim, 0.4, 0.5);
    let made = 0;
    while (made < LIMITS.tribesKept + 10) {
      sim.enqueue({ kind: 'spawn', x: p.x, y: p.y, count: 2, radius: 10, tribe: 'new' });
      sim.step();
      made++;
      sim.enqueue({ kind: 'remove', x: p.x, y: p.y, radius: 4000 }); // everyone dies → every tribe goes extinct
      sim.run(30);
    }
    const s = sim.state;
    expect(s.nextTribeId - 1).toBeGreaterThan(LIMITS.tribesKept);
    expect(s.tribes.length).toBeLessThanOrEqual(LIMITS.tribesKept + 1);
    const ids = new Set(s.tribes.map((t) => t.id));
    for (const t of s.tribes) for (const k of Object.keys(t.relations)) expect(ids.has(Number(k))).toBe(true);
    for (const a of s.agents) if (a.tribeId !== -1) expect(ids.has(a.tribeId)).toBe(true);
    for (let i = 0; i < s.world.territory.length; i++) if (s.world.territory[i] !== -1) expect(ids.has(s.world.territory[i])).toBe(true);
    // keeps running, and a save of it loads without repairs
    sim.enqueue({ kind: 'spawn', x: p.x, y: p.y, count: 30, radius: 60, tribe: 'new' });
    sim.run(100);
    const warnings: string[] = [];
    loadSim(serializeSim(sim), { warnings });
    expect(warnings).toEqual([]);
  });

  it('lineage pruning keeps every living agent on record and the index in sync', () => {
    const sim = makeSim(13);
    applyIntervention(sim, { kind: 'setConfig', patch: { maxAgents: 2000 } });
    const p = land(sim);
    for (let round = 0; round < 4; round++) {
      applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 2000, radius: 300 });
      applyIntervention(sim, { kind: 'remove', x: p.x, y: p.y, radius: 1e9 });
    }
    applyIntervention(sim, { kind: 'spawn', x: p.x, y: p.y, count: 500, radius: 300 });
    const s = sim.state;
    expect(s.nextAgentId - 1).toBeGreaterThan(LIMITS.lineage);
    expect(s.lineage.length).toBeLessThanOrEqual(LIMITS.lineage);
    expect(sim.lineageById.size).toBe(s.lineage.length);
    for (const a of s.agents) expect(sim.lineageById.get(a.id)?.deathTick).toBe(-1);
    sim.run(5);
    expect(checkInvariants(sim)).toEqual([]);
  });
});

describe('config defaults', () => {
  it('every intervention kind keeps the world finite under DEFAULT_CONFIG extremes', () => {
    const sim = makeSim(14);
    applyIntervention(sim, { kind: 'setConfig', patch: { ...DEFAULT_CONFIG, maxAgents: 2000, foodCapacity: 3, foodRegen: 3 } });
    const p = land(sim);
    sim.enqueue({ kind: 'spawn', x: p.x, y: p.y, count: 100, radius: 100 });
    sim.enqueue({ kind: 'fertilize', x: p.x, y: p.y, radius: 1e9, amount: 1e9 });
    sim.enqueue({ kind: 'addFood', x: p.x, y: p.y, radius: 1e9, amount: 1e9 });
    sim.run(50);
    const w = sim.state.world;
    for (let i = 0; i < w.food.length; i++) {
      const cap = TERRAIN_INFO[w.terrain[i] as TerrainType].maxFood * w.fertility[i] * sim.config.foodCapacity;
      if (!(w.food[i] >= 0) || w.food[i] > cap * 1.5 + 1e-3) throw new Error(`tile ${i}: food ${w.food[i]} cap ${cap}`);
    }
    expect(checkInvariants(sim)).toEqual([]);
  });
});
