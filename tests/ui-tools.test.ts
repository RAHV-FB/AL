/**
 * UI regression tests that run headless (no DOM): what a tool previews must be what it does,
 * and the theme's small-text colour must stay readable. The interactive behaviour of every
 * control is covered in the browser by scripts/ui-audit.mjs.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, METEOR_MAX_RADIUS, Painter, TOOLS, brushIntervention, effectiveRadius, type ToolSettings } from '../src/ui/tools';
import { DISASTER_KINDS } from '../src/sim/types';

// Vitest stubs CSS imports (even ?raw), so read the stylesheet from disk (no @types/node needed).
const FS_MODULE = 'node:fs';
const fs = (await import(/* @vite-ignore */ FS_MODULE)) as { readFileSync(path: URL, encoding: 'utf8'): string };
const css = fs.readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');

describe('brush tools: preview radius equals the applied radius', () => {
  it('every brush tool applies exactly the radius the preview / HUD show', () => {
    for (const t of TOOLS) {
      if (!t.brush || t.id === 'spawn') continue; // spawn builds its SpawnSpec in the designer
      for (const disaster of DISASTER_KINDS) {
        for (const radius of [6, 40, 119, 120, 121, 250, 320]) {
          const s: ToolSettings = { ...DEFAULT_SETTINGS, radius, disaster };
          const iv = brushIntervention(t.id, s, 100, 120, 600);
          expect(iv, `${t.id}/${disaster}`).not.toBeNull();
          expect((iv as { radius: number }).radius, `${t.id}/${disaster}/r${radius}`).toBe(effectiveRadius(t.id, s));
        }
      }
    }
  });

  it('a meteor is capped (the old preview showed the raw slider radius)', () => {
    const s: ToolSettings = { ...DEFAULT_SETTINGS, radius: 250, disaster: 'meteor' };
    expect(effectiveRadius('disaster', s)).toBe(METEOR_MAX_RADIUS);
    const iv = brushIntervention('disaster', s, 10, 10, 600);
    expect(iv).toMatchObject({ kind: 'disaster', disaster: 'meteor', radius: METEOR_MAX_RADIUS });
    // other disasters and tools keep the full brush
    expect(effectiveRadius('disaster', { ...s, disaster: 'drought' })).toBe(250);
    expect(effectiveRadius('remove', s)).toBe(250);
  });

  it('the disaster tool passes intensity and duration (days × day length) through', () => {
    const iv = brushIntervention('disaster', { ...DEFAULT_SETTINGS, disaster: 'plague', intensity: 0.4, durationDays: 1.5 }, 0, 0, 600);
    expect(iv).toMatchObject({ kind: 'disaster', intensity: 0.4, duration: 900 });
  });
});

describe('Painter', () => {
  it('fills a fast stroke with stamps no further apart than half the radius', () => {
    const pts: [number, number][] = [];
    const p = new Painter((x, y) => pts.push([x, y]));
    p.begin(0, 0, 0);
    p.move(60, 0, 10, 100, false); // one pointer event after a long, fast drag
    p.end(60, 0, 10, 110);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1][0]).toBeCloseTo(60, 6);
    for (let i = 1; i < pts.length; i++) expect(pts[i][0] - pts[i - 1][0]).toBeLessThanOrEqual(5 + 1e-9);
  });

  it('air-brush tools repeat while held still; others do not', () => {
    for (const airbrush of [true, false]) {
      let n = 0;
      const p = new Painter(() => n++);
      p.begin(5, 5, 0);
      for (let t = 50; t <= 1000; t += 50) p.hold(20, t, airbrush);
      p.end(5, 5, 20, 1000);
      if (airbrush) expect(n).toBeGreaterThanOrEqual(3);
      else expect(n).toBe(1);
    }
  });
});

/** WCAG 2 relative luminance / contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe('theme contrast', () => {
  const token = (name: string): string => {
    const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
    if (!m) throw new Error(`--${name} not found in styles.css`);
    return m[1];
  };

  it('small secondary text (--faint, --muted) reads at ≥ 4.5:1 on every panel surface', () => {
    // #111824 is the lightest surface measured under --faint text (experiment buttons on the panel)
    const surfaces = [token('bg'), token('bg-2'), token('panel'), token('panel-2'), '#111824'];
    for (const fg of ['faint', 'muted', 'text']) {
      for (const bg of surfaces) expect(contrast(token(fg), bg), `--${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
