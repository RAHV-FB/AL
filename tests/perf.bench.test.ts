/**
 * Performance benchmark (QA-owned). Run alone for clean numbers:  npm run bench
 *
 * Fills the first scenario to ~1000 agents through ordinary `spawn` interventions
 * (half founding new tribes, half unaffiliated), warms up, then times 500 ticks of
 * sim.step() (simulation only — no rendering). Prints mean/p50/p95/max ms per tick.
 * The assertion is deliberately generous (AL_PERF_BUDGET_MS, default 25 ms/tick):
 * at 60 fps the UI needs ~16 ms for everything, so the real target is far lower.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { envInt } from '../scripts/qa-helpers';

const BUDGET_MS = envInt('AL_PERF_BUDGET_MS', 25);
const TARGET = 1000;
const TICKS = 500;

function timeTicks(sim: Simulation, n: number): { mean: number; p50: number; p95: number; max: number; times: number[] } {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    sim.step();
    times.push(performance.now() - t0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { mean: times.reduce((a, b) => a + b, 0) / n, p50: q(0.5), p95: q(0.95), max: sorted[sorted.length - 1], times };
}

describe('performance', () => {
  it(`~${TARGET} agents: mean ms/tick over ${TICKS} ticks < ${BUDGET_MS} ms`, () => {
    const sc = SCENARIOS[0];
    const sim = Simulation.create({ scenario: sc, seed: 31337, config: { maxAgents: TARGET } });
    const W = sim.worldW;
    const H = sim.worldH;
    const spots: [number, number][] = [];
    for (let gy = 1; gy <= 3; gy++) for (let gx = 1; gx <= 4; gx++) spots.push([(W * gx) / 5, (H * gy) / 4]);

    // Fill to ~TARGET with spawn interventions (spawns skip impassable points, so retry a few rounds).
    for (let round = 0; round < 8 && sim.state.agents.length < TARGET * 0.95; round++) {
      const need = TARGET - sim.state.agents.length;
      spots.forEach(([x, y], i) => {
        sim.enqueue({ kind: 'spawn', x, y, count: Math.ceil(need / spots.length), radius: 110, tribe: i % 2 === 0 && round === 0 ? 'new' : 'none' });
      });
      sim.step();
    }
    const popStart = sim.state.agents.length;
    timeTicks(sim, 30); // warm-up (JIT)
    const r = timeTicks(sim, TICKS);
    const popEnd = sim.state.agents.length;

    // Reference: the scenario's own starting population.
    const base = Simulation.create({ scenario: sc, seed: 31337 });
    timeTicks(base, 30);
    const rb = timeTicks(base, TICKS);

    console.log(
      `[perf] ${sc.id}, ${popStart}→${popEnd} agents (cap ${sim.config.maxAgents}), ${TICKS} ticks: ` +
        `mean ${r.mean.toFixed(2)} ms  p50 ${r.p50.toFixed(2)}  p95 ${r.p95.toFixed(2)}  max ${r.max.toFixed(2)} ms/tick` +
        `  (≈ ${(1000 / r.mean).toFixed(0)} ticks/s)\n` +
        `[perf] ${sc.id}, default population ${base.state.agents.length} at end: ` +
        `mean ${rb.mean.toFixed(2)} ms  p95 ${rb.p95.toFixed(2)} ms/tick`,
    );

    expect(popStart).toBeGreaterThanOrEqual(Math.min(TARGET * 0.9, sim.config.maxAgents * 0.9));
    expect(r.mean).toBeLessThan(BUDGET_MS);
  }, 600_000);
});
