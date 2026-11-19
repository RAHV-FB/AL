/**
 * Social-state invariants over a real run (agent intelligence / social audit): tribe member counts match
 * the agents, role tallies add up, the territory map only names living tribes on passable land, camps sit
 * on passable ground (also after a wall is painted over one), relationships never point at the dead, and
 * carried food stays within carry capacity.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { getScenario } from '../src/sim/presets';
import { SOCIAL_TUNING, carryCapacity } from '../src/sim/social';
import { NONE, TERRAIN } from '../src/sim/types';

/** First tick a living agent was seen still linked to a dead one ("agent:dead" → tick). */
const deadLinks = new Map<string, number>();

function checkSocial(sim: Simulation, out: string[]): void {
  const s = sim.state;
  const counts = new Map<number, number>();
  for (const a of s.agents) {
    if (a.carried > carryCapacity(a) + 1e-6) out.push(`t${s.tick} agent ${a.id} carries ${a.carried} > ${carryCapacity(a)}`);
    for (const r of a.relationships) {
      if (sim.getAgent(r.id)) continue;
      // one-sided links are pruned by the agent's own maintenance, at most one social period later
      const key = `${a.id}:${r.id}`;
      const first = deadLinks.get(key) ?? s.tick;
      deadLinks.set(key, first);
      if (s.tick - first > SOCIAL_TUNING.agentPeriod) out.push(`t${s.tick} agent ${a.id} still remembers dead ${r.id} (since t${first})`);
    }
    if (a.tribeId === NONE) continue;
    const t = sim.getTribe(a.tribeId);
    if (!t || t.extinctTick !== -1) out.push(`t${s.tick} agent ${a.id} in dead tribe ${a.tribeId}`);
    // members are recounted by the tribe pass (tick % tribePeriod == 0); newborns of that tick join after it
    if (a.birthTick !== s.tick - 1) counts.set(a.tribeId, (counts.get(a.tribeId) ?? 0) + 1);
  }
  for (const t of s.tribes) {
    if (t.extinctTick !== -1) continue;
    if (!sim.passableAt(t.homeX, t.homeY)) out.push(`t${s.tick} camp of tribe ${t.id} on impassable ground`);
    const n = counts.get(t.id) ?? 0;
    if (t.members !== n) out.push(`t${s.tick} tribe ${t.id} members ${t.members} != agents ${n}`);
    const roles = Object.values(t.roles).reduce((x, y) => x + y, 0);
    if (roles !== t.members) out.push(`t${s.tick} tribe ${t.id} roles ${roles} != members ${t.members}`);
  }
  const terr = s.world.territory;
  for (let i = 0; i < terr.length; i++) {
    const id = terr[i];
    if (id === -1) continue;
    const t = sim.getTribe(id);
    if (!t || t.extinctTick !== -1) {
      out.push(`t${s.tick} tile ${i} owned by dead tribe ${id}`);
      break;
    }
  }
}

describe('social invariants over a run', () => {
  it('two-civs (fission, wars, raids): counts, roles, territory, camps, relationships, loads stay valid', () => {
    const sim = Simulation.create({ scenario: getScenario('two-civs'), seed: 7 });
    const out: string[] = [];
    const P = SOCIAL_TUNING.tribePeriod;
    let painted = false;
    for (let t = 0; t < 3000 && out.length < 20; t++) {
      if (!painted && sim.tick === 1500) {
        // wall over a camp: the tribe must move its camp to open ground by its next tribe pass
        const tr = sim.state.tribes.find((x) => x.extinctTick === -1)!;
        sim.enqueue({ kind: 'paintTerrain', x: tr.homeX, y: tr.homeY, radius: 20, terrain: TERRAIN.Wall });
        painted = true;
      }
      sim.step();
      if ((sim.tick - 1) % P === 0 && sim.tick > 1) checkSocial(sim, out);
    }
    expect(out, out.join('\n')).toEqual([]);
  }, 300_000);
});
