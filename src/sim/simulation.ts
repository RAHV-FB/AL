/**
 * Simulation orchestrator (lead-owned). Pure logic — no DOM access.
 *
 * Tick order (deterministic):
 *   1. scheduled scenario events, replayed interventions, queued user interventions
 *   2. environment clock (day/night, seasons, temperature)       → ecology.updateEnvironment
 *   3. disasters (progress, effects, random spawning)            → disasters.updateDisasters
 *   4. plant regrowth / fertility                                → ecology.updateResources
 *   5. spatial index rebuild
 *   6. per agent (array order): think (when cooldown expires) → act → updateVitals
 *   7. disease transmission/progression                          → disease.updateDisease
 *   8. social systems (tribes, relations, territory, roles)      → social.updateSocial
 *   9. flush deaths (compaction) and births (append)
 *  10. statistics sampling                                       → stats.updateStats
 *  11. tick++
 */
import { Rng } from './rng';
import { SpatialHash } from './spatial';
import { DEFAULT_CONFIG } from './config';
import { LIMITS, SAVE_VERSION, TERRAIN_INFO } from './constants';
import { agentName, tribeName } from './names';
import {
  NONE,
  type Agent,
  type AgentId,
  type DeathCause,
  type EventCategory,
  type Intervention,
  type InterventionRecord,
  type LineageRecord,
  type Role,
  type ScenarioDef,
  type SimConfig,
  type SimEvent,
  type SimState,
  type TerrainType,
  type Tribe,
  type TribeId,
} from './types';
import { generateWorld } from './world';
import { initEnvironment, updateEnvironment, updateResources } from './ecology';
import { updateDisasters } from './disasters';
import { updateDisease } from './disease';
import { think, act } from './brain';
import { updateVitals } from './lifecycle';
import { updateSocial } from './social';
import { createStatsState, updateStats } from './stats';
import { applyIntervention } from './interventions';

export interface CreateOptions {
  scenario: ScenarioDef;
  /** Overrides the scenario/default seed. */
  seed?: number;
  /** Extra config overrides applied after the scenario's. */
  config?: Partial<SimConfig>;
  /** Interventions to replay at their recorded ticks (for "restart & replay"). */
  replay?: InterventionRecord[];
}

const EMPTY_ROLES = (): Record<Role, number> => ({ none: 0, forager: 0, warrior: 0, caretaker: 0, explorer: 0 });

export class Simulation {
  state: SimState;
  rng: Rng;
  spatial: SpatialHash;
  /** Indexes over state (rebuilt on load; maintained incrementally). */
  readonly agentById = new Map<AgentId, Agent>();
  readonly tribeById = new Map<TribeId, Tribe>();
  readonly lineageById = new Map<AgentId, LineageRecord>();
  /** Reusable scratch array for spatial queries inside a single function (do not hold across calls). */
  readonly scratch: Agent[] = [];

  private queue: Intervention[] = [];
  private replayQueue: InterventionRecord[] = [];
  private pendingBirths: Agent[] = [];
  private stepping = false;
  private deadThisTick = 0;

  /** World size in world units. */
  readonly worldW: number;
  readonly worldH: number;

  private constructor(state: SimState, rng: Rng) {
    this.state = state;
    this.rng = rng;
    this.worldW = state.world.width * state.world.tileSize;
    this.worldH = state.world.height * state.world.tileSize;
    this.spatial = new SpatialHash(this.worldW, this.worldH, 32);
    this.reindex();
  }

  // ------------------------------------------------------------ construction

  static create(opts: CreateOptions): Simulation {
    const scenario = opts.scenario;
    const config: SimConfig = { ...DEFAULT_CONFIG, ...scenario.config, ...(opts.config ?? {}) };
    if (opts.seed !== undefined) config.seed = opts.seed >>> 0;
    const rng = new Rng(config.seed);
    const worldRng = new Rng(config.seed, 1);
    const world = generateWorld(config, worldRng, scenario.world ?? {});
    const state: SimState = {
      version: SAVE_VERSION,
      scenarioId: scenario.id,
      config,
      tick: 0,
      rngState: rng.getState(),
      nextAgentId: 1,
      nextTribeId: 1,
      nextEventId: 1,
      nextDisasterId: 1,
      world,
      env: initEnvironment(config),
      agents: [],
      tribes: [],
      lineage: [],
      events: [],
      disasters: [],
      scheduled: (scenario.scheduled ?? []).map((e) => ({ ...e, intervention: structuredCloneSafe(e.intervention) })),
      interventionLog: [],
      stats: createStatsState(),
    };
    const sim = new Simulation(state, rng);
    for (const pop of scenario.populations ?? []) {
      applyIntervention(sim, { kind: 'spawn', ...pop });
    }
    sim.flush();
    if (opts.replay) sim.replayQueue = opts.replay.map((r) => ({ tick: r.tick, intervention: structuredCloneSafe(r.intervention) }));
    sim.log('environment', 'info', `Experiment "${scenario.name}" started (seed ${config.seed}).`);
    return sim;
  }

  /** Rebuild a simulation from a validated SimState (see persistence.ts). */
  static fromState(state: SimState): Simulation {
    const rng = new Rng(state.config.seed);
    rng.setState(state.rngState);
    return new Simulation(state, rng);
  }

  get config(): SimConfig {
    return this.state.config;
  }

  get tick(): number {
    return this.state.tick;
  }

  /** Rebuild maps from state arrays. */
  reindex(): void {
    this.agentById.clear();
    for (const a of this.state.agents) this.agentById.set(a.id, a);
    this.tribeById.clear();
    for (const t of this.state.tribes) this.tribeById.set(t.id, t);
    this.lineageById.clear();
    for (const l of this.state.lineage) this.lineageById.set(l.id, l);
    this.spatial.rebuild(this.state.agents);
  }

  // ------------------------------------------------------------ main loop

  /** Queue a user intervention; applied (and recorded) at the start of the next tick. */
  enqueue(iv: Intervention): void {
    this.queue.push(iv);
  }

  /** Advance one tick. */
  step(): void {
    const s = this.state;
    this.stepping = true;
    this.deadThisTick = 0;

    // 1. scheduled + replayed + user interventions
    if (s.scheduled.length) this.processScheduled();
    if (this.replayQueue.length) {
      while (this.replayQueue.length && this.replayQueue[0].tick <= s.tick) {
        const r = this.replayQueue.shift()!;
        this.applyRecorded(r.intervention);
      }
    }
    if (this.queue.length) {
      const q = this.queue;
      this.queue = [];
      for (const iv of q) this.applyRecorded(iv);
    }

    // 2-4. environment
    updateEnvironment(this);
    updateDisasters(this);
    updateResources(this);

    // 5. spatial index
    this.spatial.rebuild(s.agents);

    // 6. agents
    const agents = s.agents;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.alive) continue;
      if (a.decisionCooldown <= 0) think(this, a);
      else a.decisionCooldown--;
      if (!a.alive) continue;
      act(this, a);
      if (!a.alive) continue;
      updateVitals(this, a);
    }

    // 7-8. disease & social
    updateDisease(this);
    updateSocial(this);

    // 9. births / deaths
    this.flush();

    // 10. stats
    updateStats(this);

    s.tick++;
    s.rngState = this.rng.getState();
    this.stepping = false;
  }

  /** Run n ticks (headless). */
  run(n: number): void {
    for (let i = 0; i < n; i++) this.step();
  }

  private processScheduled(): void {
    const s = this.state;
    for (const ev of s.scheduled) {
      if (ev.tick === s.tick) {
        applyIntervention(this, structuredCloneSafe(ev.intervention));
        if (ev.note) this.log('environment', 'major', ev.note);
        if (ev.repeat && ev.repeat > 0) ev.tick += ev.repeat;
      }
    }
    s.scheduled = s.scheduled.filter((e) => e.tick >= s.tick);
  }

  private applyRecorded(iv: Intervention): void {
    const s = this.state;
    s.interventionLog.push({ tick: s.tick, intervention: structuredCloneSafe(iv) });
    if (s.interventionLog.length > LIMITS.interventionLog) s.interventionLog.shift();
    applyIntervention(this, iv);
  }

  /** Remove dead agents and append newborns. Safe to call outside step(). */
  flush(): void {
    const s = this.state;
    const agents = s.agents;
    let w = 0;
    for (let r = 0; r < agents.length; r++) {
      const a = agents[r];
      if (a.alive) agents[w++] = a;
      else this.agentById.delete(a.id);
    }
    agents.length = w;
    if (this.pendingBirths.length) {
      for (const b of this.pendingBirths) {
        if (!b.alive) continue;
        agents.push(b);
        this.agentById.set(b.id, b);
      }
      this.pendingBirths.length = 0;
    }
    if (s.lineage.length > LIMITS.lineage) this.pruneLineage();
  }

  // ------------------------------------------------------------ agents

  /** Allocate a fresh agent id. */
  newAgentId(): AgentId {
    return this.state.nextAgentId++;
  }

  newName(): string {
    return agentName(this.rng);
  }

  /** Living agents + agents born this tick (not yet flushed). */
  get population(): number {
    return this.state.agents.length + this.pendingBirths.length - this.deadThisTick;
  }

  /** True if another agent may be added without exceeding config.maxAgents. */
  canSpawn(): boolean {
    return this.population < this.config.maxAgents;
  }

  /**
   * Register a newly created agent (from lifecycle.createAgent). During a tick it
   * joins the world at the end of the tick; outside a tick it is added immediately.
   * Also creates its lineage record and bumps birth counters when it has parents.
   */
  addAgent(agent: Agent): void {
    const rec: LineageRecord = {
      id: agent.id,
      name: agent.name,
      parents: [agent.parents[0], agent.parents[1]],
      generation: agent.generation,
      birthTick: agent.birthTick,
      deathTick: -1,
      deathCause: null,
      hue: agent.traits.hue,
      tribeId: agent.tribeId,
      offspring: 0,
    };
    this.state.lineage.push(rec);
    this.lineageById.set(rec.id, rec);
    if (agent.parents[0] !== NONE) {
      this.state.stats.counters.births++;
      this.state.stats.totals.births++;
      for (const pid of agent.parents) {
        const pr = this.lineageById.get(pid);
        if (pr) pr.offspring++;
      }
    }
    if (this.stepping) this.pendingBirths.push(agent);
    else {
      this.state.agents.push(agent);
      this.agentById.set(agent.id, agent);
    }
  }

  /** Kill an agent (idempotent). It is removed from the world at the end of the tick. */
  killAgent(agent: Agent, cause: DeathCause): void {
    if (!agent.alive) return;
    agent.alive = false;
    agent.deathTick = this.state.tick;
    agent.deathCause = cause;
    agent.health = 0;
    this.deadThisTick++;
    const c = this.state.stats.counters;
    c.deaths++;
    c.deathsByCause[cause] = (c.deathsByCause[cause] ?? 0) + 1;
    this.state.stats.totals.deaths++;
    const rec = this.lineageById.get(agent.id);
    if (rec) {
      rec.deathTick = this.state.tick;
      rec.deathCause = cause;
      rec.tribeId = agent.tribeId;
    }
    if (!this.stepping) this.flush();
  }

  /** Lookup a living agent (undefined if dead/unknown — always handle that). */
  getAgent(id: AgentId): Agent | undefined {
    if (id === NONE) return undefined;
    const a = this.agentById.get(id);
    return a && a.alive ? a : undefined;
  }

  private pruneLineage(): void {
    const s = this.state;
    const excess = s.lineage.length - Math.floor(LIMITS.lineage * 0.9);
    let removed = 0;
    const keep: LineageRecord[] = [];
    for (const rec of s.lineage) {
      if (removed < excess && rec.deathTick !== -1) {
        this.lineageById.delete(rec.id);
        removed++;
      } else keep.push(rec);
    }
    s.lineage = keep;
  }

  // ------------------------------------------------------------ tribes

  /** Create & register a tribe. */
  createTribe(founder: Agent | null, x: number, y: number, name?: string, hue?: number, parentTribeId: TribeId = NONE): Tribe {
    const s = this.state;
    const t: Tribe = {
      id: s.nextTribeId++,
      name: name ?? tribeName(this.rng),
      hue: hue ?? Math.floor(this.rng.next() * 360),
      foundedTick: s.tick,
      founderId: founder ? founder.id : NONE,
      homeX: x,
      homeY: y,
      stockpile: 0,
      members: 0,
      peakMembers: 0,
      totalJoined: 0,
      extinctTick: -1,
      relations: {},
      territory: 0,
      roles: EMPTY_ROLES(),
      meanGenes: [],
      parentTribeId,
    };
    s.tribes.push(t);
    this.tribeById.set(t.id, t);
    // cap stored tribes: drop oldest extinct ones
    if (s.tribes.length > LIMITS.tribesKept) {
      const idx = s.tribes.findIndex((tr) => tr.extinctTick !== -1);
      if (idx >= 0) {
        this.tribeById.delete(s.tribes[idx].id);
        s.tribes.splice(idx, 1);
      }
    }
    return t;
  }

  getTribe(id: TribeId): Tribe | undefined {
    if (id === NONE) return undefined;
    return this.tribeById.get(id);
  }

  // ------------------------------------------------------------ events

  log(
    category: EventCategory,
    severity: SimEvent['severity'],
    message: string,
    extra?: { x?: number; y?: number; agentId?: AgentId; tribeId?: TribeId },
  ): void {
    const s = this.state;
    s.events.push({ id: s.nextEventId++, tick: s.tick, category, severity, message, ...(extra ?? {}) });
    if (s.events.length > LIMITS.events) s.events.splice(0, s.events.length - LIMITS.events);
  }

  // ------------------------------------------------------------ tile helpers

  /** Tile index for world coords, or -1 when outside the map. */
  tileIndex(x: number, y: number): number {
    const w = this.state.world;
    const tx = Math.floor(x / w.tileSize);
    const ty = Math.floor(y / w.tileSize);
    if (tx < 0 || ty < 0 || tx >= w.width || ty >= w.height) return -1;
    return ty * w.width + tx;
  }

  terrainAt(x: number, y: number): TerrainType | -1 {
    const i = this.tileIndex(x, y);
    return i < 0 ? -1 : (this.state.world.terrain[i] as TerrainType);
  }

  passableAt(x: number, y: number): boolean {
    const i = this.tileIndex(x, y);
    return i >= 0 && TERRAIN_INFO[this.state.world.terrain[i] as TerrainType].passable;
  }

  /** Movement multiplier at a position (0 if impassable). */
  moveCostAt(x: number, y: number): number {
    const i = this.tileIndex(x, y);
    return i < 0 ? 0 : TERRAIN_INFO[this.state.world.terrain[i] as TerrainType].moveCost;
  }

  /** Clamp a coordinate pair inside the world bounds. */
  clampX(x: number): number {
    return x < 0.5 ? 0.5 : x > this.worldW - 0.5 ? this.worldW - 0.5 : x;
  }

  clampY(y: number): number {
    return y < 0.5 ? 0.5 : y > this.worldH - 0.5 ? this.worldH - 0.5 : y;
  }

  // ------------------------------------------------------------ diagnostics

  /** Deterministic fingerprint of the full simulation state (for tests). */
  hash(): string {
    let h1 = 0x811c9dc5 | 0;
    let h2 = 0x01000193 | 0;
    const mix = (v: number) => {
      // quantise floats to 1e-6 to get a stable integer stream
      const q = Number.isFinite(v) ? Math.round(v * 1e6) | 0 : 0x7fffffff;
      h1 = Math.imul(h1 ^ q, 0x01000193);
      h2 = Math.imul(h2 ^ (q >>> 7) ^ h1, 0x5bd1e995);
    };
    const s = this.state;
    mix(s.tick);
    for (const v of s.rngState) mix(v);
    mix(s.agents.length);
    for (const a of s.agents) {
      mix(a.id); mix(a.x); mix(a.y); mix(a.health); mix(a.food); mix(a.energy); mix(a.carried); mix(a.tribeId); mix(a.age);
      for (const g of a.genes) mix(g);
    }
    for (const t of s.tribes) { mix(t.id); mix(t.stockpile); mix(t.members); mix(t.homeX); mix(t.homeY); }
    const f = s.world.food;
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * ((i % 97) + 1);
    mix(sum);
    let fert = 0;
    for (let i = 0; i < s.world.fertility.length; i++) fert += s.world.fertility[i];
    mix(fert);
    let terr = 0;
    for (let i = 0; i < s.world.terrain.length; i++) terr = (terr * 31 + s.world.terrain[i]) | 0;
    mix(terr);
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }
}

/** Deep-clone plain JSON data (interventions). */
export function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
