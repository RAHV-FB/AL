#!/usr/bin/env node
/**
 * UI audit (OWNER: UI). Exercises every visible control of the built app in headless
 * Chromium and asserts a real effect through `window.app` (the App instance: sim,
 * renderer, view, settings, designer, ...).
 *
 *   npm run build && node scripts/ui-audit.mjs
 *   node scripts/ui-audit.mjs --url http://localhost:5196/     # e.g. against `npx vite --port 5196`
 *   node scripts/ui-audit.mjs --file path/to/index.html        # another single-file build
 *   node scripts/ui-audit.mjs --only "tool|layout"             # subset (regex on check names)
 *   node scripts/ui-audit.mjs --groups "layout|performance"    # run only these groups (regex on group names)
 *   node scripts/ui-audit.mjs --shots out/dir                  # save layout screenshots
 *   node scripts/ui-audit.mjs --no-perf                        # skip the ~1000-agent FPS run
 *
 * Prints one PASS/FAIL line per control (plus INFO lines with measurements) and exits
 * 1 when any check fails, 2 on setup problems. Needs Playwright with Chromium (a global
 * install reachable through NODE_PATH works).
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const file = resolve(opt('file', join(root, 'dist/index.html')));
const url = opt('url', pathToFileURL(file).href);
const only = opt('only', '') ? new RegExp(opt('only', ''), 'i') : null;
const groupsRe = opt('groups', '') ? new RegExp(opt('groups', ''), 'i') : null;
const shotsDir = opt('shots', '') ? resolve(opt('shots', '')) : '';
const runPerf = !flag('no-perf');

async function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright'); // honours NODE_PATH (global installs)
  } catch {
    try {
      return await import('playwright');
    } catch {
      console.error('✗ Playwright not found. Install it: npm i -D playwright && npx playwright install chromium');
      process.exit(2);
    }
  }
}

if (url.startsWith('file:') && !existsSync(fileURLToPath(url))) {
  console.error(`✗ ${fileURLToPath(url)} not found — run "npm run build" first (or pass --url / --file).`);
  process.exit(2);
}

// ------------------------------------------------------------------ check framework
const results = [];
const infos = [];
const pageErrors = [];
let group = '';
const t0 = Date.now();

class Skip extends Error {}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function approx(a, b, tol, what) {
  assert(Number.isFinite(a) && Math.abs(a - b) <= tol, `${what}: expected ≈${b} (±${tol}), got ${a}`);
}
function info(msg) {
  infos.push(msg);
  console.log(`  INFO  ${msg}`);
}
async function check(name, fn) {
  const full = group ? `${group} › ${name}` : name;
  if (only && !only.test(full)) return;
  const errBefore = pageErrors.length;
  const ts = Date.now();
  try {
    const detail = await fn();
    const newErrs = pageErrors.slice(errBefore);
    if (newErrs.length) throw new Error(`console/page error during check: ${newErrs.join(' | ')}`);
    results.push({ name: full, ok: true });
    console.log(`  PASS  ${full}${detail ? ` — ${detail}` : ''}  (${Date.now() - ts} ms)`);
  } catch (err) {
    if (err instanceof Skip) {
      results.push({ name: full, ok: true, skipped: true });
      console.log(`  SKIP  ${full} — ${err.message}`);
      return;
    }
    results.push({ name: full, ok: false, error: err.message });
    console.log(`  FAIL  ${full} — ${String(err.message).split('\n')[0]}`);
  }
}

/** Run one group of checks; a failure in its setup code is reported and the next group still runs. */
async function section(name, fn) {
  if (groupsRe && !groupsRe.test(name)) return;
  group = name;
  try {
    await fn();
  } catch (err) {
    const msg = String(err && err.message ? err.message : err).split('\n')[0];
    results.push({ name: `${name} › (setup aborted)`, ok: false, error: msg });
    console.log(`  FAIL  ${name} › (setup aborted) — ${msg}`);
  }
}

// ------------------------------------------------------------------ page helpers (installed into window.__ui)
function installPageHelpers() {
  const app = window.app;
  const TERRAIN = { DeepWater: 0, Water: 1, Sand: 2, Grass: 3, Forest: 4, Desert: 5, Rock: 6, Wall: 7 };
  const ui = {
    TERRAIN,
    frames(n = 1) {
      return new Promise((r) => {
        let k = 0;
        const f = () => (++k >= n ? r() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      });
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    tileIndex: (x, y) => app.sim.tileIndex(x, y),
    terrainAt: (x, y) => app.sim.terrainAt(x, y),
    /** Centre of a tile index. */
    tileCentre(i) {
      const w = app.sim.state.world;
      return { x: ((i % w.width) + 0.5) * w.tileSize, y: (Math.floor(i / w.width) + 0.5) * w.tileSize };
    },
    /** A tile of terrain `t` whose whole (2r+1)² neighbourhood is that terrain, nearest to (cx,cy). */
    findTerrain(t, r = 3, cx, cy, avoidAgents = 0) {
      const w = app.sim.state.world;
      const W = w.width;
      const H = w.height;
      cx ??= app.sim.worldW / 2;
      cy ??= app.sim.worldH / 2;
      let best = null;
      let bestD = Infinity;
      for (let ty = r; ty < H - r; ty++) {
        for (let tx = r; tx < W - r; tx++) {
          if (w.terrain[ty * W + tx] !== t) continue;
          let ok = true;
          for (let dy = -r; dy <= r && ok; dy++) for (let dx = -r; dx <= r && ok; dx++) if (w.terrain[(ty + dy) * W + tx + dx] !== t) ok = false;
          if (!ok) continue;
          const x = (tx + 0.5) * w.tileSize;
          const y = (ty + 0.5) * w.tileSize;
          if (avoidAgents > 0 && app.sim.state.agents.some((a) => Math.hypot(a.x - x, a.y - y) < avoidAgents)) continue;
          const d = Math.hypot(x - cx, y - cy);
          if (d < bestD) {
            bestD = d;
            best = { x, y, i: ty * W + tx };
          }
        }
      }
      return best;
    },
    /** Tiles whose centre lies within r of (x,y) (same rule as interventions.forTilesInRadius). */
    tilesIn(x, y, r) {
      const w = app.sim.state.world;
      const ts = w.tileSize;
      const out = [];
      for (let ty = Math.max(0, Math.floor((y - r) / ts)); ty <= Math.min(w.height - 1, Math.floor((y + r) / ts)); ty++)
        for (let tx = Math.max(0, Math.floor((x - r) / ts)); tx <= Math.min(w.width - 1, Math.floor((x + r) / ts)); tx++) {
          const dx = (tx + 0.5) * ts - x;
          const dy = (ty + 0.5) * ts - y;
          if (dx * dx + dy * dy <= r * r) out.push(ty * w.width + tx);
        }
      return out;
    },
    sumIn(field, x, y, r) {
      const arr = app.sim.state.world[field];
      let s = 0;
      for (const i of ui.tilesIn(x, y, r)) s += arr[i];
      return s;
    },
    agentsIn(x, y, r) {
      return app.sim.state.agents.filter((a) => a.alive && Math.hypot(a.x - x, a.y - y) <= r);
    },
    /** Living agent with no other agent within `gap` world units, nearest to (cx,cy). */
    isolatedAgent(gap = 7, cx, cy, filter) {
      const ag = app.sim.state.agents;
      cx ??= app.camera.x;
      cy ??= app.camera.y;
      let best = null;
      let bestD = Infinity;
      for (const a of ag) {
        if (!a.alive || (filter && !filter(a))) continue;
        let alone = true;
        for (const b of ag)
          if (b !== a && b.alive && Math.abs(b.x - a.x) < gap && Math.abs(b.y - a.y) < gap && Math.hypot(b.x - a.x, b.y - a.y) < gap) {
            alone = false;
            break;
          }
        if (!alone || !app.sim.passableAt(a.x, a.y)) continue;
        const d = Math.hypot(a.x - cx, a.y - cy);
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
      return best;
    },
    /** Put world point (x,y) at the canvas centre with the given zoom; cancels flights & follow. */
    centre(x, y, zoom) {
      app.flight = null;
      app.stopFollow();
      if (zoom) {
        app.camera.zoom = zoom; // external write: the camera adopts it and cancels any zoom animation
        app.camera.targetZoom = zoom;
      }
      app.camera.x = x;
      app.camera.y = y;
    },
    /** Page (client) coordinates of a world point. */
    screenOf(x, y) {
      const r = app.renderer.canvas.getBoundingClientRect();
      const p = app.camera.worldToScreen(x, y);
      return { x: r.left + p.x, y: r.top + p.y };
    },
    canvasRect() {
      const r = app.renderer.canvas.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
    /** Pixel statistics of a canvas region (CSS px, relative to the canvas). */
    canvasStats(canvas, x = 0, y = 0, w, h) {
      const c = canvas || app.renderer.canvas;
      const k = c.width / Math.max(1, c.getBoundingClientRect().width);
      w ??= c.width / k;
      h ??= c.height / k;
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(Math.round(x * k), Math.round(y * k), Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))).data;
      const colors = new Set();
      let n = 0;
      let opaque = 0;
      let sum = 0;
      let hash = 0;
      for (let i = 0; i < d.length; i += 4 * 3) {
        colors.add(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3));
        if (d[i + 3] > 8) opaque++;
        sum += d[i] + d[i + 1] + d[i + 2];
        hash = (Math.imul(hash, 31) + d[i] * 7 + d[i + 1] * 13 + d[i + 2] * 17) | 0;
        n++;
      }
      return { colors: colors.size, opaque: opaque / Math.max(1, n), mean: sum / Math.max(1, n * 3), hash };
    },
    /** Mean |Δ| per channel between two equally sized regions captured as arrays. */
    grab(x, y, w, h) {
      const c = app.renderer.canvas;
      const k = c.width / Math.max(1, c.getBoundingClientRect().width);
      return Array.from(c.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), Math.round(w * k), Math.round(h * k)).data);
    },
    diff(a, b) {
      let s = 0;
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) if ((i & 3) !== 3) s += Math.abs(a[i] - b[i]);
      return s / Math.max(1, (n / 4) * 3);
    },
    visible(el) {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      }
      return true;
    },
    text: (sel) => document.querySelector(sel)?.textContent ?? '',
  };
  window.__ui = ui;
  return true;
}

// ------------------------------------------------------------------ run
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const tmp = mkdtempSync(join(tmpdir(), 'al-ui-audit-'));
let page;
let context;

const ev = (fn, arg) => page.evaluate(fn, arg);
const frames = (n = 2) => ev((n) => window.__ui.frames(n), n);
const sleep = (ms) => page.waitForTimeout(ms);
const waitFor = (fn, arg, timeout = 5000) => page.waitForFunction(fn, arg, { timeout, polling: 'raf' });

function watch(p, label) {
  p.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`[${label}] console.error: ${msg.text()}`);
  });
  p.on('pageerror', (err) => pageErrors.push(`[${label}] pageerror: ${err.message}`));
  p.on('requestfailed', (req) => pageErrors.push(`[${label}] request failed: ${req.url()} (${req.failure()?.errorText ?? '?'})`));
}

async function openPage(width, height, label) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, acceptDownloads: true });
  const p = await ctx.newPage();
  watch(p, label);
  // keep file-chooser interception on for the whole session: enabling it lazily per waitForEvent
  // races with the keypress / click that opens the chooser
  p.on('filechooser', () => {});
  await p.goto(url, { waitUntil: 'load', timeout: 30_000 });
  await p.waitForFunction(() => window.app && window.app.sim && window.app.sim.tick > 3, null, { timeout: 15_000 });
  await p.evaluate(installPageHelpers);
  return { ctx, p };
}

/** Pause and (re)start a scenario with a seed, run `ticks` headless ticks, select Inspect. */
async function fresh(id = 'eden', seed = 12345, ticks = 0) {
  await ev(
    ({ id, seed, ticks }) => {
      const app = window.app;
      app.setPaused(true);
      app.showHelp(false);
      const sc = window.__scenarioDefs?.[id];
      if (!sc) throw new Error(`scenario ${id} not captured`);
      app.startScenario(sc, { seed, quiet: true });
      app.setTool('inspect', false);
      for (let i = 0; i < ticks; i++) app.sim.step();
      return app.sim.tick;
    },
    { id, seed, ticks },
  );
  await frames(2);
}

/**
 * Collect every ScenarioDef through the experiment list: each card's primary button calls
 * app.startScenario(sc); a temporary wrapper records the definitions instead of starting them.
 */
async function captureScenarios() {
  const ids = await ev(async () => {
    const app = window.app;
    const defs = {};
    const names = {};
    const orig = app.startScenario.bind(app);
    // Read each card: clicking an experiment button shows its detail; its primary button calls app.startScenario(sc).
    app.startScenario = (sc) => {
      defs[sc.id] = sc;
      names[sc.id] = sc.name;
      return true;
    };
    try {
      for (const b of document.querySelectorAll('.exp-btn')) {
        b.click();
        document.querySelector('.exp-detail .btn.primary').click();
      }
    } finally {
      app.startScenario = orig;
    }
    window.__scenarioDefs = defs;
    window.__names = names;
    // restore the detail card to the running experiment
    [...document.querySelectorAll('.exp-btn')].find((b) => b.classList.contains('running'))?.click();
    return Object.keys(defs);
  });
  return ids;
}

/** Click a world point: centres the camera there (zoom z), then clicks the canvas centre. */
async function clickWorld(x, y, { zoom = 2, shift = false, settle = 2 } = {}) {
  await ev(({ x, y, zoom }) => window.__ui.centre(x, y, zoom), { x, y, zoom });
  await frames(settle);
  const p = await ev(({ x, y }) => window.__ui.screenOf(x, y), { x, y });
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  if (shift) await page.keyboard.up('Shift');
  return p;
}

/** Wait until the paused app applied queued interventions (one tick after the click). */
async function waitTick(t, timeout = 5000) {
  await waitFor((t) => window.app.sim.tick >= t, t, timeout);
}

/** Step n ticks through the app (the Step button path) and return the hash. */
const stepN = (n) =>
  ev((n) => {
    for (let i = 0; i < n; i++) window.app.stepOnce();
    return window.app.sim.hash();
  }, n);
const tick = () => ev(() => window.app.sim.tick);
const pop = () => ev(() => window.app.sim.state.agents.length);

async function setRange(locator, value) {
  if (await locator.isVisible()) await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
const slider = (scope, label) =>
  page
    .locator(`${scope} .ctl-slider`)
    .filter({ has: page.locator('.ctl-label', { hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }) })
    .locator('input[type=range]');
const toggleCtl = (scope, label) => page.locator(`${scope} label.ctl-toggle`).filter({ has: page.locator('.ctl-label', { hasText: new RegExp(`^${label}$`) }) });

try {
  ({ ctx: context, p: page } = await openPage(1440, 900, 'main'));
  const scenarioIds = await captureScenarios();

  // =================================================================== boot
  await section('boot', async () => {
    await check('app boots without errors, canvas is drawn', async () => {
      const s = await ev(() => ({ ...window.__ui.canvasStats(), tick: window.app.sim.tick, agents: window.app.sim.state.agents.length }));
      assert(s.colors > 40, `canvas looks blank (${s.colors} colours)`);
      assert(s.agents > 0, 'no agents');
      return `${s.colors} colours, ${s.agents} agents, tick ${s.tick}`;
    });
    await check('experiment list exposes all presets', async () => {
      assert(scenarioIds.length >= 7, `only ${scenarioIds.length} experiments: ${scenarioIds.join(',')}`);
      return scenarioIds.join(', ');
    });
  });

  // =================================================================== top bar
  await section('topbar', async () => {
    await fresh('eden', 12345, 0);
    await ev(() => window.app.setPaused(false));
    await check('play/pause button', async () => {
      const btn = page.locator('.play-btn');
      await btn.click();
      assert((await ev(() => window.app.running)) === false, 'click did not pause');
      assert(await page.locator('.paused-pill').isVisible(), 'paused pill not shown');
      const t1 = await tick();
      await sleep(250);
      assert((await tick()) === t1, 'ticks advance while paused');
      await btn.click();
      assert((await ev(() => window.app.running)) === true, 'click did not resume');
      await sleep(300);
      assert((await tick()) > t1, 'ticks do not advance after resume');
      assert(!(await page.locator('.paused-pill').isVisible()), 'paused pill still shown');
    });
    await check('paused pill resumes', async () => {
      await page.locator('.play-btn').click();
      await page.locator('.paused-pill').click();
      assert(await ev(() => window.app.running), 'pill click did not resume');
    });
    await check('step button advances exactly one tick', async () => {
      await page.locator('.play-btn').click(); // pause
      await frames(2);
      const t1 = await tick();
      const step = page.getByRole('button', { name: 'Step one tick' });
      await step.click();
      await frames(3);
      const t2 = await tick();
      assert(t2 === t1 + 1, `tick ${t1} → ${t2}`);
      await step.click();
      await step.click();
      await frames(3);
      assert((await tick()) === t1 + 3, 'three clicks ≠ three ticks');
      assert((await ev(() => window.app.running)) === false, 'step resumed the run');
    });
    await check('step while running pauses and steps', async () => {
      await ev(() => window.app.setPaused(false));
      await page.getByRole('button', { name: 'Step one tick' }).click();
      assert((await ev(() => window.app.running)) === false, 'not paused after step');
    });
    {
      const labels = await page.locator('.seg.speed button').allTextContents();
      await check('speed selector lists ¼× … 64× and Max', async () => {
        assert(labels.length === 10 && labels[9] === 'Max', `labels: ${labels.join(' ')}`);
        return labels.join(' ');
      });
      await ev(() => window.app.setPaused(false));
      const rates = [];
      for (let i = 0; i < labels.length; i++) {
        await check(`speed ${labels[i]}`, async () => {
          await page.locator('.seg.speed button').nth(i).click();
          const st = await ev(
            (i) => ({
              idx: window.app.speedIdx,
              on: document.querySelectorAll('.seg.speed button')[i].classList.contains('on'),
              aria: document.querySelectorAll('.seg.speed button')[i].getAttribute('aria-checked'),
            }),
            i,
          );
          assert(st.idx === i && st.on && st.aria === 'true', `speed index ${st.idx}, on=${st.on}, aria=${st.aria}`);
          await sleep(250);
          const r = await ev(async () => {
            const a = window.app;
            const k0 = a.sim.tick;
            const t0 = performance.now();
            await new Promise((res) => setTimeout(res, 1100));
            return { tps: ((a.sim.tick - k0) * 1000) / (performance.now() - t0), shown: Number(a.el.tps.textContent), limited: a.el.cpu.classList.contains('show') };
          });
          rates.push(r.tps);
          const mult = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 0][i];
          const want = 30 * mult;
          if (mult > 0 && mult <= 2) assert(Math.abs(r.tps - want) <= Math.max(2, want * 0.3), `measured ${r.tps.toFixed(1)} TPS, want ≈${want}`);
          else if (mult > 2) assert(r.tps >= want * 0.7 || r.limited || r.tps > 90, `measured ${r.tps.toFixed(1)} TPS for ${want} requested and no CPU-limited badge`);
          else assert(r.tps > 60, `Max ran only ${r.tps.toFixed(1)} TPS`);
          assert(Number.isFinite(r.shown), 'TPS readout is not a number');
          return `${r.tps.toFixed(1)} TPS measured, readout ${r.shown}${r.limited ? ' (CPU-limited badge)' : ''}`;
        });
      }
      await check('speed changes TPS monotonically (¼× < 1× < 4× ≤ Max)', async () => {
        assert(rates.length === 10, 'missing rates');
        assert(rates[0] < rates[2] && rates[2] < rates[4] && rates[4] <= rates[9] * 1.15, `rates ${rates.map((r) => r.toFixed(0)).join(', ')}`);
        return rates.map((r, i) => `${labels[i]}=${r.toFixed(0)}`).join(' ');
      });
      await page.locator('.seg.speed button').nth(2).click();
    }
    await check('help button opens the shortcuts overlay; close button closes it', async () => {
      await page.getByRole('button', { name: 'Help' }).click();
      await page.locator('.modal-back.show').waitFor({ state: 'visible', timeout: 2000 });
      const rows = await page.locator('.modal .key-row').count();
      assert(rows >= 20, `only ${rows} shortcut rows`);
      await page.locator('.modal').getByRole('button', { name: 'Close' }).click();
      assert(!(await page.locator('.modal-back').isVisible()), 'overlay still visible after close');
      return `${rows} shortcut rows`;
    });
    await check('help overlay closes on backdrop click', async () => {
      await page.getByRole('button', { name: 'Help' }).click();
      await page.mouse.click(8, 450); // backdrop, outside the modal card
      assert(!(await page.locator('.modal-back').isVisible()), 'overlay still visible');
    });
    await check('“H shortcuts” badge opens the overlay', async () => {
      await page.locator('.keys-hint').click();
      assert(await page.locator('.modal-back').isVisible(), 'not opened');
      await page.keyboard.press('Escape');
      assert(!(await page.locator('.modal-back').isVisible()), 'Esc did not close');
    });
    for (const side of ['left', 'right']) {
      await check(`toggle ${side} sidebar`, async () => {
        const btn = page.getByRole('button', { name: `Toggle ${side} sidebar` });
        const w0 = await ev(() => window.app.camera.viewW);
        await btn.click();
        await frames(3);
        const hidden = await ev((s) => getComputedStyle(document.querySelector(`.sidebar.${s}`)).display === 'none', side);
        const w1 = await ev(() => window.app.camera.viewW);
        assert(hidden, 'sidebar still displayed');
        assert(w1 > w0 + 100, `stage did not grow (${w0} → ${w1})`);
        assert((await ev((s) => localStorage.getItem(`al:hide${s === 'left' ? 'Left' : 'Right'}`), side)) === '1', 'not persisted');
        await btn.click();
        await frames(3);
        const shown = await ev((s) => getComputedStyle(document.querySelector(`.sidebar.${s}`)).display !== 'none', side);
        assert(shown && (await ev(() => window.app.camera.viewW)) === w0, 'not restored');
        return `stage ${w0} → ${w1} px`;
      });
    }
    await check('experiment chip opens the Experiments section', async () => {
      await page.getByRole('button', { name: 'Toggle left sidebar' }).click(); // hide first
      await page.locator('.exp-chip').click();
      await sleep(400);
      const st = await ev(() => ({ shown: getComputedStyle(document.querySelector('.sidebar.left')).display !== 'none', open: document.querySelector('#sec-experiments').classList.contains('open') }));
      assert(st.shown && st.open, JSON.stringify(st));
    });
    await check('topbar readouts (clock, tick, population, tribes, TPS/FPS)', async () => {
      await frames(4);
      const r = await ev(() => {
        const a = window.app;
        return {
          clock: a.el.clock.textContent,
          tick: a.el.tick.textContent,
          pop: a.el.pop.textContent,
          tribes: a.el.tribes.textContent,
          n: a.sim.state.agents.length,
          simTick: a.sim.tick,
          liveTribes: a.sim.state.tribes.filter((t) => t.extinctTick === -1).length,
          fps: a.el.fps.textContent,
        };
      });
      assert(/Year \d+ · \w+ · Day \d+/.test(r.clock), `clock "${r.clock}"`);
      assert(r.tick.replace(/[^0-9]/g, '') === String(r.simTick), `tick readout "${r.tick}" vs ${r.simTick}`);
      assert(r.pop.replace(/[^0-9]/g, '') === String(r.n), `population readout "${r.pop}" vs ${r.n}`);
      assert(Number(r.tribes) === r.liveTribes, `tribes readout "${r.tribes}" vs ${r.liveTribes}`);
      assert(Number(r.fps) > 0, `fps readout "${r.fps}"`);
      return `${r.clock}, ${r.tick}, ${r.pop} agents, ${r.tribes} tribes, ${r.fps} FPS`;
    });
  });

  // =================================================================== tools (canvas)
  await section('tools', async () => {
    await fresh('eden', 12345, 240);
    const TOOL_IDS = ['inspect', 'spawn', 'remove', 'addFood', 'removeFood', 'fertilize', 'terrain', 'disaster', 'bless'];
    for (let k = 0; k < 9; k++) {
      await check(`key ${k + 1} selects ${TOOL_IDS[k]}`, async () => {
        await page.locator('canvas.world').focus();
        await page.keyboard.press(String(k + 1));
        const st = await ev(() => ({
          tool: window.app.tool.id,
          rail: [...document.querySelectorAll('.rail-btn')].findIndex((b) => b.classList.contains('on')),
          title: document.querySelector('.tool-title')?.textContent ?? '',
        }));
        assert(st.tool === TOOL_IDS[k] && st.rail === k, `tool ${st.tool}, rail ${st.rail}`);
        return st.title;
      });
    }
    for (let k = 8; k >= 0; k--) {
      await check(`toolbar button ${k + 1} selects ${TOOL_IDS[k]}`, async () => {
        await page.locator('.rail-btn').nth(k).click();
        const st = await ev(() => ({
          tool: window.app.tool.id,
          opts: [...document.querySelectorAll('.tool-opt')].filter((o) => o.style.display !== 'none').map((o) => o.dataset.tool),
          radius: getComputedStyle(document.querySelector('#sec-tool .ctl-slider')).display,
        }));
        assert(st.tool === TOOL_IDS[k], `tool ${st.tool}`);
        const hasOpts = ['spawn', 'addFood', 'fertilize', 'terrain', 'disaster'].includes(TOOL_IDS[k]);
        assert(hasOpts ? st.opts.length === 1 && st.opts[0] === TOOL_IDS[k] : st.opts.length === 0, `options shown: ${st.opts}`);
        const brush = !['inspect', 'bless'].includes(TOOL_IDS[k]);
        assert((st.radius !== 'none') === brush, `brush radius slider display=${st.radius}`);
      });
    }

    await check('inspect: click selects the agent under the cursor', async () => {
      await page.keyboard.press('1');
      const a = await ev(() => {
        const ag = window.__ui.isolatedAgent(9);
        return ag && { id: ag.id, x: ag.x, y: ag.y, name: ag.name };
      });
      assert(a, 'no isolated agent');
      await clickWorld(a.x, a.y, { zoom: 3 });
      await frames(2);
      const st = await ev(() => ({ sel: window.app.view.selectedId, tab: document.querySelector('.tab.on')?.textContent, name: document.querySelector('.insp-name')?.textContent ?? '' }));
      assert(st.sel === a.id, `selected ${st.sel}, wanted ${a.id}`);
      assert(/Inspector/.test(st.tab ?? ''), `tab ${st.tab}`);
      assert(st.name.startsWith(a.name), `inspector shows "${st.name}"`);
      return a.name;
    });
    await check('inspect: click on empty ground deselects', async () => {
      const g = await ev(() => window.__ui.findTerrain(window.__ui.TERRAIN.Grass, 2, undefined, undefined, 30));
      assert(g, 'no empty grass');
      await clickWorld(g.x, g.y, { zoom: 3 });
      assert((await ev(() => window.app.view.selectedId)) === -1, 'still selected');
    });
    await check('inspect: drag pans the camera', async () => {
      const c = await ev(() => ({ ...window.__ui.canvasRect(), cx: window.app.camera.x, z: window.app.camera.zoom }));
      await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2);
      await page.mouse.down();
      await page.mouse.move(c.x + c.w / 2 - 120, c.y + c.h / 2, { steps: 6 });
      await page.mouse.up();
      const cx = await ev(() => window.app.camera.x);
      approx(cx - c.cx, 120 / c.z, 2, 'camera x after 120 px drag');
    });
    await check('inspect: double-click follows the agent', async () => {
      const a = await ev(() => {
        const ag = window.__ui.isolatedAgent(9);
        return ag && { id: ag.id, x: ag.x, y: ag.y };
      });
      await ev(({ x, y }) => window.__ui.centre(x, y, 3), a);
      await frames(2);
      const p = await ev(({ x, y }) => window.__ui.screenOf(x, y), a);
      await page.mouse.dblclick(p.x, p.y);
      const st = await ev(() => ({ f: window.app.followId, pill: document.querySelector('.follow-pill').style.display !== 'none' }));
      assert(st.f === a.id && st.pill, JSON.stringify(st));
      await page.locator('.follow-pill').click();
      assert((await ev(() => window.app.followId)) === -1, 'follow pill did not stop following');
    });

    // ---------------- spawn + designer
    const grass = await ev(() => window.__ui.findTerrain(window.__ui.TERRAIN.Grass, 4, undefined, undefined, 60));
    async function spawnAt(x, y) {
      const before = await ev(() => ({ next: window.app.sim.state.nextAgentId, t: window.app.sim.tick, tribes: window.app.sim.state.tribes.length, nextTribe: window.app.sim.state.nextTribeId }));
      await clickWorld(x, y, { zoom: 2 });
      await waitTick(before.t + 1);
      return ev((b) => {
        const s = window.app.sim.state;
        const made = s.agents.filter((a) => a.id >= b.next && a.parents[0] === -1);
        const G = ['speed', 'size', 'perception', 'metabolism', 'aggression', 'sociability', 'altruism', 'fertility', 'longevity', 'immunity', 'efficiency', 'hue'];
        const mean = {};
        const sd = {};
        G.forEach((g, i) => {
          const v = made.map((a) => a.genes[i]);
          const m = v.reduce((p, q) => p + q, 0) / Math.max(1, v.length);
          mean[g] = m;
          sd[g] = Math.sqrt(v.reduce((p, q) => p + (q - m) ** 2, 0) / Math.max(1, v.length));
        });
        const tribeIds = [...new Set(made.map((a) => a.tribeId))];
        const newTribes = s.tribes.filter((t) => t.id >= b.nextTribe).map((t) => ({ id: t.id, name: t.name }));
        return { n: made.length, mean, sd, tribeIds, newTribes, passable: made.every((a) => window.app.sim.passableAt(a.x, a.y)) };
      }, before);
    }
    const designer = '.designer';
    await check('spawn: click adds the group size (default 20) as a new tribe', async () => {
      await page.keyboard.press('2');
      assert(grass, 'no grass');
      const n0 = await pop();
      const r = await spawnAt(grass.x, grass.y);
      assert(r.n === 20, `spawned ${r.n}`);
      assert((await pop()) >= n0 + 18, 'population did not increase');
      assert(r.newTribes.length === 1 && r.tribeIds.length === 1 && r.tribeIds[0] === r.newTribes[0].id, `tribes ${JSON.stringify(r.newTribes)} / ${r.tribeIds}`);
      assert(r.passable, 'spawned on impassable ground');
      return `+${r.n} agents, new tribe ${r.newTribes[0].name}`;
    });
    await check('spawn: group size slider', async () => {
      await setRange(slider(designer, 'Group size'), 7);
      const r = await spawnAt(grass.x + 40, grass.y);
      assert(r.n === 7, `spawned ${r.n}`);
    });
    const PRESETS = {
      'Gentle foragers': { aggression: 0.04, altruism: 0.88 },
      'Warlike raiders': { aggression: 0.96, size: 0.75 },
      'Swift scouts': { speed: 0.95, size: 0.28 },
      'Hardy giants': { size: 0.95, longevity: 0.88 },
      Balanced: { aggression: 0.4, sociability: 0.55 },
    };
    await setRange(slider(designer, 'Group size'), 24);
    for (const [name, genes] of Object.entries(PRESETS)) {
      await check(`spawn: designer preset “${name}” sets spawned genes`, async () => {
        await page.locator(`${designer} .presets .chip`, { hasText: name }).click();
        const r = await spawnAt(grass.x, grass.y + 30);
        assert(r.n === 24, `spawned ${r.n}`);
        for (const [g, v] of Object.entries(genes)) approx(r.mean[g], v, 0.06, `mean ${g}`);
        return Object.keys(genes)
          .map((g) => `${g} ${r.mean[g].toFixed(2)}`)
          .join(', ');
      });
    }
    await check('spawn: “Random” preset rolls new gene means', async () => {
      const g0 = await ev(() => ({ ...window.app.designer.genes }));
      await page.locator(`${designer} .presets .chip`, { hasText: 'Random' }).click();
      const g1 = await ev(() => ({ ...window.app.designer.genes }));
      const changed = Object.keys(g0).filter((k) => Math.abs(g0[k] - g1[k]) > 1e-6).length;
      assert(changed >= 8, `only ${changed} genes changed`);
      const r = await spawnAt(grass.x - 30, grass.y);
      approx(r.mean.speed, g1.speed, 0.08, 'mean speed');
    });
    await check('spawn: gene sliders change spawned genes', async () => {
      await page.locator(`${designer} .presets .chip`, { hasText: 'Balanced' }).click();
      await setRange(slider(designer, 'Speed'), 0.12);
      await setRange(slider(designer, 'Immunity'), 0.9);
      await setRange(slider(designer, 'Colour (hue)'), 0.6);
      const presetOn = await page.locator(`${designer} .presets .chip.on`).count();
      assert(presetOn === 0, 'preset chip still highlighted after a manual edit');
      const r = await spawnAt(grass.x, grass.y - 30);
      approx(r.mean.speed, 0.12, 0.06, 'mean speed');
      approx(r.mean.immunity, 0.9, 0.06, 'mean immunity');
      approx(r.mean.hue, 0.6, 0.06, 'mean hue');
      return `speed ${r.mean.speed.toFixed(2)}, immunity ${r.mean.immunity.toFixed(2)}, hue ${r.mean.hue.toFixed(2)}`;
    });
    await check('spawn: variation slider 0 makes clones', async () => {
      await setRange(slider(designer, 'Variation (spread)'), 0);
      const r = await spawnAt(grass.x + 30, grass.y + 30);
      const maxSd = Math.max(...Object.values(r.sd));
      assert(maxSd < 1e-6, `gene sd ${maxSd}`);
      await setRange(slider(designer, 'Variation (spread)'), 0.08);
    });
    await check('spawn: all 12 gene sliders set the spawned genome', async () => {
      const LABELS = ['Speed', 'Size', 'Perception', 'Metabolism', 'Aggression', 'Sociability', 'Altruism', 'Fertility', 'Longevity', 'Immunity', 'Efficiency', 'Colour (hue)'];
      const G = ['speed', 'size', 'perception', 'metabolism', 'aggression', 'sociability', 'altruism', 'fertility', 'longevity', 'immunity', 'efficiency', 'hue'];
      const want = LABELS.map((_, i) => Number((0.13 + i * 0.07).toFixed(2)));
      for (let i = 0; i < LABELS.length; i++) await setRange(slider(designer, LABELS[i]), want[i]);
      await setRange(slider(designer, 'Variation (spread)'), 0);
      const r = await spawnAt(grass.x - 30, grass.y + 30);
      const bad = G.filter((g, i) => Math.abs(r.mean[g] - want[i]) > 1e-6).map((g, i) => `${g} ${r.mean[g]}`);
      assert(r.n > 0 && !bad.length, `genes off: ${bad.join(', ')}`);
      await setRange(slider(designer, 'Variation (spread)'), 0.08);
      return G.map((g) => `${g} ${r.mean[g].toFixed(2)}`).join(' ');
    });
    await check('spawn: phenotype preview follows the genes', async () => {
      const a = await page.locator(`${designer} .designer-preview`).textContent();
      await setRange(slider(designer, 'Speed'), 0.95);
      const b = await page.locator(`${designer} .designer-preview`).textContent();
      assert(a !== b && /speed/.test(b), `preview "${a}" → "${b}"`);
    });
    await check('spawn: tribe “Unaffiliated” spawns loners', async () => {
      await page.locator(`${designer} select`).selectOption('none');
      const r = await spawnAt(grass.x - 30, grass.y - 30);
      assert(r.n > 0 && r.tribeIds.length === 1 && r.tribeIds[0] === -1 && r.newTribes.length === 0, `tribes ${r.tribeIds} new ${JSON.stringify(r.newTribes)}`);
      const nameShown = await page.locator(`${designer} input[type=text]`).isVisible();
      assert(!nameShown, 'tribe name box shown for unaffiliated');
    });
    await check('spawn: “Found a new tribe” with a custom name', async () => {
      await page.locator(`${designer} select`).selectOption('new');
      await page.locator(`${designer} input[type=text]`).fill('Audit Clan');
      const r = await spawnAt(grass.x + 40, grass.y - 30);
      assert(r.newTribes.length === 1 && r.newTribes[0].name === 'Audit Clan', `new tribes ${JSON.stringify(r.newTribes)}`);
      assert(r.tribeIds.length === 1 && r.tribeIds[0] === r.newTribes[0].id, 'members not in the new tribe');
      await page.locator(`${designer} input[type=text]`).fill('');
    });
    await check('spawn: “Join <tribe>” reinforces an existing tribe', async () => {
      await ev(() => window.app.designer.refreshTribes());
      const opt = await page.locator(`${designer} select option`).nth(2);
      const val = await opt.getAttribute('value');
      assert(val && /^\d+$/.test(val), `no tribe option (${val})`);
      await page.locator(`${designer} select`).selectOption(val);
      const r = await spawnAt(grass.x - 40, grass.y + 30);
      assert(r.n > 0 && r.tribeIds.length === 1 && r.tribeIds[0] === Number(val) && r.newTribes.length === 0, `tribes ${r.tribeIds} (want ${val})`);
      await page.locator(`${designer} select`).selectOption('new');
      return `joined tribe #${val}`;
    });
    await check('spawn: refused on impassable terrain (toast, nothing spawned)', async () => {
      const deep = await ev(() => window.__ui.findTerrain(window.__ui.TERRAIN.DeepWater, 2));
      assert(deep, 'no deep water');
      const n0 = await ev(() => window.app.sim.state.nextAgentId);
      const toasts0 = await page.locator('.toast').count();
      await clickWorld(deep.x, deep.y, { zoom: 2 });
      await frames(3);
      assert((await ev(() => window.app.sim.state.nextAgentId)) === n0, 'agents were spawned in deep water');
      assert((await page.locator('.toast-bad').count()) > 0 || (await page.locator('.toast').count()) > toasts0, 'no feedback toast');
    });

    // ---------------- remove
    await check('remove: click removes agents inside the brush', async () => {
      await page.keyboard.press('3');
      await setRange(slider('#sec-tool', 'Brush radius'), 40);
      const t = await ev(() => {
        const s = window.app.sim.state;
        // densest point: an agent with the most neighbours within 40
        let best = null;
        let bn = -1;
        for (const a of s.agents) {
          const n = window.__ui.agentsIn(a.x, a.y, 40).length;
          if (n > bn) {
            bn = n;
            best = a;
          }
        }
        return { x: best.x, y: best.y, n: bn, next: s.nextAgentId, t: window.app.sim.tick, pop: s.agents.length };
      });
      // Agents keep moving after the removal is applied (interventions run at tick start, movement later in
      // the same tick), so judge by identity: every agent inside the brush when it fired must be gone.
      // The sim is paused, so nothing moves between this snapshot and the tick that applies the click.
      const inside = await ev((t) => window.__ui.agentsIn(t.x, t.y, 38).map((a) => a.id), t);
      await clickWorld(t.x, t.y, { zoom: 2 });
      await waitTick(t.t + 1);
      const r = await ev(
        (q) => ({ left: q.inside.filter((id) => window.app.sim.getAgent(id)).length, pre: window.app.sim.state.agents.filter((a) => a.id < q.next).length }),
        { inside, next: t.next },
      );
      assert(r.left === 0, `${r.left} of ${inside.length} agents inside the brush survived`);
      // newborns of this tick are appended at its end; count only agents that existed before the click
      assert(r.pre <= t.pop - t.n && r.pre >= t.pop - t.n - 10, `pre-existing agents ${t.pop} → ${r.pre} (expected −${t.n})`);
      return `removed ${t.n} agents`;
    });
    await check('remove: drag sweeps a path', async () => {
      const g = await ev(() => {
        const s = window.app.sim.state;
        const a = s.agents[Math.floor(s.agents.length / 2)];
        return { x: a.x, y: a.y, t: window.app.sim.tick, log: s.interventionLog.length };
      });
      await ev(({ x, y }) => window.__ui.centre(x, y, 2), g);
      await frames(2);
      const p = await ev(({ x, y }) => window.__ui.screenOf(x, y), g);
      await page.mouse.move(p.x - 100, p.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(p.x - 100 + i * 25, p.y);
        await sleep(50);
      }
      await page.mouse.up();
      await frames(4);
      const n = await ev((g) => window.app.sim.state.interventionLog.slice(g.log).filter((r) => r.intervention.kind === 'remove').length, g);
      assert(n >= 3, `only ${n} remove stamps along a 200 px drag`);
      return `${n} stamps`;
    });

    // ---------------- food & fertility
    await check('remove food: brush strips the food', async () => {
      await page.keyboard.press('5');
      await setRange(slider('#sec-tool', 'Brush radius'), 40);
      const g = await ev(() => window.__ui.findTerrain(window.__ui.TERRAIN.Grass, 5, window.app.sim.worldW * 0.3, window.app.sim.worldH * 0.3));
      const before = await ev((g) => ({ f: window.__ui.sumIn('food', g.x, g.y, 40), t: window.app.sim.tick }), g);
      await clickWorld(g.x, g.y);
      await waitTick(before.t + 1);
      const after = await ev((g) => window.__ui.sumIn('food', g.x, g.y, 40), g);
      assert(before.f > 10 && after < before.f * 0.05, `food ${before.f.toFixed(1)} → ${after.toFixed(1)}`);
      return `${before.f.toFixed(0)} → ${after.toFixed(1)}`;
    });
    await check('add food: brush adds “food per tile”', async () => {
      await page.keyboard.press('4');
      await setRange(slider('#sec-tool', 'Brush radius'), 40);
      await setRange(slider('#sec-tool', 'Food per tile'), 5);
      const g = await ev(() => window.__ui.findTerrain(window.__ui.TERRAIN.Grass, 5, window.app.sim.worldW * 0.3, window.app.sim.worldH * 0.3));
      const before = await ev((g) => ({ f: window.__ui.sumIn('food', g.x, g.y, 40), n: window.__ui.tilesIn(g.x, g.y, 40).length, t: window.app.sim.tick }), g);
      await clickWorld(g.x, g.y);
      await waitTick(before.t + 1);
      const after = await ev((g) => window.__ui.sumIn('food', g.x, g.y, 40), g);
      const added = after - before.f;
      assert(added > before.n * 5 * 0.8, `added ${added.toFixed(1)} over ${before.n} tiles (want ≈${before.n * 5})`);
      const amt = await ev(() => window.app.sim.state.interventionLog.at(-1).intervention.amount);
      assert(amt === 5, `intervention amount ${amt}`);
      return `+${added.toFixed(0)} food on ${before.n} tiles`;
    });
    await check('fertilize: brush raises soil fertility by the slider amount', async () => {
      await page.keyboard.press('6');
      await setRange(slider('#sec-tool', 'Fertility boost'), 0.2);
      const g = await ev(() => {
        const w = window.app.sim.state.world;
        for (let i = 0; i < w.fertility.length; i++) if (w.terrain[i] === 3 && w.fertility[i] < 0.7) return window.__ui.tileCentre(i);
        return window.__ui.findTerrain(window.__ui.TERRAIN.Grass, 3);
      });
      const before = await ev((g) => ({ f: window.app.sim.state.world.fertility[window.app.sim.tileIndex(g.x, g.y)], t: window.app.sim.tick }), g);
      await clickWorld(g.x, g.y);
      await waitTick(before.t + 1);
      const after = await ev((g) => window.app.sim.state.world.fertility[window.app.sim.tileIndex(g.x, g.y)], g);
      assert(after > before.f + 0.15, `fertility ${before.f.toFixed(2)} → ${after.toFixed(2)}`);
      return `${before.f.toFixed(2)} → ${after.toFixed(2)}`;
    });
    await check('air-brush tools keep stamping while held still', async () => {
      const g = await ev(() => window.__ui.findTerrain(window.__ui.TERRAIN.Grass, 3, window.app.sim.worldW * 0.7, window.app.sim.worldH * 0.6));
      await ev(({ x, y }) => window.__ui.centre(x, y, 2), g);
      await frames(2);
      const p = await ev(({ x, y }) => window.__ui.screenOf(x, y), g);
      const log0 = await ev(() => window.app.sim.state.interventionLog.length);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await sleep(1000);
      await page.mouse.up();
      await frames(3);
      const n = await ev((l) => window.app.sim.state.interventionLog.slice(l).filter((r) => r.intervention.kind === 'fertilize').length, log0);
      assert(n >= 3, `${n} stamps in 1 s hold`);
      return `${n} stamps in 1 s`;
    });

    // ---------------- terrain
    const TERRAINS = ['Grassland', 'Forest', 'Sand', 'Desert', 'Mountain', 'Shallows', 'Deep water', 'Wall'];
    const TCODE = { Grassland: 3, Forest: 4, Sand: 2, Desert: 5, Mountain: 6, Shallows: 1, 'Deep water': 0, Wall: 7 };
    await page.keyboard.press('7');
    for (const tname of TERRAINS) {
      await check(`paint terrain: ${tname}`, async () => {
        await page.locator('.terrain-pick .chip', { hasText: tname }).click();
        assert((await ev(() => window.app.settings.terrain)) === TCODE[tname], 'settings.terrain not updated');
        const help = await page.locator('#sec-tool .helpbox').textContent();
        assert(help.includes(tname), `help box does not describe ${tname}`);
        await setRange(slider('#sec-tool', 'Brush radius'), 24);
        const target = await ev((code) => {
          // a land tile of a different terrain, with agents around for the impassable cases
          const s = window.app.sim.state;
          const a = s.agents.find((ag) => ag.alive && window.app.sim.terrainAt(ag.x, ag.y) !== code && window.__ui.agentsIn(ag.x, ag.y, 24).length >= 2);
          return a ? { x: a.x, y: a.y } : window.__ui.findTerrain(3, 3);
        }, TCODE[tname]);
        const t0 = await tick();
        await clickWorld(target.x, target.y);
        await waitTick(t0 + 1);
        const r = await ev(({ x, y }) => {
          const sim = window.app.sim;
          const bad = sim.state.agents.filter((a) => a.alive && !sim.passableAt(a.x, a.y)).length;
          const camps = sim.state.tribes.filter((t) => t.extinctTick === -1 && !sim.passableAt(t.homeX, t.homeY)).length;
          return { t: sim.terrainAt(x, y), tiles: window.__ui.tilesIn(x, y, 24).filter((i) => sim.state.world.terrain[i] === window.app.settings.terrain).length, bad, camps };
        }, target);
        assert(r.t === TCODE[tname], `tile is ${r.t}, wanted ${TCODE[tname]}`);
        assert(r.bad === 0, `${r.bad} agents left on impassable tiles`);
        assert(r.camps === 0, `${r.camps} camps left on impassable tiles`);
        return `${r.tiles} tiles`;
      });
    }
    await check('paint terrain: dragging a wall leaves a continuous line', async () => {
      await page.locator('.terrain-pick .chip', { hasText: 'Wall' }).click();
      await setRange(slider('#sec-tool', 'Brush radius'), 10);
      const g = await ev(() => window.__ui.findTerrain(3, 6, window.app.sim.worldW * 0.5, window.app.sim.worldH * 0.5));
      await ev(({ x, y }) => window.__ui.centre(x, y, 2), g);
      await frames(2);
      const p = await ev(({ x, y }) => window.__ui.screenOf(x, y), g);
      await page.mouse.move(p.x - 60, p.y);
      await page.mouse.down();
      await page.mouse.move(p.x + 60, p.y, { steps: 3 }); // fast stroke: the painter must interpolate
      await sleep(60);
      await page.mouse.move(p.x + 61, p.y);
      await page.mouse.up();
      await frames(4);
      const holes = await ev(({ x, y }) => {
        const sim = window.app.sim;
        let holes = 0;
        for (let dx = -25; dx <= 25; dx += 2) if (sim.terrainAt(x + dx, y) !== 7) holes++;
        return holes;
      }, g);
      assert(holes === 0, `${holes} gaps along a 50-unit wall stroke`);
    });

    // ---------------- disasters
    await page.keyboard.press('8');
    await setRange(slider('#sec-tool', 'Brush radius'), 60);
    const KINDS = [
      ['Drought', 'drought'],
      ['Blight', 'blight'],
      ['Abundance', 'bloom'],
      ['Plague', 'plague'],
      ['Meteor', 'meteor'],
      ['Cold snap', 'coldsnap'],
    ];
    for (const [label, kind] of KINDS) {
      await check(`disaster tool: ${label}`, async () => {
        await page.locator('.disaster-pick .chip', { hasText: label }).click();
        assert((await ev(() => window.app.settings.disaster)) === kind, 'settings.disaster not updated');
        const g = await ev(() => window.__ui.findTerrain(3, 3, window.app.sim.worldW * 0.6, window.app.sim.worldH * 0.4));
        const before = await ev(() => ({ t: window.app.sim.tick, next: window.app.sim.state.nextDisasterId }));
        await clickWorld(g.x, g.y);
        await waitTick(before.t + 1);
        const d = await ev((b) => window.app.sim.state.disasters.filter((d) => d.id >= b.next), before);
        assert(d.length === 1 && d[0].kind === kind, `new disasters: ${JSON.stringify(d.map((x) => x.kind))}`);
        approx(d[0].x, g.x, 1, 'disaster x');
        if (kind !== 'meteor') approx(d[0].radius, 60, 0.01, 'radius');
        return `r=${d[0].radius}, I=${d[0].intensity}, ${d[0].duration} ticks`;
      });
    }
    await check('disaster tool: intensity and duration sliders', async () => {
      await page.locator('.disaster-pick .chip', { hasText: 'Drought' }).click();
      await setRange(slider('#sec-tool', 'Intensity'), 0.4);
      await setRange(slider('#sec-tool', 'Duration'), 1.5);
      const g = await ev(() => window.__ui.findTerrain(3, 3, window.app.sim.worldW * 0.4, window.app.sim.worldH * 0.6));
      const before = await ev(() => ({ t: window.app.sim.tick, next: window.app.sim.state.nextDisasterId, dl: window.app.sim.config.dayLength }));
      await clickWorld(g.x, g.y);
      await waitTick(before.t + 1);
      const d = await ev((b) => window.app.sim.state.disasters.find((d) => d.id >= b.next), before);
      approx(d.intensity, 0.4, 1e-9, 'intensity');
      approx(d.duration, 1.5 * before.dl, 0, 'duration (ticks)');
    });

    await check('disaster tool: meteor preview shows the capped impact radius and hides Duration', async () => {
      await page.locator('.disaster-pick .chip', { hasText: 'Meteor' }).click();
      await setRange(slider('#sec-tool', 'Brush radius'), 250);
      const durShown = await slider('#sec-tool', 'Duration').isVisible();
      const g = await ev(() => window.__ui.findTerrain(3, 3, window.app.sim.worldW * 0.5, window.app.sim.worldH * 0.5));
      await ev(({ x, y }) => window.__ui.centre(x, y, 1), g);
      await frames(2);
      const p = await ev(({ x, y }) => window.__ui.screenOf(x, y), g);
      await page.mouse.move(p.x, p.y);
      await frames(3);
      const st = await ev(() => ({ preview: window.app.view.brush?.radius, hud: document.querySelector('.tool-hud').textContent }));
      const t0 = await tick();
      await page.mouse.click(p.x, p.y);
      await waitTick(t0 + 1);
      const iv = await ev(() => window.app.sim.state.interventionLog.at(-1).intervention);
      await page.locator('.disaster-pick .chip', { hasText: 'Drought' }).click();
      await frames(2);
      await page.mouse.move(p.x, p.y);
      await frames(3);
      const after = { preview: await ev(() => window.app.view.brush?.radius), dur: (await slider('#sec-tool', 'Duration').isVisible()) ? 'shown' : 'none' };
      await setRange(slider('#sec-tool', 'Brush radius'), 60);
      assert(iv.kind === 'disaster' && iv.disaster === 'meteor', JSON.stringify(iv));
      assert(st.preview === iv.radius, `brush preview radius ${st.preview} but the meteor hits radius ${iv.radius}`);
      assert(st.hud.includes(`${iv.radius} u`), `tool HUD "${st.hud}" vs impact radius ${iv.radius}`);
      assert(!durShown, 'Duration slider shown for meteors (the simulation ignores it)');
      assert(after.preview === 250 && after.dur !== 'none', `after switching to Drought: ${JSON.stringify(after)}`);
      return `preview ${st.preview} = impact ${iv.radius}`;
    });

    // ---------------- bless / smite
    await check('bless: click fully heals and feeds the agent', async () => {
      await page.keyboard.press('9');
      const a = await ev(() => {
        const ag = window.__ui.isolatedAgent(9, undefined, undefined, (x) => x.food < x.traits.maxFood * 0.9) || window.__ui.isolatedAgent(9);
        return ag && { id: ag.id, x: ag.x, y: ag.y, food: ag.food, max: ag.traits.maxFood, t: window.app.sim.tick };
      });
      assert(a, 'no target');
      await clickWorld(a.x, a.y, { zoom: 3 });
      await waitTick(a.t + 1);
      const r = await ev((id) => {
        const x = window.app.sim.getAgent(id);
        return x && { food: x.food, max: x.traits.maxFood, hp: x.health, maxHp: x.traits.maxHealth, energy: x.energy };
      }, a.id);
      assert(r, 'agent died');
      assert(r.food >= r.max * 0.97 && r.hp >= r.maxHp * 0.97, `food ${r.food.toFixed(1)}/${r.max.toFixed(1)}, hp ${r.hp.toFixed(1)}/${r.maxHp.toFixed(1)}`);
      return `food ${a.food.toFixed(0)} → ${r.food.toFixed(0)} / ${r.max.toFixed(0)}`;
    });
    await check('smite: Shift-click kills the agent', async () => {
      const a = await ev(() => {
        const ag = window.__ui.isolatedAgent(9);
        return ag && { id: ag.id, x: ag.x, y: ag.y, t: window.app.sim.tick };
      });
      await clickWorld(a.x, a.y, { zoom: 3, shift: true });
      await waitTick(a.t + 1);
      const r = await ev((id) => ({ alive: !!window.app.sim.getAgent(id), cause: window.app.sim.lineageById.get(id)?.deathCause }), a.id);
      assert(!r.alive && r.cause === 'removed', JSON.stringify(r));
    });
    await check('bless: click on empty ground only shows a hint', async () => {
      const g = await ev(() => window.__ui.findTerrain(3, 2, undefined, undefined, 30));
      const l0 = await ev(() => window.app.sim.state.interventionLog.length);
      await clickWorld(g.x, g.y, { zoom: 3 });
      await frames(3);
      assert((await ev(() => window.app.sim.state.interventionLog.length)) === l0, 'an intervention was recorded');
    });

    // ---------------- brush radius controls
    await check('brush radius slider sets the intervention radius', async () => {
      await page.keyboard.press('5');
      // real pointer interaction: click 3/4 along the slider track
      const s = slider('#sec-tool', 'Brush radius');
      await s.scrollIntoViewIfNeeded();
      const box = await s.boundingBox();
      await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
      const r1 = await ev(() => window.app.settings.radius);
      assert(r1 > 200 && r1 < 260, `radius after clicking 75% of the track: ${r1}`);
      await setRange(s, 33);
      const g = await ev(() => window.__ui.findTerrain(3, 3));
      const t0 = await tick();
      await clickWorld(g.x, g.y);
      await waitTick(t0 + 1);
      const iv = await ev(() => window.app.sim.state.interventionLog.at(-1).intervention);
      assert(iv.kind === 'removeFood' && iv.radius === 33, JSON.stringify(iv));
      const hud = await page.locator('.tool-hud').textContent();
      assert(hud.includes('33'), `tool HUD "${hud}"`);
    });
    await check('[ and ] keys resize the brush', async () => {
      await page.locator('canvas.world').focus();
      const r0 = await ev(() => window.app.settings.radius);
      await page.keyboard.press(']');
      const r1 = await ev(() => window.app.settings.radius);
      await page.keyboard.press('[');
      await page.keyboard.press('[');
      const r2 = await ev(() => window.app.settings.radius);
      assert(r1 > r0 && r2 < r1, `${r0} → ${r1} → ${r2}`);
      const shown = await slider('#sec-tool', 'Brush radius').inputValue();
      await sleep(300);
      assert(Math.abs(Number(await slider('#sec-tool', 'Brush radius').inputValue()) - r2) < 1, `slider shows ${shown}`);
    });
    await check('Alt + wheel resizes the brush', async () => {
      const c = await ev(() => window.__ui.canvasRect());
      await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2);
      const r0 = await ev(() => window.app.settings.radius);
      await page.keyboard.down('Alt');
      await page.mouse.wheel(0, -200);
      await page.keyboard.up('Alt');
      await frames(2);
      const r1 = await ev(() => window.app.settings.radius);
      assert(r1 > r0, `${r0} → ${r1}`);
    });
  });

  // =================================================================== global events
  await section('global events', async () => {
    await fresh('eden', 12345, 60);
    await setRange(slider('#sec-global', 'Severity'), 0.55);
    await setRange(slider('#sec-global', 'Duration'), 1.25);
    for (const [label, kind] of [
      ['Drought', 'drought'],
      ['Plague', 'plague'],
      ['Abundance', 'bloom'],
      ['Ice age', 'coldsnap'],
      ['Blight', 'blight'],
    ]) {
      await check(label, async () => {
        const b = await ev(() => ({ t: window.app.sim.tick, next: window.app.sim.state.nextDisasterId, dl: window.app.sim.config.dayLength }));
        await page.locator('#sec-global .gev-btn', { hasText: label }).click();
        await waitTick(b.t + 1);
        const d = await ev((b) => window.app.sim.state.disasters.filter((d) => d.id >= b.next), b);
        assert(d.length === 1 && d[0].kind === kind && d[0].radius === 0, JSON.stringify(d));
        approx(d[0].intensity, 0.55, 1e-9, 'intensity');
        approx(d[0].duration, 1.25 * b.dl, 0, 'duration');
        return `${kind} r=0 I=${d[0].intensity} ${d[0].duration} ticks`;
      });
    }
  });

  // =================================================================== view
  await section('view', async () => {
    // Frames are compared after rendering twice at the same fixed animation time, so only the
    // control under test can change pixels (paused sim, no hover, no brush).
    // The minimap caches a thumbnail on its own frame counter (and the app's rAF renders run in between),
    // so it is excluded from these pixel comparisons; it has dedicated checks of its own.
    const renderSnap = () =>
      ev(() => {
        const a = window.app;
        a.view.hoverId = -1;
        a.renderer.render(a.sim, { ...a.view, showMinimap: false }, 987654);
        const c = a.renderer.canvas;
        window.__snap = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        return true;
      });
    const renderDiff = () =>
      ev(() => {
        const a = window.app;
        a.view.hoverId = -1;
        a.renderer.render(a.sim, { ...a.view, showMinimap: false }, 987654);
        const c = a.renderer.canvas;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const p = window.__snap;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - p[i]) + Math.abs(d[i + 1] - p[i + 1]) + Math.abs(d[i + 2] - p[i + 2]) > 24) n++;
        return n;
      });
    await fresh('eden', 12345, 900);
    await page.mouse.move(700, 20); // park the pointer on the top bar: no hover tag, no brush
    // a selected agent with visible relationships that walks for a while, so it leaves a trail
    let selA = -1;
    for (let attempt = 0; attempt < 4; attempt++) {
      selA = await ev((attempt) => {
        const sim = window.app.sim;
        const moving = new Set(['forage', 'wander', 'explore', 'gohome', 'flee', 'socialize', 'mate']);
        const rel = (a) => a.relationships.filter((r) => sim.getAgent(r.id) && (r.kin > 0 || Math.abs(r.affinity) >= 0.12)).length >= 2;
        const pool = sim.state.agents.filter((a) => rel(a) && moving.has(a.action) && a.energy > 0.4);
        const a = pool[attempt % Math.max(1, pool.length)] || sim.state.agents.find(rel) || sim.state.agents[0];
        window.app.select(a.id);
        return a.id;
      }, attempt);
      await ev(() => {
        window.app.setSpeed(4);
        window.app.setPaused(false);
      });
      await sleep(1500);
      await ev(() => {
        window.app.setPaused(true);
        window.app.setSpeed(2);
      });
      const extent = await ev(() => {
        const r = window.app.renderer;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = 0; i < r.trailLen; i++) {
          const k = ((r.trailHead - 1 - i + r.trail.length / 2) % (r.trail.length / 2)) * 2;
          x0 = Math.min(x0, r.trail[k]); x1 = Math.max(x1, r.trail[k]); y0 = Math.min(y0, r.trail[k + 1]); y1 = Math.max(y1, r.trail[k + 1]);
        }
        return r.trailLen > 1 ? Math.hypot(x1 - x0, y1 - y0) : 0;
      });
      if (extent >= 20) break;
    }
    await page.locator('#sec-global .gev-btn', { hasText: 'Plague' }).click(); // so disease/climate overlays have content
    await page.locator('#sec-global .gev-btn', { hasText: 'Drought' }).click();
    await frames(4);
    await check('fixed-time re-render is pixel-identical (method check)', async () => {
      await ev(() => window.app.fitWorld());
      await renderSnap();
      const n = await renderDiff();
      assert(n === 0, `${n} pixels differ between identical renders`);
    });
    const OVERLAYS = ['None', 'Food', 'Fertility', 'Density', 'Territory', 'Disease', 'Climate'];
    const OVAL = { None: 'none', Food: 'food', Fertility: 'fertility', Density: 'density', Territory: 'territory', Disease: 'disease', Climate: 'climate' };
    await page.locator('.overlay-pick .chip', { hasText: /^None$/ }).click();
    await renderSnap();
    for (const name of OVERLAYS) {
      await check(`overlay ${name}`, async () => {
        await page.locator('.overlay-pick .chip', { hasText: new RegExp(`^${name}$`) }).click();
        const st = await ev(() => ({ ov: window.app.view.overlay, stored: localStorage.getItem('al:overlay'), on: document.querySelector('.overlay-pick .chip.on')?.textContent }));
        assert(st.ov === OVAL[name] && st.stored === OVAL[name] && st.on === name, JSON.stringify(st));
        const n = await renderDiff();
        const lg = await ev(() => ({ ...window.app.renderer.legendRect }));
        if (name === 'None') {
          assert(n === 0 && !lg.visible, `${n} pixels changed / legend ${lg.visible}`);
          return;
        }
        const total = await ev(() => window.app.renderer.canvas.width * window.app.renderer.canvas.height);
        assert(n > total * 0.02, `the ${name} overlay changed only ${n} pixels`);
        assert(lg.visible && lg.w > 100 && lg.h > 30, `legend ${JSON.stringify(lg)}`);
        return `${((n / total) * 100).toFixed(1)}% of pixels changed, legend ${lg.w}×${lg.h}`;
      });
    }
    await check('O key cycles overlays (Shift+O backwards)', async () => {
      await page.locator('canvas.world').focus();
      const a = await ev(() => window.app.view.overlay);
      await page.keyboard.press('o');
      const b = await ev(() => window.app.view.overlay);
      await page.keyboard.press('Shift+O');
      const c = await ev(() => window.app.view.overlay);
      const chip = await page.locator('.overlay-pick .chip.on').textContent();
      assert(a !== b && c === a, `${a} → ${b} → ${c}`);
      assert(OVAL[chip] === c, `chip "${chip}" vs overlay ${c}`);
    });
    await page.locator('.overlay-pick .chip', { hasText: /^Food$/ }).click();
    const TOGGLES = [
      ['Vision radius', 'showVision'],
      ['Trails', 'showTrails'],
      ['Relationships', 'showRelations'],
      ['Tribe camps', 'showCamps'],
      ['Name labels', 'showLabels'],
      ['Minimap', 'showMinimap'],
      ['Overlay legend', 'showLegend'],
    ];
    for (const [label, key] of TOGGLES) {
      await check(`toggle ${label} changes the rendered frame`, async () => {
        // frame the feature: the selected agent up close, or a camp for the camp markers
        await ev(
          ({ key, id }) => {
            const sim = window.app.sim;
            const a = sim.getAgent(id);
            if (key === 'showCamps') {
              const t = sim.state.tribes.find((t) => t.extinctTick === -1);
              window.__ui.centre(t.homeX, t.homeY, 2);
            } else if (key === 'showMinimap' || key === 'showLegend') window.app.fitWorld();
            else window.__ui.centre(a.x, a.y, key === 'showLabels' ? 4 : 3);
          },
          { key, id: selA },
        );
        await frames(2);
        const ctl = toggleCtl('#sec-view', label);
        const v0 = await ev((k) => window.app.view[k], key);
        await renderSnap();
        await ctl.click();
        const n = await renderDiff();
        const v1 = await ev((k) => window.app.view[k], key);
        const stored = await ev((k) => JSON.parse(localStorage.getItem('al:view') || '{}')[k], key);
        const extra = await ev((k) => (k === 'showMinimap' ? window.app.renderer.minimapRect.visible : k === 'showLegend' ? window.app.renderer.legendRect.visible : null), key);
        await ctl.click();
        await frames(2);
        const v2 = await ev((k) => window.app.view[k], key);
        assert(v1 === !v0 && v2 === v0, `${key}: ${v0} → ${v1} → ${v2}`);
        assert(stored === v1, `not persisted (${stored})`);
        if (extra !== null) assert(extra === v1, `renderer visibility ${extra} does not follow ${key}=${v1}`);
        assert(n >= 40, `turning ${label} ${v1 ? 'on' : 'off'} changed only ${n} pixels`);
        return `${n} pixels`;
      });
    }
    await check('Fit world button', async () => {
      await ev(() => window.__ui.centre(50, 50, 5));
      await page.locator('#sec-view button', { hasText: 'Fit world' }).click();
      await frames(2);
      const c = await ev(() => ({
        x: window.app.camera.x,
        y: window.app.camera.y,
        z: window.app.camera.zoom,
        W: window.app.sim.worldW,
        H: window.app.sim.worldH,
        vw: window.app.camera.viewW,
        vh: window.app.camera.viewH,
      }));
      approx(c.x, c.W / 2, 1, 'camera x');
      approx(c.z, Math.min(c.vw / c.W, c.vh / c.H) * 0.98, 0.01, 'zoom');
    });
    await check('minimap click moves the camera there', async () => {
      const mm = await ev(() => ({ ...window.app.renderer.minimapRect, c: window.__ui.canvasRect(), W: window.app.sim.worldW, H: window.app.sim.worldH }));
      assert(mm.visible, 'minimap hidden');
      await ev(() => window.__ui.centre(window.app.sim.worldW / 2, window.app.sim.worldH / 2, 3));
      await frames(2);
      await page.mouse.click(mm.c.x + mm.x + mm.w * 0.8, mm.c.y + mm.y + mm.h * 0.25);
      await sleep(600);
      const cam = await ev(() => ({ x: window.app.camera.x, y: window.app.camera.y }));
      approx(cam.x, mm.W * 0.8, mm.W * 0.03, 'camera x');
      approx(cam.y, mm.H * 0.25, mm.H * 0.04, 'camera y');
      return `camera → (${cam.x.toFixed(0)}, ${cam.y.toFixed(0)})`;
    });
    await check('minimap drag scrubs the camera', async () => {
      const mm = await ev(() => ({ ...window.app.renderer.minimapRect, c: window.__ui.canvasRect(), W: window.app.sim.worldW, H: window.app.sim.worldH }));
      await page.mouse.move(mm.c.x + mm.x + mm.w * 0.2, mm.c.y + mm.y + mm.h * 0.5);
      await page.mouse.down();
      await page.mouse.move(mm.c.x + mm.x + mm.w * 0.6, mm.c.y + mm.y + mm.h * 0.7, { steps: 5 });
      await page.mouse.up();
      await frames(2);
      const cam = await ev(() => ({ x: window.app.camera.x, y: window.app.camera.y }));
      approx(cam.x, mm.W * 0.6, mm.W * 0.03, 'camera x');
      approx(cam.y, mm.H * 0.7, mm.H * 0.04, 'camera y');
    });
    await check('mouse wheel zooms at the cursor', async () => {
      const c = await ev(() => window.__ui.canvasRect());
      await ev(() => window.__ui.centre(window.app.sim.worldW / 2, window.app.sim.worldH / 2, 1.5));
      await frames(2);
      const w0 = await ev(({ x, y }) => window.app.camera.screenToWorld(x, y), { x: c.w * 0.3, y: c.h * 0.4 });
      await page.mouse.move(c.x + c.w * 0.3, c.y + c.h * 0.4);
      await page.mouse.wheel(0, -300);
      await sleep(500);
      const r = await ev(({ x, y }) => ({ z: window.app.camera.zoom, w: window.app.camera.screenToWorld(x, y) }), { x: c.w * 0.3, y: c.h * 0.4 });
      assert(r.z > 1.6, `zoom ${r.z}`);
      approx(r.w.x, w0.x, 2, 'world x under the cursor');
      approx(r.w.y, w0.y, 2, 'world y under the cursor');
    });
  });

  // =================================================================== follow, keyboard
  await section('keyboard', async () => {
    await fresh('eden', 12345, 200);
    await page.locator('canvas.world').focus();
    await check('Space toggles pause', async () => {
      await page.keyboard.press('Space');
      assert((await ev(() => window.app.running)) === true, 'not running');
      await page.keyboard.press('Space');
      assert((await ev(() => window.app.running)) === false, 'not paused');
    });
    await check('“.” advances one tick', async () => {
      const t1 = await tick();
      await page.keyboard.press('.');
      await frames(3);
      assert((await tick()) === t1 + 1, `tick ${t1} → ${await tick()}`);
    });
    await check('“>” and “<” change speed', async () => {
      const i0 = await ev(() => window.app.speedIdx);
      await page.keyboard.press('>');
      const i1 = await ev(() => window.app.speedIdx);
      await page.keyboard.press('<');
      await page.keyboard.press('<');
      const i2 = await ev(() => window.app.speedIdx);
      assert(i1 === i0 + 1 && i2 === i0 - 1, `${i0} → ${i1} → ${i2}`);
      await page.locator('.seg.speed button').nth(2).click();
    });
    for (const [keys, dx, dy] of [
      [['KeyD', 'ArrowRight'], 1, 0],
      [['KeyA', 'ArrowLeft'], -1, 0],
      [['KeyS', 'ArrowDown'], 0, 1],
      [['KeyW', 'ArrowUp'], 0, -1],
    ]) {
      for (const key of keys) {
        await check(`${key} pans the camera`, async () => {
          await ev(() => window.__ui.centre(window.app.sim.worldW / 2, window.app.sim.worldH / 2, 2));
          const c0 = await ev(() => ({ x: window.app.camera.x, y: window.app.camera.y }));
          await page.keyboard.down(key);
          await sleep(300);
          await page.keyboard.up(key);
          const c1 = await ev(() => ({ x: window.app.camera.x, y: window.app.camera.y }));
          const mx = c1.x - c0.x;
          const my = c1.y - c0.y;
          assert(
            (dx ? Math.sign(mx) === dx && Math.abs(mx) > 20 : Math.abs(mx) < 1) && (dy ? Math.sign(my) === dy && Math.abs(my) > 20 : Math.abs(my) < 1),
            `moved (${mx.toFixed(1)}, ${my.toFixed(1)})`,
          );
        });
      }
    }
    await check('+ and − zoom in and out', async () => {
      await ev(() => window.__ui.centre(window.app.sim.worldW / 2, window.app.sim.worldH / 2, 2));
      await page.keyboard.press('+');
      await sleep(350);
      const z1 = await ev(() => window.app.camera.zoom);
      await page.keyboard.press('-');
      await page.keyboard.press('-');
      await sleep(350);
      const z2 = await ev(() => window.app.camera.zoom);
      approx(z1, 2.6, 0.05, 'zoom after +');
      approx(z2, 2 / 1.3, 0.05, 'zoom after −−');
    });
    await check('0 fits the world', async () => {
      await ev(() => window.__ui.centre(40, 40, 4));
      await page.keyboard.press('0');
      const c = await ev(() => ({ x: window.app.camera.x, W: window.app.sim.worldW, z: window.app.camera.zoom }));
      approx(c.x, c.W / 2, 1, 'camera x');
      assert(c.z < 1.5, `zoom ${c.z}`);
    });
    await check('F follows the selected agent (camera tracks), F again stops', async () => {
      const a = await ev(() => {
        const ag = window.__ui.isolatedAgent(6);
        window.app.select(ag.id);
        return ag.id;
      });
      await ev(() => window.__ui.centre(20, 20, 2));
      await page.locator('canvas.world').focus();
      await page.keyboard.press('f');
      assert((await ev(() => window.app.followId)) === a, 'followId not set');
      await page.keyboard.press('Space'); // run so the agent moves
      await sleep(1500);
      const d = await ev((id) => {
        const ag = window.app.sim.getAgent(id);
        return ag ? Math.hypot(ag.x - window.app.camera.x, ag.y - window.app.camera.y) : -1;
      }, a);
      await page.keyboard.press('Space');
      assert(d >= 0 && d < 12, `camera ${d.toFixed(1)} units from the followed agent`);
      await page.keyboard.press('f');
      assert((await ev(() => window.app.followId)) === -1, 'F did not stop following');
      return `camera within ${d.toFixed(1)} units`;
    });
    await check('“Follow selected” button follows', async () => {
      await page.locator('#sec-view button', { hasText: 'Follow selected' }).click();
      const st = await ev(() => ({ f: window.app.followId, s: window.app.view.selectedId }));
      assert(st.f !== -1 && st.f === st.s, JSON.stringify(st));
    });
    await check('panning stops following', async () => {
      await page.locator('canvas.world').focus();
      await page.keyboard.down('KeyD');
      await sleep(120);
      await page.keyboard.up('KeyD');
      assert((await ev(() => window.app.followId)) === -1, 'still following');
    });
    await check('Esc deselects and stops following', async () => {
      await ev(() => window.app.follow(window.app.view.selectedId));
      await page.keyboard.press('Escape');
      const st = await ev(() => ({ s: window.app.view.selectedId, f: window.app.followId }));
      assert(st.s === -1 && st.f === -1, JSON.stringify(st));
    });
    await check('Esc cancels the current tool (back to Inspect)', async () => {
      await page.keyboard.press('4');
      await page.keyboard.press('Escape');
      const t = await ev(() => window.app.tool.id);
      assert(t === 'inspect', `tool still ${t}`);
    });
    await check('H opens help, H closes it; ? opens it too', async () => {
      await page.keyboard.press('h');
      assert(await page.locator('.modal-back').isVisible(), 'H did not open help');
      await page.keyboard.press('h');
      assert(!(await page.locator('.modal-back').isVisible()), 'H did not close help');
      await page.keyboard.press('?');
      assert(await page.locator('.modal-back').isVisible(), '? did not open help');
      await page.keyboard.press('Escape');
    });
    await check('shortcuts are ignored while typing in a text box', async () => {
      await page.keyboard.press('2');
      const box = page.locator('.designer input[type=text]');
      await box.click();
      await page.keyboard.type('h 1 x');
      const st = await ev(() => ({ help: window.app.helpOpen, tool: window.app.tool.id, running: window.app.running }));
      assert(!st.help && st.tool === 'spawn' && !st.running, JSON.stringify(st));
      assert((await box.inputValue()) === 'h 1 x', 'typed text lost');
      await box.fill('');
      await page.keyboard.press('Escape'); // blurs the box
      await page.keyboard.press('1');
      assert((await ev(() => window.app.tool.id)) === 'inspect', 'shortcuts dead after leaving the text box');
    });
    await check('shortcuts keep working after clicking a button', async () => {
      await page.locator('#sec-view button', { hasText: 'Fit world' }).click();
      await page.keyboard.press('3');
      assert((await ev(() => window.app.tool.id)) === 'remove', 'key ignored after button click');
      await page.keyboard.press('1');
    });

    await check('shortcuts work after typing a seed and clicking Restart', async () => {
      await page.locator('.seed-input').fill('31337');
      await page.locator('.seed-row button', { hasText: 'Restart' }).click();
      await page.keyboard.press('2');
      const st = await ev(() => ({ tool: window.app.tool.id, box: document.querySelector('.seed-input').value, seed: window.app.sim.config.seed }));
      assert(st.seed === 31337, `restart used seed ${st.seed}`);
      assert(st.tool === 'spawn' && st.box === '31337', `key "2" went to the seed box (tool ${st.tool}, box "${st.box}")`);
      await page.keyboard.press('Escape');
    });
    await check('spawn tool: dragging pans instead of spawning', async () => {
      await page.keyboard.press('2');
      const c = await ev(() => ({ ...window.__ui.canvasRect(), cx: window.app.camera.x, next: window.app.sim.state.nextAgentId, t: window.app.sim.tick }));
      await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2);
      await page.mouse.down();
      await page.mouse.move(c.x + c.w / 2 + 90, c.y + c.h / 2, { steps: 5 });
      await page.mouse.up();
      await frames(3);
      const r = await ev(() => ({ cx: window.app.camera.x, next: window.app.sim.state.nextAgentId, t: window.app.sim.tick }));
      assert(r.cx < c.cx - 10, `camera did not pan (${c.cx} → ${r.cx})`);
      assert(r.next === c.next && r.t === c.t, 'a drag spawned agents');
    });
    await check('right-drag pans with a paint tool (no paint)', async () => {
      await page.keyboard.press('7');
      const c = await ev(() => ({ ...window.__ui.canvasRect(), cy: window.app.camera.y, log: window.app.sim.state.interventionLog.length, terrainV: window.app.sim.state.world.terrainVersion }));
      await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2 + 80, { steps: 5 });
      await page.mouse.up({ button: 'right' });
      await frames(3);
      const r = await ev(() => ({ cy: window.app.camera.y, log: window.app.sim.state.interventionLog.length, terrainV: window.app.sim.state.world.terrainVersion }));
      assert(r.cy < c.cy - 10, `camera did not pan (${c.cy} → ${r.cy})`);
      assert(r.log === c.log && r.terrainV === c.terrainV, 'right-drag painted');
      await page.keyboard.press('Escape');
    });
  });

  // =================================================================== inspector
  await section('inspector', async () => {
    await fresh('eden', 12345, 1500);
    const fam = await ev(() => {
      const sim = window.app.sim;
      const a = sim.state.agents.find((x) => x.children.some((c) => sim.getAgent(c))) || sim.state.agents.find((x) => x.relationships.some((r) => sim.getAgent(r.id)));
      return a && { id: a.id, name: a.name, x: a.x, y: a.y };
    });
    await check('select an agent → inspector shows it', async () => {
      assert(fam, 'no agent with living relatives');
      await page.keyboard.press('1');
      await ev((id) => window.app.select(id), fam.id);
      await frames(3);
      const st = await ev(() => ({
        name: document.querySelector('.insp-name')?.textContent,
        badge: document.querySelector('.insp-badge')?.textContent,
        meters: document.querySelectorAll('.insp-meter').length,
        genes: document.querySelectorAll('.insp-trait').length,
        utils: document.querySelectorAll('.insp-util').length,
      }));
      assert(st.name?.startsWith(fam.name) && st.badge === 'Alive', JSON.stringify(st));
      assert(st.meters >= 4 && st.genes === 12, JSON.stringify(st));
      return `${st.name}: ${st.genes} genes, ${st.utils} utilities`;
    });
    await check('clicking a relative switches the selection', async () => {
      const target = await ev(() => {
        const sim = window.app.sim;
        const btns = [...document.querySelectorAll('.pane-inspector button.insp-person')].filter((b) => window.__ui.visible(b) && !b.classList.contains('insp-dead'));
        return btns.length ? btns[0].textContent : null;
      });
      assert(target, 'no visible living relative link');
      await page.locator('.pane-inspector button.insp-person:not(.insp-dead)').filter({ hasText: target }).first().click();
      await frames(3);
      const st = await ev(() => ({ sel: window.app.view.selectedId, name: document.querySelector('.insp-name')?.textContent }));
      assert(st.sel !== fam.id && st.sel !== -1, `selection ${st.sel}`);
      assert(st.name?.startsWith(target.replace(' †', '')), `inspector shows ${st.name}, clicked ${target}`);
      return `→ ${st.name}`;
    });
    await check('Follow button', async () => {
      await page.locator('.pane-inspector .insp-btn', { hasText: 'Follow' }).click();
      const st = await ev(() => ({ f: window.app.followId, s: window.app.view.selectedId }));
      assert(st.f === st.s && st.f !== -1, JSON.stringify(st));
      await ev(() => window.app.stopFollow());
    });
    await check('Feed & heal raises health and food', async () => {
      const before = await ev(() => {
        const a = window.app.sim.getAgent(window.app.view.selectedId);
        a.food = a.traits.maxFood * 0.3; // make the effect observable
        a.health = a.traits.maxHealth * 0.5;
        return { food: a.food, hp: a.health, t: window.app.sim.tick };
      });
      await page.locator('.pane-inspector .insp-btn', { hasText: 'Feed & heal' }).click();
      await waitTick(before.t + 1);
      const r = await ev(() => {
        const a = window.app.sim.getAgent(window.app.view.selectedId);
        return { food: a.food, max: a.traits.maxFood, hp: a.health, maxHp: a.traits.maxHealth };
      });
      assert(r.food > before.food && r.food >= r.max * 0.97 && r.hp >= r.maxHp * 0.97, JSON.stringify(r));
      await sleep(400);
      const meter = await page.locator('.pane-inspector .insp-m-health .insp-meter-val').textContent();
      assert(meter.startsWith(String(Math.round(r.hp))) || meter.includes('/'), `health meter "${meter}"`);
    });
    await check('Smite kills; inspector shows the death', async () => {
      const t0 = await tick();
      const id = await ev(() => window.app.view.selectedId);
      await page.locator('.pane-inspector .insp-btn', { hasText: 'Smite' }).click();
      await waitTick(t0 + 1);
      await sleep(400);
      const st = await ev(
        (id) => ({
          alive: !!window.app.sim.getAgent(id),
          badge: document.querySelector('.insp-badge')?.textContent,
          banner: document.querySelector('.insp-death')?.textContent,
          disabled: [...document.querySelectorAll('.insp-btn')].every((b) => b.disabled),
        }),
        id,
      );
      assert(!st.alive && st.badge === 'Dead' && /Died/.test(st.banner ?? '') && st.disabled, JSON.stringify(st));
    });
    await check('inspector sections collapse and expand', async () => {
      const sum = page.locator('.pane-inspector summary').first();
      const open0 = await sum.evaluate((s) => s.parentElement.open);
      await sum.click();
      const open1 = await sum.evaluate((s) => s.parentElement.open);
      await sum.click();
      assert(open1 === !open0, 'details did not toggle');
    });
  });

  // =================================================================== stats & events
  await section('stats', async () => {
    await page.locator('.tab', { hasText: 'Stats' }).click();
    await frames(4);
    await check('KPI tiles show live numbers', async () => {
      const st = await ev(() => [...document.querySelectorAll('.an-kpi')].map((k) => ({ l: k.querySelector('.an-kpi-label').textContent, v: k.querySelector('.an-kpi-value').textContent })));
      const popTile = st.find((k) => k.l === 'Population');
      const n = await pop();
      assert(st.length === 8 && popTile && Number(popTile.v.replace(/[^0-9.]/g, '')) > 0, JSON.stringify(st));
      assert(Math.abs(Number(popTile.v) - n) <= Math.max(3, n * 0.02) || /k$/.test(popTile.v), `population tile ${popTile.v} vs ${n}`);
      return st.map((k) => `${k.l}=${k.v}`).join(', ');
    });
    await check('charts render real data', async () => {
      const r = await ev(() => {
        const out = [];
        for (const c of document.querySelectorAll('.pane-stats canvas.an-chart-base')) {
          if (!window.__ui.visible(c)) continue;
          const s = window.__ui.canvasStats(c);
          out.push(s.opaque);
        }
        return out;
      });
      const drawn = r.filter((o) => o > 0.02).length;
      assert(r.length >= 8 && drawn >= r.length - 1, `${drawn}/${r.length} visible charts have content`);
      return `${drawn}/${r.length} charts drawn`;
    });
    for (const label of ['20 d', '5 d', '1 d', 'All']) {
      await check(`range ${label}`, async () => {
        const b = page.locator('.an-toolbar .an-seg', { hasText: label });
        await b.click();
        await frames(2);
        assert((await b.getAttribute('aria-pressed')) === 'true', 'not pressed');
      });
    }
    await check('every gene chip and gene-mean cell selects its gene', async () => {
      const names = await page.locator('.an-chips .an-chip').allTextContents();
      assert(names.length === 12, `${names.length} gene chips`);
      for (let i = 0; i < names.length; i++) {
        await page.locator('.an-chips .an-chip').nth(i).click();
        const st = await ev(
          (i) => ({
            desc: document.querySelector('.an-gene-desc').textContent,
            pressed: document.querySelectorAll('.an-chips .an-chip')[i].getAttribute('aria-pressed'),
            cell: document.querySelectorAll('.an-multi-cell')[i].classList.contains('an-on'),
          }),
          i,
        );
        assert(st.desc.startsWith(names[i]) && st.pressed === 'true' && st.cell, `${names[i]}: ${JSON.stringify(st)}`);
      }
      await page.locator('.an-multi-cell').nth(4).click();
      const d = await page.locator('.an-gene-desc').textContent();
      assert(d.startsWith(names[4]), `multi cell → ${d}`);
    });
    await check('every stats section collapses and expands', async () => {
      const n = await page.locator('.pane-stats summary.an-sec-title').count();
      for (let i = 0; i < n; i++) {
        const sum = page.locator('.pane-stats summary.an-sec-title').nth(i);
        await sum.click();
        const closed = await sum.evaluate((s) => !s.parentElement.open);
        await sum.click();
        const open = await sum.evaluate((s) => s.parentElement.open);
        assert(closed && open, `section ${i} did not toggle`);
      }
      await frames(3);
      const blank = await ev(() => [...document.querySelectorAll('.pane-stats canvas.an-chart-base')].filter((c) => window.__ui.visible(c) && window.__ui.canvasStats(c).opaque < 0.02).length);
      assert(blank <= 1, `${blank} charts blank after re-opening their sections`);
      return `${n} sections`;
    });
    await check('chart hover shows a tooltip', async () => {
      const chart = page.locator('.pane-stats .an-chart').first();
      await chart.scrollIntoViewIfNeeded();
      const box = await chart.boundingBox();
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
      await frames(2);
      const tip = await page.locator('.pane-stats .an-tip').first();
      assert(await tip.isVisible(), 'no tooltip');
      await page.mouse.move(5, 5);
    });
  });
  await section('events', async () => {
    await check('Events tab lists events and clears its badge', async () => {
      await page.locator('.tab', { hasText: 'Events' }).click();
      await sleep(320); // the badge is refreshed with the panels (4 Hz)
      const st = await ev(() => ({ rows: document.querySelectorAll('.ev-row').length, events: window.app.sim.state.events.length, badge: document.querySelector('.tab-badge').textContent }));
      assert(st.rows > 0 && st.rows <= Math.max(st.events, 300) && st.badge === '', JSON.stringify(st));
      return `${st.rows} rows`;
    });
    await check('filter chip hides and shows a category', async () => {
      const chip = page.locator('.ev-chip', { hasText: 'You' });
      await chip.click();
      const hidden = await ev(() => [...document.querySelectorAll('.ev-row.ev-c-intervention')].every((r) => getComputedStyle(r).display === 'none'));
      const n = await page.locator('.ev-row.ev-c-intervention').count();
      assert(n > 0 && hidden && (await chip.getAttribute('aria-pressed')) === 'false', `rows ${n}, hidden ${hidden}`);
      await chip.click();
      const shown = await ev(() => [...document.querySelectorAll('.ev-row.ev-c-intervention')].some((r) => getComputedStyle(r).display !== 'none'));
      assert(shown, 'rows not shown again');
    });
    await check('event rows are dated like the top-bar clock', async () => {
      await page.locator('#sec-global .gev-btn', { hasText: 'Abundance' }).click();
      await sleep(350);
      const st = await ev(() => ({ clock: window.app.el.clock.textContent, row: document.querySelector('.ev-row .ev-time')?.textContent ?? '', msg: document.querySelector('.ev-row .ev-msg')?.textContent ?? '' }));
      const clockDay = /Day (\d+)/.exec(st.clock)?.[1];
      const rowDay = /Day (\d+)/.exec(st.row)?.[1];
      assert(clockDay && clockDay === rowDay, `clock "${st.clock}" but the event just logged is dated "${st.row}" (${st.msg.slice(0, 40)})`);
      return `${st.row} — ${st.msg.slice(0, 50)}`;
    });
    await check('every category chip toggles its rows', async () => {
      const n = await page.locator('.ev-chip:not(.ev-chip-all)').count();
      for (let i = 0; i < n; i++) {
        const chip = page.locator('.ev-chip:not(.ev-chip-all)').nth(i);
        await chip.click();
        const st = await ev((i) => {
          const btn = document.querySelectorAll('.ev-chip:not(.ev-chip-all)')[i];
          const cat = [...btn.classList].find((c) => c.startsWith('ev-c-')).slice(5);
          const list = document.querySelector('.ev-list');
          const rows = [...document.querySelectorAll(`.ev-row.ev-c-${cat}`)];
          return {
            cat,
            pressed: btn.getAttribute('aria-pressed'),
            hiddenClass: list.classList.contains(`ev-hide-${cat}`),
            visibleRows: rows.filter((r) => getComputedStyle(r).display !== 'none').length,
          };
        }, i);
        await chip.click();
        assert(st.pressed === 'false' && st.hiddenClass && st.visibleRows === 0, JSON.stringify(st));
      }
      const pressed = await ev(() => [...document.querySelectorAll('.ev-chip')].every((b) => b.getAttribute('aria-pressed') === 'true'));
      assert(pressed, 'chips not restored');
      return `${n} chips`;
    });
    await check('“All” chip hides all, then shows all', async () => {
      const all = page.locator('.ev-chip-all');
      await all.click();
      const vis1 = await ev(() => [...document.querySelectorAll('.ev-row')].filter((r) => getComputedStyle(r).display !== 'none').length);
      await all.click();
      const vis2 = await ev(() => [...document.querySelectorAll('.ev-row')].filter((r) => getComputedStyle(r).display !== 'none').length);
      assert(vis1 === 0 && vis2 > 0, `${vis1} / ${vis2}`);
    });
    await check('double-click a chip shows only that category', async () => {
      await page.locator('.ev-chip', { hasText: 'You' }).dblclick();
      const other = await ev(() => [...document.querySelectorAll('.ev-row:not(.ev-c-intervention)')].filter((r) => getComputedStyle(r).display !== 'none').length);
      const mine = await ev(() => [...document.querySelectorAll('.ev-row.ev-c-intervention')].filter((r) => getComputedStyle(r).display !== 'none').length);
      await page.locator('.ev-chip-all').click();
      assert(other === 0 && mine > 0, `${other} other rows visible, ${mine} intervention rows`);
    });
    await check('clicking an event jumps the camera to it', async () => {
      const row = page
        .locator('.ev-row.ev-jump')
        .filter({ has: page.locator('.ev-pin') })
        .first();
      const id = Number(await row.getAttribute('data-id'));
      const e = await ev((id) => window.app.sim.state.events.find((x) => x.id === id), id);
      await ev(() => window.__ui.centre(5, 5, 2));
      await row.click();
      await sleep(600);
      const cam = await ev(() => ({ x: window.app.camera.x, y: window.app.camera.y }));
      approx(cam.x, e.x, 3, 'camera x');
      approx(cam.y, e.y, 3, 'camera y');
      return e.message;
    });
    await check('new events badge the Events tab when it is hidden', async () => {
      await page.locator('.tab', { hasText: 'Stats' }).click();
      await page.locator('#sec-global .gev-btn', { hasText: 'Abundance' }).click();
      await sleep(400);
      const badge = await page.locator('.tab-badge').textContent();
      assert(Number(badge) >= 1, `badge "${badge}"`);
    });
  });

  // =================================================================== parameters
  await section('parameters', async () => {
    await fresh('eden', 12345, 30);
    const specs = await ev(() =>
      [...document.querySelectorAll('#sec-params .ctl-slider')].map((el) => {
        const i = el.querySelector('input');
        return { label: el.querySelector('.ctl-label').textContent, min: Number(i.min), max: Number(i.max), step: Number(i.step), value: Number(i.value) };
      }),
    );
    const KEYS = {
      'Mutation rate': 'mutationRate',
      'Mutation size': 'mutationSize',
      'Reproduction rate': 'reproductionRate',
      'Plant regrowth': 'foodRegen',
      'Food capacity': 'foodCapacity',
      'Environmental harshness': 'difficulty',
      'Random disasters': 'disasterRate',
      'Disease virulence': 'diseaseVirulence',
      'Aggression bias': 'aggressionBias',
      'Cooperation bias': 'cooperationBias',
      'Mate compatibility': 'mateCompatibility',
      'Population cap': 'maxAgents',
    };
    await check('every runtime parameter has a slider', async () => {
      const missing = Object.keys(KEYS).filter((l) => !specs.some((s) => s.label === l));
      assert(!missing.length && specs.length === 12, `missing ${missing}`);
    });
    for (const s of specs) {
      await check(`slider ${s.label}`, async () => {
        const key = KEYS[s.label];
        const cur = await ev((k) => window.app.sim.config[k], key);
        approx(s.value, cur, 1e-9, 'slider shows the config value');
        const steps = Math.round((s.max - s.min) / s.step);
        const v = Number((s.min + s.step * Math.round(steps * (cur > (s.min + s.max) / 2 ? 0.2 : 0.8))).toFixed(6));
        const t0 = await tick();
        await setRange(slider('#sec-params', s.label), v);
        await waitTick(t0 + 1);
        await sleep(300); // sync() must not snap the slider back
        const r = await ev((k) => window.app.sim.config[k], key);
        approx(r, v, 1e-9, `sim.config.${key}`);
        approx(Number(await slider('#sec-params', s.label).inputValue()), v, 1e-9, 'slider position after sync');
        const logged = await ev(() => window.app.sim.state.interventionLog.at(-1).intervention);
        assert(logged.kind === 'setConfig' && Math.abs(logged.patch[key] - v) < 1e-9, `logged ${JSON.stringify(logged)}`);
        return `${key} ${cur} → ${r}`;
      });
    }
    await check('mouse-dragging a parameter slider applies the released value', async () => {
      const s = slider('#sec-params', 'Plant regrowth');
      await s.scrollIntoViewIfNeeded();
      const box = await s.boundingBox();
      const t0 = await tick();
      await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await waitTick(t0 + 1);
      await sleep(300);
      const v = await ev(() => window.app.sim.config.foodRegen);
      approx(v, 1.5, 0.08, 'foodRegen after dragging to the middle');
    });
    for (const [label, key] of [
      ['Overgrazing', 'overgrazing'],
      ['Seasons', 'seasons'],
      ['Day / night', 'dayNight'],
      ['Tribes', 'tribesEnabled'],
    ]) {
      await check(`toggle ${label}`, async () => {
        const v0 = await ev((k) => window.app.sim.config[k], key);
        const t0 = await tick();
        await toggleCtl('#sec-params', label).click();
        await waitTick(t0 + 1);
        await sleep(300);
        const v1 = await ev((k) => window.app.sim.config[k], key);
        assert(v1 === !v0, `${key} ${v0} → ${v1}`);
        const checked = await toggleCtl('#sec-params', label).locator('input').isChecked();
        assert(checked === v1, `switch shows ${checked}`);
      });
    }
    await check('“Reset to experiment defaults” restores every parameter', async () => {
      const t0 = await tick();
      await page.locator('#sec-params button', { hasText: 'Reset to experiment defaults' }).click();
      await waitTick(t0 + 1);
      await sleep(300);
      const r = await ev(() => {
        const app = window.app;
        const base = app.scenarioConfig();
        const diff = [];
        for (const k of Object.keys(base)) if (base[k] !== app.sim.config[k]) diff.push(`${k}: ${app.sim.config[k]} ≠ ${base[k]}`);
        const sliders = [...document.querySelectorAll('#sec-params .ctl-slider input')].map((i) => Number(i.value));
        return { diff, sliders };
      });
      assert(!r.diff.length, r.diff.join('; '));
    });
  });

  // =================================================================== experiments
  await section('experiments', async () => {
    await ev(() => window.app.setPaused(true));
    for (const id of scenarioIds) {
      await check(`start ${id}`, async () => {
        const name = await ev((id) => window.__names[id], id);
        await page.locator('.exp-btn', { hasText: name }).click();
        const detail = await page.locator('.exp-detail-name').textContent();
        assert(detail === name, `detail shows ${detail}`);
        await page.locator('.exp-detail .btn.primary').click();
        await frames(2);
        const st = await ev(() => ({
          id: window.app.sim.state.scenarioId,
          tick: window.app.sim.tick,
          top: window.app.el.expName.textContent,
          running: document.querySelector('.exp-btn.running')?.textContent ?? '',
          n: window.app.sim.state.agents.length,
        }));
        assert(st.id === id && st.top === name && st.running.includes(name), JSON.stringify(st));
        assert(st.tick <= 2 && st.n > 0, `tick ${st.tick}, ${st.n} agents`);
        return `${name}: ${st.n} agents`;
      });
    }
    let hashA = '';
    await check('Restart (seed box) reproduces the same hash', async () => {
      await page.locator('.exp-btn', { hasText: 'Garden of Eden' }).click();
      await page.locator('.exp-detail .btn.primary').click();
      await page.locator('.seed-input').fill('4242');
      await page.locator('.seed-row button', { hasText: 'Restart' }).click();
      assert((await ev(() => window.app.sim.config.seed)) === 4242, 'seed not applied');
      hashA = await stepN(90);
      await page.locator('.seed-row button', { hasText: 'Restart' }).click();
      assert((await tick()) === 0, 'restart did not reset the tick');
      const hashB = await stepN(90);
      assert(hashA === hashB, `${hashA} ≠ ${hashB}`);
      return hashA;
    });
    await check('New seed (dice) changes the world and the hash', async () => {
      await page.getByRole('button', { name: 'New seed' }).click();
      const seed = await ev(() => window.app.sim.config.seed);
      assert(seed !== 4242, 'seed unchanged');
      assert((await page.locator('.seed-input').inputValue()) === String(seed), 'seed box not updated');
      const h = await stepN(90);
      assert(h !== hashA, 'hash unchanged');
      return `seed ${seed}`;
    });
    await check('Replay my interventions reproduces the intervention run', async () => {
      await page.locator('.seed-input').fill('777');
      await page.locator('.seed-row button', { hasText: 'Restart' }).click();
      const step = page.getByRole('button', { name: 'Step one tick' });
      for (let i = 0; i < 5; i++) await step.click();
      await page.keyboard.press('2');
      const g = await ev(() => window.__ui.findTerrain(3, 4, undefined, undefined, 50));
      let t = await tick();
      await clickWorld(g.x, g.y);
      await waitTick(t + 1);
      for (let i = 0; i < 3; i++) await step.click();
      await page.keyboard.press('7');
      await page.locator('.terrain-pick .chip', { hasText: 'Wall' }).click();
      t = await tick();
      await clickWorld(g.x + 60, g.y);
      await waitTick(t + 1);
      t = await tick();
      await setRange(slider('#sec-params', 'Plant regrowth'), 2);
      await waitTick(t + 1);
      t = await tick();
      await page.locator('#sec-global .gev-btn', { hasText: 'Drought' }).click();
      await waitTick(t + 1);
      await page.keyboard.press('4');
      t = await tick();
      await clickWorld(g.x - 50, g.y + 20);
      await waitTick(t + 1);
      await page.keyboard.press('1');
      const log = await ev(() => window.app.sim.state.interventionLog.length);
      const cur = await tick();
      const hRun = await stepN(120 - cur);
      const replayBtn = page.locator('#sec-experiments button', { hasText: 'Replay my interventions' });
      assert((await replayBtn.textContent()).includes(`(${log})`), `button label "${await replayBtn.textContent()}"`);
      await replayBtn.click();
      assert((await tick()) === 0, 'replay did not restart');
      const hReplay = await stepN(120);
      assert(hRun === hReplay, `run ${hRun} ≠ replay ${hReplay} (${log} interventions)`);
      return `${log} interventions, hash ${hRun}`;
    });
    await check('Replay warns when the intervention log was truncated', async () => {
      const st = await ev(() => {
        const app = window.app;
        for (let k = 0; k <= 5000; k++) app.sim.enqueue({ kind: 'fertilize', x: 100, y: 100, radius: 4, amount: 0.0001 }); // fills the capped log
        app.stepOnce();
        return { dropped: app.sim.state.interventionLogDropped ?? null, log: app.sim.state.interventionLog.length };
      });
      if (st.dropped === null) throw new Skip('this build does not track dropped log entries');
      assert(st.dropped > 0, `nothing dropped (${JSON.stringify(st)})`);
      await sleep(300);
      await page.locator('#sec-experiments button', { hasText: 'Replay my interventions' }).click();
      const t = page.locator('.toast-bad', { hasText: 'Replay is incomplete' });
      await t.first().waitFor({ timeout: 2000 });
      return `${st.dropped} dropped → warning shown`;
    });
    await check('Replay button is disabled without interventions', async () => {
      await page.locator('.seed-row button', { hasText: 'Restart' }).click();
      assert(await page.locator('#sec-experiments button', { hasText: 'Replay my interventions' }).isDisabled(), 'enabled');
    });
  });

  // =================================================================== save / load
  await section('save/load', async () => {
    await fresh('eden', 12345, 0);
    // a run with a few UI interventions, so the save carries an intervention log
    {
      await stepN(20);
      await page.keyboard.press('4');
      const g = await ev(() => window.__ui.findTerrain(3, 3));
      let t = await tick();
      await clickWorld(g.x, g.y);
      await waitTick(t + 1);
      await stepN(30);
      t = await tick();
      await page.locator('#sec-global .gev-btn', { hasText: 'Blight' }).click();
      await waitTick(t + 1);
      await page.keyboard.press('Escape');
      await stepN(300 - (await tick()));
    }
    let savedPath = '';
    let saved = null;
    await check('Save experiment downloads valid JSON', async () => {
      const st = await ev(() => ({ tick: window.app.sim.tick, hash: window.app.sim.hash(), n: window.app.sim.state.agents.length }));
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.locator('#sec-io button', { hasText: 'Save experiment' }).click()]);
      savedPath = join(tmp, dl.suggestedFilename());
      await dl.saveAs(savedPath);
      const json = JSON.parse(readFileSync(savedPath, 'utf8'));
      assert(json && typeof json === 'object', 'not an object');
      const state = json.state ?? json;
      assert(JSON.stringify(json).length > 1000, 'file too small');
      saved = { ...st, name: dl.suggestedFilename(), keys: Object.keys(json).slice(0, 8), stateTick: state.tick };
      assert(dl.suggestedFilename().endsWith('.json') && dl.suggestedFilename().includes(`t${st.tick}`), dl.suggestedFilename());
      return `${dl.suggestedFilename()} (${(readFileSync(savedPath).length / 1024).toFixed(0)} kB)`;
    });
    await check('Load… restores the saved state (tick and hash)', async () => {
      assert(savedPath, 'no save file');
      const contHash = await stepN(40);
      await stepN(25);
      await page.locator('#sec-io input[type=file]').setInputFiles(savedPath);
      await waitFor((t) => window.app.sim.tick === t, saved.tick);
      const st = await ev(() => ({ tick: window.app.sim.tick, hash: window.app.sim.hash() }));
      assert(st.tick === saved.tick && st.hash === saved.hash, `loaded tick ${st.tick} hash ${st.hash}, saved ${saved.tick} ${saved.hash}`);
      const after = await stepN(40);
      assert(after === contHash, 'continuing after load diverges from the original run');
      await page.locator('.toast-good').last().waitFor({ timeout: 2000 });
      return `tick ${st.tick}, hash ${st.hash}`;
    });
    await check('Replay after loading reproduces the saved state', async () => {
      const log = await ev(() => window.app.sim.state.interventionLog.length);
      assert(log >= 2, `save has ${log} interventions`);
      await page.locator('#sec-experiments button', { hasText: 'Replay my interventions' }).click();
      assert((await tick()) === 0, 'replay did not restart');
      const h = await stepN(saved.tick);
      assert(h === saved.hash, `replayed hash ${h} ≠ saved ${saved.hash}`);
      return `${log} interventions replayed to tick ${saved.tick}`;
    });
    await check('“Load…” button opens the file chooser and loads the file', async () => {
      await stepN(10);
      const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.locator('#sec-io button', { hasText: 'Load…' }).click()]);
      await fc.setFiles(savedPath);
      await waitFor((t) => window.app.sim.tick === t, saved.tick);
      assert((await ev(() => window.app.sim.hash())) === saved.hash, 'hash differs after loading through the chooser');
    });
    await check('loading an invalid file shows an error and keeps running', async () => {
      const bad = join(tmp, 'broken.json');
      writeFileSync(bad, '{"version": 999, "nope": true');
      const t0 = await tick();
      await page.locator('#sec-io input[type=file]').setInputFiles(bad);
      await page.locator('.toast-error').last().waitFor({ timeout: 3000 });
      const msg = await page.locator('.toast-error').last().textContent();
      await ev(() => window.app.setPaused(false));
      await sleep(400);
      const t1 = await tick();
      await ev(() => window.app.setPaused(true));
      assert(t1 > t0 + 3, 'app stopped');
      const bad2 = join(tmp, 'wrong-version.json');
      writeFileSync(bad2, JSON.stringify({ version: 999, state: {} }));
      await page.locator('#sec-io input[type=file]').setInputFiles(bad2);
      await sleep(300);
      assert((await page.locator('.toast-error').count()) >= 1, 'no error toast for a wrong version');
      return msg.slice(0, 90);
    });
    await check('dropping a save file on the window loads it', async () => {
      const text = readFileSync(savedPath, 'utf8');
      await ev((text) => {
        const dt = new DataTransfer();
        dt.items.add(new File([text], 'dropped.json', { type: 'application/json' }));
        window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
        const shown = document.querySelector('.drop').classList.contains('show');
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        if (!shown) throw new Error('drop overlay not shown on dragenter');
      }, text);
      await waitFor((t) => window.app.sim.tick === t, saved.tick);
      assert(!(await ev(() => document.querySelector('.drop').classList.contains('show'))), 'drop overlay stuck');
    });
    await check('Ctrl+S saves, Ctrl+O opens the file chooser', async () => {
      await page.locator('canvas.world').focus();
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.keyboard.press('Control+s')]);
      assert(dl.suggestedFilename().endsWith('.json'), dl.suggestedFilename());
      const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.keyboard.press('Control+o')]);
      await fc.setFiles(savedPath);
      await waitFor((t) => window.app.sim.tick === t, saved.tick);
    });
  });

  // =================================================================== sections
  await section('sidebar', async () => {
    for (const id of ['tool', 'global', 'experiments', 'view', 'params', 'io']) {
      await check(`section ${id} collapses and expands`, async () => {
        const head = page.locator(`#sec-${id} > .sec-head`);
        await head.click();
        const a = await ev((id) => ({ open: document.querySelector(`#sec-${id}`).classList.contains('open'), body: getComputedStyle(document.querySelector(`#sec-${id} .sec-body`)).display }), id);
        await head.click();
        const b = await ev((id) => ({ open: document.querySelector(`#sec-${id}`).classList.contains('open'), body: getComputedStyle(document.querySelector(`#sec-${id} .sec-body`)).display }), id);
        assert(!a.open && a.body === 'none' && b.open && b.body !== 'none', `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
      });
    }
    await check('tooltips appear on hover', async () => {
      await page.locator('.play-btn').hover();
      await sleep(500);
      const tip = await ev(() => ({ show: document.querySelector('.tip').classList.contains('show'), text: document.querySelector('.tip').textContent }));
      assert(tip.show && /pause/i.test(tip.text), JSON.stringify(tip));
      await page.mouse.move(700, 500);
    });
    await check('toasts are dismissed on click', async () => {
      await page.locator('#sec-global .gev-btn', { hasText: 'Drought' }).click();
      const toast = page.locator('.toast:not(.out)').last();
      const text = await toast.textContent();
      await toast.click();
      await sleep(350);
      const still = await page.locator('.toast', { hasText: text }).count();
      assert(still === 0, `clicked toast “${text.slice(0, 40)}” still shown`);
    });

    await check('no console errors in the main session', async () => {
      const errs = pageErrors.filter((e) => e.startsWith('[main]'));
      assert(!errs.length, errs.join(' | '));
    });
  });
  await context.close();

  // =================================================================== layout & contrast
  for (const [w, hgt] of [
    [1280, 720],
    [1440, 900],
    [1920, 1080],
  ]) {
    await section(`layout ${w}×${hgt}`, async () => {
      const { ctx, p } = await openPage(w, hgt, `layout-${w}`);
      page = p;
      await ev(() => window.app.setPaused(true));
      const states = [
        ['default', async () => {}],
        [
          'spawn tool + inspector',
          async () => {
            await page.keyboard.press('2');
            await ev(() => {
              const a = window.app.sim.state.agents[0];
              window.app.select(a.id);
              window.app.follow(a.id);
            });
            await page.locator('.seg.speed button').nth(2).click();
          },
        ],
        [
          'terrain tool + events tab + cursor bar',
          async () => {
            await page.keyboard.press('7');
            await page.locator('.tab', { hasText: 'Events' }).click();
            await ev(() => window.app.setOverlay('territory'));
            const c = await ev(() => window.__ui.canvasRect());
            await page.mouse.move(c.x + c.w * 0.45, c.y + c.h * 0.6); // shows the bottom status bar
          },
        ],
        [
          'disaster tool + help',
          async () => {
            await page.keyboard.press('8');
            await ev(() => window.app.setOverlay('disease'));
            await page.keyboard.press('h');
          },
        ],
      ];
      for (const [label, setup] of states) {
        await check(label, async () => {
          await setup();
          await sleep(350);
          await frames(3);
          const issues = await ev(() => {
            const out = [];
            const de = document.documentElement;
            if (de.scrollWidth > window.innerWidth + 1 || document.body.scrollWidth > window.innerWidth + 1) out.push(`horizontal page overflow ${de.scrollWidth}px > ${window.innerWidth}px`);
            if (de.scrollHeight > window.innerHeight + 1) out.push(`vertical page overflow ${de.scrollHeight}px`);
            const vis = window.__ui.visible;
            for (const sc of document.querySelectorAll('.sidebar.left, .pane.on, .modal')) {
              if (vis(sc) && sc.scrollWidth > sc.clientWidth + 1) out.push(`${sc.className} scrolls horizontally (${sc.scrollWidth} > ${sc.clientWidth})`);
            }
            const name = (el) =>
              `${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className)
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .join('.')}${el.textContent?.trim() ? ` “${el.textContent.trim().slice(0, 24)}”` : ''}`;
            const clipper = (el) => {
              for (let e = el.parentElement; e; e = e.parentElement) {
                const cs = getComputedStyle(e);
                if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') return e;
              }
              return null;
            };
            const sel =
              'button, input:not([type=file]):not([type=checkbox]), select, label.ctl-toggle, summary, .tool-hud, .keys-hint, .hud-pill, .cursor-info.show, .exp-chip, .clock, .tb-stat, .perf';
            const els = [...document.querySelectorAll(sel)].filter((e) => vis(e) && !e.closest('.toasts') && !e.closest('.tip'));
            const modalOpen = !!document.querySelector('.modal-back.show');
            for (const e of els) {
              if (modalOpen && !e.closest('.modal')) continue;
              const r = e.getBoundingClientRect();
              if (r.left < -0.5 || r.right > window.innerWidth + 0.5) out.push(`${name(e)} outside the window (${Math.round(r.left)}–${Math.round(r.right)})`);
              const c = clipper(e);
              if (c) {
                const cr = c.getBoundingClientRect();
                const cs = getComputedStyle(c);
                // horizontal clipping only (vertical clipping inside scroll panes is scrolling)
                if (cs.overflowX !== 'visible' && (r.left < cr.left - 0.5 || r.right > cr.right + 0.5) && !c.matches('.exp-chip'))
                  out.push(`${name(e)} clipped by ${name(c).slice(0, 40)} (${Math.round(r.left)}–${Math.round(r.right)} vs ${Math.round(cr.left)}–${Math.round(cr.right)})`);
              }
            }
            // overlaps between sibling-level controls
            const boxes = els.filter((e) => !(modalOpen && !e.closest('.modal'))).map((e) => ({ e, r: e.getBoundingClientRect() }));
            for (let i = 0; i < boxes.length; i++) {
              for (let j = i + 1; j < boxes.length; j++) {
                const a = boxes[i];
                const b = boxes[j];
                if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
                // content legitimately scrolls underneath sticky section headers
                if (a.e.matches('.sec-head') || b.e.matches('.sec-head')) continue;
                const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
                const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
                if (ix > 1 && iy > 1) {
                  // only report overlaps that are actually on screen (not scrolled away inside a pane)
                  const sa = clipper(a.e)?.getBoundingClientRect();
                  const inView = (r, s) => !s || (r.bottom > s.top && r.top < s.bottom);
                  if (inView(a.r, sa) && inView(b.r, clipper(b.e)?.getBoundingClientRect())) out.push(`${name(a.e)} overlaps ${name(b.e)} (${Math.round(ix)}×${Math.round(iy)} px)`);
                }
              }
            }
            // truncated control labels (ellipsis): taglines are allowed to truncate
            for (const e of document.querySelectorAll(
              '.ctl-label, .chip > span:last-child, .gev-btn > span:last-child, .btn, .tab, .sec-title, .exp-btn-name, .an-chip, .ev-chip, .insp-btn, .an-seg, .rail-btn',
            )) {
              if (!vis(e) || (modalOpen && !e.closest('.modal'))) continue;
              const cs = getComputedStyle(e);
              if ((cs.textOverflow === 'ellipsis' || cs.overflow === 'hidden') && e.scrollWidth > e.clientWidth + 1) out.push(`truncated text ${name(e)} (${e.scrollWidth} > ${e.clientWidth})`);
            }
            // canvas-drawn HUD (minimap, legend) vs DOM HUD
            const c = window.__ui.canvasRect();
            const canvasBoxes = [];
            const mm = window.app.renderer.minimapRect;
            if (mm && mm.visible) canvasBoxes.push(['minimap', { left: c.x + mm.x - 4, top: c.y + mm.y - 4, right: c.x + mm.x + mm.w + 4, bottom: c.y + mm.y + mm.h + 4 }]);
            const lg = window.app.renderer.legendRect;
            if (lg && lg.visible) canvasBoxes.push(['overlay legend', { left: c.x + lg.x, top: c.y + lg.y, right: c.x + lg.x + lg.w, bottom: c.y + lg.y + lg.h }]);
            const hud = [...document.querySelectorAll('.keys-hint, .cursor-info, .rail, .tool-hud, .hud-pill')].filter(vis);
            for (const [nm, r] of canvasBoxes) {
              for (const e of hud) {
                const b = e.getBoundingClientRect();
                const ix = Math.min(r.right, b.right) - Math.max(r.left, b.left);
                const iy = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
                if (ix > 0 && iy > 0) out.push(`${nm} (canvas) sits under ${name(e)}`);
              }
              if (r.left < c.x || r.right > c.x + c.w || r.top < c.y || r.bottom > c.y + c.h) out.push(`${nm} outside the canvas`);
            }
            if (canvasBoxes.length === 2) {
              const [a, b] = canvasBoxes.map((x) => x[1]);
              if (Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)) out.push('minimap overlaps the overlay legend');
            }
            return [...new Set(out)];
          });
          if (shotsDir) {
            mkdirSync(shotsDir, { recursive: true });
            await page.screenshot({ path: join(shotsDir, `layout-${w}x${hgt}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`) });
          }
          assert(!issues.length, issues.slice(0, 12).join('; ') + (issues.length > 12 ? ` (+${issues.length - 12} more)` : ''));
        });
      }
      await check('opening sidebar sections never scrolls the page', async () => {
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        const bad = [];
        for (const id of ['io', 'params', 'view', 'experiments', 'global', 'tool']) {
          await ev((id) => window.app.left.openSection(id), id);
          await sleep(450);
          const st = await ev(() => ({
            y: window.scrollY,
            body: document.body.scrollTop,
            app: document.querySelector('#app').scrollTop,
            top: document.querySelector('.topbar').getBoundingClientRect().top,
          }));
          if (st.y || st.body || st.app || st.top !== 0) bad.push(`${id}: ${JSON.stringify(st)}`);
        }
        assert(!bad.length, bad.join('; '));
      });
      await check('window resize keeps the canvas sharp and the view centred', async () => {
        await ev(() => window.app.stopFollow());
        await frames(2);
        const before = await ev(() => ({ x: window.app.camera.x, y: window.app.camera.y }));
        await page.setViewportSize({ width: w + 160, height: hgt + 90 });
        await sleep(300);
        await frames(3);
        const st = await ev(() => {
          const c = window.app.renderer.canvas;
          const r = c.getBoundingClientRect();
          const cam = window.app.camera;
          return { cw: c.width, ch: c.height, rw: r.width, rh: r.height, vw: cam.viewW, vh: cam.viewH, x: cam.x, y: cam.y, dpr: window.app.renderer.dpr };
        });
        await page.setViewportSize({ width: w, height: hgt });
        await sleep(300);
        assert(Math.abs(st.cw - Math.floor(st.rw * st.dpr)) <= 1 && Math.abs(st.ch - Math.floor(st.rh * st.dpr)) <= 1, `backing store ${st.cw}×${st.ch} for ${st.rw}×${st.rh} CSS px`);
        assert(Math.abs(st.vw - st.rw) < 1 && Math.abs(st.vh - st.rh) < 1, `camera view ${st.vw}×${st.vh} ≠ canvas ${st.rw}×${st.rh}`);
        approx(st.x, before.x, 1, 'camera x after resize');
        approx(st.y, before.y, 1, 'camera y after resize');
        return `${st.rw}×${st.rh} → ${st.cw}×${st.ch} px`;
      });
      if (w === 1440) {
        await check('text contrast (WCAG AA) of visible UI text', async () => {
          await page.keyboard.press('2');
          await ev(() => window.app.select(window.app.sim.state.agents[0].id));
          await sleep(300);
          const fails = [];
          for (const tab of ['Inspector', 'Stats', 'Events']) {
            await page.locator('.tab', { hasText: tab }).click();
            await sleep(200);
            fails.push(...(await ev(contrastAudit)));
          }
          await page.keyboard.press('h');
          await sleep(250);
          fails.push(...(await ev(contrastAudit)));
          await page.keyboard.press('Escape');
          const uniq = [...new Map(fails.map((f) => [f.key, f])).values()];
          if (uniq.length) {
            for (const f of uniq.slice(0, 40)) info(`low contrast ${f.ratio.toFixed(2)}:1 (< ${f.need}) ${f.sel} “${f.text}” ${f.fg} on ${f.bg}`);
          }
          assert(!uniq.length, `${uniq.length} text styles below WCAG AA`);
          return 'all ≥ AA';
        });
      }
      await ctx.close();
    });
  }

  // =================================================================== performance
  if (runPerf) {
    await section('performance', async () => {
      const { ctx, p } = await openPage(1440, 900, 'perf');
      page = p;
      await check('~1000 agents: FPS at 1× and Max', async () => {
        await ev(() => window.app.setPaused(true));
        await page.keyboard.press('2');
        await setRange(slider('.designer', 'Group size'), 100);
        const pts = await ev(() => {
          const out = [];
          const W = window.app.sim.worldW;
          const H = window.app.sim.worldH;
          for (const [fx, fy] of [
            [0.3, 0.3],
            [0.5, 0.3],
            [0.7, 0.3],
            [0.3, 0.5],
            [0.5, 0.5],
            [0.7, 0.5],
            [0.3, 0.7],
            [0.5, 0.7],
            [0.7, 0.7],
          ]) {
            const g = window.__ui.findTerrain(3, 2, W * fx, H * fy);
            if (g) out.push(g);
          }
          return out;
        });
        for (const g of pts) {
          const t = await tick();
          await clickWorld(g.x, g.y, { zoom: 1 });
          await waitTick(t + 1);
          if ((await pop()) >= 990) break;
        }
        const n = await pop();
        assert(n >= 900, `only ${n} agents`);
        await ev(() => window.app.fitWorld());
        await page.keyboard.press('1');
        const measure = () =>
          ev(async () => {
            let frames = 0;
            const k0 = window.app.sim.tick;
            const t0 = performance.now();
            await new Promise((res) => {
              const f = () => {
                frames++;
                if (performance.now() - t0 < 3000) requestAnimationFrame(f);
                else res();
              };
              requestAnimationFrame(f);
            });
            const dt = performance.now() - t0;
            return { fps: (frames * 1000) / dt, tps: ((window.app.sim.tick - k0) * 1000) / dt, draw: window.app.renderer.stats.drawMs, n: window.app.sim.state.agents.length };
          });
        await page.locator('.seg.speed button').nth(2).click();
        await ev(() => window.app.setPaused(false));
        await sleep(800);
        const one = await measure();
        await page.locator('.seg.speed button').nth(9).click();
        await sleep(800);
        const max = await measure();
        await ev(() => window.app.setPaused(true));
        info(`perf @${one.n} agents, 1×: ${one.fps.toFixed(1)} FPS, ${one.tps.toFixed(1)} TPS, render ${one.draw.toFixed(2)} ms/frame`);
        info(`perf @${max.n} agents, Max: ${max.fps.toFixed(1)} FPS, ${max.tps.toFixed(1)} TPS, render ${max.draw.toFixed(2)} ms/frame`);
        assert(one.fps >= 20, `1× runs at ${one.fps.toFixed(1)} FPS`);
        assert(max.fps >= 10 && max.tps > one.tps, `Max: ${max.fps.toFixed(1)} FPS / ${max.tps.toFixed(1)} TPS`);
        return `1×: ${one.fps.toFixed(0)} FPS · Max: ${max.fps.toFixed(0)} FPS, ${max.tps.toFixed(0)} TPS`;
      });
      await ctx.close();
    });
  }
} catch (err) {
  console.error(`✗ audit aborted: ${err.stack || err.message}`);
  results.push({ name: `${group} › (aborted)`, ok: false, error: err.message });
} finally {
  await browser.close().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------------ contrast audit (runs in the page)
function contrastAudit() {
  const parse = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (top, under) => {
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
  };
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const canvas = window.app.renderer.canvas;
  const cRect = canvas.getBoundingClientRect();
  const k = canvas.width / cRect.width;
  const cctx = canvas.getContext('2d');
  const canvasAvg = (r) => {
    const x = Math.max(0, Math.round((r.left - cRect.left) * k));
    const y = Math.max(0, Math.round((r.top - cRect.top) * k));
    const w = Math.max(1, Math.min(canvas.width - x, Math.round(r.width * k)));
    const h = Math.max(1, Math.min(canvas.height - y, Math.round(r.height * k)));
    const d = cctx.getImageData(x, y, w, h).data;
    let R = 0,
      G = 0,
      B = 0,
      n = 0;
    for (let i = 0; i < d.length; i += 4) {
      R += d[i];
      G += d[i + 1];
      B += d[i + 2];
      n++;
    }
    return [R / n, G / n, B / n, 1];
  };
  const layerOf = (e) => {
    const cs = getComputedStyle(e);
    let c = parse(cs.backgroundColor);
    const img = cs.backgroundImage;
    if (img && img !== 'none' && img.includes('gradient')) {
      const stops = [...img.matchAll(/rgba?\([^)]+\)/g)].map((m) => parse(m[0])).filter(Boolean);
      if (stops.length) {
        const avg = stops.reduce((p, q) => [p[0] + q[0] / stops.length, p[1] + q[1] / stops.length, p[2] + q[2] / stops.length, p[3] + q[3] / stops.length], [0, 0, 0, 0]);
        c = c && c[3] > 0 ? over(avg, c) : avg;
      }
    }
    return c && c[3] > 0 ? c : null;
  };
  const bgOf = (el, rect) => {
    const layers = [];
    let base = null;
    for (let e = el; e; e = e.parentElement) {
      const l = layerOf(e);
      if (l) {
        if (l[3] >= 0.999) {
          base = l;
          break;
        }
        layers.push(l);
      }
      if (e.classList && e.classList.contains('stage')) {
        base = canvasAvg(rect);
        break;
      }
    }
    if (!base) base = [6, 10, 18, 1];
    let c = base;
    for (let i = layers.length - 1; i >= 0; i--) c = over(layers[i], c);
    return c;
  };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent.trim()) continue;
    seen.add(el);
    if (!window.__ui.visible(el) || el.closest('.tip, [disabled], .insp-dead, noscript, .toasts') || el.closest('button:disabled')) continue;
    const cs = getComputedStyle(el);
    if (cs.color === 'rgba(0, 0, 0, 0)' || cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)' || cs.backgroundClip === 'text') continue;
    const r = el.getBoundingClientRect();
    let fg = parse(cs.color);
    let op = 1;
    for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    fg = [fg[0], fg[1], fg[2], fg[3] * op];
    const bg = bgOf(el, r);
    const fgc = over(fg, bg);
    const L1 = lum(fgc);
    const L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (ratio < need) {
      const sel = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
      const hex = (c) =>
        '#' +
        c
          .slice(0, 3)
          .map((v) => Math.round(v).toString(16).padStart(2, '0'))
          .join('');
      out.push({ key: `${sel}|${hex(fgc)}|${hex(bg)}`, sel, text: n.textContent.trim().slice(0, 30), ratio, need, fg: hex(fgc), bg: hex(bg) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ summary
const failed = results.filter((r) => !r.ok);
const passed = results.filter((r) => r.ok && !r.skipped).length;
const skipped = results.filter((r) => r.skipped).length;
const strayErrors = pageErrors.filter((e) => !results.some((r) => r.error && r.error.includes(e)));
console.log('');
if (strayErrors.length) {
  console.log(`  console/page errors (${strayErrors.length}):`);
  for (const e of strayErrors.slice(0, 20)) console.log(`    - ${e}`);
}
console.log(`ui-audit: ${passed} passed, ${failed.length} failed${skipped ? `, ${skipped} skipped` : ''} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
if (strayErrors.length) process.exit(1);
console.log('✓ every audited control works');
