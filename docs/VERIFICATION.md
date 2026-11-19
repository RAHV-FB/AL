# Verification

How to verify an Artificial Life build, and the results of each recorded run. Record only results you ran yourself, and note the date, the commit and which modules were complete at the time.

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

Environment knobs, with their defaults: `AL_INVARIANT_TICKS` (3000), `AL_LONGRUN_TICKS` (20000), `AL_LONGRUN_HEAP_MB` (150), `AL_PERF_BUDGET_MS` (25), `AL_BALANCE_DAYS` (12), `AL_BALANCE_SCENARIO`, `AL_SEED` (42).

## Release checklist

The recorded results below refer to these checks by number.

| # | Check | Command |
| --- | --- | --- |
| 1 | Typecheck is clean | `npm run typecheck` |
| 2 | All tests pass, including save/load (not skipped) | `npm test -- --silent=false` |
| 3 | Mean ms per tick at about 1000 agents | `npm run bench -- --silent=false` |
| 4 | A 20k-tick long run stays bounded, with no heap growth | `npx vitest run tests/longrun.test.ts --silent=false` |
| 5 | No preset goes extinct unintentionally within 12 days | balance report |
| 6 | The build produces one file that works from file:// | `npm run build` and open `dist/index.html` |
| 7 | The browser smoke test passes (no console errors, non-blank canvas, controls respond) | `node scripts/browser-smoke.mjs` |
| 8 | The GitHub Pages deploy is green and https://rahv-fb.github.io/AL/ loads | Actions tab and browser |
| 9 | Each preset shows its "look for" behavior (manual) | open each preset, about 2 minutes at high speed |

## Recorded results

### 2026-11-05: mid-integration snapshot (QA engineer)

The tree was the base commit `ec3719b` plus uncommitted work in progress. `genetics.ts`, `stats.ts` and `lifecycle.ts` (metabolism) had landed, along with parts of the UI and render code. These modules were still stubs: `brain.ts` (agents only wandered and never ate), `interventions.ts` (only `spawn`), `ecology.ts`, `social.ts`, `disease.ts`, `disasters.ts`, `world.ts` (flat grass), `persistence.ts` (threw "not implemented") and `presets.ts` (only `eden`). These numbers therefore validate the test harness only.

`npx vitest run --silent=false` reported 6 files passed, with 14 tests passed and 1 skipped:

- The skipped test was save, load and continue, because `serializeSim` was still "not implemented".
- Determinism passed. The same seed and the same scripted interventions gave identical hashes at 7 checkpoints, different seeds differed, the intervention-log replay matched, and `Math.random` was never called.
- `eden` held all invariants for 3,000 ticks (0.36 ms/tick). The intervention barrage peaked at 1,000 agents (the cap held) and passed. The wall and deep-water paint checks were not exercised yet, because `interventions.ts` was a stub.
- The long run, 20,000 ticks on `eden` with seeds 777 and 778, took 3.1 s and 2.2 s. The footprint stayed bounded (667 stat samples, 120 lineage records), and the heap went from 13.1 to 17.6 MB and from 18.6 to 16.2 MB.
- Performance with the stub brain, which is not representative:

  | Agents | Ticks | Mean ms/tick | p50 | p95 | Max |
  | --- | --- | --- | --- | --- | --- |
  | 1,000 at start and end | 500 | 0.53 | 0.46 | 1.17 | 10.13 |
  | 120 (default) | 500 | 0.15 | n/a | 0.19 | n/a |

- In the balance report `eden` starved to extinction by day 3 (120, then 55, then 0), all deaths by starvation, while total world food stayed untouched at 175.0k. Lifecycle's metabolism had landed but the brain stub never ate, so this was expected to resolve when `brain.ts` landed.

`node scripts/browser-smoke.mjs` passed against the stub-UI build: a 2880×1800 canvas with 194 distinct colors and a luminance standard deviation of 10.1, and no console errors. The Pause, Play and speed buttons did not exist yet.

### 2026-11-05: integration run (Linux container, Node 22, 4 vCPU)

`npx vitest run --exclude tests/balance.report.test.ts --silent=false`: 17 test files, 229 tests passed, 0 failed.

Every preset held all invariant checks over 3000 ticks:

| Preset | Population at tick 3000 | Peak | Births | Deaths | Tribes | ms/tick |
| --- | --- | --- | --- | --- | --- | --- |
| eden | 1000 | 1000 | 850 | 0 | 38 | 3.26 |
| fittest | 175 | 321 | 237 | 242 | 13 | 1.86 |
| two-civs | 856 | 856 | 637 | 1 | 31 | 2.94 |
| evolab | 805 | 805 | 626 | 1 | 30 | 2.18 |
| collapse | 1400 | 1400 | 1240 | 0 | 39 | 4.25 |
| plague-island | 857 | 857 | 758 | 106 | 32 | 2.66 |
| predators | 970 | 970 | 759 | 1 | 37 | 2.44 |

In `tests/perf.bench.test.ts`, 1000 agents took a mean of 4.47 ms per tick (p50 3.77, p95 8.72, max 32.9), about 224 ticks/s. The default eden population (~228) took 1.68 ms per tick.

In `tests/longrun.test.ts`, eden ran 20,000 ticks at 7.29 ms/tick with the heap going from 28.4 to 24.4 MB, and predators ran 20,000 ticks at 2.18 ms/tick with the heap going from 27.4 to 38.3 MB. Both stayed bounded, with all state arrays within `LIMITS`.

Identical seeds and interventions gave identical hashes, replaying the intervention log reproduced the original hash, and save, load and continue matched the uninterrupted run.

`npm run build && node scripts/browser-smoke.mjs` produced a single-file `dist/index.html` (358 kB) that loaded over `file://` with no console errors. The canvas rendered 590 distinct colors, and the screenshot went to `docs/screenshot.png`.

In the 12-day headless balance report (`npm run balance`), populations boomed, then thinned out in winter (days 9 to 11). Most presets survived at reduced numbers, and `collapse` collapsed, as designed.

### 2026-11-18: requirements and documentation audit

The requirements and docs auditor ran this audit against baseline `7d0a909`. Four other auditors were editing `src/` in the same working tree at the same time, so measurements on the working tree are marked as such. At the time, [`docs/REQUIREMENTS.md`](REQUIREMENTS.md) traced 74 requirements: 69 Done, 5 Partial, 0 Missing.

| # | Check | What was run | Result |
| --- | --- | --- | --- |
| 6 | The release file matches the committed source | Built `git archive HEAD` in a scratch folder with `npx vite build`, then compared it with `cmp` | Pass. `release/artificial-life.html` is byte-identical to the fresh build of `7d0a909` (357,853 bytes). It was a manual copy; no npm script produced it yet. |
| 6/7 | The release file works from `file://` | `node scripts/browser-smoke.mjs --url file:///…/release/artificial-life.html --no-screenshot --wait 3000` | Pass: 1624×1696 canvas, 606 distinct colors, luminance sd 53.6, no console errors and no failed requests. The script's "speed" click landed on the Eden experiment button, though, because the speed buttons have `role="radio"` and `/fast/` matches the Eden tagline. It also never found the 1× button, so only play/pause and the keys were really exercised. |
| 8 | GitHub Pages deploy is green and the site loads | Read-only GitHub Actions API calls | Fail. CI run #6 on `7d0a909` passed. All five Pages runs (#2 to #6, the last being 42089509958 on `7d0a909`) passed the `build` job but failed the `deploy` job, which never got a runner and stopped after about 2 seconds. No deployment had ever succeeded. The repository had one branch, `claude/artificial-life-simulator-8iuk86`. The site was not fetched. The fix belonged in the repository settings: set the Pages source to GitHub Actions, and allow the branch in the `github-pages` environment. |
| 5 | Balance of `fittest` over 12 days (the speed gene, the crash) | A temporary vitest file, seeds 42 and 7 | See the table below. |
| | Saving during a replay (gap G1) | A temporary vitest file, on the baseline and again on the working tree | Defect confirmed. The replay reproduced the original hash, but a save taken at tick 50 during the replay, loaded and run to tick 300, diverged: its intervention log had 0 entries instead of 1. |
| | Intervention-log cap (gap G2) | A temporary vitest file, on the baseline and again on the working tree | Defect confirmed. A spawn followed by 5,000 Add food stamps left only the last 5,000 entries in the log, so the spawn was lost and the replay diverged. |
| | Requirements and README drift | `npx vitest run tests/spec-requirements.test.ts` | Pass, 16 of 16 (2026-11-19 00:10 UTC, working tree). The file checks the required traits, behaviors, shocks and presets. It also checks that every tool and intervention is explained, applied and logged through `sim.enqueue`; that every parameter has an explained slider that applies live and is clamped; that the release file is self-contained; that the sources make no network calls; that the gene pool shifts under selection; and that the README's presets, tools, overlays, toggles, shortcuts, counts, defaults, caps, files, npm scripts and CI claims match the code. |
| 1 | Typecheck | `npx tsc --noEmit` | Pass, except for other auditors' temporary files. The full run failed only in `tests/core-tmp-dump.test.ts`, another auditor's temporary file that uses `process`. Excluding `tests/*-tmp-*.test.ts` gave exit code 0. |

`fittest` at baseline `7d0a909`, where population is the end-of-day count and speed is the mean speed gene:

| Day | Seed 42 population | Seed 42 speed | Seed 7 population | Seed 7 speed |
| --- | --- | --- | --- | --- |
| 0 | 180 | 0.48 | 180 | 0.46 |
| 3 | 300 | 0.55 | 316 | 0.52 |
| 6 | 50 | 0.63 | 150 | 0.62 |
| 9 | 14 | 0.82 | 21 | 0.76 |
| 12 | 6 | 0.88 | 15 | 0.75 |

The population first grew to about 300. A starvation crash followed on days 4 to 8, killing up to 110 agents a day, and later deaths were mostly from old age. At baseline the loners formed up to 15 tribes in seed 42 and 21 in seed 7. Efficiency did not rise: it moved from 0.49 to 0.33 in seed 42 and stayed at 0.48 in seed 7, which contradicted the preset's in-app "look for" text (`presets.ts:118`).

On the working tree at 2026-11-19 00:10 UTC, with other auditors' fixes in progress, the population was 249/250 on day 1, 169/152 on day 6 and 15/15 on day 12 (seeds 42/7). The speed gene rose from 0.48 to 0.71 and from 0.46 to 0.75, efficiency fell to 0.44, and the loners formed 2 to 4 tribes.

The audit made these README corrections:

- The offline file was corrected to `release/artificial-life.html`, because `dist/` is gitignored.
- The online link said that no deployment had succeeded yet.
- The `Esc` row was changed to match the UI auditor's change: Esc deselects, stops following and switches back to Inspect.
- Missing shortcuts and mouse actions were added.
- The CI and Pages triggers were described correctly, with a note that the Pages workflow does not run tests.
- The architecture file list was completed.
- The limitations gained the replay-log cap, saving mid-replay and the single resource type.

### 2026-11-19: independent re-check of the documentation audit

A second verifier re-ran the audit's checks against the working tree: baseline `7d0a909` plus the other auditors' uncommitted changes, which were still landing. Times are UTC.

| # | Check | What was run | Result |
| --- | --- | --- | --- |
| 6 | The release file matches the committed source | Built `git archive HEAD` with `npx vite build` in a scratch folder and compared it with `cmp` | Pass. Byte-identical (357,853 bytes). |
| 6/7 | The release file works from `file://` | `node scripts/browser-smoke.mjs --url file:///…/release/artificial-life.html --no-screenshot --wait 3000` | Pass at 00:13: 1624×1696 canvas, 603 distinct colors, luminance sd 53.6, no errors. The same caveat applied: the "speed" click hit the Eden experiment button, and no 1× button was found. At 00:30, with the UI auditor's updated script, it passed again (596 colors), and the script now set 4× and then 1× through the speed radio group and checked that each took effect. |
| 8 | GitHub Pages deploy | Read-only GitHub Actions API calls | Fail, with a correction: there were six Pages runs (#1 to #6), not five. Run #1 (42085639543 on `cc49c0d`) failed the same way. All six passed `build` and failed `deploy` after about 2 seconds. |
| | Saving during a replay (G1) | A temporary vitest file, run on the working tree (00:18) and on a copy of the baseline | Still reproduced. On the working tree the original and the replay both hashed to `5ec394e2…`, but saving the replay at tick 50, loading it and running to tick 300 gave `ed092790…`, with 0 log entries instead of 1. On the baseline: `a0e6e6a5…` against `1b8a66fe…`. |
| | Intervention-log cap (G2) | The same file | Still reproduced. With `LIMITS.interventionLog` at 5,000, the spawn was dropped and the replay diverged. The working tree now also set `interventionLogDropped` to 1 and logged one "The intervention log is full" event (category You). The baseline did neither. |
| | Save, load and continue | `plague-island`, seeds 1, 2, 3 and 5, saved mid-epidemic (ticks 1,900 to 2,100); both copies continued to tick 4,200 | The trajectory was identical in 4 of 4 runs (`hash({ events: false })`), but the event logs differed in 4 of 4 (1 to 30 messages). In one run, for example, one copy reported that the epidemic had burned out with 34 dead (peak 33 infected) and the other with 17 dead (peak 17 infected), and an alliance announcement was missing. The baseline did the same ("peak 13" against "peak 12" in the determinism-test scenario). The README was changed to say so; the final results below show that this was fixed later. |
| | Load repairs | A damaged save (health set to a string, an unknown tribe id) | The values were repaired, and `deserializeState(text, { warnings })` listed both repairs. `App.loadFile` (`src/ui/app.ts`) called `deserializeState(text)` with no options and showed only the "Loaded" toast, so the user never saw them. The README and REQUIREMENTS E12 were corrected, and `tests/spec-docs-drift.test.ts` guards the README wording. The app has since been changed to show the repairs. |
| 5 | `fittest` over 12 days | A temporary vitest file, working tree at 00:21 | Seed 42: 180 at the start, a peak of 256, 127 on day 6 and 15 on day 12. The speed gene went from 0.48 to 0.82 and efficiency from 0.49 to 0.56. Seed 7: 180, a peak of 232, 117 on day 6 and 8 on day 12; speed went from 0.46 to 0.66 and efficiency from 0.48 to 0.30. There were at most 4 and 2 tribes. The same code run on the baseline copy reproduced the baseline table above exactly. |
| | Requirements and README drift | `npx vitest run tests/spec-requirements.test.ts` | 15 of 16 at 00:14: the core auditor had briefly raised `LIMITS.interventionLog` to 50,000, and the README check caught the stale "5,000". From 00:19 on, with the cap back at 5,000, 16 of 16. |
| | Docs drift, save/load and determinism | `npx vitest run tests/spec-requirements.test.ts tests/spec-docs-drift.test.ts` (00:27, again 00:30); `npx vitest run tests/determinism.test.ts tests/persistence.test.ts` (00:28) | Pass: 18 of 18, and 39 of 39. |
| 1 | Typecheck | `npx tsc --noEmit` (00:27, again 00:30) | Pass (exit code 0). The other auditors' temporary files no longer broke it. |

### 2026-11-19: final results after the audit (Linux container, Node 22, 4 shared vCPU)

All numbers in this section come from runs on the final tree. Five parallel audits (core, behavior, ecology, UI, spec and docs), each followed by an independent adversarial verifier, fixed the defects in the gap list of `docs/REQUIREMENTS.md` and added regression tests.

`npx vitest run --exclude tests/balance.report.test.ts` ran 36 files and 365 tests, all passing. One test, the REQUIREMENTS summary check, was re-run on its own after a wording fix, and all 18 spec tests passed. `npx tsc --noEmit` was clean.

`npm run build` produced a single-file `dist/index.html` of about 379 kB. With that build:

- `node scripts/ui-audit.mjs --file dist/index.html` reported 231 passed and 0 failed. It drives every visible control in Chromium and asserts its real effect, checks the layout at 1280×720, 1440×900 and 1920×1080, checks WCAG AA contrast, and fails on console errors.
- `node scripts/browser-smoke.mjs` passed over `file://` (589 distinct colors, speed set to 4× and then 1×, no console errors) and refreshed `docs/screenshot.png`.
- With about 1000 agents the app rendered 60 FPS at 30 TPS on 1×, and 39 FPS at 175 to 181 TPS on Max, with about 1.2 ms of render time per frame.

In `tests/perf.bench.test.ts`, 1000 agents took a mean of 3.86 ms per tick (p50 3.09, p95 8.02), about 259 ticks/s, and eden's starting population took 0.96 ms per tick.

In `tests/longrun.test.ts` (20,000 ticks), eden ran at 3.63 ms/tick with the heap going from 34.8 to 28.3 MB, and predators at 3.26 ms/tick with the heap going from 36.8 to 32.4 MB. Both stayed bounded.

The same seed and interventions give an identical full-state hash, and Replay my interventions reproduces the run, also from a log that went through a save file. Saving, loading and continuing gives the identical full hash, event log included, also when the save is taken mid-epidemic (`plague-island`), mid-war (`two-civs`) or mid-replay (`tests/lead-*.test.ts`).

Population dynamics from `npm run balance` (12 in-game days, seed 42), with the population on day 6 and day 12 and the peak:

| Preset | Day 6 | Day 12 | Peak | Notes |
| --- | --- | --- | --- | --- |
| eden | 1000 | 1000 | 1000 (day 6) | limited by the cap by design; births continue at the cap (80 a day on day 12) |
| fittest | 195 | 68 | 280 (day 4) | harsh but viable; speed 0.48 to 0.67, metabolism 0.50 to 0.41, fertility 0.50 to 0.70, longevity 0.50 to 0.66 |
| two-civs | 540 | 519 | 573 (day 10) | the raiders lose: aggression 0.48 to 0.15, altruism 0.51 to 0.75, efficiency 0.59 to 0.76 |
| evolab | 574 | 716 | 778 (day 11) | fertility 0.50 to 0.61, longevity 0.50 to 0.60 |
| collapse | 1217 | 1148 | 1400 (day 7) | scripted drought and blight (day 8) and cold snap (day 10): 413 deaths on day 12, 328 of them by starvation |
| plague-island | 717 | 982 | 1000 (day 10) | the day-3 epidemic was absorbed; second strain on day 10 |
| predators | 689 | 655 | 768 (day 10) | predation and raids from day 5 |

No preset went extinct within 12 days. In 20-day runs measured by the ecology auditor, the seasonal swing was −6% to −28%, down from winter crashes of −82% to −94% before the fixes, and `fittest` survived on seeds 42, 1, 7 and 99.

In the behavior audit (seed 42, 12 days, integrated tree), the number of fights per day was 0 in eden, collapse and plague-island (gentle genomes), about 22 in predators, 104 in fittest, 181 in two-civs and 196 in evolab. There were about 5 to 15 living tribes per 1000 agents, down from about 40 tiny splinters.

After the final code was pushed to `main`, "Deploy to GitHub Pages" run #12 (44440590726) succeeded, with the build and deploy jobs green. The earlier failures came from the `github-pages` environment rejecting deploys from the feature branch. Loading <https://rahv-fb.github.io/AL/> in headless Chromium returned HTTP 200, and the app booted into Garden of Eden and was simulating (tick 120, 224 agents after about 4 s) with no console or page errors.

### 2026-11-19: route planning across fords

Agents plan walking routes (A* over the tile grid with walkable regions, exact line of sight, partial routes through mazes and a per-tick search budget), and hungry agents on spent land migrate to greener land on a committed trek. Four independent adversarial reviews (pathfinding correctness, determinism and save/load, performance, behavior) and one verification round of their fixes were run. Every confirmed finding was fixed and has a regression test in `tests/route-planning.test.ts` or `tests/agent-shape.test.ts`.

All numbers here come from runs on the final tree:

- `npx vitest run --exclude tests/balance.report.test.ts`: 38 files, 389 tests passed. `npx tsc --noEmit` was clean.
- On a synthetic river with a single ford, 12 of 12 starving migrants out of sight of the lush far bank trekked across on each of seeds 3, 11 and 29, and none starved on the way. With routing disabled (pathfinding mocked), 0 of 12 crossed.
- In Plague Island, 50 agents followed planned routes between islands within 3,000 ticks. In Two Civilizations the river blocks most straight crossings, but both banks are one region and camp-to-camp routes plan through the fords.
- These robustness cases pass: thin walls near the goal; diagonal one-tile walls, where the planner, smoothing and stepping agree on the corner rule; a serpentine maze crossed with partial routes; a dead-end cup where the agent gives up instead of freezing, while 20 of 20 bystanders still reach their goals; routes kept through land-to-land repaints; and saves taken mid-route, which continue with an identical full hash.
- In `tests/perf.bench.test.ts`, 1000 agents took a mean of 3.46 ms per tick (p95 5.51), against about 3.9 ms before the feature. `tests/agent-shape.test.ts` enforces one hidden class per agent, for live and loaded agents. In the long runs eden ran 20,000 ticks at 4.02 ms/tick with the heap going from 35.9 to 28.5 MB, and predators ran at 3.59 ms/tick, from 28.3 to 33.3 MB.
- `node scripts/ui-audit.mjs --file dist/index.html` reported 231 passed and 0 failed. With about 1000 agents the app ran at 58 FPS on 1×, and at 38.6 FPS and 178 TPS on Max. `node scripts/browser-smoke.mjs` passed.
- Final populations after 12 days with seed 42: eden 1000, fittest 78, two-civs 519, evolab 770, collapse 1219, plague-island 1000 and predators 689. No preset went extinct, and all were within a few percent of the pre-feature runs.
