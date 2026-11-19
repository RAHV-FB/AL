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

---

## 2026-11-18: requirements and documentation audit

This audit was made by the requirements and docs auditor against baseline `7d0a909`. Four other auditors were editing `src/` in the same working tree at the same time, so measurements on the working tree are marked as such.

The traceability table is in [`docs/REQUIREMENTS.md`](REQUIREMENTS.md): 74 requirements, 69 Done, 5 Partial, 0 Missing.

| # | Check | What was run | Result |
| --- | --- | --- | --- |
| 6 | The release file matches the committed source | Built `git archive HEAD` in a scratch folder with `npx vite build`, then compared it with `cmp` | **Pass.** `release/artificial-life.html` is byte-identical to the fresh build of `7d0a909` (357,853 bytes). It is a manual copy: no npm script produces it. |
| 6/7 | The release file works from `file://` | `node scripts/browser-smoke.mjs --url file:///…/release/artificial-life.html --no-screenshot --wait 3000` | **Pass.** 1624×1696 canvas, 606 distinct colours, luminance sd 53.6, no console errors and no failed requests. **Caveat:** the script's "speed" click landed on the Eden experiment button, because the speed buttons have `role="radio"` and `/fast/` matches the Eden tagline. It also never found the 1× button, so only play/pause and the keys were really exercised. |
| 8 | GitHub Pages deploy is green and the site loads | Read-only GitHub Actions API calls | **Fail.** CI run #6 on `7d0a909` passed. All five Pages runs (#2–#6, the last being 42089509958 on `7d0a909`) passed the `build` job but failed the `deploy` job, which never got a runner and stopped after about 2 seconds. No deployment has ever succeeded. The repository has one branch, `claude/artificial-life-simulator-8iuk86`. The site was not fetched. Fix this in the repository settings: Pages → Source = GitHub Actions, and allow the branch under Environments → `github-pages`. |
| 5 | Balance of `fittest` over 12 days (the speed gene, the crash) | A temporary vitest file, seeds 42 and 7 | See the table below. |
| — | Saving during a replay (gap G1) | A temporary vitest file, on the baseline and again on the working tree | **Defect confirmed.** The replay reproduces the original hash. A save taken at tick 50, during the replay, then loaded and run to tick 300, diverges: its intervention log has 0 entries instead of 1. |
| — | Intervention-log cap (gap G2) | A temporary vitest file, on the baseline and again on the working tree | **Defect confirmed.** A spawn followed by 5,000 Add food stamps leaves only the last 5,000 entries in the log, so the spawn is lost and the replay diverges. |
| — | Requirements and README drift | `npx vitest run tests/spec-requirements.test.ts` | **Pass: 16 of 16** (2026-11-19 00:10 UTC, working tree). It checks the required traits, behaviours, shocks and presets; every tool and intervention is explained, applied and logged through `sim.enqueue`; every parameter has an explained slider that applies live and is clamped; the release file is self-contained; the sources make no network calls; the gene pool shifts under selection; and the README's presets, tools, overlays, toggles, shortcuts, counts, defaults, caps, files, npm scripts and CI claims match the code. |
| 1 | Typecheck | `npx tsc --noEmit` | **Pass, except for other auditors' temporary files.** The full run fails only in `tests/core-tmp-dump.test.ts`, another auditor's temporary file that uses `process`. Excluding `tests/*-tmp-*.test.ts` gives exit code 0. |

**`fittest` at baseline `7d0a909`** (population is the end-of-day count; speed is the mean speed gene):

| Day | Seed 42 population | Seed 42 speed | Seed 7 population | Seed 7 speed |
| --- | --- | --- | --- | --- |
| 0 | 180 | 0.48 | 180 | 0.46 |
| 3 | 300 | 0.55 | 316 | 0.52 |
| 6 | 50 | 0.63 | 150 | 0.62 |
| 9 | 14 | 0.82 | 21 | 0.76 |
| 12 | 6 | 0.88 | 15 | 0.75 |

- **Shape:** the population first grows to about 300. A starvation crash follows on days 4–8, killing up to 110 agents a day, and later deaths are mostly from old age.
- **Tribes:** at baseline, the loners formed up to 15 tribes in seed 42 and 21 in seed 7.
- **Genes:** efficiency did not rise. It moved from 0.49 to 0.33 in seed 42 and stayed at 0.48 in seed 7. This contradicts the preset's in-app "look for" text (`presets.ts:118`).
- **Working tree:** on the working tree at 2026-11-19 00:10 UTC, with other auditors' fixes in progress, the population is 249/250 on day 1, 169/152 on day 6 and 15/15 on day 12 (seeds 42/7). The speed gene rises 0.48 → 0.71 and 0.46 → 0.75, efficiency falls to 0.44, and loners form 2–4 tribes.

README corrections in this audit:
- The offline file is `release/artificial-life.html`; `dist/` is gitignored.
- The online link now states that no deployment has succeeded yet.
- The `Esc` row now matches the UI auditor's change: Esc deselects, stops following and switches back to Inspect.
- Shortcuts and mouse actions that were missing are now listed.
- The CI and Pages triggers are described correctly, and the Pages workflow is noted not to run tests.
- The architecture file list is complete.
- The limitations now cover the replay-log cap, saving mid-replay and the single resource type.

---

## 2026-11-19: independent re-check of the documentation audit

A second verifier re-ran the audit's checks against the working tree: baseline `7d0a909` plus the other auditors' uncommitted changes, which were still landing. Times are UTC.

| # | Check | What was run | Result |
| --- | --- | --- | --- |
| 6 | The release file matches the committed source | Built `git archive HEAD` with `npx vite build` in a scratch folder and compared it with `cmp` | **Pass.** Byte-identical (357,853 bytes). |
| 6/7 | The release file works from `file://` | `node scripts/browser-smoke.mjs --url file:///…/release/artificial-life.html --no-screenshot --wait 3000` | **Pass.** 00:13: 1624×1696 canvas, 603 distinct colours, luminance sd 53.6, no errors. Same caveat as above: the "speed" click hit the Eden experiment button, and no 1× button was found. 00:30, with the UI auditor's updated script: **pass** (596 colours), and it now sets 4× and then 1× through the speed radio group and checks that each took effect. |
| 8 | GitHub Pages deploy | Read-only GitHub Actions API calls | **Fail, with a correction:** there are **six** Pages runs (#1–#6), not five. Run #1 (42085639543 on `cc49c0d`) failed the same way. All six passed `build` and failed `deploy` after about 2 seconds. |
| — | Saving during a replay (G1) | A temporary vitest file, run on the working tree (00:18) and on a copy of the baseline | **Still reproduces.** Working tree: the original and the replay both hash to `5ec394e2…`. Saving the replay at tick 50, loading it and running to tick 300 gives `ed092790…`, with 0 log entries instead of 1. Baseline: `a0e6e6a5…` against `1b8a66fe…`. |
| — | Intervention-log cap (G2) | The same file | **Still reproduces.** With `LIMITS.interventionLog` at 5,000, the spawn is dropped and the replay diverges. The working tree now also sets `interventionLogDropped` to 1 and logs one "The intervention log is full" event (category You). The baseline does neither. |
| — | Save → load → continue | `plague-island`, seeds 1, 2, 3 and 5, saved mid-epidemic (ticks 1,900–2,100); both copies continued to tick 4,200 | The trajectory was identical in 4 of 4 runs (`hash({ events: false })`). The event logs differed in 4 of 4 (1 to 30 messages). For example, "The epidemic has burned out — 34 died (peak 33 infected)" against "17 died (peak 17 infected)", and an alliance announcement was missing. The baseline does the same: "peak 13" against "peak 12" in the determinism-test scenario. The README now says so. |
| — | Load repairs | A damaged save (health set to a string, an unknown tribe id) | The values are repaired, and `deserializeState(text, { warnings })` lists both repairs. `App.loadFile` (`src/ui/app.ts`) calls `deserializeState(text)` with no options and shows only the "Loaded" toast, so the user never sees them. The README and REQUIREMENTS E12 are corrected, and `tests/spec-docs-drift.test.ts` guards the README wording. |
| 5 | `fittest` over 12 days | A temporary vitest file, working tree at 00:21 | Seed 42: 180, peak 256, 127 on day 6, 15 on day 12. The speed gene went 0.48 → 0.82 and efficiency 0.49 → 0.56. Seed 7: 180, peak 232, 117 on day 6, 8 on day 12. Speed went 0.46 → 0.66 and efficiency 0.48 → 0.30. At most 4 and 2 tribes. The same code run on the baseline copy reproduced the baseline table above exactly. |
| — | Requirements and README drift | `npx vitest run tests/spec-requirements.test.ts` | 00:14: **15 of 16.** The core auditor had briefly raised `LIMITS.interventionLog` to 50,000, and the README check caught the stale "5,000". 00:19 and later, with the cap back at 5,000: **16 of 16.** |
| — | Docs drift, save/load and determinism | `npx vitest run tests/spec-requirements.test.ts tests/spec-docs-drift.test.ts` (00:27, again 00:30); `npx vitest run tests/determinism.test.ts tests/persistence.test.ts` (00:28) | **Pass:** 18 of 18, and 39 of 39. |
| 1 | Typecheck | `npx tsc --noEmit` (00:27, again 00:30) | **Pass** (exit code 0). The other auditors' temporary files no longer break it. |

## Final results — after the 2026-11-19 audit (Linux container, Node 22, 4 shared vCPU)

All numbers below are from runs on the final tree. Five parallel audits (core, behaviour, ecology, UI, spec/docs), each followed by an independent adversarial verifier, fixed the defects listed in `docs/REQUIREMENTS.md` (gap list) and added regression tests.

**Automated tests** — `npx vitest run --exclude tests/balance.report.test.ts`: **36 files, 365 tests, all passing** (one test, the REQUIREMENTS summary check, was re-run on its own after a wording fix: 18/18 spec tests pass). `npx tsc --noEmit`: clean.

**Browser** — `npm run build` → single-file `dist/index.html` (≈379 kB), then:

- `node scripts/ui-audit.mjs --file dist/index.html` → **231 passed, 0 failed** (every visible control driven in Chromium with its real effect asserted; layout at 1280×720, 1440×900, 1920×1080; WCAG AA contrast; no console errors).
- `node scripts/browser-smoke.mjs` → passed over `file://` (589 distinct colours, speed set 4× then 1×, no console errors); `docs/screenshot.png` refreshed.
- Rendering at ~1000 agents: 1× → 60 FPS / 30 TPS; Max → 39 FPS / 175–181 TPS (render ≈1.2 ms/frame).

**Simulation performance** (`tests/perf.bench.test.ts`): 1000 agents → mean **3.86 ms/tick** (p50 3.09, p95 8.02) ≈ 259 ticks/s; eden's starting population → 0.96 ms/tick.

**Long run** (`tests/longrun.test.ts`, 20,000 ticks): eden 3.63 ms/tick, heap 34.8 → 28.3 MB; predators 3.26 ms/tick, heap 36.8 → 32.4 MB (bounded).

**Determinism & persistence**: same seed + same interventions ⇒ identical full-state hash; *Replay my interventions* reproduces the run (also from a log that went through a save file); save → load → continue gives the identical full hash including the event log, also mid-epidemic (`plague-island`), mid-war (`two-civs`) and mid-replay (`tests/lead-*.test.ts`).

**Population dynamics** (`npm run balance`, 12 in-game days, seed 42; population on day 6 → day 12, peak):

| preset | day 6 | day 12 | peak | notes |
| --- | --- | --- | --- | --- |
| eden | 1000 | 1000 | 1000 (d6) | cap-limited by design; births continue at the cap (80/day on d12) |
| fittest | 195 | 68 | 280 (d4) | harsh but viable; speed 0.48→0.67, metabolism 0.50→0.41, fertility 0.50→0.70, longevity 0.50→0.66 |
| two-civs | 540 | 519 | 573 (d10) | raiders lose: aggression 0.48→0.15, altruism 0.51→0.75, efficiency 0.59→0.76 |
| evolab | 574 | 716 | 778 (d11) | fertility 0.50→0.61, longevity 0.50→0.60 |
| collapse | 1217 | 1148 | 1400 (d7) | scripted drought/blight (d8) and cold snap (d10): 413 deaths on d12, 328 by starvation |
| plague-island | 717 | 982 | 1000 (d10) | epidemic on d3 absorbed; second strain d10 |
| predators | 689 | 655 | 768 (d10) | predation and raids from day 5 |

No preset goes extinct within 12 days. In 20-day runs, measured by the ecology auditor, the seasonal swing is −6% to −28% instead of the earlier −82% to −94% winter crashes, and `fittest` survives on seeds 42, 1, 7 and 99.

**Emergent conflict** (behaviour audit, seed 42, 12 days, integrated tree): fights/day — eden 0, collapse 0, plague-island 0 (gentle genomes), predators ≈22, fittest ≈104, two-civs ≈181, evolab ≈196; living tribes ≈5–15 per 1000 agents (was ≈40 tiny splinters).

**GitHub Pages** — after pushing the final code to `main`, the "Deploy to GitHub Pages" run #12 (44440590726) **succeeded** (build and deploy jobs green). The earlier failures were the `github-pages` environment rejecting deploys from the feature branch. Loading <https://rahv-fb.github.io/AL/> in headless Chromium returned HTTP 200; the app booted into Garden of Eden and was simulating (tick 120, 224 agents after ~4 s) with no console or page errors.


## Route planning across fords (added 2026-11-19)

Agents now plan walking routes (A* over the tile grid with walkable regions, exact line of sight, partial routes through mazes, a per-tick search budget) and hungry agents on spent land migrate to greener land on a committed trek. Four independent adversarial reviews (pathfinding correctness, determinism & save/load, performance, behaviour) and one verification round of their fixes were run; every confirmed finding was fixed and has a regression test in `tests/route-planning.test.ts` or `tests/agent-shape.test.ts`.

All numbers below are from runs on the final tree:

- **Tests:** `npx vitest run --exclude tests/balance.report.test.ts` → **38 files, 389 tests passed.** `npx tsc --noEmit` clean.
- **Crossing a ford (synthetic river with a single ford):** 12 of 12 starving migrants, out of sight of the lush far bank, trek across on each of seeds 3, 11 and 29, with 0 starving on the way; with routing disabled (pathfinding mocked) 0 of 12 cross.
- **Real presets:** Plague Island — 50 agents followed planned routes between islands within 3,000 ticks; Two Civilizations — the river blocks most straight crossings but both banks are one region and camp-to-camp routes plan through the fords.
- **Robustness:** thin walls near the goal, diagonal one-tile walls (planner, smoothing and stepping agree on the corner rule), a serpentine maze crossed with partial routes, a dead-end cup that gives up instead of freezing (20 of 20 bystanders still reach their goals), routes kept through land→land repaints, saves taken mid-route continue with an identical full hash.
- **Performance:** 1000 agents → mean **3.46 ms/tick** (p95 5.51) in `tests/perf.bench.test.ts`; the pre-feature value was ≈3.9 ms. One hidden class per agent is enforced by `tests/agent-shape.test.ts` (live and loaded agents). Long runs: eden 20,000 ticks at 4.02 ms/tick, heap 35.9 → 28.5 MB; predators 3.59 ms/tick, 28.3 → 33.3 MB.
- **Browser:** `node scripts/ui-audit.mjs --file dist/index.html` → **231 passed, 0 failed**; ~1000 agents: 58 FPS at 1×, 38.6 FPS / 178 TPS at Max. `node scripts/browser-smoke.mjs` passed.
- **Balance (12 days, seed 42, final population):** eden 1000, fittest 78, two-civs 519, evolab 770, collapse 1219, plague-island 1000, predators 689 — no extinctions; within a few percent of the pre-feature runs.
