// OWNER: UI/UX agent. Left sidebar: active tool options, global events,
// experiments, view options, runtime parameters and save/load.
import { PARAM_SPECS } from '../sim/config';
import { TERRAIN_INFO } from '../sim/constants';
import { DISASTER_INFO } from '../sim/disasters';
import { SCENARIOS } from '../sim/presets';
import { DISASTER_KINDS, type DisasterKind, type ScenarioDef, type SimConfig } from '../sim/types';
import type { OverlayKind, ViewOptions } from '../render/renderer';
import type { App } from './app';
import { chips, fmtInt, h, icon, section, slider, toggle, type SliderCtl, type ToggleCtl } from './dom';
import { TERRAIN_ORDER, TOOLS, terrainColor, toolHelp, type ToolId } from './tools';

export const OVERLAYS: { value: OverlayKind; label: string; tip: string }[] = [
  { value: 'none', label: 'None', tip: 'Plain terrain view (no data overlay).' },
  { value: 'food', label: 'Food', tip: 'Standing food on each tile — bright means plenty. Watch grazing fronts and regrowth.' },
  { value: 'fertility', label: 'Fertility', tip: 'Soil fertility: how much food a tile can hold and how fast it regrows. Overgrazing wears it down.' },
  { value: 'density', label: 'Density', tip: 'Population density: where agents crowd together.' },
  { value: 'territory', label: 'Territory', tip: 'Land claimed by each tribe, drawn in tribe colours.' },
  { value: 'disease', label: 'Disease', tip: 'Infections and contagion hotspots.' },
  { value: 'climate', label: 'Climate', tip: 'Regional growth modifiers from droughts, blights, blooms and cold snaps.' },
];

const VIEW_TOGGLES: { key: string; label: string; tip: string }[] = [
  { key: 'showVision', label: 'Vision radius', tip: 'Draw the selected agent\'s perception radius.' },
  { key: 'showTrails', label: 'Trails', tip: 'Motion trail behind the selected / followed agent.' },
  { key: 'showRelations', label: 'Relationships', tip: 'Lines from the selected agent to friends, enemies and kin.' },
  { key: 'showCamps', label: 'Tribe camps', tip: 'Camp markers (with food stockpiles) for every tribe.' },
  { key: 'showLabels', label: 'Name labels', tip: 'Agent names when zoomed in.' },
  { key: 'showMinimap', label: 'Minimap', tip: 'Overview map in the corner of the world view.' },
];

const CONFIG_TOGGLES: { key: 'overgrazing' | 'seasons' | 'dayNight' | 'tribesEnabled'; label: string; tip: string }[] = [
  { key: 'overgrazing', label: 'Overgrazing', tip: 'When on, tiles stripped bare lose soil fertility and slowly turn barren — a tragedy of the commons. When off, land always recovers.' },
  { key: 'seasons', label: 'Seasons', tip: 'Spring/summer/autumn/winter cycle: plant growth and temperature vary through the year. Off = endless mild spring.' },
  { key: 'dayNight', label: 'Day / night', tip: 'Day/night cycle: darkness reduces vision and agents tend to rest at night.' },
  { key: 'tribesEnabled', label: 'Tribes', tip: 'Allow agents to found, join and split tribes with camps, shared stockpiles, territory and wars.' },
];

const GLOBAL_EVENTS: { kind: DisasterKind; label: string; tip: string; sev: number; days: number }[] = [
  { kind: 'drought', label: 'Global drought', tip: 'Plant regrowth collapses across the entire world. Who survives the famine?', sev: 1, days: 1 },
  { kind: 'plague', label: 'Global plague', tip: 'Infects agents everywhere with a contagious disease. Immunity genes suddenly matter.', sev: 1, days: 0.5 },
  { kind: 'bloom', label: 'Global abundance', tip: 'Food bursts to capacity everywhere and regrowth is boosted — watch the baby boom.', sev: 1, days: 1 },
  { kind: 'coldsnap', label: 'Ice age', tip: 'A world-wide cold snap: temperature plunges, raising metabolic costs and stunting growth.', sev: 1, days: 2 },
  { kind: 'blight', label: 'Global blight', tip: 'Destroys standing food and damages soil fertility everywhere.', sev: 1, days: 0.5 },
];

const TOOL_TIPS: Partial<Record<ToolId, string>> = {
  inspect: 'Click: select · Drag: pan · Double-click: follow · Esc: deselect',
  bless: 'Click: heal & feed · Shift-click: smite',
};

export interface LeftSidebar {
  el: HTMLElement;
  onSimChanged(): void;
  onToolChanged(): void;
  /** ~4 Hz refresh (config reflection, counters). */
  sync(): void;
  setOverlay(k: OverlayKind): void;
  openSection(id: string): void;
}

export function buildLeftSidebar(app: App): LeftSidebar {
  const el = h('aside', { class: 'sidebar left', 'data-tip-side': 'right', 'aria-label': 'Controls' });

  // ================================================================ TOOL
  const toolSec = section('tool', 'Tool', 'brush', true);
  const toolTitle = h('div', { class: 'tool-title' });
  const helpBox = h('div', { class: 'helpbox' });
  const radius = slider({
    label: 'Brush radius',
    min: 6,
    max: 320,
    step: 1,
    value: app.settings.radius,
    help: 'Size of the brush circle in world units (one tile = ' + app.sim.state.world.tileSize + ' units). Shortcut: [ and ] or Alt + mouse wheel.',
    fmt: (v) => `${Math.round(v)} u`,
    onInput: (v) => (app.settings.radius = v),
  });
  const opts: Partial<Record<ToolId, HTMLElement>> = {};

  opts.spawn = app.designer.el;
  opts.addFood = slider({ label: 'Food per tile', min: 1, max: 30, step: 0.5, value: app.settings.foodAmount, help: 'Food added to each tile under the brush per stamp (tiles are capped at their capacity).', onInput: (v) => (app.settings.foodAmount = v) }).el;
  opts.fertilize = slider({ label: 'Fertility boost', min: 0.05, max: 1, step: 0.05, value: app.settings.fertilizeAmount, help: 'How much soil fertility (0–1 scale) each stamp adds.', onInput: (v) => (app.settings.fertilizeAmount = v) }).el;

  const terrainPick = chips(
    TERRAIN_ORDER.map((t) => ({ value: t, label: TERRAIN_INFO[t].name, swatch: terrainColor(t), tip: TERRAIN_INFO[t].description })),
    app.settings.terrain,
    (t) => {
      app.settings.terrain = t;
      refreshHelp();
    },
    'grid2 terrain-pick',
  );
  opts.terrain = h('div', null, h('div', { class: 'sub-title' }, 'Terrain type'), terrainPick.el);

  const disasterPick = chips(
    DISASTER_KINDS.map((k) => ({ value: k, label: DISASTER_INFO[k].label, icon: DISASTER_INFO[k].icon, tip: DISASTER_INFO[k].help })),
    app.settings.disaster,
    (k) => {
      app.settings.disaster = k;
      refreshHelp();
    },
    'grid2 disaster-pick',
  );
  const intensity = slider({ label: 'Intensity', min: 0.1, max: 1, step: 0.05, value: app.settings.intensity, help: 'How severe the disaster is (0.1 = mild, 1 = catastrophic).', onInput: (v) => (app.settings.intensity = v) });
  const duration = slider({ label: 'Duration', min: 0.25, max: 12, step: 0.25, value: app.settings.durationDays, help: 'How long the disaster lasts, in in-game days.', fmt: (v) => `${v} day${v === 1 ? '' : 's'}`, onInput: (v) => (app.settings.durationDays = v) });
  opts.disaster = h('div', null, h('div', { class: 'sub-title' }, 'Disaster type'), disasterPick.el, intensity.el, duration.el);
  opts.inspect = h('div', { class: 'hint' }, TOOL_TIPS.inspect ?? '');
  opts.bless = h('div', { class: 'hint' }, TOOL_TIPS.bless ?? '');

  const optWrap = h('div', { class: 'tool-opts' });
  for (const t of TOOLS) {
    const o = opts[t.id];
    if (!o) continue;
    o.classList.add('tool-opt');
    o.dataset.tool = t.id;
    optWrap.append(o);
  }
  toolSec.body.append(toolTitle, helpBox, radius.el, optWrap);

  const refreshHelp = () => {
    const help = toolHelp(app.tool, app.settings);
    helpBox.replaceChildren(...help.lines.map((l) => h('p', null, l)));
  };

  // ================================================================ GLOBAL EVENTS
  const globSec = section('global', 'Global events', 'globe', true);
  const gSev = slider({ label: 'Severity', min: 0.1, max: 1, step: 0.05, value: 0.75, help: 'Intensity of the world-wide event.' });
  const gDur = slider({ label: 'Duration', min: 0.25, max: 12, step: 0.25, value: 2, help: 'How long the world-wide event lasts, in in-game days.', fmt: (v) => `${v} day${v === 1 ? '' : 's'}` });
  const gGrid = h('div', { class: 'grid2 global-grid' });
  for (const g of GLOBAL_EVENTS) {
    const info = DISASTER_INFO[g.kind];
    gGrid.append(
      h(
        'button',
        {
          type: 'button',
          class: `btn ev-btn ev-${g.kind}`,
          tip: `${g.tip} (${info.label} with radius 0 = whole world)`,
          onclick: () => {
            const sim = app.sim;
            app.enqueue({
              kind: 'disaster',
              disaster: g.kind,
              x: sim.worldW / 2,
              y: sim.worldH / 2,
              radius: 0,
              intensity: gSev.value,
              duration: Math.max(1, Math.round(gDur.value * sim.config.dayLength)),
            });
            app.toaster.show(`${g.label} unleashed for ${gDur.value} day${gDur.value === 1 ? '' : 's'} at ${Math.round(gSev.value * 100)}% severity.`, { kind: g.kind === 'bloom' ? 'good' : 'bad', title: `${info.icon} ${g.label}` });
          },
        },
        h('span', { class: 'ev-ic' }, info.icon),
        h('span', null, g.label),
      ),
    );
  }
  globSec.body.append(gSev.el, gDur.el, gGrid);

  // ================================================================ EXPERIMENTS
  const expSec = section('experiments', 'Experiments', 'flask', true);
  const cards = new Map<string, HTMLElement>();
  const cardList = h('div', { class: 'exp-cards' });
  let expanded = '';
  const setExpanded = (id: string) => {
    expanded = expanded === id ? '' : id;
    for (const [cid, c] of cards) c.classList.toggle('expanded', cid === expanded);
  };
  for (const sc of SCENARIOS) {
    const card = h(
      'div',
      { class: 'exp-card' },
      h(
        'button',
        { type: 'button', class: 'exp-card-head', onclick: () => setExpanded(sc.id), 'aria-label': `${sc.name}: show details` },
        h('span', { class: 'exp-card-name' }, sc.name, h('span', { class: 'badge running-badge' }, 'running')),
        h('span', { class: 'exp-card-tag' }, sc.tagline),
      ),
      h(
        'div',
        { class: 'exp-card-body' },
        h('p', null, sc.description),
        sc.lookFor && sc.lookFor.length ? h('div', { class: 'sub-title' }, 'What to look for') : null,
        sc.lookFor && sc.lookFor.length ? h('ul', { class: 'lookfor' }, ...sc.lookFor.map((l) => h('li', null, l))) : null,
        h('button', { type: 'button', class: 'btn primary wide', onclick: () => app.startScenario(sc), tip: 'Start this experiment from tick 0 with its default seed.' }, icon('play', 13), 'Start experiment'),
      ),
    );
    cards.set(sc.id, card);
    cardList.append(card);
  }
  const seedInput = h('input', { type: 'number', class: 'text mono seed-input', min: 0, max: 4294967295, step: 1, 'aria-label': 'Seed', tip: 'The random seed. The same seed always produces the same world and — without interventions — exactly the same history.' });
  const replayBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn wide',
      tip: 'Restart from tick 0 with the seed in the box and automatically re-apply every intervention you made, at the exact tick you made it. With the same seed this reproduces your run exactly; with a new seed it tests your interventions in a different world.',
      onclick: () => app.replay(readSeed()),
    },
    icon('replay', 14),
    h('span', { class: 'replay-label' }, 'Replay my interventions'),
  );
  const readSeed = (): number => {
    const v = Number(seedInput.value);
    return Number.isFinite(v) && seedInput.value !== '' ? Math.max(0, Math.floor(v)) >>> 0 : app.sim.config.seed;
  };
  const nowRunning = h('div', { class: 'now-running' });
  expSec.body.append(
    nowRunning,
    cardList,
    h(
      'div',
      { class: 'seed-row' },
      h('label', { class: 'ctl-label' }, 'Seed'),
      seedInput,
      h('button', { type: 'button', class: 'btn', onclick: () => app.restart(readSeed()), tip: 'Restart the current experiment from tick 0 with the seed in the box. Same seed = identical world and identical history (your interventions are not re-applied).' }, icon('restart', 14), 'Restart'),
      h('button', { type: 'button', class: 'btn icon', onclick: () => app.restart(Math.floor(Math.random() * 1e9)), tip: 'New seed: restart the current experiment in a freshly generated world with a different random history.', 'aria-label': 'New seed' }, icon('dice', 15)),
    ),
    replayBtn,
  );

  // ================================================================ VIEW
  const viewSec = section('view', 'View', 'eye', true);
  const overlayPick = chips(OVERLAYS, app.view.overlay, (k) => app.setOverlay(k), 'grid3 overlay-pick');
  const viewToggles: ToggleCtl[] = [];
  const vt = h('div', { class: 'toggles' });
  const viewRec = app.view as unknown as Record<string, unknown>;
  for (const t of VIEW_TOGGLES) {
    if (t.key === 'showMinimap' && !app.supportsMinimap) continue;
    const ctl = toggle({ label: t.label, value: Boolean(viewRec[t.key]), help: t.tip, onChange: (v) => { viewRec[t.key] = v; app.saveView(); } });
    viewToggles.push(ctl);
    vt.append(ctl.el);
  }
  viewSec.body.append(
    h('div', { class: 'sub-title' }, 'Data overlay ', h('span', { class: 'kbd-hint' }, 'O')),
    overlayPick.el,
    vt,
    h(
      'div',
      { class: 'row gap6 mt8' },
      h('button', { type: 'button', class: 'btn grow', onclick: () => app.fitWorld(), tip: 'Zoom out to show the whole world (key 0).' }, icon('fit', 14), 'Fit world'),
      h('button', { type: 'button', class: 'btn grow', onclick: () => app.toggleFollow(), tip: 'Camera follows the selected agent (key F). Any manual pan stops following.' }, icon('target', 14), 'Follow selected'),
    ),
  );

  // ================================================================ PARAMETERS
  const paramSec = section('params', 'Parameters', 'sliders', true);
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
  const pGrid = h('div', { class: 'params' });
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
    pGrid.append(s.el);
  }
  const ct = h('div', { class: 'toggles' });
  for (const t of CONFIG_TOGGLES) {
    const ctl = toggle({ label: t.label, value: Boolean(app.sim.config[t.key]), help: t.tip, onChange: (v) => queuePatch(t.key, v, true) });
    cfgToggles.set(t.key, ctl);
    ct.append(ctl.el);
  }
  paramSec.body.append(
    h('p', { class: 'hint' }, 'Changes apply live, are recorded in your intervention log and replay deterministically.'),
    pGrid,
    ct,
    h(
      'button',
      {
        type: 'button',
        class: 'btn wide mt8',
        tip: 'Restore every parameter on this panel to the current experiment\'s starting values.',
        onclick: () => {
          const base = app.scenarioConfig();
          const patch: Partial<SimConfig> = {};
          for (const spec of PARAM_SPECS) (patch as Record<string, unknown>)[spec.key] = base[spec.key];
          for (const t of CONFIG_TOGGLES) (patch as Record<string, unknown>)[t.key] = base[t.key];
          for (const k of Object.keys(patch) as (keyof SimConfig)[]) pendingTick.set(k, app.sim.tick);
          app.enqueue({ kind: 'setConfig', patch });
          for (const [k, s] of paramSliders) s.set(Number(base[k]));
          for (const [k, c] of cfgToggles) c.set(Boolean(base[k]));
          app.toaster.show('Parameters reset to the experiment defaults.', { kind: 'info' });
        },
      },
      icon('restart', 14),
      'Reset to experiment defaults',
    ),
  );

  // ================================================================ SAVE / LOAD
  const ioSec = section('io', 'Save & load', 'save', true);
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', 'aria-hidden': 'true' });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) app.loadFile(f);
    fileInput.value = '';
  });
  ioSec.body.append(
    h(
      'div',
      { class: 'row gap6' },
      h('button', { type: 'button', class: 'btn grow', onclick: () => app.save(), tip: 'Download the complete experiment (world, every agent, tribes, history, statistics and your intervention log) as a JSON file.' }, icon('save', 14), 'Save experiment'),
      h('button', { type: 'button', class: 'btn grow', onclick: () => fileInput.click(), tip: 'Load a previously saved experiment JSON file and continue exactly where it left off.' }, icon('load', 14), 'Load…'),
    ),
    h('p', { class: 'hint' }, 'Tip: you can also drop a save file anywhere on the window.'),
    fileInput,
  );

  el.append(expSec.el, toolSec.el, globSec.el, viewSec.el, paramSec.el, ioSec.el);

  // ================================================================ lifecycle hooks
  const onToolChanged = () => {
    const t = app.tool;
    toolTitle.replaceChildren(icon(t.icon, 16), h('span', null, t.name), h('kbd', null, t.key));
    radius.el.style.display = t.brush ? '' : 'none';
    for (const o of optWrap.children) (o as HTMLElement).style.display = (o as HTMLElement).dataset.tool === t.id ? '' : 'none';
    refreshHelp();
    if (t.id === 'spawn') app.designer.refreshTribes();
  };

  let lastLogLen = -1;
  const sync = () => {
    const sim = app.sim;
    const cfg = sim.config;
    const active = document.activeElement;
    for (const [k, s] of paramSliders) {
      const pt = pendingTick.get(k);
      if (pt !== undefined) {
        if (sim.tick <= pt) continue; // our change hasn't been applied yet
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
      (replayBtn.querySelector('.replay-label') as HTMLElement).textContent = `Replay my interventions (${fmtInt(n)})`;
      replayBtn.toggleAttribute('disabled', n === 0);
    }
    radius.set(app.settings.radius);
  };

  const onSimChanged = () => {
    const sc: ScenarioDef = app.scenario;
    nowRunning.replaceChildren(
      h('div', { class: 'now-label' }, 'Now running'),
      h('div', { class: 'now-name' }, sc.name),
      h('div', { class: 'now-tag' }, sc.tagline),
    );
    for (const [id, c] of cards) c.classList.toggle('active', id === sc.id);
    seedInput.value = String(app.sim.config.seed);
    pendingTick.clear();
    for (const k of Object.keys(pending)) delete (pending as Record<string, unknown>)[k];
    lastLogLen = -1;
    for (const [k, s] of paramSliders) s.set(Number(app.sim.config[k]));
    for (const [k, c] of cfgToggles) c.set(Boolean(app.sim.config[k]));
    sync();
    app.designer.refreshTribes();
  };

  return {
    el,
    onSimChanged,
    onToolChanged,
    sync,
    setOverlay: (k) => overlayPick.set(k),
    openSection: (id) => {
      const s = { experiments: expSec, tool: toolSec, global: globSec, view: viewSec, params: paramSec, io: ioSec }[id];
      if (!s) return;
      s.open(true);
      s.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
  };
}

/** View flags persisted per viewer (overlay excluded). */
export function viewPrefs(view: ViewOptions): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const rec = view as unknown as Record<string, unknown>;
  for (const t of VIEW_TOGGLES) if (typeof rec[t.key] === 'boolean') out[t.key] = rec[t.key] as boolean;
  return out;
}
