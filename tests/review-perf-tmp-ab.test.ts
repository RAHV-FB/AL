// TEMPORARY review experiment (performance lens) — deleted after the review.
// A/B/C timing of ~1000-agent presets: NEW (working tree), STUB (working tree with routing disabled:
// sameRegion → false, planRoute → unreachable), BASE (HEAD, pre-feature). Interleaved in chunks so CPU
// contention from parallel jobs hits all three alike.
import { describe, expect, it } from 'vitest';
import { Simulation as NewSim } from '../src/sim/simulation';
import { SCENARIOS as NEW_SC } from '../src/sim/presets';
import { Simulation as StubSim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/stub/src/sim/simulation';
import { SCENARIOS as STUB_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/stub/src/sim/presets';
import { Simulation as BaseSim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/simulation';
import { SCENARIOS as BASE_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/presets';
import { Simulation as Fix1Sim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/fix1/src/sim/simulation';
import { SCENARIOS as FIX1_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/fix1/src/sim/presets';

type AnySim = { step(): void; state: { agents: { alive: boolean; route?: { pts: number[]; fail?: boolean } }[]; tick: number }; worldW: number; worldH: number; enqueue(iv: unknown): void; config: { maxAgents: number } };

const TARGET = 1000;
const WARM = Number(process.env.AB_WARM ?? 60);
const ARMS = (process.env.AB_ARMS ?? 'NEW,STUB,BASE').split(',');
const ROUNDS = Number(process.env.AB_ROUNDS ?? 6);
const CHUNK = Number(process.env.AB_CHUNK ?? 50);
const ONLY = process.env.AB_ONLY ? process.env.AB_ONLY.split(',') : null;

function fill(sim: AnySim): void {
  const W = sim.worldW;
  const H = sim.worldH;
  const spots: [number, number][] = [];
  for (let gy = 1; gy <= 3; gy++) for (let gx = 1; gx <= 4; gx++) spots.push([(W * gx) / 5, (H * gy) / 4]);
  for (let round = 0; round < 8 && sim.state.agents.length < TARGET * 0.95; round++) {
    const need = TARGET - sim.state.agents.length;
    spots.forEach(([x, y], i) => {
      sim.enqueue({ kind: 'spawn', x, y, count: Math.ceil(need / spots.length), radius: 110, tribe: i % 2 === 0 && round === 0 ? 'new' : 'none' });
    });
    sim.step();
  }
}

function stats(times: number[]) {
  const s = [...times].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { mean: times.reduce((a, b) => a + b, 0) / times.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}

describe('review perf A/B/C', () => {
  it('~1000 agents per preset: NEW vs STUB vs BASE (ms/tick)', () => {
    const rows: string[] = [];
    for (let p = 0; p < NEW_SC.length; p++) {
      const id = NEW_SC[p].id;
      if (ONLY && !ONLY.includes(id)) continue;
      const mk: [string, () => AnySim][] = [
        ['NEW', () => NewSim.create({ scenario: NEW_SC[p], seed: 31337, config: { maxAgents: TARGET } }) as unknown as AnySim],
        ['STUB', () => StubSim.create({ scenario: STUB_SC[p], seed: 31337, config: { maxAgents: TARGET } }) as unknown as AnySim],
        ['FIX1', () => Fix1Sim.create({ scenario: FIX1_SC[p], seed: 31337, config: { maxAgents: TARGET } }) as unknown as AnySim],
        ['BASE', () => BaseSim.create({ scenario: BASE_SC[p], seed: 31337, config: { maxAgents: TARGET } }) as unknown as AnySim],
      ].filter(([n]) => ARMS.includes(n as string)) as [string, () => AnySim][];
      const sims = mk.map(([name, f]) => {
        const sim = f();
        fill(sim);
        return { name, sim, times: [] as number[], pop0: sim.state.agents.length, worst: 0, worstTick: -1 };
      });
      for (const s of sims) for (let k = 0; k < WARM; k++) s.sim.step();
      for (let r = 0; r < ROUNDS; r++) {
        for (const s of sims) {
          for (let k = 0; k < CHUNK; k++) {
            const t0 = performance.now();
            s.sim.step();
            const dt = performance.now() - t0;
            s.times.push(dt);
            if (dt > s.worst) {
              s.worst = dt;
              s.worstTick = s.sim.state.tick - 1;
            }
          }
        }
      }
      const base = stats(sims[sims.length - 1].times).mean;
      for (const s of sims) {
        const st = stats(s.times);
        let routed = 0;
        let fail = 0;
        let pts = 0;
        for (const a of s.sim.state.agents) {
          if (!a.route) continue;
          if (a.route.fail) fail++;
          else if (a.route.pts.length) routed++;
          pts += a.route.pts.length;
        }
        rows.push(
          `${id.padEnd(14)} ${s.name.padEnd(4)} agents ${s.pop0}→${s.sim.state.agents.length}  mean ${st.mean.toFixed(2)}  p50 ${st.p50.toFixed(2)}  p95 ${st.p95.toFixed(2)}  max ${st.max.toFixed(2)} (tick ${s.worstTick})  ×BASE ${(st.mean / base).toFixed(3)}` +
            (s.name !== 'BASE' ? `  | end: routed ${routed}, fail ${fail}, pts ${pts}` : ''),
        );
      }
      console.log(rows.slice(-sims.length).join('\n'));
    }
    console.log('[perf-ab]\n' + rows.join('\n'));
    expect(rows.length).toBeGreaterThan(0);
  }, 1_200_000);
});
