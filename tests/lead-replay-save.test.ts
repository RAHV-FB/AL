import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { getScenario } from '../src/sim/presets';
import { deserializeState, serializeSim } from '../src/sim/persistence';

/** Regression (gap G1): a save taken during "restart & replay" must continue the replay exactly. */
describe('replay survives save/load', () => {
  it('a save taken mid-replay keeps the not-yet-replayed interventions', () => {
    const sc = getScenario('eden');
    const orig = Simulation.create({ scenario: sc, seed: 1 });
    orig.run(100);
    orig.enqueue({ kind: 'spawn', x: 800, y: 500, count: 12, radius: 40, tribe: 'new', tribeName: 'Replayers' });
    orig.run(120);
    orig.enqueue({ kind: 'addFood', x: 600, y: 400, radius: 60, amount: 5 });
    orig.run(80);
    expect(orig.state.interventionLog.length).toBe(2);

    const replay = Simulation.create({ scenario: sc, seed: 1, replay: orig.state.interventionLog });
    replay.run(50);
    expect(replay.pendingReplayCount).toBe(2);
    const loaded = Simulation.fromState(deserializeState(serializeSim(replay)));
    expect(loaded.pendingReplayCount).toBe(2);
    loaded.run(250);
    expect(loaded.state.interventionLog.length).toBe(2);
    expect(loaded.pendingReplayCount).toBe(0);
    expect(loaded.hash({ events: false })).toBe(orig.hash({ events: false }));
  });

  it('interventions enqueued but not yet applied survive a save', () => {
    const sc = getScenario('eden');
    const a = Simulation.create({ scenario: sc, seed: 3 });
    a.run(40);
    a.enqueue({ kind: 'spawn', x: 700, y: 450, count: 5, radius: 30 });
    const b = Simulation.fromState(deserializeState(serializeSim(a)));
    a.run(60);
    b.run(60);
    expect(b.state.interventionLog.length).toBe(1);
    expect(b.hash({ events: false })).toBe(a.hash({ events: false }));
  });

  it('scheduled events with fractional ticks still fire', () => {
    const sc = { ...getScenario('eden'), scheduled: [{ tick: 10.6, intervention: { kind: 'addFood' as const, x: 500, y: 500, radius: 30, amount: 3 }, note: 'Fractional tick fired' }] };
    const sim = Simulation.create({ scenario: sc, seed: 5 });
    sim.run(20);
    expect(sim.state.events.some((e) => e.message === 'Fractional tick fired')).toBe(true);
  });
});
