#!/usr/bin/env node
/**
 * UI audit (OWNER: UI). Drives the built app in headless Chromium like a user and asserts a real
 * effect for every control through `window.app` (the App instance: sim, renderer, view, settings,
 * designer, ...). The app opens on the start screen and nothing runs until Start, so the audit
 * starts there and then works through the main screen: top bar, tool rail and every tool's
 * options, Layers menu, zoom, hover card, the Overview, Agent and Events tabs, the Settings
 * drawer, notices, keyboard, layout at three window sizes, contrast, the design rules and a
 * performance run.
 *
 *   npm run build && node scripts/ui-audit.mjs
 *   node scripts/ui-audit.mjs --url http://localhost:5196/     # e.g. against `npx vite --port 5196`
 *   node scripts/ui-audit.mjs --file path/to/index.html        # another single-file build
 *   node scripts/ui-audit.mjs --only "tool|layout"             # subset (regex on check names)
 *   node scripts/ui-audit.mjs --groups "layout|performance"    # run only these groups (regex on group names)
 *   node scripts/ui-audit.mjs --shots out/dir                  # save layout screenshots
 *   node scripts/ui-audit.mjs --no-perf                        # skip the ~1000-agent FPS run
 *
 * Prints one PASS/FAIL line per check (plus INFO lines with measurements) and exits 1 when any
 * check fails, 2 on setup problems. Needs Playwright with Chromium (a global install reachable
 * through NODE_PATH works).
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
      console.error('Playwright not found. Install it: npm i -D playwright && npx playwright install chromium');
      process.exit(2);
    }
  }
}

if (url.startsWith('file:') && !existsSync(fileURLToPath(url))) {
  console.error(`${fileURLToPath(url)} not found. Run "npm run build" first (or pass --url or --file).`);
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
  assert(Number.isFinite(a) && Math.abs(a - b) <= tol, `${what}: expected about ${b} (tolerance ${tol}), got ${a}`);
}
function info(msg) {
  infos.push(msg);
  console.log(`  INFO  ${msg}`);
}
async function check(name, fn) {
  const full = group ? `${group} > ${name}` : name;
  if (only && !only.test(full)) return;
  const errBefore = pageErrors.length;
  const ts = Date.now();
  try {
    const detail = await fn();
    const newErrs = pageErrors.slice(errBefore);
    if (newErrs.length) throw new Error(`console or page error during the check: ${newErrs.join(' | ')}`);
    results.push({ name: full, ok: true });
    console.log(`  PASS  ${full}${detail ? `: ${detail}` : ''}  (${Date.now() - ts} ms)`);
  } catch (err) {
    if (err instanceof Skip) {
      results.push({ name: full, ok: true, skipped: true });
      console.log(`  SKIP  ${full}: ${err.message}`);
      return;
    }
    results.push({ name: full, ok: false, error: err.message });
    console.log(`  FAIL  ${full}: ${String(err.message).split('\n')[0]}`);
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
    results.push({ name: `${name} > (setup aborted)`, ok: false, error: msg });
    console.log(`  FAIL  ${name} > (setup aborted): ${msg}`);
  }
}

// ------------------------------------------------------------------ instrumentation (runs before the app)
/** Counts canvas gradients, shadows (glows) and filters (blur) the app creates, and the most notices on screen at once. */
function instrumentPage() {
  const rec = { gradients: 0, shadows: 0, filters: 0, where: [] };
  window.__canvasStyle = rec;
  const note = (what) => {
    if (rec.where.length < 8) rec.where.push(`${what} ${(new Error().stack || '').split('\n')[3]?.trim() ?? ''}`);
  };
  const protos = [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D].filter(Boolean).map((c) => c.prototype);
  for (const P of protos) {
    for (const k of ['createLinearGradient', 'createRadialGradient', 'createConicGradient']) {
      const f = P[k];
      if (typeof f !== 'function') continue;
      P[k] = function (...a) {
        rec.gradients++;
        note(k);
        return f.apply(this, a);
      };
    }
    const wrap = (prop, bad, key) => {
      const d = Object.getOwnPropertyDescriptor(P, prop);
      if (!d || !d.set) return;
      Object.defineProperty(P, prop, {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set(v) {
          if (bad(v)) {
            rec[key]++;
            note(`${prop}=${v}`);
          }
          d.set.call(this, v);
        },
      });
    };
    wrap('shadowBlur', (v) => Number(v) > 0, 'shadows');
    wrap('filter', (v) => typeof v === 'string' && v !== 'none' && v !== '', 'filters');
  }
  // the most notices on screen at the same time, over the whole session
  window.__toastMax = 0;
  window.__toastLog = [];
  const watchToasts = () => {
    const box = document.querySelector('.toasts');
    if (!box) return void requestAnimationFrame(watchToasts);
    new MutationObserver(() => {
      const n = box.querySelectorAll('.toast').length;
      if (n > window.__toastMax) window.__toastMax = n;
      for (const t of box.querySelectorAll('.toast')) {
        if (t.__seen) continue;
        t.__seen = true;
        window.__toastLog.push({ at: performance.now(), cls: t.className, text: t.textContent });
      }
    }).observe(box, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchToasts);
  else watchToasts();
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
    /** Centre of a tile index. */
    tileCentre(i) {
      const w = app.sim.state.world;
      return { x: ((i % w.width) + 0.5) * w.tileSize, y: (Math.floor(i / w.width) + 0.5) * w.tileSize };
    },
    /** A tile of terrain `t` whose whole (2r+1)^2 neighbourhood is that terrain, nearest to (cx,cy). */
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
    /** Put world point (x,y) at the canvas centre with the given zoom; cancels flights and follow. */
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
    /** Share of neighbouring pixel pairs that differ a lot (hard edges) or only slightly (soft smears) in a canvas region. */
    sharpness(x, y, w, h) {
      const c = app.renderer.canvas;
      const k = c.width / Math.max(1, c.getBoundingClientRect().width);
      const d = c.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), Math.max(2, Math.round(w * k)), Math.max(1, Math.round(h * k)));
      const W = d.width;
      const px = d.data;
      let edges = 0;
      let soft = 0;
      let n = 0;
      for (let yy = 0; yy < d.height; yy += 2)
        for (let xx = 0; xx < W - 1; xx++) {
          const i = (yy * W + xx) * 4;
          const dd = Math.abs(px[i] - px[i + 4]) + Math.abs(px[i + 1] - px[i + 5]) + Math.abs(px[i + 2] - px[i + 6]);
          if (dd > 30) edges++;
          else if (dd > 0 && dd <= 6) soft++;
          n++;
        }
      return { edges: edges / Math.max(1, n), soft: soft / Math.max(1, n) };
    },
    visible(el) {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        // inside a closed fold only its own summary shows
        if (e.tagName === 'DETAILS' && !e.open && e !== el) {
          const sum = el.closest('summary');
          if (!sum || sum.parentElement !== e) return false;
        }
      }
      return true;
    },
    text: (sel) => document.querySelector(sel)?.textContent ?? '',
    /** Labels of the visible sliders inside `scope`. */
    sliderLabels(scope) {
      return [...document.querySelectorAll(`${scope} .ctl-slider`)].filter((e) => ui.visible(e)).map((e) => e.querySelector('.ctl-label').textContent);
    },
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

/** Open the app; `hash` such as '#run=eden&seed=12345' skips the start screen. */
async function openPage(width, height, label, hash = '') {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, acceptDownloads: true });
  await ctx.addInitScript(instrumentPage);
  const p = await ctx.newPage();
  watch(p, label);
  // keep file-chooser interception on for the whole session: enabling it lazily per waitForEvent
  // races with the keypress or click that opens the chooser
  p.on('filechooser', () => {});
  await p.goto(url + hash, { waitUntil: 'load', timeout: 30_000 });
  await p.waitForFunction(() => window.app && window.app.sim && window.app.renderer && document.querySelector('canvas.world'), null, { timeout: 15_000 });
  await p.evaluate(installPageHelpers);
  await p.waitForTimeout(150);
  return { ctx, p };
}

/** Pause and (re)start an experiment with a seed, run `ticks` headless ticks, select Inspect, close popovers. */
async function fresh(id = 'eden', seed = 12345, ticks = 0) {
  await ev(
    ({ id, seed, ticks }) => {
      const app = window.app;
      app.setPaused(true);
      app.showHelp(false);
      app.showSettings(false);
      app.closeMenus();
      const sc = app.scenarios.find((s) => s.id === id);
      if (!sc) throw new Error(`no experiment ${id}`);
      app.startScenario(sc, { seed, quiet: true });
      app.setPaused(true);
      app.setTool('inspect');
      app.toaster.clear();
      for (let i = 0; i < ticks; i++) app.sim.step();
      return app.sim.tick;
    },
    { id, seed, ticks },
  );
  await frames(2);
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
const exact = (label) => new RegExp(`^${label.replace(/[()[\]/.+?*]/g, '\\$&')}$`);
const slider = (scope, label) =>
  page
    .locator(`${scope} .ctl-slider`)
    .filter({ has: page.locator('.ctl-label', { hasText: exact(label) }) })
    .locator('input[type=range]');
const sliderVal = (scope, label) =>
  page
    .locator(`${scope} .ctl-slider`)
    .filter({ has: page.locator('.ctl-label', { hasText: exact(label) }) })
    .locator('.ctl-val');
const toggleCtl = (scope, label) => page.locator(`${scope} label.ctl-toggle`).filter({ has: page.locator('.ctl-label', { hasText: exact(label) }) });
const chip = (scope, label) => page.locator(`${scope} .chip`).filter({ has: page.locator('.chip-label', { hasText: exact(label) }) });
const toolBtn = (scope, label) => page.locator(`${scope} button`, { hasText: exact(label) });

async function openDrawer() {
  if (!(await ev(() => document.querySelector('.drawer').classList.contains('show')))) await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.drawer.show').waitFor({ timeout: 2000 });
}
async function openMore() {
  await openDrawer();
  const open = await ev(() => document.querySelector('.drawer details.fold').open);
  if (!open) await page.locator('.drawer details.fold > summary').click();
}
async function openLayers() {
  if (!(await ev(() => document.querySelector('.layers-menu').classList.contains('show')))) await page.locator('.layers-btn').click();
  await page.locator('.layers-menu.show').waitFor({ timeout: 2000 });
}
async function closeLayers() {
  if (await ev(() => document.querySelector('.layers-menu').classList.contains('show'))) await page.locator('.layers-btn').click();
}
async function setTab(label) {
  await page.locator('.tab', { hasText: exact(label) }).click();
  await frames(2);
}
async function pickSpeed(i) {
  await page.locator('.speed-label').click();
  await page.locator(`.speed-menu .menu-item[data-i="${i}"]`).click();
}

const SPEED_LABELS = ['1/4x', '1/2x', '1x', '2x', '4x', '8x', '16x', '32x', '64x', 'Max'];
const TOOL_IDS = ['inspect', 'spawn', 'remove', 'addFood', 'removeFood', 'fertilize', 'terrain', 'disaster', 'bless'];
const TOOL_NAMES = ['Inspect', 'Add agents', 'Remove agents', 'Add food', 'Remove food', 'Fertilize', 'Paint terrain', 'Disaster', 'Bless or smite'];
const TOOL_SLIDERS = {
  inspect: null,
  spawn: ['Group size', 'Brush size'],
  remove: ['Brush size'],
  addFood: ['Food per tile', 'Brush size'],
  removeFood: ['Brush size'],
  fertilize: ['Fertility added', 'Brush size'],
  terrain: ['Brush size'],
  disaster: ['Intensity', 'Duration', 'Brush size'],
  bless: [],
};

try {
  ({ ctx: context, p: page } = await openPage(1440, 900, 'main'));
  const scenarios = await ev(() => window.app.scenarios.map((s) => ({ id: s.id, name: s.name, look: (s.lookFor ?? []).length })));

  // =================================================================== start screen
  await section('start screen', async () => {
    await ev(() => {
      window.__bootSim = window.app.sim;
    });
    await check('opens on the start screen: nothing runs and no notice covers the map', async () => {
      const a = await ev(() => ({
        open: window.app.startOpen,
        running: window.app.running,
        tick: window.app.sim.tick,
        hasSim: !!(window.app.sim && window.app.sim.state && window.app.sim.state.agents),
        toasts: document.querySelectorAll('.toasts .toast').length,
        start: window.__ui.visible(document.querySelector('.start')),
        top: window.__ui.visible(document.querySelector('.topbar')),
        side: window.__ui.visible(document.querySelector('.side')),
        rail: window.__ui.visible(document.querySelector('.rail')),
      }));
      await sleep(700);
      const t = await tick();
      assert(a.open && a.start && !a.running && a.hasSim, JSON.stringify(a));
      assert(a.tick === 0 && t === 0, `tick ${a.tick} then ${t}: the world runs behind the start screen`);
      assert(a.toasts === 0, `${a.toasts} notices on the start screen`);
      assert(!a.top && !a.side && !a.rail, `main screen controls shown behind the start screen: ${JSON.stringify(a)}`);
      return 'paused at tick 0, window.app.sim exists';
    });
    await check('the selected world is drawn right of the column, fitted to the view', async () => {
      const r = await ev(() => {
        const col = document.querySelector('.start').getBoundingClientRect().width;
        const c = window.__ui.canvasRect();
        const s = window.app.shownSim;
        const a = window.app.camera.worldToScreen(0, 0);
        const b = window.app.camera.worldToScreen(s.worldW, s.worldH);
        return { ...window.__ui.canvasStats(null, col + 20, 20, c.w - col - 40, c.h - 40), col, cw: c.w, ch: c.h, x0: a.x, y0: a.y, x1: b.x, y1: b.y, scen: s.state.scenarioId, sel: document.querySelector('.st-item.on .st-item-name')?.textContent };
      });
      assert(r.colors > 40, `the preview looks blank (${r.colors} colours)`);
      assert(r.x0 >= r.col - 1 && r.x1 <= r.cw + 1 && r.y0 >= -1 && r.y1 <= r.ch + 1, `world drawn at ${r.x0.toFixed(0)}..${r.x1.toFixed(0)} x ${r.y0.toFixed(0)}..${r.y1.toFixed(0)}, column ${r.col}px`);
      assert(r.x1 - r.x0 > (r.cw - r.col) * 0.6 || r.y1 - r.y0 > r.ch * 0.6, 'the preview is not fitted to the free space');
      return `${r.sel}: ${r.colors} colours, world at x ${r.x0.toFixed(0)} to ${r.x1.toFixed(0)}`;
    });
    await check('lists every experiment with its name and one short line', async () => {
      const items = await ev(() => [...document.querySelectorAll('.st-item')].map((b) => ({ name: b.querySelector('.st-item-name')?.textContent, tag: b.querySelector('.st-item-tag')?.textContent ?? '' })));
      assert(items.length === scenarios.length && scenarios.length >= 7, `${items.length} items for ${scenarios.length} experiments`);
      for (let i = 0; i < items.length; i++) {
        assert(items[i].name === scenarios[i].name, `item ${i} "${items[i].name}" vs "${scenarios[i].name}"`);
        assert(items[i].tag.length > 8 && items[i].tag.length < 120, `tagline of ${items[i].name}: "${items[i].tag}"`);
      }
      return items.map((i) => i.name).join(', ');
    });
    for (const sc of [...scenarios.slice(1), scenarios[0]]) {
      await check(`pick ${sc.name}: description, what to watch for and a fresh preview`, async () => {
        await page.locator('.st-item', { has: page.locator('.st-item-name', { hasText: exact(sc.name) }) }).click();
        await waitFor((id) => window.app.shownSim.state.scenarioId === id && window.app.shownSim.tick === 0, sc.id);
        await frames(3);
        const st = await ev(() => {
          const item = document.querySelector('.st-item.on');
          const d = document.querySelector('.st-detail');
          const look = [...(d?.querySelectorAll('.st-look li') ?? [])].map((l) => l.textContent);
          return {
            selected: item?.getAttribute('aria-selected'),
            name: item?.querySelector('.st-item-name')?.textContent,
            detailName: d?.querySelector('.st-name')?.textContent,
            tagline: d?.querySelector('.st-tagline')?.textContent ?? '',
            desc: d?.querySelector('.st-desc')?.textContent ?? '',
            watch: d?.querySelector('h3')?.textContent ?? '',
            look,
            placeholder: document.querySelector('#st-seed').placeholder,
            seed: window.app.shownSim.config.seed,
            agents: window.app.shownSim.state.agents.length,
            same: window.app.sim === window.__bootSim,
            simTick: window.app.sim.tick,
            running: window.app.running,
            shownIsBoot: window.app.shownSim === window.__bootSim,
            boot: window.__bootSim.state.scenarioId,
          };
        });
        assert(st.selected === 'true' && st.name === sc.name && st.detailName === sc.name, `selected ${st.name} (${st.selected}), details of ${st.detailName}`);
        assert(st.tagline.length > 8 && st.desc.length > 40, `line "${st.tagline}", description "${st.desc}"`);
        assert(st.watch === 'What to watch for', `heading "${st.watch}"`);
        assert(st.look.length >= Math.min(2, sc.look) && st.look.length <= 4 && st.look.length === Math.min(4, sc.look), `${st.look.length} points to watch for (lookFor has ${sc.look})`);
        const def = Number(/^(\d+)/.exec(st.placeholder)?.[1]);
        assert(st.seed === def, `preview seed ${st.seed}, the box says the default is "${st.placeholder}"`);
        assert(st.same && st.simTick === 0 && !st.running, `picking changed the current run: ${JSON.stringify(st)}`);
        if (sc.id !== st.boot) assert(!st.shownIsBoot, 'the preview was not regenerated');
        return `${st.agents} agents, seed ${st.seed}, ${st.look.length} points`;
      });
    }
    await check('picking experiments never scrolls the page', async () => {
      const st = await ev(() => ({ y: window.scrollY, body: document.body.scrollTop, app: document.querySelector('#app').scrollTop, al: document.querySelector('.al').scrollTop, top: document.querySelector('.al').getBoundingClientRect().top }));
      assert(!st.y && !st.body && !st.app && !st.al && st.top === 0, JSON.stringify(st));
    });
    await check('arrow keys move through the list', async () => {
      const i0 = await ev(() => [...document.querySelectorAll('.st-item')].findIndex((b) => b.classList.contains('on')));
      await page.locator('.st-item.on').focus();
      await page.keyboard.press('ArrowDown');
      const i1 = await ev(() => [...document.querySelectorAll('.st-item')].findIndex((b) => b.classList.contains('on')));
      await page.keyboard.press('ArrowUp');
      const i2 = await ev(() => [...document.querySelectorAll('.st-item')].findIndex((b) => b.classList.contains('on')));
      const n = scenarios.length;
      assert(i1 === (i0 + 1) % n && i2 === i0, `${i0} then ${i1} then ${i2}`);
      await waitFor((id) => window.app.shownSim.state.scenarioId === id, scenarios[i0].id);
    });
    await check('a typed seed regenerates the preview', async () => {
      await page.locator('#st-seed').fill('777');
      await waitFor(() => window.app.shownSim.config.seed === 777, null, 3000);
      const note = await page.locator('.st-note').textContent();
      assert(note === 'The same seed always gives the same world.', `note "${note}"`);
      assert((await tick()) === 0 && !(await ev(() => window.app.running)), 'the run moved');
    });
    await check('an invalid seed is marked and leaves the preview alone', async () => {
      await page.locator('#st-seed').fill('12ab');
      await sleep(500);
      const st = await ev(() => ({ bad: document.querySelector('#st-seed').classList.contains('bad'), note: document.querySelector('.st-note').textContent, seed: window.app.shownSim.config.seed }));
      await page.locator('#st-seed').fill('777');
      assert(st.bad && /whole number from 0 to 4294967295/.test(st.note) && st.seed === 777, JSON.stringify(st));
    });
    await check('New seed puts a random seed in the box and regenerates the preview', async () => {
      await page.locator('.st-foot .seed-row .btn', { hasText: 'New seed' }).click();
      const v = Number(await page.locator('#st-seed').inputValue());
      assert(Number.isInteger(v) && v > 0 && v !== 777, `box "${v}"`);
      await waitFor((v) => window.app.shownSim.config.seed === v, v, 3000);
      return `seed ${v}`;
    });
    await check('Keyboard shortcuts opens the help list; Esc closes it and keeps the start screen', async () => {
      await page.locator('.st-links .link', { hasText: 'Keyboard shortcuts' }).click();
      assert(await page.locator('.modal-back.show').isVisible(), 'help not shown');
      await page.keyboard.press('Escape');
      const st = await ev(() => ({ help: document.querySelector('.modal-back').classList.contains('show'), start: window.app.startOpen }));
      assert(!st.help && st.start, JSON.stringify(st));
    });
    await check('Load a saved world opens the file chooser', async () => {
      const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.locator('.st-links .link', { hasText: 'Load a saved world' }).click()]);
      assert(fc && !fc.isMultiple(), 'no single-file chooser');
      assert(await ev(() => window.app.startOpen), 'the start screen closed');
    });
    await check('Space and the tool keys do nothing on the start screen', async () => {
      await ev(() => document.activeElement && document.activeElement.blur());
      await page.keyboard.press('Space');
      await page.keyboard.press('3');
      await page.keyboard.press('.');
      await sleep(300);
      const st = await ev(() => ({ running: window.app.running, tool: window.app.tool.id, tick: window.app.sim.tick, open: window.app.startOpen }));
      assert(!st.running && st.tool === 'inspect' && st.tick === 0 && st.open, JSON.stringify(st));
    });
    await check('Start runs the selected experiment with the seed in the box, and the preview becomes the run', async () => {
      await page.locator('.st-item', { has: page.locator('.st-item-name', { hasText: exact('Two Civilizations') }) }).click();
      await page.locator('#st-seed').fill('4242');
      await waitFor(() => window.app.shownSim.config.seed === 4242 && window.app.shownSim.state.scenarioId === 'two-civs', null, 3000);
      await ev(() => {
        window.__preview = window.app.shownSim;
      });
      await page.locator('.st-start').click();
      await frames(3);
      const st = await ev(() => ({
        open: window.app.startOpen,
        id: window.app.sim.state.scenarioId,
        seed: window.app.sim.config.seed,
        running: window.app.running,
        speed: window.app.speedIdx,
        reused: window.app.sim === window.__preview,
        top: window.__ui.visible(document.querySelector('.topbar')),
        side: window.__ui.visible(document.querySelector('.side')),
        name: document.querySelector('.exp-name').textContent,
        t: window.app.sim.tick,
      }));
      assert(!st.open && st.id === 'two-civs' && st.seed === 4242 && st.running && st.speed === 2, JSON.stringify(st));
      assert(st.top && st.side && st.name === 'Two Civilizations', JSON.stringify(st));
      assert(st.reused, 'Start built a different world from the one shown');
      await sleep(500);
      assert((await tick()) > st.t, 'the run does not advance');
      return 'Two Civilizations, seed 4242, 1x';
    });
    await check('a one-time hint explains zoom, drag and click', async () => {
      const st = await ev(() => ({ shown: window.__ui.visible(document.querySelector('.hint-box')), text: document.querySelector('.hint-box span')?.textContent }));
      assert(st.shown && st.text === 'Scroll to zoom, drag to move. Click an agent to see what it is doing.', JSON.stringify(st));
    });
    await check('the experiment name in the top bar reopens the start screen and pauses', async () => {
      await ev(() => {
        const a = window.app;
        a.camera.zoom = 1.7;
        a.camera.x = 700;
        a.camera.y = 500;
        window.__before = { sim: a.sim, x: a.camera.x, y: a.camera.y, z: a.camera.zoom };
      });
      await frames(2);
      await ev(() => {
        const a = window.app;
        window.__before = { sim: a.sim, x: a.camera.x, y: a.camera.y, z: a.camera.zoom };
      });
      await page.locator('.exp-btn').click();
      const t1 = await tick();
      await sleep(400);
      const st = await ev(() => ({ open: window.app.startOpen, running: window.app.running, back: window.__ui.visible(document.querySelector('.st-back')), sel: document.querySelector('.st-item.on .st-item-name')?.textContent, seed: document.querySelector('#st-seed').value }));
      assert(st.open && !st.running && st.back, JSON.stringify(st));
      assert((await tick()) === t1, 'the run kept going behind the start screen');
      assert(st.sel === 'Two Civilizations' && st.seed === '4242', `selected ${st.sel}, seed box "${st.seed}"`);
    });
    await check('Back to current run closes it without changes', async () => {
      const t1 = await tick();
      await page.locator('.st-back').click();
      await frames(1);
      const st = await ev(() => {
        const a = window.app;
        const b = window.__before;
        return { open: a.startOpen, same: a.sim === b.sim, running: a.running, dx: a.camera.x - b.x, dy: a.camera.y - b.y, dz: a.camera.zoom - b.z, t: a.sim.tick };
      });
      assert(!st.open && st.same && st.running, JSON.stringify(st));
      assert(st.t >= t1 && st.t <= t1 + 3, `tick ${t1} then ${st.t}`);
      assert(Math.abs(st.dx) < 1e-6 && Math.abs(st.dy) < 1e-6 && Math.abs(st.dz) < 1e-9, `camera moved by ${st.dx}, ${st.dy}, zoom ${st.dz}`);
    });
    await check('Esc on the start screen goes back to the run', async () => {
      await page.locator('.exp-btn').click();
      await page.keyboard.press('Escape');
      const st = await ev(() => ({ open: window.app.startOpen, same: window.app.sim === window.__before.sim, running: window.app.running }));
      assert(!st.open && st.same && st.running, JSON.stringify(st));
    });
    await check('Enter in the seed box starts', async () => {
      await page.locator('.exp-btn').click();
      await page.locator('#st-seed').fill('31337');
      await page.locator('#st-seed').press('Enter');
      await frames(2);
      const st = await ev(() => ({ open: window.app.startOpen, seed: window.app.sim.config.seed, id: window.app.sim.state.scenarioId, running: window.app.running }));
      assert(!st.open && st.seed === 31337 && st.id === 'two-civs' && st.running, JSON.stringify(st));
    });
    await check('dismissing the hint keeps it away', async () => {
      const shown = await ev(() => window.__ui.visible(document.querySelector('.hint-box')));
      await page.locator('.hint-box button[aria-label="Dismiss hint"]').click();
      const st = await ev(() => ({ shown: window.__ui.visible(document.querySelector('.hint-box')), stored: localStorage.getItem('al:hint') }));
      await page.locator('.exp-btn').click();
      await page.locator('.st-start').click();
      await frames(2);
      const again = await ev(() => window.__ui.visible(document.querySelector('.hint-box')));
      assert(shown && !st.shown && st.stored === 'done' && !again, JSON.stringify({ shown, ...st, again }));
    });
  });

  // =================================================================== start every experiment
  await section('experiments', async () => {
    for (const sc of scenarios) {
      await check(`start ${sc.name} from the start screen`, async () => {
        await ev(() => window.app.startOpen || window.app.openStart());
        await page.locator('.st-item', { has: page.locator('.st-item-name', { hasText: exact(sc.name) }) }).click();
        await page.locator('#st-seed').fill('');
        const def = Number(/^(\d+)/.exec(await page.locator('#st-seed').getAttribute('placeholder'))?.[1]);
        await waitFor(({ id, def }) => window.app.shownSim.state.scenarioId === id && window.app.shownSim.config.seed === def, { id: sc.id, def }, 3000);
        await page.locator('.st-start').click();
        await frames(2);
        const st = await ev(() => ({
          id: window.app.sim.state.scenarioId,
          seed: window.app.sim.config.seed,
          tick: window.app.sim.tick,
          top: document.querySelector('.exp-name').textContent,
          title: document.title,
          n: window.app.sim.state.agents.length,
          running: window.app.running,
        }));
        await ev(() => window.app.setPaused(true));
        assert(st.id === sc.id && st.top === sc.name && st.seed === def && st.running, JSON.stringify(st));
        assert(st.tick <= 8 && st.n > 0, `tick ${st.tick}, ${st.n} agents`);
        assert(st.title === `Artificial Life: ${sc.name}`, `title "${st.title}"`);
        return `${st.n} agents, seed ${st.seed}`;
      });
    }
  });

  // =================================================================== top bar
  await section('topbar', async () => {
    await fresh('eden', 12345, 0);
    await ev(() => window.app.setPaused(false));
    const pausedPill = page.locator('.pills .pill').first();
    await check('play/pause button', async () => {
      const btn = page.locator('.play-btn');
      await btn.click();
      assert((await ev(() => window.app.running)) === false, 'click did not pause');
      assert(await pausedPill.isVisible(), 'Paused pill not shown');
      assert((await pausedPill.textContent()) === 'Paused', `pill "${await pausedPill.textContent()}"`);
      const t1 = await tick();
      await sleep(250);
      assert((await tick()) === t1, 'ticks advance while paused');
      await btn.click();
      assert((await ev(() => window.app.running)) === true, 'click did not resume');
      await sleep(300);
      assert((await tick()) > t1, 'ticks do not advance after resume');
      assert(!(await pausedPill.isVisible()), 'Paused pill still shown');
    });
    await check('the Paused pill resumes', async () => {
      await page.locator('.play-btn').click();
      await pausedPill.click();
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
      assert(t2 === t1 + 1, `tick ${t1} then ${t2}`);
      await step.click();
      await step.click();
      await frames(3);
      assert((await tick()) === t1 + 3, 'three clicks did not make three ticks');
      assert((await ev(() => window.app.running)) === false, 'step resumed the run');
    });
    await check('step while running pauses and steps', async () => {
      await ev(() => window.app.setPaused(false));
      await page.getByRole('button', { name: 'Step one tick' }).click();
      assert((await ev(() => window.app.running)) === false, 'not paused after step');
    });
    await check('slower and faster step through the speeds and stop at the ends', async () => {
      await ev(() => window.app.setSpeed(2));
      const faster = page.getByRole('button', { name: 'Faster' });
      const slower = page.getByRole('button', { name: 'Slower' });
      await faster.click();
      const a = await ev(() => ({ i: window.app.speedIdx, l: document.querySelector('.speed-label').textContent }));
      await slower.click();
      await slower.click();
      const b = await ev(() => ({ i: window.app.speedIdx, l: document.querySelector('.speed-label').textContent }));
      await slower.click();
      await slower.click();
      const c = await ev(() => window.app.speedIdx);
      await ev(() => window.app.setSpeed(9));
      await faster.click();
      const d = await ev(() => ({ i: window.app.speedIdx, l: document.querySelector('.speed-label').textContent }));
      await ev(() => window.app.setSpeed(2));
      assert(a.i === 3 && a.l === '2x' && b.i === 1 && b.l === '1/2x' && c === 0 && d.i === 9 && d.l === 'Max', JSON.stringify({ a, b, c, d }));
      return `${a.l}, ${b.l}, ${SPEED_LABELS[c]}, ${d.l}`;
    });
    const labels = await ev(() => [...document.querySelectorAll('.speed-menu .menu-item')].map((b) => b.firstElementChild.textContent));
    await check('the speed menu lists 1/4x to 64x and Max with their tick rates', async () => {
      await page.locator('.speed-label').click();
      const st = await ev(() => ({ shown: window.__ui.visible(document.querySelector('.speed-menu')), subs: [...document.querySelectorAll('.speed-menu .menu-sub')].map((s) => s.textContent) }));
      await page.keyboard.press('Escape');
      assert(labels.join(' ') === SPEED_LABELS.join(' '), `labels ${labels.join(' ')}`);
      assert(st.shown && st.subs[2] === '30 ticks per second' && st.subs[9] === 'as fast as possible', JSON.stringify(st));
      assert(!(await page.locator('.speed-menu').isVisible()), 'Esc did not close the speed menu');
      return labels.join(' ');
    });
    await ev(() => window.app.setPaused(false));
    const rates = [];
    for (let i = 0; i < SPEED_LABELS.length; i++) {
      await check(`speed ${SPEED_LABELS[i]}`, async () => {
        await pickSpeed(i);
        const st = await ev((i) => {
          const b = document.querySelector(`.speed-menu .menu-item[data-i="${i}"]`);
          return { idx: window.app.speedIdx, on: b.classList.contains('on'), aria: b.getAttribute('aria-checked'), label: document.querySelector('.speed-label').textContent, menu: document.querySelector('.speed-menu').classList.contains('show') };
        }, i);
        assert(st.idx === i && st.on && st.aria === 'true' && st.label === SPEED_LABELS[i] && !st.menu, JSON.stringify(st));
        await sleep(250);
        const r = await ev(async () => {
          const a = window.app;
          const k0 = a.sim.tick;
          const t0 = performance.now();
          await new Promise((res) => setTimeout(res, 1100));
          const num = document.querySelectorAll('.drawer .kv .num');
          return { tps: ((a.sim.tick - k0) * 1000) / (performance.now() - t0), shown: Number(num[0].textContent.replace(/,/g, '')), limited: document.querySelector('.speed-label').classList.contains('limited') };
        });
        rates.push(r.tps);
        const mult = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 0][i];
        const want = 30 * mult;
        if (mult > 0 && mult <= 2) assert(Math.abs(r.tps - want) <= Math.max(2, want * 0.3), `measured ${r.tps.toFixed(1)} TPS, want about ${want}`);
        else if (mult > 2) assert(r.tps >= want * 0.7 || r.limited || r.tps > 90, `measured ${r.tps.toFixed(1)} TPS for ${want} requested and the speed label is not marked`);
        else assert(r.tps > 60, `Max ran only ${r.tps.toFixed(1)} TPS`);
        assert(Number.isFinite(r.shown), 'the Settings performance readout is not a number');
        return `${r.tps.toFixed(1)} TPS measured, Settings shows ${r.shown}${r.limited ? ' (speed label marked: the computer cannot keep up)' : ''}`;
      });
    }
    await check('speed changes TPS monotonically (1/4x < 1x < 4x <= Max)', async () => {
      assert(rates.length === 10, 'missing rates');
      assert(rates[0] < rates[2] && rates[2] < rates[4] && rates[4] <= rates[9] * 1.15, `rates ${rates.map((r) => r.toFixed(0)).join(', ')}`);
      return rates.map((r, i) => `${SPEED_LABELS[i]}=${r.toFixed(0)}`).join(' ');
    });
    await pickSpeed(2);
    await check('the speed menu closes on a click elsewhere', async () => {
      await page.locator('.speed-label').click();
      const open = await page.locator('.speed-menu').isVisible();
      await page.locator('.clock').click();
      assert(open && !(await page.locator('.speed-menu').isVisible()), `open ${open}, still open after a click elsewhere`);
    });
    await check('help button opens the controls list; the close button closes it', async () => {
      await page.locator('.topbar').getByRole('button', { name: 'Help' }).click();
      await page.locator('.modal-back.show').waitFor({ state: 'visible', timeout: 2000 });
      const st = await ev(() => ({ rows: document.querySelectorAll('.modal .key-row').length, heads: [...document.querySelectorAll('.modal h3')].map((x) => x.textContent), title: document.querySelector('.modal h2').textContent }));
      assert(st.rows >= 25 && st.title === 'Controls' && st.heads.join(',') === 'Mouse,Tools,Keyboard', JSON.stringify(st));
      await page.locator('.modal').getByRole('button', { name: 'Close' }).click();
      assert(!(await page.locator('.modal-back').isVisible()), 'overlay still visible after close');
      return `${st.rows} rows: ${st.heads.join(', ')}`;
    });
    await check('help overlay closes on a backdrop click', async () => {
      await page.locator('.topbar').getByRole('button', { name: 'Help' }).click();
      await page.mouse.click(8, 450); // backdrop, outside the modal card
      assert(!(await page.locator('.modal-back').isVisible()), 'overlay still visible');
    });
    await check('side panel button hides and shows the side panel', async () => {
      const btn = page.getByRole('button', { name: 'Side panel' });
      const w0 = await ev(() => window.app.camera.viewW);
      await btn.click();
      await frames(3);
      const hidden = await ev(() => getComputedStyle(document.querySelector('.side')).display === 'none');
      const w1 = await ev(() => window.app.camera.viewW);
      assert(hidden, 'side panel still displayed');
      assert(w1 > w0 + 200, `map did not grow (${w0} to ${w1})`);
      assert((await ev(() => localStorage.getItem('al:hideSide'))) === '1', 'not remembered');
      await btn.click();
      await frames(3);
      const shown = await ev(() => getComputedStyle(document.querySelector('.side')).display !== 'none');
      assert(shown && (await ev(() => window.app.camera.viewW)) === w0, 'not restored');
      return `map ${w0} to ${w1} px wide`;
    });
    await check('Settings opens and closes the settings drawer', async () => {
      const btn = page.getByRole('button', { name: 'Settings', exact: true });
      await btn.click();
      const a = await page.locator('.drawer').isVisible();
      await btn.click();
      const b = await page.locator('.drawer').isVisible();
      await btn.click();
      await page.getByRole('button', { name: 'Close settings' }).click();
      const c = await page.locator('.drawer').isVisible();
      assert(a && !b && !c, `open ${a}, after second click ${b}, after close ${c}`);
    });
    await check('top bar: clock in words with a sun or moon, agent count, no TPS or FPS', async () => {
      await frames(4);
      const r = await ev(() => {
        const a = window.app;
        const env = a.sim.state.env;
        return {
          clock: document.querySelector('.clock-text').textContent,
          tip: document.querySelector('.clock').dataset.tip ?? '',
          icon: !!document.querySelector('.day-ic svg'),
          pop: document.querySelector('.pop-text').textContent,
          n: a.sim.state.agents.length,
          day: Math.floor(env.day) + 1,
          year: env.year + 1,
          simTick: a.sim.tick,
          top: document.querySelector('.topbar').textContent,
        };
      });
      assert(/^Day [\d,]+(, (spring|summer|autumn|winter))?, year \d+$/.test(r.clock), `clock "${r.clock}"`);
      assert(r.clock.startsWith(`Day ${r.day.toLocaleString('en-US')},`) && r.clock.endsWith(`year ${r.year}`), `clock "${r.clock}" vs day ${r.day}, year ${r.year}`);
      assert(r.icon, 'no sun or moon icon');
      assert(r.pop === `${r.n.toLocaleString('en-US')} ${r.n === 1 ? 'agent' : 'agents'}`, `"${r.pop}" vs ${r.n}`);
      assert(/Tick [\d,]+/.test(r.tip), `clock tooltip "${r.tip}"`);
      assert(!/\b(TPS|FPS)\b/.test(r.top), 'TPS or FPS still in the top bar');
      return `${r.clock}, ${r.pop}`;
    });
    await check('Settings, Performance shows ticks and frames per second', async () => {
      await ev(() => window.app.setPaused(false));
      await sleep(1200);
      await openDrawer();
      const st = await ev(() => [...document.querySelectorAll('.drawer .kv dd')].map((d) => d.textContent));
      await ev(() => window.app.showSettings(false));
      assert(/^[\d,]+ ticks per second$/.test(st[0]) && /^[\d,]+ frames per second$/.test(st[1]) && Number(st[1].replace(/\D/g, '')) > 0, JSON.stringify(st));
      return st.join(', ');
    });
  });

  // =================================================================== tools (rail and options)
  await section('tools', async () => {
    await fresh('eden', 12345, 240);
    await check('Inspect is the default; the rail shows icons with tooltips and no number badges', async () => {
      const st = await ev(() => ({
        tool: window.app.tool.id,
        btns: [...document.querySelectorAll('.rail .rail-btn')].map((b) => ({ text: b.textContent.trim(), svg: !!b.querySelector('svg path, svg circle, svg rect'), tip: b.dataset.tip })),
        panel: window.__ui.visible(document.querySelector('.tool-panel')),
      }));
      assert(st.tool === 'inspect' && !st.panel, JSON.stringify({ tool: st.tool, panel: st.panel }));
      assert(st.btns.length === 9, `${st.btns.length} rail buttons`);
      st.btns.forEach((b, k) => {
        assert(b.text === '' && b.svg, `rail button ${k + 1} shows "${b.text}" or has no icon`);
        assert(b.tip === `${TOOL_NAMES[k]} (${k + 1})`, `rail button ${k + 1} tooltip "${b.tip}"`);
      });
      return st.btns.map((b) => b.tip).join(', ');
    });
    for (let k = 0; k < 9; k++) {
      await check(`key ${k + 1} selects ${TOOL_NAMES[k]}`, async () => {
        await page.locator('canvas.world').focus();
        await page.keyboard.press(String(k + 1));
        const st = await ev(() => ({
          tool: window.app.tool.id,
          rail: [...document.querySelectorAll('.rail-btn')].findIndex((b) => b.classList.contains('on')),
          pressed: document.querySelector('.rail-btn.on')?.getAttribute('aria-pressed'),
          title: document.querySelector('.tool-panel .tp-title > span')?.textContent ?? '',
          shown: window.__ui.visible(document.querySelector('.tool-panel')),
        }));
        assert(st.tool === TOOL_IDS[k] && st.rail === k && st.pressed === 'true', `tool ${st.tool}, rail ${st.rail}`);
        if (k === 0) assert(!st.shown, 'options panel shown for Inspect');
        else assert(st.shown && st.title === TOOL_NAMES[k], `panel ${st.shown}, title "${st.title}"`);
        return k === 0 ? 'no options panel' : st.title;
      });
    }
    await page.keyboard.press('1'); // clicking the active tool's button would go back to Inspect
    for (let k = 8; k >= 0; k--) {
      await check(`rail button ${k + 1} opens only the ${TOOL_NAMES[k]} options`, async () => {
        await page.locator('.rail-btn').nth(k).click();
        const st = await ev(() => ({
          tool: window.app.tool.id,
          shown: window.__ui.visible(document.querySelector('.tool-panel')),
          how: document.querySelector('.tool-panel .tp-how')?.textContent ?? '',
          sliders: window.__ui.sliderLabels('.tool-panel'),
          choices: [...document.querySelectorAll('.tool-panel .rows.two .chip')].filter((c) => window.__ui.visible(c)).map((c) => c.textContent),
          whole: [...document.querySelectorAll('.tool-panel .tp-whole .btn')].filter((c) => window.__ui.visible(c)).map((c) => c.textContent),
          designer: window.__ui.visible(document.querySelector('.tool-panel .designer')),
        }));
        const id = TOOL_IDS[k];
        assert(st.tool === id, `tool ${st.tool}`);
        if (id === 'inspect') {
          assert(!st.shown, 'options panel shown for Inspect');
          return;
        }
        assert(st.shown && st.how.length > 10, `panel ${st.shown}, how "${st.how}"`);
        assert([...st.sliders].sort().join('|') === [...TOOL_SLIDERS[id]].sort().join('|'), `sliders ${st.sliders.join(', ')} (want ${TOOL_SLIDERS[id].join(', ')})`);
        assert(st.designer === (id === 'spawn'), `population designer shown: ${st.designer}`);
        if (id === 'terrain') assert(st.choices.length === 8, `${st.choices.length} terrains`);
        else if (id === 'disaster') assert(st.choices.length === 6 && st.whole.length === 1, `${st.choices.length} types, whole map ${st.whole}`);
        else assert(!st.choices.length && !st.whole.length, `other choices shown: ${st.choices} ${st.whole}`);
        return [...st.sliders, ...(st.choices.length ? [`${st.choices.length} choices`] : []), ...st.whole].join(', ') || 'no settings';
      });
    }
    await check('clicking the active tool again returns to Inspect', async () => {
      await page.locator('.rail-btn').nth(3).click();
      const a = await ev(() => window.app.tool.id);
      await page.locator('.rail-btn').nth(3).click();
      const b = await ev(() => window.app.tool.id);
      assert(a === 'addFood' && b === 'inspect', `${a} then ${b}`);
    });
    await check('the close button of the options panel returns to Inspect', async () => {
      await page.keyboard.press('6');
      await page.locator('.tool-panel .tp-x').click();
      const st = await ev(() => ({ tool: window.app.tool.id, shown: window.__ui.visible(document.querySelector('.tool-panel')) }));
      assert(st.tool === 'inspect' && !st.shown, JSON.stringify(st));
    });

    await check('inspect: a click selects the agent under the cursor and opens the Agent tab', async () => {
      await page.keyboard.press('1');
      await setTab('Overview');
      const a = await ev(() => {
        const ag = window.__ui.isolatedAgent(9);
        return ag && { id: ag.id, x: ag.x, y: ag.y, name: ag.name };
      });
      assert(a, 'no isolated agent');
      await clickWorld(a.x, a.y, { zoom: 3 });
      await frames(2);
      const st = await ev(() => ({ sel: window.app.view.selectedId, tab: document.querySelector('.tab.on')?.textContent, name: document.querySelector('.pane-inspector .insp-name')?.textContent ?? '' }));
      assert(st.sel === a.id, `selected ${st.sel}, wanted ${a.id}`);
      assert(st.tab === 'Agent', `tab ${st.tab}`);
      assert(st.name === a.name, `Agent tab shows "${st.name}"`);
      return a.name;
    });
    await check('inspect: clicking an agent opens a hidden side panel', async () => {
      await page.getByRole('button', { name: 'Side panel' }).click();
      await frames(3);
      const a = await ev(() => {
        const ag = window.__ui.isolatedAgent(9, undefined, undefined, (x) => x.id !== window.app.view.selectedId);
        return ag && { id: ag.id, x: ag.x, y: ag.y };
      });
      await clickWorld(a.x, a.y, { zoom: 3 });
      await frames(3);
      const st = await ev(() => ({ side: getComputedStyle(document.querySelector('.side')).display !== 'none', sel: window.app.view.selectedId, tab: document.querySelector('.tab.on')?.textContent }));
      assert(st.side && st.sel === a.id && st.tab === 'Agent', JSON.stringify(st));
    });
    await check('inspect: a click on empty ground deselects', async () => {
      const g = await ev(() => window.__ui.findTerrain(window.__ui.TERRAIN.Grass, 2, undefined, undefined, 30));
      assert(g, 'no empty grass');
      await clickWorld(g.x, g.y, { zoom: 3 });
      assert((await ev(() => window.app.view.selectedId)) === -1, 'still selected');
    });
    await check('inspect: drag moves the map', async () => {
      const c = await ev(() => ({ ...window.__ui.canvasRect(), cx: window.app.camera.x, z: window.app.camera.zoom }));
      await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2);
      await page.mouse.down();
      await page.mouse.move(c.x + c.w / 2 - 120, c.y + c.h / 2, { steps: 6 });
      await page.mouse.up();
      const cx = await ev(() => window.app.camera.x);
      approx(cx - c.cx, 120 / c.z, 2, 'camera x after a 120 px drag');
    });

    // ---------------- Add agents and the population designer
    const grass = await ev(() => window.__ui.findTerrain(window.__ui.TERRAIN.Grass, 4, undefined, undefined, 60));
    async function spawnAt(x, y) {
      const before = await ev(() => ({ next: window.app.sim.state.nextAgentId, t: window.app.sim.tick, nextTribe: window.app.sim.state.nextTribeId }));
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
    const designer = '.tool-panel .designer';
    await check('add agents: a click adds the group size (default 20) as a new tribe', async () => {
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
    await check('add agents: group size slider', async () => {
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
      await check(`add agents: preset "${name}" sets the spawned genes`, async () => {
        await chip(`${designer} .presets`, name).click();
        assert((await chip(`${designer} .presets`, name).getAttribute('aria-checked')) === 'true', 'preset not marked');
        const r = await spawnAt(grass.x, grass.y + 30);
        assert(r.n === 24, `spawned ${r.n}`);
        for (const [g, v] of Object.entries(genes)) approx(r.mean[g], v, 0.06, `mean ${g}`);
        return Object.keys(genes)
          .map((g) => `${g} ${r.mean[g].toFixed(2)}`)
          .join(', ');
      });
    }
    await check('add agents: the Random preset rolls new gene means', async () => {
      const g0 = await ev(() => ({ ...window.app.designer.genes }));
      await chip(`${designer} .presets`, 'Random').click();
      const g1 = await ev(() => ({ ...window.app.designer.genes }));
      const changed = Object.keys(g0).filter((k) => Math.abs(g0[k] - g1[k]) > 1e-6).length;
      assert(changed >= 8, `only ${changed} genes changed`);
      const r = await spawnAt(grass.x - 30, grass.y);
      approx(r.mean.speed, g1.speed, 0.08, 'mean speed');
    });
    await check('add agents: Customize genes opens the gene sliders', async () => {
      const before = await ev(() => window.__ui.sliderLabels('.tool-panel .designer'));
      const fold = page.locator(`${designer} details.fold`);
      if (!(await fold.evaluate((d) => d.open))) await page.locator(`${designer} details.fold > summary`).click();
      const after = await ev(() => window.__ui.sliderLabels('.tool-panel .designer'));
      const title = await page.locator(`${designer} details.fold > summary`).textContent();
      assert(title === 'Customize genes', `fold "${title}"`);
      assert(before.length === 1 && after.length === 14 && after.includes('Variation') && after.includes('Color'), `before ${before.join(', ')} / after ${after.join(', ')}`);
      return after.slice(1).join(', ');
    });
    await check('add agents: gene sliders change the spawned genes', async () => {
      await chip(`${designer} .presets`, 'Balanced').click();
      await setRange(slider(designer, 'Speed'), 0.12);
      await setRange(slider(designer, 'Immunity'), 0.9);
      await setRange(slider(designer, 'Color'), 0.6);
      const presetOn = await page.locator(`${designer} .presets .chip.on`).count();
      assert(presetOn === 0, 'preset still marked after a manual edit');
      const r = await spawnAt(grass.x, grass.y - 30);
      approx(r.mean.speed, 0.12, 0.06, 'mean speed');
      approx(r.mean.immunity, 0.9, 0.06, 'mean immunity');
      approx(r.mean.hue, 0.6, 0.06, 'mean hue');
      return `speed ${r.mean.speed.toFixed(2)}, immunity ${r.mean.immunity.toFixed(2)}, hue ${r.mean.hue.toFixed(2)}`;
    });
    await check('add agents: variation 0 makes clones', async () => {
      await setRange(slider(designer, 'Variation'), 0);
      const r = await spawnAt(grass.x + 30, grass.y + 30);
      const maxSd = Math.max(...Object.values(r.sd));
      assert(maxSd < 1e-6, `gene sd ${maxSd}`);
      await setRange(slider(designer, 'Variation'), 0.08);
    });
    await check('add agents: all 12 gene sliders set the spawned genome', async () => {
      const LABELS = ['Speed', 'Size', 'Perception', 'Metabolism', 'Aggression', 'Sociability', 'Altruism', 'Fertility', 'Longevity', 'Immunity', 'Efficiency', 'Color'];
      const G = ['speed', 'size', 'perception', 'metabolism', 'aggression', 'sociability', 'altruism', 'fertility', 'longevity', 'immunity', 'efficiency', 'hue'];
      const want = LABELS.map((_, i) => Number((0.13 + i * 0.07).toFixed(2)));
      for (let i = 0; i < LABELS.length; i++) await setRange(slider(designer, LABELS[i]), want[i]);
      await setRange(slider(designer, 'Variation'), 0);
      const r = await spawnAt(grass.x - 30, grass.y + 30);
      const bad = G.filter((g, i) => Math.abs(r.mean[g] - want[i]) > 1e-6).map((g) => `${g} ${r.mean[g]}`);
      assert(r.n > 0 && !bad.length, `genes off: ${bad.join(', ')}`);
      await setRange(slider(designer, 'Variation'), 0.08);
      return G.map((g) => `${g} ${r.mean[g].toFixed(2)}`).join(' ');
    });
    await check('add agents: the trait preview and colour swatch follow the genes', async () => {
      const a = await ev(() => ({ t: document.querySelector('.designer-preview').textContent, c: document.querySelector('.designer-swatch').style.background }));
      await setRange(slider(designer, 'Speed'), 0.95);
      await setRange(slider(designer, 'Color'), 0.33);
      const b = await ev(() => ({ t: document.querySelector('.designer-preview').textContent, c: document.querySelector('.designer-swatch').style.background, keys: [...document.querySelectorAll('.designer-preview .pv-k')].map((k) => k.textContent) }));
      assert(a.t !== b.t && b.keys.join(',') === 'Speed,Vision,Health,Lifespan', `preview "${a.t}" then "${b.t}"`);
      assert(a.c !== b.c && b.c.startsWith('rgb'), `swatch ${a.c} then ${b.c}`);
    });
    await check('add agents: "No tribe" spawns loners', async () => {
      await page.locator(`${designer} select`).selectOption('none');
      const r = await spawnAt(grass.x - 30, grass.y - 30);
      assert(r.n > 0 && r.tribeIds.length === 1 && r.tribeIds[0] === -1 && r.newTribes.length === 0, `tribes ${r.tribeIds} new ${JSON.stringify(r.newTribes)}`);
      const nameShown = await page.locator(`${designer} input[type=text]`).isVisible();
      assert(!nameShown, 'tribe name box shown for loners');
    });
    await check('add agents: "Found a new tribe" with a custom name', async () => {
      await page.locator(`${designer} select`).selectOption('new');
      await page.locator(`${designer} input[type=text]`).fill('Audit Clan');
      const r = await spawnAt(grass.x + 40, grass.y - 30);
      assert(r.newTribes.length === 1 && r.newTribes[0].name === 'Audit Clan', `new tribes ${JSON.stringify(r.newTribes)}`);
      assert(r.tribeIds.length === 1 && r.tribeIds[0] === r.newTribes[0].id, 'members not in the new tribe');
      await page.locator(`${designer} input[type=text]`).fill('');
    });
    await check('add agents: "Join <tribe>" reinforces a living tribe', async () => {
      await ev(() => window.app.designer.refreshTribes());
      const o = page.locator(`${designer} select option`).nth(2);
      const val = await o.getAttribute('value');
      const label = await o.textContent();
      assert(val && /^\d+$/.test(val) && /^Join .+ \(\d+\)$/.test(label), `no tribe option (${val}, "${label}")`);
      await page.locator(`${designer} select`).selectOption(val);
      const r = await spawnAt(grass.x - 40, grass.y + 30);
      assert(r.n > 0 && r.tribeIds.length === 1 && r.tribeIds[0] === Number(val) && r.newTribes.length === 0, `tribes ${r.tribeIds} (want ${val})`);
      await page.locator(`${designer} select`).selectOption('new');
      return label;
    });
    await check('add agents: refused on deep water with a notice, nothing spawned', async () => {
      const deep = await ev(() => window.__ui.findTerrain(window.__ui.TERRAIN.DeepWater, 2));
      assert(deep, 'no deep water');
      const n0 = await ev(() => window.app.sim.state.nextAgentId);
      await clickWorld(deep.x, deep.y, { zoom: 2 });
      await frames(3);
      assert((await ev(() => window.app.sim.state.nextAgentId)) === n0, 'agents were spawned in deep water');
      const t = await page.locator('.toasts .toast-bad').textContent();
      assert(/deep water or walls/.test(t), `notice "${t}"`);
      return t;
    });
    await check('add agents: refused at the population cap with a notice', async () => {
      const cap0 = await ev(() => window.app.sim.config.maxAgents);
      await ev(() => window.app.enqueue({ kind: 'setConfig', patch: { maxAgents: 50 } }));
      await frames(3);
      const n0 = await ev(() => window.app.sim.state.nextAgentId);
      await clickWorld(grass.x, grass.y, { zoom: 2 });
      await frames(3);
      const st = await ev(() => ({ next: window.app.sim.state.nextAgentId, t: document.querySelector('.toasts .toast')?.textContent ?? '' }));
      await ev((c) => window.app.enqueue({ kind: 'setConfig', patch: { maxAgents: c } }), cap0);
      await frames(3);
      assert(st.next === n0 && /population cap of 50 is reached/.test(st.t), JSON.stringify(st));
      return st.t;
    });

    // ---------------- remove
    await check('remove agents: a click removes the agents inside the brush', async () => {
      await page.keyboard.press('3');
      await setRange(slider('.tool-panel', 'Brush size'), 40);
      const t = await ev(() => {
        const s = window.app.sim.state;
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
      const inside = await ev((t) => window.__ui.agentsIn(t.x, t.y, 38).map((a) => a.id), t);
      await clickWorld(t.x, t.y, { zoom: 2 });
      await waitTick(t.t + 1);
      const r = await ev(
        (q) => ({ left: q.inside.filter((id) => window.app.sim.getAgent(id)).length, pre: window.app.sim.state.agents.filter((a) => a.id < q.next).length }),
        { inside, next: t.next },
      );
      assert(r.left === 0, `${r.left} of ${inside.length} agents inside the brush survived`);
      assert(r.pre <= t.pop - t.n && r.pre >= t.pop - t.n - 10, `pre-existing agents ${t.pop} to ${r.pre} (expected minus ${t.n})`);
      return `removed ${t.n} agents`;
    });
    await check('remove agents: a drag sweeps a path', async () => {
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

    // ---------------- food and fertility
    await check('remove food: the brush strips the food', async () => {
      await page.keyboard.press('5');
      await setRange(slider('.tool-panel', 'Brush size'), 40);
      const g = await ev(() => window.__ui.findTerrain(window.__ui.TERRAIN.Grass, 5, window.app.sim.worldW * 0.3, window.app.sim.worldH * 0.3));
      const before = await ev((g) => ({ f: window.__ui.sumIn('food', g.x, g.y, 40), t: window.app.sim.tick }), g);
      await clickWorld(g.x, g.y);
      await waitTick(before.t + 1);
      const after = await ev((g) => window.__ui.sumIn('food', g.x, g.y, 40), g);
      assert(before.f > 10 && after < before.f * 0.05, `food ${before.f.toFixed(1)} to ${after.toFixed(1)}`);
      return `${before.f.toFixed(0)} to ${after.toFixed(1)}`;
    });
    await check('add food: the brush adds the food per tile', async () => {
      await page.keyboard.press('4');
      await setRange(slider('.tool-panel', 'Brush size'), 40);
      await setRange(slider('.tool-panel', 'Food per tile'), 5);
      const g = await ev(() => window.__ui.findTerrain(window.__ui.TERRAIN.Grass, 5, window.app.sim.worldW * 0.3, window.app.sim.worldH * 0.3));
      const before = await ev((g) => ({ f: window.__ui.sumIn('food', g.x, g.y, 40), n: window.__ui.tilesIn(g.x, g.y, 40).length, t: window.app.sim.tick }), g);
      await clickWorld(g.x, g.y);
      await waitTick(before.t + 1);
      const after = await ev((g) => window.__ui.sumIn('food', g.x, g.y, 40), g);
      const added = after - before.f;
      assert(added > before.n * 5 * 0.8, `added ${added.toFixed(1)} over ${before.n} tiles (want about ${before.n * 5})`);
      const amt = await ev(() => window.app.sim.state.interventionLog.at(-1).intervention.amount);
      assert(amt === 5, `intervention amount ${amt}`);
      return `+${added.toFixed(0)} food on ${before.n} tiles`;
    });
    await check('fertilize: the brush adds the fertility shown on the slider', async () => {
      await page.keyboard.press('6');
      await setRange(slider('.tool-panel', 'Fertility added'), 0.2);
      const shown = await sliderVal('.tool-panel', 'Fertility added').textContent();
      const g = await ev(() => {
        const w = window.app.sim.state.world;
        for (let i = 0; i < w.fertility.length; i++) if (w.terrain[i] === 3 && w.fertility[i] < 0.7) return window.__ui.tileCentre(i);
        return window.__ui.findTerrain(window.__ui.TERRAIN.Grass, 3);
      });
      const before = await ev((g) => ({ f: window.app.sim.state.world.fertility[window.app.sim.tileIndex(g.x, g.y)], t: window.app.sim.tick }), g);
      await clickWorld(g.x, g.y);
      await waitTick(before.t + 1);
      const after = await ev((g) => window.app.sim.state.world.fertility[window.app.sim.tileIndex(g.x, g.y)], g);
      assert(shown === '20%', `slider shows "${shown}"`);
      assert(after > before.f + 0.15, `fertility ${before.f.toFixed(2)} to ${after.toFixed(2)}`);
      return `${before.f.toFixed(2)} to ${after.toFixed(2)} (${shown})`;
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
      assert(n >= 3, `${n} stamps in a 1 s hold`);
      return `${n} stamps in 1 s`;
    });

    // ---------------- terrain
    const TERRAINS = ['Grassland', 'Forest', 'Sand', 'Desert', 'Mountain', 'Shallows', 'Deep water', 'Wall'];
    const TCODE = { Grassland: 3, Forest: 4, Sand: 2, Desert: 5, Mountain: 6, Shallows: 1, 'Deep water': 0, Wall: 7 };
    await page.keyboard.press('7');
    for (const tname of TERRAINS) {
      await check(`paint terrain: ${tname}`, async () => {
        await chip('.tool-panel .rows.two', tname).click();
        assert((await ev(() => window.app.settings.terrain)) === TCODE[tname], 'settings.terrain not updated');
        const note = await page.locator('.tool-panel .tp-note').first().textContent();
        assert(note.startsWith(`${tname}:`), `the note does not describe ${tname}: "${note}"`);
        await setRange(slider('.tool-panel', 'Brush size'), 24);
        const target = await ev((code) => {
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
      await chip('.tool-panel .rows.two', 'Wall').click();
      await setRange(slider('.tool-panel', 'Brush size'), 10);
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
    await setRange(slider('.tool-panel', 'Brush size'), 60);
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
        await chip('.tool-panel .rows.two', label).click();
        assert((await ev(() => window.app.settings.disaster)) === kind, 'settings.disaster not updated');
        const note = await page.locator('.tool-panel .tp-note').first().textContent();
        assert(note.startsWith(`${label}:`), `note "${note}"`);
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
      await chip('.tool-panel .rows.two', 'Drought').click();
      await setRange(slider('.tool-panel', 'Intensity'), 0.4);
      await setRange(slider('.tool-panel', 'Duration'), 1.5);
      const shown = [await sliderVal('.tool-panel', 'Intensity').textContent(), await sliderVal('.tool-panel', 'Duration').textContent()];
      const g = await ev(() => window.__ui.findTerrain(3, 3, window.app.sim.worldW * 0.4, window.app.sim.worldH * 0.6));
      const before = await ev(() => ({ t: window.app.sim.tick, next: window.app.sim.state.nextDisasterId, dl: window.app.sim.config.dayLength }));
      await clickWorld(g.x, g.y);
      await waitTick(before.t + 1);
      const d = await ev((b) => window.app.sim.state.disasters.find((d) => d.id >= b.next), before);
      approx(d.intensity, 0.4, 1e-9, 'intensity');
      approx(d.duration, 1.5 * before.dl, 0, 'duration (ticks)');
      assert(shown[0] === '40%' && shown[1] === '1.5 days', `sliders show ${shown.join(', ')}`);
      return shown.join(', ');
    });
    await check('disaster tool: a meteor previews its capped impact radius and hides Duration and the whole-map button', async () => {
      await chip('.tool-panel .rows.two', 'Meteor').click();
      await setRange(slider('.tool-panel', 'Brush size'), 250);
      const st0 = await ev(() => ({
        dur: window.__ui.sliderLabels('.tool-panel').includes('Duration'),
        whole: [...document.querySelectorAll('.tool-panel .tp-whole .btn')].some((b) => window.__ui.visible(b)),
        note: [...document.querySelectorAll('.tool-panel .tp-whole .tp-note')].filter((n) => window.__ui.visible(n)).map((n) => n.textContent).join(''),
        size: [...document.querySelectorAll('.tool-panel .tp-size .ctl-val')].map((v) => v.textContent).join(''),
      }));
      const g = await ev(() => window.__ui.findTerrain(3, 3, window.app.sim.worldW * 0.5, window.app.sim.worldH * 0.5));
      await ev(({ x, y }) => window.__ui.centre(x, y, 1), g);
      await frames(2);
      const p = await ev(({ x, y }) => window.__ui.screenOf(x, y), g);
      await page.mouse.move(p.x, p.y);
      await frames(3);
      const preview = await ev(() => window.app.view.brush?.radius);
      const t0 = await tick();
      await page.mouse.click(p.x, p.y);
      await waitTick(t0 + 1);
      const iv = await ev(() => window.app.sim.state.interventionLog.at(-1).intervention);
      await chip('.tool-panel .rows.two', 'Drought').click();
      await frames(2);
      await page.mouse.move(p.x, p.y);
      await frames(3);
      const after = await ev(() => ({ preview: window.app.view.brush?.radius, dur: window.__ui.sliderLabels('.tool-panel').includes('Duration'), whole: [...document.querySelectorAll('.tool-panel .tp-whole .btn')].some((b) => window.__ui.visible(b)) }));
      await setRange(slider('.tool-panel', 'Brush size'), 60);
      assert(iv.kind === 'disaster' && iv.disaster === 'meteor', JSON.stringify(iv));
      assert(preview === iv.radius, `brush preview radius ${preview} but the meteor hits radius ${iv.radius}`);
      assert(st0.size === `${iv.radius} units (meteor limit)`, `brush size shows "${st0.size}" for an impact radius of ${iv.radius}`);
      assert(!st0.dur && !st0.whole && st0.note === 'A meteor always strikes one spot.', `meteor options ${JSON.stringify(st0)}`);
      assert(after.preview === 250 && after.dur && after.whole, `after switching to Drought: ${JSON.stringify(after)}`);
      return `preview ${preview} = impact ${iv.radius}`;
    });

    // ---------------- bless or smite
    await check('bless: a click fully heals and feeds the agent', async () => {
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
        return x && { food: x.food, max: x.traits.maxFood, hp: x.health, maxHp: x.traits.maxHealth };
      }, a.id);
      assert(r, 'agent died');
      assert(r.food >= r.max * 0.97 && r.hp >= r.maxHp * 0.97, `food ${r.food.toFixed(1)}/${r.max.toFixed(1)}, hp ${r.hp.toFixed(1)}/${r.maxHp.toFixed(1)}`);
      return `food ${a.food.toFixed(0)} to ${r.food.toFixed(0)} of ${r.max.toFixed(0)}`;
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
    await check('bless: a click on empty ground only shows a hint', async () => {
      const g = await ev(() => window.__ui.findTerrain(3, 2, undefined, undefined, 30));
      const l0 = await ev(() => window.app.sim.state.interventionLog.length);
      await clickWorld(g.x, g.y, { zoom: 3 });
      await frames(3);
      assert((await ev(() => window.app.sim.state.interventionLog.length)) === l0, 'an intervention was recorded');
      const t = await page.locator('.toasts .toast').textContent();
      assert(/Click on an agent to bless it/.test(t), `hint "${t}"`);
    });

    // ---------------- brush size controls
    await check('brush size slider sets the intervention radius', async () => {
      await page.keyboard.press('5');
      const s = slider('.tool-panel', 'Brush size');
      await s.scrollIntoViewIfNeeded();
      const box = await s.boundingBox();
      await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
      const r1 = await ev(() => window.app.settings.radius);
      assert(r1 > 200 && r1 < 260, `radius after clicking 75% along the track: ${r1}`);
      await setRange(s, 33);
      const g = await ev(() => window.__ui.findTerrain(3, 3));
      const t0 = await tick();
      await clickWorld(g.x, g.y);
      await waitTick(t0 + 1);
      const iv = await ev(() => window.app.sim.state.interventionLog.at(-1).intervention);
      assert(iv.kind === 'removeFood' && iv.radius === 33, JSON.stringify(iv));
      const shown = await sliderVal('.tool-panel', 'Brush size').textContent();
      assert(shown === '33 units', `brush size shows "${shown}"`);
    });
    await check('[ and ] keys resize the brush', async () => {
      await page.locator('canvas.world').focus();
      const r0 = await ev(() => window.app.settings.radius);
      await page.keyboard.press(']');
      const r1 = await ev(() => window.app.settings.radius);
      await page.keyboard.press('[');
      await page.keyboard.press('[');
      const r2 = await ev(() => window.app.settings.radius);
      assert(r1 > r0 && r2 < r1, `${r0} to ${r1} to ${r2}`);
      await sleep(100);
      assert(Math.abs(Number(await slider('.tool-panel', 'Brush size').inputValue()) - r2) < 1, 'the slider does not follow the keys');
    });
    await check('Alt and the wheel resize the brush', async () => {
      const c = await ev(() => window.__ui.canvasRect());
      await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2);
      const r0 = await ev(() => ({ r: window.app.settings.radius, z: window.app.camera.targetZoom }));
      await page.keyboard.down('Alt');
      await page.mouse.wheel(0, -200);
      await page.keyboard.up('Alt');
      await frames(2);
      const r1 = await ev(() => ({ r: window.app.settings.radius, z: window.app.camera.targetZoom }));
      assert(r1.r > r0.r && r1.z === r0.z, `${JSON.stringify(r0)} to ${JSON.stringify(r1)}`);
    });
  });

  // =================================================================== disasters on the whole map
  await section('whole map', async () => {
    await fresh('eden', 12345, 60);
    await page.keyboard.press('8');
    await setRange(slider('.tool-panel', 'Intensity'), 0.55);
    await setRange(slider('.tool-panel', 'Duration'), 1.25);
    for (const [label, kind] of [
      ['Drought', 'drought'],
      ['Plague', 'plague'],
      ['Abundance', 'bloom'],
      ['Cold snap', 'coldsnap'],
      ['Blight', 'blight'],
    ]) {
      await check(`${label} on the whole map`, async () => {
        await chip('.tool-panel .rows.two', label).click();
        const b = await ev(() => ({ t: window.app.sim.tick, next: window.app.sim.state.nextDisasterId, dl: window.app.sim.config.dayLength }));
        const btn = page.locator('.tool-panel .tp-whole .btn');
        assert((await btn.textContent()) === `${label} on the whole map`, `button "${await btn.textContent()}"`);
        await btn.click();
        await waitTick(b.t + 1);
        const d = await ev((b) => window.app.sim.state.disasters.filter((d) => d.id >= b.next), b);
        assert(d.length === 1 && d[0].kind === kind && d[0].radius === 0, JSON.stringify(d));
        approx(d[0].intensity, 0.55, 1e-9, 'intensity');
        approx(d[0].duration, Math.round(1.25 * b.dl), 0, 'duration');
        const t = await page.locator('.toasts .toast').textContent();
        assert(t.startsWith(`${label} started on the whole map for 1.25 days.`), `confirmation "${t}"`);
        return `${kind} r=0 I=${d[0].intensity} ${d[0].duration} ticks`;
      });
    }
    await page.keyboard.press('Escape');
  });

  // =================================================================== layers menu
  await section('layers', async () => {
    // Frames are compared after rendering twice at the same fixed animation time, so only the
    // control under test can change pixels (paused sim, no hover, no brush). The minimap caches a
    // thumbnail on its own frame counter, so it is left out of these comparisons except its own.
    const renderSnap = (keepMinimap = false) =>
      ev((keep) => {
        const a = window.app;
        a.view.hoverId = -1;
        a.renderer.render(a.sim, keep ? a.view : { ...a.view, showMinimap: false }, 987654);
        const c = a.renderer.canvas;
        window.__snap = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        return true;
      }, keepMinimap);
    const renderDiff = (keepMinimap = false) =>
      ev((keep) => {
        const a = window.app;
        a.view.hoverId = -1;
        a.renderer.render(a.sim, keep ? a.view : { ...a.view, showMinimap: false }, 987654);
        const c = a.renderer.canvas;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const p = window.__snap;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - p[i]) + Math.abs(d[i + 1] - p[i + 1]) + Math.abs(d[i + 2] - p[i + 2]) > 24) n++;
        return n;
      }, keepMinimap);
    await fresh('eden', 12345, 900);
    await page.mouse.move(700, 20); // park the pointer on the top bar: no hover, no brush
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
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (let i = 0; i < r.trailLen; i++) {
          const k = ((r.trailHead - 1 - i + r.trail.length / 2) % (r.trail.length / 2)) * 2;
          x0 = Math.min(x0, r.trail[k]);
          x1 = Math.max(x1, r.trail[k]);
          y0 = Math.min(y0, r.trail[k + 1]);
          y1 = Math.max(y1, r.trail[k + 1]);
        }
        return r.trailLen > 1 ? Math.hypot(x1 - x0, y1 - y0) : 0;
      });
      if (extent >= 20) break;
    }
    // so the disease and climate layers have content
    await ev(() => {
      const s = window.app.sim;
      window.app.enqueue({ kind: 'disaster', disaster: 'plague', x: s.worldW / 2, y: s.worldH / 2, radius: 0, intensity: 0.6, duration: 900 });
      window.app.enqueue({ kind: 'disaster', disaster: 'drought', x: s.worldW / 2, y: s.worldH / 2, radius: 0, intensity: 0.6, duration: 900 });
    });
    await frames(4);
    await ev(() => window.app.toaster.clear());
    await check('the Layers button opens the menu; a click elsewhere and Esc close it', async () => {
      await page.locator('.layers-btn').click();
      const a = await ev(() => ({ shown: window.__ui.visible(document.querySelector('.layers-menu')), exp: document.querySelector('.layers-btn').getAttribute('aria-expanded'), titles: [...document.querySelectorAll('.layers-menu .menu-title')].map((t) => t.childNodes[0].textContent) }));
      await page.locator('.clock').click();
      const b = await page.locator('.layers-menu').isVisible();
      await page.locator('.layers-btn').click();
      await page.keyboard.press('Escape');
      const c = await page.locator('.layers-menu').isVisible();
      assert(a.shown && a.exp === 'true' && !b && !c, JSON.stringify({ a, b, c }));
      assert(a.titles.join(',') === 'Data on the map,Show', `sections ${a.titles}`);
    });
    await check('fixed-time re-render is pixel-identical (method check)', async () => {
      await ev(() => window.app.fitWorld());
      await renderSnap();
      const n = await renderDiff();
      assert(n === 0, `${n} pixels differ between identical renders`);
    });
    const OVERLAYS = ['None', 'Food', 'Fertility', 'Density', 'Territory', 'Disease', 'Climate'];
    const OVAL = { None: 'none', Food: 'food', Fertility: 'fertility', Density: 'density', Territory: 'territory', Disease: 'disease', Climate: 'climate' };
    await openLayers();
    await chip('.layers-menu .rows.radio', 'None').click();
    await renderSnap();
    for (const name of OVERLAYS) {
      await check(`data layer ${name}, with its legend shown automatically`, async () => {
        await openLayers();
        await chip('.layers-menu .rows.radio', name).click();
        const st = await ev(() => ({ ov: window.app.view.overlay, stored: localStorage.getItem('al:overlay'), on: document.querySelector('.layers-menu .rows.radio .chip.on')?.textContent, n: document.querySelectorAll('.layers-menu .rows.radio .chip.on').length }));
        assert(st.ov === OVAL[name] && st.stored === OVAL[name] && st.on === name && st.n === 1, JSON.stringify(st));
        const n = await renderDiff();
        const lg = await ev(() => ({ ...window.app.renderer.legendRect }));
        if (name === 'None') {
          assert(n === 0 && !lg.visible, `${n} pixels changed, legend ${lg.visible}`);
          return;
        }
        const total = await ev(() => window.app.renderer.canvas.width * window.app.renderer.canvas.height);
        assert(n > total * 0.02, `the ${name} layer changed only ${n} pixels`);
        assert(lg.visible && lg.w > 100 && lg.h > 30, `legend ${JSON.stringify(lg)}`);
        return `${((n / total) * 100).toFixed(1)}% of pixels changed, legend ${lg.w}x${lg.h}`;
      });
    }
    await check('O key cycles the data layers (Shift+O backwards) and the menu follows', async () => {
      await page.keyboard.press('Escape');
      await page.locator('canvas.world').focus();
      const a = await ev(() => window.app.view.overlay);
      await page.keyboard.press('o');
      const b = await ev(() => window.app.view.overlay);
      await page.keyboard.press('Shift+O');
      const c = await ev(() => window.app.view.overlay);
      const on = await page.locator('.layers-menu .rows.radio .chip.on').textContent();
      assert(a !== b && c === a, `${a} then ${b} then ${c}`);
      assert(OVAL[on] === c, `menu shows "${on}", layer ${c}`);
    });
    await openLayers();
    await chip('.layers-menu .rows.radio', 'Food').click();
    const TOGGLES = [
      ['Vision radius', 'showVision'],
      ['Trails and routes', 'showTrails'],
      ['Connections', 'showConnections'],
      ['Tribe camps', 'showCamps'],
      ['Names', 'showLabels'],
      ['Minimap', 'showMinimap'],
    ];
    await check('the Show list has the six map toggles', async () => {
      const labels = await ev(() => [...document.querySelectorAll('.layers-menu label.ctl-toggle .ctl-label')].map((l) => l.textContent));
      assert(labels.sort().join(',') === TOGGLES.map((t) => t[0]).sort().join(','), labels.join(', '));
      return labels.join(', ');
    });
    for (const [label, key] of TOGGLES) {
      await check(`toggle ${label} changes the map`, async () => {
        await ev(
          ({ key, id }) => {
            const sim = window.app.sim;
            const a = sim.getAgent(id);
            if (key === 'showCamps') {
              const t = sim.state.tribes.find((t) => t.extinctTick === -1);
              window.__ui.centre(t.homeX, t.homeY, 2);
            } else if (key === 'showMinimap') window.app.fitWorld();
            else window.__ui.centre(a.x, a.y, key === 'showLabels' || key === 'showConnections' ? 4 : 3);
          },
          { key, id: selA },
        );
        await frames(2);
        await openLayers();
        const ctl = toggleCtl('.layers-menu', label);
        const v0 = await ev((k) => window.app.view[k] !== false, key);
        const keep = key === 'showMinimap';
        await renderSnap(keep);
        await ctl.click();
        const n = await renderDiff(keep);
        const v1 = await ev((k) => window.app.view[k] !== false, key);
        const stored = await ev((k) => JSON.parse(localStorage.getItem('al:view') || '{}')[k], key);
        const extra = await ev((k) => (k === 'showMinimap' ? window.app.renderer.minimapRect.visible : k === 'showConnections' ? window.app.view.showRelations !== false : null), key);
        const box = await ctl.locator('input').isChecked();
        await ctl.click();
        await frames(2);
        const v2 = await ev((k) => window.app.view[k] !== false, key);
        assert(v1 === !v0 && v2 === v0, `${key}: ${v0} then ${v1} then ${v2}`);
        assert(stored === v1 && box === v1, `not remembered or the box disagrees (${stored}, ${box})`);
        if (extra !== null) assert(extra === v1, `${key === 'showMinimap' ? 'minimap visibility' : 'selected agent lines'} ${extra} does not follow ${key}=${v1}`);
        assert(n >= 40, `turning ${label} ${v1 ? 'on' : 'off'} changed only ${n} pixels`);
        return `${n} pixels`;
      });
    }
    await check('connections: lines between agents with strong ties up close, with a legend', async () => {
      await closeLayers();
      const t = await ev(() => {
        const sim = window.app.sim;
        window.app.select(-1);
        // the densest camp: families and friends close together
        const tr = [...sim.state.tribes].filter((x) => x.extinctTick === -1).sort((a, b) => b.members - a.members)[0];
        window.__ui.centre(tr.homeX, tr.homeY, 4);
        return tr.name;
      });
      await frames(3);
      const on = await ev(() => {
        const a = window.app;
        a.renderer.render(a.sim, a.view, 987654);
        return { lines: a.renderer.stats.connections, legend: a.renderer.connectionsLegendRect.visible, h: a.renderer.connectionsLegendRect.h, z: a.camera.zoom };
      });
      await ev(() => {
        window.app.view.showConnections = false;
        window.app.view.showRelations = false;
      });
      const off = await ev(() => {
        const a = window.app;
        a.renderer.render(a.sim, a.view, 987654);
        return { lines: a.renderer.stats.connections, legend: a.renderer.connectionsLegendRect.visible, h: a.renderer.connectionsLegendRect.h };
      });
      const far = await ev(() => {
        const a = window.app;
        a.view.showConnections = true;
        a.view.showRelations = true;
        a.fitWorld();
        a.renderer.render(a.sim, a.view, 987654);
        return { lines: a.renderer.stats.connections, z: a.camera.zoom };
      });
      assert(on.lines > 0 && on.legend, `at zoom ${on.z}: ${on.lines} lines, legend ${on.legend} (near ${t})`);
      // the same legend also explains territory edges up close, so it may stay, without the connection rows
      assert(off.lines === 0 && (!off.legend || off.h < on.h - 30), `with Connections off: ${off.lines} lines, legend ${off.legend} (${off.h} px tall, ${on.h} px with connections)`);
      assert(far.z >= 2.5 || far.lines === 0, `${far.lines} lines drawn with nobody selected at zoom ${far.z.toFixed(2)}`);
      return `${on.lines} lines at ${t}`;
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
      return `camera at (${cam.x.toFixed(0)}, ${cam.y.toFixed(0)})`;
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
    await openLayers();
    await chip('.layers-menu .rows.radio', 'None').click();
    await closeLayers();
  });

  // =================================================================== zoom
  await section('zoom', async () => {
    await fresh('two-civs', 12345, 300);
    const settle = () => waitFor(() => !window.app.camera.animating, null, 3000);
    await check('the + and - buttons zoom 1.5x about the centre', async () => {
      await ev(() => window.__ui.centre(window.app.sim.worldW / 2, window.app.sim.worldH / 2, 2));
      const c0 = await ev(() => ({ x: window.app.camera.x, y: window.app.camera.y }));
      await page.getByRole('button', { name: 'Zoom in' }).click();
      await settle();
      const z1 = await ev(() => ({ z: window.app.camera.zoom, x: window.app.camera.x, y: window.app.camera.y }));
      await page.getByRole('button', { name: 'Zoom out' }).click();
      await page.getByRole('button', { name: 'Zoom out' }).click();
      await settle();
      const z2 = await ev(() => window.app.camera.zoom);
      approx(z1.z, 3, 0.01, 'zoom after +');
      approx(z2, 2 / 1.5, 0.01, 'zoom after - -');
      approx(z1.x, c0.x, 0.5, 'centre x');
      approx(z1.y, c0.y, 0.5, 'centre y');
      return `2 to ${z1.z.toFixed(2)} to ${z2.toFixed(2)}`;
    });
    await check('the Fit button shows the whole map', async () => {
      await ev(() => window.__ui.centre(50, 50, 5));
      await page.getByRole('button', { name: 'Show the whole map' }).click();
      await frames(2);
      const c = await ev(() => ({ x: window.app.camera.x, y: window.app.camera.y, z: window.app.camera.zoom, W: window.app.sim.worldW, H: window.app.sim.worldH, vw: window.app.camera.viewW, vh: window.app.camera.viewH }));
      approx(c.x, c.W / 2, 1, 'camera x');
      approx(c.y, c.H / 2, 1, 'camera y');
      approx(c.z, Math.min(c.vw / c.W, c.vh / c.H) * 0.98, 0.01, 'zoom');
    });
    await check('one wheel notch zooms about 1.35x at the cursor', async () => {
      const c = await ev(() => window.__ui.canvasRect());
      await ev(() => window.__ui.centre(window.app.sim.worldW / 2, window.app.sim.worldH / 2, 1.5));
      await frames(2);
      const w0 = await ev(({ x, y }) => window.app.camera.screenToWorld(x, y), { x: c.w * 0.3, y: c.h * 0.4 });
      await page.mouse.move(c.x + c.w * 0.3, c.y + c.h * 0.4);
      await page.mouse.wheel(0, -100);
      await settle();
      const r = await ev(({ x, y }) => ({ z: window.app.camera.zoom, w: window.app.camera.screenToWorld(x, y) }), { x: c.w * 0.3, y: c.h * 0.4 });
      approx(r.z / 1.5, 1.35, 0.02, 'zoom factor of one notch');
      approx(r.w.x, w0.x, 1, 'world x under the cursor');
      approx(r.w.y, w0.y, 1, 'world y under the cursor');
      return `factor ${(r.z / 1.5).toFixed(3)}`;
    });
    await check('the closest zoom is 24 px per world unit', async () => {
      await ev(() => window.__ui.centre(window.app.sim.worldW / 2, window.app.sim.worldH / 2, 16));
      for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Zoom in' }).click();
      await settle();
      const z = await ev(() => ({ z: window.app.camera.zoom, max: window.app.camera.maxZoom }));
      assert(z.max === 24 && Math.abs(z.z - 24) < 1e-6, JSON.stringify(z));
    });
    await check('up close the map is crisp: hard edges, no smeared texture', async () => {
      // an upscaled low-resolution texture shows almost no hard edges and many tiny steps between neighbours
      const rows = [];
      for (const [label, t] of [
        ['grass', 3],
        ['forest', 4],
      ]) {
        const g = await ev((t) => window.__ui.findTerrain(t, 4), t);
        if (!g) continue;
        for (const z of [6, 12, 24]) {
          await ev(({ x, y, z }) => window.__ui.centre(x, y, z), { ...g, z });
          await frames(3);
          const c = await ev(() => window.__ui.canvasRect());
          const s = await ev(({ w, h }) => window.__ui.sharpness(w / 2 - 150, h / 2 - 150, 300, 300), { w: c.w, h: c.h });
          rows.push({ label: `${label} at ${z}`, ...s });
        }
      }
      assert(rows.length >= 3, 'no grass or forest to look at');
      // the old 4 px per tile texture: no hard edges at all and 15 to 75% soft steps
      const bad = rows.filter((r) => r.edges < 0.001 || r.soft > 0.12);
      const fmt = (r) => `${r.label}: ${(r.edges * 100).toFixed(1)}% edges, ${(r.soft * 100).toFixed(1)}% soft`;
      assert(!bad.length, bad.map(fmt).join('; '));
      return rows.map(fmt).join('; ');
    });
    await check('a double-click on the ground zooms in 2x there', async () => {
      const g = await ev(() => window.__ui.findTerrain(window.__ui.TERRAIN.Grass, 3, undefined, undefined, 40));
      await ev(({ x, y }) => window.__ui.centre(x, y, 1.5), g);
      await frames(2);
      const c = await ev(() => window.__ui.canvasRect());
      const sx = c.w / 2 + 60;
      const sy = c.h / 2 - 40;
      const w0 = await ev(({ x, y }) => window.app.camera.screenToWorld(x, y), { x: sx, y: sy });
      await page.mouse.dblclick(c.x + sx, c.y + sy);
      await settle();
      const r = await ev(({ x, y }) => ({ z: window.app.camera.zoom, w: window.app.camera.screenToWorld(x, y), f: window.app.followId }), { x: sx, y: sy });
      approx(r.z, 3, 0.01, 'zoom');
      approx(r.w.x, w0.x, 1, 'world x under the cursor');
      approx(r.w.y, w0.y, 1, 'world y under the cursor');
      assert(r.f === -1, 'started following');
    });
    await check('a double-click on an agent follows it at a close view', async () => {
      const a = await ev(() => {
        const ag = window.__ui.isolatedAgent(9);
        return ag && { id: ag.id, x: ag.x, y: ag.y };
      });
      await ev(({ x, y }) => window.__ui.centre(x, y, 2), a);
      await frames(2);
      const p = await ev(({ x, y }) => window.__ui.screenOf(x, y), a);
      await page.mouse.dblclick(p.x, p.y);
      await settle();
      const st = await ev(() => ({ f: window.app.followId, s: window.app.view.selectedId, z: window.app.camera.zoom, pill: window.__ui.visible(document.querySelectorAll('.pills .pill')[1]), pillText: document.querySelectorAll('.pills .pill')[1].textContent, tab: document.querySelector('.tab.on')?.textContent }));
      assert(st.f === a.id && st.s === a.id && st.tab === 'Agent', JSON.stringify(st));
      approx(st.z, 5, 0.01, 'zoom');
      assert(st.pill && st.pillText.startsWith('Following '), `follow pill "${st.pillText}"`);
      await page.locator('.pills .pill').nth(1).click();
      assert((await ev(() => window.app.followId)) === -1, 'the Following pill did not stop following');
      return st.pillText;
    });
  });

  // =================================================================== hover card
  await section('hover card', async () => {
    await fresh('two-civs', 12345, 600);
    const target = await ev(() => {
      const ag = window.__ui.isolatedAgent(12);
      return ag && { id: ag.id, x: ag.x, y: ag.y, name: ag.name };
    });
    const hoverAgent = async () => {
      await ev(({ x, y }) => window.__ui.centre(x, y, 3), target);
      await frames(2);
      const p = await ev(({ x, y }) => window.__ui.screenOf(x, y), target);
      await page.mouse.move(p.x - 30, p.y - 30);
      await page.mouse.move(p.x, p.y, { steps: 3 });
      await frames(4);
      return p;
    };
    await check('hovering an agent shows its name, tribe, age and what it is doing', async () => {
      await page.keyboard.press('1');
      await hoverAgent();
      const st = await ev((id) => {
        const card = document.querySelector('.hover-card');
        const a = window.app.sim.getAgent(id);
        const tribe = a && window.app.sim.getTribe(a.tribeId);
        return {
          shown: window.__ui.visible(card),
          name: card.querySelector('.hc-name')?.textContent,
          sub: card.querySelector('.hc-sub')?.textContent ?? '',
          doing: card.querySelector('.hc-doing')?.textContent ?? '',
          agentDoing: document.querySelector('.pane-inspector .insp-doing')?.textContent ?? '',
          tribe: tribe ? tribe.name : 'No tribe',
          gen: a.generation,
          hover: window.app.view.hoverId,
        };
      }, target.id);
      assert(st.shown && st.name === target.name && st.hover === target.id, JSON.stringify(st));
      assert(st.sub.startsWith(`${st.tribe}, `) && /old, generation \d+$/.test(st.sub), `"${st.sub}"`);
      assert(/^[A-Z].+\.$/.test(st.doing), `doing "${st.doing}"`);
      return `${st.name}: ${st.sub}; ${st.doing}`;
    });
    await check('the hover card says the same as the Agent tab', async () => {
      await ev((id) => window.app.select(id), target.id);
      await frames(3);
      await sleep(150);
      await page.mouse.move(5, 300);
      await hoverAgent();
      const st = await ev(() => ({ card: document.querySelector('.hover-card .hc-doing')?.textContent, tab: document.querySelector('.pane-inspector .insp-doing')?.textContent }));
      assert(st.card === st.tab, JSON.stringify(st));
      await ev(() => window.app.select(-1));
    });
    await check('the hover card stays inside the map', async () => {
      const r = await ev(() => {
        const c = document.querySelector('.hover-card').getBoundingClientRect();
        const s = document.querySelector('.stage').getBoundingClientRect();
        return { c: [c.left, c.top, c.right, c.bottom], s: [s.left, s.top, s.right, s.bottom] };
      });
      assert(r.c[0] >= r.s[0] && r.c[1] >= r.s[1] && r.c[2] <= r.s[2] && r.c[3] <= r.s[3], JSON.stringify(r));
    });
    await check('the hover card hides with other tools', async () => {
      await page.keyboard.press('3');
      await hoverAgent();
      const shown = await ev(() => window.__ui.visible(document.querySelector('.hover-card')));
      await page.keyboard.press('1');
      assert(!shown, 'card shown with the Remove agents tool');
    });
    await check('the hover card hides while dragging', async () => {
      const p = await hoverAgent();
      await page.mouse.down();
      await page.mouse.move(p.x + 40, p.y + 10, { steps: 4 });
      await frames(2);
      const shown = await ev(() => window.__ui.visible(document.querySelector('.hover-card')));
      await page.mouse.up();
      assert(!shown, 'card shown during a drag');
    });
    await check('the hover card hides over the minimap', async () => {
      await hoverAgent();
      const mm = await ev(() => ({ ...window.app.renderer.minimapRect, c: window.__ui.canvasRect() }));
      await page.mouse.move(mm.c.x + mm.x + mm.w / 2, mm.c.y + mm.y + mm.h / 2, { steps: 4 });
      await frames(3);
      assert(!(await ev(() => window.__ui.visible(document.querySelector('.hover-card')))), 'card shown over the minimap');
    });
    await check('with a data layer, the card describes the ground', async () => {
      await ev(() => window.app.setOverlay('food'));
      const g = await ev(() => window.__ui.findTerrain(window.__ui.TERRAIN.Grass, 3, undefined, undefined, 40));
      await ev(({ x, y }) => window.__ui.centre(x, y, 3), g);
      await frames(2);
      const p = await ev(({ x, y }) => window.__ui.screenOf(x, y), g);
      await page.mouse.move(p.x + 3, p.y + 3, { steps: 3 });
      await frames(4);
      const st = await ev(() => ({ shown: window.__ui.visible(document.querySelector('.hover-card')), name: document.querySelector('.hover-card .hc-name')?.textContent, sub: document.querySelector('.hover-card .hc-sub')?.textContent }));
      await ev(() => window.app.setOverlay('none'));
      await page.mouse.move(700, 20);
      assert(st.shown && st.name === 'Grassland' && /^Food [\d.]+, fertility \d+%$/.test(st.sub ?? ''), JSON.stringify(st));
      return `${st.name}: ${st.sub}`;
    });
  });

  // =================================================================== keyboard
  await section('keyboard', async () => {
    await fresh('eden', 12345, 200);
    await page.locator('canvas.world').focus();
    await check('Space toggles pause', async () => {
      await page.keyboard.press('Space');
      assert((await ev(() => window.app.running)) === true, 'not running');
      await page.keyboard.press('Space');
      assert((await ev(() => window.app.running)) === false, 'not paused');
    });
    await check('"." advances one tick', async () => {
      const t1 = await tick();
      await page.keyboard.press('.');
      await frames(3);
      assert((await tick()) === t1 + 1, `tick ${t1} then ${await tick()}`);
    });
    await check('">" and "<" change the speed', async () => {
      const i0 = await ev(() => window.app.speedIdx);
      await page.keyboard.press('>');
      const i1 = await ev(() => ({ i: window.app.speedIdx, l: document.querySelector('.speed-label').textContent }));
      await page.keyboard.press('<');
      await page.keyboard.press('<');
      const i2 = await ev(() => window.app.speedIdx);
      assert(i1.i === i0 + 1 && i1.l === SPEED_LABELS[i0 + 1] && i2 === i0 - 1, `${i0} then ${i1.i} then ${i2}`);
      await ev(() => window.app.setSpeed(2));
    });
    for (const [keys, dx, dy] of [
      [['KeyD', 'ArrowRight'], 1, 0],
      [['KeyA', 'ArrowLeft'], -1, 0],
      [['KeyS', 'ArrowDown'], 0, 1],
      [['KeyW', 'ArrowUp'], 0, -1],
    ]) {
      for (const key of keys) {
        await check(`${key} moves the map`, async () => {
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
    await check('+ and - zoom in and out by 1.5x', async () => {
      await ev(() => window.__ui.centre(window.app.sim.worldW / 2, window.app.sim.worldH / 2, 2));
      await page.keyboard.press('+');
      await sleep(450);
      const z1 = await ev(() => window.app.camera.zoom);
      await page.keyboard.press('-');
      await page.keyboard.press('-');
      await sleep(450);
      const z2 = await ev(() => window.app.camera.zoom);
      approx(z1, 3, 0.05, 'zoom after +');
      approx(z2, 2 / 1.5, 0.05, 'zoom after - -');
    });
    await check('0 shows the whole map', async () => {
      await ev(() => window.__ui.centre(40, 40, 4));
      await page.keyboard.press('0');
      const c = await ev(() => ({ x: window.app.camera.x, W: window.app.sim.worldW, z: window.app.camera.zoom, vw: window.app.camera.viewW, vh: window.app.camera.viewH, H: window.app.sim.worldH }));
      approx(c.x, c.W / 2, 1, 'camera x');
      approx(c.z, Math.min(c.vw / c.W, c.vh / c.H) * 0.98, 0.01, 'zoom');
    });
    await check('F follows the selected agent (the camera tracks it), F again stops', async () => {
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
    await check('F without a selection says what to do', async () => {
      await ev(() => window.app.select(-1));
      await page.keyboard.press('f');
      const t = await page.locator('.toasts .toast').textContent();
      assert(/Select an agent first/.test(t), `notice "${t}"`);
    });
    await check('moving the map stops following', async () => {
      await ev(() => {
        const ag = window.__ui.isolatedAgent(6);
        window.app.select(ag.id);
        window.app.follow(ag.id);
      });
      await page.locator('canvas.world').focus();
      await page.keyboard.down('KeyD');
      await sleep(120);
      await page.keyboard.up('KeyD');
      assert((await ev(() => window.app.followId)) === -1, 'still following');
    });
    await check('Esc closes the Layers menu first, the Settings drawer next, then deselects', async () => {
      await ev(() => window.app.follow(window.app.view.selectedId));
      await page.locator('.layers-btn').click();
      await page.keyboard.press('Escape');
      const a = await ev(() => ({ menu: document.querySelector('.layers-menu').classList.contains('show'), s: window.app.view.selectedId, f: window.app.followId }));
      await openDrawer();
      await page.keyboard.press('Escape');
      const b = await ev(() => ({ drawer: document.querySelector('.drawer').classList.contains('show'), s: window.app.view.selectedId, f: window.app.followId }));
      await page.keyboard.press('Escape');
      const c = await ev(() => ({ s: window.app.view.selectedId, f: window.app.followId }));
      assert(!a.menu && a.s !== -1 && a.f !== -1, `Esc with the Layers menu open: ${JSON.stringify(a)}`);
      assert(!b.drawer && b.s !== -1 && b.f !== -1, `Esc with the drawer open: ${JSON.stringify(b)}`);
      assert(c.s === -1 && c.f === -1, `Esc with nothing open: ${JSON.stringify(c)}`);
    });
    await check('Esc cancels the current tool (back to Inspect)', async () => {
      await page.keyboard.press('4');
      await page.keyboard.press('Escape');
      const t = await ev(() => window.app.tool.id);
      assert(t === 'inspect', `tool still ${t}`);
    });
    await check('H opens the help list, H closes it; ? opens it too', async () => {
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
      const box = page.locator('.tool-panel .designer input[type=text]');
      await box.click();
      await page.keyboard.type('h 1 x');
      const st = await ev(() => ({ help: window.app.helpOpen, tool: window.app.tool.id, running: window.app.running }));
      assert(!st.help && st.tool === 'spawn' && !st.running, JSON.stringify(st));
      assert((await box.inputValue()) === 'h 1 x', 'typed text lost');
      await box.fill('');
      await page.keyboard.press('Escape'); // leaves the box
      await page.keyboard.press('1');
      assert((await ev(() => window.app.tool.id)) === 'inspect', 'shortcuts dead after leaving the text box');
    });
    await check('shortcuts keep working after clicking a button', async () => {
      await page.getByRole('button', { name: 'Show the whole map' }).click();
      await page.keyboard.press('3');
      assert((await ev(() => window.app.tool.id)) === 'remove', 'key ignored after a button click');
      await page.keyboard.press('1');
    });
    await check('shortcuts work after typing a seed and clicking Restart', async () => {
      await openDrawer();
      await page.locator('.drawer .seed-input').fill('31337');
      await toolBtn('.drawer', 'Restart').click();
      await page.keyboard.press('2');
      const st = await ev(() => ({ tool: window.app.tool.id, box: document.querySelector('.drawer .seed-input').value, seed: window.app.sim.config.seed }));
      assert(st.seed === 31337, `restart used seed ${st.seed}`);
      assert(st.tool === 'spawn' && st.box === '31337', `key "2" went to the seed box (tool ${st.tool}, box "${st.box}")`);
      await page.keyboard.press('Escape');
      await ev(() => window.app.showSettings(false));
    });
    await check('Add agents: a drag moves the map instead of adding', async () => {
      await page.keyboard.press('2');
      const c = await ev(() => ({ ...window.__ui.canvasRect(), cx: window.app.camera.x, next: window.app.sim.state.nextAgentId, t: window.app.sim.tick }));
      await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2);
      await page.mouse.down();
      await page.mouse.move(c.x + c.w / 2 + 90, c.y + c.h / 2, { steps: 5 });
      await page.mouse.up();
      await frames(3);
      const r = await ev(() => ({ cx: window.app.camera.x, next: window.app.sim.state.nextAgentId, t: window.app.sim.tick }));
      assert(r.cx < c.cx - 10, `camera did not move (${c.cx} to ${r.cx})`);
      assert(r.next === c.next && r.t === c.t, 'a drag added agents');
    });
    await check('right-drag moves the map with a paint tool (no paint)', async () => {
      await page.keyboard.press('7');
      const c = await ev(() => ({ ...window.__ui.canvasRect(), cy: window.app.camera.y, log: window.app.sim.state.interventionLog.length, terrainV: window.app.sim.state.world.terrainVersion }));
      await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2 + 80, { steps: 5 });
      await page.mouse.up({ button: 'right' });
      await frames(3);
      const r = await ev(() => ({ cy: window.app.camera.y, log: window.app.sim.state.interventionLog.length, terrainV: window.app.sim.state.world.terrainVersion }));
      assert(r.cy < c.cy - 10, `camera did not move (${c.cy} to ${r.cy})`);
      assert(r.log === c.log && r.terrainV === c.terrainV, 'right-drag painted');
      await page.keyboard.press('Escape');
    });
  });

  // =================================================================== Agent tab
  await section('agent tab', async () => {
    await fresh('eden', 12345, 1500);
    await check('with nothing selected it asks to click an agent', async () => {
      await ev(() => window.app.select(-1));
      await setTab('Agent');
      const t = await ev(() => {
        const e = document.querySelector('.pane-inspector .insp-empty');
        return e && window.__ui.visible(e) ? e.textContent : '';
      });
      assert(t === 'Click an agent on the map to see what it is doing and why.', `empty state "${t}"`);
    });
    const fam = await ev(() => {
      const sim = window.app.sim;
      const a = sim.state.agents.find((x) => x.children.some((c) => sim.getAgent(c))) || sim.state.agents.find((x) => x.relationships.some((r) => sim.getAgent(r.id)));
      return a && { id: a.id, name: a.name, x: a.x, y: a.y };
    });
    await check('a selected agent: name, tribe, age, what it is doing, needs, why, genes', async () => {
      assert(fam, 'no agent with living relatives');
      await page.keyboard.press('1');
      await ev((id) => window.app.select(id), fam.id);
      await frames(3);
      await sleep(150);
      const st = await ev(() => {
        const q = (s) => document.querySelector(`.pane-inspector ${s}`);
        const vis = (s) => [...document.querySelectorAll(`.pane-inspector ${s}`)].filter((e) => window.__ui.visible(e));
        return {
          name: q('.insp-name')?.textContent,
          badge: q('.insp-badge')?.hidden,
          tribe: q('.insp-tribe')?.textContent,
          meta: q('.insp-meta-2')?.textContent ?? '',
          doing: q('.insp-doing')?.textContent ?? '',
          needs: vis('.insp-needs .insp-meter').map((m) => m.querySelector('.insp-meter-label').textContent),
          utils: vis('.insp-util').length,
          genes: document.querySelectorAll('.pane-inspector .insp-trait').length,
          heads: vis('.insp-h').map((x) => x.textContent),
          folds: [...document.querySelectorAll('.pane-inspector summary.insp-sec-title')].map((x) => x.textContent),
          btns: vis('.insp-btn').map((b) => b.textContent),
        };
      });
      assert(st.name === fam.name && st.badge === true, `name ${st.name}, dead badge hidden ${st.badge}`);
      assert(st.tribe && /days? old/.test(st.meta) && /generation \d+/.test(st.meta), `tribe "${st.tribe}", "${st.meta}"`);
      assert(/^[A-Z].*\.$/.test(st.doing), `doing "${st.doing}"`);
      assert(['Health', 'Hunger', 'Energy', 'Carrying'].every((n) => st.needs.includes(n)), `needs ${st.needs}`);
      assert(st.utils >= 2 && st.genes === 12, `${st.utils} options, ${st.genes} genes`);
      assert(['Now', 'Why', 'Relationships', 'Family'].every((n) => st.heads.includes(n)), `sections ${st.heads}`);
      assert(st.folds.join(',') === 'Genes,Skills and lifetime,Life story', `folds ${st.folds}`);
      assert(st.btns.join(',') === 'Follow,Show on map,Bless,Smite', `buttons ${st.btns}`);
      return `${st.name}, ${st.tribe}: ${st.doing}`;
    });
    await check('clicking a relative selects it and shows it on the map', async () => {
      const target = await ev(() => {
        const btns = [...document.querySelectorAll('.pane-inspector button.insp-person')].filter((b) => window.__ui.visible(b) && !b.classList.contains('insp-dead'));
        return btns.length ? btns[0].textContent : null;
      });
      assert(target, 'no visible living relative link');
      await ev(() => window.__ui.centre(10, 10, 1));
      await page.locator('.pane-inspector button.insp-person:not(.insp-dead)').filter({ hasText: exact(target) }).first().click();
      await sleep(600);
      await frames(2);
      const st = await ev(() => {
        const a = window.app.sim.getAgent(window.app.view.selectedId);
        return { sel: window.app.view.selectedId, name: document.querySelector('.pane-inspector .insp-name')?.textContent, d: a ? Math.hypot(a.x - window.app.camera.x, a.y - window.app.camera.y) : -1, z: window.app.camera.targetZoom };
      });
      assert(st.sel !== fam.id && st.sel !== -1, `selection ${st.sel}`);
      assert(st.name === target, `Agent tab shows ${st.name}, clicked ${target}`);
      assert(st.d >= 0 && st.d < 6 && st.z >= 3 - 1e-9, `camera ${st.d.toFixed(1)} units away at zoom ${st.z}`);
      return `${target}`;
    });
    await check('Follow keeps the camera on the agent', async () => {
      await page.locator('.pane-inspector .insp-btn', { hasText: exact('Follow') }).click();
      const st = await ev(() => ({ f: window.app.followId, s: window.app.view.selectedId }));
      assert(st.f === st.s && st.f !== -1, JSON.stringify(st));
      await ev(() => window.app.stopFollow());
    });
    await check('Show on map moves the camera to the agent without following', async () => {
      await ev(() => window.__ui.centre(10, 10, 1));
      await page.locator('.pane-inspector .insp-btn', { hasText: exact('Show on map') }).click();
      await sleep(600);
      const st = await ev(() => {
        const a = window.app.sim.getAgent(window.app.view.selectedId);
        return { d: Math.hypot(a.x - window.app.camera.x, a.y - window.app.camera.y), z: window.app.camera.targetZoom, f: window.app.followId };
      });
      assert(st.d < 6 && st.z >= 3 - 1e-9 && st.f === -1, JSON.stringify(st));
    });
    await check('Bless heals and feeds it', async () => {
      const before = await ev(() => {
        const a = window.app.sim.getAgent(window.app.view.selectedId);
        a.food = a.traits.maxFood * 0.3; // make the effect observable
        a.health = a.traits.maxHealth * 0.5;
        return { food: a.food, hp: a.health, t: window.app.sim.tick };
      });
      await page.locator('.pane-inspector .insp-btn', { hasText: exact('Bless') }).click();
      await waitTick(before.t + 1);
      const r = await ev(() => {
        const a = window.app.sim.getAgent(window.app.view.selectedId);
        return { food: a.food, max: a.traits.maxFood, hp: a.health, maxHp: a.traits.maxHealth };
      });
      assert(r.food > before.food && r.food >= r.max * 0.97 && r.hp >= r.maxHp * 0.97, JSON.stringify(r));
      await sleep(300);
      const meter = await page.locator('.pane-inspector .insp-m-health .insp-meter-val').textContent();
      assert(meter === `${Math.round(r.hp)} of ${Math.round(r.maxHp)}`, `health meter "${meter}"`);
    });
    await check('Smite kills it; the tab shows the death and disables the buttons', async () => {
      const t0 = await tick();
      const id = await ev(() => window.app.view.selectedId);
      await page.locator('.pane-inspector .insp-btn', { hasText: exact('Smite') }).click();
      await waitTick(t0 + 1);
      await sleep(400);
      const st = await ev(
        (id) => ({
          alive: !!window.app.sim.getAgent(id),
          badge: document.querySelector('.pane-inspector .insp-badge')?.hidden === false ? document.querySelector('.pane-inspector .insp-badge').textContent : '',
          banner: document.querySelector('.pane-inspector .insp-death')?.textContent,
          disabled: [...document.querySelectorAll('.pane-inspector .insp-btn')].every((b) => b.disabled),
          now: window.__ui.visible(document.querySelector('.pane-inspector .insp-doing')),
        }),
        id,
      );
      assert(!st.alive && st.badge === 'Dead' && /^Removed by you/.test(st.banner ?? '') && st.disabled && !st.now, JSON.stringify(st));
      return st.banner;
    });
    await check('genes, skills and life story fold and unfold', async () => {
      const n = await page.locator('.pane-inspector summary.insp-sec-title').count();
      for (let i = 0; i < n; i++) {
        const sum = page.locator('.pane-inspector summary.insp-sec-title').nth(i);
        const open0 = await sum.evaluate((s) => s.parentElement.open);
        await sum.click();
        const open1 = await sum.evaluate((s) => s.parentElement.open);
        await sum.click();
        assert(open1 === !open0, `section ${i} did not toggle`);
      }
      return `${n} folds`;
    });
  });

  // =================================================================== Overview tab
  await section('overview tab', async () => {
    await fresh('two-civs', 12345, 2400);
    await setTab('Overview');
    await sleep(1100); // the sentences refresh about once a second
    await check('a few plain sentences say what is happening now', async () => {
      const st = await ev(() => ({ lines: [...document.querySelectorAll('.pane-stats .an-now-text p')].map((p) => p.textContent), n: window.app.sim.state.agents.length, head: document.querySelector('.pane-stats .an-now .an-h')?.textContent }));
      assert(st.head === 'Now' && st.lines.length >= 3 && st.lines.length <= 6, `${st.lines.length} sentences under "${st.head}"`);
      assert(st.lines[0].includes(st.n.toLocaleString('en-US')), `first sentence "${st.lines[0]}" vs ${st.n} agents`);
      for (const l of st.lines) assert(/^[A-Z0-9].*[.!?]$/.test(l) && !/[\u2012-\u2015]/.test(l), `sentence "${l}"`);
      return st.lines.join(' ');
    });
    await check('key numbers: a label, a value and a trend line each', async () => {
      const st = await ev(() => [...document.querySelectorAll('.pane-stats .an-key')].map((k) => ({ l: k.querySelector('.an-key-label').textContent, v: k.querySelector('.an-key-value').textContent, spark: window.__ui.canvasStats(k.querySelector('canvas.an-spark')).opaque })));
      const want = ['Population', 'Births per day', 'Deaths per day', 'Tribes', 'Highest generation', 'Infected', 'Food'];
      assert(st.map((k) => k.l).join('|') === want.join('|'), `labels ${st.map((k) => k.l).join(', ')}`);
      const n = await pop();
      const popRow = st[0];
      assert(Number(popRow.v.replace(/,/g, '')) === n, `population ${popRow.v} vs ${n}`);
      const tribes = await ev(() => window.app.sim.state.tribes.filter((t) => t.extinctTick === -1 && t.members > 0).length);
      assert(Number(st[3].v) === tribes, `tribes ${st[3].v} vs ${tribes}`);
      assert(/^\d+%$/.test(st[6].v), `food "${st[6].v}"`);
      const drawn = st.filter((k) => k.spark > 0.003).length;
      assert(drawn >= 5, `${drawn} of 7 trend lines drawn`);
      return st.map((k) => `${k.l} ${k.v}`).join(', ');
    });
    await check('one population chart', async () => {
      const r = await ev(() => {
        const blocks = [...document.querySelectorAll('.pane-stats > .an-block')];
        const b = blocks.find((x) => x.querySelector('.an-h')?.textContent === 'Population');
        const c = b?.querySelector('canvas.an-chart-base');
        return { found: !!c, opaque: c ? window.__ui.canvasStats(c).opaque : 0, outside: [...document.querySelectorAll('.pane-stats canvas.an-chart-base')].filter((x) => !x.closest('.an-more')).length };
      });
      assert(r.found && r.opaque > 0.02 && r.outside === 1, JSON.stringify(r));
    });
    await check('tribes list: colour, name, members, food and relations in words', async () => {
      const st = await ev(() => ({
        rows: [...document.querySelectorAll('.pane-stats .an-tribe')].map((r) => ({ name: r.querySelector('.an-tribe-name').textContent, n: r.querySelector('.an-tribe-n').textContent, rel: r.querySelector('.an-tribe-rel').textContent, sw: r.querySelector('.an-sw').style.background })),
        living: window.app.sim.state.tribes.filter((t) => t.extinctTick === -1 && t.members > 0).length,
      }));
      assert(st.rows.length === Math.min(8, st.living) && st.rows.length >= 2, `${st.rows.length} rows for ${st.living} tribes`);
      for (const r of st.rows) {
        assert(/^[\d,]+ members?, [\d,]+ food$/.test(r.n), `"${r.n}"`);
        assert(/^(At war with|Hostile toward|Allied with|At peace|The only tribe)/.test(r.rel), `relations "${r.rel}"`);
        assert(r.sw.startsWith('rgb'), `swatch ${r.sw}`);
      }
      assert(st.rows.some((r) => /At war with/.test(r.rel)), 'no tribe is at war in Two Civilizations');
      return st.rows.map((r) => `${r.name}: ${r.rel}`).join('; ');
    });
    await check('clicking a tribe moves the camera to its camp', async () => {
      const name = await page.locator('.pane-stats .an-tribe .an-tribe-name').nth(1).textContent();
      await ev(() => window.__ui.centre(10, 10, 1));
      await page.locator('.pane-stats .an-tribe').nth(1).click();
      await sleep(600);
      const st = await ev((name) => {
        const t = window.app.sim.state.tribes.find((x) => x.name === name);
        return { d: Math.hypot(t.homeX - window.app.camera.x, t.homeY - window.app.camera.y), z: window.app.camera.zoom };
      }, name);
      assert(st.d < 3, `camera ${st.d.toFixed(1)} units from the camp of ${name}`);
      return name;
    });
    await check('More charts unfolds the detailed charts, all drawn', async () => {
      const more = page.locator('.pane-stats details.an-more');
      assert(!(await more.evaluate((d) => d.open)), 'More charts is open by default');
      await page.locator('.pane-stats summary.an-more-title').click();
      const n = await page.locator('.pane-stats details.an-sec').count();
      for (let i = 0; i < n; i++) {
        const d = page.locator('.pane-stats details.an-sec').nth(i);
        if (!(await d.evaluate((x) => x.open))) await d.locator('summary').click();
      }
      await frames(4);
      await sleep(200);
      const r = await ev(() => [...document.querySelectorAll('.pane-stats .an-more canvas.an-chart-base')].filter((c) => window.__ui.visible(c)).map((c) => window.__ui.canvasStats(c).opaque));
      const drawn = r.filter((o) => o > 0.02).length;
      assert(r.length >= 10 && drawn >= r.length - 1, `${drawn} of ${r.length} visible charts have content`);
      return `${drawn} of ${r.length} charts drawn in ${n} sections`;
    });
    for (const label of ['20 days', '5 days', '1 day', 'All']) {
      await check(`time range ${label}`, async () => {
        const b = page.locator('.pane-stats .an-toolbar .an-seg', { hasText: exact(label) });
        await b.click();
        await frames(2);
        const st = await ev(() => [...document.querySelectorAll('.pane-stats .an-seg')].map((x) => x.getAttribute('aria-pressed')));
        assert((await b.getAttribute('aria-pressed')) === 'true' && st.filter((x) => x === 'true').length === 1, JSON.stringify(st));
      });
    }
    await check('every gene chip and gene cell selects its gene', async () => {
      const names = await page.locator('.pane-stats .an-chips .an-chip').allTextContents();
      assert(names.length === 12, `${names.length} gene chips`);
      for (let i = 0; i < names.length; i++) {
        await page.locator('.pane-stats .an-chips .an-chip').nth(i).click();
        const st = await ev(
          (i) => ({
            desc: document.querySelector('.pane-stats .an-gene-desc').textContent,
            pressed: document.querySelectorAll('.pane-stats .an-chips .an-chip')[i].getAttribute('aria-pressed'),
            cell: document.querySelectorAll('.pane-stats .an-multi-cell')[i].classList.contains('an-on'),
          }),
          i,
        );
        assert(st.desc.startsWith(names[i]) && st.pressed === 'true' && st.cell, `${names[i]}: ${JSON.stringify(st)}`);
      }
      await page.locator('.pane-stats .an-multi-cell').nth(4).click();
      const d = await page.locator('.pane-stats .an-gene-desc').textContent();
      assert(d.startsWith(names[4]), `gene cell selects ${d}`);
      return names.join(', ');
    });
    await check('every chart section folds and unfolds', async () => {
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
      const blank = await ev(() => [...document.querySelectorAll('.pane-stats .an-more canvas.an-chart-base')].filter((c) => window.__ui.visible(c) && window.__ui.canvasStats(c).opaque < 0.02).length);
      assert(blank <= 1, `${blank} charts blank after re-opening their sections`);
      return `${n} sections`;
    });
    await check('hovering a chart shows a tooltip', async () => {
      const chart = page.locator('.pane-stats .an-chart').first();
      await chart.scrollIntoViewIfNeeded();
      const box = await chart.boundingBox();
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
      await frames(2);
      const tip = page.locator('.pane-stats .an-tip').first();
      assert(await tip.isVisible(), 'no tooltip');
      const text = await tip.textContent();
      await page.mouse.move(700, 20);
      return text.slice(0, 60);
    });
    await page.locator('.pane-stats summary.an-more-title').click(); // fold "More charts" again
    await check('in the first hours births and deaths show as counts so far', async () => {
      await fresh('eden', 12345, 40);
      await setTab('Overview');
      await sleep(400);
      const st = await ev(() => [...document.querySelectorAll('.pane-stats .an-key')].slice(1, 3).map((k) => k.querySelector('.an-key-value').textContent));
      const births = await ev(() => window.app.sim.state.stats.totals.births);
      assert(/^[\d,]+ so far$/.test(st[0]) && /^[\d,]+ so far$/.test(st[1]) && Number(st[0].replace(/\D/g, '')) === births, `${st.join(', ')} (births ${births})`);
      return st.join(', ');
    });
  });

  // =================================================================== Events tab
  await section('events tab', async () => {
    await check('lists events newest first', async () => {
      await setTab('Events');
      await sleep(320); // the panels refresh 4 times a second
      const st = await ev(() => ({ rows: document.querySelectorAll('.ev-row').length, events: window.app.sim.state.events.length, ids: [...document.querySelectorAll('.ev-row')].slice(0, 20).map((r) => Number(r.dataset.id)) }));
      assert(st.rows > 0 && st.rows <= Math.max(st.events, 300), JSON.stringify({ rows: st.rows, events: st.events }));
      assert(st.ids.every((v, i) => i === 0 || st.ids[i - 1] > v), `not newest first: ${st.ids.join(',')}`);
      return `${st.rows} rows`;
    });
    await check('the filter row: All plus one icon chip per kind, labelled', async () => {
      const st = await ev(() => [...document.querySelectorAll('.ev-chip')].map((c) => ({ text: c.textContent, aria: c.getAttribute('aria-label'), svg: !!c.querySelector('svg path, svg circle, svg rect'), tip: c.dataset.tip })));
      assert(st[0].text === 'All' && st.length === 10, `${st.length} chips, first "${st[0].text}"`);
      for (const c of st.slice(1)) assert(c.aria && c.svg && c.text === '' && c.tip && c.tip.startsWith(c.aria), JSON.stringify(c));
      return st
        .slice(1)
        .map((c) => c.aria)
        .join(', ');
    });
    await check('event rows are dated like the top-bar clock', async () => {
      await page.keyboard.press('8');
      await chip('.tool-panel .rows.two', 'Abundance').click();
      const t0 = await tick();
      await page.locator('.tool-panel .tp-whole .btn').click();
      await waitTick(t0 + 1);
      await page.keyboard.press('Escape');
      await sleep(350);
      const st = await ev(() => ({ clock: document.querySelector('.clock-text').textContent, row: document.querySelector('.ev-row .ev-time')?.textContent ?? '', msg: document.querySelector('.ev-row .ev-msg')?.textContent ?? '' }));
      const clockDay = /^Day (\d+(?:,\d{3})*)\b/.exec(st.clock)?.[1];
      const rowDay = /^Day (\d+(?:,\d{3})*), \d\d:\d\d$/.exec(st.row)?.[1];
      assert(clockDay && clockDay === rowDay, `clock "${st.clock}" but the event just logged is dated "${st.row}" (${st.msg.slice(0, 40)})`);
      return `${st.row}: ${st.msg.slice(0, 50)}`;
    });
    await check('a filter chip hides and shows its kind', async () => {
      const c = page.locator('.ev-chip.ev-c-intervention');
      await c.click();
      const hidden = await ev(() => [...document.querySelectorAll('.ev-row.ev-c-intervention')].every((r) => getComputedStyle(r).display === 'none'));
      const n = await page.locator('.ev-row.ev-c-intervention').count();
      const note = await page.locator('.ev-filter-note').textContent();
      assert(n > 0 && hidden && (await c.getAttribute('aria-pressed')) === 'false', `rows ${n}, hidden ${hidden}`);
      assert(/^Showing .+\.$/.test(note) && !note.includes('interventions'), `note "${note}"`);
      await c.click();
      const shown = await ev(() => [...document.querySelectorAll('.ev-row.ev-c-intervention')].some((r) => getComputedStyle(r).display !== 'none'));
      assert(shown && !(await page.locator('.ev-filter-note').isVisible()), 'rows not shown again');
    });
    await check('every kind chip toggles its rows', async () => {
      const n = await page.locator('.ev-chip:not(.ev-chip-all)').count();
      for (let i = 0; i < n; i++) {
        const c = page.locator('.ev-chip:not(.ev-chip-all)').nth(i);
        await c.click();
        const st = await ev((i) => {
          const btn = document.querySelectorAll('.ev-chip:not(.ev-chip-all)')[i];
          const cat = [...btn.classList].find((c) => c.startsWith('ev-c-')).slice(5);
          const list = document.querySelector('.ev-list');
          const rows = [...document.querySelectorAll(`.ev-row.ev-c-${cat}`)];
          return { cat, pressed: btn.getAttribute('aria-pressed'), hiddenClass: list.classList.contains(`ev-hide-${cat}`), visibleRows: rows.filter((r) => getComputedStyle(r).display !== 'none').length };
        }, i);
        await c.click();
        assert(st.pressed === 'false' && st.hiddenClass && st.visibleRows === 0, JSON.stringify(st));
      }
      const pressed = await ev(() => [...document.querySelectorAll('.ev-chip')].every((b) => b.getAttribute('aria-pressed') === 'true'));
      assert(pressed, 'chips not restored');
      return `${n} chips`;
    });
    await check('"All" hides every kind, then shows them again', async () => {
      const all = page.locator('.ev-chip-all');
      await all.click();
      const vis1 = await ev(() => [...document.querySelectorAll('.ev-row')].filter((r) => getComputedStyle(r).display !== 'none').length);
      const note = await page.locator('.ev-filter-note').textContent();
      await all.click();
      const vis2 = await ev(() => [...document.querySelectorAll('.ev-row')].filter((r) => getComputedStyle(r).display !== 'none').length);
      assert(vis1 === 0 && vis2 > 0 && note === 'All kinds of events are hidden.', `${vis1} / ${vis2}, note "${note}"`);
    });
    await check('a double-click on a chip shows only that kind', async () => {
      await page.locator('.ev-chip.ev-c-intervention').dblclick();
      const other = await ev(() => [...document.querySelectorAll('.ev-row:not(.ev-c-intervention)')].filter((r) => getComputedStyle(r).display !== 'none').length);
      const mine = await ev(() => [...document.querySelectorAll('.ev-row.ev-c-intervention')].filter((r) => getComputedStyle(r).display !== 'none').length);
      await page.locator('.ev-chip-all').click();
      if (await ev(() => document.querySelector('.ev-chip-all').getAttribute('aria-pressed') !== 'true')) await page.locator('.ev-chip-all').click();
      assert(other === 0 && mine > 0, `${other} other rows visible, ${mine} intervention rows`);
    });
    await check('clicking an event moves the camera to its place', async () => {
      const e = await ev(() => {
        const ids = new Set([...document.querySelectorAll('.ev-row.ev-jump')].map((r) => Number(r.dataset.id)));
        return [...window.app.sim.state.events].reverse().find((x) => ids.has(x.id) && Number.isFinite(x.x) && Number.isFinite(x.y) && x.x > 30 && x.y > 30);
      });
      assert(e, 'no event with a place');
      await ev(() => window.__ui.centre(5, 5, 2));
      await page.locator(`.ev-row[data-id="${e.id}"]`).click();
      await sleep(600);
      const cam = await ev(() => ({ x: window.app.camera.x, y: window.app.camera.y }));
      approx(cam.x, e.x, 3, 'camera x');
      approx(cam.y, e.y, 3, 'camera y');
      return e.message.slice(0, 70);
    });
  });

  // =================================================================== settings drawer
  await section('settings', async () => {
    await fresh('eden', 12345, 30);
    await openMore();
    const specs = await ev(() =>
      [...document.querySelectorAll('.drawer .fold-body .ctl-slider')].map((el) => {
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
    await check('the drawer: world rules, this run, save and load, notices, performance', async () => {
      const st = await ev(() => ({ heads: [...document.querySelectorAll('.drawer .dsec h3')].map((x) => x.textContent), title: document.querySelector('.drawer h2').textContent, fold: document.querySelector('.drawer details.fold summary').textContent }));
      assert(st.title === 'Settings' && st.heads.join('|') === 'World rules|This run|Save and load|Notices|Performance' && st.fold === 'More settings', JSON.stringify(st));
    });
    await check('More settings holds a slider for every parameter', async () => {
      const missing = Object.keys(KEYS).filter((l) => !specs.some((s) => s.label === l));
      assert(!missing.length && specs.length === 12, `missing ${missing}`);
    });
    for (const s of specs) {
      await check(`slider ${s.label}`, async () => {
        await openMore();
        const key = KEYS[s.label];
        const cur = await ev((k) => window.app.sim.config[k], key);
        approx(s.value, cur, 1e-9, 'slider shows the config value');
        const steps = Math.round((s.max - s.min) / s.step);
        const v = Number((s.min + s.step * Math.round(steps * (cur > (s.min + s.max) / 2 ? 0.2 : 0.8))).toFixed(6));
        const t0 = await tick();
        await setRange(slider('.drawer', s.label), v);
        await waitTick(t0 + 1);
        await sleep(300); // sync() must not snap the slider back
        const r = await ev((k) => window.app.sim.config[k], key);
        approx(r, v, 1e-9, `sim.config.${key}`);
        approx(Number(await slider('.drawer', s.label).inputValue()), v, 1e-9, 'slider position after sync');
        const logged = await ev(() => window.app.sim.state.interventionLog.at(-1).intervention);
        assert(logged.kind === 'setConfig' && Math.abs(logged.patch[key] - v) < 1e-9, `logged ${JSON.stringify(logged)}`);
        return `${key} ${cur} to ${r}`;
      });
    }
    await check('mouse-dragging a parameter slider applies the released value', async () => {
      await openMore();
      const s = slider('.drawer', 'Plant regrowth');
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
      await check(`world rule ${label}`, async () => {
        await openDrawer();
        const v0 = await ev((k) => window.app.sim.config[k], key);
        const t0 = await tick();
        await toggleCtl('.drawer', label).click();
        await waitTick(t0 + 1);
        await sleep(300);
        const v1 = await ev((k) => window.app.sim.config[k], key);
        assert(v1 === !v0, `${key} ${v0} to ${v1}`);
        const checked = await toggleCtl('.drawer', label).locator('input').isChecked();
        assert(checked === v1, `the box shows ${checked}`);
      });
    }
    await check('"Reset to experiment defaults" restores every rule and parameter', async () => {
      await openMore();
      const t0 = await tick();
      await toolBtn('.drawer', 'Reset to experiment defaults').click();
      await waitTick(t0 + 1);
      await sleep(300);
      const r = await ev(() => {
        const app = window.app;
        const base = app.scenarioConfig();
        const diff = [];
        for (const k of Object.keys(base)) if (base[k] !== app.sim.config[k]) diff.push(`${k}: ${app.sim.config[k]} vs ${base[k]}`);
        const boxes = [...document.querySelectorAll('.drawer .toggles')][0].querySelectorAll('input');
        return { diff, boxes: [...boxes].map((b) => b.checked), want: [base.overgrazing, base.seasons, base.dayNight, base.tribesEnabled] };
      });
      assert(!r.diff.length, r.diff.join('; '));
      assert(r.boxes.join() === r.want.join(), `boxes ${r.boxes} vs ${r.want}`);
      const t = await page.locator('.toasts .toast').textContent();
      assert(/back to the experiment defaults/.test(t), `confirmation "${t}"`);
    });
    await check('pop-up notices can be turned off and on', async () => {
      await openDrawer();
      await toggleCtl('.drawer', 'Pop-up notices').click();
      const a = await ev(() => ({ on: window.app.notices, stored: localStorage.getItem('al:notices') }));
      await toggleCtl('.drawer', 'Pop-up notices').click();
      const b = await ev(() => ({ on: window.app.notices, stored: localStorage.getItem('al:notices') }));
      assert(!a.on && a.stored === '0' && b.on && b.stored === '1', JSON.stringify({ a, b }));
    });
    await ev(() => window.app.showSettings(false));
  });

  // =================================================================== this run: restart, new seed, replay
  await section('this run', async () => {
    await fresh('eden', 12345, 0);
    let hashA = '';
    await check('Restart with the seed in the box reproduces the same hash', async () => {
      await openDrawer();
      await page.locator('.drawer .seed-input').fill('4242');
      await toolBtn('.drawer', 'Restart').click();
      assert((await ev(() => window.app.sim.config.seed)) === 4242, 'seed not applied');
      const t = await page.locator('.toasts .toast').textContent();
      assert(t === 'Restarted Garden of Eden with seed 4242.', `confirmation "${t}"`);
      hashA = await stepN(90);
      await toolBtn('.drawer', 'Restart').click();
      assert((await tick()) === 0, 'restart did not reset the tick');
      const hashB = await stepN(90);
      assert(hashA === hashB, `${hashA} vs ${hashB}`);
      return hashA;
    });
    await check('New seed changes the world and the hash', async () => {
      await openDrawer();
      await toolBtn('.drawer', 'New seed').click();
      const seed = await ev(() => window.app.sim.config.seed);
      assert(seed !== 4242, 'seed unchanged');
      await waitFor((s) => document.querySelector('.drawer .seed-input').value === String(s), seed, 2000);
      const h = await stepN(90);
      assert(h !== hashA, 'hash unchanged');
      return `seed ${seed}`;
    });
    await check('Enter in the seed box restarts with that seed', async () => {
      await openDrawer();
      await page.locator('.drawer .seed-input').fill('5150');
      await page.locator('.drawer .seed-input').press('Enter');
      const st = await ev(() => ({ seed: window.app.sim.config.seed, tick: window.app.sim.tick }));
      assert(st.seed === 5150 && st.tick === 0, JSON.stringify(st));
    });
    await check('Replay my interventions reproduces the intervention run', async () => {
      await openDrawer();
      await page.locator('.drawer .seed-input').fill('777');
      await toolBtn('.drawer', 'Restart').click();
      const step = page.getByRole('button', { name: 'Step one tick' });
      for (let i = 0; i < 5; i++) await step.click();
      await page.keyboard.press('2');
      const g = await ev(() => window.__ui.findTerrain(3, 4, undefined, undefined, 50));
      let t = await tick();
      await clickWorld(g.x, g.y);
      await waitTick(t + 1);
      for (let i = 0; i < 3; i++) await step.click();
      await page.keyboard.press('7');
      await chip('.tool-panel .rows.two', 'Wall').click();
      t = await tick();
      await clickWorld(g.x + 60, g.y);
      await waitTick(t + 1);
      await openMore();
      t = await tick();
      await setRange(slider('.drawer', 'Plant regrowth'), 2);
      await waitTick(t + 1);
      await page.keyboard.press('8');
      await chip('.tool-panel .rows.two', 'Drought').click();
      t = await tick();
      await page.locator('.tool-panel .tp-whole .btn').click();
      await waitTick(t + 1);
      await page.keyboard.press('4');
      t = await tick();
      await clickWorld(g.x - 50, g.y + 20);
      await waitTick(t + 1);
      await page.keyboard.press('1');
      const log = await ev(() => window.app.sim.state.interventionLog.length);
      const cur = await tick();
      const hRun = await stepN(120 - cur);
      await openDrawer();
      await sleep(300);
      const replayBtn = toolBtn('.drawer', `Replay my interventions (${log})`);
      assert((await replayBtn.count()) === 1, `button label "${await page.locator('.drawer button', { hasText: 'Replay my interventions' }).textContent()}" (log ${log})`);
      await replayBtn.click();
      assert((await tick()) === 0, 'replay did not restart');
      const hReplay = await stepN(120);
      assert(hRun === hReplay, `run ${hRun} vs replay ${hReplay} (${log} interventions)`);
      return `${log} interventions, hash ${hRun}`;
    });
    await check('Replay warns when the intervention log was cut short', async () => {
      const st = await ev(() => {
        const app = window.app;
        for (let k = 0; k <= 5000; k++) app.sim.enqueue({ kind: 'fertilize', x: 100, y: 100, radius: 4, amount: 0.0001 }); // fills the capped log
        app.stepOnce();
        return { dropped: app.sim.state.interventionLogDropped ?? null, log: app.sim.state.interventionLog.length };
      });
      if (st.dropped === null) throw new Skip('this build does not track dropped log entries');
      assert(st.dropped > 0, `nothing dropped (${JSON.stringify(st)})`);
      await openDrawer();
      await sleep(300);
      await page.locator('.drawer button', { hasText: 'Replay my interventions' }).click();
      const t = page.locator('.toasts .toast-bad', { hasText: 'Replay is incomplete' });
      await t.first().waitFor({ timeout: 2000 });
      return `${st.dropped} dropped, warning shown`;
    });
    await check('Replay is disabled without interventions', async () => {
      await openDrawer();
      await toolBtn('.drawer', 'Restart').click();
      await sleep(300);
      const b = page.locator('.drawer button', { hasText: 'Replay my interventions' });
      assert((await b.textContent()) === 'Replay my interventions' && (await b.isDisabled()), `"${await b.textContent()}", disabled ${await b.isDisabled()}`);
      await ev(() => window.app.showSettings(false));
    });
  });

  // =================================================================== save / load
  await section('save and load', async () => {
    await fresh('eden', 12345, 0);
    // a run with a few interventions, so the save carries an intervention log
    {
      await stepN(20);
      await page.keyboard.press('4');
      const g = await ev(() => window.__ui.findTerrain(3, 3));
      let t = await tick();
      await clickWorld(g.x, g.y);
      await waitTick(t + 1);
      await stepN(30);
      await page.keyboard.press('8');
      await chip('.tool-panel .rows.two', 'Blight').click();
      t = await tick();
      await page.locator('.tool-panel .tp-whole .btn').click();
      await waitTick(t + 1);
      await page.keyboard.press('Escape');
      await stepN(300 - (await tick()));
    }
    let savedPath = '';
    let saved = null;
    const loadThroughChooser = async (trigger, path) => {
      const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), trigger()]);
      await fc.setFiles(path);
    };
    await check('Save this world downloads valid JSON', async () => {
      await openDrawer();
      const st = await ev(() => ({ tick: window.app.sim.tick, hash: window.app.sim.hash(), n: window.app.sim.state.agents.length }));
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), toolBtn('.drawer', 'Save this world').click()]);
      savedPath = join(tmp, dl.suggestedFilename());
      await dl.saveAs(savedPath);
      const json = JSON.parse(readFileSync(savedPath, 'utf8'));
      assert(json && typeof json === 'object' && JSON.stringify(json).length > 1000, 'not a save');
      saved = { ...st, name: dl.suggestedFilename() };
      assert(dl.suggestedFilename().endsWith('.json') && dl.suggestedFilename().includes(`t${st.tick}`), dl.suggestedFilename());
      const t = await page.locator('.toasts .toast').textContent();
      assert(t.startsWith(`Saved ${dl.suggestedFilename()} (`), `confirmation "${t}"`);
      return `${dl.suggestedFilename()} (${(readFileSync(savedPath).length / 1024).toFixed(0)} kB)`;
    });
    await check('Load a saved world restores the saved state (tick and hash)', async () => {
      assert(savedPath, 'no save file');
      const contHash = await stepN(40);
      await stepN(25);
      await openDrawer();
      await loadThroughChooser(() => toolBtn('.drawer', 'Load a saved world').click(), savedPath);
      await waitFor((t) => window.app.sim.tick === t, saved.tick);
      const st = await ev(() => ({ tick: window.app.sim.tick, hash: window.app.sim.hash() }));
      assert(st.tick === saved.tick && st.hash === saved.hash, `loaded tick ${st.tick} hash ${st.hash}, saved ${saved.tick} ${saved.hash}`);
      const after = await stepN(40);
      assert(after === contHash, 'continuing after the load diverges from the original run');
      const t = await page.locator('.toasts .toast').textContent();
      assert(t.startsWith(`Loaded ${saved.name}: day `), `confirmation "${t}"`);
      return `tick ${st.tick}, hash ${st.hash}`;
    });
    await check('Replay after loading reproduces the saved state', async () => {
      const log = await ev(() => window.app.sim.state.interventionLog.length);
      assert(log >= 2, `the save has ${log} interventions`);
      await openDrawer();
      await sleep(300);
      await page.locator('.drawer button', { hasText: 'Replay my interventions' }).click();
      assert((await tick()) === 0, 'replay did not restart');
      const h = await stepN(saved.tick);
      assert(h === saved.hash, `replayed hash ${h} vs saved ${saved.hash}`);
      return `${log} interventions replayed to tick ${saved.tick}`;
    });
    await check('an invalid file shows an error and the run goes on', async () => {
      const bad = join(tmp, 'broken.json');
      writeFileSync(bad, '{"version": 999, "nope": true');
      const t0 = await tick();
      await openDrawer();
      await loadThroughChooser(() => toolBtn('.drawer', 'Load a saved world').click(), bad);
      await page.locator('.toasts .toast-error').waitFor({ timeout: 3000 });
      const msg = await page.locator('.toasts .toast-error').textContent();
      assert(msg.startsWith('broken.json is not an Artificial Life save.'), `error "${msg}"`);
      await ev(() => window.app.setPaused(false));
      await sleep(400);
      const t1 = await tick();
      await ev(() => window.app.setPaused(true));
      assert(t1 > t0 + 3, 'the app stopped');
      const bad2 = join(tmp, 'wrong-version.json');
      writeFileSync(bad2, JSON.stringify({ version: 999, state: {} }));
      await openDrawer();
      await loadThroughChooser(() => toolBtn('.drawer', 'Load a saved world').click(), bad2);
      await page.locator('.toasts .toast-error', { hasText: 'wrong-version.json' }).waitFor({ timeout: 3000 });
      return msg.slice(0, 90);
    });
    await check('dropping a save file on the window loads it', async () => {
      const text = readFileSync(savedPath, 'utf8');
      await ev((text) => {
        const dt = new DataTransfer();
        dt.items.add(new File([text], 'dropped.json', { type: 'application/json' }));
        window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
        const shown = document.querySelector('.drop').classList.contains('show');
        const label = document.querySelector('.drop').textContent;
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        if (!shown) throw new Error('drop overlay not shown on dragenter');
        if (label !== 'Drop a saved world (.json) to load it') throw new Error(`drop overlay says "${label}"`);
      }, text);
      await waitFor((t) => window.app.sim.tick === t, saved.tick);
      assert(!(await ev(() => document.querySelector('.drop').classList.contains('show'))), 'drop overlay stuck');
    });
    await check('Ctrl+S saves, Ctrl+O opens the file chooser', async () => {
      await page.locator('canvas.world').focus();
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.keyboard.press('Control+s')]);
      assert(dl.suggestedFilename().endsWith('.json'), dl.suggestedFilename());
      await stepN(5);
      await loadThroughChooser(() => page.keyboard.press('Control+o'), savedPath);
      await waitFor((t) => window.app.sim.tick === t, saved.tick);
    });
    await check('Load a saved world on the start screen loads it and starts', async () => {
      await stepN(7);
      await page.locator('.exp-btn').click();
      await loadThroughChooser(() => page.locator('.st-links .link', { hasText: 'Load a saved world' }).click(), savedPath);
      await waitFor((t) => window.app.sim.tick >= t && !window.app.startOpen, saved.tick);
      const st = await ev(() => ({ open: window.app.startOpen, running: window.app.running, id: window.app.sim.state.scenarioId, top: document.querySelector('.exp-name').textContent }));
      await ev(() => window.app.setPaused(true));
      assert(!st.open && st.running && st.id === 'eden' && st.top === 'Garden of Eden', JSON.stringify(st));
    });
  });

  // =================================================================== notices
  await section('notices', async () => {
    // Evolution Laboratory schedules a climate shift on day 3 (tick 1200): a major event, so a notice
    const toBefore = async (t) => {
      await fresh('evolab', 12345, t);
      await ev(() => {
        const a = window.app;
        const evs = a.sim.state.events;
        a.lastEventId = evs.length ? evs[evs.length - 1].id : 0; // only what happens from now on
        a.pendingEvent = null;
        a.lastEventToast = -Infinity;
        a.toaster.clear();
      });
    };
    let first = null;
    await check('a scheduled disaster raises one short notice at the bottom centre of the map', async () => {
      await toBefore(1195);
      await stepN(8);
      await page.locator('.toasts .toast-major, .toasts .toast-good').first().waitFor({ timeout: 3000 });
      first = await ev(() => {
        const t = document.querySelector('.toasts .toast');
        const r = t.getBoundingClientRect();
        const s = document.querySelector('.stage').getBoundingClientRect();
        return { text: t.textContent, n: document.querySelectorAll('.toasts .toast').length, cx: (r.left + r.right) / 2, scx: (s.left + s.right) / 2, bottom: s.bottom - r.bottom, w: r.width, at: performance.now() };
      });
      assert(first.n === 1 && /Climate shift/.test(first.text), JSON.stringify(first));
      assert(Math.abs(first.cx - first.scx) < 2 && first.bottom >= 8 && first.bottom < 120 && first.w <= 560, `placed at ${JSON.stringify(first)}`);
      assert(first.text.length < 160, `notice is ${first.text.length} characters long`);
      return first.text;
    });
    await check('the next notice waits at least 8 s', async () => {
      if (!first) throw new Error('no first notice');
      // day 5 (tick 2400) brings the next climate shift
      await ev(() => {
        const a = window.app;
        for (let i = a.sim.tick; i < 2405; i++) a.sim.step();
      });
      await sleep(800);
      const soon = await ev(() => [...document.querySelectorAll('.toasts .toast')].map((t) => t.textContent));
      await page.waitForFunction((t) => [...document.querySelectorAll('.toasts .toast')].some((x) => x.textContent !== t && /Climate shift|cold/i.test(x.textContent)), first.text, { timeout: 12_000, polling: 200 });
      const at = await ev(() => performance.now());
      const gap = (at - first.at) / 1000;
      assert(!soon.some((t) => t !== first.text && /cold/i.test(t)), `second notice right away: ${soon}`);
      assert(gap >= 7.9, `second notice after ${gap.toFixed(1)} s`);
      return `${gap.toFixed(1)} s apart`;
    });
    await check('the dismiss button closes a notice', async () => {
      await page.locator('.toasts .toast .toast-x').first().click();
      assert((await page.locator('.toasts .toast').count()) === 0, 'notice still shown');
    });
    await check('with notices off, the same event raises none', async () => {
      await openDrawer();
      await toggleCtl('.drawer', 'Pop-up notices').click();
      await ev(() => window.app.showSettings(false));
      await toBefore(1195);
      await stepN(8);
      await sleep(1200);
      const n = await ev(() => document.querySelectorAll('.toasts .toast-major, .toasts .toast-good').length);
      await openDrawer();
      await toggleCtl('.drawer', 'Pop-up notices').click();
      await ev(() => window.app.showSettings(false));
      assert(n === 0, `${n} notices with notices turned off`);
    });
    await check('never more than one notice at a time (whole session so far)', async () => {
      const st = await ev(() => ({ max: window.__toastMax, n: window.__toastLog.length, kinds: [...new Set(window.__toastLog.map((t) => t.cls.replace(/^toast /, '')))] }));
      assert(st.max <= 1, `${st.max} notices at once`);
      return `${st.n} notices shown, kinds ${st.kinds.join(', ')}`;
    });
    await check('tooltips appear on hover', async () => {
      await fresh('eden', 12345, 30);
      const tipOf = async (loc) => {
        await page.mouse.move(700, 20);
        await sleep(100);
        await loc.hover();
        await sleep(550);
        return ev(() => ({ show: document.querySelector('.tip').classList.contains('show'), text: document.querySelector('.tip').textContent }));
      };
      const a = await tipOf(page.locator('.play-btn'));
      const b = await tipOf(page.locator('.rail-btn').first());
      await setTab('Overview');
      const c = await tipOf(page.locator('.pane-stats .an-key').first());
      await page.mouse.move(700, 20);
      assert(a.show && a.text === 'Play or pause (Space)', `play: ${JSON.stringify(a)}`);
      assert(b.show && b.text === 'Inspect (1)', `rail: ${JSON.stringify(b)}`);
      assert(c.show && c.text.startsWith('Agents alive now'), `key number: ${JSON.stringify(c)}`);
    });
  });

  // =================================================================== design rules (styles and words)
  await section('design rules', async () => {
    await fresh('two-civs', 12345, 1800);
    const all = { style: [], text: [] };
    const take = async (label) => {
      await frames(2);
      await sleep(120);
      const s = await ev(styleAudit);
      const t = await ev(textAudit);
      for (const x of s) all.style.push(`${x} [${label}]`);
      for (const x of t) all.text.push(`${x} [${label}]`);
    };
    // every view of the app, one after the other
    await setTab('Overview');
    await page.locator('.pane-stats summary.an-more-title').click();
    for (let i = 0; i < (await page.locator('.pane-stats details.an-sec').count()); i++) {
      const d = page.locator('.pane-stats details.an-sec').nth(i);
      if (!(await d.evaluate((x) => x.open))) await d.locator('summary').click();
    }
    await take('Overview');
    await page.locator('.pane-stats summary.an-more-title').click();
    await ev(() => {
      const a = window.app.sim.state.agents.find((x) => x.relationships.length > 2 && x.history.length > 1) || window.app.sim.state.agents[0];
      window.app.select(a.id);
    });
    await setTab('Agent');
    for (const s of await page.locator('.pane-inspector summary.insp-sec-title').all()) await s.click();
    await take('Agent');
    await setTab('Events');
    await take('Events');
    await openMore();
    await take('Settings');
    await ev(() => window.app.showSettings(false));
    await openLayers();
    await take('Layers');
    await closeLayers();
    await page.locator('.speed-label').click();
    await take('Speed menu');
    await page.keyboard.press('Escape');
    for (const k of ['2', '7', '8']) {
      await page.keyboard.press(k);
      if (k === '2' && !(await page.locator('.tool-panel .designer details.fold').evaluate((d) => d.open))) await page.locator('.tool-panel .designer details.fold > summary').click();
      await take(`tool ${k}`);
    }
    await page.keyboard.press('1');
    await page.keyboard.press('h');
    await take('Help');
    await page.keyboard.press('Escape');
    {
      // hover card and a notice
      const a = await ev(() => {
        const ag = window.__ui.isolatedAgent(10);
        window.__ui.centre(ag.x, ag.y, 3);
        return { x: ag.x, y: ag.y };
      });
      await frames(2);
      const p = await ev(({ x, y }) => window.__ui.screenOf(x, y), a);
      await page.mouse.move(p.x, p.y, { steps: 3 });
      await ev(() => window.app.confirm('Saved a test notice.'));
      await take('hover card and notice');
      await page.mouse.move(700, 20);
    }
    await page.locator('.exp-btn').click();
    await take('start screen');
    await page.keyboard.press('Escape');
    const by = (re) => [...new Set(all.style.filter((s) => re.test(s)))];
    const report = (list) => list.slice(0, 8).join('; ') + (list.length > 8 ? ` (and ${list.length - 8} more)` : '');
    await check('no gradients, glass, blur or text shadows', async () => {
      const bad = by(/^(gradient|backdrop|filter|text-shadow)/);
      assert(!bad.length, report(bad));
    });
    await check('one subtle shadow, on floating menus and popovers only', async () => {
      const bad = by(/^box-shadow/);
      assert(!bad.length, report(bad));
    });
    await check('sentence case: no uppercase, letter-spacing, italic or monospace text', async () => {
      const bad = by(/^(uppercase|letter-spacing|monospace|italic)/);
      assert(!bad.length, report(bad));
    });
    await check('no coloured left stripes', async () => {
      const bad = by(/^left stripe/);
      assert(!bad.length, report(bad));
    });
    await check('2 px radius on controls, square panels', async () => {
      const bad = by(/^(radius|panel radius)/);
      assert(!bad.length, report(bad));
    });
    await check('no purple, indigo, violet, magenta, cyan or teal', async () => {
      const bad = by(/^(color|background|border) /);
      assert(!bad.length, report(bad));
    });
    await check('words: no dashes, symbol icons or all-caps labels anywhere in the text', async () => {
      const bad = [...new Set(all.text)];
      assert(!bad.length, report(bad));
    });
    await check('the map is drawn without gradients, glows or blur', async () => {
      const st = await ev(() => window.__canvasStyle);
      assert(!st.gradients && !st.shadows && !st.filters, `${st.gradients} gradients, ${st.shadows} shadows, ${st.filters} filters: ${st.where.join(' | ')}`);
    });
    await check('no console errors in the main session', async () => {
      const errs = pageErrors.filter((e) => e.startsWith('[main]'));
      assert(!errs.length, errs.join(' | '));
    });
  });
  await context.close();

  // =================================================================== URL options
  await section('url', async () => {
    await check('#run=<id>&seed=<n> skips the start screen and runs that experiment', async () => {
      const { ctx, p } = await openPage(1280, 720, 'url', '#run=plague-island&seed=9');
      page = p;
      await sleep(400);
      const st = await ev(() => ({ open: window.app.startOpen, running: window.app.running, id: window.app.sim.state.scenarioId, seed: window.app.sim.config.seed, t: window.app.sim.tick }));
      await ctx.close();
      assert(!st.open && st.running && st.id === 'plague-island' && st.seed === 9 && st.t > 0, JSON.stringify(st));
    });
    await check('#run runs the default experiment at once', async () => {
      const { ctx, p } = await openPage(1280, 720, 'url', '#run');
      page = p;
      await sleep(400);
      const st = await ev(() => ({ open: window.app.startOpen, running: window.app.running, id: window.app.sim.state.scenarioId, t: window.app.sim.tick }));
      await ctx.close();
      assert(!st.open && st.running && st.id === 'eden' && st.t > 0, JSON.stringify(st));
    });
  });

  // =================================================================== layout and contrast
  for (const [w, hgt] of [
    [1280, 720],
    [1440, 900],
    [1920, 1080],
  ]) {
    await section(`layout ${w}x${hgt}`, async () => {
      const { ctx, p } = await openPage(w, hgt, `layout-${w}`);
      page = p;
      const states = [
        ['start screen', async () => {}],
        [
          'main screen',
          async () => {
            await page.locator('.st-start').click();
            await ev(() => window.app.setPaused(true));
          },
        ],
        [
          'Add agents tool, genes open, Agent tab',
          async () => {
            await page.keyboard.press('2');
            if (!(await page.locator('.tool-panel .designer details.fold').evaluate((d) => d.open))) await page.locator('.tool-panel .designer details.fold > summary').click();
            await ev(() => {
              const a = window.app.sim.state.agents[0];
              window.app.select(a.id);
              window.app.follow(a.id);
            });
          },
        ],
        [
          'Paint terrain tool, Events tab, data layer',
          async () => {
            await page.keyboard.press('7');
            await setTab('Events');
            await ev(() => window.app.setOverlay('territory'));
          },
        ],
        [
          'Disaster tool, More charts and help',
          async () => {
            await page.keyboard.press('8');
            await ev(() => window.app.setOverlay('disease'));
            await setTab('Overview');
            await page.locator('.pane-stats summary.an-more-title').click();
            await page.keyboard.press('h');
          },
        ],
        [
          'Settings drawer with More settings',
          async () => {
            await page.keyboard.press('Escape');
            await page.keyboard.press('1');
            await openMore();
          },
        ],
        [
          'Layers menu and the speed menu',
          async () => {
            await ev(() => window.app.showSettings(false));
            await openLayers();
          },
        ],
      ];
      for (const [label, setup] of states) {
        await check(label, async () => {
          await setup();
          await sleep(350);
          await frames(3);
          const issues = await ev(layoutAudit);
          if (shotsDir) {
            mkdirSync(shotsDir, { recursive: true });
            await page.screenshot({ path: join(shotsDir, `layout-${w}x${hgt}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`) });
          }
          assert(!issues.length, issues.slice(0, 12).join('; ') + (issues.length > 12 ? ` (and ${issues.length - 12} more)` : ''));
        });
      }
      await check('every experiment is in view on the start screen', async () => {
        await closeLayers();
        await page.locator('.exp-btn').click();
        await page.locator('.st-item').first().click();
        await sleep(200);
        const st = await ev(() => {
          const box = document.querySelector('.st-scroll').getBoundingClientRect();
          return [...document.querySelectorAll('.st-item')].map((b) => {
            const r = b.getBoundingClientRect();
            return { name: b.querySelector('.st-item-name').textContent, ok: r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 };
          });
        });
        await page.keyboard.press('Escape');
        const hidden = st.filter((x) => !x.ok).map((x) => x.name);
        assert(st.length === 7 && !hidden.length, `scrolled out of view: ${hidden.join(', ')}`);
      });
      await check('the map gets most of the window', async () => {
        await closeLayers();
        const st = await ev(() => {
          const c = window.__ui.canvasRect();
          return { share: (c.w * c.h) / (window.innerWidth * window.innerHeight), w: c.w, h: c.h };
        });
        assert(st.share >= 0.62, `the map covers ${(st.share * 100).toFixed(0)}% of the window`);
        return `${st.w}x${st.h} px, ${(st.share * 100).toFixed(0)}% of the window`;
      });
      await check('opening menus, folds, the drawer and the start screen never scrolls the page', async () => {
        const bad = [];
        const probe = async (what) => {
          await sleep(250);
          const st = await ev(() => ({ y: window.scrollY, body: document.body.scrollTop, app: document.querySelector('#app').scrollTop, al: document.querySelector('.al').scrollTop, stage: document.querySelector('.stage').scrollTop, top: document.querySelector('.al').getBoundingClientRect().top }));
          if (st.y || st.body || st.app || st.al || st.stage || st.top !== 0) bad.push(`${what}: ${JSON.stringify(st)}`);
        };
        await openLayers();
        await probe('layers');
        await closeLayers();
        await page.locator('.speed-label').click();
        await probe('speed menu');
        await page.keyboard.press('Escape');
        await openMore();
        await probe('drawer');
        await ev(() => window.app.showSettings(false));
        await page.keyboard.press('2');
        await probe('tool panel');
        await page.keyboard.press('1');
        await page.locator('.exp-btn').click();
        for (const n of ['Plague Island', 'Wolves Among Sheep', 'Garden of Eden']) {
          const item = page.locator('.st-item', { has: page.locator('.st-item-name', { hasText: exact(n) }) });
          if (await item.count()) await item.click();
        }
        await probe('start screen');
        await page.keyboard.press('Escape');
        assert(!bad.length, bad.join('; '));
      });
      await check('a window resize keeps the canvas sharp and the view centred', async () => {
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
        assert(Math.abs(st.cw - Math.floor(st.rw * st.dpr)) <= 1 && Math.abs(st.ch - Math.floor(st.rh * st.dpr)) <= 1, `backing store ${st.cw}x${st.ch} for ${st.rw}x${st.rh} CSS px`);
        assert(Math.abs(st.vw - st.rw) < 1 && Math.abs(st.vh - st.rh) < 1, `camera view ${st.vw}x${st.vh} vs canvas ${st.rw}x${st.rh}`);
        approx(st.x, before.x, 1, 'camera x after resize');
        approx(st.y, before.y, 1, 'camera y after resize');
        return `${st.rw}x${st.rh} to ${st.cw}x${st.ch} px`;
      });
      if (w === 1440) {
        await check('text contrast (WCAG AA) of all visible text', async () => {
          const fails = [];
          await page.locator('.exp-btn').click();
          await sleep(250);
          fails.push(...(await ev(contrastAudit)));
          await page.keyboard.press('Escape');
          await ev(() => window.app.select(window.app.sim.state.agents[0].id));
          await sleep(300);
          for (const tab of ['Agent', 'Overview', 'Events']) {
            await setTab(tab);
            await sleep(250);
            fails.push(...(await ev(contrastAudit)));
          }
          await page.keyboard.press('2');
          await sleep(200);
          fails.push(...(await ev(contrastAudit)));
          await page.keyboard.press('8');
          await sleep(200);
          fails.push(...(await ev(contrastAudit)));
          await page.keyboard.press('1');
          await openMore();
          await sleep(200);
          fails.push(...(await ev(contrastAudit)));
          await ev(() => window.app.showSettings(false));
          await openLayers();
          fails.push(...(await ev(contrastAudit)));
          await closeLayers();
          await ev(() => window.app.confirm('Restarted the test notice.'));
          await sleep(300);
          fails.push(...(await ev(contrastAudit)));
          await page.keyboard.press('h');
          await sleep(250);
          fails.push(...(await ev(contrastAudit)));
          await page.keyboard.press('Escape');
          const uniq = [...new Map(fails.map((f) => [f.key, f])).values()];
          for (const f of uniq.slice(0, 40)) info(`low contrast ${f.ratio.toFixed(2)}:1 (below ${f.need}) ${f.sel} "${f.text}" ${f.fg} on ${f.bg}`);
          assert(!uniq.length, `${uniq.length} text styles below WCAG AA`);
          return 'all at least AA';
        });
      }
      await ctx.close();
    });
  }

  // =================================================================== performance
  if (runPerf) {
    await section('performance', async () => {
      const { ctx, p } = await openPage(1440, 900, 'perf', '#run=eden&seed=12345');
      page = p;
      await check('about 1000 agents: FPS at 1x and Max', async () => {
        await ev(() => window.app.setPaused(true));
        await page.keyboard.press('2');
        await setRange(slider('.tool-panel .designer', 'Group size'), 100);
        const cap = await ev(() => window.app.sim.config.maxAgents);
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
            [0.4, 0.4],
            [0.6, 0.6],
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
          if ((await pop()) >= Math.min(990, cap - 5)) break;
        }
        const n = await pop();
        assert(n >= Math.min(900, cap * 0.9), `only ${n} agents (cap ${cap})`);
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
        await pickSpeed(2);
        await ev(() => window.app.setPaused(false));
        await sleep(800);
        const one = await measure();
        await pickSpeed(9);
        await sleep(800);
        const max = await measure();
        await ev(() => window.app.setPaused(true));
        info(`perf @${one.n} agents, 1x: ${one.fps.toFixed(1)} FPS, ${one.tps.toFixed(1)} TPS, render ${one.draw.toFixed(2)} ms per frame`);
        info(`perf @${max.n} agents, Max: ${max.fps.toFixed(1)} FPS, ${max.tps.toFixed(1)} TPS, render ${max.draw.toFixed(2)} ms per frame`);
        assert(one.fps >= 20, `1x runs at ${one.fps.toFixed(1)} FPS`);
        assert(max.fps >= 10 && max.tps > one.tps, `Max: ${max.fps.toFixed(1)} FPS, ${max.tps.toFixed(1)} TPS`);
        return `1x: ${one.fps.toFixed(0)} FPS, Max: ${max.fps.toFixed(0)} FPS and ${max.tps.toFixed(0)} TPS`;
      });
      await check('close zoom with about 1000 agents still draws fast', async () => {
        const r = await ev(async () => {
          const a = window.app;
          const t = [...a.sim.state.tribes].filter((x) => x.extinctTick === -1).sort((x, y) => y.members - x.members)[0];
          window.__ui.centre(t ? t.homeX : a.sim.worldW / 2, t ? t.homeY : a.sim.worldH / 2, 5);
          a.setPaused(false);
          await new Promise((res) => setTimeout(res, 2500));
          a.setPaused(true);
          return { draw: a.renderer.stats.drawMs, fps: a.renderer.stats.fps, lines: a.renderer.stats.connections, drawn: a.renderer.stats.agentsDrawn };
        });
        info(`perf close zoom (5 px per unit): render ${r.draw.toFixed(2)} ms per frame, ${r.drawn} agents and ${r.lines} connections drawn, ${r.fps.toFixed(0)} FPS`);
        assert(r.draw < 30, `render ${r.draw.toFixed(1)} ms per frame`);
        return `${r.draw.toFixed(1)} ms per frame`;
      });
      await ctx.close();
    });
  }
} catch (err) {
  console.error(`audit aborted: ${err.stack || err.message}`);
  results.push({ name: `${group} > (aborted)`, ok: false, error: err.message });
} finally {
  await browser.close().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------------ layout audit (runs in the page)
function layoutAudit() {
  const out = [];
  const de = document.documentElement;
  if (de.scrollWidth > window.innerWidth + 1 || document.body.scrollWidth > window.innerWidth + 1) out.push(`horizontal page overflow ${de.scrollWidth}px > ${window.innerWidth}px`);
  if (de.scrollHeight > window.innerHeight + 1) out.push(`vertical page overflow ${de.scrollHeight}px`);
  const vis = window.__ui.visible;
  for (const sc of document.querySelectorAll('.pane.on, .modal, .drawer-body, .tool-panel, .st-scroll, .start, .menu')) {
    if (vis(sc) && sc.scrollWidth > sc.clientWidth + 1) out.push(`${sc.className} scrolls sideways (${sc.scrollWidth} > ${sc.clientWidth})`);
  }
  const name = (el) =>
    `${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className)
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join('.')}${el.textContent?.trim() ? ` "${el.textContent.trim().slice(0, 24)}"` : ''}`;
  const clipper = (el) => {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') return e;
    }
    return null;
  };
  const modalOpen = !!document.querySelector('.modal-back.show');
  const drawerOpen = !!document.querySelector('.drawer.show');
  // popovers float above the map controls; overlaps are only judged inside one layer
  const layer = (e) => e.closest('.modal-back, .menu.show, .tool-panel, .drawer, .start, .hover-card') || document.body;
  const covered = (e) => (modalOpen && !e.closest('.modal')) || (drawerOpen && !!e.closest('.side'));
  const sel = 'button, input:not([type=file]):not([type=checkbox]), select, label.ctl-toggle, summary, .pill, .hint-box, .clock, .pop-text, .exp-btn, .st-item';
  const els = [...document.querySelectorAll(sel)].filter((e) => vis(e) && !e.closest('.toasts') && !e.closest('.tip') && !covered(e));
  for (const e of els) {
    const r = e.getBoundingClientRect();
    const c = clipper(e);
    // content scrolled away inside a pane is not outside the window
    const scrolls = c && getComputedStyle(c).overflowY !== 'visible';
    if (r.left < -0.5 || r.right > window.innerWidth + 0.5 || (!scrolls && (r.top < -0.5 || r.bottom > window.innerHeight + 0.5)))
      out.push(`${name(e)} outside the window (${Math.round(r.left)} to ${Math.round(r.right)}, ${Math.round(r.top)} to ${Math.round(r.bottom)})`);
    if (c) {
      const cr = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      // horizontal clipping only (vertical clipping inside scroll panes is scrolling)
      if (cs.overflowX !== 'visible' && (r.left < cr.left - 0.5 || r.right > cr.right + 0.5)) out.push(`${name(e)} clipped by ${name(c).slice(0, 40)} (${Math.round(r.left)} to ${Math.round(r.right)} vs ${Math.round(cr.left)} to ${Math.round(cr.right)})`);
    }
  }
  // the part of an element that is on screen: its box cut by every scrolling or clipping ancestor
  const shown = (e) => {
    const r = e.getBoundingClientRect();
    let { left, top, right, bottom } = r;
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const q = p.getBoundingClientRect();
      left = Math.max(left, q.left);
      top = Math.max(top, q.top);
      right = Math.min(right, q.right);
      bottom = Math.min(bottom, q.bottom);
    }
    return { left, top, right, bottom };
  };
  const boxes = els.map((e) => ({ e, r: shown(e), l: layer(e) })).filter((b) => b.r.right - b.r.left > 1 && b.r.bottom - b.r.top > 1);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.l !== b.l || a.e.contains(b.e) || b.e.contains(a.e)) continue;
      const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ix > 1 && iy > 1) out.push(`${name(a.e)} overlaps ${name(b.e)} (${Math.round(ix)}x${Math.round(iy)} px)`);
    }
  }
  // truncated labels (ellipsis): experiment taglines may wrap, never truncate
  for (const e of document.querySelectorAll(
    '.ctl-label, .chip-label, .btn, .tab, .st-item-name, .an-chip, .ev-chip, .insp-btn, .an-seg, .rail-btn, .exp-name, .menu-item, .pill, .tp-title > span, .an-key-label, .an-tribe-name, .insp-util-name, .insp-meter-label, .insp-trait-name, .insp-row-label',
  )) {
    if (!vis(e) || covered(e)) continue;
    const cs = getComputedStyle(e);
    if ((cs.textOverflow === 'ellipsis' || cs.overflow === 'hidden') && e.scrollWidth > e.clientWidth + 1) out.push(`truncated text ${name(e)} (${e.scrollWidth} > ${e.clientWidth})`);
  }
  // canvas-drawn parts of the map (minimap, legends) against the controls over the map
  const c = window.__ui.canvasRect();
  const canvasBoxes = [];
  const add = (nm, rr, pad = 0) => {
    if (rr && rr.visible) canvasBoxes.push([nm, { left: c.x + rr.x - pad, top: c.y + rr.y - pad, right: c.x + rr.x + rr.w + pad, bottom: c.y + rr.y + rr.h + pad }]);
  };
  if (!document.querySelector('.al.start-open')) {
    add('minimap', window.app.renderer.minimapRect, 4);
    add('data legend', window.app.renderer.legendRect);
    add('connections legend', window.app.renderer.connectionsLegendRect);
  }
  const hud = [...document.querySelectorAll('.rail, .tool-panel, .pills .pill, .map-tr > .layers-btn, .zoom, .hint-box')].filter(vis);
  // the options panel of a tool stays open while it is used: it must not cover the map's own controls
  for (const tp of document.querySelectorAll('.tool-panel')) {
    if (!vis(tp)) continue;
    const a = tp.getBoundingClientRect();
    for (const e of document.querySelectorAll('.pills .pill, .map-tr > .layers-btn, .zoom, .hint-box, .rail')) {
      if (!vis(e)) continue;
      const b = e.getBoundingClientRect();
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0) out.push(`the tool options panel covers ${name(e)}`);
    }
  }
  for (const [nm, r] of canvasBoxes) {
    for (const e of hud) {
      const b = e.getBoundingClientRect();
      const ix = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const iy = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      if (ix > 0 && iy > 0) out.push(`${nm} (canvas) sits under ${name(e)}`);
    }
    if (r.left < c.x - 0.5 || r.right > c.x + c.w + 0.5 || r.top < c.y - 0.5 || r.bottom > c.y + c.h + 0.5) out.push(`${nm} outside the canvas`);
  }
  for (let i = 0; i < canvasBoxes.length; i++)
    for (let j = i + 1; j < canvasBoxes.length; j++) {
      const [na, a] = canvasBoxes[i];
      const [nb, b] = canvasBoxes[j];
      if (Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)) out.push(`${na} overlaps the ${nb}`);
    }
  return [...new Set(out)];
}

// ------------------------------------------------------------------ design rules (run in the page)
/** Computed styles of every visible element against the design direction. */
function styleAudit() {
  const out = [];
  const ui = window.__ui;
  const probe = document.createElement('div');
  probe.style.boxShadow = getComputedStyle(document.documentElement).getPropertyValue('--pop-shadow');
  document.body.append(probe);
  const pop = getComputedStyle(probe).boxShadow;
  probe.remove();
  const name = (el) => `${el.tagName.toLowerCase()}${el.classList && el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : ''}`;
  const rgb = (s) => {
    const m = s && s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const hsl = ({ r, g, b }) => {
    r /= 255;
    g /= 255;
    b /= 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    const d = mx - mn;
    if (!d) return { h: 0, s: 0, l };
    const s = d / (1 - Math.abs(2 * l - 1));
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return { h, s, l };
  };
  // teal and cyan (160 to 196 degrees), indigo, violet, purple and magenta (228 to 335 degrees)
  const banned = (c) => {
    if (!c || c.a < 0.2) return false;
    const { h, s, l } = hsl(c);
    return s > 0.3 && l > 0.15 && l < 0.85 && ((h >= 160 && h <= 196) || (h >= 228 && h <= 335));
  };
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg') || el.tagName === 'CANVAS' || !ui.visible(el)) continue;
    const cs = getComputedStyle(el);
    const n = name(el);
    if (cs.backgroundImage && cs.backgroundImage.includes('gradient')) out.push(`gradient: ${n}`);
    if (cs.backdropFilter && cs.backdropFilter !== 'none') out.push(`backdrop-filter: ${n}`);
    if (cs.filter && cs.filter !== 'none') out.push(`filter ${cs.filter}: ${n}`);
    if (cs.textShadow && cs.textShadow !== 'none') out.push(`text-shadow: ${n}`);
    if (cs.boxShadow && cs.boxShadow !== 'none' && cs.boxShadow !== pop) out.push(`box-shadow "${cs.boxShadow}": ${n}`);
    const hasText = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    if (hasText) {
      if (cs.textTransform === 'uppercase' || cs.fontVariantCaps === 'all-small-caps' || cs.fontVariantCaps === 'small-caps') out.push(`uppercase: ${n}`);
      const ls = parseFloat(cs.letterSpacing);
      if (Number.isFinite(ls) && ls > parseFloat(cs.fontSize) * 0.02 + 0.01) out.push(`letter-spacing ${cs.letterSpacing}: ${n}`);
      if (/mono|courier|consolas|menlo/i.test(cs.fontFamily)) out.push(`monospace ${cs.fontFamily}: ${n}`);
      if (cs.fontStyle === 'italic') out.push(`italic: ${n}`);
    }
    const bl = parseFloat(cs.borderLeftWidth);
    if (bl >= 2 && cs.borderLeftStyle !== 'none' && bl > parseFloat(cs.borderRightWidth) + 0.5 && bl > parseFloat(cs.borderTopWidth) + 0.5) out.push(`left stripe ${bl}px: ${n}`);
    if (el.matches('button, input, select, .chip, .toast, .pill, kbd, .menu-item')) {
      const r = cs.borderTopLeftRadius;
      if (!r.endsWith('%') && parseFloat(r) > 2.01) out.push(`radius ${r}: ${n}`);
    }
    if (el.matches('.tool-panel, .menu, .drawer, .side, .start, .modal, .hover-card, .hint-box, .st-entry, .dsec, .an-block, .insp-block')) {
      if (parseFloat(cs.borderTopLeftRadius) > 0) out.push(`panel radius ${cs.borderTopLeftRadius}: ${n}`);
    }
    // data colours (tribe swatches, legend keys) are set inline from the simulation; everything else is the palette
    const inline = el.getAttribute('style') || '';
    if (!/background|color/.test(inline)) {
      if (hasText && banned(rgb(cs.color))) out.push(`color ${cs.color}: ${n}`);
      if (banned(rgb(cs.backgroundColor))) out.push(`background ${cs.backgroundColor}: ${n}`);
      if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && banned(rgb(cs.borderTopColor))) out.push(`border ${cs.borderTopColor}: ${n}`);
    }
  }
  return [...new Set(out)];
}

/** Visible text, tooltips, labels and placeholders against the writing rules. */
function textAudit() {
  const out = [];
  // dashes, minus, multiplication sign, ellipsis, curly quotes, arrows, bullets, middle dot, degree,
  // approximately, dagger, check marks, symbol and emoji ranges
  const bad = /[\u2012-\u2015\u2212\u00d7\u2026\u2018\u2019\u201c\u201d\u2190-\u21ff\u2022\u00b7\u00b0\u2248\u2020\u2021\u2600-\u27bf\u2b00-\u2bff\u{1f000}-\u{1faff}]/u;
  const caps = /\b[A-Z]{3,}\b/;
  const show = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 60);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent;
    if (!t.trim() || !n.parentElement || !window.__ui.visible(n.parentElement) || n.parentElement.closest('script, style, noscript')) continue;
    const m = bad.exec(t);
    if (m) out.push(`character U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} in "${show(t)}"`);
    if (caps.test(t)) out.push(`all caps in "${show(t)}"`);
  }
  for (const el of document.querySelectorAll('[data-tip], [aria-label], [placeholder], [title]')) {
    for (const a of ['data-tip', 'aria-label', 'placeholder', 'title']) {
      const v = el.getAttribute(a);
      if (!v) continue;
      const m = bad.exec(v);
      if (m) out.push(`character U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} in ${a} "${show(v)}"`);
      if (caps.test(v)) out.push(`all caps in ${a} "${show(v)}"`);
    }
  }
  return [...new Set(out)];
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
    const c = parse(cs.backgroundColor);
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
    if (!base) base = [19, 18, 16, 1];
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
    if (!window.__ui.visible(el) || el.closest('.tip, [disabled], .insp-dead, noscript') || el.closest('button:disabled')) continue;
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
  console.log(`  console or page errors (${strayErrors.length}):`);
  for (const e of strayErrors.slice(0, 20)) console.log(`    - ${e}`);
}
console.log(`ui-audit: ${passed} passed, ${failed.length} failed${skipped ? `, ${skipped} skipped` : ''} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED ${f.name}: ${f.error}`);
  process.exit(1);
}
if (strayErrors.length) process.exit(1);
console.log('Every audited control works.');
