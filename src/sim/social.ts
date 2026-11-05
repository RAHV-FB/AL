// OWNER: Social Systems agent.
/**
 * Social systems: relationships, attitudes, combat, food sharing, tribe stockpiles and the
 * periodic group dynamics (tribe formation / joining / leaving / fission / extinction, camp
 * drift, inter-tribe diplomacy, territory map, emergent roles).
 *
 * The brain decides WHEN to attack / share / deposit / withdraw / socialise; this module
 * implements the mechanics. `updateSocial` runs once per tick (after all agents acted) and
 * staggers its heavy work:
 *   - every tick ........ O(n) scan: forget agents that died this tick, population skill means
 *   - per agent / 60 t .. ((tick + id) % 60 === 0) relationship decay + pruning, skill decay,
 *                         role assignment, familiarity bonding, join / found / leave decisions
 *   - every 30 ticks .... tribe recount (members, roles, mean genes), extinction, stockpile
 *                         spoilage, camp drift, diplomacy drift + events, fission
 *   - every 120 ticks ... territory map (influence discs) + border friction between tribes
 *
 * Determinism: randomness only via sim.rng, iteration in array order. The per-simulation cache
 * below only holds scratch buffers and log de-duplication sets — never anything that feeds back
 * into simulation state, so save/load replays identically.
 */
import type { Simulation } from './simulation';
import { LIMITS, TERRAIN_INFO } from './constants';
import { addHistory, growthFactor, isAdult } from './lifecycle';
import {
  G,
  GENE_COUNT,
  NONE,
  TERRAIN_COUNT,
  type Agent,
  type AgentId,
  type Relationship,
  type Role,
  type TerrainType,
  type Tribe,
  type TribeId,
} from './types';

// ------------------------------------------------------------------ tuning

/** Tunable constants (exported read-only so brain / UI / tests can align with them). */
export const SOCIAL_TUNING = {
  // scheduling (ticks)
  agentPeriod: 60,
  tribePeriod: 30,
  territoryPeriod: 120,
  // attitudes
  /** Personal affinity below which a treats b as an enemy (grudge). */
  grudge: -0.3,
  /** Personal affinity above which a treats b as a friend. */
  friend: 0.3,
  /** Tribe relation below which members of two tribes are hostile. */
  warHostile: -0.35,
  /** Tribe relation above which members of two tribes are friendly. */
  allyFriendly: 0.5,
  /** Diplomacy event thresholds (with hysteresis). */
  warDeclare: -0.5,
  peace: -0.1,
  alliance: 0.6,
  allianceEnd: 0.3,
  // combat
  /** Damage per exchange = baseDamage × combat power × random(0.6..1.4) × bias. */
  baseDamage: 12,
  /** Defender's counter-blow as a fraction of a full hit. */
  retaliation: 0.55,
  /** Each nearby defending tribe-mate / kin adds this fraction of a full hit. */
  helperHit: 0.35,
  maxHelpers: 3,
  groupDefenseRadius: 25,
  /** Affinity change of the defender (and its kin) toward the attacker per incident. */
  attackGrudge: -0.4,
  helperGrudge: -0.25,
  /** Exchanges between the same pair closer than this (ticks) count as one incident. */
  incidentGap: 60,
  tribeIncident: -0.05,
  tribeKill: -0.1,
  // sharing
  giftAffinityReceiver: 0.15,
  giftAffinityGiver: 0.05,
  /** Max tribe-relation gain of a cross-tribe gift (scaled by size up to 20 food). */
  giftRelation: 0.03,
  // relationships (per agent update, i.e. every agentPeriod ticks)
  nonKinDecay: 0.97,
  kinDecay: 0.99,
  /** Weak non-kin ties untouched for this long are forgotten. */
  forgetAfter: 1200,
  skillDecay: 0.992,
  neighbourRadius: 40,
  bondRadius: 30,
  bondDelta: 0.008,
  bondMax: 3,
  // tribes
  foundSociability: 0.45,
  foundProb: 0.15,
  joinProb: 0.4,
  maxFounding: 14,
  maxLivingTribes: 40,
  leaveSociability: 0.35,
  /** Deposit / withdraw range around the camp (world units). */
  campRadius: 24,
  /** Stockpile spoilage per tick (fraction). */
  stockSpoil: 0.0003,
  stockPerMember: 40,
  stockBase: 200,
  /** Only members within this distance pull the camp. */
  campPull: 300,
  campStep: 6,
  extinctGrace: 10,
  fissionSize: 45,
  fissionFar: 240,
  fissionMinAge: 900,
  fissionMinMembers: 12,
  /** Inter-tribe relations decay toward 0 by this factor every tribePeriod. */
  relDrift: 0.985,
  // territory
  territoryRadius: 6, // tiles
  territoryMin: 0.35,
  campInfluence: 2,
  /** Relation loss per contested tile per territory pass (× scarcity, aggression). */
  borderFriction: 0.0015,
  // roles
  roleMin: 0.12,
} as const;

const K = SOCIAL_TUNING;
/** Max distance from a tribe's camp for depositFood / withdrawFood (world units). */
export const CAMP_RADIUS = K.campRadius;

const ROLES: Role[] = ['none', 'forager', 'warrior', 'caretaker', 'explorer'];
const PASSABLE = new Uint8Array(TERRAIN_COUNT);
for (let i = 0; i < TERRAIN_COUNT; i++) PASSABLE[i] = TERRAIN_INFO[i as TerrainType].passable ? 1 : 0;

// ------------------------------------------------------------------ per-simulation cache

interface Group {
  list: Agent[];
  genes: Float64Array;
  foodFrac: number;
  scarcity: number;
}

interface SocialCache {
  /** Pairs of tribes currently at war / allied (log hysteresis only). */
  wars: Set<number>;
  alliances: Set<number>;
  /** Tribe pairs that already had a "first blood" kill logged. */
  feuds: Set<number>;
  /** Members per living tribe — rebuilt by every tribe pass and only used within it. */
  groups: Map<TribeId, Group>;
  meanForage: number;
  meanCombat: number;
  meanSocial: number;
  meanMove: number;
  // territory scratch
  tiles: number;
  acc: Float32Array;
  best: Float32Array;
  second: Float32Array;
  bestT: Int32Array;
  secondT: Int32Array;
  mark: Int32Array;
  touched: Int32Array;
  markId: number;
  falloff: Float32Array;
}

const caches = new WeakMap<Simulation, SocialCache>();

function cacheOf(sim: Simulation): SocialCache {
  let c = caches.get(sim);
  if (c) return c;
  const R = K.territoryRadius;
  const D = 2 * R + 1;
  const falloff = new Float32Array(D * D);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      falloff[(dy + R) * D + dx + R] = d <= R ? 1 - d / (R + 1) : 0;
    }
  }
  c = {
    wars: new Set(),
    alliances: new Set(),
    feuds: new Set(),
    groups: new Map(),
    meanForage: 0,
    meanCombat: 0,
    meanSocial: 0,
    meanMove: 0,
    tiles: 0,
    acc: new Float32Array(0),
    best: new Float32Array(0),
    second: new Float32Array(0),
    bestT: new Int32Array(0),
    secondT: new Int32Array(0),
    mark: new Int32Array(0),
    touched: new Int32Array(0),
    markId: 0,
    falloff,
  };
  caches.set(sim, c);
  // Rebuild diplomacy state from the (possibly loaded) relations so events are not re-logged.
  const tribes = sim.state.tribes;
  for (const t of tribes) {
    if (t.extinctTick !== -1) continue;
    for (const o of tribes) {
      if (o.id <= t.id || o.extinctTick !== -1) continue;
      const m = meanRelation(t, o);
      if (m < K.warDeclare) c.wars.add(pairKey(t.id, o.id));
      if (m > K.alliance) c.alliances.add(pairKey(t.id, o.id));
    }
  }
  return c;
}

// Module-level scratch arrays (never held across calls; attack() and updateSocial() use separate ones).
const helperScratch: Agent[] = [];
const nbrScratch: Agent[] = [];
const eligibleScratch: Agent[] = [];
const tribeScoreIds: number[] = [];
const tribeScores: number[] = [];

// ------------------------------------------------------------------ small helpers

function clampAff(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v === v ? v : 0;
}

function clamp01(v: number): number {
  return v > 1 ? 1 : v > 0 ? v : 0;
}

function pairKey(a: number, b: number): number {
  return a < b ? a * 1048576 + b : b * 1048576 + a;
}

function meanRelation(a: Tribe, b: Tribe): number {
  return ((a.relations[b.id] ?? 0) + (b.relations[a.id] ?? 0)) / 2;
}

function liveTribe(sim: Simulation, id: TribeId): Tribe | undefined {
  if (id === NONE) return undefined;
  const t = sim.getTribe(id);
  return t && t.extinctTick === -1 ? t : undefined;
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function learn(a: Agent, kind: 'forage' | 'combat' | 'social', rate: number): void {
  const v = clamp01(a.skills[kind]);
  a.skills[kind] = v + rate * (1 - v);
}

function coopMul(sim: Simulation): number {
  const c = sim.state.config.cooperationBias;
  return Number.isFinite(c) ? Math.max(0, Math.min(3, c)) : 1;
}

function aggMul(sim: Simulation): number {
  const c = sim.state.config.aggressionBias;
  return Number.isFinite(c) ? Math.max(0, Math.min(3, c)) : 1;
}

function removeRelationship(a: Agent, id: AgentId): void {
  const rs = a.relationships;
  for (let i = 0; i < rs.length; i++) {
    if (rs[i].id === id) {
      rs.splice(i, 1);
      return;
    }
  }
}

/** Index of the relationship to evict: dead partners first, then weakest non-kin |affinity| (oldest on ties). */
function weakestIndex(sim: Simulation, rs: Relationship[], allowKin: boolean): number {
  let idx = -1;
  let best = Infinity;
  for (let pass = 0; pass < 2 && idx < 0; pass++) {
    if (pass === 1 && !allowKin) break;
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      if (!sim.getAgent(r.id)) return i;
      if (pass === 0 ? r.kin !== 0 : r.kin === 0) continue;
      const score = Math.abs(r.affinity) + r.lastTick * 1e-9;
      if (score < best) {
        best = score;
        idx = i;
      }
    }
  }
  return idx;
}

// ------------------------------------------------------------------ relationships

export function getRelationship(a: Agent, otherId: AgentId): Relationship | undefined {
  const rs = a.relationships;
  for (let i = 0; i < rs.length; i++) if (rs[i].id === otherId) return rs[i];
  return undefined;
}

/** Change a's feelings toward b by delta (creates the entry; evicts weakest when full). */
export function adjustRelationship(sim: Simulation, a: Agent, b: Agent, delta: number, kin: 0 | 1 | 2 = 0): void {
  if (a === b || a.id === b.id) return;
  const d = Number.isFinite(delta) ? delta : 0;
  const tick = sim.state.tick;
  let r = getRelationship(a, b.id);
  if (!r) {
    const rs = a.relationships;
    while (rs.length >= LIMITS.relationships) {
      const idx = weakestIndex(sim, rs, kin > 0);
      if (idx < 0) return; // full of kin and the newcomer is not kin: keep family
      rs.splice(idx, 1);
    }
    r = { id: b.id, affinity: 0, kin, lastTick: tick, interactions: 0 };
    rs.push(r);
  } else if (kin > 0 && (r.kin === 0 || kin < r.kin)) {
    r.kin = kin; // the kin flag is only ever strengthened, never cleared
  }
  r.affinity = clampAff(r.affinity + d);
  r.lastTick = tick;
  r.interactions++;
}

/** True when a would treat b as an enemy (tribal war, grudges, low affinity). */
export function isHostile(sim: Simulation, a: Agent, b: Agent): boolean {
  if (a === b) return false;
  const r = getRelationship(a, b.id);
  if (r) {
    if (r.affinity < K.grudge) return true;
    if (r.kin > 0 || r.affinity > K.friend) return false;
  }
  if (a.tribeId !== NONE && b.tribeId !== NONE && a.tribeId !== b.tribeId) {
    const ta = sim.getTribe(a.tribeId);
    if (ta && (ta.relations[b.tribeId] ?? 0) < K.warHostile) return true;
  }
  return false;
}

/** True when a considers b friend/kin/tribe-mate. */
export function isFriendly(sim: Simulation, a: Agent, b: Agent): boolean {
  if (a === b) return true;
  const r = getRelationship(a, b.id);
  if (r && r.affinity < K.grudge) return false; // a personal grudge overrides everything
  if (a.tribeId !== NONE && a.tribeId === b.tribeId) return true;
  if (r && (r.kin > 0 || r.affinity > K.friend)) return true;
  if (a.tribeId !== NONE && b.tribeId !== NONE) {
    const ta = sim.getTribe(a.tribeId);
    if (ta && (ta.relations[b.tribeId] ?? 0) > K.allyFriendly) return true;
  }
  return false;
}

/** Inter-tribe attitude (-1 war .. +1 allied); 1 for the same tribe, 0 when either is unaffiliated. */
export function tribeRelation(sim: Simulation, a: TribeId, b: TribeId): number {
  if (a === NONE || b === NONE) return 0;
  if (a === b) return 1;
  const t = sim.getTribe(a);
  return t ? (t.relations[b] ?? 0) : 0;
}

/** Symmetrically shift the relations of two living tribes and log war / peace / alliance transitions. */
export function changeTribeRelation(sim: Simulation, ta: Tribe, tb: Tribe, delta: number): void {
  if (ta === tb || ta.id === tb.id || !Number.isFinite(delta) || delta === 0) return;
  if (ta.extinctTick !== -1 || tb.extinctTick !== -1) return;
  ta.relations[tb.id] = clampAff((ta.relations[tb.id] ?? 0) + delta);
  tb.relations[ta.id] = clampAff((tb.relations[ta.id] ?? 0) + delta);
  checkDiplomacy(sim, ta, tb);
}

function checkDiplomacy(sim: Simulation, ta: Tribe, tb: Tribe): void {
  const c = cacheOf(sim);
  const m = meanRelation(ta, tb);
  const key = pairKey(ta.id, tb.id);
  const where = { x: (ta.homeX + tb.homeX) / 2, y: (ta.homeY + tb.homeY) / 2, tribeId: ta.id };
  if (!c.wars.has(key)) {
    if (m < K.warDeclare) {
      c.wars.add(key);
      sim.log('conflict', 'major', `War: the ${ta.name} and the ${tb.name} are now at war.`, where);
    }
  } else if (m > K.peace) {
    c.wars.delete(key);
    sim.log('conflict', 'good', `Peace: the ${ta.name} and the ${tb.name} have ended their war.`, where);
  }
  if (!c.alliances.has(key)) {
    if (m > K.alliance) {
      c.alliances.add(key);
      sim.log('tribe', 'good', `Alliance: the ${ta.name} and the ${tb.name} have become allies.`, where);
    }
  } else if (m < K.allianceEnd) {
    c.alliances.delete(key);
    sim.log('tribe', 'info', `The alliance between the ${ta.name} and the ${tb.name} has lapsed.`, where);
  }
}

// ------------------------------------------------------------------ combat

/** Effective fighting power: strength × growth × (0.6 + skill) × health factor × stamina factor. */
export function combatPower(a: Agent): number {
  const t = a.traits;
  const hp = t.maxHealth > 0 ? clamp01(a.health / t.maxHealth) : 0;
  const p = t.strength * growthFactor(a) * (0.6 + clamp01(a.skills.combat)) * (0.5 + 0.5 * hp) * (0.75 + 0.25 * clamp01(a.energy));
  return Number.isFinite(p) && p > 0 ? p : 0.05;
}

function rememberDanger(a: Agent, x: number, y: number, value: number, tick: number): void {
  const mem = a.memory.danger;
  for (const m of mem) {
    if (dist2(m.x, m.y, x, y) < 24 * 24) {
      m.x = x;
      m.y = y;
      m.value = Math.max(m.value, value);
      m.tick = tick;
      return;
    }
  }
  while (mem.length >= LIMITS.dangerMemory) {
    let oldest = 0;
    for (let i = 1; i < mem.length; i++) if (mem[i].tick < mem[oldest].tick) oldest = i;
    mem.splice(oldest, 1);
  }
  mem.push({ x, y, value, tick });
}

/** Attacker takes a share of the defender's carried food (all of it on a kill) and, when the
 *  defender is badly hurt or dead, a little stomach food. Pure transfer — no food is created. */
function steal(attacker: Agent, defender: Agent): void {
  const dead = !(defender.health > 0);
  const hp = dead ? 0 : clamp01(defender.health / defender.traits.maxHealth);
  let carryRoom = Math.max(0, attacker.traits.maxFood - attacker.carried);
  if (defender.carried > 0 && carryRoom > 0) {
    const frac = dead ? 1 : (0.2 + 0.5 * (1 - hp)) * (0.6 + 0.4 * clamp01(attacker.traits.aggression));
    const take = Math.min(defender.carried * frac, carryRoom);
    defender.carried = Math.max(0, defender.carried - take);
    attacker.carried += take;
    carryRoom -= take;
  }
  if ((dead || hp < 0.3) && defender.food > 0) {
    const stomachRoom = Math.max(0, attacker.traits.maxFood - attacker.food);
    const take = Math.min(defender.food * (dead ? 0.5 : 0.12), stomachRoom + carryRoom);
    if (take > 0) {
      defender.food = Math.max(0, defender.food - take);
      const toStomach = Math.min(take, stomachRoom);
      attacker.food += toStomach;
      attacker.carried += take - toStomach;
      attacker.stats.foodEaten += toStomach;
    }
  }
}

function handleKill(sim: Simulation, killer: Agent, victim: Agent): void {
  if (!victim.alive) return;
  victim.health = 0;
  sim.killAgent(victim, 'combat');
  killer.stats.kills++;
  addHistory(sim, killer, `Killed ${victim.name}`);
  addHistory(sim, victim, `Killed by ${killer.name}`);
  const tk = liveTribe(sim, killer.tribeId);
  const tv = liveTribe(sim, victim.tribeId);
  if (tk && tv && tk !== tv) {
    changeTribeRelation(sim, tk, tv, K.tribeKill);
    const c = cacheOf(sim);
    const key = pairKey(tk.id, tv.id);
    if (!c.feuds.has(key)) {
      c.feuds.add(key);
      sim.log('conflict', 'bad', `First blood: ${killer.name} of the ${tk.name} killed ${victim.name} of the ${tv.name}.`, {
        x: victim.x,
        y: victim.y,
        agentId: killer.id,
        tribeId: tk.id,
      });
    }
  }
  const k = killer.stats.kills;
  if (k === 5 || k === 10 || k === 20 || k === 50 || k === 100) {
    sim.log('conflict', k >= 10 ? 'major' : 'bad', `${killer.name}${tk ? ` of the ${tk.name}` : ''} has now killed ${k} others.`, {
      x: killer.x,
      y: killer.y,
      agentId: killer.id,
      ...(tk ? { tribeId: tk.id } : {}),
    });
  }
  // the victim's family will remember
  for (const r of victim.relationships) {
    if (r.kin === 0) continue;
    const kinAgent = sim.getAgent(r.id);
    if (kinAgent && kinAgent !== killer) adjustRelationship(sim, kinAgent, killer, -0.3);
  }
}

/** One combat exchange: attacker hits defender. Handles damage, theft, deaths (cause 'combat'), grudges, counters. */
export function attack(sim: Simulation, attacker: Agent, defender: Agent): void {
  if (attacker === defender || !attacker.alive || !defender.alive) return;
  const s = sim.state;
  const tick = s.tick;
  const rng = sim.rng;
  const agg = aggMul(sim);
  const biasMul = (1 + 0.3 * agg) / 1.3;

  // Several exchanges in quick succession between the same pair form one "incident".
  const prev = getRelationship(defender, attacker.id);
  const newIncident = defender.lastAttackerId !== attacker.id || !prev || tick - prev.lastTick > K.incidentGap;

  // 1. the blow
  const dmg = K.baseDamage * combatPower(attacker) * rng.range(0.6, 1.4) * biasMul * (0.85 + 0.3 * clamp01(attacker.traits.aggression));
  defender.health = Math.max(0, defender.health - dmg);
  attacker.stats.fights++;
  defender.stats.fights++;
  s.stats.counters.fights++;
  defender.lastAttackerId = attacker.id;
  learn(attacker, 'combat', 0.02);
  learn(defender, 'combat', 0.012);
  rememberDanger(defender, defender.x, defender.y, clamp01(0.3 + (2 * dmg) / Math.max(1, defender.traits.maxHealth)), tick);

  // 2. grudges & diplomacy
  adjustRelationship(sim, defender, attacker, newIncident ? K.attackGrudge : -0.1);
  adjustRelationship(sim, attacker, defender, -0.05);
  if (newIncident) {
    addHistory(sim, defender, `Attacked by ${attacker.name}`);
    for (const r of defender.relationships) {
      if (r.kin === 0) continue;
      const kinAgent = sim.getAgent(r.id);
      if (kinAgent && kinAgent !== attacker) adjustRelationship(sim, kinAgent, attacker, K.attackGrudge);
    }
    const ta = liveTribe(sim, attacker.tribeId);
    const td = liveTribe(sim, defender.tribeId);
    if (ta && td && ta !== td) changeTribeRelation(sim, ta, td, K.tribeIncident);
  }

  // 3. retaliation by the defender, then group defence by nearby tribe-mates / kin
  let killer: Agent | null = null;
  if (defender.health > 0) {
    const hit = K.retaliation * K.baseDamage * combatPower(defender) * rng.range(0.6, 1.4);
    attacker.health = Math.max(0, attacker.health - hit);
    if (attacker.health <= 0) killer = defender;
  }
  if (!killer) {
    const nb = sim.spatial.query(defender.x, defender.y, K.groupDefenseRadius, helperScratch, defender);
    let helpers = 0;
    for (let i = 0; i < nb.length && helpers < K.maxHelpers; i++) {
      const h = nb[i];
      if (h === attacker || !h.alive || !isAdult(h) || h.health < 0.3 * h.traits.maxHealth) continue;
      const sameTribe = h.tribeId !== NONE && h.tribeId === defender.tribeId && h.tribeId !== attacker.tribeId;
      const toDef = getRelationship(h, defender.id);
      const kinOfDef = toDef !== undefined && toDef.kin > 0 && toDef.affinity >= K.grudge;
      if (!sameTribe && !kinOfDef) continue;
      const toAtt = getRelationship(h, attacker.id);
      if (toAtt && toAtt.kin > 0) continue; // will not strike its own family
      helpers++;
      const hit = K.helperHit * K.baseDamage * combatPower(h) * rng.range(0.6, 1.4);
      attacker.health = Math.max(0, attacker.health - hit);
      h.stats.fights++;
      learn(h, 'combat', 0.008);
      adjustRelationship(sim, h, attacker, newIncident ? K.helperGrudge : -0.05);
      if (attacker.health <= 0) {
        killer = h;
        break;
      }
    }
  }

  // 4. theft, then deaths
  if (attacker.health > 0) steal(attacker, defender);
  if (!(defender.health > 0)) handleKill(sim, attacker, defender);
  if (!(attacker.health > 0) && attacker.alive) handleKill(sim, killer ?? defender, attacker);
}

// ------------------------------------------------------------------ sharing & stockpiles

/** Give food from giver to receiver (from carried first, then stomach). Returns amount transferred. */
export function shareFood(sim: Simulation, giver: Agent, receiver: Agent, amount: number): number {
  if (giver === receiver || !giver.alive || !receiver.alive || !(amount > 0)) return 0;
  const fromCarried = giver.carried > 0 ? Math.min(giver.carried, amount) : 0;
  const spare = Math.max(0, giver.food - 0.5 * giver.traits.maxFood);
  const fromStomach = Math.min(amount - fromCarried, spare);
  const total = fromCarried + fromStomach;
  if (!(total > 0)) return 0;
  giver.carried = Math.max(0, giver.carried - fromCarried);
  giver.food = Math.max(0, giver.food - fromStomach);
  const room = Math.max(0, receiver.traits.maxFood - receiver.food);
  const toStomach = Math.min(total, room);
  const wasStarving = receiver.food < 0.15 * receiver.traits.maxFood;
  receiver.food += toStomach;
  receiver.carried = Math.max(0, receiver.carried) + (total - toStomach);

  giver.stats.shared += total;
  receiver.stats.received += total;
  sim.state.stats.counters.shares++;
  adjustRelationship(sim, receiver, giver, K.giftAffinityReceiver);
  adjustRelationship(sim, giver, receiver, K.giftAffinityGiver);
  learn(giver, 'social', 0.02);
  learn(receiver, 'social', 0.005);
  if (wasStarving && toStomach > 0.1 * receiver.traits.maxFood) addHistory(sim, receiver, `Saved from starvation by ${giver.name}`);

  const tg = liveTribe(sim, giver.tribeId);
  const tr = liveTribe(sim, receiver.tribeId);
  if (tg && tr && tg !== tr) {
    changeTribeRelation(sim, tg, tr, K.giftRelation * (0.3 + 0.7 * Math.min(1, total / 20)) * Math.max(0.2, coopMul(sim)));
  }
  return total;
}

/** Maximum stockpile a tribe can keep (excess spoils). */
export function stockpileCapacity(t: Tribe): number {
  return K.stockBase + K.stockPerMember * Math.max(0, t.members);
}

function nearCamp(a: Agent, t: Tribe): boolean {
  return dist2(a.x, a.y, t.homeX, t.homeY) <= K.campRadius * K.campRadius;
}

/** Deposit carried food into the agent's tribe stockpile (must be near camp). Returns amount deposited. */
export function depositFood(sim: Simulation, a: Agent): number {
  const t = liveTribe(sim, a.tribeId);
  if (!t || !a.alive || !(a.carried > 0) || !nearCamp(a, t)) return 0;
  const room = Math.max(0, stockpileCapacity(t) - Math.max(0, t.stockpile));
  const amt = Math.min(a.carried, room);
  if (!(amt > 0)) return 0;
  a.carried = Math.max(0, a.carried - amt);
  t.stockpile = Math.max(0, t.stockpile) + amt;
  learn(a, 'social', 0.003);
  return amt;
}

/** Withdraw up to `amount` from tribe stockpile into stomach (must be near camp). Returns amount taken. */
export function withdrawFood(sim: Simulation, a: Agent, amount: number): number {
  const t = liveTribe(sim, a.tribeId);
  if (!t || !a.alive || !(amount > 0) || !(t.stockpile > 0) || !nearCamp(a, t)) return 0;
  const room = Math.max(0, a.traits.maxFood - a.food);
  const amt = Math.min(amount, t.stockpile, room);
  if (!(amt > 0)) return 0;
  t.stockpile = Math.max(0, t.stockpile - amt);
  a.food += amt;
  a.stats.foodEaten += amt;
  return amt;
}

// ------------------------------------------------------------------ membership

export function joinTribe(sim: Simulation, a: Agent, tribeId: TribeId): void {
  if (tribeId === NONE) {
    leaveTribe(sim, a);
    return;
  }
  if (a.tribeId === tribeId) return;
  const t = sim.getTribe(tribeId);
  if (!t) {
    leaveTribe(sim, a);
    return;
  }
  if (a.tribeId !== NONE) leaveTribe(sim, a);
  if (t.extinctTick !== -1) t.extinctTick = -1; // explicitly re-populated (e.g. spawn into an old tribe)
  a.tribeId = tribeId;
  t.members++;
  t.totalJoined++;
  if (t.members > t.peakMembers) t.peakMembers = t.members;
  const rec = sim.lineageById.get(a.id);
  if (rec) rec.tribeId = tribeId;
}

export function leaveTribe(sim: Simulation, a: Agent): void {
  if (a.tribeId === NONE) return;
  const t = sim.getTribe(a.tribeId);
  if (t && t.members > 0) t.members--;
  a.tribeId = NONE;
  const rec = sim.lineageById.get(a.id);
  if (rec) rec.tribeId = NONE;
}

/** Found a new tribe with `founder` (and optional initial members). Camp = group centroid when passable. */
export function foundTribe(
  sim: Simulation,
  founder: Agent,
  members: Agent[] = [],
  name?: string,
  hue?: number,
  parentTribeId: TribeId = NONE,
): Tribe {
  let cx = founder.x;
  let cy = founder.y;
  for (const m of members) {
    cx += m.x;
    cy += m.y;
  }
  cx /= members.length + 1;
  cy /= members.length + 1;
  const home = Number.isFinite(cx) && Number.isFinite(cy) && sim.passableAt(cx, cy);
  const t = sim.createTribe(founder, home ? cx : founder.x, home ? cy : founder.y, name, hue, parentTribeId);
  joinTribe(sim, founder, t.id);
  for (const m of members) joinTribe(sim, m, t.id);
  return t;
}

// ------------------------------------------------------------------ periodic update

/** Periodic social systems: relationship decay/pruning, tribe formation/fission/extinction, inter-tribe relations, territory map, roles. */
export function updateSocial(sim: Simulation): void {
  const s = sim.state;
  const tick = s.tick;
  const c = cacheOf(sim);
  const agents = s.agents;

  // Every tick: forget agents that died this tick (they are flushed right after this system)
  // and gather population skill means (used for comparative role assignment).
  let n = 0;
  let sf = 0;
  let sc = 0;
  let ss = 0;
  let sm = 0;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    if (!a.alive) {
      forgetDead(sim, a);
      continue;
    }
    if (a.age >= a.traits.maturityAge) {
      n++;
      sf += clamp01(a.skills.forage);
      sc += clamp01(a.skills.combat);
      ss += clamp01(a.skills.social);
      sm += moveRate(a);
    }
  }
  c.meanForage = n ? sf / n : 0;
  c.meanCombat = n ? sc / n : 0;
  c.meanSocial = n ? ss / n : 0;
  c.meanMove = n ? sm / n : 0;

  const P = K.agentPeriod;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    if (!a.alive || (tick + a.id) % P !== 0) continue;
    agentUpdate(sim, a, c);
  }

  if (tick % K.tribePeriod === 0) tribePass(sim, c);
  if (tick % K.territoryPeriod === 0) territoryPass(sim, c);
}

function forgetDead(sim: Simulation, dead: Agent): void {
  const rs = dead.relationships;
  for (let i = 0; i < rs.length; i++) {
    const p = sim.getAgent(rs[i].id);
    if (p) removeRelationship(p, dead.id);
  }
}

function moveRate(a: Agent): number {
  const r = a.stats.distance / Math.max(1, a.age) / Math.max(0.1, a.traits.speed);
  return Number.isFinite(r) ? r : 0;
}

function agentUpdate(sim: Simulation, a: Agent, c: SocialCache): void {
  maintainRelationships(sim, a);
  const sk = a.skills;
  sk.forage = clamp01(sk.forage) * K.skillDecay;
  sk.combat = clamp01(sk.combat) * K.skillDecay;
  sk.social = clamp01(sk.social) * K.skillDecay;
  assignRole(a, c);

  const nb = sim.spatial.query(a.x, a.y, K.neighbourRadius, nbrScratch, a);
  bond(sim, a, nb);
  if (!sim.state.config.tribesEnabled) return;
  if (a.tribeId === NONE) considerJoinOrFound(sim, a, nb);
  else considerLeaving(sim, a);
}

function maintainRelationships(sim: Simulation, a: Agent): void {
  const rs = a.relationships;
  const tick = sim.state.tick;
  let w = 0;
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i];
    if (!sim.getAgent(r.id)) continue; // partner died
    const aff = clampAff(r.affinity) * (r.kin ? K.kinDecay : K.nonKinDecay);
    r.affinity = aff;
    if (r.kin === 0 && Math.abs(aff) < 0.02 && tick - r.lastTick > K.forgetAfter) continue;
    rs[w++] = r;
  }
  rs.length = w;
  while (rs.length > LIMITS.relationships) rs.splice(Math.max(0, weakestIndex(sim, rs, true)), 1);
}

/** Familiarity: agents that spend time near each other slowly warm to one another. */
function bond(sim: Simulation, a: Agent, nb: Agent[]): void {
  if (nb.length === 0) return;
  const delta = K.bondDelta * (0.5 + clamp01(a.traits.sociability)) * (0.5 + 0.5 * coopMul(sim));
  const r2 = K.bondRadius * K.bondRadius;
  const start = sim.rng.int(nb.length);
  let made = 0;
  for (let k = 0; k < nb.length && made < K.bondMax; k++) {
    const o = nb[(start + k) % nb.length];
    if (!o.alive || dist2(a.x, a.y, o.x, o.y) > r2 || isHostile(sim, a, o)) continue;
    adjustRelationship(sim, a, o, delta);
    made++;
  }
}

function assignRole(a: Agent, c: SocialCache): void {
  if (!isAdult(a)) {
    a.role = 'none';
    return;
  }
  const g = a.genes;
  const sk = a.skills;
  const gene = (i: number) => clamp01(g[i]);
  const scores: Record<Role, number> = {
    none: K.roleMin,
    forager: 0.12 + 1.5 * (clamp01(sk.forage) - c.meanForage) + 0.3 * (gene(G.efficiency) - 0.5),
    warrior: 1.5 * (clamp01(sk.combat) - c.meanCombat) + 0.5 * (gene(G.aggression) - 0.5) + 0.2 * (gene(G.size) - 0.5),
    caretaker:
      1.5 * (clamp01(sk.social) - c.meanSocial) + 0.5 * (gene(G.altruism) - 0.5) + 0.25 * Math.min(1, a.stats.shared / 100) - 0.03,
    explorer: 0.3 * (gene(G.perception) - 0.5) + 0.3 * (gene(G.speed) - 0.5) + 1.0 * (moveRate(a) - c.meanMove),
  };
  if (a.role !== 'none') scores[a.role] += 0.04; // hysteresis
  let best: Role = 'none';
  for (const r of ROLES) if (scores[r] > scores[best]) best = r;
  a.role = best;
}

function countLivingTribes(sim: Simulation): number {
  let n = 0;
  for (const t of sim.state.tribes) if (t.extinctTick === -1) n++;
  return n;
}

function considerJoinOrFound(sim: Simulation, a: Agent, nb: Agent[]): void {
  const mat = a.traits.maturityAge;
  if (a.age < 0.5 * mat) return;
  const soc = clamp01(a.traits.sociability);
  const coop = 0.4 + 0.6 * coopMul(sim);

  // ---- join a tribe whose members nearby a likes (or that is well represented and not resented)
  tribeScoreIds.length = 0;
  tribeScores.length = 0;
  for (const o of nb) {
    if (o.tribeId === NONE || !liveTribe(sim, o.tribeId)) continue;
    const r = getRelationship(a, o.id);
    let v = 0.3;
    if (r) {
      if (r.affinity < K.grudge) v = -2;
      else if (r.kin > 0 || r.affinity > 0.2) v = 1;
    }
    let idx = tribeScoreIds.indexOf(o.tribeId);
    if (idx < 0) {
      idx = tribeScoreIds.length;
      tribeScoreIds.push(o.tribeId);
      tribeScores.push(0);
    }
    tribeScores[idx] += v;
  }
  let bestIdx = -1;
  for (let i = 0; i < tribeScores.length; i++) {
    if (tribeScores[i] >= 1 && (bestIdx < 0 || tribeScores[i] > tribeScores[bestIdx])) bestIdx = i;
  }
  if (bestIdx >= 0) {
    if (sim.rng.chance(Math.min(1, K.joinProb * soc * coop))) {
      const t = sim.getTribe(tribeScoreIds[bestIdx])!;
      joinTribe(sim, a, t.id);
      addHistory(sim, a, `Joined the ${t.name}`);
    }
    return; // a tribe is close by: do not found a rival one right next to it
  }

  // ---- found a new tribe with like-minded unaffiliated neighbours
  if (soc <= K.foundSociability || a.age < mat) return;
  const eligible = eligibleScratch;
  eligible.length = 0;
  for (const o of nb) {
    if (o.tribeId !== NONE || !o.alive || o.age < 0.5 * o.traits.maturityAge) continue;
    const r = getRelationship(a, o.id);
    if (r && r.affinity < K.grudge) continue;
    const friendly = r !== undefined && (r.kin > 0 || r.affinity > 0.2);
    if (!friendly && clamp01(o.traits.sociability) <= K.foundSociability) continue;
    eligible.push(o);
    if (eligible.length >= K.maxFounding) break;
  }
  if (eligible.length < 2) return;
  if (countLivingTribes(sim) >= K.maxLivingTribes) return;
  if (!sim.rng.chance(Math.min(1, K.foundProb * soc * coop))) return;

  const first = sim.state.nextTribeId === 1;
  const t = foundTribe(sim, a, eligible.slice());
  addHistory(sim, a, `Founded the ${t.name} with ${eligible.length} others`);
  for (const o of eligible) addHistory(sim, o, `Helped ${a.name} found the ${t.name}`);
  sim.log(
    'tribe',
    first ? 'major' : 'good',
    first
      ? `The first tribe has formed: ${a.name} gathered ${eligible.length} others into the ${t.name}.`
      : `${a.name} founded the ${t.name} with ${eligible.length} others.`,
    { x: t.homeX, y: t.homeY, agentId: a.id, tribeId: t.id },
  );
}

function considerLeaving(sim: Simulation, a: Agent): void {
  const t = liveTribe(sim, a.tribeId);
  if (!t) {
    a.tribeId = NONE; // tribe vanished (extinct / dropped): become unaffiliated
    return;
  }
  const soc = clamp01(a.traits.sociability);
  const hungry = a.food < 0.3 * a.traits.maxFood;
  const famine = hungry && t.stockpile < Math.max(1, t.members) * 2;
  let p = 0;
  if (soc < K.leaveSociability) p += 0.004 * (1 - soc / K.leaveSociability);
  if (famine) p += 0.03 * (1 - soc) * (1 - soc);
  if (p <= 0 || !sim.rng.chance(p)) return;
  leaveTribe(sim, a);
  addHistory(sim, a, famine ? `Left the starving ${t.name}` : `Left the ${t.name} to live alone`);
}

// ------------------------------------------------------------------ tribe pass

function tribePass(sim: Simulation, c: SocialCache): void {
  const s = sim.state;
  const tribes = s.tribes;

  // --- recount
  for (const t of tribes) {
    if (t.extinctTick !== -1) continue;
    let g = c.groups.get(t.id);
    if (!g) {
      g = { list: [], genes: new Float64Array(GENE_COUNT), foodFrac: 0, scarcity: 0 };
      c.groups.set(t.id, g);
    } else {
      g.list.length = 0;
      g.genes.fill(0);
      g.foodFrac = 0;
      g.scarcity = 0;
    }
    for (const r of ROLES) t.roles[r] = 0;
  }
  for (const a of s.agents) {
    if (!a.alive || a.tribeId === NONE) continue;
    const t = liveTribe(sim, a.tribeId);
    const g = t ? c.groups.get(t.id) : undefined;
    if (!t || !g) {
      a.tribeId = NONE; // orphaned (tribe extinct or dropped from the registry)
      continue;
    }
    g.list.push(a);
    for (let i = 0; i < GENE_COUNT; i++) g.genes[i] += a.genes[i] ?? 0;
    g.foodFrac += a.traits.maxFood > 0 ? clamp01(a.food / a.traits.maxFood) : 0;
    t.roles[a.role] = (t.roles[a.role] ?? 0) + 1;
  }

  const spoil = Math.pow(1 - K.stockSpoil, K.tribePeriod);
  for (const t of tribes) {
    if (t.extinctTick !== -1) continue;
    const g = c.groups.get(t.id)!;
    const n = g.list.length;
    t.members = n;
    if (n > t.peakMembers) {
      for (const m of [25, 50, 100, 200]) {
        if (t.peakMembers < m && n >= m) {
          sim.log('tribe', m >= 50 ? 'major' : 'good', `The ${t.name} have grown to ${m} members.`, { x: t.homeX, y: t.homeY, tribeId: t.id });
        }
      }
      t.peakMembers = n;
    }
    if (n === 0) {
      if (s.tick - t.foundedTick >= K.extinctGrace) markExtinct(sim, t, c);
      continue;
    }
    if (t.meanGenes.length !== GENE_COUNT) t.meanGenes = new Array(GENE_COUNT).fill(0);
    for (let i = 0; i < GENE_COUNT; i++) t.meanGenes[i] = g.genes[i] / n;
    g.foodFrac /= n;
    g.scarcity = clamp01((0.6 - g.foodFrac) / 0.5) * (t.stockpile < n * 5 ? 1 : 0.5);

    // stockpile: slow spoilage, hard cap, never negative / NaN
    let st = Number.isFinite(t.stockpile) ? t.stockpile * spoil : 0;
    st = Math.min(st, stockpileCapacity(t));
    t.stockpile = st > 1e-6 ? st : 0;

    moveCamp(sim, t, g.list);
  }

  // --- diplomacy: drift toward neutral, drop dead tribes, log transitions
  for (const t of tribes) {
    if (t.extinctTick !== -1) continue;
    for (const key in t.relations) {
      const oid = Number(key);
      const o = sim.getTribe(oid);
      if (!o || o.extinctTick !== -1 || oid === t.id) {
        delete t.relations[oid];
        continue;
      }
      const v = t.relations[oid] * K.relDrift;
      t.relations[oid] = Number.isFinite(v) ? clampAff(v) : 0;
    }
  }
  for (const t of tribes) {
    if (t.extinctTick !== -1) continue;
    for (const key in t.relations) {
      const o = sim.getTribe(Number(key));
      if (o && o.id > t.id) checkDiplomacy(sim, t, o);
    }
  }

  if (s.config.tribesEnabled) considerFission(sim, c);
}

function markExtinct(sim: Simulation, t: Tribe, c: SocialCache): void {
  const s = sim.state;
  t.extinctTick = s.tick;
  t.members = 0;
  t.stockpile = 0; // the camp's store is abandoned
  t.territory = 0;
  for (const r of ROLES) t.roles[r] = 0;
  for (const o of s.tribes) {
    if (o === t) continue;
    if (o.relations[t.id] !== undefined) delete o.relations[t.id];
    const key = pairKey(t.id, o.id);
    c.wars.delete(key);
    c.alliances.delete(key);
  }
  t.relations = {};
  c.groups.delete(t.id);
  const terr = s.world.territory;
  for (let i = 0; i < terr.length; i++) if (terr[i] === t.id) terr[i] = -1;
  const days = (s.tick - t.foundedTick) / Math.max(1, s.config.dayLength);
  sim.log('tribe', t.peakMembers >= 10 ? 'major' : 'bad', `The ${t.name} have died out after ${days.toFixed(1)} days (peak ${t.peakMembers} members).`, {
    x: t.homeX,
    y: t.homeY,
    tribeId: t.id,
  });
}

/** Drift the camp toward the members' centroid, weighted toward members standing on food. */
function moveCamp(sim: Simulation, t: Tribe, list: Agent[]): void {
  const food = sim.state.world.food;
  const pull2 = K.campPull * K.campPull;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let pass = 0; pass < 2 && sw === 0; pass++) {
    for (const m of list) {
      if (pass === 0 && dist2(m.x, m.y, t.homeX, t.homeY) > pull2) continue;
      const ti = sim.tileIndex(m.x, m.y);
      const f = ti >= 0 ? food[ti] : 0;
      const w = 0.5 + Math.min(2, (Number.isFinite(f) ? f : 0) / 5);
      sx += m.x * w;
      sy += m.y * w;
      sw += w;
    }
  }
  if (sw === 0) return;
  const tx = sx / sw;
  const ty = sy / sw;
  if (!sim.passableAt(t.homeX, t.homeY)) {
    // camp flooded / walled in: relocate outright
    const ok = sim.passableAt(tx, ty);
    t.homeX = ok ? tx : list[0].x;
    t.homeY = ok ? ty : list[0].y;
    return;
  }
  const dx = tx - t.homeX;
  const dy = ty - t.homeY;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (!(d > 1)) return;
  const step = Math.min(K.campStep, d * 0.1);
  for (const f of [1, 0.5]) {
    const nx = sim.clampX(t.homeX + (dx / d) * step * f);
    const ny = sim.clampY(t.homeY + (dy / d) * step * f);
    if (sim.passableAt(nx, ny)) {
      t.homeX = nx;
      t.homeY = ny;
      return;
    }
  }
}

/** Oversized or over-stretched tribes split: the cluster around the farthest member founds a daughter tribe. */
function considerFission(sim: Simulation, c: SocialCache): void {
  const s = sim.state;
  if (countLivingTribes(sim) >= K.maxLivingTribes) return;
  const far2 = K.fissionFar * K.fissionFar;
  const tribes = s.tribes;
  const count = tribes.length; // tribes founded below are not revisited
  for (let ti = 0; ti < count; ti++) {
    const t = tribes[ti];
    if (t.extinctTick !== -1) continue;
    const g = c.groups.get(t.id);
    if (!g) continue;
    const list = g.list;
    const n = list.length;
    if (n < K.fissionMinMembers || s.tick - t.foundedTick < K.fissionMinAge) continue;
    let far = 0;
    let pole: Agent | null = null;
    let poleD = -1;
    for (const m of list) {
      const d = dist2(m.x, m.y, t.homeX, t.homeY);
      if (d > far2) far++;
      if (d > poleD) {
        poleD = d;
        pole = m;
      }
    }
    const big = n > K.fissionSize;
    const stretched = far >= Math.max(6, 0.3 * n);
    if (!pole || (!big && !stretched)) continue;
    if (!sim.rng.chance(big ? 0.3 : 0.2)) continue;

    const px = pole.x;
    const py = pole.y;
    const byPole = list.slice().sort((p, q) => dist2(p.x, p.y, px, py) - dist2(q.x, q.y, px, py) || p.id - q.id);
    let k = 0;
    for (const m of byPole) if (dist2(m.x, m.y, px, py) < dist2(m.x, m.y, t.homeX, t.homeY)) k++;
    k = Math.max(Math.ceil(0.25 * n), Math.min(Math.floor(0.6 * n), k));
    if (k < 5) continue;
    const faction = byPole.slice(0, k);
    let founder: Agent | null = null;
    for (const m of faction) {
      if (isAdult(m) && (!founder || m.traits.sociability > founder.traits.sociability)) founder = m;
    }
    if (!founder) continue;
    split(sim, t, founder, faction, g.scarcity);
    return; // at most one fission per pass
  }
}

function split(sim: Simulation, parent: Tribe, founder: Agent, faction: Agent[], scarcity: number): void {
  const rng = sim.rng;
  const n = parent.members;
  const hue = (parent.hue + (rng.chance(0.5) ? 1 : -1) * rng.range(25, 50) + 360) % 360;
  const others = faction.filter((m) => m !== founder);
  const nt = foundTribe(sim, founder, others, undefined, hue, parent.id);
  // daughter takes a proportional share of the store; sister tribes start on good terms unless hungry
  const share = n > 0 ? Math.max(0, parent.stockpile) * (faction.length / n) * 0.5 : 0;
  parent.stockpile = Math.max(0, parent.stockpile - share);
  nt.stockpile = share;
  const rel = scarcity > 0.5 ? 0 : 0.25;
  nt.relations[parent.id] = rel;
  parent.relations[nt.id] = rel;
  addHistory(sim, founder, `Led ${others.length} followers away from the ${parent.name} to found the ${nt.name}`);
  for (const m of others) addHistory(sim, m, `Followed ${founder.name} to found the ${nt.name}`);
  sim.log('tribe', 'major', `The ${nt.name} split from the ${parent.name} (${faction.length} members led by ${founder.name}).`, {
    x: nt.homeX,
    y: nt.homeY,
    agentId: founder.id,
    tribeId: nt.id,
  });
}

// ------------------------------------------------------------------ territory

function ensureTerritoryBuffers(c: SocialCache, n: number): void {
  if (c.tiles === n) return;
  c.tiles = n;
  c.acc = new Float32Array(n);
  c.best = new Float32Array(n);
  c.second = new Float32Array(n);
  c.bestT = new Int32Array(n);
  c.secondT = new Int32Array(n);
  c.mark = new Int32Array(n);
  c.touched = new Int32Array(n);
  c.markId = 0;
}

/**
 * Territory: every member stamps an influence disc (radius territoryRadius tiles, linear falloff)
 * into a per-tribe accumulator (only touched tiles are visited); the camp stamps a stronger disc.
 * Each passable tile goes to the tribe with the highest influence above territoryMin. Tiles where the
 * runner-up has ≥ 50% of the winner's influence are "contested" and erode relations between the pair.
 */
function territoryPass(sim: Simulation, c: SocialCache): void {
  const s = sim.state;
  const w = s.world;
  const W = w.width;
  const H = w.height;
  const N = W * H;
  if (!(w.territory instanceof Int16Array) || w.territory.length !== N) w.territory = new Int16Array(N).fill(-1);
  const terr = w.territory;
  if (!s.config.tribesEnabled) {
    terr.fill(-1);
    for (const t of s.tribes) t.territory = 0;
    return;
  }
  ensureTerritoryBuffers(c, N);
  const { acc, best, second, bestT, secondT, mark, touched, falloff } = c;
  best.fill(0);
  second.fill(0);
  bestT.fill(-1);
  secondT.fill(-1);
  const R = K.territoryRadius;
  const D = 2 * R + 1;
  const ts = w.tileSize;

  for (const t of s.tribes) {
    if (t.extinctTick !== -1) continue;
    const g = c.groups.get(t.id);
    if (!g || g.list.length === 0) continue;
    const markId = ++c.markId;
    let nt = 0;
    const stamp = (x: number, y: number, weight: number) => {
      const tx0 = Math.floor(x / ts);
      const ty0 = Math.floor(y / ts);
      if (!Number.isFinite(tx0) || !Number.isFinite(ty0)) return;
      for (let dy = -R; dy <= R; dy++) {
        const ty = ty0 + dy;
        if (ty < 0 || ty >= H) continue;
        const row = ty * W;
        const frow = (dy + R) * D + R;
        for (let dx = -R; dx <= R; dx++) {
          const tx = tx0 + dx;
          if (tx < 0 || tx >= W) continue;
          const f = falloff[frow + dx];
          if (f <= 0) continue;
          const i = row + tx;
          if (mark[i] !== markId) {
            mark[i] = markId;
            acc[i] = 0;
            touched[nt++] = i;
          }
          acc[i] += f * weight;
        }
      }
    };
    for (const m of g.list) stamp(m.x, m.y, 1);
    stamp(t.homeX, t.homeY, K.campInfluence);
    for (let k = 0; k < nt; k++) {
      const i = touched[k];
      const v = acc[i];
      if (v > best[i]) {
        second[i] = best[i];
        secondT[i] = bestT[i];
        best[i] = v;
        bestT[i] = t.id;
      } else if (v > second[i]) {
        second[i] = v;
        secondT[i] = t.id;
      }
    }
  }

  const counts = new Map<TribeId, number>();
  const contested = new Map<number, { a: TribeId; b: TribeId; n: number }>();
  const terrain = w.terrain;
  for (let i = 0; i < N; i++) {
    const b = best[i];
    const owner = b >= K.territoryMin && PASSABLE[terrain[i]] === 1 && bestT[i] <= 32767 ? bestT[i] : -1;
    terr[i] = owner;
    if (owner === -1) continue;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
    const rival = secondT[i];
    if (rival !== -1 && second[i] >= 0.5 * b) {
      const key = pairKey(owner, rival);
      const e = contested.get(key);
      if (e) e.n++;
      else contested.set(key, { a: owner, b: rival, n: 1 });
    }
  }
  for (const t of s.tribes) t.territory = t.extinctTick === -1 ? (counts.get(t.id) ?? 0) : 0;

  // Border friction: contested land erodes relations, much faster when either side is hungry.
  const agg = 0.5 + 0.5 * aggMul(sim);
  for (const e of contested.values()) {
    const ta = liveTribe(sim, e.a);
    const tb = liveTribe(sim, e.b);
    if (!ta || !tb) continue;
    const sa = c.groups.get(ta.id)?.scarcity ?? 0;
    const sb = c.groups.get(tb.id)?.scarcity ?? 0;
    changeTribeRelation(sim, ta, tb, -K.borderFriction * Math.min(e.n, 60) * (0.4 + sa + sb) * agg);
  }
}
