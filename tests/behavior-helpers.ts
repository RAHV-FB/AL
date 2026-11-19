/**
 * Helpers for the behavior-* regression tests (agent intelligence & social systems).
 * Small all-grass worlds, agents with exact genes, and brain-only ticking.
 */
import { Simulation } from '../src/sim/simulation';
import { act, think } from '../src/sim/brain';
import { createAgent } from '../src/sim/lifecycle';
import { randomGenes } from '../src/sim/genetics';
import { TERRAIN, type Agent, type GenomeTemplate, type ScenarioDef, type SimConfig, type TerrainType } from '../src/sim/types';

/** All-grass world (no water, no disasters), `w`×`h` tiles of 8 units. */
export function makeSim(seed = 1, w = 80, h = 50, config: Partial<SimConfig> = {}): Simulation {
  const scenario: ScenarioDef = {
    id: 'behavior-test',
    name: 'Behavior test',
    tagline: '',
    description: '',
    lookFor: [],
    config: { worldWidth: w, worldHeight: h, tileSize: 8, disasterRate: 0, maxAgents: 400, ...config },
    world: { island: false, waterLevel: 0, mountainLevel: 0, desertLevel: 0, divide: 'none', initialFood: 0.8 },
    populations: [],
    scheduled: [],
  };
  const sim = Simulation.create({ scenario, seed });
  sim.state.world.terrain.fill(TERRAIN.Grass);
  sim.state.world.terrainVersion++;
  sim.state.env.daylight = 1;
  return sim;
}

/** Average genome; tests override what they care about. */
export const BASE: GenomeTemplate = {
  speed: 0.5, size: 0.5, perception: 0.5, metabolism: 0.5, aggression: 0.3, sociability: 0.5,
  altruism: 0.5, fertility: 0.5, longevity: 0.5, immunity: 0.5, efficiency: 0.5, hue: 0.5, spread: 0,
};

/** Adult (age 1500) with exactly the given gene values, registered immediately. */
export function spawn(sim: Simulation, x: number, y: number, genes: GenomeTemplate = {}, age = 1500): Agent {
  const a = createAgent(sim, { x, y, genes: randomGenes(sim.rng, { ...BASE, ...genes, spread: 0 }), age });
  sim.addAgent(a);
  return a;
}

export function setHunger(a: Agent, hunger: number): void {
  a.food = a.traits.maxFood * (1 - hunger);
}

/** Brain-only ticks (think/act with the orchestrator's cooldown rule; no metabolism / social pass). */
export function brainTicks(sim: Simulation, agents: Agent[], n: number, until?: () => boolean): void {
  for (let t = 0; t < n; t++) {
    sim.spatial.rebuild(sim.state.agents);
    for (const a of agents) {
      if (!a.alive) continue;
      if (a.decisionCooldown <= 0) think(sim, a);
      else a.decisionCooldown--;
      if (a.alive) act(sim, a);
    }
    sim.state.tick++;
    if (until && until()) return;
  }
}

/** One fresh decision for `a` (spatial index rebuilt first). */
export function decide(sim: Simulation, a: Agent): void {
  sim.spatial.rebuild(sim.state.agents);
  think(sim, a);
}

/** Paint the tile rectangle [tx0..tx1]×[ty0..ty1] with `terrain`. */
export function paintTiles(sim: Simulation, tx0: number, ty0: number, tx1: number, ty1: number, terrain: TerrainType): void {
  const w = sim.state.world;
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) w.terrain[ty * w.width + tx] = terrain;
  w.terrainVersion++;
}

/** Mark every tile within `radius` world units of (x,y) as owned by `tribeId` (what social's territory pass would do). */
export function claimLand(sim: Simulation, x: number, y: number, radius: number, tribeId: number): void {
  const w = sim.state.world;
  for (let ty = 0; ty < w.height; ty++) {
    for (let tx = 0; tx < w.width; tx++) {
      const dx = (tx + 0.5) * w.tileSize - x;
      const dy = (ty + 0.5) * w.tileSize - y;
      if (dx * dx + dy * dy <= radius * radius) w.territory[ty * w.width + tx] = tribeId;
    }
  }
}
