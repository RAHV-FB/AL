import { it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { TERRAIN_INFO } from '../src/sim/constants';
import type { TerrainType } from '../src/sim/types';
import { basalBurn } from '../src/sim/genetics';
it('capacity table', () => {
  const rows: string[] = ['id          land  sumCap  sumCapRegen  foodRegen diff  meanBurn  MSY/t(s=1)  K_msy  K_bare(seed) agents0'];
  for (const sc of SCENARIOS) {
    const sim = Simulation.create({ scenario: sc, seed: 42 });
    const w = sim.state.world;
    let land = 0, sc1 = 0, scr = 0, seedSum = 0;
    for (let i = 0; i < w.terrain.length; i++) {
      const info = TERRAIN_INFO[w.terrain[i] as TerrainType];
      if (info.maxFood <= 0) continue;
      land++;
      const cap = info.maxFood * w.fertility[i] * sim.config.foodCapacity;
      sc1 += cap;
      scr += cap * info.regen;
      seedSum += 0.0012 * w.fertility[i] * info.regen;
    }
    let burn = 0;
    for (const a of sim.state.agents) burn += basalBurn(a.traits);
    burn /= Math.max(1, sim.state.agents.length);
    const per = burn * sim.config.difficulty;
    const msy = 0.0055 * sim.config.foodRegen * scr / 4;
    const bare = seedSum * sim.config.foodRegen;
    rows.push(`${sc.id.padEnd(12)} ${String(land).padStart(5)} ${(sc1/1000).toFixed(1).padStart(6)}k ${(scr/1000).toFixed(1).padStart(8)}k  ${sim.config.foodRegen.toFixed(2).padStart(6)} ${sim.config.difficulty.toFixed(2)}  ${per.toFixed(3)}    ${msy.toFixed(0).padStart(6)}  ${(msy/per).toFixed(0).padStart(6)}  ${(bare/per).toFixed(0).padStart(6)}  ${sim.state.agents.length}`);
  }
  console.log(rows.join('\n'));
});
