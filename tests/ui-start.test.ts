/**
 * Start screen, headless: the seed box accepts exactly the seeds the simulation can use, and every
 * experiment has the texts the start screen shows (a short line, a description and 2 to 4 points to
 * watch for), with no dashes once they pass through plainText().
 */
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../src/sim/presets';
import { DEFAULT_CONFIG } from '../src/sim/config';
import { defaultSeedOf, parseSeed } from '../src/ui/start';
import { plainText } from '../src/ui/analytics';

describe('seed box', () => {
  it('accepts whole numbers from 0 to 4294967295', () => {
    expect(parseSeed('0')).toBe(0);
    expect(parseSeed(' 777 ')).toBe(777);
    expect(parseSeed('4294967295')).toBe(4294967295);
  });

  it('treats anything else as no seed', () => {
    for (const s of ['', ' ', '-1', '1.5', '12ab', '4294967296', '99999999999', '1e5']) expect(parseSeed(s), s).toBeUndefined();
  });

  it('the default seed is the experiment seed, else the app default', () => {
    for (const sc of SCENARIOS) {
      const want = (sc.config.seed ?? DEFAULT_CONFIG.seed) >>> 0;
      expect(defaultSeedOf(sc)).toBe(want);
    }
  });
});

describe('experiment texts on the start screen', () => {
  it('there are seven experiments with distinct ids and names', () => {
    expect(SCENARIOS.length).toBe(7);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(7);
    expect(new Set(SCENARIOS.map((s) => s.name)).size).toBe(7);
  });

  for (const sc of SCENARIOS) {
    it(`${sc.name}: a short line, a description and points to watch for, without dashes`, () => {
      const tag = plainText(sc.tagline);
      const desc = plainText(sc.description);
      const look = (sc.lookFor ?? []).slice(0, 4).map(plainText);
      expect(tag.length).toBeGreaterThan(8);
      expect(tag.length).toBeLessThan(120);
      expect(desc.length).toBeGreaterThan(40);
      expect(look.length).toBeGreaterThanOrEqual(2);
      for (const t of [tag, desc, ...look]) {
        expect(t, t).not.toMatch(/[‒-―]/);
        expect(t, t).not.toMatch(/\b[A-Z]{3,}\b/);
        expect(t.trim(), t).toBe(t);
      }
    });
  }
});
