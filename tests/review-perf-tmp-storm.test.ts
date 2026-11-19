// TEMPORARY review experiment (performance lens) — deleted after the review.
// Retry storms: a goal reachable (same region) but costlier than NAV.queryBudget is re-searched at full cost
// every budgetRetry (3 + id % 4) ticks, forever; it saturates the shared tick budget and starves other agents.
import { describe, expect, it } from 'vitest';
import { Simulation } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/simulation';
import { getScenario } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/presets';
import { STATS, sameRegion } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/pathfinding';
import { moveToward } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/steering';
import { createAgent } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/lifecycle';
import { randomGenes } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/genetics';
import { TERRAIN, type Agent, type TerrainType } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/types';

const TS = 8;
const c = (tx: number, ty: number) => ({ x: (tx + 0.5) * TS, y: (ty + 0.5) * TS });

/**
 * West part (x < 95): serpentine walls (horizontal walls every 10 rows, gaps alternating at x 0..3 / 91..94)
 * plus the right edge x=95 walled except a gap at the bottom; east part: a river (x 120..129) with a ford.
 */
function world(paint: (tx: number, ty: number) => TerrainType) {
  const sc = { ...getScenario('eden'), populations: [], scheduled: [] };
  const sim = Simulation.create({ scenario: sc, seed: 3, config: { disasterRate: 0, maxAgents: 3000 } });
  const w = sim.state.world;
  for (let ty = 0; ty < w.height; ty++)
    for (let tx = 0; tx < w.width; tx++) {
      const t = paint(tx, ty);
      const i = ty * w.width + tx;
      w.terrain[i] = t;
      w.fertility[i] = w.baseFertility[i] = t === TERRAIN.Grass ? 1 : 0;
      w.food[i] = t === TERRAIN.Grass ? 8 : 0;
    }
  w.terrainVersion++;
  return sim;
}

const mazeAndRiver = (tx: number, ty: number): TerrainType => {
  if (tx >= 120 && tx <= 129) return ty >= 60 && ty <= 62 ? TERRAIN.Water : TERRAIN.DeepWater;
  if (tx === 95) return ty >= 121 ? TERRAIN.Grass : TERRAIN.Wall;
  if (tx < 95 && ty % 10 === 5) {
    const k = (ty - 5) / 10;
    return (k % 2 === 0 ? tx > 3 : tx < 91) ? TERRAIN.Wall : TERRAIN.Grass;
  }
  return TERRAIN.Grass;
};

function add(sim: Simulation, x: number, y: number): Agent {
  const genes = randomGenes(sim.rng, { speed: 0.6, perception: 0.9, spread: 0.01 });
  const a = createAgent(sim, { x, y, genes, age: 2000, food: 120 });
  sim.addAgent(a);
  return a;
}

describe('review perf: retry storms', () => {
  it('k agents with an over-budget goal + 60 ordinary river crossers: per-tick expansions and how long crossers wait for a route', () => {
    const lines: string[] = [];
    for (const k of [0, 1, 3, 6]) {
      const sim = world(mazeAndRiver);
      const movers: { a: Agent; gx: number; gy: number; firstRoute: number }[] = [];
      // maze agents: in the top corridor of the maze, heading east of the maze wall (goal at (105, 10))
      for (let j = 0; j < k; j++) {
        const s = c(40 + j * 3, 1);
        const g = c(105, 10);
        movers.push({ a: add(sim, s.x, s.y), gx: g.x, gy: g.y, firstRoute: -1 });
      }
      const crossers: typeof movers = [];
      let seed = 7;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
      for (let j = 0; j < 60; j++) {
        const s = c(100 + Math.floor(rnd() * 18), 5 + Math.floor(rnd() * 115));
        const g = c(135 + Math.floor(rnd() * 60), 5 + Math.floor(rnd() * 115));
        crossers.push({ a: add(sim, s.x, s.y), gx: g.x, gy: g.y, firstRoute: -1 });
      }
      if (k > 0) expect(sameRegion(sim, movers[0].a.x, movers[0].a.y, movers[0].gx, movers[0].gy)).toBe(true);
      const perTickExp: number[] = [];
      const perTickMs: number[] = [];
      let budgetStatuses = 0;
      const p0 = STATS.plans;
      for (let t = 0; t < 400; t++) {
        const e0 = STATS.expanded;
        const b0 = STATS.budget;
        const t0 = performance.now();
        for (const m of [...movers, ...crossers]) {
          moveToward(sim, m.a, m.gx, m.gy, 1, 3);
          m.a.energy = 1;
          if (m.firstRoute < 0 && m.a.route && m.a.route.pts.length > 0) m.firstRoute = t;
        }
        perTickMs.push(performance.now() - t0);
        perTickExp.push(STATS.expanded - e0);
        budgetStatuses += STATS.budget - b0;
        sim.state.tick++;
      }
      const waits = crossers.map((m) => (m.firstRoute < 0 ? 400 : m.firstRoute)).sort((x, y) => x - y);
      const sat = perTickExp.filter((e) => e >= 29000).length;
      const meanExp = perTickExp.reduce((x, y) => x + y, 0) / perTickExp.length;
      const meanMs = perTickMs.reduce((x, y) => x + y, 0) / perTickMs.length;
      const maxMs = Math.max(...perTickMs);
      const mazeRouted = movers.filter((m) => m.firstRoute >= 0).length;
      lines.push(
        `${k} over-budget agents: mean ${meanExp.toFixed(0)} expansions/tick, ${sat}/400 ticks saturated (≥29k), mean ${meanMs.toFixed(2)} ms/tick (max ${maxMs.toFixed(2)}) for ${k + 60} moveToward calls/tick; ` +
          `'budget' results ${budgetStatuses}, plans ${STATS.plans - p0}; maze agents that ever got a route ${mazeRouted}/${k}; ` +
          `crossers' wait for a first route (ticks): p50 ${waits[30]} p90 ${waits[54]} max ${waits[59]}; never routed ${waits.filter((x) => x === 400).length}`,
      );
    }
    console.log('[perf-storm]\n' + lines.join('\n'));
  }, 600_000);
});

describe('review perf: brain-driven storm (hungry band in a user-built maze)', () => {
  it('12 starving migrants: maze (route > queryBudget) vs open world with the same food layout', () => {
    const fullMaze = (tx: number, ty: number): TerrainType => {
      if (ty % 10 !== 5) return TERRAIN.Grass;
      const k = (ty - 5) / 10;
      return (k % 2 === 0 ? tx > 3 : tx < 196) ? TERRAIN.Wall : TERRAIN.Grass;
    };
    const lines: string[] = [];
    for (const [name, layout] of [['maze', fullMaze], ['open', () => TERRAIN.Grass as TerrainType]] as const) {
      const sim = world(layout);
      const w = sim.state.world;
      for (let ty = 0; ty < w.height; ty++)
        for (let tx = 0; tx < w.width; tx++) {
          const i = ty * w.width + tx;
          if (ty < 116) {
            w.food[i] = 0;
            w.fertility[i] = w.baseFertility[i] = 0.01;
          } else if (w.terrain[i] === TERRAIN.Grass) w.food[i] = 10;
        }
      const band: Agent[] = [];
      const N = Number(process.env.STORM_N ?? 12);
      for (let j = 0; j < N; j++) {
        const p = c(10 + ((j * 7) % 180), 1 + (j % 4));
        const a = add(sim, p.x, p.y);
        a.food = a.traits.maxFood * 0.45;
        band.push(a);
      }
      const s0 = { plans: STATS.plans, exp: STATS.expanded, budget: STATS.budget, refused: STATS.budgetRefused, ok: STATS.ok };
      const ms: number[] = [];
      let sat = 0;
      let maxExp = 0;
      let treks = 0;
      const T = Number(process.env.STORM_T ?? 3000);
      for (let t = 0; t < T; t++) {
        const e0 = STATS.expanded;
        const t0 = performance.now();
        sim.step();
        ms.push(performance.now() - t0);
        const e = STATS.expanded - e0;
        if (e >= 29000) sat++;
        if (e > maxExp) maxExp = e;
        if (t % 100 === 0) treks += band.filter((a) => a.alive && a.trek).length;
      }
      const alive = band.filter((a) => a.alive).length;
      const reached = band.filter((a) => a.alive && a.y > 116 * TS).length;
      const sorted = [...ms].sort((x, y) => x - y);
      lines.push(
        `${name}: ${(ms.reduce((x, y) => x + y, 0) / ms.length).toFixed(3)} ms/tick mean, p95 ${sorted[Math.floor(0.95 * sorted.length)].toFixed(3)}, max ${sorted[sorted.length - 1].toFixed(2)} | ` +
          `plans ${STATS.plans - s0.plans} (ok ${STATS.ok - s0.ok}, budget ${STATS.budget - s0.budget}, refused ${STATS.budgetRefused - s0.refused}), expansions ${STATS.expanded - s0.exp}, ` +
          `ticks ≥29k expansions ${sat}/${T}, max expansions in one tick ${maxExp} | trek-holding samples ${treks} | alive ${alive}/${N}, reached the lush corridor ${reached}`,
      );
    }
    console.log('[perf-storm2]\n' + lines.join('\n'));
  }, 600_000);
});
