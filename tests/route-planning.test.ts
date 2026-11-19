import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { getScenario } from '../src/sim/presets';
import { NAV, navBudgetLeft, planRoute, regionAt, resetNavBudget, sameRegion } from '../src/sim/pathfinding';
import { moveToward } from '../src/sim/steering';
import { createAgent } from '../src/sim/lifecycle';
import { randomGenes } from '../src/sim/genetics';
import { deserializeState, serializeSim } from '../src/sim/persistence';
import { applyIntervention } from '../src/sim/interventions';
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
    expect(crossed, 'migrants that reached the far bank').toBeGreaterThanOrEqual(9);
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

/** A flat grass world with no river, for obstacle-specific tests. */
function grassWorld(): Simulation {
  const sim = riverWorld();
  const w = sim.state.world;
  for (let i = 0; i < w.terrain.length; i++) {
    w.terrain[i] = TERRAIN.Grass;
    w.fertility[i] = w.baseFertility[i] = 1;
    w.food[i] = 8;
  }
  w.terrainVersion++;
  return sim;
}

function walkTo(sim: Simulation, a: Agent, gx: number, gy: number, ticks: number): number {
  for (let t = 0; t < ticks; t++) {
    if (moveToward(sim, a, gx, gy, 1, 3)) return t;
    expect(sim.passableAt(a.x, a.y)).toBe(true);
    a.energy = 1;
    sim.state.tick++;
  }
  return -1;
}

describe('route following: review regressions', () => {
  it('a thin wall between the agent and a nearby goal is walked round, not pushed into', () => {
    const sim = grassWorld();
    const w = sim.state.world;
    for (let tx = 20; tx < w.width; tx++) w.terrain[60 * w.width + tx] = TERRAIN.Wall; // 1-tile wall, gap at the far west
    w.terrainVersion++;
    const s = tileCentre(110, 61);
    const g = tileCentre(100, 59);
    const a = addAgent(sim, s.x, s.y);
    expect(walkTo(sim, a, g.x, g.y, 6000)).toBeGreaterThanOrEqual(0);
  });

  it('a diagonal one-tile wall is not slipped through at its corners (planner, smoothing and stepping agree)', () => {
    const sim = grassWorld();
    const w = sim.state.world;
    // anti-diagonal wall (66,83)..(56,93) plus a lake to its south-west
    for (let k = 0; k <= 10; k++) w.terrain[(83 + k) * w.width + (66 - k)] = TERRAIN.Wall;
    for (let ty = 95; ty < 110; ty++) for (let tx = 40; tx < 62; tx++) w.terrain[ty * w.width + tx] = TERRAIN.DeepWater;
    w.terrainVersion++;
    const s = { x: 52.25 * TS, y: 84.05 * TS };
    const g = tileCentre(112, 115);
    const res = planRoute(sim, s.x, s.y, g.x, g.y);
    expect(res.status).toBe('ok');
    // every leg, sampled finely: never on a wall tile, never squeezing diagonally past a wall corner
    const open = (tx: number, ty: number) => sim.passableAt((tx + 0.5) * TS, (ty + 0.5) * TS);
    let px = s.x;
    let py = s.y;
    for (let k = 0; k < res.pts.length; k += 2) {
      const n = Math.ceil(Math.hypot(res.pts[k] - px, res.pts[k + 1] - py) / (0.02 * TS));
      let ptx = Math.floor(px / TS);
      let pty = Math.floor(py / TS);
      for (let q = 1; q <= n; q++) {
        const x = px + ((res.pts[k] - px) * q) / n;
        const y = py + ((res.pts[k + 1] - py) * q) / n;
        const tx = Math.floor(x / TS);
        const ty = Math.floor(y / TS);
        expect(open(tx, ty), `leg ${k / 2} enters tile ${tx},${ty}`).toBe(true);
        if (tx !== ptx && ty !== pty) expect(open(tx, pty) && open(ptx, ty), `leg ${k / 2} cuts the corner at ${tx},${ty}`).toBe(true);
        ptx = tx;
        pty = ty;
      }
      px = res.pts[k];
      py = res.pts[k + 1];
    }
    const a = addAgent(sim, s.x, s.y);
    a.traits.speed = 0.53; // slow walkers were the ones that got pinned
    expect(walkTo(sim, a, g.x, g.y, 8000)).toBeGreaterThanOrEqual(0);
  });

  it('a maze too big for one search is crossed with partial routes, without hammering the budget', () => {
    const sim = grassWorld();
    const w = sim.state.world;
    // serpentine walls every 6 rows with alternating gaps at the ends
    for (let ty = 6; ty < w.height - 2; ty += 6) {
      const gapLeft = (ty / 6) % 2 === 0;
      for (let tx = 0; tx < w.width; tx++) {
        if (gapLeft ? tx < 3 : tx >= w.width - 3) continue;
        w.terrain[ty * w.width + tx] = TERRAIN.Wall;
      }
    }
    w.terrainVersion++;
    const s = tileCentre(100, 1);
    const g = tileCentre(100, 123);
    expect(sameRegion(sim, s.x, s.y, g.x, g.y)).toBe(true);
    const a = addAgent(sim, s.x, s.y);
    let partial = 0;
    let arrived = -1;
    for (let t = 0; t < 40000 && arrived < 0; t++) {
      if (moveToward(sim, a, g.x, g.y, 1, 3)) arrived = t;
      if (a.route?.p) partial = Math.max(partial, a.route.p);
      a.energy = 1;
      sim.state.tick++;
    }
    expect(partial, 'used partial routes').toBeGreaterThan(0);
    expect(arrived, 'got through the maze').toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('rejects a saved route whose waypoint index points past the last waypoint', () => {
    const sim = riverWorld();
    const a = addAgent(sim, tileCentre(80, 30).x, tileCentre(80, 30).y);
    a.route = { gx: 1000, gy: 240, pts: [700, 240, 1000, 240], i: 4, t: 0, v: sim.state.world.terrainVersion };
    const warnings: string[] = [];
    const st = deserializeState(serializeSim(sim), { warnings });
    expect(st.agents.find((x) => x.id === a.id)!.route).toBeUndefined();
  });

  it('route searches made between ticks do not eat into the next tick (budget reset at every step)', () => {
    const a = riverWorld();
    const b = riverWorld();
    const s = tileCentre(20, 110);
    const g = tileCentre(180, 10);
    for (let k = 0; k < 6; k++) planRoute(a, s.x, s.y, g.x, g.y); // only on a, outside step()
    a.step();
    b.step();
    expect(navBudgetLeft(a)).toBe(navBudgetLeft(b));
  });
});

describe('route planning: performance regressions', () => {
  it('every agent keeps one object shape (same keys, same order) — fresh, after routing and migrating, and after a load', () => {
    const sim = Simulation.create({ scenario: getScenario('plague-island'), seed: 42 });
    sim.run(2500);
    const shapes = new Set(sim.state.agents.map((a) => Object.keys(a).join(',')));
    expect(sim.state.agents.some((a) => a.route !== undefined)).toBe(true);
    expect(shapes.size).toBe(1);
    const loaded = Simulation.fromState(deserializeState(serializeSim(sim)));
    const loadedShapes = new Set(loaded.state.agents.map((a) => Object.keys(a).join(',')));
    expect([...loadedShapes]).toEqual([...shapes]);
  }, 120_000);

  it('repainting land as other land keeps everyone’s routes; only a change of walkability is checked', () => {
    const sim = riverWorld();
    const a = addAgent(sim, tileCentre(70, 20).x, tileCentre(70, 20).y);
    const goal = tileCentre(130, 20);
    for (let t = 0; t < 20; t++) {
      moveToward(sim, a, goal.x, goal.y, 1, 3);
      sim.state.tick++;
    }
    const before = a.route!;
    expect(before.pts.length).toBeGreaterThan(0);
    const nav0 = sim.state.world.navVersion ?? 0;
    // (applied directly: stepping the sim would also run this agent's own brain)
    applyIntervention(sim, { kind: 'paintTerrain', x: 30 * TS, y: 110 * TS, radius: 5 * TS, terrain: TERRAIN.Sand }); // grass → sand far away
    expect(sim.state.world.navVersion ?? 0).toBe(nav0);
    moveToward(sim, a, goal.x, goal.y, 1, 3);
    expect(a.route).toBe(before); // same object: not re-planned
    applyIntervention(sim, { kind: 'paintTerrain', x: 30 * TS, y: 110 * TS, radius: 3 * TS, terrain: TERRAIN.Wall }); // walkability changes, off-route
    expect(sim.state.world.navVersion ?? 0).toBe(nav0 + 1);
    moveToward(sim, a, goal.x, goal.y, 1, 3);
    expect(a.route!.pts).toEqual(before.pts); // its legs were re-checked and are still clear
  });

  it('starving migrants cross on several seeds, and few starve on the way', () => {
    for (const seed of [3, 11, 29]) {
      const sc = { ...getScenario('eden'), populations: [], scheduled: [] };
      const sim = Simulation.create({ scenario: sc, seed, config: { disasterRate: 0 } });
      const w = sim.state.world;
      for (let ty = 0; ty < w.height; ty++) {
        for (let tx = 0; tx < w.width; tx++) {
          const i = ty * w.width + tx;
          const river = tx >= 95 && tx <= 104;
          w.terrain[i] = river ? (ty >= 60 && ty <= 62 ? TERRAIN.Water : TERRAIN.DeepWater) : TERRAIN.Grass;
          const west = tx < 95;
          w.fertility[i] = w.baseFertility[i] = river ? 0 : west ? 0.01 : 1;
          w.food[i] = river || west ? 0 : 10;
        }
      }
      w.terrainVersion++;
      w.navVersion = (w.navVersion ?? 0) + 1;
      const band: Agent[] = [];
      for (let k = 0; k < 12; k++) {
        const p = tileCentre(40 + (k % 4) * 2, 22 + Math.floor(k / 4) * 2);
        const a = addAgent(sim, p.x, p.y);
        a.food = a.traits.maxFood * 0.45;
        band.push(a);
      }
      const crossed = new Set<number>();
      for (let t = 0; t < 3000; t++) {
        sim.step();
        for (const a of band) {
          if (a.alive && a.x > 105 * TS) crossed.add(a.id);
          if (a.trek) expect(a.trek.x, 'every trek heads for the lush far bank').toBeGreaterThan(95 * TS);
        }
      }
      const dead = band.filter((a) => !a.alive && !crossed.has(a.id)).length;
      console.log(`[route] seed ${seed}: ${crossed.size}/12 crossed, ${dead} starved before crossing`);
      expect(crossed.size, `seed ${seed}`).toBeGreaterThanOrEqual(8);
      expect(dead, `seed ${seed}`).toBeLessThanOrEqual(4);
    }
  }, 180_000);
});

describe('route following: final-verification regressions', () => {
  it('a dead-end pocket gives up instead of waiting forever, and does not starve other agents’ planning', () => {
    const sim = grassWorld();
    const w = sim.state.world;
    for (let tx = 20; tx <= 180; tx++) w.terrain[100 * w.width + tx] = TERRAIN.Wall; // cup bottom
    for (let ty = 10; ty <= 100; ty++) {
      w.terrain[ty * w.width + 20] = TERRAIN.Wall;
      w.terrain[ty * w.width + 180] = TERRAIN.Wall;
    }
    for (let ty = 105; ty < 120; ty++) for (let tx = 5; tx < 15; tx++) w.terrain[ty * w.width + tx] = TERRAIN.DeepWater; // a lake
    w.terrainVersion++;
    w.navVersion = (w.navVersion ?? 0) + 1;
    const trapped: Agent[] = [];
    for (let k = 0; k < 8; k++) trapped.push(addAgent(sim, tileCentre(96 + k, 99).x, tileCentre(96 + k, 99).y));
    const bystanders: Agent[] = [];
    for (let k = 0; k < 20; k++) bystanders.push(addAgent(sim, tileCentre(2, 103 + (k % 10)).x + (k >= 10 ? 4 : 0), tileCentre(2, 103 + (k % 10)).y));
    const cupGoal = tileCentre(100, 110);
    const lakeGoal = tileCentre(18, 112);
    let trappedWaitTicks = 0;
    const arrived = new Set<number>();
    for (let t = 0; t < 3000; t++) {
      for (const a of trapped) {
        moveToward(sim, a, cupGoal.x, cupGoal.y, 1, 3);
        if (a.route?.wait) trappedWaitTicks++;
        a.energy = 1;
      }
      for (const a of bystanders) {
        if (arrived.has(a.id)) continue;
        if (moveToward(sim, a, lakeGoal.x, lakeGoal.y, 1, 4)) arrived.add(a.id);
        a.energy = 1;
      }
      sim.state.tick++;
      resetNavBudget(sim);
    }
    expect(arrived.size, 'bystanders that reached their goal round the lake').toBe(20);
    expect(trappedWaitTicks, 'ticks the trapped agents spent waiting for search budget').toBeLessThan(1000);
  }, 120_000);

  it('a juvenile holding a leftover straight-line route still follows its mother across the ford', () => {
    const sim = riverWorld();
    const mother = addAgent(sim, tileCentre(110, 30).x, tileCentre(110, 30).y);
    const kid = addAgent(sim, tileCentre(89, 31).x, tileCentre(89, 31).y);
    kid.age = Math.floor(kid.traits.maturityAge * 0.3);
    kid.parents = [mother.id, -1];
    kid.route = { gx: 90.9 * TS, gy: 37.4 * TS, pts: [], i: 0, t: 1e6, v: sim.state.world.navVersion ?? 0, b: 1e9, bt: 0 }; // stale verdict
    let crossed = -1;
    for (let t = 0; t < 3000 && crossed < 0; t++) {
      mother.x = tileCentre(110, 30).x; // she waits on the far bank
      mother.y = tileCentre(110, 30).y;
      mother.food = mother.traits.maxFood;
      kid.food = kid.traits.maxFood;
      sim.step();
      if (kid.x > 105 * TS) crossed = t;
    }
    expect(crossed, 'tick the juvenile reached the far bank').toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('agents behind diagonal one-tile walls — far or near the goal — are not pinned', () => {
    let arrivedFar = 0;
    let arrivedNear = 0;
    let trials = 0;
    for (let k = 0; k < 6; k++) {
      const sim = grassWorld();
      const w = sim.state.world;
      const ox = 40 + 20 * k;
      for (let j = 0; j < 30; j++) w.terrain[(50 + j) * w.width + (ox + j)] = TERRAIN.Wall; // diagonal wall
      w.terrainVersion++;
      w.navVersion = (w.navVersion ?? 0) + 1;
      trials++;
      // far: across the wall's middle
      const a = addAgent(sim, tileCentre(ox + 10, 64).x + 2.3, tileCentre(ox + 10, 64).y + 1.1);
      const g = tileCentre(ox + 2, 75);
      if (walkTo(sim, a, g.x, g.y, 6000) >= 0) arrivedFar++;
      // near: goal within 2.5 tiles on the other side of the wall
      const b = addAgent(sim, tileCentre(ox + 15, 64).x + 1.7, tileCentre(ox + 15, 64).y + 2.9);
      const gb = tileCentre(ox + 14, 66);
      if (walkTo(sim, b, gb.x, gb.y, 6000) >= 0) arrivedNear++;
    }
    expect(arrivedFar).toBe(trials);
    expect(arrivedNear).toBe(trials);
  }, 120_000);
});
