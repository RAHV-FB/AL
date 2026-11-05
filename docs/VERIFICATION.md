# Verification

How to verify an Artificial Life build, and what was actually measured. **Only record results you ran yourself.** Note the date, the commit and which modules were complete at the time.

## Commands

```bash
npm ci                                   # clean install (Node 22)
npm run typecheck                        # tsc --noEmit over src/, tests/, scripts/
npm test -- --silent=false               # full vitest suite with printed reports
npm run bench -- --silent=false          # perf benchmark alone (cleanest numbers)
npx vitest run tests/balance.report.test.ts --silent=false   # per-day balance tables
npm run build                            # → dist/index.html (single self-contained file)
node scripts/browser-smoke.mjs           # headless Chromium on dist/index.html + docs/screenshot.png
```

Knobs: `AL_INVARIANT_TICKS` (3000), `AL_LONGRUN_TICKS` (20000), `AL_LONGRUN_HEAP_MB` (150), `AL_PERF_BUDGET_MS` (25), `AL_BALANCE_DAYS` (12), `AL_BALANCE_SCENARIO`, `AL_SEED` (42).

## Checklist (release)

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | Typecheck clean | `npm run typecheck` | TBD |
| 2 | All tests pass, including save/load (not skipped) | `npm test -- --silent=false` | TBD |
| 3 | Perf: mean ms/tick at ~1000 agents | `npm run bench -- --silent=false` | TBD |
| 4 | Long run: 20k ticks bounded, no heap growth | `npx vitest run tests/longrun.test.ts --silent=false` | TBD |
| 5 | Balance: no preset goes extinct unintentionally within 12 days | balance report | TBD |
| 6 | Build produces one file that works from file:// | `npm run build` and open `dist/index.html` | TBD |
| 7 | Browser smoke passes (no console errors, non-blank canvas, controls respond) | `node scripts/browser-smoke.mjs` | TBD |
| 8 | GitHub Pages deploy is green and https://rahv-fb.github.io/AL/ loads | Actions tab and browser | TBD |
| 9 | Manual: each preset shows its "look for" behavior | open each preset, ~2 min at high speed | TBD |

---

## Recorded results

### 2026-11-05: mid-integration snapshot (QA engineer)

**Tree state:** the base commit `ec3719b` plus uncommitted work in progress.

- **Landed:** `genetics.ts`, `stats.ts` and `lifecycle.ts` (metabolism), plus parts of the UI and render code.
- **Still stubs:** `brain.ts` (agents only wander and never eat), `interventions.ts` (only `spawn`), `ecology.ts`, `social.ts`, `disease.ts`, `disasters.ts`, `world.ts` (flat grass), `persistence.ts` (throws "not implemented") and `presets.ts` (only `eden`).

These numbers therefore validate the **harness**, not the final simulation.

`npx vitest run --silent=false` reported **6 files passed; 14 tests passed, 1 skipped**:

- **Skipped:** save → load → continue. `serializeSim` is still "not implemented".
- **Determinism:** same seed and the same scripted interventions give identical hashes at 7 checkpoints. Different seeds differ, intervention-log replay matches, and `Math.random` was never called. All pass.
- **Invariants:** `eden` held all invariants for 3,000 ticks (0.36 ms/tick). The intervention barrage peaked at 1,000 agents (the cap held) and passed. Because `interventions.ts` is a stub, the wall and deep-water paint checks are not exercised yet.
- **Long run:** 20,000 ticks on `eden` with seeds 777 and 778 took 3.1 s and 2.2 s. The footprint stayed bounded (667 stat samples, 120 lineage records). Heap was 13.1 → 17.6 MB and 18.6 → 16.2 MB.
- **Performance** (stub brain, so not representative):

  | Agents | Ticks | Mean ms/tick | p50 | p95 | Max |
  | --- | --- | --- | --- | --- | --- |
  | 1,000 → 1,000 | 500 | 0.53 | 0.46 | 1.17 | 10.13 |
  | 120 (default) | 500 | 0.15 | n/a | 0.19 | n/a |

- **Balance:** in `eden` the population starved to extinction by day 3: 120 → 55 → 0, all deaths by starvation, total world food untouched at 175.0k. The cause is that lifecycle's metabolism has landed but the brain stub never eats. Expected to resolve when `brain.ts` lands.

`node scripts/browser-smoke.mjs` against the stub-UI build passed:

- 2880×1800 canvas, 194 distinct colors, luminance standard deviation 10.1
- no console errors
- no Pause/Play/speed buttons existed yet

### Final release run

*(Lead: paste the outputs of the checklist commands here after integration.)*

## Results — integration run (2026-11-05, Linux container, Node 22, 4 vCPU)

`npx vitest run --exclude tests/balance.report.test.ts --silent=false` → **17 test files, 229 tests passed, 0 failed.**

Invariants (every preset, 3000 ticks, all checks passing):

| preset | pop @3000 | peak | births | deaths | tribes | ms/tick |
| --- | --- | --- | --- | --- | --- | --- |
| eden | 1000 | 1000 | 850 | 0 | 38 | 3.26 |
| fittest | 175 | 321 | 237 | 242 | 13 | 1.86 |
| two-civs | 856 | 856 | 637 | 1 | 31 | 2.94 |
| evolab | 805 | 805 | 626 | 1 | 30 | 2.18 |
| collapse | 1400 | 1400 | 1240 | 0 | 39 | 4.25 |
| plague-island | 857 | 857 | 758 | 106 | 32 | 2.66 |
| predators | 970 | 970 | 759 | 1 | 37 | 2.44 |

Performance (`tests/perf.bench.test.ts`): 1000 agents → mean **4.47 ms/tick** (p50 3.77, p95 8.72, max 32.9) ≈ 224 ticks/s; default eden population (~228) → 1.68 ms/tick.

Long run (`tests/longrun.test.ts`): eden 20 000 ticks at 7.29 ms/tick, heap 28.4 → 24.4 MB; predators 20 000 ticks at 2.18 ms/tick, heap 27.4 → 38.3 MB (bounded; all state arrays within LIMITS).

Determinism: identical seeds + identical interventions → identical hashes; replay of the intervention log reproduces the original hash; save → load → continue equals uninterrupted run.

Browser: `npm run build && node scripts/browser-smoke.mjs` → single-file `dist/index.html` (358 kB) loaded via `file://`, no console errors, canvas rendered (590 distinct colours), screenshot at `docs/screenshot.png`.

Balance note (12-day headless report, `npm run balance`): populations boom, then thin out in winter (days 9–11); most presets survive at reduced numbers, `collapse` collapses by design.
