/**
 * Long-run stability (QA-owned): 20k ticks (≈ 33 in-game days at the default dayLength)
 * on two scenarios.
 *  - population stays within [0, config.maxAgents]
 *  - every state array stays bounded (deterministic footprint check against LIMITS)
 *  - retained heap does not keep growing (min-of-window heapUsed, tolerant to GC timing)
 *  - full invariant check every 2000 ticks
 * Override the length with AL_LONGRUN_TICKS=5000 for a quicker local run.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { LIMITS } from '../src/sim/constants';
import { checkInvariants, envInt, footprint, heapUsedMB, trackAlive } from '../scripts/qa-helpers';

const TICKS = envInt('AL_LONGRUN_TICKS', 20_000);
/** Allowed growth of retained heap between the early window and the end of the run. */
const HEAP_GROWTH_MB = envInt('AL_LONGRUN_HEAP_MB', 150);

const picks = SCENARIOS.length >= 2 ? [SCENARIOS[0], SCENARIOS[SCENARIOS.length - 1]] : [SCENARIOS[0], SCENARIOS[0]];

describe('long run', () => {
  picks.forEach((sc, idx) => {
    const seed = 777 + idx;
    it(`${sc.id} (seed ${seed}): ${TICKS} ticks stay bounded`, () => {
      const sim = Simulation.create({ scenario: sc, seed });
      const maxAgents = () => sim.config.maxAgents;
      const heap: { tick: number; mb: number }[] = [];
      const popTrace: string[] = [];
      const lastSeenAlive = new Map<number, number>();
      const violations: string[] = [];
      let maxFootprint = 0;
      const t0 = performance.now();

      while (sim.tick < TICKS) {
        sim.step();
        const pop = sim.state.agents.length;
        if (pop < 0 || pop > maxAgents()) violations.push(`[tick ${sim.tick}] population ${pop} outside [0, ${maxAgents()}]`);
        if (sim.tick % 500 === 0) {
          const f = footprint(sim);
          maxFootprint = Math.max(maxFootprint, f.total);
          if (f.events > LIMITS.events || f.lineage > LIMITS.lineage || f.samples > LIMITS.statSamples ||
            f.interventionLog > LIMITS.interventionLog || f.disasters > 256 || f.scheduled > 1000 ||
            f.maxPerAgent > Math.max(LIMITS.relationships, LIMITS.children, LIMITS.history, LIMITS.foodMemory + LIMITS.dangerMemory))
            violations.push(`[tick ${sim.tick}] state arrays exceed limits: ${JSON.stringify(f)}`);
          const mb = heapUsedMB();
          if (mb !== null) heap.push({ tick: sim.tick, mb });
        }
        if (sim.tick % 1000 === 0) {
          popTrace.push(`${sim.tick / 1000}k:${pop}`);
          trackAlive(sim, lastSeenAlive);
          violations.push(...checkInvariants(sim, { lastSeenAlive, checkInterval: 1000, maxViolations: 5 }));
        }
        if (violations.length >= 20) break;
      }

      const secs = (performance.now() - t0) / 1000;
      const f = footprint(sim);
      // Retained-heap estimate: minimum over a window (GC may run at any time; the min approximates live data).
      const minIn = (lo: number, hi: number) => {
        const xs = heap.filter((h) => h.tick >= lo && h.tick <= hi).map((h) => h.mb);
        return xs.length ? Math.min(...xs) : NaN;
      };
      const early = minIn(TICKS * 0.1, TICKS * 0.3);
      const late = minIn(TICKS * 0.8, TICKS);
      console.log(
        `[longrun] ${sc.id} seed ${seed}: ${sim.tick} ticks in ${secs.toFixed(1)}s (${((secs * 1000) / Math.max(1, sim.tick)).toFixed(2)} ms/tick)\n` +
          `  population trace: ${popTrace.join(' ')}\n` +
          `  totals: births ${sim.state.stats.totals.births} deaths ${sim.state.stats.totals.deaths} peak ${sim.state.stats.totals.peakPopulation}\n` +
          `  footprint at end: ${JSON.stringify(f)} (max total seen ${maxFootprint})\n` +
          `  heapUsed (min-of-window): early ${early.toFixed(1)} MB → late ${late.toFixed(1)} MB` +
          (sim.state.agents.length === 0 ? '\n  NOTE: population went extinct (allowed, but worth a balance look)' : ''),
      );

      expect(violations.length, `\n${violations.join('\n')}\n`).toBe(0);
      expect(sim.tick).toBe(TICKS);
      if (Number.isFinite(early) && Number.isFinite(late)) {
        expect(late - early, `retained heap grew ${(late - early).toFixed(1)} MB over the run`).toBeLessThan(HEAP_GROWTH_MB);
      }
    }, 1_800_000);
  });
});
