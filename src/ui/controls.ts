// OWNER: UI shell. The tool options panel next to the rail (only the active tool's
// settings) and the Layers menu (data overlay and map toggles).
import { TERRAIN_INFO } from '../sim/constants';
import { DISASTER_INFO } from '../sim/disasters';
import { DISASTER_KINDS, type DisasterKind } from '../sim/types';
import type { OverlayKind, ViewOptions } from '../render/renderer';
import type { App } from './app';
import { chips, h, icon, slider, toggle, type ToggleCtl } from './dom';
import { TERRAIN_ORDER, choiceHelp, effectiveRadius, terrainColor, type ToolId } from './tools';

export const OVERLAYS: { value: OverlayKind; label: string; tip: string }[] = [
  { value: 'none', label: 'None', tip: 'The plain map.' },
  { value: 'food', label: 'Food', tip: 'Food standing on each tile. Brighter means more. Watch grazed land and regrowth.' },
  { value: 'fertility', label: 'Fertility', tip: 'How much food each tile can hold and how fast it regrows. Overgrazing wears it down.' },
  { value: 'density', label: 'Density', tip: 'Where agents crowd together.' },
  { value: 'territory', label: 'Territory', tip: 'Land claimed by each tribe, in tribe colors.' },
  { value: 'disease', label: 'Disease', tip: 'Infected agents and where the disease spreads.' },
  { value: 'climate', label: 'Climate', tip: 'Where droughts, blights, abundance and cold snaps change plant growth.' },
];

/** Map toggles in the Layers menu (view flags, remembered per viewer). */
export const VIEW_TOGGLES: { key: string; label: string; tip: string }[] = [
  { key: 'showCamps', label: 'Tribe camps', tip: 'Camp markers with the tribe name and its stored food.' },
  { key: 'showLabels', label: 'Names', tip: 'Agent names and what they are doing, when you zoom in close.' },
  { key: 'showConnections', label: 'Connections', tip: "Lines between agents with strong ties when you zoom in: family, friends and enemies. The selected agent's ties always show." },
  { key: 'showTrails', label: 'Trails and routes', tip: 'The path behind the selected agent, and the route it plans around rivers, lakes and walls.' },
  { key: 'showVision', label: 'Vision radius', tip: 'How far the selected agent can see.' },
  { key: 'showMinimap', label: 'Minimap', tip: 'The whole world in a corner of the map. Click or drag on it to move the view.' },
];

/** World rules in the Settings drawer (SimConfig booleans). */
export const CONFIG_TOGGLES: { key: 'overgrazing' | 'seasons' | 'dayNight' | 'tribesEnabled'; label: string; tip: string }[] = [
  { key: 'overgrazing', label: 'Overgrazing', tip: 'Land grazed bare loses fertility and slowly turns barren. When off, land always recovers.' },
  { key: 'seasons', label: 'Seasons', tip: 'Plant growth and temperature change through spring, summer, autumn and winter. When off, it is always a mild spring.' },
  { key: 'dayNight', label: 'Day / night', tip: 'At night agents see less and tend to rest.' },
  { key: 'tribesEnabled', label: 'Tribes', tip: 'Agents can found, join and split tribes with camps, shared food stores, territory and wars.' },
];

/** View flags persisted per viewer (overlay excluded). */
export function viewPrefs(view: ViewOptions): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const rec = view as unknown as Record<string, unknown>;
  for (const t of VIEW_TOGGLES) if (typeof rec[t.key] === 'boolean') out[t.key] = rec[t.key] as boolean;
  return out;
}

/** Selected agent's relationship lines follow the Connections toggle. */
export function applyConnections(view: ViewOptions, on: boolean): void {
  const rec = view as unknown as Record<string, unknown>;
  rec.showConnections = on;
  rec.showRelations = on;
}

// ================================================================ tool options panel
export interface ToolPanel {
  el: HTMLElement;
  /** Show the options of the current tool (hidden for Inspect). */
  onToolChanged(): void;
  /** Reflect values changed elsewhere (brush size keys). */
  sync(): void;
}

const fmtDays = (v: number): string => `${v} ${v === 1 ? 'day' : 'days'}`;

export function buildToolPanel(app: App): ToolPanel {
  const title = h('div', { class: 'tp-title' });
  const how = h('p', { class: 'tp-how' });
  const close = h('button', { type: 'button', class: 'btn icon ghost tp-x', 'aria-label': 'Close and go back to Inspect', tip: 'Back to Inspect (Esc)', onclick: () => app.setTool('inspect') }, icon('x', 16));
  const el = h('div', { class: 'tool-panel', role: 'dialog', 'aria-label': 'Tool settings' }, h('div', { class: 'tp-head' }, title, close), how);
  const body = h('div', { class: 'tp-body' });
  el.append(body);

  const radius = slider({
    label: 'Brush size',
    min: 6,
    max: 320,
    step: 1,
    value: app.settings.radius,
    help: `Radius of the circle in world units (a tile is ${app.sim.state.world.tileSize} units). Keys [ and ], or Alt and the mouse wheel.`,
    fmt: (v) => `${Math.round(v)} units`,
    onInput: (v) => app.setRadius(v),
  });

  // one line about the current choice; each tool has its own element so blocks never share a node
  const notes: Partial<Record<ToolId, HTMLElement>> = { terrain: h('p', { class: 'tp-note' }), disaster: h('p', { class: 'tp-note' }), remove: h('p', { class: 'tp-note' }) };
  const refreshChoice = () => {
    const n = notes[app.tool.id];
    if (n) n.textContent = choiceHelp(app.tool, app.settings);
  };

  // --- per-tool blocks
  const blocks: Partial<Record<ToolId, HTMLElement>> = {};
  blocks.spawn = app.designer.el;
  blocks.addFood = slider({ label: 'Food per tile', min: 1, max: 30, step: 0.5, value: app.settings.foodAmount, help: 'Food added to each tile under the circle each time. A tile holds at most 1.5 times its normal capacity.', onInput: (v) => (app.settings.foodAmount = v) }).el;
  blocks.fertilize = slider({ label: 'Fertility added', min: 0.05, max: 1, step: 0.05, value: app.settings.fertilizeAmount, help: 'Fertility added each time, on a scale where 1 is the richest soil.', fmt: (v) => `${Math.round(v * 100)}%`, onInput: (v) => (app.settings.fertilizeAmount = v) }).el;

  const terrainPick = chips(
    TERRAIN_ORDER.map((t) => ({ value: t, label: TERRAIN_INFO[t].name, swatch: terrainColor(t) })),
    app.settings.terrain,
    (t) => {
      app.settings.terrain = t;
      refreshChoice();
    },
    'rows two',
  );
  blocks.terrain = h('div', null, h('div', { class: 'sub-title' }, 'Terrain'), terrainPick.el, notes.terrain);

  const disasterPick = chips(
    DISASTER_KINDS.map((k) => ({ value: k, label: DISASTER_INFO[k].label, icon: k })),
    app.settings.disaster,
    (k) => {
      app.settings.disaster = k;
      refreshChoice();
      refreshDisaster();
    },
    'rows two',
  );
  const intensity = slider({ label: 'Intensity', min: 0.1, max: 1, step: 0.05, value: app.settings.intensity, help: 'How strong the disaster is, from mild to catastrophic.', fmt: (v) => `${Math.round(v * 100)}%`, onInput: (v) => (app.settings.intensity = v) });
  const duration = slider({ label: 'Duration', min: 0.25, max: 12, step: 0.25, value: app.settings.durationDays, help: 'How long it lasts, in days.', fmt: fmtDays, onInput: (v) => (app.settings.durationDays = v) });
  const wholeLabel = h('span');
  const whole = h(
    'button',
    {
      type: 'button',
      class: 'btn wide',
      tip: 'Start it everywhere at once, with the intensity and duration above.',
      onclick: () => wholeMap(app, app.settings.disaster, app.settings.intensity, app.settings.durationDays),
    },
    icon('globe', 15),
    wholeLabel,
  );
  const wholeNote = h('p', { class: 'tp-note' }, 'A meteor always strikes one spot.');
  blocks.disaster = h('div', null, h('div', { class: 'sub-title' }, 'Type'), disasterPick.el, notes.disaster, intensity.el, duration.el);
  const wholeBlock = h('div', { class: 'tp-whole' }, whole, wholeNote);
  // meteors strike at once (the simulation ignores their duration) and never cover the whole map
  const refreshDisaster = () => {
    const meteor = app.settings.disaster === 'meteor';
    duration.el.style.display = meteor ? 'none' : '';
    whole.style.display = meteor ? 'none' : '';
    wholeNote.style.display = meteor ? '' : 'none';
    wholeLabel.textContent = `${DISASTER_INFO[app.settings.disaster].label} on the whole map`;
  };
  refreshDisaster();

  const sizeSlot = h('div', { class: 'tp-size' }, radius.el);

  const onToolChanged = () => {
    const t = app.tool;
    const show = t.id !== 'inspect';
    el.classList.toggle('show', show);
    if (!show) return;
    title.replaceChildren(icon(t.icon, 18), h('span', null, t.name), h('kbd', { tip: 'Shortcut' }, t.key));
    how.textContent = t.how;
    refreshChoice();
    const block = blocks[t.id];
    body.replaceChildren();
    if (block) body.append(block);
    if (t.brush) body.append(sizeSlot);
    if (t.id === 'disaster') body.append(wholeBlock);
    if (t.id === 'remove') body.append(notes.remove!);
    if (t.id === 'spawn') app.designer.refreshTribes();
    sync();
  };

  const sync = () => {
    radius.set(app.settings.radius);
    const eff = Math.round(effectiveRadius(app.tool.id, app.settings));
    const capped = eff < Math.round(app.settings.radius);
    radius.el.querySelector('.ctl-val')!.textContent = capped ? `${eff} units (meteor limit)` : `${Math.round(app.settings.radius)} units`;
  };

  return { el, onToolChanged, sync };
}

/** A disaster over the whole map (radius 0), as the old world-wide events did. */
export function wholeMap(app: App, kind: DisasterKind, intensity: number, days: number): void {
  const sim = app.sim;
  app.enqueue({
    kind: 'disaster',
    disaster: kind,
    x: sim.worldW / 2,
    y: sim.worldH / 2,
    radius: 0,
    intensity,
    duration: Math.max(1, Math.round(days * sim.config.dayLength)),
  });
  app.confirm(`${DISASTER_INFO[kind].label} started on the whole map for ${fmtDays(days)}.`);
}

// ================================================================ layers menu
export interface LayersMenu {
  button: HTMLButtonElement;
  menu: HTMLElement;
  setOverlay(k: OverlayKind): void;
  open(v: boolean): void;
  readonly isOpen: boolean;
}

export function buildLayersMenu(app: App): LayersMenu {
  const overlayPick = chips(
    OVERLAYS.map((o) => ({ value: o.value, label: o.label, tip: o.tip })),
    app.view.overlay,
    (k) => app.setOverlay(k),
    'rows radio',
  );
  const rec = app.view as unknown as Record<string, unknown>;
  const toggles: ToggleCtl[] = [];
  const list = h('div', { class: 'toggles' });
  for (const t of VIEW_TOGGLES) {
    if (t.key === 'showMinimap' && !app.supportsMinimap) continue;
    const ctl = toggle({
      label: t.label,
      value: rec[t.key] !== false,
      help: t.tip,
      onChange: (v) => {
        if (t.key === 'showConnections') applyConnections(app.view, v);
        else rec[t.key] = v;
        app.saveView();
      },
    });
    toggles.push(ctl);
    list.append(ctl.el);
  }
  const menu = h(
    'div',
    { class: 'menu layers-menu', role: 'dialog', 'aria-label': 'Layers', 'data-tip-side': 'left' },
    h('div', { class: 'menu-title' }, 'Data on the map', h('kbd', { tip: 'Shortcut: next layer' }, 'O')),
    overlayPick.el,
    h('div', { class: 'menu-title' }, 'Show'),
    list,
  );
  let open = false;
  const button = h(
    'button',
    { type: 'button', class: 'btn map-btn layers-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: () => set(!open) },
    icon('layers', 16),
    h('span', null, 'Layers'),
  );
  const set = (v: boolean) => {
    open = v;
    menu.classList.toggle('show', v);
    button.classList.toggle('on', v);
    button.setAttribute('aria-expanded', String(v));
  };
  return {
    button,
    menu,
    setOverlay: (k) => overlayPick.set(k),
    open: set,
    get isOpen() {
      return open;
    },
  };
}

