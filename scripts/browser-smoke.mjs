#!/usr/bin/env node
/**
 * Browser smoke test (OWNER: UI).
 *
 *   npm run build && node scripts/browser-smoke.mjs
 *   node scripts/browser-smoke.mjs --url https://rahv-fb.github.io/AL/ --out docs/screenshot.png
 *   node scripts/browser-smoke.mjs --file path/to/index.html --no-screenshot
 *
 * Loads the single-file build (dist/index.html) over file:// in headless Chromium and FAILS (exit 1) on:
 *   - any console error, uncaught page error or failed request
 *   - a blank or near-uniform map canvas
 *   - a world that runs before Start, or a run that does not start
 * It opens on the start screen, picks Two Civilizations, presses Start, lets a few in-game hours
 * pass, zooms in on a camp, clicks an agent so the Agent tab opens, and saves a 1440x900
 * screenshot to docs/screenshot.png. Then it tries the transport controls and a few shortcuts.
 *
 * Options: --url <url>, --file <html>, --wait <ms> (extra settle time after load, default 800),
 * --out <png>, --scale <n> (device pixel ratio of the screenshot, default 1), --no-screenshot.
 * Needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`,
 * or a global install reachable through NODE_PATH).
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const distFile = resolve(opt('file', resolve(root, 'dist/index.html')));
const url = opt('url', pathToFileURL(distFile).href);
const waitMs = Number(opt('wait', '800'));
const outFile = resolve(root, opt('out', 'docs/screenshot.png'));
const scale = Number(opt('scale', '1'));
const takeShot = !flag('no-screenshot');
/** In-game time to let pass before the screenshot (a day is 600 ticks, so 25 ticks an hour). */
const HOURS = 6;

async function loadPlaywright() {
  // CommonJS resolution honours NODE_PATH (global installs); ESM import does not.
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    try {
      return await import('playwright');
    } catch {
      console.error('Playwright not found. Install it: npm i -D playwright && npx playwright install chromium');
      process.exit(2);
    }
  }
}

const problems = [];
const notes = [];
const log = (m) => console.log(m);

if (url.startsWith('file:') && !existsSync(fileURLToPath(url))) {
  console.error(`${fileURLToPath(url)} not found. Run "npm run build" first.`);
  process.exit(2);
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scale });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
    else if (msg.type() === 'warning') notes.push(`console.warn: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => problems.push(`request failed: ${req.url()} (${req.failure()?.errorText ?? '?'})`));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  log(`loading ${url}`);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  await page.waitForFunction(() => window.app && window.app.sim && document.querySelector('canvas.world'), null, { timeout: 15_000 });
  await page.waitForTimeout(waitMs);
  log(`  loaded in ${Date.now() - t0} ms`);

  // ---- canvas check: the map canvas must show a real image (the preview behind the start screen)
  const canvasStats = async (label) => {
    const main = page.locator('canvas.world');
    const png = await main.screenshot();
    // decode the PNG in a blank page (a data: URL is never tainted)
    const probe = await context.newPage();
    const stats = await probe.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const colors = new Set();
      let sum = 0;
      let sum2 = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 7) {
        colors.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        sum += l;
        sum2 += l * l;
        n++;
      }
      const mean = sum / n;
      return { w: c.width, h: c.height, colors: colors.size, mean, sd: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
    }, png.toString('base64'));
    await probe.close();
    log(`  ${label}: canvas ${stats.w}x${stats.h}, ${stats.colors} colours, luminance mean ${stats.mean.toFixed(1)} sd ${stats.sd.toFixed(1)}`);
    if (stats.colors < 16 || stats.sd < 4) problems.push(`${label}: the map looks blank (${stats.colors} colours, sd ${stats.sd.toFixed(1)})`);
  };

  // ---- the start screen: nothing runs until Start
  const start = await ev(() => ({ open: window.app.startOpen, running: window.app.running, tick: window.app.sim.tick, items: document.querySelectorAll('.st-item').length }));
  await page.waitForTimeout(600);
  const tickLater = await ev(() => window.app.sim.tick);
  if (!start.open) problems.push('the app did not open on the start screen');
  if (start.running || tickLater !== start.tick) problems.push(`the world runs before Start (tick ${start.tick} then ${tickLater})`);
  log(`  start screen: ${start.items} experiments, tick ${tickLater}`);
  await canvasStats('start screen preview');

  // ---- pick Two Civilizations with its own seed and start it
  const item = page.locator('.st-item', { has: page.locator('.st-item-name', { hasText: /^Two Civilizations$/ }) });
  if (!(await item.count())) throw new Error('Two Civilizations is not in the experiment list');
  await item.click();
  await page.locator('#st-seed').fill('');
  await page.waitForFunction(() => window.app.shownSim && window.app.shownSim.state.scenarioId === 'two-civs', null, { timeout: 5000 });
  await page.locator('.st-start').click();
  await page.waitForFunction(() => !window.app.startOpen && window.app.running, null, { timeout: 5000 });
  const run = await ev(() => ({ id: window.app.sim.state.scenarioId, seed: window.app.sim.config.seed, name: document.querySelector('.exp-name')?.textContent }));
  log(`  started ${run.name} (${run.id}, seed ${run.seed})`);
  if (run.id !== 'two-civs') problems.push(`Start ran ${run.id}`);

  // ---- a few in-game hours at 4x (the Faster button twice), then pause with the play button
  const faster = page.getByRole('button', { name: 'Faster' });
  await faster.click();
  await faster.click();
  const want = await ev((hours) => Math.round((window.app.sim.config.dayLength / 24) * hours), HOURS);
  await page.waitForFunction((t) => window.app.sim.tick >= t, want, { timeout: 30_000, polling: 100 });
  await page.locator('.play-btn').click();
  const paused = await ev(() => ({ running: window.app.running, tick: window.app.sim.tick, clock: document.querySelector('.clock-text')?.textContent }));
  if (paused.running) problems.push('the play button did not pause');
  log(`  paused at tick ${paused.tick} (${paused.clock})`);
  await page.getByRole('button', { name: 'Slower' }).click();
  await page.getByRole('button', { name: 'Slower' }).click();

  // ---- zoom in on a camp with the wheel, then click an agent with friends or family there
  const target = await ev(() => {
    const sim = window.app.sim;
    const camps = sim.state.tribes.filter((t) => t.extinctTick === -1 && t.members > 0).sort((a, b) => b.members - a.members);
    let best = null;
    let bestScore = -Infinity;
    for (const a of sim.state.agents) {
      if (!a.alive || a.tribeId === -1) continue;
      const t = camps.find((c) => c.id === a.tribeId);
      if (!t) continue;
      const d = Math.hypot(a.x - t.homeX, a.y - t.homeY);
      const ties = a.relationships.filter((r) => sim.getAgent(r.id)).length;
      let near = 0;
      for (const b of sim.state.agents) if (b !== a && Math.hypot(b.x - a.x, b.y - a.y) < 6) near++;
      const score = ties * 2 - d / 15 - near * 3 + (a.children.length ? 3 : 0);
      if (score > bestScore && near <= 1) {
        bestScore = score;
        best = { id: a.id, name: a.name, x: a.x, y: a.y, cx: (a.x + t.homeX) / 2, cy: (a.y + t.homeY) / 2 };
      }
    }
    return best;
  });
  if (!target) throw new Error('no agent to select');
  await ev((t) => {
    // put the area between the agent and its camp in the middle of the map
    window.app.camera.x = t.cx;
    window.app.camera.y = t.cy;
  }, target);
  await page.waitForTimeout(100);
  const screenOf = (t) =>
    ev((t) => {
      const r = window.app.renderer.canvas.getBoundingClientRect();
      const p = window.app.camera.worldToScreen(t.x, t.y);
      return { x: r.left + p.x, y: r.top + p.y };
    }, t);
  let p = await screenOf(target);
  await page.mouse.move(p.x, p.y);
  for (let i = 0; i < 12 && (await ev(() => window.app.camera.targetZoom)) < 3.2; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(60);
  }
  await page.waitForFunction(() => !window.app.camera.animating, null, { timeout: 5000 });
  p = await screenOf(target);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(400);
  const sel = await ev(() => ({ id: window.app.view.selectedId, tab: document.querySelector('.tab.on')?.textContent, name: document.querySelector('.pane-inspector .insp-name')?.textContent, zoom: window.app.camera.zoom }));
  if (sel.id !== target.id) problems.push(`clicking ${target.name} selected agent ${sel.id}`);
  if (sel.tab !== 'Agent' || sel.name !== target.name) problems.push(`the Agent tab shows "${sel.name}" on tab "${sel.tab}"`);
  log(`  selected ${sel.name} at zoom ${sel.zoom.toFixed(2)}, tab ${sel.tab}`);

  // a clean frame: no hint, no notice, the pointer off the map
  const hint = page.locator('.hint-box button[aria-label="Dismiss hint"]');
  if (await hint.isVisible()) await hint.click();
  await ev(() => window.app.toaster.clear());
  await page.mouse.move(1000, 24);
  await page.waitForTimeout(700);
  await canvasStats('main screen');

  if (takeShot) {
    mkdirSync(dirname(outFile), { recursive: true });
    await page.screenshot({ path: outFile });
    log(`  screenshot saved to ${outFile}`);
  }

  // ---- transport and a few shortcuts (after the screenshot)
  const t1 = await ev(() => window.app.sim.tick);
  await page.getByRole('button', { name: 'Step one tick' }).click();
  await page.waitForTimeout(150);
  if ((await ev(() => window.app.sim.tick)) !== t1 + 1) problems.push('the step button did not advance one tick');
  await page.locator('.play-btn').click();
  await page.waitForTimeout(500);
  if (!(await ev(() => window.app.running)) || (await ev(() => window.app.sim.tick)) <= t1 + 1) problems.push('the play button did not resume the run');
  await page.locator('canvas.world').focus();
  for (const key of ['Space', 'Period', 'Space', 'h', 'Escape', '8', 'Escape', 'o', 'Shift+O']) {
    await page.keyboard.press(key).catch((e) => problems.push(`key ${key}: ${e.message}`));
    await page.waitForTimeout(150);
  }
  const after = await ev(() => ({ help: document.querySelector('.modal-back').classList.contains('show'), tool: window.app.tool.id, overlay: window.app.view.overlay }));
  if (after.help || after.tool !== 'inspect' || after.overlay !== 'none') problems.push(`shortcuts left the app in ${JSON.stringify(after)}`);
  await page.waitForTimeout(800);
} catch (err) {
  problems.push(`smoke run aborted: ${err.message}`);
} finally {
  await browser.close();
}

for (const n of notes) log(`  note: ${n}`);
if (problems.length) {
  console.error(`browser smoke FAILED (${problems.length} problem${problems.length > 1 ? 's' : ''}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
log('browser smoke passed');
