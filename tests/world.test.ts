import { describe, expect, it } from 'vitest';
import { createEmptyWorld, defaultFertility, findPassableInWorld, findPassableNear, generateWorld, GradientNoise } from '../src/sim/world';
import { Rng } from '../src/sim/rng';
import { DEFAULT_CONFIG } from '../src/sim/config';
import { TERRAIN_INFO } from '../src/sim/constants';
import { Simulation } from '../src/sim/simulation';
import { TERRAIN, type ScenarioDef, type SimConfig, type TerrainType, type WorldGenOptions, type WorldState } from '../src/sim/types';

const gen = (seed: number, opts: WorldGenOptions = {}, cfg: Partial<SimConfig> = {}): WorldState =>
  generateWorld({ ...DEFAULT_CONFIG, ...cfg, seed }, new Rng(seed, 1), opts);

const isPassable = (w: WorldState, i: number): boolean => TERRAIN_INFO[w.terrain[i] as TerrainType].passable;
const isWater = (w: WorldState, i: number): boolean => w.terrain[i] === TERRAIN.Water || w.terrain[i] === TERRAIN.DeepWater;

function passableFraction(w: WorldState): number {
  let n = 0;
  for (let i = 0; i < w.terrain.length; i++) if (isPassable(w, i)) n++;
  return n / w.terrain.length;
}

/** 4-neighbour flood fill from `starts` over tiles accepted by `allow`. */
function flood(w: WorldState, starts: number[], allow: (i: number) => boolean): Uint8Array {
  const N = w.width * w.height;
  const seen = new Uint8Array(N);
  const q: number[] = [];
  for (const s of starts) {
    if (!seen[s] && allow(s)) {
      seen[s] = 1;
      q.push(s);
    }
  }
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    const x = i % w.width;
    for (const j of [x > 0 ? i - 1 : -1, x < w.width - 1 ? i + 1 : -1, i - w.width, i + w.width]) {
      if (j >= 0 && j < N && !seen[j] && allow(j)) {
        seen[j] = 1;
        q.push(j);
      }
    }
  }
  return seen;
}

/** Group consecutive row indices and count the groups. */
function countGroups(rows: number[]): number {
  let groups = 0;
  for (let k = 0; k < rows.length; k++) if (k === 0 || rows[k] !== rows[k - 1] + 1) groups++;
  return groups;
}

describe('GradientNoise', () => {
  it('is seeded, bounded and continuous', () => {
    const a = new GradientNoise(new Rng(9));
    const b = new GradientNoise(new Rng(9));
    const c = new GradientNoise(new Rng(10));
    let diff = 0;
    for (let k = 0; k < 500; k++) {
      const x = k * 0.137;
      const y = k * 0.291;
      const v = a.fbm(x, y, 5);
      expect(v).toBe(b.fbm(x, y, 5));
      expect(Math.abs(v)).toBeLessThanOrEqual(1.0001);
      expect(Math.abs(a.noise(x, y) - a.noise(x + 1e-4, y))).toBeLessThan(0.01);
      diff += Math.abs(v - c.fbm(x, y, 5));
    }
    expect(diff).toBeGreaterThan(5);
  });
});

describe('generateWorld', () => {
  it('is deterministic per seed and differs across seeds', () => {
    for (const opts of [{}, { divide: 'river' }, { divide: 'mountains', island: false }] as WorldGenOptions[]) {
      const a = gen(11, opts);
      const b = gen(11, opts);
      expect(a.terrain).toEqual(b.terrain);
      expect(a.food).toEqual(b.food);
      expect(a.fertility).toEqual(b.fertility);
      expect(a.baseFertility).toEqual(b.baseFertility);
      expect(a.elevation).toEqual(b.elevation);
      const c = gen(12, opts);
      let differ = 0;
      for (let i = 0; i < a.terrain.length; i++) if (a.terrain[i] !== c.terrain[i]) differ++;
      expect(differ / a.terrain.length).toBeGreaterThan(0.1);
    }
  });

  it('builds a varied island with a deep-water border and mostly passable land', () => {
    const w = gen(1);
    expect(w.width).toBe(DEFAULT_CONFIG.worldWidth);
    expect(w.height).toBe(DEFAULT_CONFIG.worldHeight);
    expect(w.tileSize).toBe(DEFAULT_CONFIG.tileSize);
    expect(w.terrainVersion).toBe(0);
    const counts = new Array(8).fill(0);
    for (let i = 0; i < w.terrain.length; i++) counts[w.terrain[i]]++;
    for (const t of [TERRAIN.DeepWater, TERRAIN.Water, TERRAIN.Sand, TERRAIN.Grass, TERRAIN.Forest, TERRAIN.Desert, TERRAIN.Rock]) {
      expect(counts[t], `terrain ${t}`).toBeGreaterThan(w.terrain.length * 0.02);
    }
    expect(counts[TERRAIN.Wall]).toBe(0);
    expect(counts[TERRAIN.Grass]).toBeGreaterThan(counts[TERRAIN.Desert]);
    for (let x = 0; x < w.width; x++) {
      expect(w.terrain[x]).toBe(TERRAIN.DeepWater);
      expect(w.terrain[(w.height - 1) * w.width + x]).toBe(TERRAIN.DeepWater);
    }
    for (let y = 0; y < w.height; y++) {
      expect(w.terrain[y * w.width]).toBe(TERRAIN.DeepWater);
      expect(w.terrain[y * w.width + w.width - 1]).toBe(TERRAIN.DeepWater);
    }
    expect(passableFraction(w)).toBeGreaterThanOrEqual(0.55);
    // the map centre (where scenarios usually spawn) is near land
    const mid = Math.floor(w.height / 2) * w.width + Math.floor(w.width / 2);
    expect(isPassable(w, mid) || findPassableInWorld(w, (w.width / 2) * w.tileSize, (w.height / 2) * w.tileSize, 80, true) !== null).toBe(true);
  });

  it('keeps >= 55% passable and all passable land connected, even with extreme options', () => {
    const cases: WorldGenOptions[] = [
      {},
      { waterLevel: 0.85 },
      { waterLevel: 0.85, island: false, noiseScale: 8 },
      { waterLevel: 0.6, divide: 'river' },
      { mountainLevel: 0.8, desertLevel: 0.9, forestLevel: 1 },
      { divide: 'mountains', noiseScale: 200 },
      { waterLevel: 0, island: false },
    ];
    for (const [k, opts] of cases.entries()) {
      const w = gen(100 + k, opts);
      expect(passableFraction(w), JSON.stringify(opts)).toBeGreaterThanOrEqual(0.55);
      let first = -1;
      let total = 0;
      for (let i = 0; i < w.terrain.length; i++) {
        if (!isPassable(w, i)) continue;
        total++;
        if (first < 0) first = i;
      }
      const reached = flood(w, [first], (i) => isPassable(w, i));
      let n = 0;
      for (let i = 0; i < reached.length; i++) n += reached[i];
      expect(n, `connected ${JSON.stringify(opts)}`).toBe(total);
    }
  });

  it('sets fertility in [0,1] and food = capacity x initialFood', () => {
    for (const [opts, cfg] of [
      [{}, {}],
      [{ initialFood: 0.35, fertility: 1.6 }, { foodCapacity: 2.5 }],
      [{ initialFood: 1, fertility: 0.3, divide: 'river' }, { foodCapacity: 0.4 }],
    ] as [WorldGenOptions, Partial<SimConfig>][]) {
      const w = gen(5, opts, cfg);
      const init = opts.initialFood ?? 0.7;
      const fc = cfg.foodCapacity ?? DEFAULT_CONFIG.foodCapacity;
      for (let i = 0; i < w.terrain.length; i++) {
        const f = w.fertility[i];
        expect(f >= 0 && f <= 1).toBe(true);
        expect(w.baseFertility[i]).toBe(f);
        expect(w.elevation[i] >= 0 && w.elevation[i] <= 1).toBe(true);
        expect(w.climateMod[i]).toBe(1);
        expect(w.territory[i]).toBe(-1);
        const cap = TERRAIN_INFO[w.terrain[i] as TerrainType].maxFood * f * fc;
        const food = w.food[i];
        if (!(food >= 0) || food > cap || Math.abs(food - cap * init) > 1e-5 * Math.max(1, cap)) {
          throw new Error(`tile ${i}: food ${food}, capacity ${cap}, init ${init}`);
        }
      }
    }
  });

  it('honours coverage and fertility options', () => {
    const frac = (w: WorldState, t: number) => {
      let n = 0;
      for (let i = 0; i < w.terrain.length; i++) if (w.terrain[i] === t) n++;
      return n / w.terrain.length;
    };
    const meanFert = (w: WorldState) => {
      let s = 0;
      let n = 0;
      for (let i = 0; i < w.terrain.length; i++) {
        if (TERRAIN_INFO[w.terrain[i] as TerrainType].maxFood > 0) {
          s += w.fertility[i];
          n++;
        }
      }
      return s / n;
    };
    expect(frac(gen(3, { waterLevel: 0.5 }), TERRAIN.DeepWater) + frac(gen(3, { waterLevel: 0.5 }), TERRAIN.Water)).toBeGreaterThan(
      frac(gen(3, { waterLevel: 0.15 }), TERRAIN.DeepWater) + frac(gen(3, { waterLevel: 0.15 }), TERRAIN.Water),
    );
    expect(frac(gen(3, { forestLevel: 1 }), TERRAIN.Forest)).toBeGreaterThan(frac(gen(3, { forestLevel: 0.1 }), TERRAIN.Forest) * 3);
    expect(frac(gen(3, { desertLevel: 0.45 }), TERRAIN.Desert)).toBeGreaterThan(frac(gen(3, { desertLevel: 0.05 }), TERRAIN.Desert) * 3);
    expect(frac(gen(3, { mountainLevel: 0.3 }), TERRAIN.Rock)).toBeGreaterThan(frac(gen(3, { mountainLevel: 0.05 }), TERRAIN.Rock) * 3);
    expect(frac(gen(3, { mountainLevel: 0 }), TERRAIN.Rock)).toBe(0);
    expect(meanFert(gen(3, { fertility: 0.5 }))).toBeLessThan(meanFert(gen(3, { fertility: 1 })) * 0.6);
    // island: false leaves land touching the map edge
    const open = gen(3, { island: false, waterLevel: 0.2 });
    let edgeLand = 0;
    for (let x = 0; x < open.width; x++) if (!isWater(open, x)) edgeLand++;
    expect(edgeLand).toBeGreaterThan(0);
  });

  it('river divide splits the map, crossable only at 2-3 shallow fords', () => {
    for (const seed of [2, 21, 77, 1234]) {
      const w = gen(seed, { divide: 'river' });
      const W = w.width;
      const dry = (i: number) => isPassable(w, i) && w.terrain[i] !== TERRAIN.Water;
      const westStarts: number[] = [];
      const eastStarts: number[] = [];
      for (let i = 0; i < w.terrain.length; i++) {
        const x = i % W;
        if (!dry(i)) continue;
        if (x < W * 0.2) westStarts.push(i);
        else if (x >= W * 0.8) eastStarts.push(i);
      }
      // without any shallow water the two halves are disconnected
      const west = flood(w, westStarts, dry);
      const east = flood(w, eastStarts, dry);
      for (let i = 0; i < west.length; i++) if (west[i] && east[i]) throw new Error(`seed ${seed}: land bridge across the river at ${i}`);
      // with shallows (fords) every passable tile is reachable from the west
      const all = flood(w, [westStarts[0]], (i) => isPassable(w, i));
      expect(eastStarts.every((i) => all[i] === 1)).toBe(true);
      // count fords: rows with a straight passable crossing from west land to east land
      const crossRows: number[] = [];
      for (let y = 0; y < w.height; y++) {
        let fromWest = false;
        for (let x = Math.floor(W * 0.25); x <= Math.ceil(W * 0.75); x++) {
          const i = y * W + x;
          if (!isPassable(w, i)) fromWest = false;
          else {
            if (west[i]) fromWest = true;
            if (fromWest && east[i]) {
              crossRows.push(y);
              break;
            }
          }
        }
      }
      const fords = countGroups(crossRows);
      expect(fords, `seed ${seed} fords at rows ${crossRows.join(',')}`).toBeGreaterThanOrEqual(2);
      expect(fords).toBeLessThanOrEqual(3);
    }
  });

  it('mountain divide forms a rock range with 2-3 passes', () => {
    for (const seed of [3, 31, 99]) {
      const w = gen(seed, { divide: 'mountains', mountainLevel: 0 });
      const W = w.width;
      const passRows: number[] = [];
      let ridgeRows = 0;
      let landRows = 0;
      for (let y = Math.floor(w.height * 0.15); y < Math.ceil(w.height * 0.85); y++) {
        let rock = 0;
        let land = 0;
        for (let x = Math.floor(W * 0.25); x <= Math.ceil(W * 0.75); x++) {
          const t = w.terrain[y * W + x];
          if (t === TERRAIN.Rock) rock++;
          if (t !== TERRAIN.DeepWater && t !== TERRAIN.Water) land++;
        }
        if (land < W * 0.25) continue; // mostly sea in this row
        landRows++;
        if (rock >= 4) ridgeRows++;
        if (rock === 0) passRows.push(y);
      }
      expect(ridgeRows / landRows, `seed ${seed}`).toBeGreaterThan(0.6);
      const passes = countGroups(passRows);
      expect(passes, `seed ${seed} pass rows ${passRows.join(',')}`).toBeGreaterThanOrEqual(2);
      expect(passes).toBeLessThanOrEqual(3);
    }
  });

  it('handles tiny and odd configurations', () => {
    for (const [ww, hh] of [[1, 1], [3, 2], [7, 5], [16, 9]]) {
      const w = gen(4, { divide: 'river' }, { worldWidth: ww, worldHeight: hh });
      expect(w.terrain.length).toBe(ww * hh);
      expect(passableFraction(w)).toBeGreaterThanOrEqual(0.55);
      for (let i = 0; i < w.food.length; i++) expect(Number.isFinite(w.food[i]) && w.food[i] >= 0).toBe(true);
    }
    const weird = gen(4, { waterLevel: NaN, noiseScale: -5, fertility: Infinity, initialFood: 9 } as WorldGenOptions);
    expect(passableFraction(weird)).toBeGreaterThanOrEqual(0.55);
    for (let i = 0; i < weird.food.length; i++) expect(Number.isFinite(weird.food[i]) && weird.food[i] >= 0).toBe(true);
  });

  it('defaultFertility is barren for deep water / walls and in range for the rest', () => {
    expect(defaultFertility(TERRAIN.DeepWater)).toBe(0);
    expect(defaultFertility(TERRAIN.Wall)).toBe(0);
    for (const t of [TERRAIN.Water, TERRAIN.Sand, TERRAIN.Grass, TERRAIN.Forest, TERRAIN.Desert, TERRAIN.Rock]) {
      for (const m of [0, 0.5, 1]) {
        const f = defaultFertility(t, m);
        expect(f > 0 && f <= 1).toBe(true);
      }
    }
    expect(defaultFertility(TERRAIN.Forest)).toBeGreaterThan(defaultFertility(TERRAIN.Desert));
  });
});

describe('findPassableNear', () => {
  it('returns the point itself when passable, else the nearest passable spot', () => {
    const w = createEmptyWorld(20, 10, 8);
    w.terrain.fill(TERRAIN.DeepWater);
    w.terrain[5 * 20 + 15] = TERRAIN.Grass; // tile (15,5)
    w.terrain[5 * 20 + 3] = TERRAIN.Water; // tile (3,5)
    expect(findPassableInWorld(w, 15 * 8 + 3, 5 * 8 + 4, 0)).toEqual({ x: 123, y: 44 });
    // from tile (12,5): nearest passable is (15,5) — 3 tiles away
    const p = findPassableInWorld(w, 12 * 8 + 4, 5 * 8 + 4, 100)!;
    expect(Math.floor(p.x / 8)).toBe(15);
    expect(Math.floor(p.y / 8)).toBe(5);
    // radius too small → null
    expect(findPassableInWorld(w, 12 * 8 + 4, 5 * 8 + 4, 8)).toBeNull();
    // from tile (5,5): shallows at (3,5) are closer, unless water is avoided
    const q = findPassableInWorld(w, 5 * 8 + 4, 5 * 8 + 4, 200)!;
    expect(Math.floor(q.x / 8)).toBe(3);
    const r = findPassableInWorld(w, 5 * 8 + 4, 5 * 8 + 4, 200, true)!;
    expect(Math.floor(r.x / 8)).toBe(15);
    // outside the map / NaN
    expect(findPassableInWorld(w, NaN, 3, 100)).toBeNull();
    const s = findPassableInWorld(w, 9999, 44, 1000)!;
    expect(Math.floor(s.x / 8)).toBe(15);
  });

  it('works through a Simulation and always lands on passable ground', () => {
    const scenario: ScenarioDef = {
      id: 'wtest', name: 'World test', tagline: '', description: '', lookFor: [],
      config: { disasterRate: 0 }, world: {}, populations: [], scheduled: [],
    };
    const sim = Simulation.create({ scenario, seed: 8 });
    const rng = new Rng(1);
    for (let k = 0; k < 300; k++) {
      const x = rng.next() * sim.worldW;
      const y = rng.next() * sim.worldH;
      const p = findPassableNear(sim, x, y, 2000);
      expect(p).not.toBeNull();
      expect(sim.passableAt(p!.x, p!.y)).toBe(true);
      if (sim.passableAt(x, y)) expect(p).toEqual({ x, y });
    }
  });
});
