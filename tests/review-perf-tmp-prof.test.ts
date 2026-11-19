// TEMPORARY review experiment (performance lens) — deleted after the review.
// Run NEW and BASE side by side (interleaved) under --cpu-prof to attribute the time difference.
import { describe, expect, it } from 'vitest';
import { Simulation as NewSim } from '../src/sim/simulation';
import { SCENARIOS as NEW_SC } from '../src/sim/presets';
import { Simulation as BaseSim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/simulation';
import { SCENARIOS as BASE_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/presets';

describe('review perf: profile', () => {
  it('NEW vs BASE natural run', () => {
    const id = process.env.PROF_PRESET ?? 'two-civs';
    const ticks = Number(process.env.PROF_TICKS ?? 4200);
    const p = NEW_SC.findIndex((s) => s.id === id);
    const ns = NewSim.create({ scenario: NEW_SC[p], seed: 42 });
    const bs = BaseSim.create({ scenario: BASE_SC[p], seed: 42 });
    let tN = 0;
    let tB = 0;
    let aN = 0;
    let aB = 0;
    for (let done = 0; done < ticks; done += 100) {
      let t0 = performance.now();
      for (let k = 0; k < 100; k++) ns.step();
      tN += performance.now() - t0;
      aN += ns.state.agents.length * 100;
      t0 = performance.now();
      for (let k = 0; k < 100; k++) bs.step();
      tB += performance.now() - t0;
      aB += bs.state.agents.length * 100;
    }
    console.log(`[perf-prof] ${id}: NEW ${(tN / ticks).toFixed(2)} ms/tick ${(1000 * tN / aN).toFixed(2)} µs/agent-tick | BASE ${(tB / ticks).toFixed(2)} ms/tick ${(1000 * tB / aB).toFixed(2)} µs/agent-tick`);
    expect(tN).toBeGreaterThan(0);
  }, 900_000);
});
