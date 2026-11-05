/**
 * Persistence (owned by the Persistence & Experiments engineer): exact save/load round trips,
 * rejection of unusable files, and sanitisation of damaged/hostile ones.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS, getScenario } from '../src/sim/presets';
import {
  MAX_SAVE_CHARS,
  SAVE_FORMAT,
  base64ToBytes,
  bytesToBase64,
  deserializeState,
  loadSim,
  saveFileName,
  serializeSim,
  validateSave,
} from '../src/sim/persistence';
import { LIMITS, SAVE_VERSION } from '../src/sim/constants';
import { DEFAULT_CONFIG, PARAM_SPECS } from '../src/sim/config';
import { expressTraits } from '../src/sim/genetics';
import { GENE_COUNT, NONE, TERRAIN_COUNT, type SimState } from '../src/sim/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** Serialise `sim`, let `mutate` edit the parsed file (tagged values stay as {$typed}/{$num} objects), re-stringify. */
function tamper(sim: Simulation, mutate: (file: Json) => void): string {
  const file = JSON.parse(serializeSim(sim)) as Json;
  mutate(file);
  return JSON.stringify(file);
}

const bytesOf = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const LAYERS = ['terrain', 'food', 'fertility', 'baseFertility', 'elevation', 'climateMod', 'territory'] as const;

function fresh(id: string, seed: number, ticks: number): Simulation {
  const sim = Simulation.create({ scenario: getScenario(id), seed });
  sim.run(ticks);
  return sim;
}

function expectFiniteAgents(st: SimState): void {
  for (const a of st.agents) {
    for (const v of [a.x, a.y, a.health, a.food, a.energy, a.carried]) expect(Number.isFinite(v)).toBe(true);
  }
}

describe('base64 codec', () => {
  it('matches btoa/atob for every length and byte value', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 73 + n * 31) & 255;
      const ref = btoa(String.fromCharCode(...bytes));
      expect(bytesToBase64(bytes)).toBe(ref);
      expect(Array.from(base64ToBytes(ref))).toEqual(Array.from(bytes));
      expect(Array.from(base64ToBytes(ref.replace(/=+$/, '')))).toEqual(Array.from(bytes)); // padding optional
    }
    const all = new Uint8Array(256).map((_, i) => i);
    expect(bytesToBase64(all)).toBe(btoa(String.fromCharCode(...all)));
  });

  it('rejects malformed base64', () => {
    expect(() => base64ToBytes('ab$d')).toThrow();
    expect(() => base64ToBytes('abcde')).toThrow();
    expect(() => base64ToBytes('ab=c')).toThrow();
    expect(() => base64ToBytes('éééé')).toThrow();
  });
});

describe('save → load round trip', () => {
  it('is exact: world layers byte-identical, same hash, and 300 more ticks give the same hash', () => {
    const a = fresh('eden', 42, 300);
    const json = serializeSim(a);
    const file = JSON.parse(json) as Json;
    expect(file.format).toBe(SAVE_FORMAT);
    expect(file.version).toBe(SAVE_VERSION);
    expect(typeof file.savedAt).toBe('string');
    expect(file.tick).toBe(300);
    expect(file.state.world.food.$typed).toBe('Float32Array');
    expect(file.state.world.territory.$typed).toBe('Int16Array');

    const warnings: string[] = [];
    const state = deserializeState(json, { warnings });
    expect(warnings).toEqual([]);
    for (const k of LAYERS) {
      expect(state.world[k].constructor, k).toBe(a.state.world[k].constructor);
      expect(bytesOf(state.world[k]), k).toEqual(bytesOf(a.state.world[k]));
    }
    const b = Simulation.fromState(state);
    expect(b.tick).toBe(300);
    expect(b.hash()).toBe(a.hash());
    a.run(300);
    b.run(300);
    expect(b.tick).toBe(600);
    expect(b.hash(), 'loaded copy diverged from the original').toBe(a.hash());
  });

  it('preserves every field exactly (NaN targets, -0, logs, schedules, stats)', () => {
    const a = fresh('two-civs', 7, 100);
    a.enqueue({ kind: 'spawn', x: 800, y: 500, count: 5, radius: 40, tribe: 'new', tribeName: 'Testers', template: { speed: 0.9, spread: 0.02 } });
    a.enqueue({ kind: 'setConfig', patch: { mutationRate: 0.2, overgrazing: false } });
    a.enqueue({ kind: 'disaster', disaster: 'drought', x: 400, y: 400, radius: 120, intensity: 0.6, duration: 200 });
    a.run(60);
    a.state.agents[0].targetX = NaN;
    a.state.agents[0].targetY = NaN;
    a.state.agents[1].vx = -0;

    const b = deserializeState(serializeSim(a));
    expect(Number.isNaN(b.agents[0].targetX) && Number.isNaN(b.agents[0].targetY)).toBe(true);
    expect(Object.is(b.agents[1].vx, -0)).toBe(true);
    // toEqual distinguishes 0/-0 and treats NaN as equal to NaN → this is a bit-exact comparison
    expect(b.agents).toEqual(a.state.agents);
    expect(b.tribes).toEqual(a.state.tribes);
    expect(b.lineage).toEqual(a.state.lineage);
    expect(b.events).toEqual(a.state.events);
    expect(b.disasters).toEqual(a.state.disasters);
    expect(b.scheduled).toEqual(a.state.scheduled);
    expect(b.interventionLog).toEqual(a.state.interventionLog);
    expect(b.interventionLog.length).toBeGreaterThanOrEqual(3);
    expect(b.env).toEqual(a.state.env);
    expect(b.stats).toEqual(a.state.stats);
    expect(b.config).toEqual(a.state.config);
    expect(b.rngState).toEqual(a.rng.getState());
    for (const k of ['nextAgentId', 'nextTribeId', 'nextEventId', 'nextDisasterId', 'tick', 'scenarioId'] as const) expect(b[k], k).toBe(a.state[k]);
  });

  it('is exact when saved right after create, before the first tick', () => {
    // state.rngState is only refreshed at the end of step(); serializeSim must snapshot the live RNG.
    const a = Simulation.create({ scenario: getScenario('predators'), seed: 3 });
    const b = loadSim(serializeSim(a));
    a.run(200);
    b.run(200);
    expect(b.hash()).toBe(a.hash());
  });

  it('every scenario round-trips mid-run and continues identically', () => {
    for (const sc of SCENARIOS) {
      const a = Simulation.create({ scenario: sc, seed: 11 });
      a.run(150);
      const b = loadSim(serializeSim(a));
      expect(b.hash(), sc.id).toBe(a.hash());
      a.run(150);
      b.run(150);
      expect(b.hash(), `${sc.id} diverged after load`).toBe(a.hash());
    }
  });

  it('re-serialising a loaded save reproduces the same file, and saves chain losslessly', () => {
    const a = fresh('collapse', 9, 120);
    const j1 = serializeSim(a, { savedAt: 'fixed' });
    const b = loadSim(j1);
    expect(JSON.parse(serializeSim(b, { savedAt: 'fixed' }))).toEqual(JSON.parse(j1));
    b.run(100);
    a.run(100);
    const c = loadSim(serializeSim(b));
    expect(c.hash()).toBe(a.hash());
  });

  it('suggests a descriptive, filesystem-safe file name', () => {
    const sim = fresh('two-civs', 42, 10);
    expect(saveFileName(sim)).toBe('artificial-life_two-civs_seed42_day0_t10.json');
    sim.state.scenarioId = '../evil name!';
    expect(saveFileName(sim)).toMatch(/^artificial-life_evil-name_seed42_day0_t10\.json$/);
  });
});

describe('validation: unusable files are rejected with a clear message', () => {
  const sim = fresh('two-civs', 5, 30);
  const cases: [string, string, RegExp][] = [
    ['empty', '', /empty/i],
    ['whitespace', '  \n ', /empty/i],
    ['not JSON', 'hello world', /not valid JSON/i],
    ['truncated', serializeSim(sim).slice(0, 5000), /not valid JSON/i],
    ['JSON array', '[1,2,3]', /not an Artificial Life save/i],
    ['other format', '{"format":"other","version":1,"state":{}}', /not an Artificial Life save/i],
    ['newer version', tamper(sim, (f) => (f.version = SAVE_VERSION + 1)), /newer version/i],
    ['bad version', tamper(sim, (f) => (f.version = 'one')), /version/i],
    ['no state', tamper(sim, (f) => delete f.state), /no simulation state/i],
    ['no world', tamper(sim, (f) => delete f.state.world), /no world map/i],
    ['bad world size', tamper(sim, (f) => (f.state.world.width = -5)), /invalid world size/i],
    ['array length mismatch', tamper(sim, (f) => (f.state.world.width = 199)), /needs \d+/i],
    ['missing layer', tamper(sim, (f) => delete f.state.world.elevation), /missing its "elevation" layer/i],
    ['truncated layer', tamper(sim, (f) => (f.state.world.food.b64 = f.state.world.food.b64.slice(0, -8))), /"food".*corrupted/i],
    ['bad base64', tamper(sim, (f) => (f.state.world.food.b64 = '!!!!' + f.state.world.food.b64.slice(4))), /"food" is corrupted/i],
    ['wrong layer type', tamper(sim, (f) => (f.state.world.terrain = f.state.world.food)), /wrong data type/i],
    ['unknown binary type', tamper(sim, (f) => (f.state.world.food.$typed = 'BigInt64Array')), /unsupported binary data type/i],
    ['NaN tick', tamper(sim, (f) => (f.state.tick = { $num: 'NaN' })), /tick/i],
    ['negative tick', tamper(sim, (f) => (f.state.tick = -3)), /tick/i],
  ];
  for (const [name, json, re] of cases) {
    it(`rejects: ${name}`, () => {
      expect(() => deserializeState(json)).toThrow(re);
      const v = validateSave(json);
      expect(v.ok).toBe(false);
      expect(v.errors).toHaveLength(1);
      expect(v.errors[0]).toMatch(re);
      expect(v.errors[0]).toMatch(/^Cannot load: /);
    });
  }

  it('enforces the size limit and input type', () => {
    expect(MAX_SAVE_CHARS).toBe(100 * 1024 * 1024);
    expect(() => deserializeState(serializeSim(sim), { maxChars: 1000 })).toThrow(/too large/i);
    expect(() => deserializeState(42 as unknown as string)).toThrow(/JSON text/);
  });

  it('accepts a valid save (with a UTF-8 BOM) without warnings', () => {
    const v = validateSave('﻿' + serializeSim(sim));
    expect(v).toEqual({ ok: true, errors: [], warnings: [] });
  });
});

describe('validation: damaged files are sanitised', () => {
  it('repairs bad values, drops corrupt records and unknown references, and the result runs', () => {
    const sim = fresh('two-civs', 5, 60);
    const s = sim.state;
    // world damage is planted in the live arrays (they are saved as raw bytes)
    s.world.terrain[5] = 99;
    s.world.food[3] = NaN;
    s.world.food[4] = -1;
    s.world.fertility[6] = 50;
    s.world.climateMod[8] = Infinity;
    s.world.territory[7] = 1234;
    const [o0, o1, o2, o3] = s.agents;
    const [t0, t1] = s.tribes;
    expect(t1).toBeDefined();

    let json = tamper(sim, (f) => {
      const st = f.state;
      const [a0, a1, a2, a3] = st.agents;
      a0.x = 1e9;
      a0.y = -50;
      a0.genes[0] = 7;
      a0.genes[1] = -2;
      a0.genes[2] = 'x';
      a0.traits.maxHealth = 1e9;
      a0.health = 1e9;
      a0.food = -5;
      a0.energy = { $num: 'NaN' };
      a0.action = 'teleport';
      a0.role = 'emperor';
      a0.targetId = 999_999; // never allocated
      a0.tribeId = 77; // unknown tribe
      a0.targetX = 'here';
      a0.relationships = [
        { id: 999_999, affinity: 0.5, kin: 0, lastTick: 0, interactions: 1 },
        { id: a1.id, affinity: 5, kin: 7, lastTick: 0, interactions: 1 },
        { id: a1.id, affinity: 0.1, kin: 0, lastTick: 0, interactions: 1 }, // duplicate
      ];
      a0.children = [999_999, 'kid'];
      a1.genes = a1.genes.slice(0, 5); // short genome → padded
      a3.x = { $num: 'Infinity' }; // unusable position → agent dropped
      st.agents.push(JSON.parse(JSON.stringify(a2))); // duplicate id
      st.agents.push({ ...JSON.parse(JSON.stringify(a2)), id: 888_888, alive: false }); // dead
      st.agents.push({ id: 'zzz' }); // corrupt
      st.lineage.push({ id: 'bad' });
      st.nextAgentId = 1; // stale counter
      st.nextTribeId = 'x';
      st.rngState = [1, 2, 3];
      st.config.mutationRate = 99;
      st.config.overgrazing = 'yes';
      st.config.bogus = 1;
      delete st.config.foodRegen;
      st.tribes[0].stockpile = -10;
      st.tribes[0].homeX = { $num: 'NaN' };
      st.tribes[0].relations = { 9999: 0.5, [t1.id]: 3 };
      st.events = Array.from({ length: LIMITS.events + 50 }, (_, i) => ({ id: i + 1, tick: 0, category: 'nope', severity: 'info', message: 'm' }));
      st.scheduled.push(
        { tick: 10_000, intervention: { kind: 'explode' } },
        { tick: 10_001, intervention: { kind: 'disaster', disaster: 'bloom', x: 1, y: 1, radius: 5, intensity: 0.5, duration: 10 }, repeat: -3 },
        { tick: 10_002, intervention: { kind: 'spawn', x: 'a', y: 1, count: 3, radius: 5 } },
      );
      delete st.stats;
      st.junk = { lots: 'of data' };
    });
    // prototype-pollution attempt
    json = json.replace('"state":{', '"state":{"__proto__":{"polluted":true},');

    const v = validateSave(json);
    expect(v.ok).toBe(true);
    expect(v.warnings.length).toBeGreaterThan(5);

    const st = deserializeState(json);
    const W = st.world.width * st.world.tileSize;
    const H = st.world.height * st.world.tileSize;

    // prototype pollution blocked
    expect(({} as Json).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(st)).toBe(Object.prototype);
    expect((st as unknown as Json).junk).toBeUndefined();

    // world
    expect(st.world.terrain[5]).toBeLessThan(TERRAIN_COUNT);
    expect(st.world.food[3]).toBe(0);
    expect(st.world.food[4]).toBe(0);
    expect(st.world.fertility[6]).toBeLessThanOrEqual(2);
    expect(Number.isFinite(st.world.climateMod[8])).toBe(true);
    expect(st.world.territory[7]).toBe(NONE);

    // agents
    const ids = st.agents.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(o3.id);
    expect(ids).not.toContain(888_888);
    expect(st.agents.every((a) => a.alive)).toBe(true);
    const a0 = st.agents.find((a) => a.id === o0.id)!;
    expect(a0.x).toBeGreaterThanOrEqual(0);
    expect(a0.x).toBeLessThan(W);
    expect(a0.y).toBeGreaterThanOrEqual(0);
    expect(a0.y).toBeLessThan(H);
    expect(a0.genes.slice(0, 3)).toEqual([1, 0, 0.5]);
    expect(a0.traits).toEqual(expressTraits(a0.genes));
    expect(a0.health).toBe(a0.traits.maxHealth);
    expect(a0.food).toBe(0);
    expect(a0.energy).toBe(1);
    expect(a0.action).toBe('idle');
    expect(a0.role).toBe('none');
    expect(a0.targetId).toBe(NONE);
    expect(a0.tribeId).toBe(NONE);
    expect(Number.isNaN(a0.targetX)).toBe(true);
    expect(a0.relationships).toHaveLength(1);
    expect(a0.relationships[0]).toMatchObject({ id: o1.id, affinity: 1, kin: 0 });
    expect(a0.children).toEqual([]);
    const a1 = st.agents.find((a) => a.id === o1.id)!;
    expect(a1.genes).toHaveLength(GENE_COUNT);
    expect(st.agents.find((a) => a.id === o2.id)).toBeDefined(); // original kept, duplicate dropped

    // counters & rng
    const maxId = Math.max(...st.agents.map((a) => a.id), ...st.lineage.map((l) => l.id));
    expect(st.nextAgentId).toBeGreaterThan(maxId);
    expect(st.nextTribeId).toBeGreaterThan(Math.max(...st.tribes.map((t) => t.id)));
    expect(st.rngState).toHaveLength(4);
    expect(st.lineage.every((l) => Number.isInteger(l.id))).toBe(true);

    // config
    const maxMut = PARAM_SPECS.find((p) => p.key === 'mutationRate')!.max;
    expect(st.config.mutationRate).toBe(maxMut);
    expect(st.config.overgrazing).toBe(DEFAULT_CONFIG.overgrazing);
    expect(st.config.foodRegen).toBe(DEFAULT_CONFIG.foodRegen);
    expect('bogus' in st.config).toBe(false);

    // tribes
    const tr0 = st.tribes.find((t) => t.id === t0.id)!;
    expect(tr0.stockpile).toBe(0);
    expect(Number.isFinite(tr0.homeX)).toBe(true);
    expect(Object.keys(tr0.relations)).toEqual([String(t1.id)]);
    expect(tr0.relations[t1.id]).toBe(1);

    // logs, schedules, stats
    expect(st.events).toHaveLength(LIMITS.events);
    expect(st.events.every((e) => e.category === 'environment')).toBe(true);
    expect(st.nextEventId).toBeGreaterThan(LIMITS.events + 50);
    const extra = st.scheduled.filter((e) => e.tick >= 10_000);
    expect(extra).toHaveLength(1);
    expect(extra[0].repeat).toBeUndefined();
    expect(st.stats.samples).toEqual([]);
    expect(st.stats.counters.deathsByCause.starvation).toBe(0);

    // and the repaired state is runnable
    const loaded = Simulation.fromState(st);
    loaded.run(100);
    expectFiniteAgents(loaded.state);
  });

  it('keeps references to agents that merely died (the live simulation keeps them too)', () => {
    const sim = fresh('eden', 21, 50);
    const [a, b] = sim.state.agents;
    sim.killAgent(b, 'removed');
    a.targetId = b.id;
    a.relationships = [{ id: b.id, affinity: 0.4, kin: 0, lastTick: sim.tick, interactions: 2 }];
    const st = deserializeState(serializeSim(sim));
    const la = st.agents.find((x) => x.id === a.id)!;
    expect(la.targetId).toBe(b.id);
    expect(la.relationships.map((r) => r.id)).toEqual([b.id]);
  });

  it('upgrades null targets from plain-JSON saves to NaN', () => {
    const sim = fresh('eden', 2, 20);
    const json = tamper(sim, (f) => {
      f.state.agents[0].targetX = null;
      f.state.agents[0].targetY = null;
    });
    const w: string[] = [];
    const st = deserializeState(json, { warnings: w });
    expect(Number.isNaN(st.agents[0].targetX)).toBe(true);
    expect(w).toEqual([]);
  });
});
