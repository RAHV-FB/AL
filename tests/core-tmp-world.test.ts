// TEMPORARY verification probe (core-verify). Deleted after use.
import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/sim/world';
import { generateWorld as generateWorldHead } from './core-tmp-worldhead';
import { Rng } from '../src/sim/rng';
import { DEFAULT_CONFIG } from '../src/sim/config';
import { TERRAIN_INFO } from '../src/sim/constants';
import { SCENARIOS, getScenario } from '../src/sim/presets';
import { TERRAIN, type TerrainType, type WorldState } from '../src/sim/types';

const passable = (w: WorldState, i: number) => TERRAIN_INFO[w.terrain[i] as TerrainType].passable;
function flood(w: WorldState, starts: number[], allow: (i: number) => boolean): Uint8Array {
  const N = w.width * w.height;
  const seen = new Uint8Array(N);
  const q: number[] = [];
  for (const s of starts) if (!seen[s] && allow(s)) { seen[s] = 1; q.push(s); }
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    const x = i % w.width;
    for (const j of [x > 0 ? i - 1 : -1, x < w.width - 1 ? i + 1 : -1, i - w.width, i + w.width]) {
      if (j >= 0 && j < N && !seen[j] && allow(j)) { seen[j] = 1; q.push(j); }
    }
  }
  return seen;
}
function crossing(w: WorldState): boolean {
  const W = w.width;
  const open = (i: number) => passable(w, i) && w.terrain[i] !== TERRAIN.Rock;
  const west: number[] = [];
  for (let i = 0; i < w.terrain.length; i++) if (i % W < W * 0.25) west.push(i);
  const seen = flood(w, west, open);
  for (let i = 0; i < w.terrain.length; i++) if (i % W >= W * 0.75 && seen[i]) return true;
  return false;
}
const same = (a: WorldState, b: WorldState) => {
  for (const k of ['terrain', 'food', 'fertility', 'baseFertility', 'elevation', 'climateMod', 'territory'] as const) {
    const x = a[k] as ArrayLike<number>;
    const y = b[k] as ArrayLike<number>;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false;
  }
  return true;
};

describe('core-tmp world probe', () => {
  it('evolab sweep: blocked before/after, changed worlds', () => {
    const sc = getScenario('evolab');
    const cfg = { ...DEFAULT_CONFIG, ...sc.config };
    const blockedHead: number[] = [];
    const blockedNow: number[] = [];
    const changed: number[] = [];
    let minPassFrac = 1;
    for (let seed = 1; seed <= 308; seed++) {
      const a = generateWorldHead({ ...cfg, seed }, new Rng(seed, 1), sc.world);
      const b = generateWorld({ ...cfg, seed }, new Rng(seed, 1), sc.world);
      const ch = crossing(a);
      const cn = crossing(b);
      if (!ch) blockedHead.push(seed);
      if (!cn) blockedNow.push(seed);
      if (!same(a, b)) changed.push(seed);
      let p = 0;
      for (let i = 0; i < b.terrain.length; i++) if (passable(b, i)) p++;
      minPassFrac = Math.min(minPassFrac, p / b.terrain.length);
    }
    console.log('blockedHead', blockedHead, 'blockedNow', blockedNow, 'changed', changed, 'minPassFrac', minPassFrac);
    expect(blockedNow).toEqual([]);
  });

  it('other presets byte-identical to HEAD (40 seeds each)', () => {
    const diffs: string[] = [];
    for (const sc of SCENARIOS) {
      if (sc.id === 'evolab') continue;
      const cfg = { ...DEFAULT_CONFIG, ...sc.config };
      for (let seed = 1; seed <= 40; seed++) {
        const a = generateWorldHead({ ...cfg, seed }, new Rng(seed, 1), sc.world);
        const b = generateWorld({ ...cfg, seed }, new Rng(seed, 1), sc.world);
        if (!same(a, b)) diffs.push(`${sc.id}/${seed}`);
      }
      // also default seed of the scenario
      const seed = cfg.seed;
      const a = generateWorldHead({ ...cfg, seed }, new Rng(seed, 1), sc.world);
      const b = generateWorld({ ...cfg, seed }, new Rng(seed, 1), sc.world);
      if (!same(a, b)) diffs.push(`${sc.id}/default ${seed}`);
    }
    console.log('diffs', diffs);
    expect(diffs).toEqual([]);
  });

  it('mountain divide on other world sizes / options stays sane', () => {
    const out: string[] = [];
    for (const [w, h] of [[60, 40], [100, 60], [200, 125], [320, 200], [16, 12], [8, 8]] as const) {
      for (const mountainLevel of [0, 0.16, 0.4, 0.8]) {
        for (let seed = 1; seed <= 6; seed++) {
          const cfg = { ...DEFAULT_CONFIG, worldWidth: w, worldHeight: h, seed };
          const wo = generateWorld(cfg, new Rng(seed, 1), { divide: 'mountains', mountainLevel, island: true });
          let total = 0;
          let first = -1;
          for (let i = 0; i < wo.terrain.length; i++) if (passable(wo, i)) { total++; if (first < 0) first = i; }
          const reached = flood(wo, [first], (i) => passable(wo, i)).reduce((n, v) => n + v, 0);
          if (reached !== total) out.push(`${w}x${h}/${mountainLevel}/${seed}: disconnected`);
          for (let i = 0; i < wo.food.length; i++) if (!Number.isFinite(wo.food[i]) || !Number.isFinite(wo.fertility[i])) { out.push(`${w}x${h}: nan`); break; }
          if (!crossing(wo) && w >= 60) out.push(`${w}x${h}/${mountainLevel}/${seed}: no rock-free crossing`);
        }
      }
    }
    console.log(out.join('\n'));
  });
});
