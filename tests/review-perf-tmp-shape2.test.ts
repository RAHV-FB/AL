// TEMPORARY review experiment (performance lens) — deleted after the review.
// After save → load, are agents still one hidden class (FIX1 declares route/trek in createAgent only)?
import { describe, expect, it } from 'vitest';
import { Simulation as NewSim } from '../src/sim/simulation';
import { SCENARIOS as NEW_SC } from '../src/sim/presets';
import { deserializeState as newDeser, serializeSim as newSer } from '../src/sim/persistence';
import { Simulation as Fix1Sim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/fix1/src/sim/simulation';
import { SCENARIOS as FIX1_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/fix1/src/sim/presets';
import { deserializeState as fixDeser, serializeSim as fixSer } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/fix1/src/sim/persistence';

type AnySim = { step(): void; hash(): string | number; state: { agents: object[] } };

function mapCount(agents: object[]): number | string {
  let same: (a: object, b: object) => boolean;
  try {
    same = new Function('a', 'b', 'return %HaveSameMap(a, b)') as (a: object, b: object) => boolean;
  } catch {
    return 'n/a';
  }
  const reps: object[] = [];
  for (const a of agents) if (!reps.some((r) => same(r, a))) reps.push(a);
  return reps.length;
}

describe('review perf: shapes after load', () => {
  it('live vs loaded sims (NEW and FIX1)', () => {
    const p = NEW_SC.findIndex((s) => s.id === 'two-civs');
    const nLive = NewSim.create({ scenario: NEW_SC[p], seed: 42 }) as unknown as AnySim;
    const fLive = Fix1Sim.create({ scenario: FIX1_SC[p], seed: 42 }) as unknown as AnySim;
    for (let k = 0; k < 3000; k++) {
      nLive.step();
      fLive.step();
    }
    const nLoaded = NewSim.fromState(newDeser(newSer(nLive as never))) as unknown as AnySim;
    const fLoaded = Fix1Sim.fromState(fixDeser(fixSer(fLive as never))) as unknown as AnySim;
    const arms = [
      { name: 'NEW live', sim: nLive },
      { name: 'NEW loaded', sim: nLoaded },
      { name: 'FIX1 live', sim: fLive },
      { name: 'FIX1 loaded', sim: fLoaded },
    ].map((a) => ({ ...a, maps0: mapCount(a.sim.state.agents), ms: 0, agentTicks: 0 }));
    for (let done = 0; done < 2400; done += 100) {
      for (const a of arms) {
        const t0 = performance.now();
        for (let k = 0; k < 100; k++) a.sim.step();
        a.ms += performance.now() - t0;
        a.agentTicks += 100 * a.sim.state.agents.length;
      }
    }
    const lines = arms.map((a) => `${a.name.padEnd(12)} ${((1000 * a.ms) / a.agentTicks).toFixed(2)} µs/agent-tick; hidden classes right after load/at tick 3000: ${a.maps0}, at the end: ${mapCount(a.sim.state.agents)}`);
    lines.push(`hash live==loaded: NEW ${nLive.hash() === nLoaded.hash()}, FIX1 ${fLive.hash() === fLoaded.hash()}`);
    console.log('[perf-shape2]\n' + lines.join('\n'));
    expect(lines.length).toBe(5);
  }, 900_000);
});
