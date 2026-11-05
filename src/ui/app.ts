// OWNER: UI/UX agent. Application shell: layout, game loop, camera & tool input,
// experiment lifecycle (start / restart / replay / save / load), panels and toasts.
import { Simulation } from '../sim/simulation';
import { SCENARIOS } from '../sim/presets';
import { DEFAULT_CONFIG } from '../sim/config';
import { SEASON_NAMES, TERRAIN_INFO } from '../sim/constants';
import { deserializeState, serializeSim } from '../sim/persistence';
import type { ActionKind, DeathCause, Intervention, InterventionRecord, ScenarioDef, SimConfig, SimEvent, TerrainType } from '../sim/types';
import { Renderer, type OverlayKind, type ViewOptions } from '../render/renderer';
import type { Camera } from '../render/camera';
import { createAnalyticsPanel, type AnalyticsPanel } from './analytics';
import { createInspector, type Inspector } from './inspector';
import { createEventLog, type EventLogPanel } from './eventlog';
import { fmtInt, h, icon, installTooltips, store, Toaster } from './dom';
import { DEFAULT_SETTINGS, Painter, TOOLS, brushColor, brushIntervention, toolById, type ToolDef, type ToolId, type ToolSettings } from './tools';
import { PopulationDesigner } from './designer';
import { buildLeftSidebar, OVERLAYS, viewPrefs, type LeftSidebar } from './controls';

/** Speed multipliers; 0 = "Max" (as many ticks as fit the frame budget). */
export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 0];
const SPEED_LABELS = ['¼×', '½×', '1×', '2×', '4×', '8×', '16×', '32×', '64×', 'Max'];
/** Ticks per second at 1×. */
const BASE_TPS = 30;
/** Hard budget for simulation stepping per animation frame (ms). */
const STEP_BUDGET_MS = 12;
const PAN_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

type Tab = 'stats' | 'inspector' | 'events';

const ACTION_LABEL: Record<ActionKind, string> = {
  idle: 'Idle',
  wander: 'Wandering',
  explore: 'Exploring',
  forage: 'Foraging',
  eat: 'Eating',
  rest: 'Resting',
  flee: 'Fleeing',
  attack: 'Attacking',
  share: 'Sharing food',
  mate: 'Courting',
  socialize: 'Socialising',
  gohome: 'Heading home',
  deposit: 'Storing food',
  withdraw: 'Taking from stores',
};

const DEATH_LABEL: Record<DeathCause, string> = {
  starvation: 'starved',
  old_age: 'died of old age',
  combat: 'was killed in combat',
  disease: 'succumbed to disease',
  disaster: 'was killed by a disaster',
  removed: 'was removed',
};

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface DragState {
  kind: 'pan' | 'paint' | 'click';
  id: number;
  button: number;
  sx: number;
  sy: number;
  lx: number;
  ly: number;
  moved: boolean;
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
  tool: ToolDef = TOOLS[0];
  running = true;
  speedIdx = 2;
  followId = -1;

  private readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly left: LeftSidebar;
  private readonly analytics: AnalyticsPanel;
  private readonly inspector: Inspector;
  private readonly eventlog: EventLogPanel;
  private readonly painter: Painter;
  private readonly el: Record<string, HTMLElement> = {};
  private readonly speedBtns: HTMLButtonElement[] = [];
  private readonly railBtns = new Map<ToolId, HTMLButtonElement>();
  private readonly tabBtns = new Map<Tab, HTMLButtonElement>();
  private readonly panes = new Map<Tab, HTMLElement>();
  private tab: Tab = 'stats';

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
  private simError = false;
  private renderErrLogged = false;
  private panelErrLogged = false;
  private lastEventId = 0;
  private unseenEvents = 0;
  private toastQueue: SimEvent[] = [];
  private lastToastT = 0;
  private helpOpen = false;
  private panelTicks = 0;
  private text: Record<string, string> = {};

  constructor(mount: HTMLElement) {
    installTooltips();
    this.root = h('div', { class: 'al' });
    mount.replaceChildren(this.root);

    // ---------------------------------------------------------- stage (canvas + HUD)
    this.canvas = h('canvas', { class: 'world', tabindex: '0', 'aria-label': 'World view — use the tools to interact' });
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
      showCamps: true,
      showLabels: true,
      showMinimap: true,
      brush: null,
    } as Record<string, unknown>;
    for (const [k, v] of Object.entries(storedView)) if (typeof v === 'boolean' && typeof view[k] === 'boolean') view[k] = v;
    const ov = store.get('overlay');
    if (ov && OVERLAYS.some((o) => o.value === ov)) view.overlay = ov;
    this.view = view as unknown as ViewOptions;
    this.supportsMinimap = detectMinimap(this.renderer);

    this.painter = new Painter((x, y) => {
      const iv = brushIntervention(this.tool.id, this.settings, x, y, this.sim.config.dayLength);
      if (iv) this.enqueue(iv);
    });

    // ---------------------------------------------------------- simulation
    const first = SCENARIOS.find((s) => s.id === 'eden') ?? SCENARIOS[0];
    this.scenario = first;
    this.sim = Simulation.create({ scenario: first });
    this.designer = new PopulationDesigner(() => this.sim);

    // ---------------------------------------------------------- layout
    const top = this.buildTopbar();
    this.left = buildLeftSidebar(this);
    const right = this.buildRight();
    this.buildHud();
    this.root.append(top, this.left.el, this.stage, right);
    this.root.append(this.buildHelp(), this.buildDrop());
    if (store.get('hideLeft') === '1') this.root.classList.add('no-left');
    if (store.get('hideRight') === '1') this.root.classList.add('no-right');

    // ---------------------------------------------------------- panels
    const handlers = {
      onSelect: (id: number) => {
        this.select(id);
        const a = this.sim.getAgent(id);
        if (a) this.flyTo(a.x, a.y);
      },
      onFollow: (id: number) => {
        this.select(id);
        this.follow(id);
      },
      onKill: (id: number) => this.enqueue({ kind: 'killAgent', id }),
      onBoost: (id: number) => this.enqueue({ kind: 'boostAgent', id }),
    };
    this.analytics = createAnalyticsPanel(this.panes.get('stats')!);
    this.inspector = createInspector(this.panes.get('inspector')!, handlers);
    this.eventlog = createEventLog(this.panes.get('events')!, (x, y) => {
      this.flyTo(x, y);
      this.ripple(x, y, 30, 'rgba(245,177,76,0.9)');
    });

    // ---------------------------------------------------------- input
    this.bindCanvas();
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    new ResizeObserver(() => this.onResize()).observe(this.stage);
    document.addEventListener('mousedown', (e) => {
      // keep keyboard shortcuts working after clicking buttons (no lingering focus)
      const t = e.target as Element | null;
      if (t && t.closest && t.closest('button, .chip')) e.preventDefault();
    });

    // ---------------------------------------------------------- boot
    this.renderer.resize();
    this.setSim(this.sim, first);
    this.setTool('inspect', false);
    this.setSpeed(2);
    this.updateTransport();
    if (!store.get('welcomed')) {
      store.set('welcomed', '1');
      this.toaster.show('Pick a tool on the left of the map (keys 1–9), click the world to intervene, and press H for every shortcut.', { title: 'Welcome to Artificial Life', timeout: 9000 });
    }
    requestAnimationFrame(this.frame);
  }

  get camera(): Camera {
    return this.renderer.camera;
  }

  // ============================================================== layout builders
  private buildTopbar(): HTMLElement {
    const el = this.el;
    el.expName = h('span', { class: 'exp-name' }, '—');
    el.expSeed = h('span', { class: 'exp-seed mono' });
    el.play = h('button', { type: 'button', class: 'btn icon play-btn', tip: 'Play / pause (Space)', 'aria-label': 'Play or pause', onclick: () => this.togglePause() });
    const seg = h('div', { class: 'seg speed', role: 'radiogroup', 'aria-label': 'Simulation speed' });
    SPEEDS.forEach((s, i) => {
      const b = h(
        'button',
        {
          type: 'button',
          role: 'radio',
          tip: s === 0 ? 'Max: run as many ticks as fit in the frame budget (12 ms per frame). Shortcut: < and >' : `${s}× speed = ${BASE_TPS * s} ticks per second. Shortcut: < and >`,
          onclick: () => this.setSpeed(i),
        },
        SPEED_LABELS[i],
      );
      this.speedBtns.push(b);
      seg.append(b);
    });
    el.dayIcon = h('span', { class: 'day-ic' });
    el.clock = h('span', { class: 'clock-text' });
    el.tick = h('span', { class: 'clock-tick mono' });
    el.pop = h('span', { class: 'mono stat-num' });
    el.tribes = h('span', { class: 'mono stat-num' });
    el.tps = h('span', { class: 'mono' });
    el.fps = h('span', { class: 'mono' });
    el.cpu = h('span', { class: 'badge warn cpu', tip: 'CPU-limited: the requested speed needs more computation than the 12 ms per-frame budget allows, so the simulation runs as fast as it can.' }, icon('cpu', 12), 'CPU-limited');
    return h(
      'header',
      { class: 'topbar', 'data-tip-side': 'bottom' },
      h('div', { class: 'brand' }, icon('logo', 22, 'brand-ic'), h('span', { class: 'brand-name' }, 'Artificial Life')),
      h(
        'button',
        {
          type: 'button',
          class: 'exp-chip',
          tip: 'The experiment currently running. Click to choose another experiment, change the seed or replay your interventions.',
          onclick: () => {
            this.showLeft(true);
            this.left.openSection('experiments');
          },
        },
        h('span', { class: 'exp-kicker' }, 'Experiment'),
        el.expName,
        el.expSeed,
      ),
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'transport' }, el.play, h('button', { type: 'button', class: 'btn icon', tip: 'Advance one tick (.)', 'aria-label': 'Step one tick', onclick: () => this.stepOnce() }, icon('step', 15)), seg),
      h('div', { class: 'clock', tip: 'In-game calendar. Days alternate light and dark; seasons change plant growth and temperature.' }, el.dayIcon, h('span', { class: 'clock-stack' }, el.clock, el.tick)),
      h('div', { class: 'tb-stat', tip: 'Living agents' }, icon('users', 15), el.pop),
      h('div', { class: 'tb-stat', tip: 'Living tribes' }, icon('flag', 14), el.tribes),
      h('div', { class: 'perf', tip: 'Simulation ticks per second · rendered frames per second' }, h('span', { class: 'perf-row' }, el.tps, h('span', { class: 'muted' }, ' TPS')), h('span', { class: 'perf-row' }, el.fps, h('span', { class: 'muted' }, ' FPS'))),
      el.cpu,
      h('div', { class: 'tb-spacer' }),
      h('button', { type: 'button', class: 'btn icon ghost', tip: 'Keyboard & mouse shortcuts (H)', 'aria-label': 'Help', onclick: () => this.showHelp(true) }, icon('keyboard', 17)),
      h('button', { type: 'button', class: 'btn icon ghost', tip: 'Show / hide the controls sidebar', 'aria-label': 'Toggle left sidebar', onclick: () => this.showLeft(this.root.classList.contains('no-left')) }, icon('panelLeft', 17)),
      h('button', { type: 'button', class: 'btn icon ghost', tip: 'Show / hide the statistics sidebar', 'aria-label': 'Toggle right sidebar', onclick: () => this.showRight(this.root.classList.contains('no-right')) }, icon('panelRight', 17)),
    );
  }

  private buildRight(): HTMLElement {
    const tabs: { id: Tab; label: string; icon: string; tip: string }[] = [
      { id: 'stats', label: 'Stats', icon: 'chart', tip: 'Population, genetics, tribes and causes of death over time.' },
      { id: 'inspector', label: 'Inspector', icon: 'person', tip: 'Everything about the selected agent: needs, mind, genes, family and relationships.' },
      { id: 'events', label: 'Events', icon: 'list', tip: 'Chronicle of births of tribes, wars, disasters, plagues and records. Click an event to jump there.' },
    ];
    const bar = h('div', { class: 'tabs', role: 'tablist' });
    const panesEl = h('div', { class: 'panes' });
    for (const t of tabs) {
      const b = h('button', { type: 'button', class: 'tab', role: 'tab', tip: t.tip, onclick: () => this.setTab(t.id) }, icon(t.icon, 15), h('span', null, t.label));
      if (t.id === 'events') b.append((this.el.evBadge = h('span', { class: 'tab-badge' })));
      this.tabBtns.set(t.id, b);
      bar.append(b);
      const pane = h('div', { class: `pane pane-${t.id}`, role: 'tabpanel' });
      this.panes.set(t.id, pane);
      panesEl.append(pane);
    }
    const right = h('aside', { class: 'sidebar right', 'data-tip-side': 'left', 'aria-label': 'Analysis' }, bar, panesEl);
    this.applyTab();
    return right;
  }

  private buildHud(): void {
    const rail = h('div', { class: 'rail', role: 'toolbar', 'aria-label': 'Tools', 'data-tip-side': 'right' });
    for (const t of TOOLS) {
      const b = h('button', { type: 'button', class: 'rail-btn', tip: `${t.name}  [${t.key}]\n${t.blurb}`, 'aria-label': `${t.name} (key ${t.key})`, onclick: () => this.setTool(t.id) }, icon(t.icon, 18), h('span', { class: 'k' }, t.key));
      this.railBtns.set(t.id, b);
      rail.append(b);
    }
    const el = this.el;
    el.paused = h('button', { type: 'button', class: 'hud-pill paused-pill', onclick: () => this.togglePause(), tip: 'Click or press Space to resume' }, icon('pause', 12), 'Paused');
    el.follow = h('button', { type: 'button', class: 'hud-pill follow-pill', onclick: () => this.stopFollow(), tip: 'Click, press F or pan the camera to stop following' });
    el.cursor = h('div', { class: 'cursor-info mono' });
    el.hover = h('div', { class: 'hover-card' });
    el.toolHud = h('div', { class: 'tool-hud' });
    el.keysHint = h('button', { type: 'button', class: 'keys-hint', onclick: () => this.showHelp(true) }, h('kbd', null, 'H'), ' shortcuts');
    this.stage.append(rail, h('div', { class: 'hud-top' }, el.paused, el.follow), el.toolHud, el.cursor, el.keysHint, el.hover);
  }

  private buildHelp(): HTMLElement {
    const row = (keys: string[], what: string) => h('div', { class: 'key-row' }, h('span', { class: 'keys' }, ...keys.map((k) => h('kbd', null, k))), h('span', null, what));
    const modal = h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Shortcuts' },
      h('div', { class: 'modal-head' }, icon('logo', 22, 'brand-ic'), h('h2', null, 'Artificial Life — controls'), h('button', { type: 'button', class: 'btn icon ghost', 'aria-label': 'Close', onclick: () => this.showHelp(false) }, icon('x', 16))),
      h('p', { class: 'modal-lead' }, 'A living world of agents with genomes, needs, memories, relationships and tribes. Everything you do is an intervention recorded with its tick — the same seed plus the same interventions always replays the same history.'),
      h(
        'div',
        { class: 'key-grid' },
        h('div', null, h('h3', null, 'Time'), row(['Space'], 'Play / pause'), row(['.'], 'Advance one tick'), row(['<', '>'], 'Slower / faster'), h('h3', null, 'Camera'), row(['Wheel'], 'Zoom at cursor'), row(['Drag'], 'Pan (Inspect tool, or any click tool)'), row(['Right-drag'], 'Pan with any tool'), row(['W', 'A', 'S', 'D'], 'Pan (or arrow keys)'), row(['+', '−'], 'Zoom in / out'), row(['0'], 'Fit the whole world'), row(['F'], 'Follow selected agent')),
        h('div', null, h('h3', null, 'Tools'), row(['1', '–', '9'], 'Choose a tool'), ...TOOLS.map((t) => row([t.key], t.name)), row(['[', ']'], 'Brush smaller / larger (or Alt + wheel)'), row(['Shift', 'Click'], 'Smite (with Bless tool)')),
        h('div', null, h('h3', null, 'Panels'), row(['O'], 'Cycle data overlay'), row(['Esc'], 'Deselect / close'), row(['H'], 'This help'), row(['Ctrl', 'S'], 'Save experiment'), row(['Ctrl', 'O'], 'Load experiment'), h('h3', null, 'Tips'), h('ul', { class: 'tips' }, h('li', null, 'Paint a wall across the map and watch the two halves drift apart genetically.'), h('li', null, 'Spawn "Warlike raiders" next to "Gentle foragers" and compare in the Stats tab.'), h('li', null, 'Hover any control for an explanation.'))),
      ),
    );
    const back = h('div', { class: 'modal-back', onclick: (e: Event) => { if (e.target === back) this.showHelp(false); } }, modal);
    this.el.help = back;
    return back;
  }

  private buildDrop(): HTMLElement {
    const drop = h('div', { class: 'drop' }, h('div', { class: 'drop-card' }, icon('load', 28), h('div', null, 'Drop a saved experiment (.json) to load it')));
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

  // ============================================================== experiment lifecycle
  /** Start a scenario from tick 0 (optionally with a seed and interventions to replay). */
  startScenario(sc: ScenarioDef, opts: { seed?: number; replay?: InterventionRecord[]; quiet?: boolean } = {}): boolean {
    let sim: Simulation;
    try {
      sim = Simulation.create({ scenario: sc, seed: opts.seed, replay: opts.replay });
    } catch (err) {
      console.error(err);
      this.toaster.show(`Could not start "${sc.name}": ${errMsg(err)}`, { kind: 'error', title: 'Experiment failed to start' });
      return false;
    }
    this.setSim(sim, sc);
    if (!opts.quiet) this.toaster.show(sc.tagline || 'Experiment started.', { title: `${sc.name} · seed ${sim.config.seed}`, kind: 'info' });
    return true;
  }

  restart(seed: number = this.sim.config.seed): void {
    this.startScenario(this.scenario, { seed });
  }

  replay(seed: number = this.sim.config.seed): void {
    const log = this.sim.state.interventionLog.map((r) => ({ tick: r.tick, intervention: r.intervention }));
    if (!log.length) {
      this.toaster.show('You have not made any interventions in this run yet — use the tools, global events or parameters first.', { kind: 'info', title: 'Nothing to replay' });
      return;
    }
    if (this.startScenario(this.scenario, { seed, replay: log, quiet: true })) {
      this.toaster.show(`Restarted with seed ${seed}; your ${fmtInt(log.length)} interventions will be re-applied at their original ticks.`, { kind: 'good', title: 'Replaying your interventions' });
    }
  }

  private setSim(sim: Simulation, sc: ScenarioDef): void {
    this.sim = sim;
    this.scenario = sc;
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
    this.toastQueue = [];
    this.unseenEvents = 0;
    this.el.expName.textContent = sc.name;
    this.el.expSeed.textContent = `seed ${sim.config.seed}`;
    document.title = `${sc.name} · Artificial Life`;
    this.fitWorld();
    this.left.onSimChanged();
    this.updateFollowChip();
    this.updatePanels(true);
  }

  /** The current experiment's starting configuration (for "reset parameters"). */
  scenarioConfig(): SimConfig {
    return { ...DEFAULT_CONFIG, ...this.scenario.config, seed: this.sim.config.seed };
  }

  save(): void {
    let json: string;
    try {
      json = serializeSim(this.sim);
    } catch (err) {
      console.error(err);
      this.toaster.show(errMsg(err), { kind: 'error', title: 'Could not save the experiment' });
      return;
    }
    const name = `artificial-life_${this.sim.state.scenarioId || 'experiment'}_seed${this.sim.config.seed}_t${this.sim.tick}.json`;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = h('a', { href: url, download: name, style: 'display:none' });
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    this.toaster.show(`${name} (${(json.length / 1048576).toFixed(json.length > 1048576 ? 1 : 2)} MB)`, { kind: 'good', title: 'Experiment saved' });
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
      this.toaster.show(errMsg(err), { kind: 'error', title: `Could not read "${file.name}"` });
      return;
    }
    let sim: Simulation;
    try {
      const state = deserializeState(text);
      sim = Simulation.fromState(state);
    } catch (err) {
      console.warn('Invalid save file', err);
      this.toaster.show(errMsg(err), { kind: 'error', title: `"${file.name}" is not a valid Artificial Life save`, timeout: 9000 });
      return;
    }
    const id = sim.state.scenarioId;
    const sc: ScenarioDef = SCENARIOS.find((s) => s.id === id) ?? { ...SCENARIOS[0], id, name: id ? `Loaded: ${id}` : 'Loaded experiment', tagline: 'Loaded from a save file', description: 'An experiment restored from a save file.', lookFor: [] };
    this.setSim(sim, sc);
    this.toaster.show(`Resumed at tick ${fmtInt(sim.tick)} with ${fmtInt(sim.state.agents.length)} agents and ${fmtInt(sim.state.interventionLog.length)} recorded interventions.`, { kind: 'good', title: `Loaded "${file.name}"` });
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
        this.select(a ? a.id : -1);
        break;
      }
      case 'spawn': {
        if (!sim.passableAt(w.x, w.y)) {
          this.toaster.show('Agents cannot be placed on impassable terrain (deep water or walls).', { kind: 'bad', title: 'Cannot spawn here', timeout: 2600 });
          return;
        }
        this.enqueue({ kind: 'spawn', ...this.designer.spec(w.x, w.y, this.settings.radius) });
        this.ripple(w.x, w.y, this.settings.radius, 'rgba(46,230,208,0.9)');
        if (sim.population >= sim.config.maxAgents) this.toaster.show('The population cap is reached — raise "Population cap" in Parameters to add more agents.', { kind: 'bad', title: 'Population cap', timeout: 4000 });
        break;
      }
      case 'disaster': {
        const iv = brushIntervention('disaster', this.settings, w.x, w.y, sim.config.dayLength);
        if (iv) {
          this.enqueue(iv);
          this.ripple(w.x, w.y, iv.kind === 'disaster' ? iv.radius : this.settings.radius, 'rgba(228,91,214,0.95)');
        }
        break;
      }
      case 'bless': {
        const a = this.renderer.pickAgent(sim, sx, sy);
        if (!a) {
          this.toaster.show('Click directly on an agent to bless it (Shift-click to smite).', { kind: 'info', timeout: 2200 });
          return;
        }
        if (shift) {
          this.enqueue({ kind: 'killAgent', id: a.id });
          this.ripple(a.x, a.y, 14, 'rgba(255,93,108,0.95)');
          this.toaster.show(`${a.name} was struck down.`, { kind: 'bad', title: 'Smite', timeout: 2400 });
        } else {
          this.enqueue({ kind: 'boostAgent', id: a.id });
          this.ripple(a.x, a.y, 14, 'rgba(255,214,102,0.95)');
          this.toaster.show(`${a.name} is fully healed and fed.`, { kind: 'good', title: 'Blessed', timeout: 2400 });
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
    const el = h('div', { class: 'ripple', style: `left:${p.x - r}px;top:${p.y - r}px;width:${r * 2}px;height:${r * 2}px;border-color:${color};box-shadow:0 0 18px ${color}` });
    this.stage.append(el);
    window.setTimeout(() => el.remove(), 700);
  }

  // ============================================================== transport
  togglePause(): void {
    this.running = !this.running;
    if (this.running) this.simError = false;
    this.tickAcc = 0;
    this.updateTransport();
  }

  setPaused(paused: boolean): void {
    if (this.running === !paused) return;
    this.togglePause();
  }

  stepOnce(): void {
    if (this.running) this.running = false;
    this.simError = false;
    this.safeStep(1);
    this.updateTransport();
    this.updatePanels(false);
  }

  setSpeed(i: number): void {
    this.speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, i));
    this.speedBtns.forEach((b, j) => {
      b.classList.toggle('on', j === this.speedIdx);
      b.setAttribute('aria-checked', String(j === this.speedIdx));
    });
    this.tickAcc = 0;
    this.limitedUntil = 0;
  }

  private updateTransport(): void {
    this.el.play.replaceChildren(icon(this.running ? 'pause' : 'play', 15));
    this.el.play.classList.toggle('is-paused', !this.running);
    this.el.paused.style.display = this.running ? 'none' : '';
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
    this.toaster.show(`${errMsg(err)} — the run was paused. Press play to retry, or restart / load another experiment.`, { kind: 'error', title: 'Simulation error', timeout: 12000 });
  }

  // ============================================================== selection & camera
  select(id: number): void {
    this.view.selectedId = id;
    if (this.followId !== -1 && this.followId !== id) this.stopFollow();
    if (id !== -1 && this.tab !== 'inspector') this.setTab('inspector');
    else this.updatePanel('inspector', true);
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
    else this.toaster.show('Select a living agent first (Inspect tool, key 1), then press F.', { kind: 'info', timeout: 2600 });
  }

  private updateFollowChip(): void {
    const a = this.followId !== -1 ? this.sim.getAgent(this.followId) : undefined;
    this.el.follow.style.display = a ? '' : 'none';
    if (a) this.el.follow.replaceChildren(icon('target', 12), `Following ${a.name}`, icon('x', 11, 'pill-x'));
  }

  fitWorld(): void {
    this.flight = null;
    this.stopFollow();
    this.camera.fit(this.sim.worldW, this.sim.worldH);
  }

  /** Smoothly move the camera centre to a world point. */
  flyTo(x: number, y: number): void {
    this.stopFollow();
    this.flight = { fx: this.camera.x, fy: this.camera.y, tx: x, ty: y, t0: performance.now() };
    if (this.camera.zoom < 1.2) this.camera.zoomAt(this.camera.viewW / 2, this.camera.viewH / 2, 1.6 / this.camera.zoom);
  }

  setOverlay(k: OverlayKind): void {
    this.view.overlay = k;
    this.left.setOverlay(k);
    store.set('overlay', k);
  }

  saveView(): void {
    store.set('view', JSON.stringify(viewPrefs(this.view)));
  }

  setTool(id: ToolId, reveal = true): void {
    this.tool = toolById(id);
    for (const [tid, b] of this.railBtns) b.classList.toggle('on', tid === id);
    this.left.onToolChanged();
    this.painter.end();
    this.el.toolHud.replaceChildren(icon(this.tool.icon, 13), h('span', null, this.tool.name), this.tool.brush ? h('span', { class: 'muted mono' }, ` · ${Math.round(this.settings.radius)} u`) : null);
    this.canvas.dataset.tool = id;
    if (reveal && id !== 'inspect' && !this.root.classList.contains('no-left')) this.left.openSection('tool');
  }

  showLeft(show: boolean): void {
    this.root.classList.toggle('no-left', !show);
    store.set('hideLeft', show ? '0' : '1');
  }

  showRight(show: boolean): void {
    this.root.classList.toggle('no-right', !show);
    store.set('hideRight', show ? '0' : '1');
  }

  showHelp(show: boolean): void {
    this.helpOpen = show;
    this.el.help.classList.toggle('show', show);
  }

  setTab(t: Tab): void {
    if (this.tab === t) return;
    this.tab = t;
    this.applyTab();
    if (t === 'events') this.unseenEvents = 0;
    this.updatePanel(t, true);
  }

  private applyTab(): void {
    for (const [id, b] of this.tabBtns) {
      b.classList.toggle('on', id === this.tab);
      b.setAttribute('aria-selected', String(id === this.tab));
    }
    for (const [id, p] of this.panes) p.classList.toggle('on', id === this.tab);
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
      this.el.hover.classList.remove('show');
    });
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('dblclick', (e) => {
      if (this.tool.mode !== 'select') return;
      const p = this.local(e);
      const a = this.renderer.pickAgent(this.sim, p.x, p.y);
      if (a) {
        this.select(a.id);
        this.follow(a.id);
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
    if (e.button === 1 || e.button === 2) {
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
      }
    }
    this.updateCursorInfo();
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
    if (e.altKey) {
      this.setRadius(this.settings.radius * Math.exp(-dy * 0.002));
      return;
    }
    const p = this.local(e);
    const factor = Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.0018);
    this.camera.zoomAt(p.x, p.y, factor);
  }

  setRadius(r: number): void {
    this.settings.radius = Math.max(6, Math.min(320, Math.round(r)));
    this.left.sync();
    this.setTool(this.tool.id, false);
  }

  private updateCursor(): void {
    const d = this.drag;
    let c = 'default';
    if (d && d.kind === 'pan') c = 'grabbing';
    else if (this.tool.brush) c = 'crosshair';
    else if (this.tool.id === 'bless') c = 'pointer';
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
        this.save();
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
        this.stopFollow();
        this.select(-1);
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
        this.camera.zoomAt(this.camera.viewW / 2, this.camera.viewH / 2, 1.3);
        break;
      case '-':
      case '_':
        this.camera.zoomAt(this.camera.viewW / 2, this.camera.viewH / 2, 1 / 1.3);
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
    if (!this.keys.size) return;
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
    this.renderSafe(performance.now());
  }

  // ============================================================== frame loop
  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = this.lastFrame ? Math.min(100, Math.max(0, now - this.lastFrame)) : 16;
    this.lastFrame = now;
    this.applyKeyPan(dt);
    if (this.drag?.kind === 'paint') this.painter.hold(this.settings.radius, performance.now(), this.tool.airbrush);
    this.simulate(dt, now);
    this.updateCamera(now);
    this.updateHover();
    this.updateBrush();
    this.renderSafe(now);
    this.updateTopbar(now);
    if (now - this.lastPanel >= 250) {
      this.lastPanel = now;
      this.updatePanels(false);
    }
    this.frames++;
    if (now - this.lastPerf >= 1000) {
      const span = now - this.lastPerf;
      if (this.lastPerf) {
        this.setText('fps', String(Math.round((this.frames * 1000) / span)));
        this.setText('tps', String(Math.round((this.ticksCounted * 1000) / span)));
      }
      this.frames = 0;
      this.ticksCounted = 0;
      this.lastPerf = now;
    }
  };

  private simulate(dt: number, now: number): void {
    if (this.simError) {
      this.needsApply = false;
      return;
    }
    let ticks = 0;
    const t0 = performance.now();
    try {
      if (this.running) {
        const sp = SPEEDS[this.speedIdx];
        if (sp === 0) {
          do {
            this.sim.step();
            ticks++;
          } while (performance.now() - t0 < STEP_BUDGET_MS);
        } else {
          const perSec = BASE_TPS * sp;
          this.tickAcc = Math.min(this.tickAcc + (dt / 1000) * perSec, perSec * 0.25 + 1);
          let n = Math.floor(this.tickAcc);
          this.tickAcc -= n;
          while (n > 0) {
            this.sim.step();
            ticks++;
            n--;
            if (n > 0 && performance.now() - t0 > STEP_BUDGET_MS) {
              this.limitedUntil = now + 1500;
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
    if (this.followId !== -1) {
      const a = this.sim.getAgent(this.followId);
      if (a) {
        cam.x += (a.x - cam.x) * 0.16;
        cam.y += (a.y - cam.y) * 0.16;
      } else {
        const rec = this.sim.lineageById.get(this.followId);
        if (rec) this.toaster.show(`${rec.name} ${rec.deathCause ? DEATH_LABEL[rec.deathCause] : 'died'}.`, { kind: 'bad', title: 'Followed agent died', timeout: 3500 });
        this.followId = -1;
        this.updateFollowChip();
      }
    }
  }

  private renderSafe(now: number): void {
    try {
      this.renderer.render(this.sim, this.view, now);
    } catch (err) {
      if (!this.renderErrLogged) {
        this.renderErrLogged = true;
        console.error(err);
        this.toaster.show(errMsg(err), { kind: 'error', title: 'Rendering error' });
      }
    }
  }

  private updateBrush(): void {
    const t = this.tool;
    const d = this.drag;
    if (t.brush && this.pointer.inside && !(d && d.kind === 'pan') && !this.helpOpen) {
      const w = this.camera.screenToWorld(this.pointer.x, this.pointer.y);
      const b = this.view.brush;
      const color = brushColor(t, this.settings);
      if (b) {
        b.x = w.x;
        b.y = w.y;
        b.radius = this.settings.radius;
        b.color = color;
      } else this.view.brush = { x: w.x, y: w.y, radius: this.settings.radius, color };
    } else this.view.brush = null;
  }

  private updateHover(): void {
    const card = this.el.hover;
    const allow = this.pointer.inside && !this.drag && (this.tool.mode !== 'paint' || this.tool.id === 'remove') && !this.helpOpen;
    const a = allow ? this.renderer.pickAgent(this.sim, this.pointer.x, this.pointer.y) : null;
    this.view.hoverId = a ? a.id : -1;
    if (!a) {
      card.classList.remove('show');
      return;
    }
    const tribe = this.sim.getTribe(a.tribeId);
    const hp = Math.round((a.health / Math.max(1, a.traits.maxHealth)) * 100);
    const food = Math.round((a.food / Math.max(1, a.traits.maxFood)) * 100);
    const key = `${a.id}|${a.action}|${a.thought}|${hp}|${food}|${a.tribeId}|${a.infection > 0}`;
    if (card.dataset.key !== key) {
      card.dataset.key = key;
      card.replaceChildren(
        h('div', { class: 'hc-name' }, h('span', { class: 'hc-dot', style: `background:hsl(${a.traits.hue},70%,60%)` }), a.name, h('span', { class: 'hc-gen' }, `gen ${a.generation}`)),
        h('div', { class: 'hc-action' }, ACTION_LABEL[a.action] ?? a.action, a.thought ? h('span', { class: 'hc-thought' }, ` — ${a.thought.length > 64 ? a.thought.slice(0, 62) + '…' : a.thought}`) : null),
        h(
          'div',
          { class: 'hc-meta' },
          tribe ? h('span', { class: 'hc-tribe', style: `color:hsl(${tribe.hue},70%,68%)` }, tribe.name) : h('span', { class: 'muted' }, 'no tribe'),
          h('span', { class: 'mono' }, `♥ ${hp}%`),
          h('span', { class: 'mono' }, `◍ ${food}%`),
          a.infection > 0 ? h('span', { class: 'hc-sick' }, 'infected') : null,
        ),
      );
    }
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    const cw = card.offsetWidth || 200;
    const ch = card.offsetHeight || 60;
    let x = this.pointer.x + 16;
    let y = this.pointer.y + 16;
    if (x + cw > sw - 8) x = this.pointer.x - cw - 12;
    if (y + ch > sh - 8) y = this.pointer.y - ch - 12;
    card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    card.classList.add('show');
  }

  private updateCursorInfo(): void {
    const el = this.el.cursor;
    if (!this.pointer.inside) {
      el.classList.remove('show');
      return;
    }
    const sim = this.sim;
    const w = this.camera.screenToWorld(this.pointer.x, this.pointer.y);
    const i = sim.tileIndex(w.x, w.y);
    if (i < 0) {
      el.classList.remove('show');
      return;
    }
    const world = sim.state.world;
    const terr = TERRAIN_INFO[world.terrain[i] as TerrainType];
    const owner = world.territory ? world.territory[i] : -1;
    const tribe = owner >= 0 ? sim.getTribe(owner) : undefined;
    const txt = `${Math.round(w.x)}, ${Math.round(w.y)}  ·  ${terr ? terr.name : '?'}  ·  food ${world.food[i].toFixed(1)}  ·  fertility ${Math.round(world.fertility[i] * 100)}%${tribe ? `  ·  ${tribe.name} land` : ''}`;
    if (this.text.cursor !== txt) {
      this.text.cursor = txt;
      el.textContent = txt;
    }
    el.classList.add('show');
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
    this.setText('clock', `Year ${env.year + 1} · ${SEASON_NAMES[env.season] ?? '—'} · Day ${Math.floor(env.day) + 1}`);
    this.setText('tick', `tick ${fmtInt(sim.tick)}`);
    const night = sim.config.dayNight && env.daylight < 0.4;
    const dayKey = night ? 'moon' : 'sun';
    if (this.text.dayIcon !== dayKey) {
      this.text.dayIcon = dayKey;
      this.el.dayIcon.replaceChildren(icon(dayKey, 16));
      this.el.dayIcon.classList.toggle('night', night);
    }
    this.setText('pop', fmtInt(sim.state.agents.length));
    let tribes = 0;
    for (const t of sim.state.tribes) if (t.extinctTick === -1) tribes++;
    this.setText('tribes', String(tribes));
    const limited = this.running && SPEEDS[this.speedIdx] !== 0 && now < this.limitedUntil;
    if (this.text.cpu !== String(limited)) {
      this.text.cpu = String(limited);
      this.el.cpu.classList.toggle('show', limited);
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
    else this.updatePanel(this.tab, false);
    this.checkEvents();
    this.left.sync();
    this.updateCursorInfo();
    this.updateFollowChip();
    if (this.tool.id === 'spawn' && ++this.panelTicks % 8 === 0) this.designer.refreshTribes();
  }

  /** Toast new 'major' events (rate-limited) and badge the Events tab. */
  private checkEvents(): void {
    const evs = this.sim.state.events;
    if (evs.length) {
      const newest = evs[evs.length - 1].id;
      if (newest > this.lastEventId) {
        const fresh: SimEvent[] = [];
        let count = 0;
        for (let i = evs.length - 1; i >= 0 && evs[i].id > this.lastEventId; i--) {
          count++;
          if (evs[i].severity === 'major' && evs[i].category !== 'intervention') fresh.push(evs[i]);
        }
        this.lastEventId = newest;
        if (this.tab !== 'events') this.unseenEvents += count;
        fresh.reverse();
        this.toastQueue.push(...fresh);
        if (this.toastQueue.length > 3) this.toastQueue.splice(0, this.toastQueue.length - 3);
      }
    }
    const badge = this.el.evBadge;
    const label = this.unseenEvents > 0 ? (this.unseenEvents > 99 ? '99+' : String(this.unseenEvents)) : '';
    if (badge.textContent !== label) {
      badge.textContent = label;
      badge.classList.toggle('show', Boolean(label));
    }
    const now = performance.now();
    if (this.toastQueue.length && now - this.lastToastT > 1300) {
      const ev = this.toastQueue.shift()!;
      this.lastToastT = now;
      const more = this.toastQueue.length;
      this.toaster.show(ev.message, {
        kind: 'major',
        title: `${ev.category.charAt(0).toUpperCase()}${ev.category.slice(1)} · tick ${fmtInt(ev.tick)}${more ? `  (+${more} more)` : ''}`,
        timeout: 6000,
        onClick: () => {
          if (ev.agentId !== undefined && this.sim.getAgent(ev.agentId)) this.handlersSelect(ev.agentId);
          else if (ev.x !== undefined && ev.y !== undefined) this.flyTo(ev.x, ev.y);
          else this.setTab('events');
        },
      });
    }
  }

  private handlersSelect(id: number): void {
    this.select(id);
    const a = this.sim.getAgent(id);
    if (a) this.flyTo(a.x, a.y);
  }
}

/** True when the renderer can draw a minimap (detected from its public surface). */
function detectMinimap(r: Renderer): boolean {
  const rec = r as unknown as Record<string, unknown>;
  for (const k of ['minimap', 'drawMinimap', 'renderMinimap', 'minimapHit', 'minimapRect']) if (k in rec && rec[k] !== undefined) return true;
  return false;
}
