/**
 * Presets & world generation (simulation-core audit): every scenario creates the populations and
 * tribes it describes on dry land, fires its scheduled events at exactly the documented ticks (and
 * repeats them), and its world honours the divide it promises.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS, getScenario } from '../src/sim/presets';
import { findPassableInWorld, generateWorld } from '../src/sim/world';
import { Rng } from '../src/sim/rng';
import { DEFAULT_CONFIG } from '../src/sim/config';
import { TERRAIN_INFO } from '../src/sim/constants';
import { NONE, TERRAIN, type ScenarioDef, type TerrainType, type WorldState } from '../src/sim/types';

const passable = (w: WorldState, i: number) => TERRAIN_INFO[w.terrain[i] as TerrainType].passable;

/** 4-neighbour flood fill. */
function flood(w: WorldState, starts: number[], allow: (i: number) => boolean): Uint8Array {
  const N = w.width * w.height;
  const seen = new Uint8Array(N);
  const q: number[] = [];
  for (const s of starts) {
    if (!seen[s] && allow(s)) {
      seen[s] = 1;
      q.push(s);
    }
  }
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    const x = i % w.width;
    for (const j of [x > 0 ? i - 1 : -1, x < w.width - 1 ? i + 1 : -1, i - w.width, i + w.width]) {
      if (j >= 0 && j < N && !seen[j] && allow(j)) {
        seen[j] = 1;
        q.push(j);
      }
    }
  }
  return seen;
}

describe('preset populations and tribes', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.id}: founders, tribes and camps as described (3 seeds)`, () => {
      for (const seed of [1, 42, 12345]) {
        const sim = Simulation.create({ scenario: sc, seed });
        const ts = sim.state.world.tileSize;
        const agents = sim.state.agents;
        let k = 0;
        let budget = sim.config.maxAgents;
        for (const pop of sc.populations) {
          const n = Math.min(pop.count, budget);
          budget -= n;
          const group = agents.slice(k, k + n);
          k += n;
          expect(group.length, `${sc.id}/${seed}`).toBe(n);
          let near = 0;
          for (const a of group) {
            expect(sim.passableAt(a.x, a.y)).toBe(true);
            expect(sim.state.world.terrain[sim.tileIndex(a.x, a.y)], `${sc.id}/${seed}: founder in the water`).not.toBe(TERRAIN.Water);
            expect(a.age).toBeGreaterThanOrEqual(a.traits.maturityAge);
            if (Math.hypot(a.x - pop.x, a.y - pop.y) <= pop.radius + 3 * ts) near++;
          }
          expect(near / n, `${sc.id}/${seed}: founders far from (${pop.x}, ${pop.y})`).toBeGreaterThan(0.85);
          const tribeIds = new Set(group.map((a) => a.tribeId));
          expect(tribeIds.size).toBe(1);
          const tid = [...tribeIds][0];
          if (pop.tribe === 'new') {
            const t = sim.getTribe(tid)!;
            expect(t.name).toBe(pop.tribeName);
            expect(t.members).toBe(n);
            expect(t.founderId).toBe(group[0].id);
            expect(sim.passableAt(t.homeX, t.homeY)).toBe(true);
            expect(Math.hypot(t.homeX - pop.x, t.homeY - pop.y)).toBeLessThan(pop.radius + 3 * ts);
          } else expect(tid).toBe(NONE);
        }
        expect(agents.length).toBe(k);
        expect(sim.state.tribes.length).toBe(sc.populations.filter((p) => p.tribe === 'new').length);
        expect(sim.state.events.filter((e) => e.category === 'intervention' && e.severity === 'bad')).toEqual([]); // no "spawn failed"
      }
    });
  }
});

describe('preset schedules fire at the documented ticks', () => {
  /** Jump straight to each fire tick (no agents, so stepping is cheap) and record what happened. */
  function fireTicks(sc: ScenarioDef, until: number) {
    const copy: ScenarioDef = { ...getScenario(sc.id), populations: [] };
    const sim = Simulation.create({ scenario: copy, seed: 7 });
    const fired: { tick: number; note: string; started: string[] }[] = [];
    for (;;) {
      const next = Math.min(...sim.state.scheduled.map((e) => e.tick).filter((t) => t >= sim.tick));
      if (!Number.isFinite(next) || next > until) break;
      sim.state.tick = next;
      sim.step();
      const started = sim.state.disasters.filter((d) => d.startTick === next).map((d) => d.kind);
      for (const e of sim.state.events) if (e.tick === next && e.category === 'environment' && e.severity === 'major') fired.push({ tick: next, note: e.message, started });
    }
    return { sim, fired };
  }

  for (const sc of SCENARIOS) {
    it(`${sc.id}`, () => {
      const horizon = Math.max(...sc.scheduled.map((e) => e.tick + (e.repeat ?? 0))) + 1;
      const { sim, fired } = fireTicks(sc, horizon);
      const want: { tick: number; note: string }[] = [];
      for (const e of sc.scheduled) {
        want.push({ tick: e.tick, note: e.note! });
        if (e.repeat) want.push({ tick: e.tick + e.repeat, note: e.note! });
      }
      want.sort((a, b) => a.tick - b.tick || sc.scheduled.findIndex((e) => e.note === a.note) - sc.scheduled.findIndex((e) => e.note === b.note));
      expect(fired.map(({ tick, note }) => ({ tick, note }))).toEqual(want);
      // each scheduled disaster really started at its tick; each scheduled spawn really spawned
      for (const f of fired) {
        const iv = sc.scheduled.find((e) => e.note === f.note)!.intervention;
        if (iv.kind === 'disaster') expect(f.started, f.note).toContain(iv.disaster);
      }
      for (const e of sc.scheduled) {
        const rep = e.repeat;
        if (rep) expect(sim.state.scheduled.some((x) => x.note === e.note && x.tick === e.tick + 2 * rep)).toBe(true);
      }
    });
  }

  it('the day-6 raider pack of "Wolves Among Sheep" arrives as a new tribe of 10', () => {
    const sc = getScenario('predators');
    const ev = sc.scheduled[0];
    expect(ev.tick).toBe(6 * 600);
    sc.scheduled[0] = { ...ev, tick: 5 };
    const sim = Simulation.create({ scenario: sc, seed: 3 });
    sim.run(6);
    const pack = sim.state.tribes.find((t) => t.name === 'The Second Pack')!;
    expect(pack).toBeDefined();
    expect(pack.members).toBe(10);
    expect(sim.state.agents.filter((a) => a.tribeId === pack.id)).toHaveLength(10);
  });
});

describe('preset worlds', () => {
  it('every population of every preset has dry land nearby, on connected, mostly passable worlds (12 seeds)', () => {
    for (const sc of SCENARIOS) {
      const cfg = { ...DEFAULT_CONFIG, ...sc.config };
      for (let seed = 1; seed <= 12; seed++) {
        const w = generateWorld({ ...cfg, seed }, new Rng(seed, 1), sc.world);
        let total = 0;
        let first = -1;
        for (let i = 0; i < w.terrain.length; i++) {
          if (!passable(w, i)) continue;
          total++;
          if (first < 0) first = i;
        }
        expect(total / w.terrain.length, `${sc.id}/${seed}`).toBeGreaterThanOrEqual(0.55);
        const reached = flood(w, [first], (i) => passable(w, i)).reduce((n, v) => n + v, 0);
        expect(reached, `${sc.id}/${seed} connected`).toBe(total);
        for (const p of sc.populations) {
          const q = findPassableInWorld(w, p.x, p.y, 4000, true)!;
          expect(Math.hypot(q.x - p.x, q.y - p.y), `${sc.id}/${seed} (${p.x}, ${p.y})`).toBeLessThanOrEqual(p.radius);
        }
      }
    }
  });

  it('evolab: the mountain passes lead through the flanking highlands (rock-free route west ↔ east)', () => {
    const sc = getScenario('evolab');
    const cfg = { ...DEFAULT_CONFIG, ...sc.config };
    // 7, 14, 38, 93 and 281 used to have every pass blocked by natural rock next to the ridge
    for (const seed of [7, 14, 38, 93, 281, ...Array.from({ length: 25 }, (_, i) => i + 1)]) {
      const w = generateWorld({ ...cfg, seed }, new Rng(seed, 1), sc.world);
      const W = w.width;
      const open = (i: number) => passable(w, i) && w.terrain[i] !== TERRAIN.Rock;
      const west: number[] = [];
      for (let i = 0; i < w.terrain.length; i++) if (i % W < W * 0.25) west.push(i);
      const seen = flood(w, west, open);
      let east = 0;
      for (let i = 0; i < w.terrain.length; i++) if (i % W >= W * 0.75 && seen[i]) east++;
      expect(east, `seed ${seed}`).toBeGreaterThan(0);
      // and the range itself is still there
      let ridgeRows = 0;
      for (let y = 0; y < w.height; y++) {
        let rock = 0;
        for (let x = Math.floor(W * 0.25); x <= Math.ceil(W * 0.75); x++) if (w.terrain[y * W + x] === TERRAIN.Rock) rock++;
        if (rock >= 4) ridgeRows++;
      }
      expect(ridgeRows / w.height, `seed ${seed}`).toBeGreaterThan(0.4);
    }
  });

  it('two-civs: the river separates the peoples, who start on opposite banks (10 seeds)', () => {
    const sc = getScenario('two-civs');
    const cfg = { ...DEFAULT_CONFIG, ...sc.config };
    for (let seed = 1; seed <= 10; seed++) {
      const w = generateWorld({ ...cfg, seed }, new Rng(seed, 1), sc.world);
      const dry = (i: number) => passable(w, i) && w.terrain[i] !== TERRAIN.Water;
      const tile = (x: number, y: number) => Math.floor(y / w.tileSize) * w.width + Math.floor(x / w.tileSize);
      const [westPop, eastPop] = sc.populations;
      const a = findPassableInWorld(w, westPop.x, westPop.y, 4000, true)!;
      const b = findPassableInWorld(w, eastPop.x, eastPop.y, 4000, true)!;
      const fromWest = flood(w, [tile(a.x, a.y)], dry);
      expect(fromWest[tile(b.x, b.y)], `seed ${seed}: dry land bridge between the two peoples`).toBe(0);
      const viaFords = flood(w, [tile(a.x, a.y)], (i) => passable(w, i));
      expect(viaFords[tile(b.x, b.y)], `seed ${seed}: no ford`).toBe(1);
    }
  });
});
