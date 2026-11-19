// TEMPORARY review experiment (performance lens) — deleted after the review.
// Is NEW's higher per-agent cost a density effect (more neighbours in perception range)?
import { describe, expect, it } from 'vitest';
import { Simulation as NewSim } from '../src/sim/simulation';
import { SCENARIOS as NEW_SC } from '../src/sim/presets';
import { Simulation as BaseSim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/simulation';
import { SCENARIOS as BASE_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/presets';

type Ag = { x: number; y: number; alive: boolean; traits: { perception: number } };
type AnySim = { step(): void; state: { agents: Ag[] } };

function neighbours(agents: Ag[]): { meanInView: number; meanWithin40: number } {
  let inView = 0;
  let near = 0;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const r = a.traits.perception;
    for (let j = 0; j < agents.length; j++) {
      if (i === j) continue;
      const dx = agents[j].x - a.x;
      const dy = agents[j].y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < r * r) inView++;
      if (d2 < 40 * 40) near++;
    }
  }
  return { meanInView: inView / Math.max(1, agents.length), meanWithin40: near / Math.max(1, agents.length) };
}

describe('review perf: density', () => {
  it('neighbours in view, NEW vs BASE', () => {
    const out: string[] = [];
    for (const id of (process.env.DEN_ONLY ?? 'predators,two-civs').split(',')) {
      const p = NEW_SC.findIndex((s) => s.id === id);
      const arms = [
        { name: 'NEW', sim: NewSim.create({ scenario: NEW_SC[p], seed: 42 }) as unknown as AnySim, ms: 0, agentTicks: 0, view: 0, near: 0, n: 0 },
        { name: 'BASE', sim: BaseSim.create({ scenario: BASE_SC[p], seed: 42 }) as unknown as AnySim, ms: 0, agentTicks: 0, view: 0, near: 0, n: 0 },
      ];
      for (let done = 0; done < 4800; done += 100) {
        for (const a of arms) {
          const t0 = performance.now();
          for (let k = 0; k < 100; k++) a.sim.step();
          a.ms += performance.now() - t0;
          a.agentTicks += 100 * a.sim.state.agents.length;
          if (done >= 2400 && done % 200 === 0) {
            const nb = neighbours(a.sim.state.agents);
            a.view += nb.meanInView;
            a.near += nb.meanWithin40;
            a.n++;
          }
        }
      }
      for (const a of arms)
        out.push(`${id.padEnd(10)} ${a.name.padEnd(4)} ${((1000 * a.ms) / a.agentTicks).toFixed(2)} µs/agent-tick; days 5-8 mean neighbours in perception range ${(a.view / a.n).toFixed(1)}, within 40 u ${(a.near / a.n).toFixed(1)}; end agents ${a.sim.state.agents.length}`);
    }
    console.log('[perf-density]\n' + out.join('\n'));
    expect(out.length).toBeGreaterThan(0);
  }, 900_000);
});
