/**
 * Scenario presets (owned by the Persistence & Experiments engineer): every experiment is complete,
 * well-formed, distinct, stays inside the tunable parameter ranges and actually runs.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS, findScenario, getScenario } from '../src/sim/presets';
import { DEFAULT_CONFIG, PARAM_SPECS } from '../src/sim/config';
import { DISASTER_KINDS, GENES, TERRAIN_COUNT, type GenomeTemplate, type SimConfig } from '../src/sim/types';

const REQUIRED = ['eden', 'fittest', 'two-civs', 'evolab', 'collapse'];
const INTERVENTION_KINDS = ['spawn', 'remove', 'killAgent', 'addFood', 'removeFood', 'paintTerrain', 'fertilize', 'disaster', 'setConfig', 'boostAgent'];

function merged(id: string): SimConfig {
  return { ...DEFAULT_CONFIG, ...findScenario(id)!.config };
}

function checkTemplate(t: GenomeTemplate | undefined, where: string): void {
  if (!t) return;
  for (const [k, v] of Object.entries(t)) {
    if (k === 'spread') {
      expect(v, `${where}.spread`).toBeGreaterThanOrEqual(0);
      expect(v, `${where}.spread`).toBeLessThanOrEqual(0.5);
    } else {
      expect(GENES as readonly string[], `${where}: unknown gene "${k}"`).toContain(k);
      expect(v, `${where}.${k}`).toBeGreaterThanOrEqual(0);
      expect(v, `${where}.${k}`).toBeLessThanOrEqual(1);
    }
  }
}

describe('scenario presets', () => {
  it('provides the five core experiments plus bonus ones, fully documented', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(6);
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of REQUIRED) expect(ids).toContain(id);
    expect(ids[0]).toBe('eden');
    for (const sc of SCENARIOS) {
      expect(sc.id).toMatch(/^[a-z0-9-]+$/);
      expect(sc.name.length, sc.id).toBeGreaterThan(3);
      expect(sc.tagline.length, sc.id).toBeGreaterThan(10);
      expect(sc.description.length, sc.id).toBeGreaterThan(120);
      expect(sc.description.split(/[.!?](\s|$)/).filter((x) => x && x.trim().length > 3).length, `${sc.id} description sentences`).toBeGreaterThanOrEqual(2);
      expect(sc.lookFor.length, sc.id).toBeGreaterThanOrEqual(3);
      expect(sc.lookFor.length, sc.id).toBeLessThanOrEqual(4);
      for (const l of sc.lookFor) expect(l.length, sc.id).toBeGreaterThan(20);
      expect(sc.populations.length, sc.id).toBeGreaterThan(0);
      expect(sc.scheduled.length, sc.id).toBeGreaterThan(0);
    }
  });

  it('configs are meaningfully distinct and stay inside the tunable ranges (saves round-trip unclamped)', () => {
    const seen = new Set<string>();
    for (const sc of SCENARIOS) {
      for (const [k, v] of Object.entries(sc.config)) {
        expect(k in DEFAULT_CONFIG, `${sc.id}: unknown config key ${k}`).toBe(true);
        expect(typeof v, `${sc.id}.${k}`).toBe(typeof DEFAULT_CONFIG[k as keyof SimConfig]);
        const spec = PARAM_SPECS.find((p) => p.key === k);
        if (spec) {
          expect(v as number, `${sc.id}.${k}`).toBeGreaterThanOrEqual(spec.min);
          expect(v as number, `${sc.id}.${k}`).toBeLessThanOrEqual(spec.max);
        }
      }
      const key = JSON.stringify({ c: merged(sc.id), w: sc.world });
      expect(seen.has(key), `${sc.id} duplicates another scenario`).toBe(false);
      seen.add(key);
    }
    // a few defining traits of the core experiments
    expect(merged('eden').foodRegen).toBeGreaterThanOrEqual(1.8);
    expect(merged('eden').disasterRate).toBe(0);
    expect(merged('fittest').foodRegen).toBeLessThan(0.7);
    expect(merged('fittest').difficulty).toBeGreaterThan(1.4);
    expect(merged('fittest').aggressionBias).toBeGreaterThan(1.3);
    expect(findScenario('two-civs')!.world.divide).toBeDefined();
    expect(findScenario('two-civs')!.world.divide).not.toBe('none');
    expect(merged('evolab').mutationRate).toBeGreaterThanOrEqual(0.2);
    expect(merged('evolab').mateCompatibility).toBeLessThanOrEqual(0.25);
    expect(findScenario('evolab')!.scheduled.every((e) => (e.repeat ?? 0) > 0)).toBe(true);
    expect(merged('collapse').overgrazing).toBe(true);
    const tc = findScenario('two-civs')!.populations;
    expect(tc).toHaveLength(2);
    expect(tc[0].template!.aggression!).toBeLessThan(0.3);
    expect(tc[1].template!.aggression!).toBeGreaterThan(0.7);
  });

  it('populations and scheduled events are well-formed and inside the world', () => {
    for (const sc of SCENARIOS) {
      const cfg = merged(sc.id);
      const W = cfg.worldWidth * cfg.tileSize;
      const H = cfg.worldHeight * cfg.tileSize;
      for (const [i, p] of sc.populations.entries()) {
        const where = `${sc.id}.populations[${i}]`;
        expect(p.x, where).toBeGreaterThanOrEqual(0.1 * W);
        expect(p.x, where).toBeLessThanOrEqual(0.9 * W);
        expect(p.y, where).toBeGreaterThanOrEqual(0.15 * H);
        expect(p.y, where).toBeLessThanOrEqual(0.85 * H);
        expect(p.count, where).toBeGreaterThan(0);
        expect(p.radius, where).toBeGreaterThan(0);
        if (p.tribe === 'new') expect(typeof p.tribeName, where).toBe('string');
        checkTemplate(p.template, where);
      }
      for (const [i, e] of sc.scheduled.entries()) {
        const where = `${sc.id}.scheduled[${i}]`;
        expect(Number.isInteger(e.tick) && e.tick > 0, where).toBe(true);
        expect((e.note ?? '').length, `${where} note`).toBeGreaterThan(10);
        if (e.repeat !== undefined) expect(Number.isInteger(e.repeat) && e.repeat > 0, where).toBe(true);
        const iv = e.intervention;
        expect(INTERVENTION_KINDS, where).toContain(iv.kind);
        if (iv.kind === 'disaster') {
          expect(DISASTER_KINDS, where).toContain(iv.disaster);
          expect(iv.intensity, where).toBeGreaterThan(0);
          expect(iv.intensity, where).toBeLessThanOrEqual(1);
          expect(iv.duration, where).toBeGreaterThan(0);
          expect(iv.radius, where).toBeGreaterThanOrEqual(0);
        }
        if (iv.kind === 'spawn') checkTemplate(iv.template, where);
        if (iv.kind === 'paintTerrain') expect(iv.terrain).toBeLessThan(TERRAIN_COUNT);
        if ('x' in iv) {
          expect(iv.x, where).toBeGreaterThanOrEqual(0);
          expect(iv.x, where).toBeLessThanOrEqual(W);
          expect(iv.y, where).toBeGreaterThanOrEqual(0);
          expect(iv.y, where).toBeLessThanOrEqual(H);
        }
      }
    }
  });

  it('getScenario returns a deep copy and falls back to the first scenario', () => {
    const a = getScenario('collapse');
    expect(a.id).toBe('collapse');
    expect(a).toEqual(findScenario('collapse'));
    expect(a).not.toBe(findScenario('collapse'));
    a.config.foodRegen = 0;
    a.populations[0].count = 1;
    expect(findScenario('collapse')!.config.foodRegen).not.toBe(0);
    expect(findScenario('collapse')!.populations[0].count).not.toBe(1);
    expect(getScenario('no-such-scenario').id).toBe(SCENARIOS[0].id);
    expect(findScenario('no-such-scenario')).toBeUndefined();
  });

  it('every scenario creates a populated simulation (with its tribes) and runs 500 ticks cleanly', () => {
    for (const sc of SCENARIOS) {
      const sim = Simulation.create({ scenario: sc, seed: 2024 });
      const planned = sc.populations.reduce((n, p) => n + p.count, 0);
      expect(sim.state.agents.length, sc.id).toBeGreaterThan(0.5 * planned);
      const newTribes = sc.populations.filter((p) => p.tribe === 'new').length;
      expect(sim.state.tribes.length, `${sc.id} tribes`).toBe(newTribes);
      for (const p of sc.populations.filter((q) => q.tribe === 'new')) {
        expect(sim.state.tribes.map((t) => t.name), sc.id).toContain(p.tribeName);
      }
      sim.run(500);
      expect(sim.tick).toBe(500);
      expect(sim.state.agents.length, `${sc.id} died out within 500 ticks`).toBeGreaterThan(0);
      for (const a of sim.state.agents) {
        expect(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.health) && Number.isFinite(a.food), sc.id).toBe(true);
      }
    }
  });

  it('scheduled events fire, log their notes and repeat (time-compressed copies)', () => {
    for (const sc of SCENARIOS) {
      const copy = getScenario(sc.id);
      copy.scheduled.forEach((e, i) => {
        e.tick = 2 + i;
        if (e.repeat) e.repeat = 50;
      });
      const sim = Simulation.create({ scenario: copy, seed: 1 });
      sim.run(4 + copy.scheduled.length);
      const messages = sim.state.events.map((e) => e.message);
      for (const e of copy.scheduled) expect(messages, `${sc.id}: "${e.note}"`).toContain(e.note);
      for (const e of copy.scheduled.filter((x) => x.repeat)) {
        expect(sim.state.scheduled.some((x) => x.note === e.note && x.tick > sim.tick), `${sc.id}: repeating "${e.note}"`).toBe(true);
      }
    }
  });
});
