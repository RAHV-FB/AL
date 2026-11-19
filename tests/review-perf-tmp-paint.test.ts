// TEMPORARY review experiment (performance lens) — deleted after the review.
// Nav-cache rebuild cost, and the cost of terrain painting (each stamp bumps world.terrainVersion).
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { getScenario, SCENARIOS } from '../src/sim/presets';
import { regionAt, sameRegion } from '../src/sim/pathfinding';
import { moveToward } from '../src/sim/steering';
import { createAgent } from '../src/sim/lifecycle';
import { randomGenes } from '../src/sim/genetics';
import { TERRAIN, type Agent, type TerrainType } from '../src/sim/types';
import { Simulation as InstSim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/simulation';
import { getScenario as instScenario } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/presets';
import { STATS } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/pathfinding';
import { SSTATS, moveToward as instMoveToward } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/steering';
import { createAgent as instCreateAgent } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/lifecycle';
import { randomGenes as instRandomGenes } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/genetics';
import { Simulation as BaseSim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/simulation';
import { SCENARIOS as BASE_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/presets';

const TS = 8;
type AnySim = { step(): void; enqueue(iv: unknown): void; state: { tick: number; agents: unknown[]; world: { terrainVersion: number } }; worldW: number; worldH: number };

function stats(times: number[]) {
  const s = [...times].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `mean ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(3)} p50 ${q(0.5).toFixed(3)} p95 ${q(0.95).toFixed(3)} max ${s[s.length - 1].toFixed(3)}`;
}

function fill(sim: AnySim, target = 1000): void {
  const W = sim.worldW;
  const H = sim.worldH;
  const spots: [number, number][] = [];
  for (let gy = 1; gy <= 3; gy++) for (let gx = 1; gx <= 4; gx++) spots.push([(W * gx) / 5, (H * gy) / 4]);
  for (let round = 0; round < 8 && sim.state.agents.length < target * 0.95; round++) {
    const need = target - sim.state.agents.length;
    spots.forEach(([x, y], i) => {
      sim.enqueue({ kind: 'spawn', x, y, count: Math.ceil(need / spots.length), radius: 110, tribe: i % 2 === 0 && round === 0 ? 'new' : 'none' });
    });
    sim.step();
  }
}

describe('review perf: nav rebuilds and painting', () => {
  it('A. nav-cache rebuild cost on each preset map (200x125)', () => {
    const lines: string[] = [];
    for (const sc of SCENARIOS) {
      const sim = Simulation.create({ scenario: sc, seed: 42 });
      const t0 = performance.now();
      regionAt(sim, 10, 10);
      const first = performance.now() - t0;
      const times: number[] = [];
      for (let k = 0; k < 200; k++) {
        sim.state.world.terrainVersion++;
        const t1 = performance.now();
        sameRegion(sim, 10, 10, 1500, 900);
        times.push(performance.now() - t1);
      }
      lines.push(`${sc.id.padEnd(14)} first build ${first.toFixed(2)} ms; rebuild ${stats(times)} ms`);
    }
    console.log('[perf-paint] A. nav rebuilds\n' + lines.join('\n'));
    expect(lines.length).toBe(SCENARIOS.length);
  });

  it('B. ~1000 agents (two-civs and plague-island): ticks with a paint stamp every tick vs no paint, NEW vs BASE', () => {
    const out: string[] = [];
    for (const id of ['two-civs', 'plague-island', 'eden']) {
      const p = SCENARIOS.findIndex((s) => s.id === id);
      const nsim = Simulation.create({ scenario: SCENARIOS[p], seed: 31337, config: { maxAgents: 1000 } }) as unknown as AnySim;
      const isim = InstSim.create({ scenario: instScenario(id), seed: 31337, config: { maxAgents: 1000 } }) as unknown as AnySim;
      const bsim = BaseSim.create({ scenario: BASE_SC[p], seed: 31337, config: { maxAgents: 1000 } }) as unknown as AnySim;
      const sims = [
        { name: 'NEW', sim: nsim, idle: [] as number[], paint: [] as number[] },
        { name: 'INST', sim: isim, idle: [] as number[], paint: [] as number[] },
        { name: 'BASE', sim: bsim, idle: [] as number[], paint: [] as number[] },
      ];
      for (const s of sims) {
        fill(s.sim);
        for (let k = 0; k < 300; k++) s.sim.step();
      }
      let idlePlans = 0, idleExp = 0, idleMk = 0, idleBuilds = 0, idleBudget = 0;
      let paintPlans = 0, paintExp = 0, paintMk = 0, paintBuilds = 0, paintBudget = 0, paintCs = 0, idleCs = 0;
      let stamp = 0;
      for (let round = 0; round < 4; round++) {
        for (const phase of ['idle', 'paint'] as const) {
          for (const s of sims) {
            const a0 = { plans: STATS.plans, exp: STATS.expanded, mk: SSTATS.makeRoute, builds: STATS.builds, budget: STATS.budget, cs: SSTATS.clearSamples };
            for (let k = 0; k < 50; k++) {
              if (phase === 'paint') {
                // a user dragging a small brush in a far corner: alternate sand/grass so every stamp changes tiles
                s.sim.enqueue({ kind: 'paintTerrain', x: 40 + (k % 5) * 6, y: 40, radius: 12, terrain: (stamp + k) % 2 === 0 ? TERRAIN.Sand : TERRAIN.Grass });
              }
              const t0 = performance.now();
              s.sim.step();
              (phase === 'paint' ? s.paint : s.idle).push(performance.now() - t0);
            }
            if (s.name === 'INST') {
              const d = { plans: STATS.plans - a0.plans, exp: STATS.expanded - a0.exp, mk: SSTATS.makeRoute - a0.mk, builds: STATS.builds - a0.builds, budget: STATS.budget - a0.budget, cs: SSTATS.clearSamples - a0.cs };
              if (phase === 'paint') { paintPlans += d.plans; paintExp += d.exp; paintMk += d.mk; paintBuilds += d.builds; paintBudget += d.budget; paintCs += d.cs; }
              else { idlePlans += d.plans; idleExp += d.exp; idleMk += d.mk; idleBuilds += d.builds; idleBudget += d.budget; idleCs += d.cs; }
            }
          }
          stamp++;
        }
      }
      for (const s of sims) out.push(`${id.padEnd(14)} ${s.name.padEnd(4)} agents ${s.sim.state.agents.length}: no paint ${stats(s.idle)} | paint stamp each tick ${stats(s.paint)}`);
      out.push(`${id.padEnd(14)} INST counters per 200 ticks: no paint plans ${idlePlans} exp ${idleExp} makeRoute ${idleMk} builds ${idleBuilds} budget ${idleBudget} clearPath samples ${idleCs} | paint plans ${paintPlans} exp ${paintExp} makeRoute ${paintMk} builds ${paintBuilds} budget ${paintBudget} clearPath samples ${paintCs}`);
      console.log(out.slice(-4).join('\n'));
    }
    console.log('[perf-paint] B\n' + out.join('\n'));
  }, 600_000);

  it('C. worst case: 1000 agents all following cross-river routes; a far-away stamp each tick re-plans them all', () => {
    const mk = (S: typeof Simulation | typeof InstSim, scen: typeof getScenario, cA: typeof createAgent, rg: typeof randomGenes, mv: typeof moveToward) => {
      const sc = { ...scen('eden'), populations: [], scheduled: [] };
      const sim = (S as typeof Simulation).create({ scenario: sc, seed: 3, config: { disasterRate: 0, maxAgents: 2000 } });
      const w = sim.state.world;
      for (let ty = 0; ty < w.height; ty++)
        for (let tx = 0; tx < w.width; tx++) {
          let t: TerrainType = TERRAIN.Grass;
          if (tx >= 95 && tx <= 104) t = (ty >= 30 && ty <= 32) || (ty >= 90 && ty <= 92) ? TERRAIN.Water : TERRAIN.DeepWater;
          w.terrain[ty * w.width + tx] = t;
        }
      w.terrainVersion++;
      const agents: Agent[] = [];
      const goals: number[] = [];
      let seed = 99;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
      for (let k = 0; k < 1000; k++) {
        const x = (10 + rnd() * 80) * TS;
        const y = (2 + rnd() * 120) * TS;
        const genes = rg(sim.rng, { speed: 0.6, perception: 0.9, spread: 0.01 });
        const a = cA(sim, { x, y, genes, age: 2000, food: 120 });
        sim.addAgent(a);
        agents.push(a);
        goals.push((110 + rnd() * 80) * TS, (2 + rnd() * 120) * TS);
      }
      const tick = () => {
        for (let k = 0; k < agents.length; k++) {
          const a = agents[k];
          if (mv(sim, a, goals[2 * k], goals[2 * k + 1], 1, 3)) {
            // arrived: send it back west
            goals[2 * k] = (10 + rnd() * 80) * TS;
            goals[2 * k + 1] = (2 + rnd() * 120) * TS;
          }
          a.energy = 1;
        }
        sim.state.tick++;
      };
      return { sim, agents, tick };
    };
    const lines: string[] = [];
    for (const variant of ['NEW', 'INST'] as const) {
      const v = variant === 'NEW' ? mk(Simulation, getScenario, createAgent, randomGenes, moveToward) : mk(InstSim as unknown as typeof Simulation, instScenario as typeof getScenario, instCreateAgent as unknown as typeof createAgent, instRandomGenes as unknown as typeof randomGenes, instMoveToward as unknown as typeof moveToward);
      const first: number[] = [];
      for (let t = 0; t < 30; t++) {
        const t0 = performance.now();
        v.tick();
        first.push(performance.now() - t0);
      }
      const steady: number[] = [];
      const s0 = { plans: STATS.plans, exp: STATS.expanded, budget: STATS.budget, refused: STATS.budgetRefused };
      for (let t = 0; t < 100; t++) {
        const t0 = performance.now();
        v.tick();
        steady.push(performance.now() - t0);
      }
      const s1 = { plans: STATS.plans, exp: STATS.expanded, budget: STATS.budget, refused: STATS.budgetRefused };
      let routed = 0;
      for (const a of v.agents) if (a.route && a.route.pts.length) routed++;
      const painting: number[] = [];
      const w = v.sim.state.world;
      for (let t = 0; t < 100; t++) {
        // one stamp far from everyone, land→land (passability unchanged)
        const i = 2 * w.width + 2 + (t % 4);
        w.terrain[i] = w.terrain[i] === TERRAIN.Grass ? TERRAIN.Sand : TERRAIN.Grass;
        w.terrainVersion++;
        const t0 = performance.now();
        v.tick();
        painting.push(performance.now() - t0);
      }
      const s2 = { plans: STATS.plans, exp: STATS.expanded, budget: STATS.budget, refused: STATS.budgetRefused };
      let routed2 = 0;
      let fail2 = 0;
      for (const a of v.agents) {
        if (a.route && a.route.pts.length) routed2++;
        if (a.route && a.route.fail) fail2++;
      }
      lines.push(
        `${variant}: first 30 ticks ${stats(first)} | steady 100 ticks ${stats(steady)} (agents on waypoint routes ${routed}) | stamp every tick ${stats(painting)} (on waypoint routes after ${routed2}, fail ${fail2})` +
          (variant === 'INST'
            ? `\n   INST counters: steady plans ${s1.plans - s0.plans} exp ${s1.exp - s0.exp} budget ${s1.budget - s0.budget} (refused ${s1.refused - s0.refused}) | painting plans ${s2.plans - s1.plans} exp ${s2.exp - s1.exp} budget ${s2.budget - s1.budget} (refused ${s2.refused - s1.refused})`
            : ''),
      );
    }
    console.log('[perf-paint] C\n' + lines.join('\n'));
  }, 600_000);
});
