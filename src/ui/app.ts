// OWNER: UI shell. Application shell: start screen, layout, game loop, camera and tool
// input, experiment lifecycle (start, restart, replay, save, load), panels and notices.
import { Simulation } from '../sim/simulation';
import { SCENARIOS } from '../sim/presets';
import { DEFAULT_CONFIG } from '../sim/config';
import { SEASON_NAMES, TERRAIN_INFO } from '../sim/constants';
import { deserializeState, serializeSim } from '../sim/persistence';
import type { DeathCause, Intervention, InterventionRecord, ScenarioDef, SimConfig, SimEvent, TerrainType } from '../sim/types';
import { Renderer, type OverlayKind, type ViewOptions } from '../render/renderer';
import type { Camera } from '../render/camera';
import { createAnalyticsPanel, plainText, type AnalyticsPanel } from './analytics';
import { createInspector, describeAction, type Inspector, type InspectorHandlers } from './inspector';
import { createEventLog, type EventLogPanel } from './eventlog';
import { fill, fmtInt, h, icon, installTooltips, plural, store, Toaster, type ToastOpts } from './dom';
import { DEFAULT_SETTINGS, Painter, TOOLS, brushColor, brushIntervention, effectiveRadius, toolById, type ToolDef, type ToolId, type ToolSettings } from './tools';
import { PopulationDesigner } from './designer';
import { OVERLAYS, VIEW_TOGGLES, applyConnections, buildLayersMenu, buildToolPanel, viewPrefs, type LayersMenu, type ToolPanel } from './controls';
import { buildSettings, type SettingsDrawer } from './settings';
import { buildStartScreen, defaultSeedOf, parseSeed, type StartScreen } from './start';

/** Speed multipliers; 0 = "Max" (as many ticks as fit the frame budget). */
export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 0];
const SPEED_LABELS = ['1/4x', '1/2x', '1x', '2x', '4x', '8x', '16x', '32x', '64x', 'Max'];
/** Ticks per second at 1x. */
const BASE_TPS = 30;
/** Hard budget for simulation stepping per animation frame (ms). */
const STEP_BUDGET_MS = 12;
const PAN_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
/** Zoom step of the +, - buttons and keys. */
const ZOOM_STEP = 1.5;
/** Close view used when double-clicking an agent (CSS px per world unit). */
const CLOSE_ZOOM = 5;
/** Least time between two notices about simulation events (ms). */
const EVENT_TOAST_GAP = 8000;
/** Space on the right of the map kept for the zoom buttons (renderer legend stays clear). */
const ZOOM_COL = 56;
/** Room kept above the minimap for the renderer's map legend (connections and territory edges, 115 px with its gap). */
const LEGEND_ZONE = 120;

type Tab = 'stats' | 'inspector' | 'events';

const DEATH_LABEL: Record<DeathCause, string> = {
  starvation: 'starved',
  old_age: 'died of old age',
  combat: 'was killed in a fight',
  disease: 'died of disease',
  disaster: 'was killed by a disaster',
  removed: 'was removed',
};

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** An error message as one sentence (exactly one final period). */
const sentence = (msg: string): string => `${msg.trim().replace(/[.\s]+$/, '')}.`;

interface DragState {
  kind: 'pan' | 'paint' | 'click' | 'minimap';
  id: number;
  button: number;
  sx: number;
  sy: number;
  lx: number;
  ly: number;
  moved: boolean;
}

/** URL hash options: #run starts the default experiment at once; #run=<id>&seed=<n> picks one. */
function readHash(): { run: string | null; seed: number | undefined } {
  try {
    const p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    return { run: p.has('run') ? (p.get('run') ?? '') : null, seed: parseSeed(p.get('seed') ?? '') };
  } catch {
    return { run: null, seed: undefined };
  }
}

export class App {
  sim!: Simulation;
  scenario!: ScenarioDef;
  readonly renderer: Renderer;
  readonly view: ViewOptions;
  readonly settings: ToolSettings = { ...DEFAULT_SETTINGS };
  readonly designer: PopulationDesigner;
  readonly toaster: Toaster;
  readonly supportsMinimap: boolean;
  /** Every experiment, in start screen order (for scripts). */
  readonly scenarios: readonly ScenarioDef[] = SCENARIOS;
  tool: ToolDef = TOOLS[0];
  running = false;
  speedIdx = 2;
  followId = -1;
  /** True while the start screen is shown (nothing runs). */
  startOpen = false;
  /** True once a run was started from the start screen or a save was loaded. */
  hasRun = false;
  /** Pop-up notices about simulation events (Settings). */
  notices = store.get('notices') !== '0';
  helpOpen = false;
  readonly el: Record<string, HTMLElement> = {};

  private readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly start: StartScreen;
  private readonly toolPanel: ToolPanel;
  private readonly layers: LayersMenu;
  private readonly drawer: SettingsDrawer;
  private readonly analytics: AnalyticsPanel;
  private readonly inspector: Inspector;
  private readonly eventlog: EventLogPanel;
  private readonly painter: Painter;
  private readonly railBtns = new Map<ToolId, HTMLButtonElement>();
  private readonly tabBtns = new Map<Tab, HTMLButtonElement>();
  private readonly panes = new Map<Tab, HTMLElement>();
  private tab: Tab = 'stats';

  /** World shown behind the start screen (null = the current run). */
  private preview: { sim: Simulation; sc: ScenarioDef } | null = null;
  /** View used while the start screen is open (no selection, brush or minimap). */
  private startView: ViewOptions;
  /** Width of the start column in CSS px (measured when the start screen is laid out). */
  private startColW = 420;
  /** Camera and run state to restore with "Back to current run". */
  private resumeState: { x: number; y: number; zoom: number; running: boolean } | null = null;

  private drag: DragState | null = null;
  private pointer = { x: 0, y: 0, inside: false };
  private keys = new Set<string>();
  private flight: { fx: number; fy: number; tx: number; ty: number; t0: number } | null = null;

  private tickAcc = 0;
  private lastFrame = 0;
  private lastPanel = 0;
  private lastPerf = 0;
  private frames = 0;
  private ticksCounted = 0;
  private limitedUntil = 0;
  private needsApply = false;
  /** Set when speed or pause changes so the next perf window is not judged. */
  private perfDirty = true;
  private simError = false;
  private renderErrLogged = false;
  private panelErrLogged = false;
  /** Smoothed cost of one simulation tick in ms (see simulate()). */
  private tickCost = 1;
  private lastEventId = 0;
  /** One waiting notice about a simulation event (newest wins). */
  private pendingEvent: { ev: SimEvent; at: number } | null = null;
  private lastEventToast = -Infinity;
  private panelTicks = 0;
  private text: Record<string, string> = {};
  private hoverKey = '';
  private hudKey = '';

  constructor(mount: HTMLElement) {
    installTooltips();
    this.root = h('div', { class: 'al' });
    mount.replaceChildren(this.root);

    // ---------------------------------------------------------- stage (canvas + map controls)
    this.canvas = h('canvas', { class: 'world', tabindex: '0', 'aria-label': 'World map' });
    this.stage = h('main', { class: 'stage' }, this.canvas);
    this.renderer = new Renderer(this.canvas);
    this.toaster = new Toaster(this.stage);

    const storedView = (() => {
      try {
        return JSON.parse(store.get('view') ?? '{}') as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    const view = {
      overlay: 'none',
      selectedId: -1,
      hoverId: -1,
      showVision: true,
      showTrails: true,
      showRelations: true,
      showConnections: true,
      showCamps: true,
      showLabels: true,
      showMinimap: true,
      showLegend: true,
      brush: null,
    } as Record<string, unknown>;
    const allowed = new Set(VIEW_TOGGLES.map((t) => t.key));
    for (const [k, v] of Object.entries(storedView)) if (allowed.has(k) && typeof v === 'boolean') view[k] = v;
    const ov = store.get('overlay');
    if (ov && OVERLAYS.some((o) => o.value === ov)) view.overlay = ov;
    view.insets = { top: 0, right: ZOOM_COL, bottom: 0, left: 0 };
    this.view = view as unknown as ViewOptions;
    applyConnections(this.view, view.showConnections !== false);
    this.startView = { ...this.view, overlay: 'none', selectedId: -1, hoverId: -1, brush: null, showMinimap: false, showLegend: false, insets: { top: 0, right: 0, bottom: 0, left: 0 } };
    this.supportsMinimap = detectMinimap(this.renderer);

    this.painter = new Painter((x, y) => {
      const iv = brushIntervention(this.tool.id, this.settings, x, y, this.sim.config.dayLength);
      if (iv) this.enqueue(iv);
    });

    // ---------------------------------------------------------- simulation (always exists)
    const hash = readHash();
    const byId = (id: string | null) => (id ? SCENARIOS.find((s) => s.id === id) : undefined);
    const first = byId(hash.run) ?? byId(store.get('lastScenario')) ?? SCENARIOS.find((s) => s.id === 'eden') ?? SCENARIOS[0];
    this.scenario = first;
    this.sim = Simulation.create({ scenario: first, seed: hash.seed });
    this.designer = new PopulationDesigner(() => this.sim);

    // ---------------------------------------------------------- layout
    this.toolPanel = buildToolPanel(this);
    this.layers = buildLayersMenu(this);
    this.drawer = buildSettings(this);
    this.start = buildStartScreen({
      onPick: (sc, seed) => this.previewPick(sc, seed),
      onStart: () => this.begin(),
      onBack: () => this.closeStart(),
      onLoad: () => this.openLoadDialog(),
      onHelp: () => this.showHelp(true),
    });
    const top = this.buildTopbar();
    const side = this.buildSide();
    this.buildMapControls();
    this.root.append(top, this.stage, side, this.drawer.el, this.start.el, this.buildHelp(), this.buildDrop());
    if (store.get('hideSide') === '1') this.root.classList.add('no-side');
    this.el.sideBtn.classList.toggle('on', !this.root.classList.contains('no-side'));

    // ---------------------------------------------------------- panels
    const handlers: InspectorHandlers = {
      onSelect: (id: number) => this.showAgent(id, false),
      onFollow: (id: number) => {
        this.select(id);
        this.follow(id);
      },
      onKill: (id: number) => this.enqueue({ kind: 'killAgent', id }),
      onBoost: (id: number) => this.enqueue({ kind: 'boostAgent', id }),
      onShowOnMap: (id: number) => this.showAgent(id, true),
    };
    this.analytics = createAnalyticsPanel(this.panes.get('stats')!, { onJump: (x, y) => this.flyTo(x, y, true) });
    this.inspector = createInspector(this.panes.get('inspector')!, handlers);
    this.eventlog = createEventLog(this.panes.get('events')!, (x, y) => {
      this.flyTo(x, y, true);
      this.ripple(x, y, 30, 'rgba(214,166,72,0.9)');
    });

    // ---------------------------------------------------------- input
    this.bindCanvas();
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    new ResizeObserver(() => this.onResize()).observe(this.stage);
    document.addEventListener('mousedown', (e) => {
      // keep keyboard shortcuts working after clicking buttons: buttons never take focus, and a
      // text box that had it gives it up (typing a seed then clicking Restart must not leave
      // every shortcut typing into the seed box)
      const t = e.target as Element | null;
      if (t && t.closest && t.closest('button, .chip, summary')) {
        e.preventDefault();
        const a = document.activeElement;
        if (a instanceof HTMLElement && a.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) a.blur();
      }
    });
    document.addEventListener('pointerdown', (e) => this.closeMenusOutside(e), true);

    // ---------------------------------------------------------- boot
    this.renderer.resize();
    this.setSim(this.sim, first);
    this.setTool('inspect');
    this.setSpeed(2);
    this.updateTransport();
    if (hash.run !== null) {
      this.hasRun = true;
      this.setPaused(false);
      this.maybeShowHint();
    } else {
      this.openStart();
    }
    requestAnimationFrame(this.frame);
  }

  get camera(): Camera {
    return this.renderer.camera;
  }

  /** The world on screen: the start screen preview while it is open, else the current run. */
  get shownSim(): Simulation {
    return this.startOpen && this.preview ? this.preview.sim : this.sim;
  }

  // ============================================================== layout builders
  private buildTopbar(): HTMLElement {
    const el = this.el;
    el.expName = h('span', { class: 'exp-name' });
    el.play = h('button', { type: 'button', class: 'btn icon play-btn', tip: 'Play or pause (Space)', 'aria-label': 'Play or pause', onclick: () => this.togglePause() });
    el.speedLabel = h('button', { type: 'button', class: 'btn speed-label', 'aria-haspopup': 'true', 'aria-label': 'Speed', tip: 'Speed. Click to pick one.', onclick: () => this.toggleSpeedMenu() });
    el.speedMenu = h('div', { class: 'menu speed-menu', role: 'menu' });
    SPEEDS.forEach((s, i) => {
      el.speedMenu.append(
        h(
          'button',
          { type: 'button', class: 'menu-item', role: 'menuitemradio', 'data-i': String(i), onclick: () => { this.setSpeed(i); this.toggleSpeedMenu(false); } },
          h('span', null, SPEED_LABELS[i]),
          h('span', { class: 'menu-sub' }, s === 0 ? 'as fast as possible' : `${fmtInt(BASE_TPS * s)} ticks per second`),
        ),
      );
    });
    el.dayIcon = h('span', { class: 'day-ic' });
    el.clock = h('span', { class: 'clock-text' });
    el.pop = h('span', { class: 'pop-text' });
    const speed = h(
      'div',
      { class: 'speed' },
      h('button', { type: 'button', class: 'btn icon ghost', tip: 'Slower (<)', 'aria-label': 'Slower', onclick: () => this.setSpeed(this.speedIdx - 1) }, icon('slower', 16)),
      el.speedLabel,
      h('button', { type: 'button', class: 'btn icon ghost', tip: 'Faster (>)', 'aria-label': 'Faster', onclick: () => this.setSpeed(this.speedIdx + 1) }, icon('faster', 16)),
      el.speedMenu,
    );
    el.sideBtn = h('button', { type: 'button', class: 'btn icon ghost', tip: 'Show or hide the side panel', 'aria-label': 'Side panel', onclick: () => this.showSide(this.root.classList.contains('no-side')) }, icon('panelRight', 18));
    el.settingsBtn = h('button', { type: 'button', class: 'btn ghost', 'aria-label': 'Settings', onclick: () => this.showSettings(!this.drawer.isOpen) }, icon('gear', 17), h('span', null, 'Settings'));
    return h(
      'header',
      { class: 'topbar', 'data-tip-side': 'bottom' },
      h('div', { class: 'brand' }, icon('logo', 20, 'brand-ic'), h('span', { class: 'brand-name' }, 'Artificial Life')),
      h('button', { type: 'button', class: 'exp-btn', tip: 'Choose an experiment', onclick: () => this.openStart() }, el.expName, icon('chevronDown', 14)),
      h('div', { class: 'tb-gap' }),
      h(
        'div',
        { class: 'transport' },
        el.play,
        h('button', { type: 'button', class: 'btn icon ghost', tip: 'Step one tick (.)', 'aria-label': 'Step one tick', onclick: () => this.stepOnce() }, icon('step', 16)),
        speed,
      ),
      h('div', { class: 'clock', tip: '' }, el.dayIcon, el.clock),
      el.pop,
      h('div', { class: 'tb-gap' }),
      el.settingsBtn,
      h('button', { type: 'button', class: 'btn ghost', 'aria-label': 'Help', tip: 'Mouse and keyboard controls (H)', onclick: () => this.showHelp(true) }, icon('help', 17), h('span', null, 'Help')),
      el.sideBtn,
    );
  }

  private buildSide(): HTMLElement {
    const tabs: { id: Tab; label: string; icon: string }[] = [
      { id: 'stats', label: 'Overview', icon: 'chart' },
      { id: 'inspector', label: 'Agent', icon: 'person' },
      { id: 'events', label: 'Events', icon: 'list' },
    ];
    const bar = h('div', { class: 'tabs', role: 'tablist' });
    const panesEl = h('div', { class: 'panes' });
    for (const t of tabs) {
      const b = h('button', { type: 'button', class: 'tab', role: 'tab', onclick: () => this.setTab(t.id) }, icon(t.icon, 16), h('span', null, t.label));
      this.tabBtns.set(t.id, b);
      bar.append(b);
      const pane = h('div', { class: `pane pane-${t.id}`, role: 'tabpanel', 'aria-label': t.label });
      this.panes.set(t.id, pane);
      panesEl.append(pane);
    }
    const side = h('aside', { class: 'side', 'data-tip-side': 'left', 'aria-label': 'What is happening' }, bar, panesEl);
    this.applyTab();
    return side;
  }

  private buildMapControls(): void {
    const el = this.el;
    // tool rail on the left edge, the options of the active tool next to it
    const rail = h('div', { class: 'rail', role: 'toolbar', 'aria-label': 'Tools', 'data-tip-side': 'right' });
    for (const t of TOOLS) {
      const b = h('button', { type: 'button', class: 'rail-btn', tip: `${t.name} (${t.key})`, 'aria-label': `${t.name}, key ${t.key}`, onclick: () => this.setTool(this.tool.id === t.id && t.id !== 'inspect' ? 'inspect' : t.id) }, icon(t.icon, 20));
      this.railBtns.set(t.id, b);
      rail.append(b);
    }
    // status pills at the top centre
    el.paused = h('button', { type: 'button', class: 'pill', onclick: () => this.togglePause(), tip: 'Click or press Space to continue' }, icon('pause', 13), 'Paused');
    el.follow = h('button', { type: 'button', class: 'pill', onclick: () => this.stopFollow(), tip: 'Stop following (F, or move the map)' });
    el.pills = h('div', { class: 'pills' }, el.paused, el.follow);
    // layers (top right)
    const layersWrap = h('div', { class: 'map-tr' }, this.layers.button, this.layers.menu);
    // zoom (bottom right)
    el.zoom = h(
      'div',
      { class: 'zoom', role: 'group', 'aria-label': 'Zoom', 'data-tip-side': 'left' },
      h('button', { type: 'button', class: 'btn icon map-btn', tip: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => this.zoomBy(ZOOM_STEP) }, icon('plus', 18)),
      h('button', { type: 'button', class: 'btn icon map-btn', tip: 'Zoom out (-)', 'aria-label': 'Zoom out', onclick: () => this.zoomBy(1 / ZOOM_STEP) }, icon('minus', 18)),
      h('button', { type: 'button', class: 'btn icon map-btn', tip: 'Show the whole map (0)', 'aria-label': 'Show the whole map', onclick: () => this.fitWorld() }, icon('fit', 17)),
    );
    // one-time hint (bottom left)
    el.hint = h(
      'div',
      { class: 'hint-box', role: 'note' },
      h('span', null, 'Scroll to zoom, drag to move. Click an agent to see what it is doing.'),
      h('button', { type: 'button', class: 'btn icon ghost', 'aria-label': 'Dismiss hint', onclick: () => this.dismissHint() }, icon('x', 14)),
    );
    // hover card near the cursor
    el.hover = h('div', { class: 'hover-card', 'aria-hidden': 'true' });
    this.stage.append(rail, this.toolPanel.el, el.pills, layersWrap, el.zoom, el.hint, el.hover);
  }

  private buildHelp(): HTMLElement {
    const row = (keys: string[], what: string) => h('div', { class: 'key-row' }, h('span', { class: 'keys' }, ...keys.map((k) => (k === 'or' || k === 'and' || k === 'to' ? h('span', { class: 'key-sep' }, k) : h('kbd', null, k)))), h('span', null, what));
    const modal = h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Controls' },
      h('div', { class: 'modal-head' }, h('h2', null, 'Controls'), h('button', { type: 'button', class: 'btn icon ghost', 'aria-label': 'Close', onclick: () => this.showHelp(false) }, icon('x', 18))),
      h(
        'div',
        { class: 'key-grid' },
        h(
          'div',
          null,
          h('h3', null, 'Mouse'),
          row(['Scroll'], 'Zoom in and out'),
          row(['Drag'], 'Move the map'),
          row(['Right-drag'], 'Move the map with any tool'),
          row(['Click'], 'Select an agent (Inspect tool)'),
          row(['Double-click'], 'On an agent: follow it up close. On the ground: zoom in there.'),
          row(['Alt', 'and', 'Scroll'], 'Brush size'),
          row(['Shift', 'and', 'Click'], 'Smite an agent (Bless or smite tool)'),
          h('h3', null, 'Tools'),
          ...TOOLS.map((t) => row([t.key], t.name)),
        ),
        h(
          'div',
          null,
          h('h3', null, 'Keyboard'),
          row(['Space'], 'Play or pause'),
          row(['.'], 'Step one tick'),
          row(['<', 'and', '>'], 'Slower and faster'),
          row(['1', 'to', '9'], 'Choose a tool'),
          row(['[', 'and', ']'], 'Smaller and larger brush'),
          row(['+', 'and', '-'], 'Zoom in and out'),
          row(['0'], 'Show the whole map'),
          row(['W', 'A', 'S', 'D'], 'Move the map (or the arrow keys)'),
          row(['F'], 'Follow the selected agent'),
          row(['O'], 'Next data layer (Shift+O for the previous one)'),
          row(['Esc'], 'Close, deselect, back to Inspect'),
          row(['H', 'or', '?'], 'This list'),
          row(['Ctrl', 'and', 'S'], 'Save the world'),
          row(['Ctrl', 'and', 'O'], 'Load a saved world'),
        ),
      ),
      h('p', { class: 'modal-note' }, 'Everything you do to the world is recorded with its tick, so the same seed and the same interventions always replay the same history.'),
    );
    const back = h('div', { class: 'modal-back', onclick: (e: Event) => { if (e.target === back) this.showHelp(false); } }, modal);
    this.el.help = back;
    return back;
  }

  private buildDrop(): HTMLElement {
    const drop = h('div', { class: 'drop' }, h('div', { class: 'drop-card' }, icon('load', 28), h('div', null, 'Drop a saved world (.json) to load it')));
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      depth++;
      drop.classList.add('show');
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) drop.classList.remove('show');
    });
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      drop.classList.remove('show');
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.loadFile(f);
    });
    return drop;
  }

  // ============================================================== start screen
  /** Show the start screen: the current run pauses until Start or "Back to current run". */
  openStart(): void {
    if (this.startOpen) return;
    const cam = this.camera;
    this.resumeState = { x: cam.x, y: cam.y, zoom: cam.zoom, running: this.running };
    if (this.running) this.togglePause();
    this.painter.end();
    this.drag = null;
    this.flight = null;
    this.closeMenus();
    this.showSettings(false);
    this.toaster.clear();
    this.startOpen = true;
    this.preview = null;
    this.view.hoverId = -1;
    this.el.hover.classList.remove('show');
    this.root.classList.add('start-open');
    const seed = this.sim.config.seed;
    this.start.show(this.scenario, seed === defaultSeedOf(this.scenario) ? null : seed, this.hasRun);
    this.relayout();
    this.fitStart(this.shownSim);
  }

  /** Close the start screen without changes ("Back to current run"); before the first run it starts the selection. */
  closeStart(): void {
    if (!this.startOpen) return;
    if (!this.hasRun) {
      this.begin();
      return;
    }
    this.startOpen = false;
    this.preview = null;
    this.root.classList.remove('start-open');
    this.relayout();
    const r = this.resumeState;
    this.resumeState = null;
    if (r) {
      const cam = this.camera;
      cam.zoom = r.zoom;
      cam.x = r.x;
      cam.y = r.y;
      this.setPaused(!r.running);
    }
  }

  /** Start the experiment chosen on the start screen (same as pressing Start). */
  begin(): void {
    const sc = this.startOpen ? this.start.selected : this.scenario;
    const want = this.startOpen ? (this.start.seed ?? defaultSeedOf(sc)) : this.sim.config.seed;
    let sim: Simulation | null = null;
    const p = this.preview;
    if (p && p.sc.id === sc.id && p.sim.config.seed === want && p.sim.tick === 0) sim = p.sim;
    else if (!this.hasRun && this.sim.tick === 0 && this.scenario.id === sc.id && this.sim.config.seed === want) sim = this.sim;
    if (!sim) {
      try {
        sim = Simulation.create({ scenario: sc, seed: want });
      } catch (err) {
        console.error(err);
        this.toaster.show(errMsg(err), { kind: 'error', title: `Could not start ${sc.name}.` });
        return;
      }
    }
    this.startOpen = false;
    this.preview = null;
    this.resumeState = null;
    this.root.classList.remove('start-open');
    this.relayout();
    if (sim !== this.sim) this.setSim(sim, sc);
    else this.fitWorld();
    this.hasRun = true;
    store.set('lastScenario', sc.id);
    this.setSpeed(2);
    this.setPaused(false);
    this.maybeShowHint();
  }

  private previewPick(sc: ScenarioDef, seed: number | undefined): void {
    const want = seed ?? defaultSeedOf(sc);
    const p = this.preview;
    if (p && p.sc.id === sc.id && p.sim.config.seed === want && p.sim.tick === 0) return;
    if (this.sim.tick === 0 && this.scenario.id === sc.id && this.sim.config.seed === want) this.preview = { sim: this.sim, sc };
    else {
      try {
        this.preview = { sim: Simulation.create({ scenario: sc, seed: want }), sc };
      } catch (err) {
        console.error(err);
        this.toaster.show(errMsg(err), { kind: 'error', title: `Could not build ${sc.name}.` });
        return;
      }
    }
    this.fitStart(this.preview.sim);
  }

  /** Fit a world into the part of the map right of the start column. */
  private fitStart(sim: Simulation): void {
    const cam = this.camera;
    const col = this.start.el.getBoundingClientRect().width;
    this.startColW = col;
    const pad = 28;
    const w = Math.max(80, cam.viewW - col - pad * 2);
    const hh = Math.max(80, cam.viewH - pad * 2);
    const z = Math.min(w / sim.worldW, hh / sim.worldH);
    this.flight = null;
    this.followId = -1;
    cam.zoom = z > 0 && Number.isFinite(z) ? z : 1;
    cam.x = sim.worldW / 2 - col / 2 / cam.zoom;
    cam.y = sim.worldH / 2;
  }

  // ============================================================== experiment lifecycle
  /** Start a scenario from tick 0 (optionally with a seed and interventions to replay). */
  startScenario(sc: ScenarioDef, opts: { seed?: number; replay?: InterventionRecord[]; quiet?: boolean } = {}): boolean {
    let sim: Simulation;
    try {
      sim = Simulation.create({ scenario: sc, seed: opts.seed, replay: opts.replay });
    } catch (err) {
      console.error(err);
      this.toaster.show(errMsg(err), { kind: 'error', title: `Could not start ${sc.name}.` });
      return false;
    }
    const fromStart = this.startOpen;
    if (fromStart) {
      this.startOpen = false;
      this.preview = null;
      this.resumeState = null;
      this.root.classList.remove('start-open');
      this.relayout();
    }
    this.setSim(sim, sc);
    this.hasRun = true;
    store.set('lastScenario', sc.id);
    if (fromStart) this.setPaused(false);
    if (!opts.quiet) this.confirm(`Started ${sc.name} with seed ${sim.config.seed}.`);
    return true;
  }

  /** True when the loaded save names an experiment this app does not know (restart and replay cannot rebuild it). */
  private unknownScenario = false;

  private refuseUnknownScenario(action: string): boolean {
    if (!this.unknownScenario) return false;
    this.toaster.show(`This save comes from an experiment this version does not have ("${this.sim.state.scenarioId}"), so its first day cannot be rebuilt. Choose an experiment instead.`, { kind: 'bad', title: `Cannot ${action}.`, timeout: 9000 });
    return true;
  }

  restart(seed: number = this.sim.config.seed): void {
    if (this.refuseUnknownScenario('restart')) return;
    if (this.startScenario(this.scenario, { seed, quiet: true })) this.confirm(`Restarted ${this.scenario.name} with seed ${seed}.`);
  }

  replay(seed: number = this.sim.config.seed): void {
    if (this.refuseUnknownScenario('replay')) return;
    const log = this.sim.state.interventionLog.map((r) => ({ tick: r.tick, intervention: r.intervention }));
    if (!log.length) {
      this.confirm('There is nothing to replay yet. Use a tool or change a setting first.');
      return;
    }
    // the log keeps only the newest entries: once any were dropped the replay cannot match the run
    const dropped = (this.sim.state as { interventionLogDropped?: number }).interventionLogDropped ?? 0;
    if (this.startScenario(this.scenario, { seed, replay: log, quiet: true })) {
      if (dropped > 0) {
        this.toaster.show(`Only your latest ${fmtInt(log.length)} interventions were kept and the first ${fmtInt(dropped)} were dropped, so this replay will differ from your run.`, { kind: 'bad', title: 'Replay is incomplete.', timeout: 9000 });
      } else {
        this.confirm(`Restarted with seed ${seed}. Your ${plural(log.length, 'intervention')} will happen again at the same ticks.`);
      }
    }
  }

  private setSim(sim: Simulation, sc: ScenarioDef): void {
    this.sim = sim;
    this.scenario = sc;
    this.unknownScenario = false;
    this.simError = false;
    this.view.selectedId = -1;
    this.view.hoverId = -1;
    this.followId = -1;
    this.flight = null;
    this.tickAcc = 0;
    this.drag = null;
    this.painter.end();
    const evs = sim.state.events;
    this.lastEventId = evs.length ? evs[evs.length - 1].id : 0;
    this.pendingEvent = null;
    this.el.expName.textContent = sc.name;
    document.title = `Artificial Life: ${sc.name}`;
    this.fitWorld();
    this.drawer.onSimChanged();
    this.designer.refreshTribes();
    this.updateFollowChip();
    this.updatePanels(true);
  }

  /** The current experiment's starting configuration (for "reset to experiment defaults"). */
  scenarioConfig(): SimConfig {
    return { ...DEFAULT_CONFIG, ...this.scenario.config, seed: this.sim.config.seed };
  }

  save(): void {
    let json: string;
    try {
      json = serializeSim(this.sim);
    } catch (err) {
      console.error(err);
      this.toaster.show(errMsg(err), { kind: 'error', title: 'Could not save the world.' });
      return;
    }
    const name = `artificial-life_${this.sim.state.scenarioId || 'experiment'}_seed${this.sim.config.seed}_t${this.sim.tick}.json`;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = h('a', { href: url, download: name, style: 'display:none' });
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    this.confirm(`Saved ${name} (${(json.length / 1048576).toFixed(json.length > 1048576 ? 1 : 2)} MB).`);
  }

  openLoadDialog(): void {
    const input = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) void this.loadFile(f);
      input.remove();
    });
    document.body.append(input);
    input.click();
  }

  async loadFile(file: File): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch (err) {
      this.toaster.show(errMsg(err), { kind: 'error', title: `Could not read ${file.name}.` });
      return;
    }
    let sim: Simulation;
    const warnings: string[] = [];
    try {
      const state = deserializeState(text, { warnings });
      sim = Simulation.fromState(state);
    } catch (err) {
      console.info('Rejected save file:', errMsg(err));
      this.toaster.show(errMsg(err), { kind: 'error', title: `${file.name} is not an Artificial Life save.`, timeout: 9000 });
      return;
    }
    const id = sim.state.scenarioId;
    const known = SCENARIOS.find((s) => s.id === id);
    const sc: ScenarioDef = known ?? { ...SCENARIOS[0], id, name: id ? `Loaded: ${id}` : 'Loaded world', tagline: 'Loaded from a save file', description: 'A world restored from a save file.', lookFor: [] };
    const fromStart = this.startOpen;
    if (fromStart) {
      this.startOpen = false;
      this.preview = null;
      this.resumeState = null;
      this.root.classList.remove('start-open');
      this.relayout();
    }
    this.setSim(sim, sc);
    this.hasRun = true;
    // restart and replay rebuild the world from the scenario definition, which this app does not have
    this.unknownScenario = !known;
    if (fromStart) this.setPaused(false);
    const day = Math.floor(sim.state.env.day) + 1;
    this.confirm(`Loaded ${file.name}: day ${fmtInt(day)}, ${plural(sim.state.agents.length, 'agent')}.`);
    if (warnings.length) {
      console.info('Save file repairs:', warnings);
      const shown = warnings.slice(0, 3).join('; ');
      const more = warnings.length > 3 ? ` (and ${warnings.length - 3} more in the console)` : '';
      this.toaster.show(`${shown}${more}`, { kind: 'bad', title: `Repaired ${plural(warnings.length, 'problem')} in the save.`, timeout: 12000 });
    }
  }

  // ============================================================== notices
  /** Short confirmation of something the user just did (replaces any notice on screen). */
  confirm(message: string, opts: ToastOpts = {}): void {
    this.toaster.show(message, { kind: 'info', timeout: 3200, ...opts });
  }

  setNotices(on: boolean): void {
    this.notices = on;
    store.set('notices', on ? '1' : '0');
    if (!on) this.pendingEvent = null;
  }

  /** Simulation events worth a pop-up: wars, tribes dying out, epidemics, scheduled or big disasters, crashes. */
  private isMajor(ev: SimEvent): boolean {
    switch (ev.category) {
      case 'conflict':
        return ev.severity === 'major' && ev.agentId === undefined; // war declared (kill counts carry an agent)
      case 'tribe': {
        if (ev.severity !== 'major' || ev.tribeId === undefined) return false;
        const t = this.sim.state.tribes.find((x) => x.id === ev.tribeId);
        return Boolean(t && t.extinctTick !== -1); // died out
      }
      case 'disease':
        return ev.severity === 'major' || /epidemic/i.test(ev.message);
      case 'environment':
      case 'disaster':
        return ev.severity === 'major';
      case 'population':
        return ev.severity === 'major' || ev.severity === 'bad';
      default:
        return false;
    }
  }

  private showEvent(ev: SimEvent): void {
    this.lastEventToast = performance.now();
    this.toaster.show(plainText(ev.message), {
      kind: ev.severity === 'good' ? 'good' : 'major',
      timeout: 5500,
      onClick: () => {
        if (ev.agentId !== undefined && this.sim.getAgent(ev.agentId)) this.showAgent(ev.agentId, true);
        else if (ev.x !== undefined && ev.y !== undefined) this.flyTo(ev.x, ev.y, true);
        else {
          this.showSide(true);
          this.setTab('events');
        }
      },
    });
  }

  /** Queue major new events as notices (one at a time, spaced out). */
  private checkEvents(): void {
    const evs = this.sim.state.events;
    if (evs.length) {
      const newest = evs[evs.length - 1].id;
      if (newest > this.lastEventId) {
        for (let i = evs.length - 1; i >= 0 && evs[i].id > this.lastEventId; i--) {
          if (this.notices && !this.startOpen && this.isMajor(evs[i])) {
            if (!this.pendingEvent || this.pendingEvent.ev.id < evs[i].id) this.pendingEvent = { ev: evs[i], at: performance.now() };
            break;
          }
        }
        this.lastEventId = newest;
      }
    }
    const p = this.pendingEvent;
    if (!p) return;
    const now = performance.now();
    if (now - p.at > 20000) {
      this.pendingEvent = null;
      return;
    }
    if (!this.toaster.visible && now - this.lastEventToast >= EVENT_TOAST_GAP && now - this.toaster.lastShown >= 1500) {
      this.pendingEvent = null;
      this.showEvent(p.ev);
    }
  }

  private maybeShowHint(): void {
    if (store.get('hint') === 'done') return;
    this.el.hint.classList.add('show');
    this.stage.classList.add('hint-on');
  }

  private dismissHint(): void {
    this.el.hint.classList.remove('show');
    this.stage.classList.remove('hint-on');
    store.set('hint', 'done');
  }

  // ============================================================== interventions
  /** The single path for world changes: queue on the simulation (deterministic, recorded, replayable). */
  enqueue(iv: Intervention): void {
    this.sim.enqueue(iv);
    // while paused, advance one tick at the end of the frame so edits become visible
    if (!this.running) this.needsApply = true;
  }

  private clickAt(sx: number, sy: number, shift: boolean): void {
    const w = this.camera.screenToWorld(sx, sy);
    const sim = this.sim;
    switch (this.tool.id) {
      case 'inspect': {
        const a = this.renderer.pickAgent(sim, sx, sy);
        this.select(a ? a.id : -1, true);
        break;
      }
      case 'spawn': {
        if (!sim.passableAt(w.x, w.y)) {
          this.confirm('Agents cannot stand on deep water or walls.', { kind: 'bad' });
          return;
        }
        if (sim.population >= sim.config.maxAgents) {
          this.confirm(`The population cap of ${fmtInt(sim.config.maxAgents)} is reached. Raise it under Settings, More settings.`, { kind: 'bad', timeout: 4500 });
          return;
        }
        this.enqueue({ kind: 'spawn', ...this.designer.spec(w.x, w.y, this.settings.radius) });
        this.ripple(w.x, w.y, this.settings.radius, 'rgba(143,181,115,0.95)');
        break;
      }
      case 'disaster': {
        const iv = brushIntervention('disaster', this.settings, w.x, w.y, sim.config.dayLength);
        if (iv) {
          this.enqueue(iv);
          this.ripple(w.x, w.y, iv.kind === 'disaster' ? iv.radius : this.settings.radius, 'rgba(207,91,69,0.95)');
        }
        break;
      }
      case 'bless': {
        const a = this.renderer.pickAgent(sim, sx, sy);
        if (!a) {
          this.confirm('Click on an agent to bless it, or Shift-click to smite it.', { timeout: 2500 });
          return;
        }
        if (shift) {
          this.enqueue({ kind: 'killAgent', id: a.id });
          this.ripple(a.x, a.y, 14, 'rgba(207,91,69,0.95)');
        } else {
          this.enqueue({ kind: 'boostAgent', id: a.id });
          this.ripple(a.x, a.y, 14, 'rgba(214,166,72,0.95)');
        }
        break;
      }
      default:
        break;
    }
  }

  /** Expanding ring at a world position (visual confirmation of a click). */
  ripple(wx: number, wy: number, worldRadius: number, color: string): void {
    const p = this.camera.worldToScreen(wx, wy);
    const r = Math.max(10, Math.min(600, worldRadius * this.camera.zoom));
    const el = h('div', { class: 'ripple', style: `left:${p.x - r}px;top:${p.y - r}px;width:${r * 2}px;height:${r * 2}px;border-color:${color}` });
    this.stage.append(el);
    window.setTimeout(() => el.remove(), 700);
  }

  // ============================================================== transport
  togglePause(): void {
    if (this.startOpen && !this.running) return; // nothing runs behind the start screen
    this.running = !this.running;
    if (this.running) this.simError = false;
    this.tickAcc = 0;
    this.perfDirty = true;
    this.limitedUntil = 0;
    this.updateTransport();
  }

  setPaused(paused: boolean): void {
    if (this.running === !paused) return;
    this.togglePause();
  }

  stepOnce(): void {
    if (this.startOpen) return;
    if (this.running) this.running = false;
    this.simError = false;
    this.safeStep(1);
    this.updateTransport();
    this.updatePanels(false);
  }

  setSpeed(i: number): void {
    this.speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, i));
    const label = SPEED_LABELS[this.speedIdx];
    this.el.speedLabel.textContent = label;
    for (const b of this.el.speedMenu.children) {
      const on = Number((b as HTMLElement).dataset.i) === this.speedIdx;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    this.tickAcc = 0;
    this.limitedUntil = 0;
    this.perfDirty = true;
    this.text.limited = '';
  }

  private toggleSpeedMenu(v?: boolean): void {
    const m = this.el.speedMenu;
    m.classList.toggle('show', v ?? !m.classList.contains('show'));
  }

  private updateTransport(): void {
    this.el.play.replaceChildren(icon(this.running ? 'pause' : 'play', 17));
    this.el.play.classList.toggle('is-paused', !this.running);
    this.el.paused.style.display = this.running || this.startOpen ? 'none' : '';
  }

  private safeStep(n: number): number {
    let done = 0;
    try {
      for (; done < n; done++) this.sim.step();
    } catch (err) {
      this.onSimError(err);
    }
    return done;
  }

  private onSimError(err: unknown): void {
    console.error(err);
    this.simError = true;
    this.running = false;
    this.updateTransport();
    this.toaster.show(`${sentence(errMsg(err))} The run is paused: press play to try again, or restart.`, { kind: 'error', title: 'Simulation error.', timeout: 12000 });
  }

  // ============================================================== selection & camera
  /** Select an agent (-1 clears). `fromMap`: a click on the map, which also opens the side panel. */
  select(id: number, fromMap = false): void {
    this.view.selectedId = id;
    if (this.followId !== -1 && this.followId !== id) this.stopFollow();
    if (id !== -1 && fromMap && this.root.classList.contains('no-side')) this.showSide(true);
    if (id !== -1 && this.tab !== 'inspector') this.setTab('inspector');
    else this.updatePanel('inspector', true);
  }

  /** Select an agent and move the camera to it (zooming in when far out), without following. */
  private showAgent(id: number, close: boolean): void {
    this.select(id);
    const a = this.sim.getAgent(id);
    if (!a) return;
    this.flyTo(a.x, a.y, !close);
    if (close && this.camera.zoom < 3) this.camera.setZoom(3);
  }

  follow(id: number): void {
    if (!this.sim.getAgent(id)) return;
    this.followId = id;
    this.flight = null;
    this.updateFollowChip();
  }

  stopFollow(): void {
    if (this.followId === -1) return;
    this.followId = -1;
    this.updateFollowChip();
  }

  toggleFollow(): void {
    if (this.followId !== -1) return this.stopFollow();
    if (this.view.selectedId !== -1 && this.sim.getAgent(this.view.selectedId)) this.follow(this.view.selectedId);
    else this.confirm('Select an agent first (Inspect tool), then press F.', { timeout: 2600 });
  }

  private updateFollowChip(): void {
    const a = this.followId !== -1 ? this.sim.getAgent(this.followId) : undefined;
    this.el.follow.style.display = a ? '' : 'none';
    const label = a ? `Following ${a.name}` : '';
    if (a && this.text.follow !== label) {
      this.text.follow = label;
      this.el.follow.replaceChildren(icon('target', 14), label, icon('x', 13, 'pill-x'));
    }
  }

  fitWorld(): void {
    this.flight = null;
    this.stopFollow();
    if (this.startOpen) {
      this.fitStart(this.shownSim);
      return;
    }
    this.camera.fit(this.sim.worldW, this.sim.worldH);
  }

  /** Zoom around the centre of the map by `factor`. */
  zoomBy(factor: number): void {
    this.camera.zoomAt(this.camera.viewW / 2, this.camera.viewH / 2, factor);
  }

  /** Smoothly move the camera centre to a world point. */
  flyTo(x: number, y: number, zoomIn = true): void {
    this.stopFollow();
    this.flight = { fx: this.camera.x, fy: this.camera.y, tx: x, ty: y, t0: performance.now() };
    if (zoomIn && this.camera.zoom < 1.2) this.camera.setZoom(1.6);
  }

  /** World point under a screen point when it lies on the renderer's minimap (if the renderer has one). */
  private minimapWorld(sx: number, sy: number): { x: number; y: number } | null {
    if (this.startOpen || (this.view as { showMinimap?: boolean }).showMinimap === false) return null;
    const r = this.renderer as unknown as { minimapToWorld?: (x: number, y: number) => { x: number; y: number } | null };
    try {
      return typeof r.minimapToWorld === 'function' ? r.minimapToWorld(sx, sy) : null;
    } catch {
      return null;
    }
  }

  setOverlay(k: OverlayKind): void {
    this.view.overlay = k;
    this.layers.setOverlay(k);
    store.set('overlay', k);
  }

  saveView(): void {
    store.set('view', JSON.stringify(viewPrefs(this.view)));
  }

  setTool(id: ToolId): void {
    this.tool = toolById(id);
    for (const [tid, b] of this.railBtns) {
      b.classList.toggle('on', tid === id);
      b.setAttribute('aria-pressed', String(tid === id));
    }
    this.painter.end();
    this.toolPanel.onToolChanged();
    this.stage.classList.toggle('tool-open', id !== 'inspect');
    this.canvas.dataset.tool = id;
    this.updateCursor();
    if (id !== 'inspect') this.el.hover?.classList.remove('show');
  }

  showSide(show: boolean): void {
    this.root.classList.toggle('no-side', !show);
    store.set('hideSide', show ? '0' : '1');
    this.el.sideBtn.classList.toggle('on', show);
    this.relayout();
  }

  showSettings(show: boolean): void {
    if (show) this.closeMenus();
    this.drawer.open(show);
    this.el.settingsBtn.classList.toggle('on', show);
  }

  showHelp(show: boolean): void {
    this.helpOpen = show;
    this.el.help.classList.toggle('show', show);
  }

  setTab(t: Tab): void {
    if (this.tab === t) return;
    this.tab = t;
    this.applyTab();
    this.updatePanel(t, true);
  }

  private applyTab(): void {
    for (const [id, b] of this.tabBtns) {
      b.classList.toggle('on', id === this.tab);
      b.setAttribute('aria-selected', String(id === this.tab));
    }
    for (const [id, p] of this.panes) p.classList.toggle('on', id === this.tab);
  }

  private closeMenus(): void {
    this.layers.open(false);
    this.toggleSpeedMenu(false);
  }

  /** A press outside an open menu closes it. */
  private closeMenusOutside(e: Event): void {
    const t = e.target as Element | null;
    if (!t || !t.closest) return;
    if (this.layers.isOpen && !t.closest('.map-tr')) this.layers.open(false);
    if (this.el.speedMenu.classList.contains('show') && !t.closest('.speed')) this.toggleSpeedMenu(false);
    if (this.drawer.isOpen && !t.closest('.drawer') && !t.closest('[aria-label="Settings"]') && t.closest('.stage')) this.showSettings(false);
  }

  /** Sizes changed (start screen, side panel): resize the canvas now and keep the view centre. */
  private relayout(): void {
    const cam = this.camera;
    const cx = cam.x;
    const cy = cam.y;
    this.renderer.resize();
    cam.x = cx;
    cam.y = cy;
    this.hudKey = '';
  }

  // ============================================================== canvas input
  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bindCanvas(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    c.addEventListener('pointerenter', () => (this.pointer.inside = true));
    c.addEventListener('pointerleave', () => {
      this.pointer.inside = false;
      this.view.hoverId = -1;
      this.updateHoverCard();
    });
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('dblclick', (e) => {
      const p = this.local(e);
      if (this.minimapWorld(p.x, p.y)) return;
      if (!this.startOpen && this.tool.mode !== 'select') return;
      const a = this.startOpen ? null : this.renderer.pickAgent(this.sim, p.x, p.y);
      if (a) {
        // follow it and zoom to a close view
        this.select(a.id, true);
        this.follow(a.id);
        if (this.camera.targetZoom < CLOSE_ZOOM) this.camera.setZoom(CLOSE_ZOOM);
      } else {
        this.stopFollow();
        this.flight = null;
        this.camera.zoomAt(p.x, p.y, 2);
      }
    });
  }

  private onPointerDown(e: PointerEvent): void {
    const p = this.local(e);
    this.pointer = { x: p.x, y: p.y, inside: true };
    if (document.activeElement instanceof HTMLElement && document.activeElement !== this.canvas) document.activeElement.blur();
    if (this.drag) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const base = { id: e.pointerId, button: e.button, sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false };
    const mm = e.button === 0 ? this.minimapWorld(p.x, p.y) : null;
    if (this.startOpen) {
      this.drag = { kind: 'pan', ...base };
    } else if (mm) {
      this.drag = { kind: 'minimap', ...base };
      this.stopFollow();
      this.flyTo(mm.x, mm.y, false);
    } else if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      this.drag = { kind: 'pan', ...base };
    } else if (e.button === 0) {
      if (this.tool.mode === 'paint') {
        this.drag = { kind: 'paint', ...base };
        const w = this.camera.screenToWorld(p.x, p.y);
        this.painter.begin(w.x, w.y, performance.now());
      } else {
        this.drag = { kind: 'click', ...base };
      }
    }
    this.updateCursor();
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.local(e);
    this.pointer.x = p.x;
    this.pointer.y = p.y;
    this.pointer.inside = true;
    const d = this.drag;
    if (d && d.id === e.pointerId) {
      if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) > 4) {
        d.moved = true;
        if (d.kind === 'click') {
          d.kind = 'pan';
          this.updateCursor();
        }
      }
      if (d.kind === 'pan') {
        const dx = p.x - d.lx;
        const dy = p.y - d.ly;
        if (dx || dy) {
          this.camera.panBy(dx, dy);
          this.stopFollow();
          this.flight = null;
        }
        d.lx = p.x;
        d.ly = p.y;
      } else if (d.kind === 'paint') {
        const w = this.camera.screenToWorld(p.x, p.y);
        this.painter.move(w.x, w.y, this.settings.radius, performance.now(), this.tool.airbrush);
        d.lx = p.x;
        d.ly = p.y;
      } else if (d.kind === 'minimap') {
        const mm = this.minimapWorld(p.x, p.y);
        if (mm) {
          this.flight = null;
          this.camera.x = mm.x;
          this.camera.y = mm.y;
        }
      }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const p = this.local(e);
    if (d.kind === 'paint') {
      const w = this.camera.screenToWorld(p.x, p.y);
      this.painter.end(w.x, w.y, this.settings.radius, performance.now());
    } else if (d.kind === 'click' && !d.moved && e.type === 'pointerup') {
      this.clickAt(p.x, p.y, e.shiftKey);
    }
    this.updateCursor();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (e.altKey && !this.startOpen) {
      this.setRadius(this.settings.radius * Math.exp(-dy * 0.002));
      return;
    }
    const p = this.local(e);
    // one wheel notch (100 px) zooms about 1.35x
    const factor = Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.003);
    this.camera.zoomAt(p.x, p.y, factor);
  }

  setRadius(r: number): void {
    this.settings.radius = Math.max(6, Math.min(320, Math.round(r)));
    this.toolPanel.sync();
  }

  private cursorStyle = 'default';

  private updateCursor(): void {
    const d = this.drag;
    let c = 'default';
    if (d && (d.kind === 'pan' || d.kind === 'minimap')) c = 'grabbing';
    else if (this.tool.brush && !this.startOpen) c = 'crosshair';
    this.cursorStyle = c;
    this.canvas.style.cursor = c;
  }

  private onKeyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName ?? '';
    const type = tag === 'INPUT' ? (t as HTMLInputElement).type : '';
    const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && type !== 'range' && type !== 'checkbox') || Boolean(t?.isContentEditable);
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        if (!this.startOpen) this.save();
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        this.openLoadDialog();
      }
      return;
    }
    if (typing) {
      if (e.key === 'Escape') t?.blur();
      return;
    }
    if (type === 'range' && e.key.startsWith('Arrow')) return;
    if (this.helpOpen) {
      if (e.key === 'Escape' || e.key === 'h' || e.key === 'H' || e.key === '?') {
        this.showHelp(false);
        e.preventDefault();
      }
      return;
    }
    const k = e.key;
    if (this.startOpen) {
      // only a few keys work on the start screen
      if (k === 'Escape') {
        if (this.hasRun) this.closeStart();
      } else if (k === 'Enter' && !(tag === 'BUTTON')) this.begin();
      else if (k === 'h' || k === 'H' || k === '?') this.showHelp(true);
      else if (k === '+' || k === '=') this.zoomBy(ZOOM_STEP);
      else if (k === '-' || k === '_') this.zoomBy(1 / ZOOM_STEP);
      else if (k === '0') this.fitWorld();
      else return;
      e.preventDefault();
      return;
    }
    let handled = true;
    switch (k) {
      case ' ':
        this.togglePause();
        break;
      case '.':
        this.stepOnce();
        break;
      case '>':
        this.setSpeed(this.speedIdx + 1);
        break;
      case '<':
        this.setSpeed(this.speedIdx - 1);
        break;
      case 'f':
      case 'F':
        this.toggleFollow();
        break;
      case 'Escape':
        // close the topmost thing; otherwise deselect and go back to Inspect
        if (this.layers.isOpen || this.el.speedMenu.classList.contains('show')) this.closeMenus();
        else if (this.drawer.isOpen) this.showSettings(false);
        else {
          this.stopFollow();
          this.select(-1);
          if (this.tool.id !== 'inspect') this.setTool('inspect');
        }
        break;
      case 'h':
      case 'H':
      case '?':
        this.showHelp(true);
        break;
      case 'o':
      case 'O': {
        const i = OVERLAYS.findIndex((o) => o.value === this.view.overlay);
        const n = OVERLAYS.length;
        this.setOverlay(OVERLAYS[(i + (e.shiftKey ? n - 1 : 1)) % n].value);
        break;
      }
      case '[':
        this.setRadius(this.settings.radius / 1.2);
        break;
      case ']':
        this.setRadius(this.settings.radius * 1.2);
        break;
      case '+':
      case '=':
        this.zoomBy(ZOOM_STEP);
        break;
      case '-':
      case '_':
        this.zoomBy(1 / ZOOM_STEP);
        break;
      case '0':
        this.fitWorld();
        break;
      default:
        if (k.length === 1 && k >= '1' && k <= '9' && !e.altKey) this.setTool(TOOLS[Number(k) - 1].id);
        else if (PAN_CODES.has(e.code) && !e.altKey) this.keys.add(e.code);
        else handled = false;
    }
    if (handled) {
      e.preventDefault();
      if (t && t !== document.body && (tag === 'BUTTON' || tag === 'INPUT')) t.blur();
    }
  }

  private applyKeyPan(dt: number): void {
    if (!this.keys.size || this.startOpen) return;
    let x = 0;
    let y = 0;
    const k = this.keys;
    if (k.has('KeyA') || k.has('ArrowLeft')) x += 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x -= 1;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    if (!x && !y) return;
    const s = (720 * dt) / 1000;
    this.camera.panBy(x * s, y * s);
    this.stopFollow();
    this.flight = null;
  }

  private onResize(): void {
    const cam = this.camera;
    const cx = cam.x;
    const cy = cam.y;
    this.renderer.resize();
    cam.x = cx;
    cam.y = cy;
    this.hudKey = '';
    if (this.startOpen) this.fitStart(this.shownSim);
    this.renderSafe(performance.now());
  }

  // ============================================================== frame loop
  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = this.lastFrame ? Math.min(250, Math.max(0, now - this.lastFrame)) : 16;
    this.lastFrame = now;
    this.applyKeyPan(dt);
    if (this.drag?.kind === 'paint') this.painter.hold(this.settings.radius, performance.now(), this.tool.airbrush);
    this.simulate(dt);
    this.updateCamera(now);
    this.updateHover();
    this.updateBrush();
    this.renderSafe(now);
    this.updateTopbar(now);
    if (now - this.lastPanel >= 250) {
      this.lastPanel = now;
      this.updatePanels(false);
      this.layoutHud();
    }
    this.frames++;
    if (now - this.lastPerf >= 1000) {
      const span = now - this.lastPerf;
      if (this.lastPerf) {
        const tps = (this.ticksCounted * 1000) / span;
        const fps = (this.frames * 1000) / span;
        // CPU-limited = the requested speed is not being met over the last second
        const sp = SPEEDS[this.speedIdx];
        if (this.running && sp > 0 && !this.perfDirty && tps < BASE_TPS * sp * 0.85) this.limitedUntil = now + 1100;
        this.drawer.setPerf(tps, fps, this.running && sp > 0 && now < this.limitedUntil);
      }
      this.perfDirty = false;
      this.frames = 0;
      this.ticksCounted = 0;
      this.lastPerf = now;
    }
  };

  private simulate(dt: number): void {
    if (this.simError || this.startOpen) {
      this.needsApply = false;
      return;
    }
    let ticks = 0;
    const t0 = performance.now();
    // Another tick is run only if it is expected to finish inside the budget. Checking only
    // "budget not yet exceeded" overshoots by up to one tick (several ms at ~1000 agents), which
    // pushes busy frames past the display refresh.
    const fits = () => performance.now() - t0 + this.tickCost <= STEP_BUDGET_MS;
    try {
      if (this.running) {
        const sp = SPEEDS[this.speedIdx];
        if (sp === 0) {
          do {
            this.stepTimed();
            ticks++;
          } while (fits());
        } else {
          const perSec = BASE_TPS * sp;
          this.tickAcc = Math.min(this.tickAcc + (dt / 1000) * perSec, perSec * 0.25 + 1);
          let n = Math.floor(this.tickAcc);
          this.tickAcc -= n;
          while (n > 0) {
            this.stepTimed();
            ticks++;
            n--;
            if (n > 0 && !fits()) {
              this.tickAcc = 0;
              break;
            }
          }
        }
      } else if (this.needsApply) {
        this.sim.step();
        ticks++;
      }
    } catch (err) {
      this.onSimError(err);
    }
    this.needsApply = false;
    this.ticksCounted += ticks;
  }

  /** One simulation tick, timed into the smoothed per-tick cost used for frame budgeting. */
  private stepTimed(): void {
    const t = performance.now();
    this.sim.step();
    const ms = performance.now() - t;
    this.tickCost += (Math.min(ms, 50) - this.tickCost) * 0.1;
  }

  private updateCamera(now: number): void {
    const cam = this.camera;
    if (this.flight) {
      const f = this.flight;
      const t = Math.min(1, (now - f.t0) / 420);
      const e = 1 - Math.pow(1 - t, 3);
      cam.x = f.fx + (f.tx - f.fx) * e;
      cam.y = f.fy + (f.ty - f.fy) * e;
      if (t >= 1) this.flight = null;
    }
    if (this.followId !== -1 && !this.startOpen) {
      const a = this.sim.getAgent(this.followId);
      if (a) {
        cam.x += (a.x - cam.x) * 0.16;
        cam.y += (a.y - cam.y) * 0.16;
      } else {
        const rec = this.sim.lineageById.get(this.followId);
        if (rec) this.confirm(`${rec.name} ${rec.deathCause ? DEATH_LABEL[rec.deathCause] : 'died'}. The camera stopped following.`, { timeout: 4000 });
        this.followId = -1;
        this.updateFollowChip();
      }
    }
  }

  private renderSafe(now: number): void {
    try {
      if (this.startOpen) {
        const sv = this.startView as unknown as Record<string, unknown>;
        const v = this.view as unknown as Record<string, unknown>;
        for (const t of VIEW_TOGGLES) if (t.key !== 'showMinimap') sv[t.key] = v[t.key];
        sv.showRelations = v.showRelations;
        const ins = this.startView.insets!;
        ins.left = this.startColW;
        this.renderer.render(this.shownSim, this.startView, now);
      } else this.renderer.render(this.sim, this.view, now);
    } catch (err) {
      if (!this.renderErrLogged) {
        this.renderErrLogged = true;
        console.error(err);
        this.toaster.show(errMsg(err), { kind: 'error', title: 'Drawing error.' });
      }
    }
  }

  private updateBrush(): void {
    const t = this.tool;
    const d = this.drag;
    if (!this.startOpen && t.brush && this.pointer.inside && !(d && (d.kind === 'pan' || d.kind === 'minimap')) && !this.helpOpen && !(!d && this.minimapWorld(this.pointer.x, this.pointer.y))) {
      const w = this.camera.screenToWorld(this.pointer.x, this.pointer.y);
      const b = this.view.brush;
      const color = brushColor(t, this.settings);
      const radius = effectiveRadius(t.id, this.settings); // e.g. meteors are capped: preview what really happens
      if (b) {
        b.x = w.x;
        b.y = w.y;
        b.radius = radius;
        b.color = color;
      } else this.view.brush = { x: w.x, y: w.y, radius, color };
    } else this.view.brush = null;
  }

  /** Hovered agent: view.hoverId (the renderer rings it) and the hover card. */
  private updateHover(): void {
    const allow = !this.startOpen && this.pointer.inside && !this.drag && (this.tool.mode !== 'paint' || this.tool.id === 'remove') && !this.helpOpen && !this.minimapWorld(this.pointer.x, this.pointer.y);
    const a = allow ? this.renderer.pickAgent(this.sim, this.pointer.x, this.pointer.y) : null;
    const id = a ? a.id : -1;
    if (id !== this.view.hoverId) {
      this.view.hoverId = id;
      this.updateHoverCard();
    } else if (this.frames % 6 === 0) this.updateHoverCard();
    else this.placeHoverCard();
    this.canvas.style.cursor = a && !this.drag && this.tool.mode !== 'paint' ? 'pointer' : this.cursorStyle;
  }

  /** Card near the cursor: the hovered agent (Inspect tool), or the ground under it while a data layer is on. */
  private updateHoverCard(): void {
    const card = this.el.hover;
    const show = !this.startOpen && this.pointer.inside && !this.drag && this.tool.id === 'inspect' && !this.helpOpen && !this.minimapWorld(this.pointer.x, this.pointer.y);
    if (!show) {
      card.classList.remove('show');
      this.hoverKey = '';
      return;
    }
    const sim = this.sim;
    const a = this.view.hoverId !== -1 ? sim.getAgent(this.view.hoverId) : undefined;
    let key = '';
    let build: (() => void) | null = null;
    if (a) {
      const tribe = sim.getTribe(a.tribeId);
      const days = a.age / Math.max(1, sim.config.dayLength);
      const age = days < 1 ? 'less than a day old' : `${days < 10 ? days.toFixed(1) : Math.round(days)} days old`;
      // the same sentence and thought text as the Agent tab
      const doing = describeAction(sim, a);
      const said = a.thought ? plainText(a.thought) : '';
      const thought = said.length > 80 ? `${said.slice(0, 78).trimEnd()}...` : said;
      key = `a|${a.id}|${doing}|${thought}|${age}|${tribe?.id ?? -1}`;
      build = () =>
        fill(
          card,
          h('div', { class: 'hc-name' }, h('span', { class: 'hc-dot', style: `background:hsl(${tribe ? tribe.hue : a.traits.hue}, 45%, 58%)` }), a.name),
          h('div', { class: 'hc-sub' }, `${tribe ? tribe.name : 'No tribe'}, ${age}, generation ${a.generation}`),
          h('div', { class: 'hc-doing' }, doing),
          thought ? h('div', { class: 'hc-thought' }, thought) : null,
        );
    } else if (this.view.overlay !== 'none') {
      const w = this.camera.screenToWorld(this.pointer.x, this.pointer.y);
      const i = sim.tileIndex(w.x, w.y);
      if (i >= 0) {
        const world = sim.state.world;
        const terr = TERRAIN_INFO[world.terrain[i] as TerrainType];
        const owner = world.territory ? world.territory[i] : -1;
        const tribe = owner >= 0 ? sim.getTribe(owner) : undefined;
        const food = world.food[i];
        const fert = Math.round(world.fertility[i] * 100);
        key = `t|${i}|${food.toFixed(1)}|${fert}|${tribe?.id ?? -1}`;
        build = () =>
          fill(
            card,
            h('div', { class: 'hc-name' }, terr ? terr.name : 'Land'),
            h('div', { class: 'hc-sub' }, `Food ${food.toFixed(1)}, fertility ${fert}%`),
            tribe ? h('div', { class: 'hc-sub' }, `${tribe.name} land`) : null,
          );
      }
    }
    if (!build) {
      card.classList.remove('show');
      this.hoverKey = '';
      return;
    }
    const fresh = key !== this.hoverKey || !card.classList.contains('show');
    if (key !== this.hoverKey) {
      this.hoverKey = key;
      build();
    }
    card.classList.add('show');
    if (fresh) this.hoverSize = { w: card.offsetWidth, h: card.offsetHeight };
    this.placeHoverCard();
  }

  /** Size of the hover card, measured when its content changes (not every frame). */
  private hoverSize = { w: 0, h: 0 };

  private placeHoverCard(): void {
    const card = this.el.hover;
    if (!card.classList.contains('show')) return;
    const vw = this.camera.viewW;
    const vh = this.camera.viewH;
    const w = this.hoverSize.w;
    const hh = this.hoverSize.h;
    let x = this.pointer.x + 16;
    let y = this.pointer.y + 18;
    if (x + w > vw - 8) x = this.pointer.x - w - 12;
    if (y + hh > vh - 8) y = this.pointer.y - hh - 12;
    card.style.transform = `translate(${Math.round(Math.max(4, x))}px, ${Math.round(Math.max(4, y))}px)`;
  }

  /** Keep the hint box, zoom buttons and tool options clear of the minimap wherever the renderer puts it. */
  private layoutHud(): void {
    const r = this.renderer as unknown as {
      minimapRect?: { x: number; y: number; w: number; h: number; visible: boolean };
      connectionsLegendRect?: { y: number; visible: boolean };
    };
    const rect = r.minimapRect;
    const vw = this.camera.viewW;
    const vh = this.camera.viewH;
    const ties = (this.view as { showConnections?: boolean; showCamps?: boolean }).showConnections !== false || this.view.showCamps;
    const leg = r.connectionsLegendRect;
    // a legend taller than the room kept for it (a future renderer change) lays the panel out again
    const tall = !!rect && !!leg && leg.visible && leg.y < rect.y - LEGEND_ZONE ? Math.round(leg.y) : 0;
    const key = rect ? `${rect.visible}|${Math.round(rect.x)}|${Math.round(rect.y)}|${Math.round(rect.w)}|${Math.round(rect.h)}|${vw}|${vh}|${ties}|${tall}` : `none|${vw}|${vh}`;
    if (key === this.hudKey) return;
    this.hudKey = key;
    const onLeft = !!rect && rect.visible && rect.x < vw / 2;
    const left = onLeft ? Math.round(rect!.x + rect!.w + 12) : 14;
    this.el.hint.style.left = `${left}px`;
    const onRight = rect && rect.visible && rect.x >= vw / 2;
    this.el.zoom.style.right = onRight ? `${Math.round(vw - rect.x + 10)}px` : '';
    // the options panel stops above the minimap and the connections legend drawn just above it
    // (read from the style sheet: the panel is often hidden here, with no layout of its own)
    const panel = this.toolPanel.el;
    const ps = getComputedStyle(panel);
    const pLeft = parseFloat(ps.left) || 0;
    const pTop = parseFloat(ps.top) || 0;
    if (onLeft && rect!.x < pLeft + (parseFloat(ps.width) || 0)) {
      const legendTop = !ties ? rect!.y : tall ? Math.min(tall, rect!.y - LEGEND_ZONE) : rect!.y - LEGEND_ZONE;
      panel.style.maxHeight = `${Math.max(180, Math.round(legendTop - pTop - 10))}px`;
    } else panel.style.maxHeight = '';
  }

  private setText(key: string, value: string): void {
    if (this.text[key] === value) return;
    this.text[key] = value;
    const node = this.el[key];
    if (node) node.textContent = value;
  }

  private updateTopbar(now: number): void {
    const sim = this.sim;
    const env = sim.state.env;
    const season = sim.config.seasons ? `, ${(SEASON_NAMES[env.season] ?? '').toLowerCase()}` : '';
    this.setText('clock', `Day ${fmtInt(Math.floor(env.day) + 1)}${season}, year ${env.year + 1}`);
    const night = sim.config.dayNight && env.daylight < 0.4;
    const dayKey = night ? 'moon' : 'sun';
    if (this.text.dayIcon !== dayKey) {
      this.text.dayIcon = dayKey;
      this.el.dayIcon.replaceChildren(icon(dayKey, 17));
      this.el.dayIcon.classList.toggle('night', night);
    }
    if (this.frames % 15 === 0) {
      const clock = this.el.clock.parentElement;
      if (clock) clock.dataset.tip = `Tick ${fmtInt(sim.tick)}. A day is ${fmtInt(sim.config.dayLength)} ticks.`;
    }
    this.setText('pop', plural(sim.state.agents.length, 'agent'));
    const limited = this.running && SPEEDS[this.speedIdx] !== 0 && now < this.limitedUntil;
    const lk = String(limited);
    if (this.text.limited !== lk) {
      this.text.limited = lk;
      const b = this.el.speedLabel;
      b.classList.toggle('limited', limited);
      b.dataset.tip = limited ? `Your computer cannot keep up with ${SPEED_LABELS[this.speedIdx]}, so the simulation runs as fast as it can.` : 'Speed. Click to pick one.';
    }
  }

  private logPanelErr(err: unknown): void {
    if (this.panelErrLogged) return;
    this.panelErrLogged = true;
    console.error(err);
  }

  private updatePanel(t: Tab, force: boolean): void {
    const sim = this.sim;
    try {
      if (t === 'stats') this.analytics?.update(sim, force);
      else if (t === 'inspector') this.inspector?.update(sim, this.view.selectedId);
      else this.eventlog?.update(sim);
    } catch (err) {
      this.logPanelErr(err);
    }
  }

  private updatePanels(force: boolean): void {
    if (force) for (const t of this.panes.keys()) this.updatePanel(t, true);
    else if (!this.startOpen && !this.root.classList.contains('no-side')) this.updatePanel(this.tab, false);
    this.checkEvents();
    if (this.drawer.isOpen) this.drawer.sync();
    this.updateHoverCard();
    this.updateFollowChip();
    if (this.tool.id === 'spawn' && ++this.panelTicks % 8 === 0) this.designer.refreshTribes();
  }
}

/** True when the renderer can draw a minimap (detected from its public surface). */
function detectMinimap(r: Renderer): boolean {
  const rec = r as unknown as Record<string, unknown>;
  for (const k of ['minimap', 'drawMinimap', 'renderMinimap', 'minimapHit', 'minimapRect']) if (k in rec && rec[k] !== undefined) return true;
  return false;
}
