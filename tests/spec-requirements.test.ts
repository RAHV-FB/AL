/**
 * Requirements & documentation spec (owner: requirements/docs audit; see docs/REQUIREMENTS.md).
 *
 *  1. Cheap headless checks of the original requirements: the required traits, behaviours, shocks and
 *     presets exist; every tool and intervention is explained, applied and recorded through
 *     sim.enqueue; every runtime parameter has an explained slider that applies live; the offline
 *     build is one self-contained file and the sources make no network calls; selection visibly
 *     shifts the gene pool (emergent evolution, recorded for the Genetics chart).
 *  2. Documentation drift guard: facts stated in README.md (presets, tools, overlays, shortcuts,
 *     counts, defaults, caps, files, npm scripts, CI) and the docs/REQUIREMENTS.md summary still
 *     match the code.
 *
 * Repository files are read through a dynamic `node:fs` import because tsconfig uses "types": []
 * (no @types/node), like scripts/qa-helpers.ts.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { SCENARIOS, findScenario } from '../src/sim/presets';
import { DEFAULT_CONFIG, PARAM_SPECS } from '../src/sim/config';
import { LIMITS, TERRAIN_INFO } from '../src/sim/constants';
import { INTERVENTION_HELP } from '../src/sim/interventions';
import { DISASTER_INFO } from '../src/sim/disasters';
import { createStatsState } from '../src/sim/stats';
import {
  ACTIONS,
  DISASTER_KINDS,
  G,
  GENES,
  GENE_COUNT,
  HIST_BINS,
  TERRAIN_COUNT,
  type Intervention,
  type SimConfig,
  type TerrainType,
} from '../src/sim/types';
import { DEFAULT_SETTINGS, TOOLS, brushIntervention, toolHelp } from '../src/ui/tools';
import { CONFIG_TOGGLES, OVERLAYS, VIEW_TOGGLES } from '../src/ui/controls';

// ------------------------------------------------------------------ file access (no @types/node)

interface FsLike {
  readFileSync(path: URL, encoding: 'utf8'): string;
  existsSync(path: URL): boolean;
  readdirSync(path: URL, options: { recursive: true }): string[];
}
const FS_MODULE = 'node:fs';
const fs = (await import(/* @vite-ignore */ FS_MODULE)) as FsLike;
const ROOT = new URL('../', import.meta.url);
const read = (rel: string): string => fs.readFileSync(new URL(rel, ROOT), 'utf8');
const exists = (rel: string): boolean => fs.existsSync(new URL(rel, ROOT));

const README = read('README.md');
const APP_SRC = read('src/ui/app.ts');
const fmt = (n: number): string => n.toLocaleString('en-US');
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

// ------------------------------------------------------------------ 1. requirements

describe('requirements: agents, evolution, environment', () => {
  it('agents have identity, the required vitals and the required inheritable traits', () => {
    for (const g of ['speed', 'perception', 'metabolism', 'aggression', 'sociability', 'efficiency']) expect(GENES as readonly string[]).toContain(g);
    const sim = Simulation.create({ scenario: findScenario('eden')!, seed: 101 });
    const agents = sim.state.agents;
    expect(agents.length).toBeGreaterThan(100);
    expect(new Set(agents.map((a) => a.id)).size).toBe(agents.length);
    for (const a of agents) {
      expect(a.name.length).toBeGreaterThan(1);
      for (const v of [a.age, a.health, a.energy, a.food, a.reproCooldown, a.traits.hue, a.traits.maxFood]) expect(Number.isFinite(v)).toBe(true);
      expect(a.genes).toHaveLength(GENE_COUNT);
    }
  });

  it('agents can choose every required behaviour', () => {
    // exploring, gathering, resting, fleeing, competing, helping, reproducing
    for (const k of ['explore', 'forage', 'eat', 'rest', 'flee', 'attack', 'share', 'mate', 'deposit', 'withdraw']) expect(ACTIONS as string[]).toContain(k);
  });

  it('the environment has distinct terrains, day/night, seasons and the required shocks', () => {
    expect(TERRAIN_COUNT).toBeGreaterThanOrEqual(3);
    const caps = new Set<number>();
    for (let t = 0; t < TERRAIN_COUNT; t++) {
      const info = TERRAIN_INFO[t as TerrainType];
      expect(info.name.length).toBeGreaterThan(2);
      expect(info.description.length).toBeGreaterThan(10);
      caps.add(info.maxFood);
    }
    expect(caps.size, 'regions must differ in food availability').toBeGreaterThanOrEqual(4);
    expect(DEFAULT_CONFIG.dayNight && DEFAULT_CONFIG.seasons).toBe(true);
    // drought, resource collapse (blight), disease (plague), abundance (bloom)
    for (const k of ['drought', 'blight', 'plague', 'bloom'] as const) {
      expect(DISASTER_KINDS).toContain(k);
      expect(DISASTER_INFO[k].help.length).toBeGreaterThan(15);
    }
  });

  it('selection visibly shifts the gene pool under pressure (emergent; recorded for the Genetics chart)', () => {
    const sim = Simulation.create({ scenario: findScenario('fittest')!, seed: 42 });
    // founders now have mixed ages (no synchronized die-off), so selection needs a little longer to show:
    // measured on seeds 42 / 7, the largest functional gene-mean shift is ≈0.07 on day 6 and 0.13–0.15 on day 10
    sim.run(10 * sim.config.dayLength);
    const samples = sim.state.stats.samples;
    const first = samples[0];
    const last = samples[samples.length - 1];
    expect(last.population, 'population must survive to show a trait distribution').toBeGreaterThan(0);
    expect(last.maxGeneration, 'shift must involve descendants, not just founders').toBeGreaterThanOrEqual(1);
    let best = 0;
    let bestGene = '';
    for (let i = 0; i < GENE_COUNT; i++) {
      if (i === G.hue) continue; // neutral marker
      const d = Math.abs(last.geneMeans[i] - first.geneMeans[i]);
      if (d > best) {
        best = d;
        bestGene = GENES[i];
      }
    }
    expect(best, `largest shift of a functional gene mean in 10 days (${bestGene})`).toBeGreaterThanOrEqual(0.1);
    expect(last.geneHist).toHaveLength(GENE_COUNT * HIST_BINS);
  }, 120_000);
});

describe('requirements: sandbox controls and explanations', () => {
  it('every tool maps to an explained intervention that sim.enqueue applies and records with its tick', () => {
    const sim = Simulation.create({ scenario: findScenario('eden')!, seed: 11 });
    const target = sim.state.agents[0];
    const { x, y } = sim.state.agents[1]; // brush spot inside the first band (agents to remove)
    // click tools resolved in App.clickAt: Bless, Shift-click Smite and Spawn (designer spec).
    // Every intervention below has a visible effect, so it must be applied and recorded in order.
    const made: Intervention[] = [
      { kind: 'boostAgent', id: target.id },
      { kind: 'killAgent', id: target.id },
    ];
    for (const t of TOOLS) {
      expect(t.how.length, t.id).toBeGreaterThan(15);
      expect(t.what.length, t.id).toBeGreaterThan(15);
      expect(toolHelp(t, DEFAULT_SETTINGS).lines.length, t.id).toBeGreaterThanOrEqual(2);
      const iv = brushIntervention(t.id, DEFAULT_SETTINGS, x, y, sim.config.dayLength);
      if (iv) made.push(iv);
    }
    made.push({ kind: 'spawn', x, y, count: 3, radius: 30, template: { aggression: 0.9, spread: 0.05 }, tribe: 'new', tribeName: 'Spec Tribe' });
    for (const iv of made) {
      expect(INTERVENTION_HELP[iv.kind]?.length ?? 0, iv.kind).toBeGreaterThan(20);
      sim.enqueue(iv);
    }
    expect(new Set(made.map((m) => m.kind)).size).toBeGreaterThanOrEqual(9);
    const before = sim.state.interventionLog.length;
    sim.step();
    const log = sim.state.interventionLog.slice(before);
    expect(log.map((r) => r.intervention.kind)).toEqual(made.map((m) => m.kind));
    expect(log.every((r) => r.tick === 0)).toBe(true);
    expect(sim.getAgent(target.id)).toBeUndefined(); // smitten
    expect(sim.state.tribes.some((t) => t.name === 'Spec Tribe')).toBe(true);
    expect(sim.state.events.some((e) => e.category === 'intervention')).toBe(true);
  });

  it('runtime parameters (mutation, reproduction, difficulty, …) have explained sliders and apply live, clamped', () => {
    const keys = PARAM_SPECS.map((p) => p.key);
    for (const k of ['mutationRate', 'mutationSize', 'reproductionRate', 'difficulty', 'foodRegen', 'disasterRate'] as const) expect(keys).toContain(k);
    const sim = Simulation.create({ scenario: findScenario('eden')!, seed: 12 });
    const patch: Record<string, number> = {};
    for (const p of PARAM_SPECS) {
      expect(p.help.length, p.key).toBeGreaterThan(20);
      expect(p.min, p.key).toBeLessThan(p.max);
      const def = DEFAULT_CONFIG[p.key] as number;
      expect(def, p.key).toBeGreaterThanOrEqual(p.min);
      expect(def, p.key).toBeLessThanOrEqual(p.max);
      patch[p.key] = p.max * 10; // out of range on purpose
    }
    sim.enqueue({ kind: 'setConfig', patch: patch as Partial<SimConfig> });
    sim.step();
    for (const p of PARAM_SPECS) expect(sim.config[p.key], p.key).toBe(p.max);
    expect(sim.state.interventionLog.at(-1)?.intervention.kind).toBe('setConfig');
  });

  it('provides the five required presets by name (plus bonus presets)', () => {
    const names = SCENARIOS.map((s) => s.name);
    for (const n of ['Garden of Eden', 'Survival of the Fittest', 'Two Civilizations', 'Evolution Laboratory', 'Civilization Collapse']) expect(names).toContain(n);
    for (const sc of SCENARIOS) expect(sc.lookFor.length, sc.id).toBeGreaterThanOrEqual(3);
  });
});

describe('requirements: offline, self-contained, no network', () => {
  it('release/artificial-life.html is one self-contained HTML file', () => {
    expect(exists('release/artificial-life.html')).toBe(true);
    const html = read('release/artificial-life.html');
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/<script type="module"[^>]*>/);
    expect(html, 'no external scripts').not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html, 'no external stylesheets').not.toMatch(/<link[^>]*rel="stylesheet"/i);
    const urls = html.match(/https?:\/\/[^\s"'`)<>\\]+/g) ?? [];
    expect(urls.filter((u) => !u.startsWith('http://www.w3.org/'))).toEqual([]);
  });

  it('the app sources make no network or telemetry calls', () => {
    const files = fs.readdirSync(new URL('src/', ROOT), { recursive: true }).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) {
      const src = read(`src/${f.replace(/\\/g, '/')}`);
      expect(src, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/);
    }
  });
});

// ------------------------------------------------------------------ 2. documentation drift

describe('README matches the code', () => {
  it('lists every preset by name and id, with the right count', () => {
    for (const sc of SCENARIOS) {
      expect(README, sc.id).toContain(`${sc.name} (\`${sc.id}\`)`);
    }
    expect(README).toContain(`the ${WORDS[SCENARIOS.length]} experiments`);
  });

  it('lists every tool with its key and name, every data layer, map toggle, world rule, parameter and disaster of the UI', () => {
    const squash = (v: string): string => v.toLowerCase().replace(/[\s/]+/g, '');
    const readme = squash(README);
    for (const t of TOOLS) expect(README, t.id).toContain(`\`${t.key}\` ${t.name}`);
    for (const o of OVERLAYS) if (o.value !== 'none') expect(readme, o.value).toContain(squash(o.label));
    for (const p of PARAM_SPECS) expect(readme, `PARAM_SPECS: ${p.label}`).toContain(squash(p.label));
    // map toggles (Layers menu) and world rules (Settings)
    expect(VIEW_TOGGLES.length).toBeGreaterThan(0);
    expect(CONFIG_TOGGLES.length).toBeGreaterThan(0);
    for (const v of VIEW_TOGGLES) expect(readme, `VIEW_TOGGLES: ${v.label}`).toContain(squash(v.label));
    for (const c of CONFIG_TOGGLES) expect(readme, `CONFIG_TOGGLES: ${c.label}`).toContain(squash(c.label));
    // the Disaster tool starts every kind, in the brush circle or on the whole map
    for (const k of DISASTER_KINDS) expect(readme, `DISASTER_INFO: ${DISASTER_INFO[k].label}`).toContain(squash(DISASTER_INFO[k].label));
  });

  it('documents only keyboard shortcuts that src/ui/app.ts handles', () => {
    const keys = [' ', '.', '<', '>', 'f', 'F', 'Escape', 'h', 'H', '?', 'o', 'O', '[', ']', '+', '-', '0', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 's', 'S'];
    for (const k of keys) expect(APP_SRC, `key '${k}'`).toContain(`'${k}'`);
    expect(APP_SRC).toMatch(/e\.ctrlKey \|\| e\.metaKey/); // Ctrl/⌘ + S / O
    expect(APP_SRC).toMatch(/e\.altKey/); // Alt + wheel → brush size
    expect(APP_SRC).toContain("'dblclick'"); // double-click to follow
    expect(APP_SRC).toMatch(/shift/i); // Shift-click smite
    expect(APP_SRC).toMatch(/'drop'/); // drop a save file
    for (const doc of ['`Space`', '`.`', '`<` `>`', '`1` to `9`', '`+` `-`', '`0`', '`F`', '`[` `]`', '`O`', '`Esc`', '`H` or `?`', '`Ctrl`+`S`']) expect(README, doc).toContain(doc);
  });

  it('states counts, defaults and caps that match the code', () => {
    expect(README).toContain(`${ACTIONS.length} actions`);
    expect(README).toContain(`${GENE_COUNT} genes`);
    expect(README).toContain(`${TERRAIN_COUNT} terrain types`);
    expect(README).toContain(`there are ${WORDS[DISASTER_KINDS.length]}`);
    expect(README).toContain(`${PARAM_SPECS.length} sliders`);
    const c = DEFAULT_CONFIG;
    expect(README).toContain(`\`dayLength\` ticks (default ${c.dayLength})`);
    expect(README).toContain(`\`daysPerSeason\` days (default ${c.daysPerSeason})`);
    expect(README).toContain(`${4 * c.daysPerSeason} days, or ${fmt(4 * c.daysPerSeason * c.dayLength)} ticks`);
    const cap = PARAM_SPECS.find((p) => p.key === 'maxAgents')!;
    expect(README).toContain(`default is ${fmt(c.maxAgents)} living agents, adjustable from ${fmt(cap.min)} to ${fmt(cap.max)}`);
    expect(README).toContain(`tiles ${c.tileSize} world units wide`);
    expect(README).toContain(`each agent keeps up to ${LIMITS.relationships}`);
    expect(README).toContain(`rich food spots (${LIMITS.foodMemory}) and dangerous places (${LIMITS.dangerMemory})`);
    expect(README).toContain(`at most ${fmt(LIMITS.lineage)} records`);
    expect(README).toContain(`latest ${fmt(LIMITS.interventionLog)} interventions`);
    expect(README).toContain(`sampled every ${createStatsState().sampleInterval} ticks`);
    const tps = /const BASE_TPS = (\d+);/.exec(APP_SRC);
    expect(tps).not.toBeNull();
    expect(README).toContain(`1× (${tps![1]} ticks per second)`);
    const speeds = /export const SPEEDS = \[([^\]]+)\]/.exec(APP_SRC);
    expect(speeds).not.toBeNull();
    const list = speeds![1].split(',').map((v) => Number(v.trim()));
    expect(list[0]).toBe(0.25);
    expect(Math.max(...list)).toBe(64);
    expect(list).toContain(0); // Max
    expect(README).toContain('¼× to 64×, and Max');
  });

  it('references files that exist and npm scripts that exist', () => {
    const paths = new Set<string>();
    for (const m of README.matchAll(/`((?:src|tests|scripts|docs|release|\.github)\/[\w./-]+\.\w+)`/g)) paths.add(m[1]);
    for (const m of README.matchAll(/\]\(((?:docs|release)\/[\w./-]+)\)/g)) paths.add(m[1]);
    expect(paths.size).toBeGreaterThan(10);
    for (const p of paths) expect(exists(p), p).toBe(true);
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const scripts = [...README.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(5);
    for (const s of scripts) expect(pkg.scripts, `npm run ${s}`).toHaveProperty(s);
    const knobs = [...new Set([...README.matchAll(/\bAL_[A-Z_]+/g)].map((m) => m[0]))];
    const qa = ['tests/invariants.test.ts', 'tests/longrun.test.ts', 'tests/perf.bench.test.ts', 'tests/balance.report.test.ts'].map(read).join('\n');
    for (const k of knobs) expect(qa, k).toContain(`'${k}'`);
  });

  it('describes CI and Pages deployment as configured', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/^\s+push:/m);
    expect(ci).toMatch(/^\s+pull_request:/m);
    expect(ci).toContain('npm run typecheck');
    expect(ci).toContain('npm test');
    expect(ci).toContain('npm run build');
    const pages = read('.github/workflows/pages.yml');
    expect(pages).toMatch(/^\s+branches: \[main\]$/m); // github-pages deploys from the default branch only
    expect(README).toContain('on every push to `main`');
    expect(pages).not.toMatch(/npm (test|run test)\b/);
    expect(README).toContain('It does not run the tests');
    const url = 'https://rahv-fb.github.io/AL/';
    expect(README).toContain(url);
    expect(pages).toContain(url);
  });

  it('docs/REQUIREMENTS.md summary matches its traceability table', () => {
    const doc = read('docs/REQUIREMENTS.md');
    const counts: Record<string, number> = { Done: 0, Partial: 0, Missing: 0 };
    for (const line of doc.split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length > 5 && /^[A-Z]-?\d+$/.test(cells[1]) && cells[3] in counts) counts[cells[3]]++;
    }
    const total = counts.Done + counts.Partial + counts.Missing;
    const m = /Summary: (\d+) requirements traced\. (\d+) are Done, (\d+) are Partial and (none|\d+) are Missing\./.exec(doc);
    expect(m, 'summary sentence').not.toBeNull();
    expect(Number(m![1])).toBe(total);
    expect(Number(m![2])).toBe(counts.Done);
    expect(Number(m![3])).toBe(counts.Partial);
    expect(m![4] === 'none' ? 0 : Number(m![4])).toBe(counts.Missing);
  });
});
