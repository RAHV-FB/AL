// TEMPORARY review experiment (performance lens) — deleted after the review.
// Natural preset runs (default population, seed 42): NEW (instrumented working-tree copy) vs BASE (HEAD),
// interleaved per day. Per-tick ms plus routing counters; the worst ticks are attributed.
import { describe, expect, it } from 'vitest';
const SP = '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review';
import { Simulation as InstSim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/simulation';
import { SCENARIOS as INST_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/presets';
import { STATS } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/pathfinding';
import { SSTATS } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/steering';
import { BSTATS } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/inst/src/sim/brain';
import { Simulation as BaseSim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/simulation';
import { SCENARIOS as BASE_SC } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/perf-review/base/src/sim/presets';
void SP;

const DAYS = Number(process.env.LR_DAYS ?? 12);
const ONLY = process.env.LR_ONLY ? process.env.LR_ONLY.split(',') : null;
const SEED = Number(process.env.LR_SEED ?? 42);

function snap() {
  return {
    plans: STATS.plans, exp: STATS.expanded, budget: STATS.budget, refused: STATS.budgetRefused, ok: STATS.ok, unreach: STATS.unreachable,
    builds: STATS.builds, buildMs: STATS.buildMs, planMs: STATS.planMs, same: STATS.sameRegion,
    rw: SSTATS.routeWaypoint, mk: SSTATS.makeRoute, cp: SSTATS.clearPath, cs: SSTATS.clearSamples, mt: SSTATS.moveToward,
    lush: BSTATS.lushness, think: BSTATS.think, pe: BSTATS.pickExplore, trek: BSTATS.trekSet,
  };
}
type Snap = ReturnType<typeof snap>;
const diff = (a: Snap, b: Snap) => Object.fromEntries(Object.keys(a).map((k) => [k, (b as Record<string, number>)[k] - (a as Record<string, number>)[k]])) as Snap;

describe('review perf: natural long runs', () => {
  it('NEW (instrumented) vs BASE per day', () => {
    const out: string[] = [];
    for (let p = 0; p < INST_SC.length; p++) {
      const id = INST_SC[p].id;
      if (ONLY && !ONLY.includes(id)) continue;
      const ns = InstSim.create({ scenario: INST_SC[p], seed: SEED });
      const bs = BaseSim.create({ scenario: BASE_SC[p], seed: SEED });
      const dl = ns.config.dayLength;
      let nWorst = { ms: 0, tick: -1, d: null as Snap | null, agents: 0 };
      let maxExpTick = { exp: 0, tick: -1, ms: 0 };
      let maxPlansTick = { plans: 0, tick: -1, ms: 0, exp: 0 };
      const tot = { n: 0, b: 0 };
      const dayLines: string[] = [];
      let routeAgentsMax = 0;
      let ptsMax = 0;
      let budgetTicks = 0;
      let satTicks = 0;
      for (let day = 0; day < DAYS; day++) {
        // NEW day
        let nMs = 0;
        const s0 = snap();
        for (let k = 0; k < dl; k++) {
          const a = snap();
          const t0 = performance.now();
          ns.step();
          const dt = performance.now() - t0;
          nMs += dt;
          const d = diff(a, snap());
          if (dt > nWorst.ms) nWorst = { ms: dt, tick: ns.state.tick - 1, d, agents: ns.state.agents.length };
          if (d.exp > maxExpTick.exp) maxExpTick = { exp: d.exp, tick: ns.state.tick - 1, ms: dt };
          if (d.plans > maxPlansTick.plans) maxPlansTick = { plans: d.plans, tick: ns.state.tick - 1, ms: dt, exp: d.exp };
          if (d.budget > 0) budgetTicks++;
          if (d.exp >= 29000) satTicks++;
        }
        const dd = diff(s0, snap());
        let routed = 0;
        let pts = 0;
        for (const ag of ns.state.agents) {
          if (ag.route && ag.route.pts.length) routed++;
          if (ag.route) pts += ag.route.pts.length;
        }
        routeAgentsMax = Math.max(routeAgentsMax, routed);
        ptsMax = Math.max(ptsMax, pts);
        // BASE day
        let bMs = 0;
        for (let k = 0; k < dl; k++) {
          const t0 = performance.now();
          bs.step();
          bMs += performance.now() - t0;
        }
        tot.n += nMs;
        tot.b += bMs;
        dayLines.push(
          `  day ${String(day + 1).padStart(2)}: NEW ${ns.state.agents.length} agents ${(nMs / dl).toFixed(2)} ms/tick | BASE ${bs.state.agents.length} agents ${(bMs / dl).toFixed(2)} ms/tick | ` +
            `plans ${dd.plans} (ok ${dd.ok}, unreach ${dd.unreach}, budget ${dd.budget}/refused ${dd.refused}) exp ${dd.exp} planMs ${dd.planMs.toFixed(1)} builds ${dd.builds} | ` +
            `routeWaypoint ${dd.rw} makeRoute ${dd.mk} clearPath ${dd.cp} (samples ${dd.cs}) sameRegion ${dd.same} lushness ${dd.lush} think ${dd.think} treks ${dd.trek} | routed agents now ${routed}, pts ${pts}`,
        );
      }
      out.push(
        `${id}: NEW mean ${(tot.n / (DAYS * dl)).toFixed(2)} ms/tick vs BASE ${(tot.b / (DAYS * dl)).toFixed(2)} (×${(tot.n / tot.b).toFixed(3)}); ` +
          `NEW worst tick ${nWorst.tick} ${nWorst.ms.toFixed(2)} ms (${nWorst.agents} agents) counters ${JSON.stringify(nWorst.d)}; ` +
          `max expansions/tick ${maxExpTick.exp} at tick ${maxExpTick.tick} (${maxExpTick.ms.toFixed(2)} ms); max plans/tick ${maxPlansTick.plans} at tick ${maxPlansTick.tick} (${maxPlansTick.ms.toFixed(2)} ms, ${maxPlansTick.exp} exp); ` +
          `ticks with a 'budget' result ${budgetTicks}, ticks ≥29k expansions ${satTicks}; max routed agents ${routeAgentsMax}, max total pts ${ptsMax}\n` +
          dayLines.join('\n'),
      );
      console.log(out[out.length - 1]);
    }
    console.log('[perf-long]\n' + out.join('\n'));
    expect(out.length).toBeGreaterThan(0);
  }, 3_000_000);
});
