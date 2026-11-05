// OWNER: Ecology agent. STUB — replace with the real implementation.
import type { Simulation } from './simulation';
import type { EnvState, SimConfig } from './types';

/** Initial environment state for a new simulation. */
export function initEnvironment(config: SimConfig): EnvState {
  void config;
  return { timeOfDay: 0.3, daylight: 1, day: 0, season: 0, seasonProgress: 0, year: 0, temperature: 15, tempOffset: 0, seasonGrowth: 1 };
}

/** Advance clock: time of day, daylight, season, temperature, seasonGrowth. */
export function updateEnvironment(sim: Simulation): void {
  void sim;
}

/** Plant regrowth + fertility recovery (may be staggered across ticks). */
export function updateResources(sim: Simulation): void {
  void sim;
}

/** Max food a tile can currently hold (terrain × fertility × config.foodCapacity). */
export function tileCapacity(sim: Simulation, idx: number): number {
  void sim; void idx;
  return 10;
}

/** Food at a world position (0 outside map). */
export function foodAt(sim: Simulation, x: number, y: number): number {
  const i = sim.tileIndex(x, y);
  return i < 0 ? 0 : sim.state.world.food[i];
}

/**
 * Remove up to `amount` food from the tile at (x,y). Returns the amount actually
 * removed (never negative, never more than present). Handles overgrazing effects.
 */
export function consumeFood(sim: Simulation, x: number, y: number, amount: number): number {
  const i = sim.tileIndex(x, y);
  if (i < 0 || amount <= 0) return 0;
  const f = sim.state.world.food;
  const take = Math.min(f[i], amount);
  f[i] -= take;
  return take;
}

export interface FoodSpot { x: number; y: number; food: number; }

/**
 * Best food tile visible from (x,y) within `radius` (world units), scoring food
 * amount against distance. Returns world-centre coords of the tile, or null.
 */
export function findFood(sim: Simulation, x: number, y: number, radius: number): FoodSpot | null {
  void sim; void x; void y; void radius;
  return null;
}
