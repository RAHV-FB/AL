/**
 * Balance report (QA-owned) — the team's headless balancing tool. NEVER fails on
 * balance; it only asserts that nothing throws. Prints one table per scenario with
 * one row per in-game day (dayLength from the scenario's config).
 *
 *   npx vitest run tests/balance.report.test.ts
 *   AL_BALANCE_DAYS=20 AL_BALANCE_SCENARIO=eden AL_SEED=7 npx vitest run tests/balance.report.test.ts
 *
 * Columns: pop, births, deaths (total + by cause: starv/old/fight/sick/disas/remov), living tribes,
 * mean generation, avg hunger (1 - food/maxFood), total world food, mean genes speed/size/aggr/social.
 * Deaths by cause are counted by wrapping sim.killAgent, so they never depend on the stats module.
 * The summary adds the lowest population after the peak (a crash shows up as a deep trough) and the
 * drift of every gene mean from day 0 to the last day (evolution under the scenario's pressures).
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { DEATH_CAUSES, G, GENES, GENE_COUNT, type DeathCause } from '../src/sim/types';
import { envInt, envStr } from '../scripts/qa-helpers';

const DAYS = envInt('AL_BALANCE_DAYS', 12);
const SEED = envInt('AL_SEED', 42);
const ONLY = envStr('AL_BALANCE_SCENARIO');

const CAUSE_LABEL: Record<DeathCause, string> = { starvation: 'starv', old_age: 'old', combat: 'fight', disease: 'sick', disaster: 'disas', removed: 'remov' };

const pad = (v: string | number, n: number) => String(v).padStart(n);
const fmtFood = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0));

describe('balance report (informational)', () => {
  for (const sc of SCENARIOS.filter((s) => !ONLY || s.id === ONLY)) {
    it(`${sc.id}: ${DAYS} in-game days`, () => {
      const sim = Simulation.create({ scenario: sc, seed: SEED });
      const dayLength = sim.config.dayLength;

      // Count deaths by cause independently of stats.ts.
      const dayDeaths: Record<DeathCause, number> = Object.fromEntries(DEATH_CAUSES.map((c) => [c, 0])) as Record<DeathCause, number>;
      const kill = sim.killAgent.bind(sim);
      sim.killAgent = (agent, cause) => {
        if (agent.alive) dayDeaths[cause]++;
        kill(agent, cause);
      };

      const header =
        `${pad('day', 3)} ${pad('pop', 5)} ${pad('born', 5)} ${pad('died', 5)} ` +
        DEATH_CAUSES.map((c) => pad(CAUSE_LABEL[c], 5)).join(' ') +
        ` ${pad('tribe', 5)} ${pad('gen', 5)} ${pad('hungr', 5)} ${pad('food', 7)} ${pad('spd', 4)} ${pad('size', 4)} ${pad('aggr', 4)} ${pad('soc', 4)}  events`;
      const lines: string[] = [
        `\n=== ${sc.id} — ${sc.name} (seed ${SEED}, dayLength ${dayLength}, maxAgents ${sim.config.maxAgents}) ===`,
        header,
        '-'.repeat(header.length),
      ];
      const t0 = performance.now();
      let births0 = sim.state.stats.totals.births;
      let peak = sim.state.agents.length;
      let peakDay = 0;
      let troughAfterPeak = peak;
      let troughDay = 0;
      let extinctDay = -1;
      const geneMeans = (): number[] => {
        const m = new Array<number>(GENE_COUNT).fill(0);
        for (const a of sim.state.agents) for (let g = 0; g < GENE_COUNT; g++) m[g] += a.genes[g];
        return m.map((v) => (sim.state.agents.length ? v / sim.state.agents.length : NaN));
      };
      const genes0 = geneMeans();

      const row = (day: number, births: number) => {
        const s = sim.state;
        const ag = s.agents;
        const n = ag.length;
        let gen = 0, hunger = 0, spd = 0, size = 0, aggr = 0, soc = 0;
        for (const a of ag) {
          gen += a.generation;
          hunger += 1 - a.food / Math.max(1e-9, a.traits.maxFood);
          spd += a.genes[G.speed];
          size += a.genes[G.size];
          aggr += a.genes[G.aggression];
          soc += a.genes[G.sociability];
        }
        const m = (v: number) => (n ? (v / n).toFixed(2) : '  - ');
        let food = 0;
        for (let i = 0; i < s.world.food.length; i++) food += s.world.food[i];
        const died = DEATH_CAUSES.reduce((acc, c) => acc + dayDeaths[c], 0);
        const tribes = s.tribes.filter((t) => t.extinctTick === -1).length;
        const evs = s.events.filter((e) => e.tick >= s.tick - dayLength && (e.severity === 'major' || e.severity === 'bad')).length;
        lines.push(
          `${pad(day, 3)} ${pad(n, 5)} ${pad(births, 5)} ${pad(died, 5)} ` +
            DEATH_CAUSES.map((c) => pad(dayDeaths[c], 5)).join(' ') +
            ` ${pad(tribes, 5)} ${pad(n ? (gen / n).toFixed(1) : '-', 5)} ${pad(m(hunger), 5)} ${pad(fmtFood(food), 7)}` +
            ` ${pad(m(spd), 4)} ${pad(m(size), 4)} ${pad(m(aggr), 4)} ${pad(m(soc), 4)}  ${evs ? `${evs} bad/major` : ''}`,
        );
        for (const c of DEATH_CAUSES) dayDeaths[c] = 0;
      };

      row(0, 0);
      for (let day = 1; day <= DAYS; day++) {
        for (let t = 0; t < dayLength; t++) {
          sim.step();
          const n = sim.state.agents.length;
          if (n > peak) {
            peak = n;
            peakDay = day;
            troughAfterPeak = n;
            troughDay = day;
          } else if (n < troughAfterPeak) {
            troughAfterPeak = n;
            troughDay = day;
          }
        }
        const births = sim.state.stats.totals.births - births0;
        births0 = sim.state.stats.totals.births;
        row(day, births);
        if (sim.state.agents.length === 0 && extinctDay < 0) extinctDay = day;
      }
      const s = sim.state;
      const maxGen = s.agents.reduce((m, a) => Math.max(m, a.generation), 0);
      const secs = (performance.now() - t0) / 1000;
      const genes1 = geneMeans();
      lines.push(
        `summary: final pop ${s.agents.length}, peak ${peak} (day ${peakDay}), lowest after peak ${troughAfterPeak} (day ${troughDay}), ` +
          `total births ${s.stats.totals.births}, deaths ${s.stats.totals.deaths}, ` +
          `max generation ${maxGen}, tribes ever ${s.nextTribeId - 1}, ` +
          `${extinctDay > 0 ? `EXTINCT on day ${extinctDay}, ` : ''}${secs.toFixed(1)}s (${((secs * 1000) / Math.max(1, s.tick)).toFixed(2)} ms/tick)`,
      );
      lines.push('gene drift (day 0 → end): ' + GENES.map((g, i) => `${g} ${genes0[i].toFixed(2)}→${genes1[i].toFixed(2)}`).join(', '));
      const recent = s.events.filter((e) => e.severity === 'major').slice(-5);
      if (recent.length) lines.push('last major events: ' + recent.map((e) => `[t${e.tick}] ${e.message}`).join(' | '));
      console.log(lines.join('\n'));

      expect(s.tick).toBe(DAYS * dayLength);
    }, 1_800_000);
  }
});
