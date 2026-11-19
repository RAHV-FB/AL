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
  ACTIONS,
  DEATH_CAUSES,
  DISASTER_KINDS,
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
import { applyIntervention, normalizeIntervention } from './interventions';

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
const ROLE_ORDER: Role[] = ['none', 'forager', 'warrior', 'caretaker', 'explorer'];

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

  private pendingBirths: Agent[] = [];
  private stepping = false;
  /** True while step() applies interventions (phase 1, before any agent is processed). */
  private intervening = false;
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
      // whole, non-negative ticks: processScheduled() fires an event when its tick equals the clock
      scheduled: (scenario.scheduled ?? [])
        .filter((e) => e && Number.isFinite(e.tick))
        .map((e) => ({ ...e, tick: Math.max(0, Math.round(e.tick)), intervention: structuredCloneSafe(e.intervention) })),
      interventionLog: [],
      stats: createStatsState(),
    };
    const sim = new Simulation(state, rng);
    for (const pop of scenario.populations ?? []) {
      applyIntervention(sim, { kind: 'spawn', ...pop });
    }
    sim.flush();
    if (opts.replay) {
      // step() applies the queue head-first, so it must be in tick order (stable: same-tick entries keep
      // their recorded order); entries without a usable tick would block the queue forever.
      const replay = opts.replay
        .filter((r) => r && typeof r.tick === 'number' && Number.isFinite(r.tick))
        .map((r) => ({ tick: r.tick, intervention: structuredCloneSafe(r.intervention) }))
        .sort((p, q) => p.tick - q.tick);
      if (replay.length) state.pendingReplay = replay;
    }
    sim.log('environment', 'info', `Experiment "${scenario.name}" started (seed ${config.seed}).`);
    state.rngState = rng.getState(); // spawning the founders used the generator
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
    (this.state.pendingQueue ??= []).push(iv);
  }

  /** Number of "restart & replay" entries still waiting to be applied. */
  get pendingReplayCount(): number {
    return this.state.pendingReplay?.length ?? 0;
  }

  /** Advance one tick. */
  step(): void {
    const s = this.state;
    this.stepping = true;
    this.deadThisTick = 0;

    // 1. scheduled + replayed + user interventions. Nothing iterates the agent array yet, so agents they
    //    spawn join the world at once: later interventions of this tick (remove, paint, …), the agent
    //    loop and the tribe recount all see them. Deaths are still flushed at the end of the tick.
    this.intervening = true;
    if (s.scheduled.length) this.processScheduled();
    const rq = s.pendingReplay;
    if (rq) {
      while (rq.length && rq[0].tick <= s.tick) {
        const r = rq.shift()!;
        this.applyRecorded(r.intervention);
      }
      if (!rq.length) delete s.pendingReplay;
    }
    const q = s.pendingQueue;
    if (q) {
      delete s.pendingQueue;
      for (const iv of q) this.applyRecorded(iv);
    }
    this.intervening = false;

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

    // 9. births / deaths (re-index so the next tick starts from the same index a loaded save would build)
    this.flush();
    this.spatial.rebuild(s.agents);

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

  /**
   * Record and apply a user / replayed intervention. The canonical form (finite numbers, handler
   * defaults filled in, JSON-safe) is both what gets recorded and what gets applied, so a replay —
   * also of a log that went through a save file — re-applies exactly what the original run applied.
   * Interventions that cannot have any effect (unknown kind, no target point, …) are not recorded.
   */
  private applyRecorded(iv: Intervention): void {
    const s = this.state;
    const n = normalizeIntervention(iv, this);
    if (!n) return;
    s.interventionLog.push({ tick: s.tick, intervention: n });
    if (s.interventionLog.length > LIMITS.interventionLog) {
      s.interventionLog.shift();
      s.interventionLogDropped = (s.interventionLogDropped ?? 0) + 1;
      if (s.interventionLogDropped === 1) {
        this.log('intervention', 'bad', `The intervention log is full (${LIMITS.interventionLog} entries): the oldest are being dropped, so a replay can no longer reproduce this run exactly.`);
      }
    }
    applyIntervention(this, n);
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
    // every agent killed so far has just left the array, so `population` must stop subtracting them
    // (otherwise it under-counts until the next step() and canSpawn() lets spawns exceed maxAgents)
    this.deadThisTick = 0;
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
   * Register a newly created agent (from lifecycle.createAgent). Born during a tick's agent / social
   * phases it joins the world at the end of the tick; outside a tick, or spawned by an intervention at
   * the start of one, it is added immediately.
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
    if (this.stepping && !this.intervening) this.pendingBirths.push(agent);
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

  /**
   * Deterministic fingerprint of the simulation state (for tests). Covers everything that feeds
   * back into the trajectory or that a replay / save → load must reproduce: counters and RNG,
   * config, clock, every agent field that persists between ticks (vitals, kinematics, behaviour
   * timers, targets, disease, relationships, memories, children), tribes incl. diplomacy, the
   * lineage registry, disasters, schedules, the event log, statistics and every world layer.
   * Only derived / presentational agent fields (traits, utilities, thought, history) are skipped.
   * `{ events: false }` leaves out the event log (and nextEventId) to compare trajectories alone.
   */
  hash(opts: { events?: boolean } = {}): string {
    const withEvents = opts.events !== false;
    let h1 = 0x811c9dc5 | 0;
    let h2 = 0x01000193 | 0;
    const mix = (v: number) => {
      // quantise floats to 1e-6 to get a stable integer stream
      const q = Number.isFinite(v) ? Math.round(v * 1e6) | 0 : 0x7fffffff;
      h1 = Math.imul(h1 ^ q, 0x01000193);
      h2 = Math.imul(h2 ^ (q >>> 7) ^ h1, 0x5bd1e995);
    };
    const mixStr = (str: string) => {
      mix(str.length);
      for (let i = 0; i < str.length; i++) mix(str.charCodeAt(i));
    };
    const opt = (v: number | undefined) => (v === undefined ? -7 : v);
    const s = this.state;
    mix(s.tick);
    // the live generator: state.rngState is only a snapshot refreshed by step() (and saved by serializeSim)
    for (const v of this.rng.getState()) mix(v);
    mix(s.nextAgentId);
    mix(s.nextTribeId);
    if (withEvents) mix(s.nextEventId);
    mix(s.nextDisasterId);
    mixStr(s.scenarioId);
    const cfg = s.config as unknown as Record<string, number | boolean>;
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      const v = cfg[k];
      mix(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    const e = s.env;
    mix(e.timeOfDay); mix(e.daylight); mix(e.day); mix(e.season); mix(e.seasonProgress); mix(e.year); mix(e.temperature); mix(e.tempOffset); mix(e.seasonGrowth);

    mix(s.agents.length);
    for (const a of s.agents) {
      mix(a.id); mix(a.x); mix(a.y); mix(a.health); mix(a.food); mix(a.energy); mix(a.carried); mix(a.tribeId); mix(a.age);
      for (const g of a.genes) mix(g);
      mix(a.alive ? 1 : 0); mix(a.generation); mix(a.parents[0]); mix(a.parents[1]); mix(a.birthTick);
      mix(a.vx); mix(a.vy); mix(a.heading);
      mix(ACTIONS.indexOf(a.action)); mix(a.actionTicks); mix(a.targetX); mix(a.targetY); mix(a.targetId); mix(a.decisionCooldown);
      mix(a.reproCooldown); mix(a.offspring); mix(ROLE_ORDER.indexOf(a.role));
      mix(a.skills.forage); mix(a.skills.combat); mix(a.skills.social);
      mix(a.infection); mix(a.virulence); mix(a.immuneTicks); mix(a.lastAttackerId);
      mix(opt(a.fear)); mix(opt(a.sinceMeal)); mix(opt(a.diseaseHp));
      const rt = a.route;
      mix(rt ? 1 : 0);
      if (rt) {
        mix(rt.gx); mix(rt.gy); mix(rt.i); mix(rt.t); mix(rt.v); mix(rt.fail ? 1 : 0); mix(rt.pts.length);
        for (const p of rt.pts) mix(p);
      }
      const tk = a.trek;
      mix(tk ? 1 : 0);
      if (tk) { mix(tk.x); mix(tk.y); mix(tk.until); }
      const st = a.stats;
      mix(st.foodEaten); mix(st.distance); mix(st.kills); mix(st.shared); mix(st.received); mix(st.fights);
      mix(a.children.length);
      for (const c of a.children) mix(c);
      mix(a.relationships.length);
      for (const r of a.relationships) { mix(r.id); mix(r.affinity); mix(r.kin); mix(r.lastTick); mix(r.interactions); }
      mix(a.memory.food.length);
      for (const m of a.memory.food) { mix(m.x); mix(m.y); mix(m.value); mix(m.tick); }
      mix(a.memory.danger.length);
      for (const m of a.memory.danger) { mix(m.x); mix(m.y); mix(m.value); mix(m.tick); }
    }
    mix(s.tribes.length);
    for (const t of s.tribes) {
      mix(t.id); mix(t.stockpile); mix(t.members); mix(t.homeX); mix(t.homeY);
      mix(t.extinctTick); mix(t.foundedTick); mix(t.founderId); mix(t.peakMembers); mix(t.totalJoined); mix(t.territory); mix(t.hue); mix(t.parentTribeId);
      for (const k of Object.keys(t.relations)) { mix(Number(k)); mix(t.relations[Number(k)]); }
      for (const r of ROLE_ORDER) mix(t.roles[r] ?? 0);
      for (const g of t.meanGenes) mix(g);
      mixStr(t.name);
    }
    mix(s.lineage.length);
    for (const l of s.lineage) { mix(l.id); mix(l.deathTick); mix(DEATH_CAUSES.indexOf(l.deathCause as DeathCause)); mix(l.offspring); mix(l.tribeId); }
    mix(s.disasters.length);
    for (const d of s.disasters) {
      mix(d.id); mix(DISASTER_KINDS.indexOf(d.kind)); mix(d.x); mix(d.y); mix(d.radius); mix(d.startTick); mix(d.duration); mix(d.intensity); mix(d.active ? 1 : 0);
    }
    mix(s.scheduled.length);
    for (const ev of s.scheduled) { mix(ev.tick); mix(opt(ev.repeat)); mixStr(ev.intervention.kind); }
    mix(s.interventionLog.length);
    mix(opt(s.interventionLogDropped));
    for (const r of s.interventionLog) { mix(r.tick); mixStr(r.intervention.kind); }
    if (withEvents) {
      mix(s.events.length);
      for (const ev of s.events) { mix(ev.id); mix(ev.tick); mixStr(ev.message); }
    }
    const stats = s.stats;
    mix(stats.samples.length);
    mix(stats.totals.births); mix(stats.totals.deaths); mix(stats.totals.peakPopulation); mix(stats.totals.peakTick);
    mix(stats.counters.births); mix(stats.counters.deaths); mix(stats.counters.fights); mix(stats.counters.shares);
    for (const c of DEATH_CAUSES) mix(stats.counters.deathsByCause[c] ?? 0);
    const last = stats.samples[stats.samples.length - 1];
    if (last) { mix(last.tick); mix(last.population); mix(last.births); mix(last.deaths); }

    const w = s.world;
    mix(w.terrainVersion);
    const f = w.food;
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * ((i % 97) + 1);
    mix(sum);
    let fert = 0;
    let base = 0;
    let climate = 0;
    for (let i = 0; i < w.fertility.length; i++) {
      const k = (i % 89) + 1;
      fert += w.fertility[i];
      base += w.baseFertility[i] * k;
      climate += w.climateMod[i] * k;
    }
    mix(fert);
    mix(base);
    mix(climate);
    let terr = 0;
    let owner = 0;
    for (let i = 0; i < w.terrain.length; i++) {
      terr = (terr * 31 + w.terrain[i]) | 0;
      owner = (owner * 31 + w.territory[i]) | 0;
    }
    mix(terr);
    mix(owner);
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }
}

/** Deep-clone plain JSON data (interventions). */
export function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
