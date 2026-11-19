// TEMPORARY review experiment (performance lens) — deleted after the review.
// Is brain.think() optimized by V8 in NEW vs BASE? Run with NODE_OPTIONS=--allow-natives-syntax.
import { describe, expect, it } from 'vitest';
import { Simulation as NewSim } from '../src/sim/simulation';
import { SCENARIOS as NEW_SC } from '../src/sim/presets';
import * as newBrain from '../src/sim/brain';
import * as newSteer from '../src/sim/steering';
import { Simulation as BaseSim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/simulation';
import { SCENARIOS as BASE_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/presets';
import * as baseBrain from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/brain';
import * as baseSteer from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/steering';

function decode(s: number): string {
  const bits: [number, string][] = [
    [1 << 4, 'optimized'], [1 << 5, 'maglev'], [1 << 6, 'turbofan'], [1 << 7, 'interpreted'], [1 << 15, 'baseline(sparkplug)'],
    [1 << 1, 'never-optimize'], [1 << 3, 'maybe-deopted'], [1 << 8, 'marked'],
  ];
  return `${s} = ${bits.filter(([b]) => s & b).map(([, n]) => n).join('+') || 'none'}`;
}

describe('review perf: optimisation status', () => {
  it('think/act/moveToward in NEW vs BASE after a warm run', () => {
    let status: (f: unknown) => number;
    try {
      status = new Function('f', 'return %GetOptimizationStatus(f)') as (f: unknown) => number;
    } catch {
      console.log('[perf-opt] natives syntax not enabled');
      return;
    }
    const p = NEW_SC.findIndex((s) => s.id === (process.env.OPT_PRESET ?? 'two-civs'));
    const ns = NewSim.create({ scenario: NEW_SC[p], seed: 42 });
    const bs = BaseSim.create({ scenario: BASE_SC[p], seed: 42 });
    for (let k = 0; k < 3000; k++) {
      ns.step();
      bs.step();
    }
    let tN = 0;
    let tB = 0;
    for (let r = 0; r < 6; r++) {
      let t0 = performance.now();
      for (let k = 0; k < 100; k++) ns.step();
      tN += performance.now() - t0;
      t0 = performance.now();
      for (let k = 0; k < 100; k++) bs.step();
      tB += performance.now() - t0;
    }
    const lines = [
      `NEW  think: ${decode(status(newBrain.think))}  act: ${decode(status(newBrain.act))}  moveToward: ${decode(status(newSteer.moveToward))}  clearPath: ${decode(status(newSteer.clearPath))}`,
      `BASE think: ${decode(status(baseBrain.think))}  act: ${decode(status(baseBrain.act))}  moveToward: ${decode(status(baseSteer.moveToward))}  clearPath: ${decode(status(baseSteer.clearPath))}`,
      `NEW ${(tN / 600).toFixed(2)} ms/tick (${ns.state.agents.length} agents) vs BASE ${(tB / 600).toFixed(2)} ms/tick (${bs.state.agents.length} agents)`,
      `think source length: NEW ${newBrain.think.toString().length} chars, BASE ${baseBrain.think.toString().length} chars`,
    ];
    console.log('[perf-opt]\n' + lines.join('\n'));
    expect(lines.length).toBe(4);
  }, 600_000);
});
