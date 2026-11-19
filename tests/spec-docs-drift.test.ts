/**
 * Documentation drift guards for the save / load section of README.md (owner: requirements/docs audit).
 *
 * README states two facts about loading untrusted save files that depend on code in two different
 * places: the loader (src/sim/persistence.ts) can list every repair it makes, and the app
 * (src/ui/app.ts, App.loadFile) does not show that list. These tests fail as soon as either side
 * changes, so the README is updated with it. Files are read through a dynamic `node:fs` import because
 * tsconfig uses "types": [] (no @types/node), like tests/spec-requirements.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { findScenario } from '../src/sim/presets';
import { deserializeState, serializeSim } from '../src/sim/persistence';

interface FsLike {
  readFileSync(path: URL, encoding: 'utf8'): string;
}
const FS_MODULE = 'node:fs';
const fs = (await import(/* @vite-ignore */ FS_MODULE)) as FsLike;
const ROOT = new URL('../', import.meta.url);
const read = (rel: string): string => fs.readFileSync(new URL(rel, ROOT), 'utf8');

describe('README: loading save files', () => {
  it('the loader repairs damaged values and lists each repair only when asked', () => {
    const sim = Simulation.create({ scenario: findScenario('eden')!, seed: 3 });
    sim.run(10);
    const file = JSON.parse(serializeSim(sim)) as { state: { agents: Record<string, unknown>[] } };
    file.state.agents[0].health = 'broken';
    file.state.agents[1].tribeId = 99999; // a tribe that was never allocated
    const text = JSON.stringify(file);
    const warnings: string[] = [];
    const state = deserializeState(text, { warnings });
    expect(Number.isFinite(state.agents[0].health)).toBe(true);
    expect(warnings.some((w) => w.startsWith('agent.health'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('agent.tribeId'))).toBe(true);
    expect(() => deserializeState(text)).not.toThrow(); // without the option the repairs are silent
    expect(read('README.md')).toContain('`deserializeState(json, { warnings })`');
  });

  it('README says whether the app shows the repairs, matching App.loadFile', () => {
    const app = read('src/ui/app.ts');
    const call = /deserializeState\(([^)]*)\)/.exec(app);
    expect(call, 'App.loadFile calls deserializeState').not.toBeNull();
    const appShowsRepairs = /warnings/.test(call![1]);
    const readmeSaysHidden = read('README.md').includes('the app does not show that list');
    expect(readmeSaysHidden, 'README "Loading" bullet is out of date with App.loadFile').toBe(!appShowsRepairs);
  });
});
