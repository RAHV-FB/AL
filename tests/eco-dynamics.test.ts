/**
 * Regression tests (eco audit): the mechanisms that turn the old boom-and-crash dynamics into a
 * resource-limited, seasonally fluctuating quasi-equilibrium.
 *
 *  1. Grazing refuge (ecology.ROOT_RESERVE): land that is grazed bare keeps regrowing from its
 *     roots. Previously a bare tile regrew from seed rain alone (≈ 9 % of the tile's maximum
 *     sustainable yield in the middle of a grazed area), so a population that had grazed its land
 *     down lost its food supply exactly when it needed it most and crashed to near-extinction.
 *  2. Breeding needs a food-rich home range (genetics.REPRO.minRangeFood over ±rangeTiles) and good
 *     body condition (REPRO.minHealthFrac): births stop as a growing population grazes its land
 *     down, long before the stock is exhausted.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { DEFAULT_CONFIG } from '../src/sim/config';
import { ROOT_RESERVE, consumeFood, estimateCarryingCapacity, initEnvironment, localFoodFraction, tileCapacity, updateEnvironment, updateResources } from '../src/sim/ecology';
import { REPRO, canMate, isFertile, rangeFoodThreshold } from '../src/sim/genetics';
import { createAgent } from '../src/sim/lifecycle';
import { GENE_COUNT, TERRAIN, type Agent, type SimConfig, type SimState, type WorldState } from '../src/sim/types';

/** A bare Simulation (no agents) over a uniform grass world. */
function grassSim(config: Partial<SimConfig> = {}, w = 60, h = 40, fill = 1): Simulation {
  const cfg: SimConfig = { ...DEFAULT_CONFIG, worldWidth: w, worldHeight: h, disasterRate: 0, ...config };
  const n = w * h;
  const world: WorldState = {
    width: w,
    height: h,
    tileSize: cfg.tileSize,
    terrain: new Uint8Array(n).fill(TERRAIN.Grass),
    food: new Float32Array(n),
    fertility: new Float32Array(n).fill(1),
    baseFertility: new Float32Array(n).fill(1),
    elevation: new Float32Array(n).fill(0.5),
    climateMod: new Float32Array(n).fill(1),
    territory: new Int16Array(n).fill(-1),
    terrainVersion: 0,
  };
  const state: SimState = {
    version: 1,
    scenarioId: 'eco-dynamics',
    config: cfg,
    tick: 0,
    rngState: [1, 2, 3, 4],
    nextAgentId: 1,
    nextTribeId: 1,
    nextEventId: 1,
    nextDisasterId: 1,
    world,
    env: initEnvironment(cfg),
    agents: [],
    tribes: [],
    lineage: [],
    events: [],
    disasters: [],
    scheduled: [],
    interventionLog: [],
    stats: {
      sampleInterval: 30,
      samples: [],
      counters: { births: 0, deaths: 0, deathsByCause: { starvation: 0, old_age: 0, combat: 0, disease: 0, disaster: 0, removed: 0 }, fights: 0, shares: 0 },
      totals: { births: 0, deaths: 0, peakPopulation: 0, peakTick: 0 },
    },
  };
  const sim = Simulation.fromState(state);
  for (let i = 0; i < n; i++) world.food[i] = tileCapacity(sim, i) * fill;
  return sim;
}

function advance(sim: Simulation, ticks: number, each?: () => void): void {
  for (let k = 0; k < ticks; k++) {
    updateEnvironment(sim);
    updateResources(sim);
    each?.();
    sim.state.tick++;
  }
}

const centre = (sim: Simulation, tx: number, ty: number) => ({ x: (tx + 0.5) * sim.state.world.tileSize, y: (ty + 0.5) * sim.state.world.tileSize });

describe('grazing refuge (root reserve)', () => {
  it('a tile grazed bare in the middle of a grazed area still regrows at most of its peak rate', () => {
    const sim = grassSim({ seasons: false, overgrazing: false }, 40, 30, 0);
    const W = 40;
    const food = sim.state.world.food;
    const bare = 15 * W + 20; // bare block everywhere: no lush neighbours to seed from
    const half = 15 * W + 30;
    food[half] = tileCapacity(sim, half) / 2;
    for (const i of [half - 1, half + 1, half - W, half + W]) food[i] = tileCapacity(sim, i) / 2;
    advance(sim, 4); // every tile is updated exactly once per 4 ticks
    const fromBare = food[bare] / 4;
    const fromHalf = (food[half] - tileCapacity(sim, half) / 2) / 4;
    expect(ROOT_RESERVE).toBeGreaterThan(0);
    expect(fromHalf).toBeGreaterThan(0);
    // was ≈ 0.09 (seed rain only) — the collapse trap of heavily grazed land
    expect(fromBare / fromHalf).toBeGreaterThan(0.5);
  });

  it('land that is grazed bare over and over keeps yielding a large share of its sustainable maximum', () => {
    const sim = grassSim({ seasons: false, overgrazing: false }, 40, 30, 0.5);
    const W = 40;
    const patch: number[] = [];
    for (let y = 10; y < 20; y++) for (let x = 15; x < 25; x++) patch.push(y * W + x);
    let harvested = 0;
    const graze = () => {
      for (const i of patch) {
        const p = centre(sim, i % W, Math.floor(i / W));
        harvested += consumeFood(sim, p.x, p.y, 1e9);
      }
    };
    graze();
    harvested = 0;
    const ticks = 3000;
    advance(sim, ticks, () => {
      if (sim.state.tick % 100 === 0) graze();
    });
    // maximum sustainable yield of the patch per tick (what estimateCarryingCapacity assumes)
    const msyPerTick = (estimateCarryingCapacity(sim) * 0.09 * patch.length) / (40 * 30);
    expect(harvested / ticks).toBeGreaterThan(0.6 * msyPerTick);
  });
});

describe('breeding needs a food-rich home range and good condition', () => {
  const genome = () => new Array<number>(GENE_COUNT).fill(0.5);
  const adult = (sim: Simulation, x: number, y: number): Agent => {
    const a = createAgent(sim, { x, y, genes: genome(), age: 2000, food: 1e9 });
    sim.addAgent(a);
    return a;
  };
  const setRange = (sim: Simulation, x: number, y: number, frac: number) => {
    const w = sim.state.world;
    const r = REPRO.rangeTiles + 2;
    const cx = Math.floor(x / w.tileSize);
    const cy = Math.floor(y / w.tileSize);
    for (let ty = cy - r; ty <= cy + r; ty++) for (let tx = cx - r; tx <= cx + r; tx++) {
      const i = ty * w.width + tx;
      w.food[i] = tileCapacity(sim, i) * frac;
    }
  };

  it('a lush range allows breeding; a range grazed below the threshold does not', () => {
    const sim = grassSim();
    const a = adult(sim, 240, 160);
    const b = adult(sim, 244, 160);
    expect(isFertile(a) && isFertile(b)).toBe(true);
    const need = rangeFoodThreshold(a.traits);
    expect(need).toBeGreaterThan(0.3);
    setRange(sim, 242, 160, 1);
    expect(canMate(sim, a, b)).toBe(true);
    setRange(sim, 242, 160, need - 0.05);
    expect(localFoodFraction(sim, 242, 160, REPRO.rangeTiles, REPRO.rangeStride)).toBeLessThan(need);
    expect(canMate(sim, a, b)).toBe(false);
    expect(canMate(sim, b, a)).toBe(false);
    setRange(sim, 242, 160, need + 0.05);
    expect(canMate(sim, a, b)).toBe(true);
  });

  it('one rich patch underfoot does not make a grazed-out range fit for breeding', () => {
    const sim = grassSim();
    const a = adult(sim, 240, 160);
    const b = adult(sim, 244, 160);
    setRange(sim, 242, 160, 0.05);
    const w = sim.state.world;
    for (const [x, y] of [[240, 160], [244, 160]]) {
      const i = sim.tileIndex(x, y);
      w.food[i] = tileCapacity(sim, i);
    }
    expect(canMate(sim, a, b)).toBe(false);
  });

  it('agents still recovering from starvation or wounds do not breed', () => {
    const sim = grassSim();
    const a = adult(sim, 240, 160);
    const b = adult(sim, 244, 160);
    expect(canMate(sim, a, b)).toBe(true);
    a.health = a.traits.maxHealth * (REPRO.minHealthFrac - 0.02);
    expect(isFertile(a)).toBe(false);
    expect(canMate(sim, a, b)).toBe(false);
    expect(REPRO.minHealthFrac).toBeGreaterThanOrEqual(0.5);
  });

  it('localFoodFraction is capacity-weighted and 0 where nothing can grow', () => {
    const sim = grassSim({}, 60, 40, 0.4);
    expect(localFoodFraction(sim, 240, 160, 4)).toBeCloseTo(0.4, 5);
    expect(localFoodFraction(sim, 240, 160, 8, 2)).toBeCloseTo(0.4, 5);
    sim.state.world.terrain.fill(TERRAIN.DeepWater);
    expect(localFoodFraction(sim, 240, 160, 4)).toBe(0);
    expect(localFoodFraction(sim, NaN, 160, 4)).toBe(0);
  });
});
