/**
 * Regression tests (eco audit): temperature is spatial. A LOCAL cold snap chills only its own
 * area (with edge falloff) and never the global env.temperature / env.tempOffset; a GLOBAL
 * (radius 0) cold snap chills everyone. Cold stress in lifecycle uses the local temperature.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { createAgent, updateVitals } from '../src/sim/lifecycle';
import { basalBurn } from '../src/sim/genetics';
import { updateEnvironment } from '../src/sim/ecology';
import { DISASTER_TUNING, localColdOffsetAt, startDisaster, temperatureAt, updateDisasters } from '../src/sim/disasters';
import { GENE_COUNT, TERRAIN, type Agent, type ScenarioDef, type SimConfig } from '../src/sim/types';

const SCENARIO: ScenarioDef = {
  id: 'eco-temperature',
  name: 'Temperature test',
  tagline: '',
  description: '',
  lookFor: [],
  config: {},
  world: { island: false, divide: 'none' },
  populations: [],
  scheduled: [],
};

function makeSim(cfg: Partial<SimConfig> = {}): Simulation {
  // summer-ish constant clock: no seasons / day-night so env.temperature is a fixed 14 °C
  const sim = Simulation.create({ scenario: SCENARIO, seed: 3, config: { disasterRate: 0, seasons: false, dayNight: false, ...cfg } });
  sim.state.world.terrain.fill(TERRAIN.Grass);
  return sim;
}

/** Advance only the clock + disaster systems to tick t (the order step() uses). */
function at(sim: Simulation, t: number): void {
  sim.state.tick = t;
  updateEnvironment(sim);
  updateDisasters(sim);
}

function adult(sim: Simulation, x: number, y: number): Agent {
  const a = createAgent(sim, { x, y, genes: new Array<number>(GENE_COUNT).fill(0.5), age: 2000, food: 1e9 });
  sim.addAgent(a);
  a.action = 'idle';
  return a;
}

function burnOnce(sim: Simulation, a: Agent): number {
  const before = a.food;
  updateVitals(sim, a);
  return before - a.food;
}

describe('spatial temperature (local vs global cold snaps)', () => {
  it('a local cold snap leaves the global temperature untouched and chills only its area', () => {
    const sim = makeSim();
    at(sim, 0);
    const base = sim.state.env.temperature;
    expect(base).toBeCloseTo(14, 6);

    startDisaster(sim, 'coldsnap', 800, 500, 200, 1, 600);
    at(sim, 1);
    // global values unchanged (the old code subtracted the local snap from env.tempOffset)
    expect(sim.state.env.tempOffset).toBe(0);
    expect(sim.state.env.temperature).toBeCloseTo(base, 6);

    // full strength inside 0.75·radius: magnitude 12 + 8·(200/400) = 16 °C
    expect(temperatureAt(sim, 800, 500)).toBeCloseTo(base - 16, 6);
    expect(temperatureAt(sim, 800 + 140, 500)).toBeCloseTo(base - 16, 6);
    // smooth falloff between 0.75·r and r
    const edge = temperatureAt(sim, 800 + 180, 500);
    expect(edge).toBeGreaterThan(base - 16);
    expect(edge).toBeLessThan(base);
    // nothing outside the radius
    expect(temperatureAt(sim, 800 + 201, 500)).toBeCloseTo(base, 6);
    expect(temperatureAt(sim, 100, 100)).toBeCloseTo(base, 6);
    expect(localColdOffsetAt(sim, 100, 100)).toBe(0);
  });

  it('a global cold snap chills everyone; local snaps add on top inside their area', () => {
    const sim = makeSim();
    at(sim, 0);
    const base = sim.state.env.temperature;
    startDisaster(sim, 'coldsnap', 0, 0, 0, 1, 600);
    at(sim, 1);
    expect(sim.state.env.tempOffset).toBeCloseTo(-20, 6);
    expect(sim.state.env.temperature).toBeCloseTo(base - 20, 6);
    expect(temperatureAt(sim, 100, 100)).toBeCloseTo(base - 20, 6);
    expect(temperatureAt(sim, 1500, 900)).toBeCloseTo(base - 20, 6);

    startDisaster(sim, 'coldsnap', 800, 500, 400, 0.5, 600);
    at(sim, 2);
    expect(sim.state.env.tempOffset).toBeCloseTo(-20, 6); // still only the global snap
    expect(temperatureAt(sim, 800, 500)).toBeCloseTo(base - 20 - 20 * 0.5, 6);
    expect(temperatureAt(sim, 100, 100)).toBeCloseTo(base - 20, 6);
  });

  it('the combined cold-snap offset never goes below minTempOffset', () => {
    const sim = makeSim();
    at(sim, 0);
    const base = sim.state.env.temperature;
    startDisaster(sim, 'coldsnap', 0, 0, 0, 1, 600); // −20 global
    for (let i = 0; i < 3; i++) startDisaster(sim, 'coldsnap', 800, 500, 400, 1, 600); // −60 local
    at(sim, 1);
    expect(temperatureAt(sim, 800, 500)).toBeCloseTo(base + DISASTER_TUNING.minTempOffset, 6);
    expect(temperatureAt(sim, 100, 100)).toBeCloseTo(base - 20, 6);
  });

  it('local cold fades with the disaster and is gone after expiry', () => {
    const sim = makeSim();
    at(sim, 0);
    const base = sim.state.env.temperature;
    startDisaster(sim, 'coldsnap', 800, 500, 200, 1, 600);
    at(sim, 300);
    expect(temperatureAt(sim, 800, 500)).toBeCloseTo(base - 16, 6);
    at(sim, 590); // ramp-out over the last 90 ticks
    const fading = temperatureAt(sim, 800, 500);
    expect(fading).toBeGreaterThan(base - 16);
    expect(fading).toBeLessThan(base);
    at(sim, 600);
    expect(temperatureAt(sim, 800, 500)).toBeCloseTo(base, 6);
  });

  it('cold stress (lifecycle) follows the local temperature', () => {
    const sim = makeSim();
    at(sim, 0); // 14 °C: no cold cost anywhere
    const inside = adult(sim, 800, 500);
    const outside = adult(sim, 150, 150);
    expect(burnOnce(sim, inside)).toBeCloseTo(basalBurn(inside.traits), 9);
    expect(burnOnce(sim, outside)).toBeCloseTo(basalBurn(outside.traits), 9);

    startDisaster(sim, 'coldsnap', 800, 500, 200, 1, 600);
    at(sim, 1); // inside: 14 − 16 = −2 °C
    expect(burnOnce(sim, inside)).toBeGreaterThan(basalBurn(inside.traits) * 1.2);
    expect(burnOnce(sim, outside)).toBeCloseTo(basalBurn(outside.traits), 9);

    // a global snap reaches the agent outside too
    startDisaster(sim, 'coldsnap', 0, 0, 0, 1, 600);
    at(sim, 2);
    expect(burnOnce(sim, outside)).toBeGreaterThan(basalBurn(outside.traits) * 1.2);
  });
});
