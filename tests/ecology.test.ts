import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { DEFAULT_CONFIG } from '../src/sim/config';
import { TERRAIN_INFO } from '../src/sim/constants';
import {
  AGENT_FOOD_PER_TICK,
  REGROWTH_RATE,
  FERTILITY_MAX,
  FERTILITY_MIN,
  MAX_OVERFILL,
  SEASON_GROWTH,
  SEASON_TEMPERATURE,
  averageFertility,
  consumeFood,
  daylightAt,
  estimateCarryingCapacity,
  findFood,
  foodAt,
  initEnvironment,
  seasonName,
  tileCapacity,
  totalFood,
  updateEnvironment,
  updateResources,
} from '../src/sim/ecology';
import { TERRAIN, type SimConfig, type SimState, type TerrainType, type WorldState } from '../src/sim/types';

/** A bare Simulation (no agents) over a hand-built world — isolates ecology from world generation. */
function makeSim(opts: { w?: number; h?: number; config?: Partial<SimConfig>; fill?: number; terrain?: (x: number, y: number) => TerrainType } = {}): Simulation {
  const w = opts.w ?? 40;
  const h = opts.h ?? 30;
  const config: SimConfig = { ...DEFAULT_CONFIG, worldWidth: w, worldHeight: h, ...(opts.config ?? {}) };
  const n = w * h;
  const world: WorldState = {
    width: w,
    height: h,
    tileSize: config.tileSize,
    terrain: new Uint8Array(n).fill(TERRAIN.Grass),
    food: new Float32Array(n),
    fertility: new Float32Array(n).fill(1),
    baseFertility: new Float32Array(n).fill(1),
    elevation: new Float32Array(n).fill(0.5),
    climateMod: new Float32Array(n).fill(1),
    territory: new Int16Array(n).fill(-1),
    terrainVersion: 0,
  };
  if (opts.terrain) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) world.terrain[y * w + x] = opts.terrain(x, y);
  const state: SimState = {
    version: 1,
    scenarioId: 'ecology-test',
    config,
    tick: 0,
    rngState: [1, 2, 3, 4],
    nextAgentId: 1,
    nextTribeId: 1,
    nextEventId: 1,
    nextDisasterId: 1,
    world,
    env: initEnvironment(config),
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
  const fill = opts.fill ?? 0.7;
  for (let i = 0; i < n; i++) world.food[i] = tileCapacity(sim, i) * fill;
  return sim;
}

/** Mimic the ecology part of Simulation.step(): environment → resources → tick++. */
function advance(sim: Simulation, ticks: number, each?: (t: number) => void): void {
  for (let k = 0; k < ticks; k++) {
    updateEnvironment(sim);
    updateResources(sim);
    each?.(sim.state.tick);
    sim.state.tick++;
  }
}

const centre = (sim: Simulation, tx: number, ty: number) => ({ x: (tx + 0.5) * sim.state.world.tileSize, y: (ty + 0.5) * sim.state.world.tileSize });

describe('ecology: environment clock', () => {
  it('starts on a spring morning and advances days, seasons and years', () => {
    const env0 = initEnvironment(DEFAULT_CONFIG);
    expect(env0.timeOfDay).toBeCloseTo(0.3, 5);
    expect(env0).toMatchObject({ day: 0, season: 0, year: 0, tempOffset: 0 });
    expect(env0.daylight).toBeGreaterThan(0.8);
    expect(Number.isFinite(env0.temperature)).toBe(true);

    const sim = makeSim({ config: { dayLength: 20, daysPerSeason: 2 } }); // 40 ticks/season, 160 ticks/year
    const seasons: number[] = [];
    let last = sim.state.env.season as number;
    advance(sim, 160 * 2 + 10, () => {
      const env = sim.state.env;
      if (env.season !== last) seasons.push((last = env.season));
      expect(env.timeOfDay).toBeGreaterThanOrEqual(0);
      expect(env.timeOfDay).toBeLessThan(1);
      expect(env.seasonProgress).toBeGreaterThanOrEqual(0);
      expect(env.seasonProgress).toBeLessThan(1);
    });
    expect(seasons).toEqual([1, 2, 3, 0, 1, 2, 3, 0]);
    expect(sim.state.env.year).toBe(2);
    expect(sim.state.env.day).toBe(Math.floor((sim.state.tick - 1 + 6) / 20));
    const msgs = sim.state.events.filter((e) => e.category === 'environment').map((e) => e.message);
    expect(msgs.filter((m) => m.startsWith('Winter has come — plant growth slows to a crawl'))).toHaveLength(2);
    expect(msgs.some((m) => m.startsWith('Year 2 begins'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('Year 3 begins'))).toBe(true);
    expect(seasonName(sim.state.env)).toBe('Spring');
  });

  it('timeOfDay repeats every dayLength ticks; night is dark, midday is bright', () => {
    const sim = makeSim();
    const dl = sim.config.dayLength;
    updateEnvironment(sim);
    const tod0 = sim.state.env.timeOfDay;
    sim.state.tick = dl;
    updateEnvironment(sim);
    expect(sim.state.env.timeOfDay).toBeCloseTo(tod0, 9);
    expect(sim.state.env.day).toBe(1);
    expect(daylightAt(0)).toBe(0);
    expect(daylightAt(0.1)).toBe(0);
    expect(daylightAt(0.5)).toBe(1);
    expect(daylightAt(0.95)).toBe(0);
    const dawn = daylightAt(0.235);
    expect(dawn).toBeGreaterThan(0.05);
    expect(dawn).toBeLessThan(0.95);
    expect(daylightAt(0.235)).toBeCloseTo(daylightAt(0.765), 9); // symmetric dawn/dusk
  });

  it('season values are correct mid-season and change smoothly', () => {
    const sim = makeSim({ w: 8, h: 8 });
    let prev = { ...sim.state.env };
    let maxDG = 0;
    let maxDT = 0;
    let maxDL = 0;
    const tempSum = [0, 0, 0, 0];
    const tempN = [0, 0, 0, 0];
    advance(sim, 4 * 3 * 600, () => {
      const env = sim.state.env;
      maxDG = Math.max(maxDG, Math.abs(env.seasonGrowth - prev.seasonGrowth));
      maxDT = Math.max(maxDT, Math.abs(env.temperature - prev.temperature));
      maxDL = Math.max(maxDL, Math.abs(env.daylight - prev.daylight));
      if (Math.abs(env.seasonProgress - 0.5) < 1 / 6) {
        expect(env.seasonGrowth).toBeCloseTo(SEASON_GROWTH[env.season], 9); // plateau mid-season
        tempSum[env.season] += env.temperature;
        tempN[env.season]++;
      }
      prev = { ...env };
    });
    expect(maxDG).toBeLessThan(0.005);
    expect(maxDT).toBeLessThan(0.1);
    expect(maxDL).toBeLessThan(0.03);
    for (let s = 0; s < 4; s++) expect(tempSum[s] / tempN[s]).toBeCloseTo(SEASON_TEMPERATURE[s], 0);
    expect(SEASON_GROWTH).toEqual([1.3, 1.0, 0.8, 0.35]);
  });

  it('honours dayNight/seasons toggles and tempOffset', () => {
    const sim = makeSim({ config: { dayNight: false, seasons: false } });
    sim.state.env.tempOffset = -10;
    advance(sim, 3 * 3 * 600 + 300, () => {
      const env = sim.state.env;
      expect(env.daylight).toBe(1);
      expect(env.season).toBe(0);
      expect(env.seasonGrowth).toBe(1);
      expect(env.temperature).toBeCloseTo(14 - 10, 9);
    });
    expect(sim.state.events.some((e) => e.message.includes('Winter'))).toBe(false);

    const on = makeSim();
    on.state.tick = 1000;
    updateEnvironment(on);
    const t0 = on.state.env.temperature;
    on.state.env.tempOffset = -15;
    updateEnvironment(on);
    expect(on.state.env.temperature).toBeCloseTo(t0 - 15, 9);
  });

  it('is a pure function of tick (same env after a "reload" at any tick)', () => {
    const a = makeSim({ w: 8, h: 8 });
    advance(a, 5000);
    const b = makeSim({ w: 8, h: 8 });
    b.state.tick = a.state.tick - 1;
    updateEnvironment(b);
    const { tempOffset: _a, ...ea } = a.state.env;
    const { tempOffset: _b, ...eb } = b.state.env;
    expect(eb).toEqual(ea);
  });
});

describe('ecology: resources', () => {
  it('logistic regrowth: ~0.012–0.02 food/tick for grass at half capacity, bounded by capacity', () => {
    const sim = makeSim({ config: { seasons: false }, fill: 0.5 });
    const i = 15 * 40 + 20;
    const before = sim.state.world.food[i];
    advance(sim, 4); // every tile is processed exactly once per 4 ticks (4× step)
    const rate = (sim.state.world.food[i] - before) / 4;
    expect(rate).toBeGreaterThan(0.012);
    expect(rate).toBeLessThan(0.02);

    const food = sim.state.world.food;
    advance(sim, 6000, () => {
      for (let k = 0; k < food.length; k += 37) expect(food[k]).toBeLessThanOrEqual(tileCapacity(sim, k) + 1e-4);
    });
    for (let k = 0; k < food.length; k++) {
      expect(food[k]).toBeLessThanOrEqual(tileCapacity(sim, k) + 1e-4);
      expect(food[k]).toBeGreaterThan(0.95 * tileCapacity(sim, k));
    }
  });

  it('bare tiles re-seed, faster next to lush neighbours; drought (climateMod 0) stops growth', () => {
    const sim = makeSim({ config: { seasons: false } });
    const W = 40;
    const food = sim.state.world.food;
    const lone = 15 * W + 5;
    food[lone] = 0;
    for (let y = 10; y < 21; y++) for (let x = 20; x < 31; x++) food[y * W + x] = 0;
    const blockCentre = 15 * W + 25;
    const drought = 3 * W + 35;
    food[drought] = 0;
    sim.state.world.climateMod[drought] = 0;
    advance(sim, 400);
    expect(food[lone]).toBeGreaterThan(0.3);
    expect(food[blockCentre]).toBeGreaterThan(0.05);
    expect(food[lone]).toBeGreaterThan(2 * food[blockCentre]);
    expect(food[drought]).toBe(0);
  });

  it('overfilled tiles decay back toward capacity and never exceed 1.5× capacity; barren terrain holds nothing', () => {
    const sim = makeSim({ terrain: (x) => (x < 2 ? TERRAIN.DeepWater : TERRAIN.Grass) });
    const food = sim.state.world.food;
    const i = 10 * 40 + 10;
    const cap = tileCapacity(sim, i);
    food[i] = cap * 3; // something wrote far too much
    food[10 * 40] = 5; // food on deep water
    advance(sim, 4);
    expect(food[i]).toBeLessThanOrEqual(cap * MAX_OVERFILL + 1e-4);
    expect(food[10 * 40]).toBe(0);
    food[i] = cap * 1.5;
    advance(sim, 800);
    expect(food[i]).toBeLessThan(cap * 1.1);
    expect(food[i]).toBeGreaterThanOrEqual(cap - 1e-4);
  });

  it('tileCapacity = maxFood × fertility × foodCapacity', () => {
    const sim = makeSim({ config: { foodCapacity: 1.7 }, terrain: (x) => (x % 2 ? TERRAIN.Forest : TERRAIN.Sand) });
    sim.state.world.fertility[3] = 0.4;
    for (const idx of [2, 3]) {
      const t = sim.state.world.terrain[idx] as TerrainType;
      expect(tileCapacity(sim, idx)).toBe(TERRAIN_INFO[t].maxFood * sim.state.world.fertility[idx] * 1.7);
    }
    expect(tileCapacity(sim, -1)).toBe(0);
    expect(tileCapacity(sim, 1e9)).toBe(0);
  });
});

describe('ecology: consumption', () => {
  it('never goes negative, returns what was taken and conserves food', () => {
    const sim = makeSim();
    const food = sim.state.world.food;
    const p = centre(sim, 7, 9);
    const i = sim.tileIndex(p.x, p.y);
    food[i] = 1.3;
    const totalBefore = totalFood(sim);
    let taken = 0;
    for (const amt of [0.37, 0.5, 0.123456, 2, 1, 0.5]) {
      const before = food[i];
      const got = consumeFood(sim, p.x, p.y, amt);
      expect(got).toBeGreaterThanOrEqual(0);
      expect(got).toBeLessThanOrEqual(before);
      expect(got).toBeLessThanOrEqual(amt + 1e-6);
      expect(before - food[i]).toBe(got);
      expect(food[i]).toBeGreaterThanOrEqual(0);
      taken += got;
    }
    expect(food[i]).toBe(0);
    expect(taken).toBeCloseTo(1.3, 5);
    expect(totalBefore - totalFood(sim)).toBeCloseTo(taken, 3);
    expect(consumeFood(sim, p.x, p.y, 1)).toBe(0);
    food[i] = 4;
    expect(consumeFood(sim, p.x, p.y, -3)).toBe(0);
    expect(consumeFood(sim, p.x, p.y, NaN)).toBe(0);
    expect(consumeFood(sim, -50, 20, 1)).toBe(0);
    expect(consumeFood(sim, NaN, NaN, 1)).toBe(0);
    expect(food[i]).toBe(4);
    expect(foodAt(sim, p.x, p.y)).toBe(4);
    expect(foodAt(sim, 1e6, 1e6)).toBe(0);
  });
});

describe('ecology: overgrazing', () => {
  const patch = (sim: Simulation) => {
    const out: number[] = [];
    for (let y = 8; y < 22; y++) for (let x = 12; x < 28; x++) out.push(y * sim.state.world.width + x);
    return out;
  };
  const meanFert = (sim: Simulation, idx: number[]) => idx.reduce((s, i) => s + sim.state.world.fertility[i], 0) / idx.length;
  const graze = (sim: Simulation, idx: number[]) => {
    const W = sim.state.world.width;
    for (const i of idx) {
      const p = centre(sim, i % W, Math.floor(i / W));
      consumeFood(sim, p.x, p.y, 100);
    }
  };

  it('sustained overgrazing desertifies the land, which recovers when left alone', () => {
    const sim = makeSim({ config: { seasons: false } });
    const idx = patch(sim);
    advance(sim, 5400, () => graze(sim, idx));
    const degraded = meanFert(sim, idx);
    expect(degraded).toBeLessThan(0.25);
    expect(sim.state.world.fertility[2 * 40 + 2]).toBeCloseTo(1, 5); // ungrazed land untouched
    expect(estimateCarryingCapacity(sim)).toBeLessThan(0.85 * estimateCarryingCapacity(makeSim({ config: { seasons: false } })));
    advance(sim, 7200);
    const recovered = meanFert(sim, idx);
    expect(recovered).toBeGreaterThan(0.75);
    for (const i of idx) expect(sim.state.world.fertility[i]).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('does not degrade soil when config.overgrazing is off', () => {
    const sim = makeSim({ config: { seasons: false, overgrazing: false } });
    const idx = patch(sim);
    advance(sim, 3000, () => graze(sim, idx));
    expect(meanFert(sim, idx)).toBeCloseTo(1, 5);
  });

  it('fertilised soil (above base) drifts back toward base under lush cover', () => {
    const sim = makeSim({ config: { seasons: false }, fill: 1 });
    sim.state.world.fertility.fill(1.2);
    advance(sim, 6000);
    const f = averageFertility(sim);
    expect(f).toBeLessThan(1.1);
    expect(f).toBeGreaterThanOrEqual(1);
  });
});

describe('ecology: findFood', () => {
  it('picks a nearby rich tile over a slightly richer distant one and returns tile centres', () => {
    const sim = makeSim({ fill: 0 });
    const food = sim.state.world.food;
    const W = 40;
    const me = centre(sim, 10, 10);
    food[10 * W + 13] = 6; // 3 tiles away
    food[10 * W + 16] = 7; // 6 tiles away
    food[9 * W + 10] = 0.4; // adjacent but below the 0.5 threshold
    // radius 50 (6.25 tiles) is scanned at full resolution
    const spot = findFood(sim, me.x, me.y, 50);
    expect(spot).toEqual({ ...centre(sim, 13, 10), food: 6 });
    // a much richer tile further out wins
    food[10 * W + 16] = 20;
    expect(findFood(sim, me.x, me.y, 50)).toEqual({ ...centre(sim, 16, 10), food: 20 });
    expect(findFood(sim, me.x, me.y, 40)).toEqual({ ...centre(sim, 13, 10), food: 6 }); // 16 is out of range
    // out of range / nothing worth eating
    expect(findFood(sim, centre(sim, 30, 25).x, centre(sim, 30, 25).y, 30)).toBeNull();
    // standing on food: prefers the current tile
    food[10 * W + 16] = 7;
    food[10 * W + 10] = 6;
    expect(findFood(sim, me.x, me.y, 50)).toEqual({ ...centre(sim, 10, 10), food: 6 });
    expect(findFood(sim, NaN, 5, 60)).toBeNull();
  });

  it('ignores impassable tiles', () => {
    const sim = makeSim({ fill: 0, terrain: (x) => (x === 12 ? TERRAIN.Wall : TERRAIN.Grass) });
    sim.state.world.food[10 * 40 + 12] = 9;
    const me = centre(sim, 10, 10);
    expect(findFood(sim, me.x, me.y, 60)).toBeNull();
  });

  it('keeps large radii cheap (≲150 reads) yet finds distant food, deterministically', () => {
    const sim = makeSim({ w: 120, h: 90, fill: 0 });
    const W = 120;
    const food = sim.state.world.food;
    // a rich 3×3 grove 14 tiles away
    for (let y = 44; y <= 46; y++) for (let x = 73; x <= 75; x++) food[y * W + x] = 5;
    food[45 * W + 74] = 8;
    const me = centre(sim, 60, 45);
    // count tile reads through a proxy
    let reads = 0;
    const real = sim.state.world.food;
    sim.state.world.food = new Proxy(real, {
      get(t, p) {
        if (typeof p === 'string' && p.length && p.charCodeAt(0) >= 48 && p.charCodeAt(0) <= 57) reads++;
        return Reflect.get(t, p, t);
      },
    });
    for (const r of [25, 55, 140, 400, 5000]) {
      reads = 0;
      findFood(sim, me.x, me.y, r);
      expect(reads).toBeLessThanOrEqual(170);
    }
    sim.state.world.food = real;
    const a = findFood(sim, me.x, me.y, 140);
    const b = findFood(sim, me.x, me.y, 140);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    expect(a!.food).toBeGreaterThanOrEqual(5);
    expect(Math.hypot(a!.x - me.x, a!.y - me.y)).toBeLessThan(16 * sim.state.world.tileSize);
  });
});

describe('ecology: robustness & aggregates', () => {
  it('stays finite and in range over 20k ticks with disasters, grazing and corrupted values', () => {
    const terrains: TerrainType[] = [TERRAIN.Grass, TERRAIN.Forest, TERRAIN.Sand, TERRAIN.Desert, TERRAIN.Rock, TERRAIN.Water, TERRAIN.DeepWater, TERRAIN.Wall];
    const sim = makeSim({ w: 48, h: 32, config: { foodRegen: 3 }, terrain: (x, y) => terrains[(x * 7 + y * 3) % terrains.length] });
    const w = sim.state.world;
    for (let i = 0; i < w.fertility.length; i++) {
      w.fertility[i] = 0.05 + ((i * 37) % 100) / 100;
      w.baseFertility[i] = w.fertility[i];
    }
    w.food[5] = NaN;
    w.fertility[6] = NaN;
    w.food[7] = -3;
    advance(sim, 20000, (t) => {
      if (t % 500 === 0) {
        // disasters toggling climateMod (incl. garbage values) and global offsets
        for (let i = 0; i < w.climateMod.length; i += 3) w.climateMod[i] = [0, 0.2, 1, 2.5, NaN, -1][(t / 500 + i) % 6];
        sim.state.env.tempOffset = t % 1000 === 0 ? -12 : 0;
      }
      if (t % 7 === 0) for (let k = 0; k < 40; k++) consumeFood(sim, ((t * 13 + k * 97) % (48 * 8)) + 0.5, ((t * 7 + k * 31) % (32 * 8)) + 0.5, 3);
      if (t % 2000 === 0) w.food[(t / 2000) * 11] = tileCapacity(sim, (t / 2000) * 11) * 1.5; // interventions overfill
    });
    for (let i = 0; i < w.food.length; i++) {
      const f = w.food[i];
      expect(Number.isFinite(f) && f >= 0).toBe(true);
      expect(f).toBeLessThanOrEqual(tileCapacity(sim, i) * MAX_OVERFILL + 1e-4);
      if (TERRAIN_INFO[w.terrain[i] as TerrainType].maxFood > 0) {
        expect(w.fertility[i]).toBeGreaterThanOrEqual(FERTILITY_MIN);
        expect(w.fertility[i]).toBeLessThanOrEqual(FERTILITY_MAX);
      }
    }
    const env = sim.state.env;
    for (const v of [env.timeOfDay, env.daylight, env.temperature, env.seasonGrowth, env.seasonProgress]) expect(Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(totalFood(sim)) && Number.isFinite(averageFertility(sim)) && Number.isFinite(estimateCarryingCapacity(sim))).toBe(true);
  });

  it('is deterministic for identical inputs', () => {
    const run = () => {
      const sim = makeSim({ terrain: (x, y) => ((x + y) % 5 === 0 ? TERRAIN.Forest : TERRAIN.Grass) });
      advance(sim, 3000, (t) => {
        for (let k = 0; k < 25; k++) {
          const spot = findFood(sim, ((t * 17 + k * 41) % 320) + 0.5, ((t * 5 + k * 23) % 240) + 0.5, 50);
          if (spot) consumeFood(sim, spot.x, spot.y, 0.4);
        }
      });
      return sim;
    };
    const a = run();
    const b = run();
    expect(a.state.env).toEqual(b.state.env);
    expect(a.state.events.map((e) => e.message)).toEqual(b.state.events.map((e) => e.message));
    let same = true;
    for (let i = 0; i < a.state.world.food.length; i++) {
      if (a.state.world.food[i] !== b.state.world.food[i] || a.state.world.fertility[i] !== b.state.world.fertility[i]) same = false;
    }
    expect(same).toBe(true);
  });

  it('aggregates: totalFood, averageFertility, estimateCarryingCapacity', () => {
    const sim = makeSim({ fill: 0.5, config: { seasons: false }, terrain: (x) => (x < 10 ? TERRAIN.DeepWater : TERRAIN.Grass) });
    const w = sim.state.world;
    let sum = 0;
    for (let i = 0; i < w.food.length; i++) sum += w.food[i];
    expect(totalFood(sim)).toBeCloseTo(sum, 6);
    w.fertility.fill(0.5);
    for (let y = 0; y < 30; y++) for (let x = 0; x < 10; x++) w.fertility[y * 40 + x] = 0; // ocean tiles excluded
    expect(averageFertility(sim)).toBeCloseTo(0.5, 6);
    // 900 grass tiles × MSY (REGROWTH_RATE × 10 × 0.5 / 4) / 0.09 per agent
    const k = estimateCarryingCapacity(sim);
    expect(k).toBe(Math.round((900 * REGROWTH_RATE * 10 * 0.5) / 4 / AGENT_FOOD_PER_TICK));
    sim.state.config.foodRegen = 2;
    expect(estimateCarryingCapacity(sim)).toBeCloseTo(2 * k, -1);

    const seasonal = makeSim();
    seasonal.state.tick = 1.5 * 3 * 600; // mid-summer
    updateEnvironment(seasonal);
    const summer = estimateCarryingCapacity(seasonal);
    seasonal.state.tick = 3.5 * 3 * 600; // mid-winter
    updateEnvironment(seasonal);
    expect(estimateCarryingCapacity(seasonal)).toBeLessThan(summer * 0.45);
    expect(estimateCarryingCapacity(seasonal, true)).toBeGreaterThan(summer * 0.7);
  });

  it('full-size world resource update is cheap (staggered, allocation-free)', () => {
    const sim = makeSim({ w: 200, h: 125 });
    advance(sim, 50);
    const t0 = performance.now();
    advance(sim, 1000);
    expect(performance.now() - t0).toBeLessThan(1500); // ~0.2 ms/tick expected
  });
});
