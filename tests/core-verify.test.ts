/**
 * Simulation-core verification (independent re-check of the core audit): the canonical intervention form
 * must make "record = apply = reload" hold for ANY input, and the load-time repairs added for hostile files
 * must be the identity on every state a running simulation produces.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { deserializeState, loadSim, serializeSim } from '../src/sim/persistence';
import { SCENARIOS, getScenario } from '../src/sim/presets';
import { Rng } from '../src/sim/rng';
import { TERRAIN, type Intervention } from '../src/sim/types';

const JUNK_NUMS = [NaN, Infinity, -Infinity, -5, 0, -0, 1e30, -1e30, 0.5, 3, 7.5, 1e-9];
const junk = (r: Rng): unknown => {
  const k = r.int(8);
  return k === 0 ? 'str' : k === 1 ? null : k === 2 ? undefined : k === 3 ? { nested: 1 } : r.pick(JUNK_NUMS);
};
const maybe = (r: Rng, good: number): unknown => (r.next() < 0.6 ? good : junk(r));

/** A random intervention of any kind, often with invalid / non-finite / wrongly typed fields. */
function fuzzedIntervention(r: Rng, sim: Simulation): Intervention {
  const x = maybe(r, r.next() * sim.worldW);
  const y = maybe(r, r.next() * sim.worldH);
  const kind = r.pick(['spawn', 'remove', 'killAgent', 'boostAgent', 'addFood', 'removeFood', 'paintTerrain', 'fertilize', 'disaster', 'setConfig', 'bogus']);
  const living = sim.state.agents;
  const someId = living.length ? living[r.int(living.length)].id : 1;
  let iv: Record<string, unknown>;
  switch (kind) {
    case 'spawn':
      iv = {
        kind, x, y, count: maybe(r, 1 + r.int(12)), radius: maybe(r, r.next() * 80),
        template: r.next() < 0.5 ? { speed: maybe(r, r.next()), size: maybe(r, r.next()), spread: maybe(r, r.next() * 0.2), aggression: maybe(r, r.next()) } : junk(r),
        tribe: r.pick(['new', 'none', 1, 2, 3, 2.5, 'x', undefined, null, -1]),
        tribeName: r.pick(['  Foo  ', '', '   ', 'x'.repeat(60), 5, undefined]),
      };
      break;
    case 'remove':
    case 'removeFood':
      iv = { kind, x, y, radius: maybe(r, r.next() * 60) };
      break;
    case 'killAgent':
    case 'boostAgent':
      iv = { kind, id: r.next() < 0.7 ? someId : junk(r) };
      break;
    case 'addFood':
      iv = { kind, x, y, radius: maybe(r, r.next() * 60), amount: maybe(r, r.next() * 8) };
      break;
    case 'fertilize':
      iv = { kind, x, y, radius: maybe(r, r.next() * 60), amount: maybe(r, r.next() * 2 - 1) };
      break;
    case 'paintTerrain':
      iv = { kind, x, y, radius: maybe(r, r.next() * 40), terrain: r.next() < 0.8 ? r.int(8) : junk(r) };
      break;
    case 'disaster':
      iv = {
        kind, disaster: r.pick(['drought', 'blight', 'bloom', 'plague', 'meteor', 'coldsnap', 'volcano']), x, y,
        radius: maybe(r, r.next() * 200), intensity: maybe(r, r.next()), duration: maybe(r, 20 + r.int(200)),
      };
      break;
    case 'setConfig':
      iv = { kind, patch: r.next() < 0.8 ? { foodRegen: maybe(r, r.next() * 2), aggressionBias: maybe(r, r.next() * 2), seasons: r.pick([true, false, 1]), seed: 4 } : junk(r) };
      break;
    default:
      iv = { kind };
  }
  return iv as unknown as Intervention;
}

function fuzz(sim: Simulation, seed: number, until: number): void {
  const r = new Rng(seed, 99);
  while (sim.tick < until) {
    if (r.next() < 0.25) for (let n = 1 + r.int(3); n > 0; n--) sim.enqueue(fuzzedIntervention(r, sim));
    sim.step();
  }
}

describe('fuzzed interventions: the recorded log reproduces the run, also after a save round trip', () => {
  for (const [id, seed] of [['eden', 1], ['plague-island', 3]] as const) {
    it(`${id}`, () => {
      const a = Simulation.create({ scenario: getScenario(id), seed });
      fuzz(a, seed, 160);
      expect(a.state.interventionLog.length).toBeGreaterThan(20);
      const replay = Simulation.create({ scenario: getScenario(id), seed, replay: a.state.interventionLog });
      replay.run(160);
      expect(replay.hash(), 'replay of the in-memory log').toBe(a.hash());

      const warnings: string[] = [];
      const st = deserializeState(serializeSim(a), { warnings });
      expect(warnings, 'a save of recorded (canonical) interventions needs no repair').toEqual([]);
      const fromSave = Simulation.create({ scenario: getScenario(id), seed, replay: st.interventionLog });
      fromSave.run(160);
      expect(fromSave.hash(), 'replay of the log read back from the save').toBe(a.hash());

      const loaded = Simulation.fromState(st);
      expect(loaded.hash()).toBe(a.hash());
      fuzz(a, seed + 1000, 240);
      fuzz(loaded, seed + 1000, 240);
      expect(loaded.hash({ events: false }), 'loaded copy diverged under further fuzzed interventions').toBe(a.hash({ events: false }));
    });
  }
});

describe('load-time repairs are the identity on real simulation states', () => {
  it('every preset, saved mid-run after terrain painting and disasters, loads without a single repair', () => {
    const problems: string[] = [];
    for (const sc of SCENARIOS) {
      const sim = Simulation.create({ scenario: getScenario(sc.id), seed: 5 });
      const r = new Rng(5, 7);
      for (let k = 0; k < 4; k++) {
        const W = sim.worldW;
        const H = sim.worldH;
        sim.enqueue({ kind: 'paintTerrain', x: r.next() * W, y: r.next() * H, radius: 30 + r.next() * 60, terrain: r.pick([TERRAIN.DeepWater, TERRAIN.Wall, TERRAIN.Grass]) });
        sim.enqueue({ kind: 'disaster', disaster: r.pick(['plague', 'meteor', 'coldsnap', 'drought'] as const), x: r.next() * W, y: r.next() * H, radius: 150, intensity: 0.8, duration: 200 });
        sim.run(120);
        const warnings: string[] = [];
        const l = loadSim(serializeSim(sim), { warnings });
        if (warnings.length) problems.push(`${sc.id}@${sim.tick}: ${warnings.join('; ')}`);
        if (l.hash() !== sim.hash()) problems.push(`${sc.id}@${sim.tick}: hash differs after load`);
      }
    }
    expect(problems).toEqual([]);
  });
});
