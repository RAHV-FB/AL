import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { getScenario } from '../src/sim/presets';
import { NAV, planRoute, regionAt, sameRegion } from '../src/sim/pathfinding';
import { moveToward } from '../src/sim/steering';
import { createAgent } from '../src/sim/lifecycle';
import { randomGenes } from '../src/sim/genetics';
import { deserializeState, serializeSim } from '../src/sim/persistence';
import { TERRAIN, type Agent, type TerrainType } from '../src/sim/types';

/**
 * A flat grass world split by a deep river (tiles x 95..104) with one shallow ford (rows 60..62).
 * No agents; tests add their own.
 */
function riverWorld(opts: { ford?: boolean } = {}): Simulation {
  const sc = { ...getScenario('eden'), populations: [], scheduled: [] };
  const sim = Simulation.create({ scenario: sc, seed: 3, config: { disasterRate: 0 } });
  const w = sim.state.world;
  for (let ty = 0; ty < w.height; ty++) {
    for (let tx = 0; tx < w.width; tx++) {
      const i = ty * w.width + tx;
      let t: TerrainType = TERRAIN.Grass;
      if (tx >= 95 && tx <= 104) t = opts.ford !== false && ty >= 60 && ty <= 62 ? TERRAIN.Water : TERRAIN.DeepWater;
      w.terrain[i] = t;
      w.fertility[i] = w.baseFertility[i] = t === TERRAIN.Grass ? 1 : 0;
      w.food[i] = t === TERRAIN.Grass ? 8 : 0;
    }
  }
  w.terrainVersion++;
  return sim;
}

const TS = 8;
const tileCentre = (tx: number, ty: number) => ({ x: (tx + 0.5) * TS, y: (ty + 0.5) * TS });

function addAgent(sim: Simulation, x: number, y: number): Agent {
  const genes = randomGenes(sim.rng, { speed: 0.6, perception: 0.9, spread: 0.01 });
  const a = createAgent(sim, { x, y, genes, age: 2000, food: 120 });
  sim.addAgent(a);
  return a;
}

function walkable(sim: Simulation, x0: number, y0: number, x1: number, y1: number): boolean {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2);
  for (let k = 0; k <= n; k++) if (!sim.passableAt(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n)) return false;
  return true;
}

describe('pathfinding: regions and A*', () => {
  it('labels the two banks as one region only while the ford exists', () => {
    const withFord = riverWorld();
    const west = tileCentre(40, 20);
    const east = tileCentre(160, 20);
    expect(sameRegion(withFord, west.x, west.y, east.x, east.y)).toBe(true);
    const noFord = riverWorld({ ford: false });
    expect(sameRegion(noFord, west.x, west.y, east.x, east.y)).toBe(false);
    expect(regionAt(noFord, west.x, west.y)).not.toBe(regionAt(noFord, east.x, east.y));
    expect(regionAt(noFord, tileCentre(100, 20).x, tileCentre(100, 20).y)).toBe(-1); // deep water
  });

  it('routes across the river through the ford, every leg walkable', () => {
    const sim = riverWorld();
    const s = tileCentre(60, 20);
    const g = tileCentre(140, 20);
    const res = planRoute(sim, s.x, s.y, g.x, g.y);
    expect(res.status).toBe('ok');
    const pts = res.pts;
    expect(pts.length).toBeGreaterThanOrEqual(4);
    expect(pts[pts.length - 2]).toBeCloseTo(g.x, 6);
    expect(pts[pts.length - 1]).toBeCloseTo(g.y, 6);
    let px = s.x;
    let py = s.y;
    let crossedAtFord = false;
    for (let k = 0; k < pts.length; k += 2) {
      expect(walkable(sim, px, py, pts[k], pts[k + 1]), `leg ${k / 2} is walkable`).toBe(true);
      // the leg that crosses the river's middle must do so inside the ford rows
      if ((px - 100 * TS) * (pts[k] - 100 * TS) <= 0 && px !== pts[k]) {
        const t = (100 * TS - px) / (pts[k] - px);
        const yAt = py + t * (pts[k + 1] - py);
        if (yAt >= 60 * TS && yAt <= 63 * TS) crossedAtFord = true;
      }
      px = pts[k];
      py = pts[k + 1];
    }
    expect(crossedAtFord).toBe(true);
    expect(pts.length / 2).toBeLessThanOrEqual(NAV.maxWaypoints);
  });

  it('is deterministic and refuses unreachable goals without searching', () => {
    const a = riverWorld();
    const b = riverWorld();
    const s = tileCentre(30, 100);
    const g = tileCentre(170, 5);
    expect(planRoute(a, s.x, s.y, g.x, g.y).pts).toEqual(planRoute(b, s.x, s.y, g.x, g.y).pts);
    const cut = riverWorld({ ford: false });
    const res = planRoute(cut, s.x, s.y, g.x, g.y);
    expect(res.status).toBe('unreachable');
    expect(res.expanded).toBe(0);
  });

  it('shares a per-tick search budget across queries and resets it next tick', () => {
    const sim = riverWorld();
    const s = tileCentre(20, 110);
    const g = tileCentre(180, 10);
    const saved = NAV.tickBudget;
    try {
      NAV.tickBudget = 400; // far too little for a cross-river route
      expect(planRoute(sim, s.x, s.y, g.x, g.y).status).toBe('budget');
      NAV.tickBudget = saved;
      sim.step(); // new tick → fresh budget
      expect(planRoute(sim, s.x, s.y, g.x, g.y).status).toBe('ok');
    } finally {
      NAV.tickBudget = saved;
    }
  });
});

describe('route following', () => {
  it('an agent told to reach the far bank walks to the ford and crosses, never onto deep water', () => {
    const sim = riverWorld();
    const start = tileCentre(80, 20);
    const goal = tileCentre(120, 20);
    const a = addAgent(sim, start.x, start.y);
    let arrived = false;
    let maxWaypoints = 0;
    for (let t = 0; t < 2500 && !arrived; t++) {
      arrived = moveToward(sim, a, goal.x, goal.y, 1, 3);
      if (a.route && a.route.pts.length) maxWaypoints = Math.max(maxWaypoints, a.route.pts.length / 2);
      expect(sim.passableAt(a.x, a.y)).toBe(true);
      a.energy = 1; // keep the stride constant (no vitals in this test)
      sim.state.tick++;
    }
    expect(arrived).toBe(true);
    expect(maxWaypoints).toBeGreaterThan(0); // it really planned a route (the straight line is blocked)
    expect(a.route).toBeUndefined(); // cleared on arrival
  });

  it('re-plans when the ford is painted over, and gives up cleanly when no way remains', () => {
    const sim = riverWorld();
    const start = tileCentre(70, 20);
    const goal = tileCentre(130, 20);
    const a = addAgent(sim, start.x, start.y);
    for (let t = 0; t < 30; t++) {
      moveToward(sim, a, goal.x, goal.y, 1, 3);
      sim.state.tick++;
    }
    expect(a.route?.pts.length ?? 0).toBeGreaterThan(0);
    sim.enqueue({ kind: 'paintTerrain', x: 100 * TS, y: 61.5 * TS, radius: 4 * TS, terrain: TERRAIN.DeepWater });
    sim.step();
    for (let t = 0; t < 200; t++) {
      moveToward(sim, a, goal.x, goal.y, 1, 3);
      expect(sim.passableAt(a.x, a.y)).toBe(true);
      expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
      sim.state.tick++;
    }
    expect(a.route?.fail).toBe(true); // no route: steering falls back to wall-following until a retry
    expect(a.x).toBeLessThan(95 * TS); // still on the west bank
  });

  it('a hungry agent on a bare bank crosses the ford to food it can see on the other side', () => {
    const sim = riverWorld();
    const w = sim.state.world;
    // strip the west bank bare; the east bank stays lush
    for (let ty = 0; ty < w.height; ty++) for (let tx = 0; tx < 95; tx++) w.food[ty * w.width + tx] = 0;
    for (let ty = 0; ty < w.height; ty++) for (let tx = 0; tx < 95; tx++) w.fertility[ty * w.width + tx] = 0.02;
    const p = tileCentre(90, 50);
    const a = addAgent(sim, p.x, p.y);
    a.food = a.traits.maxFood * 0.3;
    let crossed = -1;
    for (let t = 0; t < 3000 && crossed < 0; t++) {
      sim.step();
      if (!a.alive) break;
      if (a.x > 105 * TS) crossed = t;
    }
    expect(crossed, 'reached the east bank').toBeGreaterThanOrEqual(0);
  }, 60_000);
});

describe('migration across a ford', () => {
  it('a starving band on a bare bank, far from the river, treks to the lush far bank through the only ford', () => {
    const sim = riverWorld();
    const w = sim.state.world;
    // the west bank is spent (no regrowth); the east bank is lush — far out of sight of the band
    for (let ty = 0; ty < w.height; ty++) {
      for (let tx = 0; tx < 95; tx++) {
        const i = ty * w.width + tx;
        w.food[i] = 0;
        w.fertility[i] = w.baseFertility[i] = 0.01;
      }
      for (let tx = 105; tx < w.width; tx++) w.food[ty * w.width + tx] = 10;
    }
    const band: Agent[] = [];
    for (let k = 0; k < 12; k++) {
      const p = tileCentre(40 + (k % 4) * 2, 22 + Math.floor(k / 4) * 2);
      const a = addAgent(sim, p.x, p.y);
      a.food = a.traits.maxFood * 0.45;
      band.push(a);
    }
    let crossed = 0;
    let routed = 0;
    const seen = new Set<number>();
    for (let t = 0; t < 3000; t++) {
      sim.step();
      for (const a of band) {
        if (!a.alive) continue;
        if (a.route && a.route.pts.length > 0) routed++;
        if (a.x > 105 * TS && !seen.has(a.id)) {
          seen.add(a.id);
          crossed++;
        }
        expect(sim.passableAt(a.x, a.y)).toBe(true);
      }
    }
    console.log(`[route] migration across the ford: ${crossed} of ${band.length} starving migrants reached the far bank`);
    expect(routed, 'migrants followed planned routes').toBeGreaterThan(0);
    expect(crossed, 'migrants that reached the far bank').toBeGreaterThanOrEqual(4);
  }, 120_000);
});

describe('routes and persistence', () => {
  it('a save taken mid-route continues identically (route kept in the save)', () => {
    const sim = riverWorld();
    const start = tileCentre(80, 30);
    const a = addAgent(sim, start.x, start.y);
    const tribeHome = tileCentre(125, 30);
    const tribe = sim.createTribe(a, tribeHome.x, tribeHome.y, 'Ford Walkers');
    a.tribeId = tribe.id;
    // run until the agent is following a planned route
    let t = 0;
    for (; t < 2000; t++) {
      sim.step();
      if (a.route && a.route.pts.length > 0) break;
    }
    const json = serializeSim(sim);
    const warnings: string[] = [];
    const loaded = Simulation.fromState(deserializeState(json, { warnings }));
    expect(warnings).toEqual([]);
    const la = loaded.getAgent(a.id)!;
    expect(la.route).toEqual(a.route);
    sim.run(400);
    loaded.run(400);
    expect(loaded.hash()).toBe(sim.hash());
  }, 60_000);

  it('a corrupted saved route is dropped (and re-planned), not trusted', () => {
    const sim = riverWorld();
    const a = addAgent(sim, tileCentre(80, 30).x, tileCentre(80, 30).y);
    a.route = { gx: 1000, gy: 240, pts: [NaN, 5, 1e9, 3], i: 1, t: 0, v: 0 };
    const warnings: string[] = [];
    const st = deserializeState(serializeSim(sim), { warnings });
    expect(st.agents.find((x) => x.id === a.id)!.route).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/route/);
  });
});

describe('routes in the real presets', () => {
  it('plague-island: agents route between islands over the shallows, and nobody ends up on impassable ground', () => {
    const sim = Simulation.create({ scenario: getScenario('plague-island'), seed: 42 });
    const routed = new Set<number>();
    for (let t = 0; t < 3000; t++) {
      sim.step();
      if (t % 10 === 0) {
        for (const a of sim.state.agents) {
          if (a.route && !a.route.fail && a.route.pts.length > 0) routed.add(a.id);
          expect(sim.passableAt(a.x, a.y)).toBe(true);
        }
      }
    }
    console.log(`[route] plague-island: ${routed.size} agents followed planned routes in 3000 ticks`);
    expect(routed.size).toBeGreaterThan(5);
  }, 180_000);

  it('two-civs: the river is a real barrier (most straight crossings blocked) yet both banks stay one connected region', () => {
    const sim = Simulation.create({ scenario: getScenario('two-civs'), seed: 42 });
    const mid = sim.worldW / 2;
    let blocked = 0;
    let total = 0;
    for (let y = 40; y < sim.worldH - 40; y += 8) {
      total++;
      if (!sameRegion(sim, mid - 120, y, mid + 120, y)) continue; // a lake row: not a river test
      // a straight line across the river at this latitude?
      let wet = 0;
      for (let x = mid - 120; x <= mid + 120; x += 4) if (!sim.passableAt(x, y)) wet++;
      if (wet > 2) blocked++;
    }
    const tribes = sim.state.tribes;
    expect(sameRegion(sim, tribes[0].homeX, tribes[0].homeY, tribes[1].homeX, tribes[1].homeY)).toBe(true);
    expect(blocked / total).toBeGreaterThan(0.5);
    const r = planRoute(sim, tribes[1].homeX, tribes[1].homeY, tribes[0].homeX, tribes[0].homeY);
    expect(r.status).toBe('ok');
  });
});
