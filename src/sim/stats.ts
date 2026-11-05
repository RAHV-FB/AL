// OWNER: Analytics agent. STUB — replace with the real implementation.
import type { Simulation } from './simulation';
import type { StatsState } from './types';

export function createStatsState(): StatsState {
  return {
    sampleInterval: 30,
    samples: [],
    counters: { births: 0, deaths: 0, deathsByCause: { starvation: 0, old_age: 0, combat: 0, disease: 0, disaster: 0, removed: 0 }, fights: 0, shares: 0 },
    totals: { births: 0, deaths: 0, peakPopulation: 0, peakTick: 0 },
  };
}

/** Called once per tick; takes a StatsSample every sampleInterval ticks and resets counters. */
export function updateStats(sim: Simulation): void {
  void sim;
}
