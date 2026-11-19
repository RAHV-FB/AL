// TEMPORARY review experiment (performance lens) — deleted after the review.
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { getScenario, SCENARIOS } from '../src/sim/presets';
import { NAV, navBudgetLeft, planRoute, sameRegion } from '../src/sim/pathfinding';
import { TERRAIN, TERRAIN_COUNT, type TerrainType } from '../src/sim/types';
import { TERRAIN_INFO } from '../src/sim/constants';

const TS = 8;
const c = (tx: number, ty: number) => ({ x: (tx + 0.5) * TS, y: (ty + 0.5) * TS });

function flatWorld(paint: (tx: number, ty: number) => TerrainType): Simulation {
  const sc = { ...getScenario('eden'), populations: [], scheduled: [] };
  const sim = Simulation.create({ scenario: sc, seed: 3, config: { disasterRate: 0 } });
  const w = sim.state.world;
  for (let ty = 0; ty < w.height; ty++)
    for (let tx = 0; tx < w.width; tx++) {
      const t = paint(tx, ty);
      w.terrain[ty * w.width + tx] = t;
    }
  w.terrainVersion++;
  return sim;
}

/** run one query on a fresh tick (fresh budget); returns status, expansions, ms (median of 5 runs). */
function q(sim: Simulation, s: { x: number; y: number }, g: { x: number; y: number }) {
  const times: number[] = [];
  let res = planRoute(sim, s.x, s.y, g.x, g.y); // warm (builds nav cache)
  for (let k = 0; k < 5; k++) {
    sim.state.tick++;
    const t0 = performance.now();
    res = planRoute(sim, s.x, s.y, g.x, g.y);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { status: res.status, expanded: res.expanded, wp: res.pts.length / 2, ms: times[2], msMax: times[4] };
}

describe('review perf: worst-case planRoute on the 200x125 map', () => {
  it('measures expansions and ms for pathological layouts', () => {
    const out: string[] = [];
    const W = 200;
    const H = 125;
    // warm the JIT on an easy map
    const warm = flatWorld(() => TERRAIN.Grass);
    for (let k = 0; k < 200; k++) {
      warm.state.tick++;
      planRoute(warm, c(5, 5).x, c(5, 5).y, c(150 + (k % 40), 100).x, c(150, 100).y);
    }

    // 1. open grass, corner to corner
    const open = flatWorld(() => TERRAIN.Grass);
    out.push(`open grass corner→corner: ${JSON.stringify(q(open, c(1, 1), c(198, 123)))}`);

    // 2. long vertical wall at x=100, gap only at the bottom (rows 121..124)
    const wall = flatWorld((tx, ty) => (tx === 100 && ty <= 120 ? TERRAIN.Wall : TERRAIN.Grass));
    out.push(`wall x=100 gap at bottom, (90,10)->(110,10): ${JSON.stringify(q(wall, c(90, 10), c(110, 10)))}`);
    out.push(`wall x=100 gap at bottom, (10,10)->(190,10): ${JSON.stringify(q(wall, c(10, 10), c(190, 10)))}`);
    out.push(`wall x=100 gap at bottom, (99,0)->(101,0): ${JSON.stringify(q(wall, c(99, 0), c(101, 0)))}`);

    // 3. U-shaped trap (cup opening away from the goal)
    const cup = flatWorld((tx, ty) =>
      (tx === 140 && ty >= 20 && ty <= 105) || ((ty === 20 || ty === 105) && tx >= 60 && tx <= 140) ? TERRAIN.Wall : TERRAIN.Grass,
    );
    out.push(`cup trap (100,62)->(190,62): ${JSON.stringify(q(cup, c(100, 62), c(190, 62)))}`);

    // 4. serpentine maze: horizontal walls every 10 rows, alternating gap at the ends
    const maze = flatWorld((tx, ty) => {
      if (ty % 10 !== 5) return TERRAIN.Grass;
      const k = (ty - 5) / 10;
      const gapLeft = k % 2 === 0;
      return (gapLeft ? tx > 3 : tx < W - 4) ? TERRAIN.Wall : TERRAIN.Grass;
    });
    out.push(`serpentine maze (100,1)->(100,123): ${JSON.stringify(q(maze, c(100, 1), c(100, 123)))}`);
    out.push(`serpentine maze (100,1)->(100,33): ${JSON.stringify(q(maze, c(100, 1), c(100, 33)))}`);

    // 5. river with one ford (tests' riverWorld), far corners
    const river = flatWorld((tx, ty) => (tx >= 95 && tx <= 104 ? (ty >= 60 && ty <= 62 ? TERRAIN.Water : TERRAIN.DeepWater) : TERRAIN.Grass));
    out.push(`river+ford (20,110)->(180,10): ${JSON.stringify(q(river, c(20, 110), c(180, 10)))}`);
    out.push(`river+ford (90,0)->(110,0): ${JSON.stringify(q(river, c(90, 0), c(110, 0)))}`);

    // 6. a sea of shallows (slow tiles everywhere) with the goal across: cost structure that defeats the heuristic
    const shallow = flatWorld((tx) => (tx >= 20 && tx <= 180 ? TERRAIN.Water : TERRAIN.Grass));
    out.push(`shallows band (5,62)->(195,62): ${JSON.stringify(q(shallow, c(5, 62), c(195, 62)))}`);

    console.log('[perf-worst]\n' + out.join('\n'));
    console.log(`[perf-worst] NAV = ${JSON.stringify(NAV)}; terrain moveCost: ${Array.from({ length: TERRAIN_COUNT }, (_, t) => `${t}:${TERRAIN_INFO[t as TerrainType].passable ? TERRAIN_INFO[t as TerrainType].moveCost : 'X'}`).join(' ')}`);
    expect(out.length).toBeGreaterThan(0);
  });

  it('per-query budget exhaustion is retried at full cost (same query every few ticks)', () => {
    const maze = flatWorld((tx, ty) => {
      if (ty % 10 !== 5) return TERRAIN.Grass;
      const k = (ty - 5) / 10;
      return (k % 2 === 0 ? tx > 3 : tx < 196) ? TERRAIN.Wall : TERRAIN.Grass;
    });
    const s = c(100, 1);
    const g = c(100, 123);
    expect(sameRegion(maze, s.x, s.y, g.x, g.y)).toBe(true);
    let total = 0;
    let ms = 0;
    for (let k = 0; k < 20; k++) {
      maze.state.tick++;
      const t0 = performance.now();
      const r = planRoute(maze, s.x, s.y, g.x, g.y);
      ms += performance.now() - t0;
      total += r.expanded;
      expect(r.status).toBe('budget');
    }
    console.log(`[perf-worst] maze query repeated 20x on fresh ticks: ${total} expansions, ${(ms / 20).toFixed(2)} ms/query, never succeeds; budget left after one query: ${navBudgetLeft(maze)}`);
  });

  it('natural presets: random same-region land pairs — expansions / ms distribution', () => {
    const lines: string[] = [];
    for (const sc of SCENARIOS) {
      const sim = Simulation.create({ scenario: sc, seed: 42 });
      const w = sim.state.world;
      const land: number[] = [];
      for (let i = 0; i < w.width * w.height; i++) if (TERRAIN_INFO[w.terrain[i] as TerrainType].passable) land.push(i);
      let seed = 12345;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
      const exp: number[] = [];
      const msArr: number[] = [];
      let budget = 0;
      let pairs = 0;
      for (let k = 0; k < 400 && pairs < 300; k++) {
        const a = land[Math.floor(rnd() * land.length)];
        const b = land[Math.floor(rnd() * land.length)];
        const ax = ((a % w.width) + 0.5) * TS;
        const ay = (Math.floor(a / w.width) + 0.5) * TS;
        const bx = ((b % w.width) + 0.5) * TS;
        const by = (Math.floor(b / w.width) + 0.5) * TS;
        if (!sameRegion(sim, ax, ay, bx, by)) continue;
        pairs++;
        sim.state.tick++;
        const t0 = performance.now();
        const r = planRoute(sim, ax, ay, bx, by);
        msArr.push(performance.now() - t0);
        exp.push(r.expanded);
        if (r.status === 'budget') budget++;
      }
      exp.sort((x, y) => x - y);
      msArr.sort((x, y) => x - y);
      const p = (arr: number[], f: number) => arr[Math.min(arr.length - 1, Math.floor(f * arr.length))];
      lines.push(
        `${sc.id.padEnd(14)} pairs ${pairs} | expansions p50 ${p(exp, 0.5)} p95 ${p(exp, 0.95)} max ${exp[exp.length - 1]} | ms p50 ${p(msArr, 0.5).toFixed(2)} p95 ${p(msArr, 0.95).toFixed(2)} max ${msArr[msArr.length - 1].toFixed(2)} | 'budget' ${budget}`,
      );
    }
    console.log('[perf-worst] random cross-map routes in the presets (seed 42):\n' + lines.join('\n'));
  });
});

describe('review perf: heap capacity is fixed at cache creation', () => {
  it('raising NAV.queryBudget after the first query overflows the fixed heap (pushes silently dropped)', () => {
    const maze = flatWorld((tx, ty) => {
      if (ty % 10 !== 5) return TERRAIN.Grass;
      const k = (ty - 5) / 10;
      return (k % 2 === 0 ? tx > 3 : tx < 196) ? TERRAIN.Wall : TERRAIN.Grass;
    });
    const s = c(100, 1);
    const g = c(100, 123);
    const q0 = NAV.queryBudget;
    const t0 = NAV.tickBudget;
    try {
      planRoute(maze, s.x, s.y, s.x + 8, s.y); // builds the cache with heap = 8 × 14000 + 16
      NAV.queryBudget = 200000;
      NAV.tickBudget = 400000;
      maze.state.tick++;
      const r1 = planRoute(maze, s.x, s.y, g.x, g.y);
      // a fresh world (cache built while the bigger budget is in force) for comparison
      const maze2 = flatWorld((tx, ty) => {
        if (ty % 10 !== 5) return TERRAIN.Grass;
        const k = (ty - 5) / 10;
        return (k % 2 === 0 ? tx > 3 : tx < 196) ? TERRAIN.Wall : TERRAIN.Grass;
      });
      const r2 = planRoute(maze2, s.x, s.y, g.x, g.y);
      console.log(`[perf-heap] queryBudget raised after cache build: ${r1.status} (${r1.expanded} expansions, ${r1.pts.length / 2} wp) | cache built with the raised budget: ${r2.status} (${r2.expanded} expansions, ${r2.pts.length / 2} wp)`);
    } finally {
      NAV.queryBudget = q0;
      NAV.tickBudget = t0;
    }
  });
});
