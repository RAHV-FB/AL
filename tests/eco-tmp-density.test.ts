import { it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { envStr } from '../scripts/qa-helpers';
const LIST = (envStr('ECO_SCEN') ?? 'eden,two-civs').split(',');
it('density at births', () => {
  for (const id of LIST) {
    const sc = SCENARIOS.find((s) => s.id === id)!;
    const sim = Simulation.create({ scenario: sc, seed: 42 });
    const scratch: any[] = [];
    const add = sim.addAgent.bind(sim);
    let hist: number[] = [];
    sim.addAgent = (a) => {
      if (a.parents[0] !== -1) hist.push(sim.spatial.query(a.x, a.y, 40, scratch).length);
      add(a);
    };
    const out: string[] = [`=== ${id}`];
    for (let day = 1; day <= 7; day++) {
      hist = [];
      for (let t = 0; t < 600; t++) sim.step();
      // population density distribution
      const counts: number[] = [];
      for (const a of sim.state.agents) counts.push(sim.spatial.query(a.x, a.y, 40, scratch, a).length);
      counts.sort((x, y) => x - y);
      hist.sort((x, y) => x - y);
      const q = (arr: number[], p: number) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : -1);
      out.push(`day ${day} pop ${sim.state.agents.length} nbrs(R40) p25/p50/p75/p90 ${q(counts, .25)}/${q(counts, .5)}/${q(counts, .75)}/${q(counts, .9)}  births ${hist.length} birth-nbrs p25/p50/p75/p90 ${q(hist, .25)}/${q(hist, .5)}/${q(hist, .75)}/${q(hist, .9)}`);
    }
    console.log(out.join('\n'));
  }
}, 600000);
