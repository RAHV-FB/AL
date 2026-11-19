import { it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { envInt, envStr } from '../scripts/qa-helpers';
const LIST = (envStr('ECO_SCEN') ?? 'two-civs').split(',');
const DAYS = envInt('ECO_DAYS', 15);
it('K with seasons off and no cap', () => {
  for (const id of LIST) {
    const sc = JSON.parse(JSON.stringify(SCENARIOS.find((s) => s.id === id)!));
    sc.scheduled = [];
    const sim = Simulation.create({ scenario: sc, seed: 42, config: { seasons: false, maxAgents: 4000, disasterRate: 0 } });
    const out: string[] = [`=== ${id} (seasons off, cap 4000, no disasters)`];
    let b0 = 0, d0 = 0;
    for (let day = 1; day <= DAYS; day++) {
      for (let t = 0; t < 600; t++) sim.step();
      const s = sim.state;
      let food = 0; for (let i = 0; i < s.world.food.length; i++) food += s.world.food[i];
      let hung = 0; for (const a of s.agents) hung += 1 - a.food / a.traits.maxFood;
      out.push(`day ${day} pop ${s.agents.length} births ${s.stats.totals.births - b0} deaths ${s.stats.totals.deaths - d0} hunger ${(hung / Math.max(1, s.agents.length)).toFixed(2)} food ${(food / 1000).toFixed(1)}k`);
      b0 = s.stats.totals.births; d0 = s.stats.totals.deaths;
    }
    console.log(out.join('\n'));
  }
}, 1800000);
