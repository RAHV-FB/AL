/**
 * TEMPORARY dynamics harness (eco auditor) — delete when done.
 *   ECO_SCEN=two-civs,fittest ECO_DAYS=20 ECO_SEED=42 npx vitest run tests/eco-tmp-dyn.test.ts --silent=false
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { DEATH_CAUSES, G, type DeathCause } from '../src/sim/types';
import { envInt, envStr } from '../scripts/qa-helpers';
import { isAdult } from '../src/sim/lifecycle';

const DAYS = envInt('ECO_DAYS', 20);
const SEED = envInt('ECO_SEED', 42);
const LIST = (envStr('ECO_SCEN') ?? 'two-civs').split(',');
const SEASON = ['Sp', 'Su', 'Au', 'Wi'];
const pad = (v: string | number, n: number) => String(v).padStart(n);

describe('eco dynamics harness', () => {
  for (const id of LIST) {
    it(`${id}`, () => {
      const sc = SCENARIOS.find((s) => s.id === id)!;
      const sim = Simulation.create({ scenario: sc, seed: SEED });
      const dl = sim.config.dayLength;
      const dd: Record<DeathCause, number> = Object.fromEntries(DEATH_CAUSES.map((c) => [c, 0])) as Record<DeathCause, number>;
      const kill = sim.killAgent.bind(sim);
      sim.killAgent = (a, c) => {
        if (a.alive) dd[c]++;
        kill(a, c);
      };
      const genes = ['speed', 'size', 'metabolism', 'efficiency', 'fertility', 'longevity', 'immunity', 'aggression', 'perception'] as const;
      const mean = () => {
        const m = genes.map(() => 0);
        for (const a of sim.state.agents) genes.forEach((g, i) => (m[i] += a.genes[G[g]]));
        return m.map((v) => (sim.state.agents.length ? v / sim.state.agents.length : 0));
      };
      const g0 = mean();
      const lines: string[] = [`\n=== ${id} seed ${SEED} cap ${sim.config.maxAgents}`];
      lines.push('day s   pop  juv born  died starv  old fight sick disas  hung  hp   food  ' + genes.map((g) => g.slice(0, 4)).join(' '));
      let b0 = 0;
      let minPop = Infinity;
      let maxPop = 0;
      const pops: number[] = [];
      const t0 = performance.now();
      for (let day = 1; day <= DAYS; day++) {
        let dayMin = Infinity;
        for (let t = 0; t < dl; t++) {
          sim.step();
          if (sim.state.agents.length < dayMin) dayMin = sim.state.agents.length;
        }
        const s = sim.state;
        const n = s.agents.length;
        pops.push(n);
        if (day > 4) {
          minPop = Math.min(minPop, dayMin);
          maxPop = Math.max(maxPop, n);
        }
        let hung = 0;
        let hp = 0;
        let juv = 0;
        for (const a of s.agents) {
          hung += 1 - a.food / a.traits.maxFood;
          hp += a.health / a.traits.maxHealth;
          if (!isAdult(a)) juv++;
        }
        let food = 0;
        for (let i = 0; i < s.world.food.length; i++) food += s.world.food[i];
        const births = s.stats.totals.births - b0;
        b0 = s.stats.totals.births;
        const died = DEATH_CAUSES.reduce((acc, c) => acc + dd[c], 0);
        const m = mean();
        lines.push(
          `${pad(day, 3)} ${SEASON[s.env.season]} ${pad(n, 5)} ${pad(juv, 4)} ${pad(births, 4)} ${pad(died, 5)} ${pad(dd.starvation, 5)} ${pad(dd.old_age, 4)} ${pad(dd.combat, 5)} ${pad(dd.disease, 4)} ${pad(dd.disaster, 5)}` +
            `  ${(n ? hung / n : 0).toFixed(2)} ${(n ? hp / n : 0).toFixed(2)} ${pad((food / 1000).toFixed(1) + 'k', 6)}  ${m.map((v) => v.toFixed(2)).join(' ')}`,
        );
        for (const c of DEATH_CAUSES) dd[c] = 0;
      }
      const g1 = mean();
      const secs = (performance.now() - t0) / 1000;
      lines.push(
        `summary ${id}: final ${sim.state.agents.length} min(d>4) ${minPop} max(d>4) ${maxPop} births ${sim.state.stats.totals.births} ${(secs * 1000 / sim.state.tick).toFixed(2)} ms/tick`,
      );
      lines.push('drift: ' + genes.map((g, i) => `${g} ${g0[i].toFixed(2)}→${g1[i].toFixed(2)}`).join(', '));
      console.log(lines.join('\n'));
      expect(sim.state.tick).toBe(DAYS * dl);
    }, 3_600_000);
  }
});
