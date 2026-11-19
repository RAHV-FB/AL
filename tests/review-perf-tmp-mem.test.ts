// TEMPORARY review experiment (performance lens) — deleted after the review.
// Memory and save-size cost of routes/treks; nav-cache footprint; hash() cost.
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { regionAt } from '../src/sim/pathfinding';
import { serializeSim } from '../src/sim/persistence';

function fill(sim: Simulation, target = 1000): void {
  const W = sim.worldW;
  const H = sim.worldH;
  const spots: [number, number][] = [];
  for (let gy = 1; gy <= 3; gy++) for (let gx = 1; gx <= 4; gx++) spots.push([(W * gx) / 5, (H * gy) / 4]);
  for (let round = 0; round < 8 && sim.state.agents.length < target * 0.95; round++) {
    const need = target - sim.state.agents.length;
    spots.forEach(([x, y], i) => {
      sim.enqueue({ kind: 'spawn', x, y, count: Math.ceil(need / spots.length), radius: 110, tribe: i % 2 === 0 && round === 0 ? 'new' : 'none' });
    });
    sim.step();
  }
}

describe('review perf: memory and save size', () => {
  it('nav cache footprint (typed arrays) for a 200x125 world', () => {
    const sim = Simulation.create({ scenario: SCENARIOS[0], seed: 1 });
    // typed arrays are allocated outside the V8 heap → arrayBuffers grows
    const before = process.memoryUsage().arrayBuffers;
    regionAt(sim, 10, 10);
    const after = process.memoryUsage().arrayBuffers;
    console.log(`[perf-mem] nav cache arrayBuffers +${((after - before) / 1024).toFixed(0)} KiB (expected 7×25000×4 + 2×112016×4 = ${((7 * 25000 * 4 + 2 * 112016 * 4) / 1024).toFixed(0)} KiB)`);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('routes in saves and hash() after a stressed run (~1000 agents, 3000 ticks)', () => {
    const lines: string[] = [];
    for (const id of ['two-civs', 'plague-island', 'collapse']) {
      const sc = SCENARIOS.find((s) => s.id === id)!;
      const sim = Simulation.create({ scenario: sc, seed: 31337, config: { maxAgents: 1000 } });
      fill(sim);
      let maxRouted = 0;
      let maxPts = 0;
      let maxObjs = 0;
      let maxTreks = 0;
      let bestJson = '';
      for (let t = 0; t < 3000; t++) {
        sim.step();
        if (t % 50 === 0) {
          let routed = 0;
          let pts = 0;
          let objs = 0;
          let treks = 0;
          for (const a of sim.state.agents) {
            if (a.trek) treks++;
            if (!a.route) continue;
            objs++;
            if (a.route.pts.length) routed++;
            pts += a.route.pts.length;
          }
          maxTreks = Math.max(maxTreks, treks);
          maxObjs = Math.max(maxObjs, objs);
          if (pts > maxPts) {
            maxPts = pts;
            maxRouted = routed;
            bestJson = serializeSim(sim);
          }
        }
      }
      const json = bestJson || serializeSim(sim);
      const parsed = JSON.parse(json);
      const agents = (parsed.state ?? parsed).agents as { route?: unknown; trek?: unknown }[];
      let routeChars = 0;
      let trekChars = 0;
      for (const a of agents) {
        if (a.route) routeChars += JSON.stringify(a.route).length + 9;
        if (a.trek) trekChars += JSON.stringify(a.trek).length + 8;
      }
      const t0 = performance.now();
      for (let k = 0; k < 20; k++) sim.hash();
      const hashMs = (performance.now() - t0) / 20;
      lines.push(
        `${id}: max route objects ${maxObjs}, at peak ${maxRouted} on waypoint routes with ${maxPts} numbers (≈${((maxPts * 8) / 1024).toFixed(1)} KiB of doubles), max treks ${maxTreks}; ` +
          `save ${(json.length / 1024).toFixed(0)} KiB of which routes ${(routeChars / 1024).toFixed(1)} KiB, treks ${(trekChars / 1024).toFixed(1)} KiB; hash() ${hashMs.toFixed(2)} ms`,
      );
    }
    console.log('[perf-mem]\n' + lines.join('\n'));
  }, 900_000);
});
