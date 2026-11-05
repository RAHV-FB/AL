// OWNER: Simulation Core agent. STUB — replace with real procedural generation.
import type { Rng } from './rng';
import { TERRAIN, type SimConfig, type WorldGenOptions, type WorldState } from './types';

export function createEmptyWorld(width: number, height: number, tileSize: number): WorldState {
  const n = width * height;
  return {
    width,
    height,
    tileSize,
    terrain: new Uint8Array(n).fill(TERRAIN.Grass),
    food: new Float32Array(n),
    fertility: new Float32Array(n).fill(1),
    baseFertility: new Float32Array(n).fill(1),
    elevation: new Float32Array(n).fill(0.5),
    climateMod: new Float32Array(n).fill(1),
    territory: new Int16Array(n).fill(-1),
    terrainVersion: 0,
  };
}

/** Generate a world deterministically from `rng` (a dedicated world RNG). */
export function generateWorld(config: SimConfig, rng: Rng, opts: WorldGenOptions): WorldState {
  void rng;
  const w = createEmptyWorld(config.worldWidth, config.worldHeight, config.tileSize);
  const init = opts.initialFood ?? 0.7;
  for (let i = 0; i < w.food.length; i++) w.food[i] = 10 * init;
  return w;
}
