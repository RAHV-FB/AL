// TEMPORARY review experiment (performance lens) — deleted after the review.
// Hypothesis: Agent.route / Agent.trek are added to agent objects after creation (createAgent does not
// declare them), so agents end up with many V8 hidden classes and hot property accesses go polymorphic /
// megamorphic. FIX1 = working tree + createAgent declares route/trek; FIX2 = also diseaseHp.
import { describe, expect, it } from 'vitest';
import { Simulation as NewSim } from '../src/sim/simulation';
import { SCENARIOS as NEW_SC } from '../src/sim/presets';
import { Simulation as Fix1Sim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/fix1/src/sim/simulation';
import { SCENARIOS as FIX1_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/fix1/src/sim/presets';
import { Simulation as Fix2Sim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/fix2/src/sim/simulation';
import { SCENARIOS as FIX2_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/fix2/src/sim/presets';
import { Simulation as BaseSim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/simulation';
import { SCENARIOS as BASE_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/presets';

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

describe('review perf: agent object shapes', () => {
  it('NEW vs FIX1 vs FIX2 vs BASE, natural runs, interleaved', () => {
    const out: string[] = [];
    const days = Number(process.env.SH_DAYS ?? 8);
    for (const id of (process.env.SH_ONLY ?? 'predators,two-civs').split(',')) {
      const p = NEW_SC.findIndex((s) => s.id === id);
      const arms = [
        { name: 'NEW', sim: NewSim.create({ scenario: NEW_SC[p], seed: 42 }) as unknown as AnySim },
        { name: 'FIX1', sim: Fix1Sim.create({ scenario: FIX1_SC[p], seed: 42 }) as unknown as AnySim },
        { name: 'FIX2', sim: Fix2Sim.create({ scenario: FIX2_SC[p], seed: 42 }) as unknown as AnySim },
        { name: 'BASE', sim: BaseSim.create({ scenario: BASE_SC[p], seed: 42 }) as unknown as AnySim },
      ].map((a) => ({ ...a, ms: 0, agentTicks: 0, maps: 0 as number | string }));
      for (let done = 0; done < days * 600; done += 100) {
        for (const a of arms) {
          const t0 = performance.now();
          for (let k = 0; k < 100; k++) a.sim.step();
          a.ms += performance.now() - t0;
          a.agentTicks += 100 * a.sim.state.agents.length;
        }
      }
      for (const a of arms) a.maps = mapCount(a.sim.state.agents);
      const base = arms[3];
      const hashes = arms.map((a) => String(a.sim.hash()));
      for (const a of arms)
        out.push(
          `${id.padEnd(10)} ${a.name.padEnd(4)} ${((1000 * a.ms) / a.agentTicks).toFixed(2)} µs/agent-tick (×BASE ${((a.ms / a.agentTicks) / (base.ms / base.agentTicks)).toFixed(3)}), ${(a.ms / (days * 600)).toFixed(2)} ms/tick, end agents ${a.sim.state.agents.length}, distinct agent hidden classes ${a.maps}`,
        );
      out.push(`${id.padEnd(10)} hash NEW==FIX1: ${hashes[0] === hashes[1]}, NEW==FIX2: ${hashes[0] === hashes[2]}`);
      console.log(out.slice(-5).join('\n'));
    }
    console.log('[perf-shape]\n' + out.join('\n'));
    expect(out.length).toBeGreaterThan(0);
  }, 1_800_000);
});
