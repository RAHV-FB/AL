/**
 * Two Civilizations raids (owner: raids workstream). By default the Crimson Raiders cross the river at the fords and
 * raid the Verdant Foragers: the preset declares an old rivalry (at war from the start, cooling only slowly), raiders
 * commit to the march (a raid trek that holds through the night) and plunder the foragers' stockpile, and neither
 * people is wiped out. A save taken in the middle of a raid continues exactly like the original run.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { getScenario } from '../src/sim/presets';
import { deserializeState, serializeSim } from '../src/sim/persistence';
import { SOCIAL_TUNING, areRivals } from '../src/sim/social';
import { raidLeg } from '../src/sim/brain';
import type { Agent, Tribe } from '../src/sim/types';

/** The founding tribe a tribe descends from (daughter tribes keep their parent's people). */
function founding(sim: Simulation, t: Tribe | undefined): string {
  let cur = t;
  for (let guard = 0; cur && cur.parentTribeId !== -1 && guard < 64; guard++) {
    const p = sim.getTribe(cur.parentTribeId);
    if (!p) break;
    cur = p;
  }
  return cur ? cur.name : '';
}

const raiderSide = (sim: Simulation, a: Agent) => a.tribeId !== -1 && founding(sim, sim.getTribe(a.tribeId)) === 'Crimson Raiders';
const foragerSide = (sim: Simulation, a: Agent) => a.tribeId !== -1 && founding(sim, sim.getTribe(a.tribeId)) === 'Verdant Foragers';

/** Raid events in which a raider tribe plundered a forager tribe. */
function raidsOnForagers(sim: Simulation): { tick: number; message: string }[] {
  return sim.state.events.filter((e) => {
    const m = /^Raiders of (.+) plundered the stockpile of (.+)\.$/.exec(e.message);
    if (!m || e.tribeId === undefined) return false;
    const target = sim.state.tribes.find((t) => m[2] === t.name || m[2] === `the ${t.name}`);
    return founding(sim, sim.getTribe(e.tribeId)) === 'Crimson Raiders' && founding(sim, target) === 'Verdant Foragers';
  });
}

// V8 shape check for trek objects (needs --allow-natives-syntax, set in vitest.config.ts)
type Native = (a: object, b: object) => boolean;
let sameMap: Native | null = null;
try {
  sameMap = new Function('a', 'b', 'return %HaveSameMap(a, b)') as Native;
} catch {
  sameMap = null;
}

describe('Two Civilizations: the raiders cross the fords and raid by default', () => {
  it('seed 42: within 12 days raiders cross east to west, plunder the foragers several times, and both peoples survive', () => {
    const sim = Simulation.create({ scenario: getScenario('two-civs'), seed: 42 });
    const raiders = sim.state.tribes.find((t) => t.name === 'Crimson Raiders')!;
    const foragers = sim.state.tribes.find((t) => t.name === 'Verdant Foragers')!;
    // the old rivalry: at war from the first tick, announced, and marked as a slow-cooling rivalry
    expect(raiders.relations[foragers.id]).toBeLessThan(SOCIAL_TUNING.warDeclare);
    expect(foragers.relations[raiders.id]).toBeLessThan(SOCIAL_TUNING.warDeclare);
    expect(areRivals(sim, raiders.id, foragers.id)).toBe(true);
    expect(sim.state.events.map((e) => e.message)).toContain('War: the Crimson Raiders and the Verdant Foragers are now at war.');

    // a crossing: a raider seen east of the river (x > 895) and later west of it (x < 715)
    const wasEast = new Set<number>();
    const crossed = new Set<number>();
    let crossings = 0;
    let firstCrossing = -1;
    for (let t = 0; t < 12 * 600; t++) {
      sim.step();
      for (const a of sim.state.agents) {
        if (!a.alive || !raiderSide(sim, a)) continue;
        if (a.x > 895) wasEast.add(a.id);
        else if (a.x < 715 && wasEast.delete(a.id)) {
          crossings++;
          crossed.add(a.id);
          if (firstCrossing < 0) firstCrossing = sim.tick;
        }
      }
    }
    const raids = raidsOnForagers(sim);
    const foragersAlive = sim.state.agents.filter((a) => foragerSide(sim, a)).length;
    const raidersAlive = sim.state.agents.filter((a) => raiderSide(sim, a)).length;
    expect(crossings, 'raider crossings east to west').toBeGreaterThanOrEqual(10);
    expect(crossed.size).toBeGreaterThanOrEqual(10);
    expect(firstCrossing, 'the first raiders reach the west bank within 3 days').toBeLessThan(3 * 600);
    expect(raids.length, 'raid events against forager tribes').toBeGreaterThanOrEqual(3);
    expect(foragersAlive, 'the foragers are not wiped out').toBeGreaterThan(60);
    expect(raidersAlive, 'the raiders are not wiped out').toBeGreaterThan(10);
    // raiding parties do not drag their home after them: the raiders' camp stays on the east bank
    expect(raiders.extinctTick).toBe(-1);
    expect(raiders.homeX).toBeGreaterThan(895);
    // the rivalry passed to every daughter tribe on either side that is still at war
    for (const t of sim.state.tribes) {
      if (t.extinctTick !== -1 || founding(sim, t) !== 'Crimson Raiders') continue;
      for (const o of sim.state.tribes) {
        if (o.extinctTick !== -1 || founding(sim, o) !== 'Verdant Foragers') continue;
        const m = ((t.relations[o.id] ?? 0) + (o.relations[t.id] ?? 0)) / 2;
        if (m < SOCIAL_TUNING.warDeclare) expect(areRivals(sim, t.id, o.id), `${t.name} / ${o.name}`).toBe(true);
      }
    }
  }, 300_000);

  it('a save taken mid-raid loads exactly and the raid goes on identically', () => {
    const a = Simulation.create({ scenario: getScenario('two-civs'), seed: 42 });
    a.run(1500); // raiding parties are on the march toward the fords
    const marching = a.state.agents.filter((x) => raidLeg(x) === 'out');
    expect(marching.length, 'raiders on the way out at the save').toBeGreaterThan(10);
    const raidsBefore = raidsOnForagers(a).length;

    const b = Simulation.fromState(deserializeState(serializeSim(a)));
    expect(b.hash()).toBe(a.hash());
    expect(b.state.diplomacy?.rivals).toEqual(a.state.diplomacy?.rivals);
    for (const x of a.state.agents) {
      const y = b.agentById.get(x.id)!;
      expect(y.trek).toEqual(x.trek);
      if (sameMap && x.trek && y.trek) expect(sameMap(x.trek, y.trek), 'a loaded trek has the live trek shape').toBe(true);
    }
    if (sameMap) {
      const ref = marching[0].trek!;
      for (const x of a.state.agents) if (x.trek) expect(sameMap(x.trek, ref), 'every trek object has one shape').toBe(true);
    }

    a.run(900);
    b.run(900);
    expect(b.hash()).toBe(a.hash());
    expect(b.state.events.map((e) => `${e.tick}:${e.message}`)).toEqual(a.state.events.map((e) => `${e.tick}:${e.message}`));
    // and the raids went on after the save: the foragers' stockpile was plundered
    expect(raidsOnForagers(a).length).toBeGreaterThan(raidsBefore);
  }, 300_000);
});
