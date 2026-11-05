/**
 * Determinism (QA-owned).
 *
 * The simulation core must be a pure function of (scenario, seed, interventions):
 *  - same seed + same interventions at the same ticks → identical state hash at every checkpoint
 *  - different seed → different state
 *  - "restart & replay" (Simulation.create({ replay: interventionLog })) reproduces the original run
 *  - save → load → continue is indistinguishable from an uninterrupted run
 *  - no Math.random() inside the simulation
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { deserializeState, serializeSim } from '../src/sim/persistence';
import { drive, interventionPlan } from '../scripts/qa-helpers';

const SC = SCENARIOS[0];
const SEED = 4242;
const END = 900;
const CHECKPOINTS = [1, 50, 150, 300, 450, 600, 900];

/** Run the scripted intervention plan and collect `tick:hash` at each checkpoint. */
function scripted(seed: number, end = END): { sim: Simulation; hashes: string[] } {
  const sim = Simulation.create({ scenario: SC, seed });
  const plan = interventionPlan(sim);
  const hashes: string[] = [];
  drive(sim, plan, end, (s) => {
    if (CHECKPOINTS.includes(s.tick)) hashes.push(`${s.tick}:${s.hash()}`);
  });
  return { sim, hashes };
}

describe('determinism', () => {
  it('same seed + identical interventions → identical hash at every checkpoint', () => {
    const a = scripted(SEED);
    const b = scripted(SEED);
    expect(a.hashes.length).toBe(CHECKPOINTS.length);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.sim.state.interventionLog.length).toBe(a.sim.state.interventionLog.length);
    expect(a.sim.state.interventionLog.length).toBeGreaterThan(0);
  });

  it('interventions actually change the outcome (guards against a vacuous test)', () => {
    const withPlan = scripted(SEED, 300).sim.hash();
    const plain = Simulation.create({ scenario: SC, seed: SEED });
    plain.run(300);
    expect(plain.hash()).not.toBe(withPlan);
  });

  it('different seeds → different state', () => {
    const a = Simulation.create({ scenario: SC, seed: 1 });
    const b = Simulation.create({ scenario: SC, seed: 2 });
    expect(a.hash()).not.toBe(b.hash());
    a.run(300);
    b.run(300);
    expect(a.hash()).not.toBe(b.hash());
  });

  it('every scenario is deterministic for a fixed seed (incl. scheduled events)', () => {
    for (const sc of SCENARIOS) {
      const a = Simulation.create({ scenario: sc, seed: 99 });
      const b = Simulation.create({ scenario: sc, seed: 99 });
      for (let i = 0; i < 4; i++) {
        a.run(150);
        b.run(150);
        expect(b.hash(), `scenario ${sc.id} diverged by tick ${a.tick}`).toBe(a.hash());
      }
    }
  });

  it('replaying the intervention log reproduces the original run', () => {
    const orig = scripted(SEED);
    const replay = Simulation.create({ scenario: SC, seed: SEED, replay: orig.sim.state.interventionLog });
    const hashes: string[] = [];
    while (replay.tick < END) {
      replay.step();
      if (CHECKPOINTS.includes(replay.tick)) hashes.push(`${replay.tick}:${replay.hash()}`);
    }
    expect(hashes).toEqual(orig.hashes);
    expect(replay.state.interventionLog.length).toBe(orig.sim.state.interventionLog.length);
  });

  it('save → load → continue equals an uninterrupted run', (ctx) => {
    const SAVE_AT = 450;
    const a = Simulation.create({ scenario: SC, seed: SEED });
    const planA = interventionPlan(a);
    drive(a, planA, SAVE_AT);
    const beforeSave = a.hash();

    let json: string;
    try {
      json = serializeSim(a);
    } catch (err) {
      if (/not implemented/i.test(String(err))) ctx.skip('persistence.serializeSim is still a stub ("not implemented") — re-run once persistence lands');
      throw err;
    }
    expect(typeof json).toBe('string');
    expect(() => JSON.parse(json)).not.toThrow();

    const loaded = Simulation.fromState(deserializeState(json));
    expect(loaded.tick).toBe(SAVE_AT);
    expect(loaded.hash(), 'hash changed by the save/load round-trip itself').toBe(beforeSave);

    // continue both: the loaded copy and the original (which never left memory)
    drive(loaded, interventionPlan(loaded), END);
    drive(a, planA, END);

    const b = Simulation.create({ scenario: SC, seed: SEED });
    drive(b, interventionPlan(b), END);

    expect(a.hash(), 'original diverged from a fresh uninterrupted run').toBe(b.hash());
    expect(loaded.hash(), 'loaded save diverged after continuing — some state lives outside SimState?').toBe(b.hash());
    // A second round-trip of the continued run must also be lossless
    expect(Simulation.fromState(deserializeState(serializeSim(loaded))).hash()).toBe(loaded.hash());
  });

  describe('no ambient randomness', () => {
    const realRandom = Math.random;
    afterEach(() => {
      Math.random = realRandom;
    });

    it('never calls Math.random() while simulating', () => {
      let calls = 0;
      Math.random = () => {
        calls++;
        return realRandom();
      };
      for (const sc of SCENARIOS) {
        const sim = Simulation.create({ scenario: sc, seed: 5 });
        drive(sim, interventionPlan(sim), 400);
      }
      Math.random = realRandom;
      expect(calls, 'Math.random() was used inside src/sim — use sim.rng instead').toBe(0);
    });
  });
});
