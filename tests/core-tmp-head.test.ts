// TEMPORARY verification probe (core-verify): reproduce the original defects on the HEAD code. Deleted after use.
import { describe, expect, it } from 'vitest';
import { Simulation as HSim } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/headsim/simulation';
import { applyIntervention as hApply } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/headsim/interventions';
import { findPassableNear as hFind } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/headsim/world';
import { getScenario as hGet } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/headsim/presets';
import { deserializeState as hDeser, serializeSim as hSer, loadSim as hLoad } from '/tmp/claude-0/-home-user-AL/18762f12-5ddf-59a9-abe8-f1784e7dd796/scratchpad/headsim/persistence';
import { TERRAIN } from '../src/sim/types';

const EMPTY = {
  id: 'core-audit', name: 'Core audit', tagline: '', description: '', lookFor: [],
  config: { disasterRate: 0 }, world: {}, populations: [], scheduled: [],
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const land = (sim: any, fx = 0.5, fy = 0.5) => hFind(sim, sim.worldW * fx, sim.worldH * fy, 4000, true)!;

describe('HEAD reproductions', () => {
  it('population accounting', () => {
    const sim = HSim.create({ scenario: EMPTY, seed: 3 });
    hApply(sim, { kind: 'setConfig', patch: { maxAgents: 50 } });
    const p = land(sim);
    hApply(sim, { kind: 'spawn', x: p.x, y: p.y, count: 50, radius: 50 });
    hApply(sim, { kind: 'killAgent', id: sim.state.agents[0].id });
    console.log('HEAD after kill: agents', sim.state.agents.length, 'population', sim.population);
    hApply(sim, { kind: 'spawn', x: p.x, y: p.y, count: 10, radius: 50 });
    console.log('HEAD after spawn 10: agents', sim.state.agents.length, '(cap 50)');
  });

  it('replay NaN spread', () => {
    const run = (replay?: unknown) => {
      const sim = HSim.create({ scenario: EMPTY, seed: 5, replay: replay as never });
      if (!replay) {
        const p = land(sim);
        sim.enqueue({ kind: 'spawn', x: p.x, y: p.y, count: 10, radius: 40, template: { speed: 0.9, size: 0.2, spread: NaN } });
      }
      sim.run(20);
      return sim;
    };
    const a = run();
    const b = run(a.state.interventionLog);
    console.log('HEAD NaN spread: orig', a.hash(), 'replay', b.hash(), 'gene0', a.state.agents[0]?.genes[0]);
  });

  it('save-file log', () => {
    const sim = HSim.create({ scenario: EMPTY, seed: 6 });
    const p = land(sim);
    sim.enqueue({ kind: 'spawn', x: p.x, y: p.y, count: 10, radius: NaN });
    sim.enqueue({ kind: 'disaster', disaster: 'meteor', x: p.x, y: p.y, radius: 60, intensity: NaN, duration: 5 });
    sim.run(10);
    const warnings: string[] = [];
    const st = hDeser(hSer(sim), { warnings });
    console.log('HEAD save log: entries', sim.state.interventionLog.length, '→', st.interventionLog.length, warnings);
  });

  it('intervention spawn in pendingBirths: same-tick remove / paint', () => {
    const s2 = HSim.create({ scenario: EMPTY, seed: 4 });
    const q = land(s2);
    s2.enqueue({ kind: 'spawn', x: q.x, y: q.y, count: 8, radius: 20 });
    s2.enqueue({ kind: 'remove', x: q.x, y: q.y, radius: 200 });
    s2.step();
    console.log('HEAD same-tick remove: deaths', s2.state.stats.totals.deaths, 'agents', s2.state.agents.length);
    const sim = HSim.create({ scenario: EMPTY, seed: 3 });
    const p = land(sim);
    sim.enqueue({ kind: 'spawn', x: p.x, y: p.y, count: 10, radius: 20, tribe: 'none' });
    sim.enqueue({ kind: 'paintTerrain', x: p.x, y: p.y, radius: 400, terrain: TERRAIN.DeepWater });
    sim.run(6);
    console.log('HEAD stranded after paint:', sim.state.agents.filter((a) => !sim.passableAt(a.x, a.y)).length, '/', sim.state.agents.length);
  });

  it('negative disaster radius', () => {
    const sim = HSim.create({ scenario: EMPTY, seed: 3 });
    const p = land(sim);
    hApply(sim, { kind: 'disaster', disaster: 'drought', x: p.x, y: p.y, radius: -5, intensity: 0.5, duration: 100 });
    console.log('HEAD negative radius → stored radius', sim.state.disasters[0].radius);
  });

  it('out-of-order replay', () => {
    const sim = HSim.create({ scenario: EMPTY, seed: 8 });
    const p = land(sim);
    const log = [
      { tick: 5, intervention: { kind: 'addFood', x: p.x, y: p.y, radius: 20, amount: 3 } },
      { tick: 2, intervention: { kind: 'spawn', x: p.x, y: p.y, count: 5, radius: 20 } },
    ];
    const r = HSim.create({ scenario: EMPTY, seed: 8, replay: log as never });
    r.run(10);
    console.log('HEAD out-of-order replay ticks', r.state.interventionLog.map((e) => e.tick));
  });

  it('save right after create', () => {
    const a = HSim.create({ scenario: hGet('eden'), seed: 15 });
    console.log('HEAD create→save hash equal?', hLoad(hSer(a)).hash() === a.hash());
  });

  it('predators recount', () => {
    const sc = hGet('predators');
    sc.scheduled[0].tick = 30;
    const sim = HSim.create({ scenario: sc, seed: 3 });
    sim.run(31);
    const t = sim.state.tribes.find((x) => x.name === 'The Second Pack')!;
    console.log('HEAD second pack members field', t?.members, 'actual', sim.state.agents.filter((a) => a.tribeId === t?.id).length, 'extinct', t?.extinctTick);
  });
});
