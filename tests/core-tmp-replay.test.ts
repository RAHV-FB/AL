// TEMPORARY verification probe (core-verify). Deleted after use.
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { deserializeState, loadSim, serializeSim } from '../src/sim/persistence';
import { SCENARIOS, getScenario } from '../src/sim/presets';
import { Rng } from '../src/sim/rng';
import { checkInvariants } from '../scripts/qa-helpers';
import { TERRAIN, type Intervention } from '../src/sim/types';

const junkNums = [NaN, Infinity, -Infinity, -5, 0, -0, 1e30, -1e30, 0.5, 3, 7.5, 1e-9];
function junk(r: Rng): unknown {
  const k = r.int(8);
  if (k === 0) return 'str';
  if (k === 1) return null;
  if (k === 2) return undefined;
  if (k === 3) return { nested: 1 };
  return r.pick(junkNums);
}
function maybe(r: Rng, good: number): unknown {
  return r.next() < 0.6 ? good : junk(r);
}

function randomIv(r: Rng, sim: Simulation): Intervention {
  const W = sim.worldW;
  const H = sim.worldH;
  const x = maybe(r, r.next() * W);
  const y = maybe(r, r.next() * H);
  const kinds = ['spawn', 'remove', 'killAgent', 'boostAgent', 'addFood', 'removeFood', 'paintTerrain', 'fertilize', 'disaster', 'setConfig', 'bogus'];
  const kind = r.pick(kinds);
  const living = sim.state.agents;
  const someId = living.length ? living[r.int(living.length)].id : 1;
  let iv: Record<string, unknown>;
  switch (kind) {
    case 'spawn':
      iv = {
        kind, x, y, count: maybe(r, 1 + r.int(12)), radius: maybe(r, r.next() * 80),
        template: r.next() < 0.5 ? { speed: maybe(r, r.next()), size: maybe(r, r.next()), spread: maybe(r, r.next() * 0.2), aggression: maybe(r, r.next()) } : maybe(r, 3),
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
      iv = { kind, disaster: r.pick(['drought', 'blight', 'bloom', 'plague', 'meteor', 'coldsnap', 'volcano']), x, y, radius: maybe(r, r.next() * 200), intensity: maybe(r, r.next()), duration: maybe(r, 20 + r.int(200)) };
      break;
    case 'setConfig':
      iv = { kind, patch: r.next() < 0.8 ? { foodRegen: maybe(r, r.next() * 2), aggressionBias: maybe(r, r.next() * 2), seasons: r.pick([true, false, 1]), maxAgents: maybe(r, 100 + r.int(900)), seed: 4 } : junk(r) };
      break;
    default:
      iv = { kind };
  }
  return iv as unknown as Intervention;
}

function drive(sim: Simulation, seed: number, until: number, perTick = 0.25) {
  const r = new Rng(seed, 99);
  while (sim.tick < until) {
    if (r.next() < perTick) {
      const n = 1 + r.int(3);
      for (let i = 0; i < n; i++) sim.enqueue(randomIv(r, sim));
    }
    sim.step();
  }
}

describe('core-tmp replay/persistence probe', () => {
  it('fuzzed interventions: log replays exactly, also after a save round trip, and saves need no repair', () => {
    for (const [scId, seed] of [['eden', 1], ['two-civs', 2], ['plague-island', 3], ['evolab', 4]] as const) {
      const sc = getScenario(scId);
      const a = Simulation.create({ scenario: sc, seed });
      drive(a, seed, 160);
      const v = checkInvariants(a, { lastTerrainEditTick: a.tick, relationGrace: 10_000 }).filter((m) => !m.includes('> config.maxAgents'));
      expect(v, v.join('\n')).toEqual([]);
      const b = Simulation.create({ scenario: getScenario(scId), seed, replay: a.state.interventionLog });
      b.run(160);
      expect(b.hash(), `${scId} replay`).toBe(a.hash());
      const warnings: string[] = [];
      const st = deserializeState(serializeSim(a), { warnings });
      expect(warnings, scId).toEqual([]);
      const c = Simulation.create({ scenario: getScenario(scId), seed, replay: st.interventionLog });
      c.run(160);
      expect(c.hash(), `${scId} replay from save`).toBe(a.hash());
      // the loaded sim continues identically (trajectory) with more fuzzed interventions
      const l = Simulation.fromState(st);
      expect(l.hash()).toBe(a.hash());
      drive(a, seed + 1000, 260);
      drive(l, seed + 1000, 260);
      expect(l.hash({ events: false }), `${scId} continue`).toBe(a.hash({ events: false }));
      console.log(scId, 'log', a.state.interventionLog.length, 'agents', a.state.agents.length, 'eventsEq', l.hash() === a.hash());
    }
  });

  it('legit saves of every preset at many points load without any repair and with identical full hash', () => {
    const problems: string[] = [];
    for (const sc of SCENARIOS) {
      for (const seed of [5, 6]) {
        const sim = Simulation.create({ scenario: getScenario(sc.id), seed });
        const r = new Rng(seed, 7);
        for (let k = 0; k < 6; k++) {
          // a few legit UI-style interventions
          const W = sim.worldW, H = sim.worldH;
          sim.enqueue({ kind: 'paintTerrain', x: r.next() * W, y: r.next() * H, radius: 30 + r.next() * 60, terrain: r.pick([TERRAIN.DeepWater, TERRAIN.Wall, TERRAIN.Grass]) });
          sim.enqueue({ kind: 'disaster', disaster: r.pick(['plague', 'meteor', 'coldsnap', 'drought']), x: r.next() * W, y: r.next() * H, radius: 150, intensity: 0.8, duration: 200 });
          sim.run(120);
          const warnings: string[] = [];
          const text = serializeSim(sim);
          const l = loadSim(text, { warnings });
          if (warnings.length) problems.push(`${sc.id}/${seed}@${sim.tick}: ${warnings.join('; ')}`);
          if (l.hash() !== sim.hash()) problems.push(`${sc.id}/${seed}@${sim.tick}: hash differs after load`);
        }
      }
    }
    console.log(problems.join('\n'));
    expect(problems).toEqual([]);
  });
});
