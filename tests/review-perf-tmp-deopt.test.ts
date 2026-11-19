// TEMPORARY review experiment (performance lens) — deleted after the review.
// Count V8 deoptimisations (run with --execArgv=--trace-deopt) for one arm: NEW or FIX1.
import { describe, expect, it } from 'vitest';
import { Simulation as NewSim } from '../src/sim/simulation';
import { SCENARIOS as NEW_SC } from '../src/sim/presets';
import { Simulation as Fix1Sim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/fix1/src/sim/simulation';
import { SCENARIOS as FIX1_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/fix1/src/sim/presets';

describe('review perf: deopts', () => {
  it('one arm', () => {
    const arm = process.env.DE_ARM ?? 'NEW';
    const id = process.env.DE_PRESET ?? 'two-civs';
    const p = NEW_SC.findIndex((s) => s.id === id);
    const sim = (arm === 'NEW' ? NewSim.create({ scenario: NEW_SC[p], seed: 42 }) : Fix1Sim.create({ scenario: FIX1_SC[p], seed: 42 })) as unknown as { step(): void; state: { agents: unknown[] } };
    const times: number[] = [];
    for (let k = 0; k < 4800; k++) {
      const t0 = performance.now();
      sim.step();
      times.push(performance.now() - t0);
    }
    const s = [...times].sort((a, b) => a - b);
    process.stdout.write(`\n[perf-deopt] ${arm} ${id}: mean ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)} ms/tick, p95 ${s[Math.floor(0.95 * s.length)].toFixed(2)}, max ${s[s.length - 1].toFixed(2)}, agents ${sim.state.agents.length}\n`);
    expect(times.length).toBe(4800);
  }, 900_000);
});
