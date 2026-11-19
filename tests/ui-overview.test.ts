/**
 * Overview tab, headless: describeNow() and tribeSummaries() read only real simulation state, write plain
 * sentences (no dashes, sentence case, full stops) and say what the state says.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS } from '../src/sim/presets';
import { clockOfTick, dayOfTick, describeNow, tribePairs, tribeSummaries } from '../src/ui/analytics';

const scenario = (id: string) => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
};

const living = (sim: Simulation) => sim.state.agents.filter((a) => a.alive).length;

function checkSentences(lines: string[]): void {
  expect(lines.length).toBeGreaterThanOrEqual(1);
  expect(lines.length).toBeLessThanOrEqual(6);
  for (const l of lines) {
    expect(l, l).not.toMatch(/[\u2012-\u2015]/); // no figure, en or em dashes
    expect(l, l).toMatch(/^[A-Z0-9]/);
    expect(l, l).toMatch(/[.!?]$/);
    expect(l, l).not.toMatch(/undefined|NaN|Infinity|\[object/);
  }
}

describe('describeNow', () => {
  it('Garden of Eden after a day and a half: population, its change, food and peace', () => {
    const sim = Simulation.create({ scenario: scenario('eden'), seed: 5 });
    sim.run(Math.round(sim.config.dayLength * 1.5));
    const lines = describeNow(sim);
    checkSentences(lines);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const pop = living(sim);
    expect(lines[0]).toContain(pop.toLocaleString('en-US'));
    expect(lines[0]).toMatch(/agents?/);
    // the change over the last day matches the samples
    const trend = lines.find((l) => l.startsWith('The population'));
    expect(trend, lines.join(' | ')).toBeTruthy();
    expect(trend).toContain('over the last day');
    const samples = sim.state.stats.samples;
    let ref = samples[0];
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i].tick <= sim.tick - sim.config.dayLength) {
        ref = samples[i];
        break;
      }
    }
    const delta = pop - ref.population;
    if (/grew by/.test(trend!)) expect(trend).toContain(`grew by ${delta.toLocaleString('en-US')}`);
    if (/fell by/.test(trend!)) expect(trend).toContain(`fell by ${(-delta).toLocaleString('en-US')}`);
    expect(lines.some((l) => /^Food stands at \d+% of what the land can hold/.test(l))).toBe(true);
  });

  it('Two Civilizations: the old rivals are named as being at war, and the tribes list says so', () => {
    const sim = Simulation.create({ scenario: scenario('two-civs'), seed: 42 });
    sim.run(200);
    const lines = describeNow(sim);
    checkSentences(lines);
    const ids = new Set(sim.state.tribes.filter((t) => t.extinctTick === -1).map((t) => t.id));
    const { wars } = tribePairs(sim, ids);
    const war = lines.find((l) => /at war/.test(l));
    if (wars.length) {
      expect(war, lines.join(' | ')).toBeTruthy();
      const [a, b] = wars[0];
      expect(war).toContain(sim.getTribe(a)!.name);
      expect(war).toContain(sim.getTribe(b)!.name);
      const rows = tribeSummaries(sim);
      const ra = rows.find((r) => r.id === a)!;
      expect(ra.relations).toContain(`At war with ${sim.getTribe(b)!.name}`);
    } else {
      expect(war ?? '').toMatch(/^No tribes are at war|^$/);
    }
    const rows = tribeSummaries(sim);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (i > 0) expect(r.members).toBeLessThanOrEqual(rows[i - 1].members);
      expect(Number.isFinite(r.x) && Number.isFinite(r.y)).toBe(true);
      expect(r.relations).toMatch(/^[A-Z]/);
      expect(r.relations).not.toMatch(/[\u2012-\u2015]/);
      total += r.members;
    }
    expect(total).toBeLessThanOrEqual(living(sim));
  });

  it('reports an epidemic and a map-wide drought with the days left', () => {
    const sim = Simulation.create({ scenario: scenario('eden'), seed: 9 });
    sim.run(60);
    sim.enqueue({ kind: 'disaster', disaster: 'plague', x: 520, y: 420, radius: 200, intensity: 1, duration: 1200 });
    sim.enqueue({ kind: 'disaster', disaster: 'drought', x: 800, y: 500, radius: 0, intensity: 0.7, duration: 1800 });
    sim.run(40);
    const lines = describeNow(sim);
    checkSentences(lines);
    const infected = sim.state.agents.filter((a) => a.alive && a.infection > 0).length;
    expect(infected).toBeGreaterThan(0);
    const sick = lines.find((l) => /infected|sick/.test(l));
    expect(sick, lines.join(' | ')).toBeTruthy();
    expect(sick).toContain(infected.toLocaleString('en-US'));
    const drought = lines.find((l) => /drought/.test(l));
    expect(drought, lines.join(' | ')).toBeTruthy();
    expect(drought).toContain('across the whole map');
    expect(drought).toMatch(/\d+ days left|about a day left|less than a day left/);
  });

  it('an empty world says so', () => {
    const sim = Simulation.create({ scenario: scenario('eden'), seed: 3 });
    sim.enqueue({ kind: 'remove', x: 800, y: 500, radius: 5000 });
    sim.run(2);
    expect(living(sim)).toBe(0);
    const lines = describeNow(sim);
    checkSentences(lines);
    expect(lines[0]).toBe('No agents are alive.');
  });

  it('works on a fresh world before any samples exist', () => {
    for (const sc of SCENARIOS) {
      const sim = Simulation.create({ scenario: sc, seed: 1 });
      const lines = describeNow(sim);
      checkSentences(lines);
      expect(lines.some((l) => l.startsWith('The population')), sc.id).toBe(false);
    }
  });
});

describe('clockOfTick', () => {
  it('uses the same day as dayOfTick and a 24 hour time', () => {
    const sim = Simulation.create({ scenario: SCENARIOS[0], seed: 2 });
    for (const t of [0, 1, 150, 599, 600, 1234, 9999]) {
      const s = clockOfTick(sim, t);
      expect(s).toMatch(/^Day \d+, \d\d:\d0$/);
      expect(s.startsWith(`Day ${dayOfTick(sim, t)},`)).toBe(true);
    }
  });
});
