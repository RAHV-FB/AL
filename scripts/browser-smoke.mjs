#!/usr/bin/env node
/**
 * Browser smoke test (QA-owned).
 *
 *   npm run build && node scripts/browser-smoke.mjs
 *   node scripts/browser-smoke.mjs --url https://rahv-fb.github.io/AL/ --wait 6000 --out docs/screenshot.png
 *   node scripts/browser-smoke.mjs --no-screenshot
 *
 * Loads the single-file build (dist/index.html) over file://, waits, and FAILS (exit 1) on:
 *   - any console error or uncaught page error, or a failed request
 *   - a blank/near-uniform main canvas
 * Then clicks a few controls if present (Pause/Play, speed), presses keyboard shortcuts,
 * and saves a 1440×900 @2x screenshot to docs/screenshot.png.
 *
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

const distFile = resolve(root, 'dist/index.html');
const url = opt('url', pathToFileURL(distFile).href);
const waitMs = Number(opt('wait', '4000'));
const outFile = resolve(root, opt('out', 'docs/screenshot.png'));
const takeShot = !flag('no-screenshot');

async function loadPlaywright() {
  // CommonJS resolution honours NODE_PATH (global installs); ESM import does not.
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    try {
      return await import('playwright');
    } catch {
      console.error('✗ Playwright not found. Install it: npm i -D playwright && npx playwright install chromium');
      process.exit(2);
    }
  }
}

const problems = [];
const notes = [];
const log = (m) => console.log(m);

if (url.startsWith('file:') && !existsSync(distFile)) {
  console.error(`✗ ${distFile} not found — run "npm run build" first.`);
  process.exit(2);
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
    else if (msg.type() === 'warning') notes.push(`console.warn: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => problems.push(`request failed: ${req.url()} (${req.failure()?.errorText ?? '?'})`));

  log(`→ loading ${url}`);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  await page.waitForTimeout(waitMs);
  log(`  loaded + waited ${Date.now() - t0} ms`);

  // ---- canvas check: largest visible canvas must show a non-trivial image
  const canvasInfo = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')].map((c, i) => {
      const r = c.getBoundingClientRect();
      return { i, w: r.width, h: r.height, area: r.width * r.height, px: `${c.width}x${c.height}` };
    });
    cs.sort((a, b) => b.area - a.area);
    return cs;
  });
  if (!canvasInfo.length || canvasInfo[0].area < 200 * 200) {
    problems.push(`no sizeable <canvas> found (${JSON.stringify(canvasInfo)})`);
  } else {
    const main = page.locator('canvas').nth(canvasInfo[0].i);
    const png = await main.screenshot();
    // Decode the PNG in a blank page (data: URL → never tainted, works for 2D or WebGL canvases).
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
      let sum = 0, sum2 = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 7) {
        colors.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        sum += l; sum2 += l * l; n++;
      }
      const mean = sum / n;
      return { w: c.width, h: c.height, colors: colors.size, mean, sd: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
    }, png.toString('base64'));
    await probe.close();
    log(`  canvas ${canvasInfo[0].px}: ${stats.colors} distinct colours, luminance mean ${stats.mean.toFixed(1)} sd ${stats.sd.toFixed(1)}`);
    if (stats.colors < 16 || stats.sd < 4) problems.push(`canvas looks blank/uniform (${stats.colors} colours, sd ${stats.sd.toFixed(1)})`);
  }

  // ---- UI interaction (tolerant: every control is optional)
  const tryClick = async (label, re) => {
    const btn = page.getByRole('button', { name: re }).first();
    if ((await btn.count()) && (await btn.isVisible().catch(() => false))) {
      await btn.click({ timeout: 2000 }).catch((e) => problems.push(`click "${label}" failed: ${e.message}`));
      log(`  clicked ${label} ("${((await btn.textContent().catch(() => '')) ?? '').trim().slice(0, 30)}")`);
      await page.waitForTimeout(300);
      return true;
    }
    notes.push(`no button matching ${label} ${re}`);
    return false;
  };
  await tryClick('speed', /(^|\s)(4|8|10|16)\s*[x×]|fast|speed/i);
  await page.waitForTimeout(1500);

  if (takeShot) {
    mkdirSync(dirname(outFile), { recursive: true });
    await page.screenshot({ path: outFile });
    log(`  screenshot → ${outFile}`);
  }

  await tryClick('pause', /pause/i);
  await tryClick('play', /play|resume/i);
  await tryClick('normal speed', /(^|\s)1\s*[x×]/i);
  // keyboard shortcuts (documented in README): pause, single step, help on/off, deselect
  await page.locator('body').click({ position: { x: 720, y: 450 } }).catch(() => {});
  for (const key of ['Space', 'Period', 'Space', 'h', 'Escape']) {
    await page.keyboard.press(key).catch((e) => problems.push(`key ${key}: ${e.message}`));
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(1000);
} finally {
  await browser.close();
}

for (const n of notes) log(`  note: ${n}`);
if (problems.length) {
  console.error(`✗ browser smoke FAILED (${problems.length} problem${problems.length > 1 ? 's' : ''}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
log('✓ browser smoke passed');
