# Requirements traceability

This audit compares the original product requirements with the code. It was made on 2026-11-18 against commit `7d0a909`.

- **Status:** **Done** (implemented and wired), **Partial** (works, with the limits noted), **Missing**.
- **Locations:** `file:line` refers to the baseline commit. The function or constant is named as well, so you can still find it after lines move.
- **Evidence:** the existing tests and `tests/spec-requirements.test.ts` (requirement and README checks).

Summary: 74 requirements traced. 72 are Done, 2 are Partial and none are Missing. (After the 2026-11-19 audit fixes; both Partial items are the single food resource, by design. The gap list at the end records how each gap was closed.)

## Platform and engineering

| # | Requirement | Status | Where | Notes |
| --- | --- | --- | --- | --- |
| E1 | Offline browser app, no network or telemetry | Done | `release/artificial-life.html`; `src/ui/dom.ts:86` (`store`) | No `fetch`, XHR, WebSocket or beacon calls in `src/`. The release file has one inline script and no external URLs. `localStorage` holds only UI preferences. |
| E2 | TypeScript + Vite + Canvas 2D | Done | `package.json`; `src/render/renderer.ts:91` (`getContext('2d')`) | No runtime dependencies. |
| E3 | Single distributable HTML that works without an HTTP server | Done | `vite.config.ts:6-7` (`base: './'`, `viteSingleFile`) | `release/artificial-life.html` is byte-identical to a fresh build of `7d0a909`. Over `file://` it passes the browser smoke test (2026-11-18, `docs/VERIFICATION.md`). |
| E4 | Simulation separated from rendering and UI | Done | `src/sim/*` (no DOM); `src/ui/app.ts:496` (`enqueue`) | The simulation runs headless in Node. Every UI change to the world goes through `sim.enqueue`. |
| E5 | Deterministic seeded randomness | Done | `src/sim/rng.ts:5` (sfc32); `src/sim/simulation.ts:98-99` | Separate world and simulation RNGs. Tested in `tests/determinism.test.ts` (including a "no `Math.random`" spy). |
| E6 | Smooth with 300–1,000 agents | Done | `src/ui/app.ts:20-25` (speeds, 12 ms step budget); `tests/perf.bench.test.ts` | 4.47 ms per tick at 1,000 agents (`docs/VERIFICATION.md`). A "CPU-limited" badge appears when the speed cannot be met. Rendering time is not benchmarked headlessly. |
| E7 | Save and load via downloadable JSON, with validation | Done | `src/ui/app.ts` (`save`, `loadFile`, drag and drop); `src/sim/persistence.ts` | Untrusted files are size-limited, version-checked and sanitized; repairs are shown in a toast. Saves include pending interventions, an unfinished replay and the epidemic/diplomacy log bookkeeping, so save → load → continue matches the uninterrupted run exactly (`tests/lead-*.test.ts`). |
| E8 | Tests for invariants | Done | `tests/invariants.test.ts`; `scripts/qa-helpers.ts:74` (`checkInvariants`) | Every preset runs 3,000 ticks, plus an intervention barrage. |
| E9 | Determinism check with identical seeds and interventions | Done | `tests/determinism.test.ts` | Checkpoint hashes, intervention-log replay and save, load and continue. |
| E10 | Long-run memory and stability | Done | `tests/longrun.test.ts`; `src/sim/constants.ts:21` (`LIMITS`) | 20,000 ticks on two presets. Arrays stay within their caps and the heap stays bounded. |
| E11 | No invalid numbers, negative resources or broken references | Done | `scripts/qa-helpers.ts:74`; NaN guards in `lifecycle.ts:175-178` and `ecology.ts` | Checked every 25 ticks in the invariant tests. |
| E12 | Validated imports | Done | `src/sim/persistence.ts:391` (`deserializeState`), `:1098` (`sanitizeState`) | Fatal problems give a readable error. Recoverable damage is repaired and listed through `options.warnings`, but `App.loadFile` (`src/ui/app.ts`) does not pass that option, so the user is not told what was repaired. |
| E13 | Profiling | Done | `tests/perf.bench.test.ts`; `src/ui/app.ts:1017-1031` (TPS/FPS); `src/render/renderer.ts` (`RenderStats`) | |
| E14 | Every UI control works | Done | `scripts/ui-audit.mjs`, `scripts/browser-smoke.mjs` | The Playwright audit drives every visible control of the built single-file app and asserts a real effect on the simulation, renderer or DOM: 231 checks, 231 passed on 2026-11-19 (tools, global events, experiments incl. restart/replay hashes, parameters, overlays, save/load incl. invalid files, inspector, event log, shortcuts, layout at 1280/1440/1920, WCAG AA contrast, FPS). |
| E15 | README with controls, rules, architecture and limitations | Done | `README.md` | Checked by `tests/spec-requirements.test.ts`. |

## Agents

| # | Requirement | Status | Where | Notes |
| --- | --- | --- | --- | --- |
| A1 | Unique identity and visible appearance | Done | `simulation.ts:271` (`newAgentId`); `names.ts:16`; `render/agents.ts:5` | Id and generated name. The body color comes from the hue gene, with a tribe-colored ring. Body size and heading are drawn. |
| A2 | Age, health, energy, hunger, reproductive status | Done | `types.ts` (`Agent`); `genetics.ts` (`isFertile`, `canMate`); `ui/inspector.ts` (Condition section) | The inspector shows health, hunger, energy, carried food, infection/immunity and reproductive status (juvenile, cooldown, past breeding age, which fertility condition is unmet, or a grazed-down home range). |
| A3 | Inheritable speed, perception, metabolism, aggression, sociability, resource efficiency | Done | `types.ts` (`GENES`); `genetics.ts:87` (`expressTraits`) | 12 genes in total, including size, altruism, fertility, longevity, immunity and hue. |
| A4 | Decisions from needs, nearby resources, threats and memory | Done | `brain.ts:574` (`think`); `:230,280,336` (food and danger memory) | Utility AI over 14 actions. Utilities and a readable "thought" are stored for the inspector. |
| A5 | Life cycle: birth, growth, reproduction, aging, death | Done | `genetics.ts:309` (`reproduce`); `lifecycle.ts:129,140,168` | Juveniles grow from 50% size. Senescence starts at 80% of longevity. Six death causes. |
| A6 | Relationships | Done | `social.ts:326` (`adjustRelationship`), `:794` (`maintainRelationships`), `:811` (`bond`) | Up to 12 per agent, with affinity −1..1 and kin flags. |
| A7 | Behaviours: explore, gather, rest, flee, compete, help, reproduce | Done | `brain.ts:1225-1255` (`act`), `:1275-1563` (`act*`) | Gathering includes carrying food to the camp stockpile. |

## Environment

| # | Requirement | Status | Where | Notes |
| --- | --- | --- | --- | --- |
| V1 | Terrain types | Done | `constants.ts:4` (`TERRAIN_INFO`); `world.ts:353` (`generateWorld`) | 8 types: deep water, shallows, sand, grass, forest, desert, mountain, wall. |
| V2 | Renewable food and resource deposits | Partial | `ecology.ts:225` (`updateResources`), `:331` (`consumeFood`) | Plant food regrows on every tile, and tribe stockpiles store it. **Gap G6:** food is the only resource; there are no non-food deposits. |
| V3 | Regions with different availability | Done | `world.ts:5-12` (moisture, desert, forest, fertility); `TERRAIN_INFO.maxFood/regen` | Optional river or mountain divides. |
| V4 | Carrying capacity | Done | `ecology.ts:225` (logistic regrowth); `simulation.ts:285` (`canSpawn`, cap) | Carrying capacity emerges from regrowth, plus a hard cap. `ecology.ts:479` (`estimateCarryingCapacity`) exists but is not shown in the UI (G7). |
| V5 | Day/night | Done | `ecology.ts:139`; `brain.ts:605` (vision shrinks at night), `:1534` (sleep); `renderer.ts:318` | |
| V6 | Seasons | Done | `ecology.ts:25-27,148-159`; `lifecycle.ts:205` (cold cost); `render/terrainLayer.ts` (season palettes) | |
| V7 | Shocks: drought, resource collapse, disease | Done | `disasters.ts:25` (6 kinds), `:398`, `:475`, `:594` (random); `disease.ts:231` | Blight is the resource collapse. **Gap G3:** at baseline, a regional cold snap lowered the temperature of the whole world. Mostly fixed in the working tree during this audit. |
| V8 | Consistent regeneration and consumption | Done | `ecology.ts:225,331`; `tests/ecology.test.ts` ("conserves food") | Food never goes negative and stays within 1.5× capacity. |

## Evolution

| # | Requirement | Status | Where | Notes |
| --- | --- | --- | --- | --- |
| G-1 | Inheritance with mutation | Done | `genetics.ts:154` (crossover with linkage), `:173` (Gaussian mutation) | Mutation rate and size can be tuned at runtime. |
| G-2 | Traits affect behaviour and survival | Done | `genetics.ts:130` (`basalBurn`: every gene has a cost); `brain.ts` utilities; `lifecycle.ts:168` | |
| G-3 | Observable change in trait distributions under pressure | Done | `stats.ts` (gene means, std-dev and histogram per sample); `ui/analytics.ts:246` (mean ± std, heatmap, histogram) | At baseline, the speed gene mean in `fittest` rose over 12 days: 0.48 → 0.88 (seed 42) and 0.46 → 0.75 (seed 7). `tests/spec-requirements.test.ts` requires a shift of at least 0.08, involving descendants, within 6 days. |
| G-4 | Emergent, not scripted | Done | genes are written only by `randomGenes` (founders) and `mutate` | Selection works through starvation, combat, disease and mate choice. |

## Social behaviour

| # | Requirement | Status | Where | Notes |
| --- | --- | --- | --- | --- |
| S1 | Cooperation and sharing | Done | `social.ts:594` (`shareFood`), `:638/651` (stockpile); `brain.ts:892` | |
| S2 | Competition over scarce resources | Done | `brain.ts:866-881` (hunting is favored when plants are scarce); `social.ts:450` (`steal`), `:515` (`attack`) | |
| S3 | Conflict and avoidance | Done | `brain.ts:839` (flee), `:280,336` (danger memory); `social.ts:349` (grudges), `:394` (war and peace) | |
| S4 | Group and tribe formation | Done | `social.ts:884` (`considerJoinOrFound`), `:1139` (fission), `:1068` (extinction) | |
| S5 | Social preferences shaped by traits | Done | `social.ts:884` (sociability); `brain.ts` (altruism → share, aggression → attack) | |
| S6 | Group survival | Done | `social.ts:573` (group defence); `lifecycle.ts:209-216` (camp shelter); stockpile withdrawals | |
| S7 | Emergent specialization | Done | `social.ts:825` (`assignRole`: learned skill relative to the population, plus gene bias) | Roles: forager, warrior, caretaker, explorer. |
| S8 | Basic resource exchange, where feasible | Partial | `social.ts:594` (gifts), `:638/651` (shared stockpile) | Gifts raise affinity and tribe relations. **Gap G6:** there is no barter, because only one resource exists. |

## Sandbox (each control traced to its handler)

| # | Requirement | Status | Where | Notes |
| --- | --- | --- | --- | --- |
| X1 | Pause, resume, accelerate, slow | Done | `app.ts:561` (`togglePause`), `:583` (`setSpeed`), `:20` (¼× to 64× and Max) | Space, `.`, `<` and `>`. Top-bar buttons. |
| X2 | Zoom and pan | Done | `app.ts:849` (wheel), `:973` (WASD and arrows), `:774-807` (drag), `:959` (`0` fits the world) | Minimap click or drag. |
| X3 | Inspect agents | Done | `app.ts:506` (`clickAt`, inspect); `ui/inspector.ts:301-363` | |
| X4 | Add and remove agents | Done | `tools.ts:30-31` → `interventions.ts:174` (`spawn`), `:261` (`remove`) | Inspector kill, plus Bless and Smite (`killAgent` and `boostAgent`). |
| X5 | Create populations with different genetics | Done | `ui/designer.ts:46-170` (gene sliders, spread, archetypes, tribe choice) | |
| X6 | Add and remove food | Done | `tools.ts:32-33` → `interventions.ts:270,285` | |
| X7 | Modify terrain and build obstacles | Done | `tools.ts:35` → `interventions.ts:316` (`paintTerrain`, walls) | Agents trapped by new terrain are moved to open ground. |
| X8 | Change mutation, reproduction and difficulty | Done | `controls.ts:240-311` (12 sliders and 4 toggles) → `setConfig` (`interventions.ts:404`) | Changes are clamped to `PARAM_SPECS` ranges and recorded. |
| X9 | Trigger disasters, epidemics, droughts, abundance | Done | `tools.ts:36` (local); `controls.ts:40` (global events) → `interventions.ts:371` | |
| X10 | Competing tribes in different map regions | Done | Designer tribe choice → `interventions.ts:219-244`; `two-civs` preset | |
| X11 | Observe long-term consequences | Done | speeds up to 64× and Max; `ui/analytics.ts:74` (All / 20 d / 5 d / 1 d ranges); stats downsampling | |
| X12 | Restart with the same seed | Done | `controls.ts:210` → `app.ts:396` (`restart`); `app.ts:400` (`replay`) | **Gap G2:** replay is incomplete once the intervention log passes 5,000 entries. |
| X13 | Clear explanation of every intervention | Done | `interventions.ts:29` (`INTERVENTION_HELP`); `tools.ts:107` (`toolHelp`); tooltips on every control; the "You" category in the event log | |

## Presets

| # | Requirement | Status | Where | Notes |
| --- | --- | --- | --- | --- |
| P1 | Garden of Eden | Done | `presets.ts:69` (`eden`) | |
| P2 | Survival of the Fittest | Done | `presets.ts:109` (`fittest`) | **Gap G5:** its in-app "look for" text predicts the wrong trait shift. At baseline the population falls to 6–15 by day 12. |
| P3 | Two Civilizations | Done | `presets.ts:163` (`two-civs`) | |
| P4 | Evolution Laboratory | Done | `presets.ts:206` (`evolab`) | |
| P5 | Civilization Collapse | Done | `presets.ts:268` (`collapse`) | |
| P6 | Presets meaningfully different | Done | `tests/presets.test.ts` (distinct configs and defining traits) | Two bonus presets: `plague-island` and `predators`. |

## Visualization and analytics

| # | Requirement | Status | Where | Notes |
| --- | --- | --- | --- | --- |
| U1 | Large animated canvas, dark scientific look | Done | `render/renderer.ts:3` (frame order); `ui/styles.css` | |
| U2 | Agents, resources and terrain easy to tell apart | Done | `render/terrainLayer.ts` (vegetation follows food); `render/agents.ts` | |
| U3 | Overlays: food, density, territory, environment | Done | `controls.ts:13` (`OVERLAYS`); `render/overlays.ts` | Also fertility, disease and climate. |
| U4 | Real-time population stats | Done | `app.ts:1196` (top bar); `ui/analytics.ts:175-182` (KPI tiles) | |
| U5 | Birth and death rates | Done | `ui/analytics.ts:205` | Plus deaths by cause (`:240`). |
| U6 | Average health and energy | Done | `ui/analytics.ts:216` | |
| U7 | Resource availability | Done | `ui/analytics.ts:227` (total food, average fertility) | |
| U8 | Trait distributions over time | Done | `ui/analytics.ts:246` | |
| U9 | Population growth chart | Done | `ui/analytics.ts:205` | |
| U10 | Tribe populations | Done | `ui/analytics.ts:234` | |
| U11 | Event log | Done | `ui/eventlog.ts:37` | Category filters. Click an event to jump there. |
| U12 | Agent inspector: characteristics, behaviour, relationships, lineage | Done | `ui/inspector.ts:301-363` | Covers condition, genes, last decision, skills, relationships, family (grandparents, children, descendants), life story and lifetime stats. |
| U13 | Follow agents | Done | `app.ts:626` (`follow`), `:747` (double-click), `F` key, inspector button | |

## Prioritized gaps

Every gap below lies outside the documentation files: in source, `package.json`, the workflows or the repository settings. Each was reported in the audit's cross-area list. The README lists the user-visible ones under Limitations.

1. **G1 — Saving during a replay loses interventions (P1).** The replay queue (`Simulation.replayQueue`) and the queue of interventions not yet applied (`Simulation.queue`) are private fields. They are not part of `SimState` (`simulation.ts:73-74`; noted in `persistence.ts:24-26`). A save taken mid-replay therefore loads without the remaining replayed interventions, and the loaded run diverges from the original.
   - Repro: Eden, seed 1. Spawn at tick 100 and run to tick 300. A replay of that log matches the original hash. Save the replay at tick 50, load it and run to tick 300: the hash differs and the log has 0 entries instead of 1. This was re-checked on the working tree with this session's other fixes.
   - Fix: keep pending replay records in `SimState` (for example an optional `pendingReplay`) and validate them in `sanitizeState`.
   - **Status (2026-11-19): fixed.** The queues now live in `SimState` (`pendingReplay`, `pendingQueue`), are validated on load and restored; `tests/lead-replay-save.test.ts` checks a mid-replay save continues to the original hash.
2. **G2 — Long sessions cannot be replayed exactly (P1).** `interventionLog` keeps only the latest `LIMITS.interventionLog` (5,000) records (`simulation.ts:242`). A drag-painting tool records a stamp about every 40 ms (`tools.ts:178-200`), so a few minutes of painting fills the log. *Replay my interventions* then silently skips the earliest ones.
   - Repro: enqueue a spawn, then 5,000 small Add food stamps. The log keeps only the last 5,000 entries, so the spawn is lost and the replay hash differs from the original. This was re-checked on the working tree with this session's other fixes.
   - Status: during this audit the core auditor added, in the working tree (not yet committed), a counter `state.interventionLogDropped` that is saved with the file, and a one-time "The intervention log is full" entry in the event log (category You, no toast). *Replay my interventions* still re-applies the truncated log without a warning. The repro still loses the spawn and diverges (re-checked 2026-11-19 00:19 UTC).
   - Fix: warn in `App.replay()` once the cap has been reached, and/or coalesce paint stamps or raise the cap.
   - **Status (2026-11-19): mitigated.** Recorded entries are canonical (no-op interventions are not logged), dropped entries are counted (`interventionLogDropped`, with an event-log warning) and *Replay my interventions* warns that the replay is incomplete. The 5,000-entry cap remains (README Limitations).
3. **G10 — The online build has never deployed (P2, repository settings).** All six "Deploy to GitHub Pages" runs (#1–#6), up to commit `7d0a909` (run 42089509958), built successfully but failed in the `deploy` job. That job never got a runner and failed after about 2 seconds. CI passed on the same commit.
   - Effect: <https://rahv-fb.github.io/AL/> is most likely not live. The repository has a single branch, `claude/artificial-life-simulator-8iuk86`.
   - Fix: in the repository settings, set Pages → Source to **GitHub Actions** and allow that branch under Environments → `github-pages`, or deploy from a `main` branch.
   - **Status (2026-11-19):** the `github-pages` environment only deploys from the default branch, so the finished code is pushed to `main`, which `pages.yml` deploys.
4. **G3 — A regional cold snap chills the whole world (P2).** At baseline, `coldOffset` (`disasters.ts:233-239`) added every active cold snap, whatever its radius, to the global `env.tempOffset`. Cold cost (`lifecycle.ts:205`) read that global temperature, so the "north-east cold snap" in `evolab` raised upkeep everywhere.
   - Status: the ecology auditor fixed this in the working tree (not yet committed). Local cold snaps now chill only their area, through `temperatureAt` and `localColdOffsetAt` in `disasters.ts`, and `lifecycle.ts` uses `temperatureAt` for the cold cost.
   - Remaining: the brain's cold perception (`brain.ts`, `const cold = …env.temperature`) still reads the global value, so agents inside a local cold snap pay the cost but do not react to it.
   - **Status (2026-11-19): fixed.** `temperatureAt(sim, x, y)` adds local cold snaps with edge falloff; lifecycle cold stress and the brain's perception both use it (`tests/eco-temperature.test.ts`).
5. **G4 — Reproductive status is not shown (P3).** The inspector should display "Fertile / cooldown N d / past breeding age". The data is in `isFertile` (`genetics.ts:256`) and `reproCooldown`.
   - **Status (2026-11-19): fixed** (see A2).
6. **G5 — Survival of the Fittest text and balance (P3).** Its "look for" text (`presets.ts:118`) says efficiency rises while speed and longevity get trimmed. At baseline, in seeds 42 and 7, the speed gene rose sharply (+0.28 to +0.40) and efficiency did not rise. The population fell from 180 to 6–15 by day 12, which puts VERIFICATION check 5 ("no unintended extinction within 12 days") at risk. The working tree kept changing while the other auditors tuned the balance. At 00:10 UTC both seeds ended day 12 with 15 agents; at 00:21 UTC they ended with 15 and 8, after peaks of 256 and 232. In both measurements the speed gene still rose (to 0.66–0.82), efficiency did not rise consistently (0.30–0.56 on day 12), and the loners formed 2–4 tribes.
   - **Status (2026-11-19): fixed.** The preset text now describes the measured selection (faster, leaner, more fertile survivors), and the rebalanced ecology keeps the preset viable: 12-day report seed 42 280 → 68, 20-day runs survive on seeds 42/1/7/99.
7. **G6 — Single resource type (P3, by design).** Food is the only resource. "Exchange" is limited to gifts and the shared tribe stockpile, with no barter between different goods.
8. **G7 — Carrying capacity is not displayed (P4).** `estimateCarryingCapacity` (`ecology.ts:479`) could be shown as a reference line in the population chart.
   - **Status (2026-11-19): done.** The Food tile in the Stats panel shows "supports ≤ N" (an upper bound from `estimateCarryingCapacity`).
9. **G8 — Release copy is manual (P4).** `release/artificial-life.html` is a hand copy of `dist/index.html`, and no npm script produces it. Add one, for example `"release": "npm run build && cp dist/index.html release/artificial-life.html"`, and rebuild after source fixes.
   - **Status (2026-11-19): done.** `npm run release` rebuilds `release/artificial-life.html`.
10. **G9 — GitHub Pages deploy skips tests (P4).** The Pages workflow builds (typecheck and build) without running the tests. Only `ci.yml` runs them.
