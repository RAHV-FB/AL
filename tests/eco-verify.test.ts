/**
 * Regression tests (eco verifier) for the ecology audit's fixes.
 *
 *  1. The breeding gate (genetics.canMate → ecology.localFoodFraction) measures the food of the home
 *     range an agent forages over, not just the camp it crowds into. With a ±3-tile window a camp
 *     grazed down in the middle of lush land stopped every birth there: in `eden` 90–95 % of the
 *     fertile adults were blocked on days 2–4 although the world's food stock stayed high, so the
 *     preset's documented J-shaped growth curve became a slow, decelerating one.
 *  2. A local cold snap applied through sim.enqueue + step() chills only its own area (env.tempOffset
 *     and env.temperature stay world-wide values) and a save → load during it continues exactly.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { findScenario } from '../src/sim/presets';
import { deserializeState, serializeSim } from '../src/sim/persistence';
import { canMate, isFertile, rangeFoodThreshold } from '../src/sim/genetics';
import { tileCapacity } from '../src/sim/ecology';
import { temperatureAt } from '../src/sim/disasters';
import { createAgent } from '../src/sim/lifecycle';
import { GENE_COUNT, TERRAIN, type Agent, type GenomeTemplate, type ScenarioDef } from '../src/sim/types';

const EMPTY: ScenarioDef = {
  id: 'eco-verify',
  name: 'Eco verify',
  tagline: '',
  description: '',
  lookFor: [],
  config: { worldWidth: 60, worldHeight: 40, disasterRate: 0 },
  world: { island: false, divide: 'none' },
  populations: [],
  scheduled: [],
};

/** Uniform lush grassland (every tile at capacity), no agents. */
function lushSim(): Simulation {
  const sim = Simulation.create({ scenario: EMPTY, seed: 11 });
  const w = sim.state.world;
  w.terrain.fill(TERRAIN.Grass);
  w.fertility.fill(1);
  w.baseFertility.fill(1);
  for (let i = 0; i < w.food.length; i++) w.food[i] = tileCapacity(sim, i);
  return sim;
}

/** Graze every tile within ±rTiles (square) of the tile under (x, y) down to `frac` of its capacity. */
function graze(sim: Simulation, x: number, y: number, rTiles: number, frac: number): void {
  const w = sim.state.world;
  const cx = Math.floor(x / w.tileSize);
  const cy = Math.floor(y / w.tileSize);
  for (let ty = cy - rTiles; ty <= cy + rTiles; ty++) {
    for (let tx = cx - rTiles; tx <= cx + rTiles; tx++) {
      if (tx < 0 || ty < 0 || tx >= w.width || ty >= w.height) continue;
      const i = ty * w.width + tx;
      w.food[i] = tileCapacity(sim, i) * frac;
    }
  }
}

function adult(sim: Simulation, x: number, y: number): Agent {
  const a = createAgent(sim, { x, y, genes: new Array<number>(GENE_COUNT).fill(0.5), age: 2000, food: 1e9 });
  sim.addAgent(a);
  return a;
}

describe('breeding gate measures the foraging range, not the camp', () => {
  it('a camp grazed down in the middle of lush land does not stop births; a grazed-out range does', () => {
    const sim = lushSim();
    const a = adult(sim, 242, 162);
    const b = adult(sim, 246, 162);
    expect(isFertile(a) && isFertile(b)).toBe(true);
    expect(rangeFoodThreshold(a.traits)).toBeGreaterThan(0.3);
    // the crowded camp: the 7×7 tiles around the couple are grazed to 15 % (it used to be the whole window)
    graze(sim, 244, 162, 3, 0.15);
    expect(canMate(sim, a, b)).toBe(true);
    expect(canMate(sim, b, a)).toBe(true);
    // the whole home range grazed down: no births
    graze(sim, 244, 162, 8, 0.15);
    expect(canMate(sim, a, b)).toBe(false);
    expect(canMate(sim, b, a)).toBe(false);
  });
});

describe('eden: unconstrained early growth', () => {
  it('grows at least two-fold from day 1 to day 4 (J-shaped curve before the cap)', () => {
    const sim = Simulation.create({ scenario: findScenario('eden')!, seed: 42 });
    const day = sim.config.dayLength;
    const pop: number[] = [sim.state.agents.length];
    for (let d = 1; d <= 4; d++) {
      sim.run(day);
      pop.push(sim.state.agents.length);
    }
    // eslint-disable-next-line no-console
    console.log(`eco-verify eden: daily population ${pop.join(' ')}`);
    expect(pop[4]).toBeGreaterThanOrEqual(2 * pop[1]);
  }, 120_000);
});

const folk: GenomeTemplate = {
  speed: 0.5, size: 0.5, perception: 0.55, metabolism: 0.5, aggression: 0.2, sociability: 0.7,
  altruism: 0.55, fertility: 0.6, longevity: 0.5, immunity: 0.5, efficiency: 0.55, hue: 0.3, spread: 0.07,
};
const VILLAGE: ScenarioDef = {
  ...EMPTY,
  id: 'eco-verify-village',
  config: { worldWidth: 90, worldHeight: 60, disasterRate: 0 },
  world: { waterLevel: 0.2, desertLevel: 0.05, mountainLevel: 0.05 },
  populations: [{ x: 360, y: 240, count: 30, radius: 50, template: folk, tribe: 'new', tribeName: 'Villagers' }],
};

describe('local cold snaps through the tick loop', () => {
  it('an enqueued local cold snap chills only its area and a save → load during it continues exactly', () => {
    const a = Simulation.create({ scenario: VILLAGE, seed: 3 });
    const control = Simulation.create({ scenario: VILLAGE, seed: 3 });
    a.run(5);
    control.run(5);
    a.enqueue({ kind: 'disaster', disaster: 'coldsnap', x: 360, y: 240, radius: 120, intensity: 1, duration: 600 });
    a.step();
    control.step();
    expect(a.state.disasters.some((d) => d.kind === 'coldsnap' && d.active && d.radius === 120)).toBe(true);
    // world-wide values untouched …
    expect(a.state.env.tempOffset).toBe(0);
    expect(a.state.env.temperature).toBeCloseTo(control.state.env.temperature, 9);
    // … the area itself is 12 + 8·120/400 = 14.4 °C colder, and the far corner is not
    expect(temperatureAt(a, 360, 240)).toBeCloseTo(a.state.env.temperature - 14.4, 6);
    expect(temperatureAt(a, 40, 40)).toBeCloseTo(a.state.env.temperature, 9);

    a.run(150);
    const loaded = Simulation.fromState(deserializeState(serializeSim(a)));
    expect(loaded.hash()).toBe(a.hash());
    a.run(300);
    loaded.run(300);
    expect(loaded.hash({ events: false })).toBe(a.hash({ events: false }));
  }, 120_000);
});
