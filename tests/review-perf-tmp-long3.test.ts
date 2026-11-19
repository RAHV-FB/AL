// TEMPORARY review experiment (performance lens) — deleted after the review.
// Natural preset runs (default population, seed 42): NEW (working tree, uninstrumented) vs INST (instrumented
// copy) vs STUB (routing disabled) vs BASE (HEAD), interleaved in 100-tick chunks.
import { describe, expect, it } from 'vitest';
import { Simulation as NewSim } from '../src/sim/simulation';
import { SCENARIOS as NEW_SC } from '../src/sim/presets';
import { Simulation as InstSim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/simulation';
import { SCENARIOS as INST_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/presets';
import { Simulation as StubSim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/stub/src/sim/simulation';
import { SCENARIOS as STUB_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/stub/src/sim/presets';
import { Simulation as BaseSim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/simulation';
import { SCENARIOS as BASE_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/presets';

type AnySim = { step(): void; state: { agents: { action: string; alive: boolean; vx: number; vy: number }[]; tick: number } };
const DAYS = Number(process.env.L3_DAYS ?? 8);
const ONLY = (process.env.L3_ONLY ?? 'two-civs,plague-island,predators').split(',');
const ARMS = (process.env.L3_ARMS ?? 'NEW,INST,STUB,BASE').split(',');

describe('review perf: natural runs, 4 arms', () => {
  it('ms/tick per arm, interleaved', () => {
    const out: string[] = [];
    for (let p = 0; p < NEW_SC.length; p++) {
      const id = NEW_SC[p].id;
      if (!ONLY.includes(id)) continue;
      const all = [
        { name: 'NEW', sim: NewSim.create({ scenario: NEW_SC[p], seed: 42 }) as unknown as AnySim },
        { name: 'INST', sim: InstSim.create({ scenario: INST_SC[p], seed: 42 }) as unknown as AnySim },
        { name: 'STUB', sim: StubSim.create({ scenario: STUB_SC[p], seed: 42 }) as unknown as AnySim },
        { name: 'BASE', sim: BaseSim.create({ scenario: BASE_SC[p], seed: 42 }) as unknown as AnySim },
      ].filter((a) => ARMS.includes(a.name));
      const arms = all.map((a) => ({ ...a, ms: 0, ticks: 0, agentTicks: 0, moving: 0, actions: {} as Record<string, number>, dayMs: [] as number[] }));
      const ticks = DAYS * 600;
      for (let done = 0; done < ticks; done += 100) {
        for (const a of arms) {
          let ms = 0;
          for (let k = 0; k < 100; k++) {
            const t0 = performance.now();
            a.sim.step();
            ms += performance.now() - t0;
            a.agentTicks += a.sim.state.agents.length;
          }
          a.ms += ms;
          a.ticks += 100;
          if ((done + 100) % 600 === 0) a.dayMs.push(a.ms);
          for (const ag of a.sim.state.agents) {
            a.actions[ag.action] = (a.actions[ag.action] ?? 0) + 1;
            if (ag.vx !== 0 || ag.vy !== 0) a.moving++;
          }
        }
      }
      const base = arms.find((a) => a.name === 'BASE');
      for (const a of arms) {
        const perDay = a.dayMs.map((v, i) => ((v - (i ? a.dayMs[i - 1] : 0)) / 600).toFixed(2)).join(' ');
        const samples = Object.values(a.actions).reduce((x, y) => x + y, 0);
        const acts = Object.entries(a.actions)
          .sort((x, y) => y[1] - x[1])
          .map(([k, v]) => `${k} ${((100 * v) / samples).toFixed(0)}%`)
          .join(', ');
        out.push(
          `${id.padEnd(14)} ${a.name.padEnd(4)} mean ${(a.ms / a.ticks).toFixed(2)} ms/tick (×BASE ${base ? (a.ms / base.ms).toFixed(3) : '-'}), ${(a.ms * 1000 / a.agentTicks).toFixed(2)} µs/agent-tick, mean agents ${(a.agentTicks / a.ticks).toFixed(0)}, end ${a.sim.state.agents.length}; moving ${((100 * a.moving) / samples).toFixed(0)}% | per day: ${perDay}\n      actions: ${acts}`,
        );
      }
      console.log(out.slice(-arms.length).join('\n'));
    }
    console.log('[perf-long3]\n' + out.join('\n'));
    expect(out.length).toBeGreaterThan(0);
  }, 3_000_000);
});
