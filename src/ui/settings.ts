// OWNER: UI shell. Settings drawer: world rules (parameters folded), this run (seed,
// restart, replay), save and load, pop-up notices and performance.
import { PARAM_SPECS } from '../sim/config';
import type { SimConfig } from '../sim/types';
import type { App } from './app';
import { CONFIG_TOGGLES } from './controls';
import { fmtInt, fold, h, icon, slider, toggle, type SliderCtl, type ToggleCtl } from './dom';

export interface SettingsDrawer {
  el: HTMLElement;
  open(v: boolean): void;
  readonly isOpen: boolean;
  onSimChanged(): void;
  /** About 4 times a second: reflect config changes and the intervention count. */
  sync(): void;
  setPerf(tps: number, fps: number, limited: boolean): void;
}

export function buildSettings(app: App): SettingsDrawer {
  // ---------------------------------------------------------------- world rules
  const paramSliders = new Map<keyof SimConfig, SliderCtl>();
  const cfgToggles = new Map<keyof SimConfig, ToggleCtl>();
  const pending: Partial<SimConfig> = {};
  const pendingTick = new Map<keyof SimConfig, number>();
  let flushTimer = 0;
  const flush = () => {
    window.clearTimeout(flushTimer);
    const keys = Object.keys(pending) as (keyof SimConfig)[];
    if (!keys.length) return;
    const patch = { ...pending } as Partial<SimConfig>;
    for (const k of keys) {
      delete pending[k];
      pendingTick.set(k, app.sim.tick);
    }
    app.enqueue({ kind: 'setConfig', patch });
  };
  const queuePatch = (key: keyof SimConfig, value: number | boolean, immediate: boolean) => {
    (pending as Record<string, number | boolean>)[key] = value;
    pendingTick.set(key, Number.MAX_SAFE_INTEGER);
    window.clearTimeout(flushTimer);
    if (immediate) flush();
    else flushTimer = window.setTimeout(flush, 160);
  };
  const rules = h('div', { class: 'toggles' });
  for (const t of CONFIG_TOGGLES) {
    const ctl = toggle({ label: t.label, value: Boolean(app.sim.config[t.key]), help: t.tip, onChange: (v) => queuePatch(t.key, v, true) });
    cfgToggles.set(t.key, ctl);
    rules.append(ctl.el);
  }
  const more = fold('More settings', 'params');
  for (const spec of PARAM_SPECS) {
    const s = slider({
      label: spec.label,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: Number(app.sim.config[spec.key]),
      help: spec.help,
      onInput: (v) => queuePatch(spec.key, v, false),
      onChange: (v) => queuePatch(spec.key, v, true),
    });
    paramSliders.set(spec.key, s);
    more.body.append(s.el);
  }
  more.body.append(
    h(
      'button',
      {
        type: 'button',
        class: 'btn wide',
        tip: "Set every rule and setting back to this experiment's starting values.",
        onclick: () => {
          const base = app.scenarioConfig();
          const patch: Partial<SimConfig> = {};
          for (const spec of PARAM_SPECS) (patch as Record<string, unknown>)[spec.key] = base[spec.key];
          for (const t of CONFIG_TOGGLES) (patch as Record<string, unknown>)[t.key] = base[t.key];
          for (const k of Object.keys(patch) as (keyof SimConfig)[]) pendingTick.set(k, app.sim.tick);
          app.enqueue({ kind: 'setConfig', patch });
          for (const [k, s] of paramSliders) s.set(Number(base[k]));
          for (const [k, c] of cfgToggles) c.set(Boolean(base[k]));
          app.confirm('Rules and settings are back to the experiment defaults.');
        },
      },
      icon('restart', 15),
      'Reset to experiment defaults',
    ),
  );

  // ---------------------------------------------------------------- this run
  const seedInput = h('input', { type: 'text', inputmode: 'numeric', class: 'text seed-input', 'aria-label': 'Seed', maxlength: 10, tip: 'The same seed always gives the same world, and without interventions the same history.' });
  const readSeed = (): number => {
    const v = Number(seedInput.value.trim());
    return seedInput.value.trim() !== '' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) >>> 0 : app.sim.config.seed;
  };
  seedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      app.restart(readSeed());
    }
  });
  const replayLabel = h('span', null, 'Replay my interventions');
  const replayBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn wide',
      tip: 'Start again from the beginning with this seed and redo every intervention you made, at the tick you made it. With the same seed you get your run again; with another seed you see the same interventions in a different world.',
      onclick: () => app.replay(readSeed()),
    },
    icon('replay', 15),
    replayLabel,
  );

  // ---------------------------------------------------------------- notices and performance
  const notices = toggle({ label: 'Pop-up notices', value: app.notices, help: 'Short notices for wars, tribes dying out, epidemics, big disasters and population crashes.', onChange: (v) => app.setNotices(v) });
  const tpsEl = h('span', { class: 'num' }, '0');
  const fpsEl = h('span', { class: 'num' }, '0');
  const limitEl = h('p', { class: 'note warn', style: 'display:none' }, 'Your computer cannot keep up with this speed, so the simulation runs as fast as it can.');

  const close = h('button', { type: 'button', class: 'btn icon ghost', 'aria-label': 'Close settings', onclick: () => set(false) }, icon('x', 16));
  const el = h(
    'aside',
    { class: 'drawer', role: 'dialog', 'aria-label': 'Settings', 'data-tip-side': 'left' },
    h('div', { class: 'drawer-head' }, h('h2', null, 'Settings'), close),
    h(
      'div',
      { class: 'drawer-body' },
      h('section', { class: 'dsec' }, h('h3', null, 'World rules'), h('p', { class: 'note' }, 'Changes apply at once and are recorded as interventions, so a replay repeats them.'), rules, more.el),
      h(
        'section',
        { class: 'dsec' },
        h('h3', null, 'This run'),
        h(
          'div',
          { class: 'seed-row' },
          h('label', { class: 'ctl-label' }, 'Seed'),
          seedInput,
          h('button', { type: 'button', class: 'btn', onclick: () => app.restart(readSeed()), tip: 'Start this experiment again from the beginning with the seed in the box. Your interventions are not repeated.' }, icon('restart', 15), 'Restart'),
          h('button', { type: 'button', class: 'btn', onclick: () => app.restart(Math.floor(Math.random() * 1e9)), tip: 'Start this experiment again in a new world.' }, icon('dice', 15), 'New seed'),
        ),
        replayBtn,
      ),
      h(
        'section',
        { class: 'dsec' },
        h('h3', null, 'Save and load'),
        h(
          'div',
          { class: 'row gap6' },
          h('button', { type: 'button', class: 'btn grow', onclick: () => app.save(), tip: 'Download this world as a file: the land, every agent, the tribes, the history, the charts and your interventions (Ctrl+S).' }, icon('save', 15), 'Save this world'),
          h('button', { type: 'button', class: 'btn grow', onclick: () => app.openLoadDialog(), tip: 'Open a saved world and carry on where it left off (Ctrl+O).' }, icon('load', 15), 'Load a saved world'),
        ),
        h('p', { class: 'note' }, 'You can also drop a save file onto the window.'),
      ),
      h('section', { class: 'dsec' }, h('h3', null, 'Notices'), notices.el),
      h(
        'section',
        { class: 'dsec' },
        h('h3', null, 'Performance'),
        h('dl', { class: 'kv' }, h('dt', null, 'Simulation'), h('dd', null, tpsEl, ' ticks per second'), h('dt', null, 'Drawing'), h('dd', null, fpsEl, ' frames per second')),
        limitEl,
      ),
    ),
  );

  let open = false;
  const set = (v: boolean) => {
    open = v;
    el.classList.toggle('show', v);
    if (v) sync();
  };

  let lastLogLen = -1;
  const sync = () => {
    const sim = app.sim;
    const cfg = sim.config;
    const active = document.activeElement;
    for (const [k, s] of paramSliders) {
      const pt = pendingTick.get(k);
      if (pt !== undefined) {
        if (sim.tick <= pt) continue; // our change has not been applied yet
        pendingTick.delete(k);
      }
      if (active === s.input) continue;
      const v = Number(cfg[k]);
      if (Number.isFinite(v) && Math.abs(v - s.value) > 1e-9) s.set(v);
    }
    for (const [k, c] of cfgToggles) {
      const pt = pendingTick.get(k);
      if (pt !== undefined) {
        if (sim.tick <= pt) continue;
        pendingTick.delete(k);
      }
      if (c.input.checked !== Boolean(cfg[k])) c.set(Boolean(cfg[k]));
    }
    const n = sim.state.interventionLog.length;
    if (n !== lastLogLen) {
      lastLogLen = n;
      replayLabel.textContent = n ? `Replay my interventions (${fmtInt(n)})` : 'Replay my interventions';
      replayBtn.toggleAttribute('disabled', n === 0);
    }
    if (document.activeElement !== seedInput && seedInput.dataset.seed !== String(cfg.seed)) {
      seedInput.dataset.seed = String(cfg.seed);
      seedInput.value = String(cfg.seed);
    }
    notices.set(app.notices);
  };

  const onSimChanged = () => {
    pendingTick.clear();
    for (const k of Object.keys(pending)) delete (pending as Record<string, unknown>)[k];
    lastLogLen = -1;
    seedInput.dataset.seed = '';
    for (const [k, s] of paramSliders) s.set(Number(app.sim.config[k]));
    for (const [k, c] of cfgToggles) c.set(Boolean(app.sim.config[k]));
    sync();
  };

  return {
    el,
    open: set,
    get isOpen() {
      return open;
    },
    onSimChanged,
    sync,
    setPerf(tps, fps, limited) {
      tpsEl.textContent = fmtInt(tps);
      fpsEl.textContent = fmtInt(fps);
      limitEl.style.display = limited ? '' : 'none';
    },
  };
}
