/**
 * State invariants (QA-owned). See scripts/qa-helpers.ts → checkInvariants for the full list:
 *  - every agent number finite; 0 ≤ health ≤ maxHealth; 0 ≤ food ≤ maxFood; energy ∈ [0,1]; carried ≥ 0
 *  - genes ∈ [0,1]; positions inside the world and on passable tiles
 *  - unique agent ids; agentById/tribeById/lineageById consistent with the state arrays
 *  - tribeId references an existing, non-extinct tribe
 *  - relationships: no self/duplicates, affinity ∈ [-1,1]; links to dead agents must be pruned within
 *    one in-game day (+ check interval). Tolerant on purpose: social pruning is periodic.
 *  - world.food ≥ 0 & finite; fertility ∈ [0,1.2]; tribe stockpile ≥ 0
 *  - population ≤ config.maxAgents; events/lineage/samples/tribes/logs within LIMITS
 * Checks run between ticks (after the births/deaths flush), every CHECK_EVERY ticks.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { checkInvariants, envInt, interventionPlan, enqueueDue, trackAlive, type PlannedIntervention } from '../scripts/qa-helpers';

const TICKS = envInt('AL_INVARIANT_TICKS', 3000);
const CHECK_EVERY = 25;
const SEED = 20251105;

function runChecked(sim: Simulation, ticks: number, plan: PlannedIntervention[] = []): { violations: string[]; summary: string } {
  const lastSeenAlive = new Map<number, number>();
  const violations: string[] = [];
  let lastTerrainEditTick: number | undefined;
  const t0 = performance.now();

  trackAlive(sim, lastSeenAlive);
  violations.push(...checkInvariants(sim, { lastSeenAlive, checkInterval: CHECK_EVERY }));
  let peak = sim.state.agents.length;
  for (let i = 0; i < ticks && violations.length < 25; i++) {
    for (const p of plan) {
      if (p.tick === sim.tick) {
        const iv = p.make(sim);
        if (iv?.kind === 'paintTerrain') lastTerrainEditTick = sim.tick;
      }
    }
    enqueueDue(sim, plan);
    sim.step();
    peak = Math.max(peak, sim.state.agents.length);
    if (sim.tick <= 5 || sim.tick % CHECK_EVERY === 0) {
      trackAlive(sim, lastSeenAlive);
      violations.push(...checkInvariants(sim, { lastSeenAlive, checkInterval: CHECK_EVERY, lastTerrainEditTick }));
    }
  }
  const s = sim.state;
  const ms = (performance.now() - t0) / Math.max(1, sim.tick);
  const living = s.tribes.filter((t) => t.extinctTick === -1).length;
  const summary =
    `${s.scenarioId.padEnd(14)} tick ${String(sim.tick).padStart(5)}  pop ${String(s.agents.length).padStart(4)} (peak ${peak})` +
    `  births ${s.stats.totals.births}  deaths ${s.stats.totals.deaths}  tribes ${living}  events ${s.events.length}` +
    `  ${ms.toFixed(2)} ms/tick`;
  return { violations, summary };
}

describe('invariants', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.id}: ${TICKS} ticks keep every state invariant`, () => {
      const sim = Simulation.create({ scenario: sc, seed: SEED });
      const { violations, summary } = runChecked(sim, TICKS);
      console.log(`[invariants] ${summary}`);
      expect(violations.length, `\n${violations.join('\n')}\n`).toBe(0);
    }, 600_000);
  }

  it('intervention barrage (every kind + edge cases) keeps every state invariant', () => {
    const sim = Simulation.create({ scenario: SCENARIOS[0], seed: SEED + 1 });
    const plan = interventionPlan(sim, { edgeCases: true });
    const { violations, summary } = runChecked(sim, Math.min(TICKS, 1500), plan);
    console.log(`[invariants] barrage: ${summary}`);
    expect(violations.length, `\n${violations.join('\n')}\n`).toBe(0);
    expect(sim.state.agents.length).toBeLessThanOrEqual(sim.config.maxAgents);
  }, 600_000);
});
