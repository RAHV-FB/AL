// OWNER: Agent Intelligence agent.
/**
 * Agent mind — a utility-based autonomous controller.
 *
 * think(sim, a)  (every ~6–14 ticks per agent, staggered; 3–5 when threatened or fighting)
 *   1. needs: hunger, fatigue, health, infection; environment: night, winter/cold.
 *   2. perception (radius = perception × (0.55 + 0.45·daylight)): neighbours are classified into
 *      threats (attackers, enemies, and — for timid agents — aggressive, stronger strangers),
 *      fight-back / defend targets, conflict candidates, potential mates, needy friends & own
 *      children, friends to socialise with, tribe cohesion. The adult strength of every band (tribe)
 *      in view and of my allies close by is tallied to judge the odds of a fight.
 *   3. food: tile underfoot, a cheap local scan (which also measures local food per head =
 *      scarcity), ecology.findFood and remembered rich spots (memory.food); danger memory and active
 *      disasters are avoided. Targets in a straight line (steering.clearPath) are preferred; places beyond
 *      a river or a lake — food when the near side is bare, the camp, an enemy camp, exploration goals — are
 *      reached by planned routes across fords (steering.moveToward → pathfinding.planRoute), and targets that
 *      cannot be reached at all (pathfinding.sameRegion) are never chosen.
 *   4. conflict appraisal — nothing scripted: for each out-group agent in view a motive (rob its load
 *      or drive it off a patch I need when food is scarce; chase it off my tribe's land near camp;
 *      tribal war or a personal feud; join a friend's fight) is weighed by the odds (combat power incl.
 *      the band backing it vs. my allies) against my boldness (aggression gene × aggressionBias, combat
 *      skill, health), then by temperament. Tribes at war send bold members to raid the enemy camp.
 *   5. a utility for every ActionKind (traits × config biases × skills × role × tribe logistics),
 *      small rng noise + hysteresis, argmax → action (choices whose target cannot be walked to are
 *      dropped), target, readable thought, a.utilities, a.decisionCooldown, smoothed a.fear.
 * act(sim, a)    (every tick, allocation-free; targets re-resolved by id)
 *   steering with obstacle avoidance (steering.ts) and the action's effect:
 *   eat/gather, flee, attack, share, mate, socialise, camp deposit/withdraw,
 *   explore / raid (plunder on arrival), wander (juveniles stay near their mother), rest/idle.
 */
import type { Simulation } from './simulation';
import { ACTIONS, NONE, type ActionKind, type Agent, type TerrainType, type Tribe } from './types';
import { LIMITS, TERRAIN_INFO } from './constants';
import { consumeFood, findFood, foodAt, tileCapacity } from './ecology';
import {
  SOCIAL_TUNING,
  adjustRelationship,
  attack,
  carryCapacity,
  combatPower,
  depositFood,
  isFriendly,
  isHostile,
  raidStockpile,
  shareFood,
  stockpileCapacity,
  withdrawFood,
} from './social';
import { canMate, geneticDistance, reproduce } from './genetics';
import { growthFactor, isAdult } from './lifecycle';
import { temperatureAt } from './disasters';
import { clearPath, escapeImpassable, halt, moveToward, stepDir } from './steering';
import { sameRegion } from './pathfinding';

/**
 * Re-exported for callers that think of them as properties of the agent. The brain judges fights with
 * the same combatPower that social.attack uses to resolve them, so agents read the odds correctly.
 */
export { carryCapacity, combatPower };

// ------------------------------------------------------------------ tuning
const MAX_NEIGHBOURS = 48;
/** Exact scan radius (tiles) around the agent; complements ecology.findFood's sparse long-range lattice. */
const LOCAL_SCAN_TILES = 5;
const FOOD_MEMORY_TTL = 5000;
const DANGER_MEMORY_TTL = 1500;
const DANGER_RADIUS = 60;
const ATTACK_INTERVAL = 15;
/** Below this fraction of max health a fighter breaks off (actAttack), so think() does not choose to fight. */
const FIGHT_MIN_HP = 0.35;
const SOCIAL_INTERVAL = 10;
const SHARE_RANGE = 8;
const MATE_RANGE = 8;
const SOCIAL_RANGE = 10;
const CAMP_RANGE = 20;
const MAX_MATE_CHECKS = 8;
/** Food candidates kept per think (best first) so an unreachable best can fall back to the next one. */
const FOOD_CANDS = 4;
/** Out-group agents appraised as conflict targets per think (the nearest are kept). */
const MAX_CANDS = 12;
/** Bands (tribes) whose adult strength in view is tallied per think. */
const TALLY_MAX = 16;
/** Allies within this distance count as backing in a fight. */
const FIGHT_R = 40;
/** Crowding radius for local food per head (≈ the local food scan). */
const LOCAL_R = 44;
/** Local food per head (scan sum / agents nearby) below which food counts as scarce (0 → scarcity 1). */
const SCARCE_PER_HEAD = 40;
/** Outsiders closer than this to my tribe's camp, standing on my tribe's land, can be challenged. */
const TERRITORY_R = 160;
/** Enemy camps farther than this on foot (walking distance by the best route, world units) are not worth raiding. */
const RAID_RANGE = 1100;
/** How long (ticks) a raider keeps marching on an enemy camp before giving up (2.5 days at the default day length). */
export const RAID_TREK_TICKS = 1500;
/** A raider whose health falls below this fraction breaks off the raid. */
const RAID_GIVE_UP_HP = 0.45;
/** Extra utility that keeps a raider on the march once it has set out. */
const RAID_COMMIT = 0.25;
/** Genetic distance (0..1) below which another agent looks like "one of us" (hostility toward it fades). */
const ALIKE_DIST = 0.3;
/** Distance a fleeing agent aims for (its escape point must be open ground). */
const FLEE_DIST = 80;

const N_ACTIONS = ACTIONS.length;
const I_IDLE = ACTIONS.indexOf('idle');
const I_WANDER = ACTIONS.indexOf('wander');
const I_EXPLORE = ACTIONS.indexOf('explore');
const I_FORAGE = ACTIONS.indexOf('forage');
const I_EAT = ACTIONS.indexOf('eat');
const I_REST = ACTIONS.indexOf('rest');
const I_FLEE = ACTIONS.indexOf('flee');
const I_ATTACK = ACTIONS.indexOf('attack');
const I_SHARE = ACTIONS.indexOf('share');
const I_MATE = ACTIONS.indexOf('mate');
const I_SOCIAL = ACTIONS.indexOf('socialize');
const I_HOME = ACTIONS.indexOf('gohome');
const I_DEPOSIT = ACTIONS.indexOf('deposit');
const I_WITHDRAW = ACTIONS.indexOf('withdraw');

const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
/** Escape-heading rotations tried by a fleeing agent: 0, ±30°, ±60°, ±90°. */
const FLEE_COS = new Float64Array(7);
const FLEE_SIN = new Float64Array(7);
for (let k = 0; k < 7; k++) {
  const ang = (k === 0 ? 0 : (k & 1 ? 1 : -1) * Math.ceil(k / 2)) * (Math.PI / 6);
  FLEE_COS[k] = Math.cos(ang);
  FLEE_SIN[k] = Math.sin(ang);
}

// ------------------------------------------------------------------ scratch (module-level, reused)
const near: Agent[] = [];
/** combatPower of near[i] when the pre-pass needed it (out-group adults), else NaN (computed on demand). */
const nearPow = new Float64Array(MAX_NEIGHBOURS * 2);
const aggressors: Agent[] = [];
const kids: Agent[] = [];
const U = new Float64Array(N_ACTIONS);
// conflict candidates (out-group agents I might pick a fight with), appraised after perception
const cands: Agent[] = [];
const candProx = new Float64Array(MAX_CANDS);
const candAff = new Float64Array(MAX_CANDS);
const candPow = new Float64Array(MAX_CANDS);
/** Ids of agents my friends are currently attacking (I may join in). */
const engaged = new Int32Array(8);
let engagedN = 0;
/** Adult combat power per tribe in view. */
const tallyId = new Int32Array(TALLY_MAX);
const tallyPow = new Float64Array(TALLY_MAX);
let tallyLen = 0;

/** Per-think perception results (reset at the start of every think). */
const P = {
  r: 1,
  myPow: 1,
  aggEff: 0,
  aggBias: 1,
  /** 0 (bold) .. 1 (timid): how strongly I avoid aggressive, stronger strangers. */
  timid: 0,
  skCombat: 0,
  hunger: 0,
  hp: 1,
  adult: true,
  /** Healthy enough to fight (actAttack breaks off below FIGHT_MIN_HP). */
  fit: true,
  matingReady: false,
  mateChecks: 0,
  surplus: 0,
  sawAttacker: false,
  /** My last attacker was among the neighbours (whether or not I still hold a grudge). */
  sawLast: false,
  attacked: false,
  /** Combat power and number of friendly adults within FIGHT_R. */
  allyPow: 0,
  allyN: 0,
  /** Agents within LOCAL_R (crowding for scarcity). */
  localN: 0,
  threat: null as Agent | null,
  threatW: 0,
  threatLevel: 0,
  escX: 0,
  escY: 0,
  avenge: null as Agent | null,
  avengeScore: 0,
  mate: null as Agent | null,
  mateScore: 0,
  needy: null as Agent | null,
  needyScore: 0,
  needyChild: false,
  needyKin: false,
  needyHunger: 0,
  friend: null as Agent | null,
  friendScore: 0,
  friendAff: 0,
  friendsNear: 0,
  cohX: 0,
  cohY: 0,
  cohN: 0,
};

function resetPercept(): void {
  P.mateChecks = 0;
  P.sawAttacker = false;
  P.sawLast = false;
  P.attacked = false;
  P.allyPow = 0;
  P.allyN = 0;
  P.localN = 0;
  cands.length = 0;
  engagedN = 0;
  tallyLen = 0;
  P.threat = null;
  P.threatW = 0;
  P.threatLevel = 0;
  P.escX = 0;
  P.escY = 0;
  P.avenge = null;
  P.avengeScore = 0;
  P.mate = null;
  P.mateScore = 0;
  P.needy = null;
  P.needyScore = 0;
  P.needyChild = false;
  P.needyKin = false;
  P.needyHunger = 0;
  P.friend = null;
  P.friendScore = 0;
  P.friendAff = 0;
  P.friendsNear = 0;
  P.cohX = 0;
  P.cohY = 0;
  P.cohN = 0;
  aggressors.length = 0;
  kids.length = 0;
}

// food candidates, best first (think only); the chosen one is copied to fX/fY/...
const fcX = new Float64Array(FOOD_CANDS);
const fcY = new Float64Array(FOOD_CANDS);
const fcFood = new Float64Array(FOOD_CANDS);
const fcScore = new Float64Array(FOOD_CANDS);
const fcDist = new Float64Array(FOOD_CANDS);
const fcMem = new Uint8Array(FOOD_CANDS);
let fcLen = 0;
/** Total food on the passable tiles of the local scan (scarcity). */
let localFood = 0;
// chosen food target (think only; also written by adjacentFood for act)
let fX = NaN;
let fY = NaN;
let fFood = 0;
let fScore = 0;
let fDist = 0;
let fFromMemory = false;
// explore target (think only)
let exX = NaN;
let exY = NaN;
// relationship lookup result
let relAff = 0;
let relKin: 0 | 1 | 2 = 0;

// ------------------------------------------------------------------ small helpers
function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v > lo ? (v < hi ? v : hi) : lo;
}

function pct(v: number): number {
  return Math.round(clamp01(v) * 100);
}

function hungerLabel(h: number): string {
  return h >= 0.8 ? 'Starving' : h >= 0.6 ? 'Very hungry' : h >= 0.35 ? 'Hungry' : h >= 0.15 ? 'Peckish' : 'Sated';
}

function terrainName(sim: Simulation, x: number, y: number): string {
  const t = sim.terrainAt(x, y);
  return t < 0 ? 'unknown' : TERRAIN_INFO[t as TerrainType].name.toLowerCase();
}

function compass(dx: number, dy: number): string {
  const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 7;
  return COMPASS[oct];
}

/** The agent's living tribe (undefined when tribeless / extinct / tribes disabled). */
function liveTribe(sim: Simulation, a: Agent): Tribe | undefined {
  if (a.tribeId === NONE || !sim.config.tribesEnabled) return undefined;
  const t = sim.getTribe(a.tribeId);
  return t && t.extinctTick === -1 && Number.isFinite(t.homeX) && Number.isFinite(t.homeY) ? t : undefined;
}

/** "the Varn-kin", but scenario names such as "The Wolf Pack" are used as they are. */
function theName(t: Tribe): string {
  return /^the\s/i.test(t.name) ? t.name : `the ${t.name}`;
}

function hungerOf(b: Agent): number {
  return clamp01(1 - b.food / (b.traits.maxFood > 0 ? b.traits.maxFood : 1));
}

/** Kinship from the parents arrays: 1 parent/child, 2 sibling (shares a parent), else 0. */
function kinFlag(a: Agent, b: Agent): 0 | 1 | 2 {
  if (b.parents[0] === a.id || b.parents[1] === a.id || a.parents[0] === b.id || a.parents[1] === b.id) return 1;
  const a0 = a.parents[0];
  const a1 = a.parents[1];
  if (a0 !== NONE && (a0 === b.parents[0] || a0 === b.parents[1])) return 2;
  if (a1 !== NONE && (a1 === b.parents[0] || a1 === b.parents[1])) return 2;
  return 0;
}

/** Sets relAff / relKin for a → b (allocation-free scan of a's relationships). */
function relationTo(a: Agent, b: Agent): void {
  relAff = 0;
  relKin = kinFlag(a, b);
  const rs = a.relationships;
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i];
    if (r.id === b.id) {
      relAff = Number.isFinite(r.affinity) ? r.affinity : 0;
      if (relKin === 0 && (r.kin === 1 || r.kin === 2)) relKin = r.kin;
      break;
    }
  }
}

// ------------------------------------------------------------------ memory
function rememberFood(a: Agent, x: number, y: number, value: number, tick: number): void {
  const mem = a.memory.food;
  for (let i = 0; i < mem.length; i++) {
    const m = mem[i];
    const dx = m.x - x;
    const dy = m.y - y;
    if (dx * dx + dy * dy < 24 * 24) {
      m.x = x;
      m.y = y;
      m.value = value;
      m.tick = tick;
      return;
    }
  }
  if (mem.length < LIMITS.foodMemory) {
    mem.push({ x, y, value, tick });
    return;
  }
  let wi = -1;
  let ws = Infinity;
  for (let i = 0; i < mem.length; i++) {
    const m = mem[i];
    const sc = m.value / (1 + (tick - m.tick) / 1500);
    if (sc < ws) {
      ws = sc;
      wi = i;
    }
  }
  if (wi >= 0 && value > ws) {
    const m = mem[wi];
    m.x = x;
    m.y = y;
    m.value = value;
    m.tick = tick;
  }
}

function forgetFoodNear(a: Agent, x: number, y: number): void {
  const mem = a.memory.food;
  let w = 0;
  for (let i = 0; i < mem.length; i++) {
    const m = mem[i];
    const dx = m.x - x;
    const dy = m.y - y;
    if (dx * dx + dy * dy < 16 * 16) continue;
    mem[w++] = m;
  }
  mem.length = w;
}

function rememberDanger(a: Agent, x: number, y: number, value: number, tick: number): void {
  const mem = a.memory.danger;
  for (let i = 0; i < mem.length; i++) {
    const m = mem[i];
    const dx = m.x - x;
    const dy = m.y - y;
    if (dx * dx + dy * dy < 40 * 40) {
      m.x = x;
      m.y = y;
      m.value = Math.max(value, m.value * 0.8);
      m.tick = tick;
      return;
    }
  }
  if (mem.length < LIMITS.dangerMemory) {
    mem.push({ x, y, value, tick });
    return;
  }
  let wi = 0;
  let ws = Infinity;
  for (let i = 0; i < mem.length; i++) {
    const m = mem[i];
    const sc = m.value * (1 - (tick - m.tick) / DANGER_MEMORY_TTL);
    if (sc < ws) {
      ws = sc;
      wi = i;
    }
  }
  const m = mem[wi];
  m.x = x;
  m.y = y;
  m.value = value;
  m.tick = tick;
}

/** Drop stale / invalid memories (in place, no allocation). */
function pruneMemory(a: Agent, tick: number): void {
  const food = a.memory.food;
  let w = 0;
  for (let i = 0; i < food.length; i++) {
    const m = food[i];
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || !(m.value >= 0.5) || tick - m.tick > FOOD_MEMORY_TTL) continue;
    food[w++] = m;
  }
  food.length = w;
  const dng = a.memory.danger;
  w = 0;
  for (let i = 0; i < dng.length; i++) {
    const m = dng[i];
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || !(m.value > 0) || tick - m.tick > DANGER_MEMORY_TTL) continue;
    dng[w++] = m;
  }
  dng.length = w;
}

/** Remembered danger at (x,y): 0 (safe) .. 1. */
function dangerAt(a: Agent, x: number, y: number, tick: number): number {
  const mem = a.memory.danger;
  let d = 0;
  for (let i = 0; i < mem.length; i++) {
    const m = mem[i];
    const dx = m.x - x;
    const dy = m.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist >= DANGER_RADIUS) continue;
    d += m.value * (1 - dist / DANGER_RADIUS) * clamp01(1 - (tick - m.tick) / DANGER_MEMORY_TTL);
  }
  return clamp01(d);
}

// ------------------------------------------------------------------ food choice
/** Offer a food target; the FOOD_CANDS best (food / distance, minus remembered danger) are kept, best first. */
function considerFood(a: Agent, x: number, y: number, food: number, bonus: number, fromMemory: boolean, tick: number): void {
  if (!(food >= 0.75) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const dx = x - a.x;
  const dy = y - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  let sc = (food * bonus) / (1 + d / 60);
  const worst = fcLen < FOOD_CANDS ? 0 : fcScore[FOOD_CANDS - 1];
  if (!(sc > worst)) return; // danger can only lower the score
  if (a.memory.danger.length) sc *= 1 - 0.8 * dangerAt(a, x, y, tick);
  if (!(sc > worst)) return;
  // the same tile can be offered twice (continuity target, scan, findFood, memory): keep the better offer
  for (let i = 0; i < fcLen; i++) {
    if (Math.abs(fcX[i] - x) < 0.5 && Math.abs(fcY[i] - y) < 0.5) {
      if (!(sc > fcScore[i])) return;
      for (let j = i; j < fcLen - 1; j++) moveFoodCand(j + 1, j);
      fcLen--;
      break;
    }
  }
  let i = fcLen < FOOD_CANDS ? fcLen++ : FOOD_CANDS - 1;
  while (i > 0 && fcScore[i - 1] < sc) {
    moveFoodCand(i - 1, i);
    i--;
  }
  fcX[i] = x;
  fcY[i] = y;
  fcFood[i] = food;
  fcScore[i] = sc;
  fcDist[i] = d;
  fcMem[i] = fromMemory ? 1 : 0;
}

function moveFoodCand(from: number, to: number): void {
  fcX[to] = fcX[from];
  fcY[to] = fcY[from];
  fcFood[to] = fcFood[from];
  fcScore[to] = fcScore[from];
  fcDist[to] = fcDist[from];
  fcMem[to] = fcMem[from];
}

/** How long (ticks) a migrant keeps heading for its chosen destination. */
export const TREK_TICKS = 1800;

/** Food reachable only by a detour (across a ford, around a lake) is worth this much of its straight-line score. */
const DETOUR_FOOD_FACTOR = 0.6;

/**
 * Choose the best food candidate (fX/fY/fFood/fScore/fDist/fFromMemory). Candidates that can be walked to in
 * a straight line win; only when none can does the agent settle for food it must detour to (across a river
 * at a ford, round a lake — steering plans the route), at a discount. Food that cannot be reached at all
 * (another island, walled off) is skipped. Returns false (fScore 0) when no candidate is reachable.
 */
function chooseFood(sim: Simulation, a: Agent): boolean {
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < fcLen; i++) {
      if (fcDist[i] > 12) {
        if (pass === 0 ? !clearPath(sim, a.x, a.y, fcX[i], fcY[i]) : !sameRegion(sim, a.x, a.y, fcX[i], fcY[i])) continue;
      }
      fX = fcX[i];
      fY = fcY[i];
      fFood = fcFood[i];
      fScore = pass === 0 ? fcScore[i] : fcScore[i] * DETOUR_FOOD_FACTOR;
      fDist = fcDist[i];
      fFromMemory = fcMem[i] === 1;
      return true;
    }
  }
  fX = NaN;
  fY = NaN;
  fFood = 0;
  fScore = 0;
  fDist = 0;
  fFromMemory = false;
  return false;
}

/** Cheap scan of the tiles around the agent: offers food targets (not the tile underfoot) and sums localFood. */
function scanLocalFood(sim: Simulation, a: Agent, tick: number): void {
  const w = sim.state.world;
  const ts = w.tileSize;
  const tx0 = Math.floor(a.x / ts);
  const ty0 = Math.floor(a.y / ts);
  const R = LOCAL_SCAN_TILES;
  for (let oy = -R; oy <= R; oy++) {
    const ty = ty0 + oy;
    if (ty < 0 || ty >= w.height) continue;
    for (let ox = -R; ox <= R; ox++) {
      const tx = tx0 + ox;
      if (tx < 0 || tx >= w.width) continue;
      const idx = ty * w.width + tx;
      const f = w.food[idx];
      if (!(f > 0)) continue;
      if (!TERRAIN_INFO[w.terrain[idx] as TerrainType].passable) continue;
      localFood += f;
      if (ox === 0 && oy === 0) continue;
      if (f >= 0.75) considerFood(a, (tx + 0.5) * ts, (ty + 0.5) * ts, f, 1, false, tick);
    }
  }
}

/** Best adjacent (3×3) tile with food, written to fX/fY; false when none. */
function adjacentFood(sim: Simulation, a: Agent): boolean {
  const w = sim.state.world;
  const ts = w.tileSize;
  const tx0 = Math.floor(a.x / ts);
  const ty0 = Math.floor(a.y / ts);
  let best = 0.5;
  let found = false;
  for (let oy = -1; oy <= 1; oy++) {
    const ty = ty0 + oy;
    if (ty < 0 || ty >= w.height) continue;
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      const tx = tx0 + ox;
      if (tx < 0 || tx >= w.width) continue;
      const idx = ty * w.width + tx;
      const f = w.food[idx];
      if (!(f > best) || !TERRAIN_INFO[w.terrain[idx] as TerrainType].passable) continue;
      best = f;
      fX = (tx + 0.5) * ts;
      fY = (ty + 0.5) * ts;
      found = true;
    }
  }
  return found;
}

// ------------------------------------------------------------------ perception
/** Keep b as a conflict candidate (the MAX_CANDS nearest are kept). */
function addCandidate(b: Agent, prox: number, aff: number, powB: number): void {
  let k = cands.length;
  if (k >= MAX_CANDS) {
    let far = 0;
    for (let i = 1; i < MAX_CANDS; i++) if (candProx[i] < candProx[far]) far = i;
    if (!(prox > candProx[far])) return;
    k = far;
    cands[k] = b;
  } else cands.push(b);
  candProx[k] = prox;
  candAff[k] = aff;
  candPow[k] = powB;
}

function perceive(sim: Simulation, a: Agent, b: Agent, pw: number): void {
  if (!b.alive || b === a) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const prox = clamp01(1 - d / P.r);
  relationTo(a, b);
  const kin = relKin;
  const aff = relAff;
  const attackingMe = b.action === 'attack' && b.targetId === a.id;
  // My last attacker stays an enemy while it keeps attacking me or while the wound still rankles
  // (personal affinity, which decays). lastAttackerId itself is never cleared, so on its own it would
  // turn a long-reconciled tribe-mate into a permanent target.
  if (b.id === a.lastAttackerId) P.sawLast = true;
  const grudge = b.id === a.lastAttackerId && (attackingMe || aff < -0.1);
  if (grudge) P.sawAttacker = true;
  const friendly = !attackingMe && (kin > 0 || aff > 0.3 || isFriendly(sim, a, b));
  const bAdult = isAdult(b);

  if (!friendly || grudge) {
    const powB = pw > 0 ? pw : combatPower(b);
    const ratio = powB / P.myPow;
    const hostile = attackingMe || grudge || isHostile(sim, a, b);
    if ((hostile || (b.action === 'attack' && b.targetId !== NONE)) && aggressors.length < 8) aggressors.push(b);
    // ratio below which I stand my ground when attacked
    const brave = 0.8 + 0.6 * Math.min(1.5, P.aggEff) + 0.3 * P.skCombat - 0.7 * (1 - P.hp);
    // fight back against whoever is attacking me — or a fresh enemy (deep grudge) close by
    if ((attackingMe || (grudge && aff < SOCIAL_TUNING.grudge && prox > 0.5)) && P.adult && P.fit && ratio < brave) {
      const sc = (attackingMe ? 1.5 : 0.8) * (0.5 + 0.5 * prox) * (brave - ratio + 0.2);
      if (sc > P.avengeScore) {
        P.avengeScore = sc;
        P.avenge = b;
      }
      if (attackingMe) P.attacked = true;
    } else {
      let w = 0;
      const bAgg = clamp(b.traits.aggression * P.aggBias, 0, 2);
      if (attackingMe || (!P.adult && hostile && prox > 0.3)) {
        w = clamp(ratio, 0.3, 3) * (0.25 + 0.75 * prox) * (attackingMe ? 1.6 : 1);
      } else if (hostile && ratio > Math.max(1.1, brave - 0.2) && prox > 0.45) {
        // a clearly stronger enemy (war, feud, old attacker) close by: keep away — more so the fiercer it
        // is; bold agents only give way to enemies well above their own strength
        w = clamp(ratio, 0.3, 3) * prox * (0.4 + 0.6 * Math.min(1, bAgg)) * (b.action === 'attack' ? 1.3 : 1);
      } else if (P.timid > 0 && prox > 0.5 && kin === 0) {
        // timid agents give aggressive, stronger strangers a wide berth (wider while they are fighting)
        const menace = bAgg * ratio * (b.action === 'attack' ? 1.5 : 1);
        if (menace > 0.7 + 0.8 * (1 - P.timid)) w = clamp(ratio, 0.3, 3) * prox * 0.4 * P.timid;
      }
      if (w > 0) {
        P.threatLevel += w;
        if (d > 1e-6) {
          P.escX -= (dx / d) * w;
          P.escY -= (dy / d) * w;
        }
        if (w > P.threatW) {
          P.threatW = w;
          P.threat = b;
        }
        if (attackingMe) P.attacked = true;
      }
    }
    // a fight I might start: appraised once perception (allies, bands, scarcity) is complete
    if (!friendly && P.adult && !attackingMe && kin === 0) addCandidate(b, prox, aff, powB);
  }

  if (friendly) {
    P.cohX += b.x;
    P.cohY += b.y;
    P.cohN++;
    if (d < 40) P.friendsNear++;
    if (bAdult && d < FIGHT_R && b.action !== 'flee') {
      P.allyPow += pw > 0 ? pw : combatPower(b);
      P.allyN++;
    }
    if (b.action === 'attack' && b.targetId !== NONE && b.targetId !== a.id && engagedN < engaged.length) engaged[engagedN++] = b.targetId;
    const myChild = kin === 1 && (b.parents[0] === a.id || b.parents[1] === a.id);
    if (myChild && !bAdult && kids.length < 4) kids.push(b);
    // needy friend / kin / own child (I share when I have surplus — and am not hungry myself, otherwise
    // two hungry carriers would just swap their loads back and forth)
    if (P.surplus >= 4) {
      const bh = hungerOf(b);
      const juvenileChild = myChild && !bAdult;
      const canGive = P.hunger <= (juvenileChild ? 0.6 : 0.45) && bh > P.hunger + 0.15;
      if (canGive && (juvenileChild ? bh > 0.35 : kin > 0 ? bh > 0.55 : bh > 0.65 && P.surplus >= 8)) {
        const kinF = juvenileChild ? 2.2 : kin > 0 ? 1.5 : 1;
        const sc = bh * kinF * (0.6 + 0.4 * prox);
        if (sc > P.needyScore) {
          P.needyScore = sc;
          P.needy = b;
          P.needyChild = juvenileChild;
          P.needyKin = kin > 0;
          P.needyHunger = bh;
        }
      }
    }
    // company
    if (b.action !== 'flee' && b.action !== 'attack') {
      const calm = b.action === 'socialize' || b.action === 'idle' || b.action === 'rest' ? 1.2 : 1;
      const sc = (0.5 + 0.5 * prox) * (1 + Math.max(-0.5, aff) + (kin > 0 ? 0.3 : 0)) * calm;
      if (sc > P.friendScore) {
        P.friendScore = sc;
        P.friend = b;
        P.friendAff = aff;
      }
    }
  }

  // potential mate (mutual compatibility)
  if (P.matingReady && P.mateChecks < MAX_MATE_CHECKS && bAdult && kin === 0 && !attackingMe && !grudge && b.reproCooldown <= 0) {
    P.mateChecks++;
    if (canMate(sim, a, b) && canMate(sim, b, a)) {
      const sc =
        0.5 + 0.5 * prox + 0.3 * aff + (a.tribeId !== NONE && a.tribeId === b.tribeId ? 0.2 : 0) + (b.action === 'mate' && b.targetId === a.id ? 0.5 : 0);
      if (sc > P.mateScore) {
        P.mateScore = sc;
        P.mate = b;
      }
    }
  }
}

// ------------------------------------------------------------------ walking distance to a camp (raids)
/**
 * Walking-distance fields toward tribe camps, used to value raids by the route a raiding party would walk (across
 * a ford, round a lake) instead of the straight line. A field is a Dijkstra search over the tile grid from the
 * camp's tile with the route planner's step costs (step length × the mean time cost 1/moveCost of the two tiles,
 * no corner cutting), in world units at the pace of open grass, so shallows and mountain passes count as the
 * extra walking they are. Unreachable tiles, and tiles beyond WALK_FIELD_MAX, read Infinity.
 * Derived data: cached per simulation and never saved. A field depends only on the camp's tile and the terrain
 * (world.terrainVersion), so a loaded run computes exactly the same values.
 */
interface WalkField {
  tile: number;
  tv: number;
  dist: Float32Array;
}
const WALK_FIELD_MAX = RAID_RANGE * 1.1;
const walkFields = new WeakMap<Simulation, Map<number, WalkField>>();
// search scratch, shared by every field (a field is computed in one synchronous call)
let wfCost = new Float32Array(0);
let wfDist = new Float64Array(0);
let wfHeapNode = new Int32Array(0);
let wfHeapKey = new Float64Array(0);
const WF_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const WF_DY = [0, 0, 1, -1, 1, -1, 1, -1];
const WF_LEN = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

function computeWalkField(sim: Simulation, src: number, out: Float32Array): void {
  const w = sim.state.world;
  const W = w.width;
  const H = w.height;
  const N = W * H;
  const ts = w.tileSize;
  if (wfCost.length !== N) {
    wfCost = new Float32Array(N);
    wfDist = new Float64Array(N);
  }
  const cost = wfCost;
  const dist = wfDist;
  const terr = w.terrain;
  for (let i = 0; i < N; i++) {
    const info = TERRAIN_INFO[terr[i] as TerrainType];
    cost[i] = info !== undefined && info.passable && info.moveCost > 0 ? 1 / info.moveCost : 0;
  }
  dist.fill(Infinity);
  out.fill(Infinity);
  if (src < 0 || src >= N || cost[src] === 0) return;
  const capacity = 8 * N + 16;
  if (wfHeapNode.length < capacity) {
    wfHeapNode = new Int32Array(capacity);
    wfHeapKey = new Float64Array(capacity);
  }
  const hn = wfHeapNode;
  const hk = wfHeapKey;
  let len = 0;
  const limit = WALK_FIELD_MAX / ts; // tile units
  dist[src] = 0;
  hn[0] = src;
  hk[0] = 0;
  len = 1;
  while (len > 0) {
    // pop the minimum
    const node = hn[0];
    const key = hk[0];
    len--;
    if (len > 0) {
      const ln = hn[len];
      const lk = hk[len];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= len) break;
        const r = l + 1;
        const c = r < len && hk[r] < hk[l] ? r : l;
        if (!(hk[c] < lk)) break;
        hn[i] = hn[c];
        hk[i] = hk[c];
        i = c;
      }
      hn[i] = ln;
      hk[i] = lk;
    }
    if (key > dist[node]) continue; // stale entry
    if (key > limit) break;
    const cx = node % W;
    const cy = (node - cx) / W;
    const cc = cost[node];
    for (let k = 0; k < 8; k++) {
      const nx = cx + WF_DX[k];
      const ny = cy + WF_DY[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const nb = ny * W + nx;
      const nc = cost[nb];
      if (nc === 0) continue;
      if (k >= 4 && (cost[cy * W + nx] === 0 || cost[ny * W + cx] === 0)) continue; // no corner cutting
      const nd = key + WF_LEN[k] * 0.5 * (cc + nc);
      if (!(nd < dist[nb])) continue;
      dist[nb] = nd;
      // push
      let i = len++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!(nd < hk[p])) break;
        hn[i] = hn[p];
        hk[i] = hk[p];
        i = p;
      }
      hn[i] = nb;
      hk[i] = nd;
    }
  }
  for (let i = 0; i < N; i++) {
    const d = dist[i];
    if (d <= limit) out[i] = d * ts;
  }
}

/** Walking distance (world units) from (x,y) to the camp of tribe t by the best route; Infinity when out of reach. */
function walkDistance(sim: Simulation, t: Tribe, x: number, y: number): number {
  const at = sim.tileIndex(x, y);
  if (at < 0) return Infinity;
  const w = sim.state.world;
  const N = w.width * w.height;
  const tile = sim.tileIndex(t.homeX, t.homeY);
  const tv = w.terrainVersion;
  let byTribe = walkFields.get(sim);
  if (!byTribe) {
    byTribe = new Map();
    walkFields.set(sim, byTribe);
  }
  let f = byTribe.get(t.id);
  if (!f || f.tile !== tile || f.tv !== tv || f.dist.length !== N) {
    if (!f) {
      if (byTribe.size >= 32) byTribe.clear(); // old camps of extinct tribes: recomputed on demand if ever needed
      f = { tile, tv, dist: new Float32Array(N) };
      byTribe.set(t.id, f);
    } else if (f.dist.length !== N) f.dist = new Float32Array(N);
    f.tile = tile;
    f.tv = tv;
    computeWalkField(sim, tile, f.dist);
  }
  return f.dist[at];
}

// ------------------------------------------------------------------ explore target
/** True when (x,y) lies in an active meteor zone, or a plague zone this agent could still catch (as in think()). */
function inDangerZone(sim: Simulation, a: Agent, x: number, y: number): boolean {
  const ds = sim.state.disasters;
  for (let i = 0; i < ds.length; i++) {
    const d = ds[i];
    if (!d.active || !(d.radius > 0)) continue;
    if (d.kind !== 'meteor' && d.kind !== 'plague') continue;
    if (d.kind === 'plague' && (a.infection > 0 || a.immuneTicks > 0)) continue;
    const dx = x - d.x;
    const dy = y - d.y;
    const R = d.radius * 1.15 + 10;
    if (dx * dx + dy * dy < R * R) return true;
  }
  return false;
}

/**
 * How lush the land around (x,y) looks: mean standing food over ±4 tiles (every 2nd tile, 25 reads) relative
 * to a well-stocked grassland tile, 0 (bare) .. 1 (lush), up to 1.5 for forest. Absolute food, not the
 * fraction of capacity, so full shallows or rock (tiny capacity) do not look like good land.
 */
function lushness(sim: Simulation, x: number, y: number): number {
  const w = sim.state.world;
  const ts = w.tileSize;
  const tx0 = Math.floor(x / ts);
  const ty0 = Math.floor(y / ts);
  let sum = 0;
  let n = 0;
  for (let oy = -4; oy <= 4; oy += 2) {
    const ty = ty0 + oy;
    if (ty < 0 || ty >= w.height) continue;
    for (let ox = -4; ox <= 4; ox += 2) {
      const tx = tx0 + ox;
      if (tx < 0 || tx >= w.width) continue;
      sum += w.food[ty * w.width + tx];
      n++;
    }
  }
  const ref = 8 * (sim.config.foodCapacity > 0 ? sim.config.foodCapacity : 1);
  const v = n > 0 ? sum / n / ref : 0;
  return v > 1.5 ? 1.5 : v > 0 ? v : 0;
}

/**
 * Pick somewhere to explore. Land that looks lush from afar is attractive — green forest across a river is
 * visible long before its food is in perception range — mildly for any scout and strongly for the hungry,
 * whose search also widens (up to ~2.2× the normal range). So a starving band whose own bank is bare heads
 * for the far bank, and steering plans the route across a ford. Unreachable places are skipped.
 */
function pickExploreTarget(sim: Simulation, a: Agent, tribe: Tribe | undefined, soc: number, tick: number, migrate = 0): boolean {
  const margin = sim.state.world.tileSize * 2;
  const W = sim.worldW;
  const H = sim.worldH;
  const hunger = hungerOf(a);
  const need = hunger > 0.3 ? (hunger - 0.3) / 0.7 : 0; // 0 when fed, 1 when starving
  // migrants (hungry on land grazed bare) search up to ~3× farther for somewhere worth moving to
  const reach = (120 + 0.8 * a.traits.perception) * (1 + 1.2 * need) * (1 + migrate);
  const tries = migrate > 0.2 ? 10 : need > 0 ? 8 : 6;
  let best = -Infinity;
  exX = NaN;
  exY = NaN;
  for (let k = 0; k < tries; k++) {
    const ang = sim.rng.next() * Math.PI * 2;
    const dist = reach * (0.6 + 0.9 * sim.rng.next());
    const jitter = sim.rng.next();
    const tx = clamp(a.x + Math.cos(ang) * dist, margin, W - margin);
    const ty = clamp(a.y + Math.sin(ang) * dist, margin, H - margin);
    if (!sim.passableAt(tx, ty)) continue;
    let sc = jitter * 0.4;
    const mem = a.memory.food;
    for (let i = 0; i < mem.length; i++) {
      const ddx = mem[i].x - tx;
      const ddy = mem[i].y - ty;
      sc += Math.min(1, Math.sqrt(ddx * ddx + ddy * ddy) / 300) * 0.2; // novelty
    }
    if (tribe) {
      const hx = tribe.homeX - tx;
      const hy = tribe.homeY - ty;
      const dh = Math.sqrt(hx * hx + hy * hy);
      // the pull of home weakens for migrants: a whole band can move on when its land is spent
      sc += (1 - soc) * Math.min(1, dh / 500) * 0.5 - ((1 - 0.8 * migrate) * soc * Math.max(0, dh - 350)) / 400;
    }
    sc -= dangerAt(a, tx, ty, tick) * 2;
    if (inDangerZone(sim, a, tx, ty)) sc -= 2; // a plague or meteor zone is no place to go
    // lush-looking land (the standing food around the spot, coarsely sampled) draws the eye — mildly for a
    // scout, strongly for the hungry
    sc += (0.25 + 1.4 * need + 1.5 * migrate) * lushness(sim, tx, ty);
    if (sc > best && !clearPath(sim, a.x, a.y, tx, ty)) {
      // across water / walls: reachable by a route (a ford, a way round) at the cost of the detour; skip
      // places that cannot be reached at all
      if (!sameRegion(sim, a.x, a.y, tx, ty)) continue;
      sc -= 0.35;
    }
    if (sc > best) {
      best = sc;
      exX = tx;
      exY = ty;
    }
  }
  return best > -Infinity;
}

/**
 * Whether the target of action k (as chosen by this think) can be reached. Places (the camp, an enemy camp
 * to raid) only need to be reachable at all — steering plans a route across fords and round obstacles.
 * Other agents must be reachable in a straight line: they move, and a long detour would never catch them.
 * Food targets are already filtered by chooseFood; flee picks open ground itself; the rest move in place.
 */
function targetReachable(sim: Simulation, a: Agent, k: number, tribe: Tribe | undefined, attackTarget: Agent | null, raid: Tribe | null): boolean {
  let x = NaN;
  let y = NaN;
  let other: Agent | null = null;
  if (k === I_ATTACK) other = attackTarget;
  else if (k === I_SHARE) other = P.needy;
  else if (k === I_MATE) other = P.mate;
  else if (k === I_SOCIAL) other = P.friend;
  else if ((k === I_HOME || k === I_DEPOSIT || k === I_WITHDRAW) && tribe) {
    x = tribe.homeX;
    y = tribe.homeY;
  } else if (k === I_EXPLORE && raid) {
    x = raid.homeX;
    y = raid.homeY;
  } else return true;
  if (other) {
    x = other.x;
    y = other.y;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
  const dx = x - a.x;
  const dy = y - a.y;
  if (dx * dx + dy * dy < 16 * 16) return true;
  if (clearPath(sim, a.x, a.y, x, y)) return true;
  return !other && sameRegion(sim, a.x, a.y, x, y);
}

// ------------------------------------------------------------------ think
/** Perceive + choose an action (utility AI). Sets action/target/utilities/thought/decisionCooldown. */
export function think(sim: Simulation, a: Agent): void {
  if (!a.alive) return;
  const s = sim.state;
  const cfg = s.config;
  const env = s.env;
  const tick = s.tick;
  const tr = a.traits;
  const rng = sim.rng;

  // ---- needs & state
  const maxFood = tr.maxFood > 0 ? tr.maxFood : 1;
  const hunger = hungerOf(a);
  const fatigue = clamp01(1 - a.energy);
  const hp = clamp01(a.health / (tr.maxHealth > 0 ? tr.maxHealth : 1));
  const sick = a.infection > 0 ? clamp01(0.35 + 0.65 * (a.virulence || 0)) : 0;
  const daylight = cfg.dayNight ? clamp01(env.daylight) : 1;
  const night = 1 - daylight;
  const winter = cfg.seasons && env.season === 3 ? 1 : 0;
  // local cold snaps count too (lifecycle charges cold stress with the same temperatureAt)
  const cold = clamp01((8 - temperatureAt(sim, a.x, a.y)) / 18);
  const chill = Math.max(winter, cold);
  const adult = isAdult(a);
  const aggBias = Number.isFinite(cfg.aggressionBias) ? clamp(cfg.aggressionBias, 0, 3) : 1;
  const aggEff = clamp(tr.aggression * aggBias, 0, 2);
  const altEff = clamp(tr.altruism * cfg.cooperationBias, 0, 2);
  const fertEff = clamp(tr.fertility * cfg.reproductionRate, 0, 2);
  const soc = clamp01(tr.sociability);
  const skForage = clamp01(a.skills.forage);
  const skCombat = clamp01(a.skills.combat);
  const skSocial = clamp01(a.skills.social);
  const role = a.role;
  const tribe = liveTribe(sim, a);
  const cap = carryCapacity(a);
  const percR = Math.max(8, tr.perception * (cfg.dayNight ? 0.55 + 0.45 * daylight : 1));
  if (!a.utilities) a.utilities = {};

  pruneMemory(a, tick);

  // ---- perception of other agents
  resetPercept();
  P.myPow = combatPower(a);
  P.aggEff = aggEff;
  P.aggBias = aggBias;
  P.timid = clamp01(1 - 1.4 * aggEff);
  P.skCombat = skCombat;
  P.hunger = hunger;
  P.hp = hp;
  P.adult = adult;
  // the same test as actAttack's break-off: an agent too hurt to fight treats its attacker as a threat
  // (choosing 'attack' here would be cancelled by act every tick, freezing the agent mid-fight)
  const fit = !(a.health < tr.maxHealth * FIGHT_MIN_HP);
  P.fit = fit;
  P.surplus = a.carried + Math.max(0, a.food - maxFood * 0.55);
  P.matingReady =
    adult && a.reproCooldown <= 0 && hunger < 0.6 && a.energy > 0.28 && hp > 0.35 && fertEff > 0.02 && sim.canSpawn();
  let r = percR;
  let n = sim.spatial.query(a.x, a.y, r, near, a).length;
  if (n > MAX_NEIGHBOURS) {
    r = percR * Math.sqrt(MAX_NEIGHBOURS / n);
    n = sim.spatial.query(a.x, a.y, r, near, a).length;
    if (n > MAX_NEIGHBOURS * 2) n = MAX_NEIGHBOURS * 2;
  }
  P.r = r;
  // pre-pass: local crowding, and the adult strength of every other band (tribe) in view
  for (let i = 0; i < n; i++) {
    const b = near[i];
    nearPow[i] = NaN;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx * dx + dy * dy < LOCAL_R * LOCAL_R) P.localN++;
    if (b.tribeId === NONE || b.tribeId === a.tribeId || b.action === 'flee' || !isAdult(b)) continue;
    const pw = combatPower(b);
    nearPow[i] = pw;
    let k = 0;
    while (k < tallyLen && tallyId[k] !== b.tribeId) k++;
    if (k === tallyLen) {
      if (tallyLen >= TALLY_MAX) continue;
      tallyId[k] = b.tribeId;
      tallyPow[k] = 0;
      tallyLen++;
    }
    tallyPow[k] += pw;
  }
  for (let i = 0; i < n; i++) perceive(sim, a, near[i], nearPow[i]);
  if (!P.sawLast && a.lastAttackerId !== NONE) {
    const atk = sim.getAgent(a.lastAttackerId);
    if (atk) {
      const dx = atk.x - a.x;
      const dy = atk.y - a.y;
      if (dx * dx + dy * dy <= percR * percR) perceive(sim, a, atk, combatPower(atk));
    }
  }

  // ---- protect own children / friends under attack
  let defend: Agent | null = null;
  let defended: Agent | null = null;
  let defendScore = 0;
  let defendChild = false;
  if (adult && fit) {
    for (let i = 0; i < aggressors.length; i++) {
      const h = aggressors[i];
      const ratio = combatPower(h) / P.myPow;
      if (ratio > 1.3 + 0.5 * Math.min(1.5, aggEff) + 0.3 * Math.min(1, altEff)) continue; // too strong to take on
      let victim: Agent | null = null;
      let isChild = false;
      if (h.action === 'attack' && h.targetId !== a.id) {
        const v = sim.getAgent(h.targetId);
        if (v && v !== a) {
          isChild = kids.indexOf(v) >= 0;
          if (isChild || kinFlag(a, v) > 0 || isFriendly(sim, a, v)) victim = v;
        }
      }
      if (!victim) {
        // hostile lurking near one of my juvenile children
        for (let k = 0; k < kids.length; k++) {
          const c = kids[k];
          const ddx = c.x - h.x;
          const ddy = c.y - h.y;
          if (ddx * ddx + ddy * ddy < 45 * 45 && combatPower(h) > combatPower(c)) {
            victim = c;
            isChild = true;
            break;
          }
        }
        if (victim && !isHostile(sim, h, victim) && !(h.action === 'attack' && h.targetId === victim.id)) victim = null;
      }
      if (!victim) continue;
      const sc = (isChild ? 2 : 1) * (1.5 - 0.5 * ratio);
      if (sc > defendScore) {
        defendScore = sc;
        defend = h;
        defended = victim;
        defendChild = isChild;
      }
    }
  }

  // ---- active disasters (meteor strike zones, plague areas)
  let zoneDanger = 0;
  let zEscX = 0;
  let zEscY = 0;
  let zoneKind = '';
  const ds = s.disasters;
  for (let i = 0; i < ds.length; i++) {
    const d = ds[i];
    if (!d.active || !(d.radius > 0)) continue;
    if (d.kind !== 'meteor' && d.kind !== 'plague') continue;
    if (d.kind === 'plague' && (a.infection > 0 || a.immuneTicks > 0)) continue;
    const dx = a.x - d.x;
    const dy = a.y - d.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const R = d.radius * 1.15 + 10;
    if (!(dist < R)) continue;
    const lvl = clamp01(d.intensity) * (1 - dist / R) * (d.kind === 'meteor' ? 1.2 : 0.8);
    zoneDanger += lvl;
    if (dist > 1e-6) {
      zEscX += (dx / dist) * lvl;
      zEscY += (dy / dist) * lvl;
    } else zEscX += lvl;
    if (lvl > 0.2) rememberDanger(a, d.x, d.y, clamp01(d.intensity), tick);
    zoneKind = d.kind;
  }
  zoneDanger = clamp01(zoneDanger);

  // ---- fear (smoothed)
  const threatNow = clamp01(P.threatLevel / 1.2);
  const prevFear = Number.isFinite(a.fear) ? (a.fear as number) : 0;
  const fear = clamp01(prevFear * 0.5 + Math.max(threatNow, zoneDanger) * 0.5 + (P.attacked ? 0.15 : 0));
  a.fear = fear;
  if (P.threat && threatNow > 0.25) rememberDanger(a, P.threat.x, P.threat.y, threatNow, tick);
  else if (P.attacked) rememberDanger(a, a.x, a.y, 0.6, tick);
  const dangerHere = dangerAt(a, a.x, a.y, tick);

  // ---- food perception
  const hereFood = foodAt(sim, a.x, a.y);
  const hereIdx = sim.tileIndex(a.x, a.y);
  const stockLow = tribe ? tribe.stockpile < Math.max(30, tribe.members * 5) : false;
  // free room in the camp store: nobody gathers for (or tries to deposit into) a full stockpile
  const storeRoom = tribe ? stockpileCapacity(tribe) - Math.max(0, tribe.stockpile) : 0;
  const gatherDrive =
    tribe && adult && hunger < 0.3 && a.carried < cap * 0.9 && storeRoom > cap * 0.5
      ? (0.06 + 0.16 * skForage + 0.12 * Math.min(1, altEff) * (stockLow ? 1 : 0.35) + 0.06 * soc + (role === 'forager' ? 0.1 : 0)) *
        (1 - 0.6 * night)
      : 0;
  const wantFood = hunger > 0.12 || gatherDrive > 0;
  fcLen = 0;
  localFood = 0;
  // continuity: keep heading to the current forage target while it still has food
  if (a.action === 'forage' && Number.isFinite(a.targetX) && Number.isFinite(a.targetY) && sim.tileIndex(a.targetX, a.targetY) !== hereIdx) {
    considerFood(a, a.targetX, a.targetY, foodAt(sim, a.targetX, a.targetY), 1.3, false, tick);
  }
  scanLocalFood(sim, a, tick);
  if (wantFood || a.memory.food.length < 2 || (tick + a.id) % 4 === 0) {
    const spot = findFood(sim, a.x, a.y, percR);
    if (spot && Number.isFinite(spot.x) && Number.isFinite(spot.y)) {
      const si = sim.tileIndex(spot.x, spot.y);
      if (si !== hereIdx) considerFood(a, spot.x, spot.y, spot.food, 1, false, tick);
      if (si >= 0 && spot.food >= Math.max(3, 0.45 * tileCapacity(sim, si))) rememberFood(a, spot.x, spot.y, spot.food, tick);
    }
  }
  {
    const mem = a.memory.food;
    let w = 0;
    for (let i = 0; i < mem.length; i++) {
      const m = mem[i];
      const dx = m.x - a.x;
      const dy = m.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < percR * percR) {
        // visible: verify / refresh, forget when depleted
        const actual = foodAt(sim, m.x, m.y);
        if (actual < 1) continue;
        m.value = actual;
        m.tick = tick;
        if (sim.tileIndex(m.x, m.y) !== hereIdx) considerFood(a, m.x, m.y, actual, 1, true, tick);
      } else {
        considerFood(a, m.x, m.y, m.value * Math.max(0.2, 1 - (tick - m.tick) / FOOD_MEMORY_TTL) * 0.85, 1, true, tick);
      }
      mem[w++] = m;
    }
    mem.length = w;
  }
  const haveFoodTarget = chooseFood(sim, a);
  let migrateDrive = 0;
  // scarcity: food within the local scan per head of everyone around (0 plenty .. 1 nothing to go round)
  const scarcity = clamp01(1 - localFood / (1 + P.localN) / SCARCE_PER_HEAD);

  // ---- tribe camp
  let campDist = 0;
  if (tribe) {
    const dx = tribe.homeX - a.x;
    const dy = tribe.homeY - a.y;
    campDist = Math.sqrt(dx * dx + dy * dy);
  }

  // ---- juveniles keep close to their mother
  let mother: Agent | undefined;
  let motherDist = 0;
  if (!adult) {
    mother = sim.getAgent(a.parents[0]) ?? sim.getAgent(a.parents[1]);
    if (mother) {
      const dx = mother.x - a.x;
      const dy = mother.y - a.y;
      motherDist = Math.sqrt(dx * dx + dy * dy);
    }
  }

  // ================================================================ utilities
  const hungerDrive = Math.pow(hunger, 1.4) * 1.25 + (hunger > 0.75 ? (hunger - 0.75) * 2 : 0);
  const foodDrive = hungerDrive * (1 + 0.25 * skForage) * (0.75 + 0.25 * clamp(tr.efficiency, 0.3, 1.5));
  U.fill(0);

  // ---- conflict appraisal: which out-group agent (if any) is worth a fight, and why
  let rival: Agent | null = null;
  let rivalScore = 0;
  let rivalWhy = 0; // 3 war / feud, 4 rob / hunt, 5 territory, 6 contest a patch, 7 join a friend's fight
  if (adult && fit && cands.length) {
    // the odds I accept: bold, skilled, healthy agents take on more — and the starving grow desperate
    const boldness =
      0.7 + 0.45 * Math.min(1.5, aggEff) + 0.25 * skCombat + (role === 'warrior' ? 0.1 : 0) - 0.6 * (1 - hp) + 0.5 * Math.max(0, hunger - 0.6);
    // odds below which I expect to win outright (and so also take stomach food, not just a carried load)
    const decisive = 0.55 + 0.35 * hunger;
    // allies close by may join in (they do not strike automatically, so they count partly)
    const myBack = P.myPow + 0.3 * Math.min(P.allyPow, 3 * P.myPow);
    const room = Math.max(0, cap - a.carried) + Math.max(0, maxFood - a.food);
    const land = s.world.territory;
    const myTid = tribe ? tribe.id : NONE;
    const tribeNeed = Math.max(scarcity, stockLow ? 0.5 : 0);
    for (let k = 0; k < cands.length; k++) {
      const b = cands[k];
      if (!b.alive) continue;
      const powB = candPow[k];
      const bAdult = isAdult(b);
      // the defender's tribe-mates in view back it up (social.attack: nearby mates strike the attacker)
      let band = 0;
      if (b.tribeId !== NONE) {
        for (let j = 0; j < tallyLen; j++) {
          if (tallyId[j] === b.tribeId) {
            band = tallyPow[j];
            break;
          }
        }
      }
      const backers = Math.max(0, band - (bAdult && b.action !== 'flee' ? powB : 0));
      const odds = (powB + 0.3 * Math.min(backers, 3 * powB)) / myBack;
      const fav = clamp01((boldness - odds) * 2 + 0.5);
      if (!(fav > 0)) continue;
      const rel = tribe && b.tribeId !== NONE && b.tribeId !== myTid ? (tribe.relations[b.tribeId] ?? 0) : 0;
      // how readily I prey on b's people: friendly tribes much less, enemies more — and those who look
      // like my own kind (similar genomes: kindred bands, the same species) less than strangers
      const relF = clamp(1 - 1.2 * rel, 0.2, 1.6);
      const kinF = 1 - 0.6 * clamp01(1 - geneticDistance(a.genes, b.genes) / ALIKE_DIST);
      // 1. food: rob its load (a decisive win also yields stomach food), or drive it off a patch I need
      let food = 0;
      let foodWhy = 4;
      if (hunger > 0.2) {
        const stealable = Math.max(0, b.carried) + (odds < decisive ? 0.45 * b.food : 0);
        const lootQ = clamp01(Math.min(stealable, room) / 15) * (bAdult ? 1 : 0.5);
        let patchQ = 0;
        if (scarcity > 0.05 && (b.action === 'eat' || b.action === 'forage')) patchQ = clamp01(foodAt(sim, b.x, b.y) / 6) * scarcity;
        food = foodDrive * Math.max(lootQ, patchQ) * relF;
        if (patchQ > lootQ) foodWhy = 6;
      }
      // 2. territory: an outsider using my tribe's land near our camp
      let turf = 0;
      if (tribe && b.tribeId !== myTid && rel < SOCIAL_TUNING.allyFriendly) {
        const cx = b.x - tribe.homeX;
        const cy = b.y - tribe.homeY;
        const dc = Math.sqrt(cx * cx + cy * cy);
        if (dc < TERRITORY_R) {
          const ti = sim.tileIndex(b.x, b.y);
          if (ti >= 0 && land[ti] === myTid) {
            const use = b.action === 'eat' || b.action === 'forage' || b.carried > 2 ? 1 : 0.35;
            turf = 0.45 * (1 - dc / TERRITORY_R) * use * (0.6 * (1 - Math.max(0, rel)) + 0.8 * Math.max(0, -rel) + 0.6 * tribeNeed);
          }
        }
      }
      // 3. tribal war or a personal feud
      let feud = rel < SOCIAL_TUNING.warHostile ? 0.35 * clamp01((-rel - 0.25) / 0.5) : 0;
      if (candAff[k] < SOCIAL_TUNING.grudge) feud = Math.max(feud, 0.35 * clamp01((-candAff[k] - 0.3) / 0.5));
      // 4. pile in when a friend is already fighting it
      let assist = 0;
      for (let j = 0; j < engagedN; j++) {
        if (engaged[j] === b.id) {
          assist = 0.2 + 0.15 * Math.min(1.5, aggEff);
          break;
        }
      }
      // an enemy that is running away has been dealt with — only a robber keeps chasing a load
      const running = b.action === 'flee' ? 0.35 : 1;
      const motive = (food + (turf + feud) * running) * kinF + assist * running;
      if (!(motive > 0)) continue;
      const sc = motive * fav * (0.5 + 0.5 * candProx[k]);
      if (sc > rivalScore) {
        rivalScore = sc;
        rival = b;
        rivalWhy = feud >= food && feud >= turf && feud >= assist ? 3 : assist >= food && assist >= turf ? 7 : turf >= food ? 5 : foodWhy;
      }
    }
  }

  // idle: loiter at camp when content
  U[I_IDLE] = 0.04 + (tribe && campDist < 40 && hunger < 0.4 ? 0.08 * soc : 0);

  // wander (juveniles: follow mother)
  U[I_WANDER] = 0.1 + 0.04 * (1 - soc) + (mother && motherDist > 30 ? 0.25 + 0.3 * clamp01((motherDist - 30) / 80) : 0);

  // explore: curious, fast, perceptive, unsociable agents; or hungry with no food in sight
  const curiosity = 0.5 * (clamp01((tr.perception - 25) / 115) + clamp01((tr.speed - 0.5) / 1.7));
  // aggressive adults with no victim in sight prowl the land looking for prey
  const prowl = adult && !rival && aggEff > 0.7 ? (aggEff - 0.7) * (0.1 + 0.9 * hunger) * 0.8 * (1 - 0.6 * fatigue) * (1 - 0.5 * night) : 0;
  U[I_EXPLORE] =
    prowl +
    (0.04 + 0.2 * curiosity) * (1 - 0.5 * soc) * (1 - 0.7 * fatigue) * (adult ? 1 : 0.25) * (1 - 0.6 * night) +
    (!haveFoodTarget && hunger > 0.25 ? hunger * 0.55 : 0) +
    (role === 'explorer' ? 0.1 : 0);
  // migration: hungry in a neighbourhood grazed bare, with no camp store to fall back on — strike out for
  // lusher land, however far (pickExploreTarget favours lush-looking ground; steering plans the route,
  // across a ford if need be). Picking at scraps nearby (a weak food target) then loses to moving on.
  // a trek in progress holds through detours. A raider's (kind 'raid') lasts until continuingRaid says the raid
  // is over; a migrant's lasts until arrival, lush land, a full stomach or expiry.
  let trek = a.trek;
  let raidTrek: Tribe | null = null;
  if (trek && trek.kind === 'raid') {
    raidTrek = continuingRaid(sim, a, trek, tribe, hp, cap, tick);
    if (!raidTrek) a.trek = undefined;
    trek = undefined; // from here on `trek` is a migration only
  }
  if (trek) {
    const tdx = trek.x - a.x;
    const tdy = trek.y - a.y;
    if (
      tick > trek.until ||
      hunger < 0.3 ||
      tdx * tdx + tdy * tdy < 40 * 40 ||
      lushness(sim, a.x, a.y) > 0.45 ||
      !sameRegion(sim, a.x, a.y, trek.x, trek.y) || // terrain changed: the destination is cut off
      inDangerZone(sim, a, trek.x, trek.y) || // a plague or meteor struck there
      (a.route !== undefined && a.route.fail === true && a.route.gx === trek.x && a.route.gy === trek.y) // no way found
    ) {
      a.trek = undefined;
      trek = undefined;
    } else U[I_EXPLORE] += 0.1 + 0.35 * foodDrive * (1 - 0.6 * night);
  }
  if (adult && hunger > 0.45 && !(tribe && !stockLow && campDist < 300)) {
    const bare = 1 - clamp01(lushness(sim, a.x, a.y) / 0.25);
    if (bare > 0) {
      // a rich patch in sight is worth eating first, and so is food within reach of a fight (a load to rob,
      // a patch to contest); scraps are not
      migrateDrive =
        bare * clamp01((hunger - 0.45) / 0.35) * (haveFoodTarget ? 1 - clamp01(fScore / 3) : 1) * (rival && rivalWhy !== 3 && rivalWhy !== 7 ? 0.25 : 1);
      U[I_EXPLORE] += foodDrive * migrateDrive * (1 - 0.6 * night) * (1 - 0.5 * fatigue);
    }
  }
  const exploreBase = U[I_EXPLORE];

  // raid: a tribe at war sends its bold, fit members against the enemy camp's stockpile. A raid is worth less the
  // farther the raiders must walk (by the route they would take, across a ford if need be), so members out by
  // the river set out more readily than those at home. Once on the march (a raid trek) a raider keeps going: in
  // daylight the raid holds through detours, and at night it sleeps where it is instead of turning home.
  let raidTarget: Tribe | null = null;
  if (
    tribe &&
    adult &&
    aggEff > 0.45 &&
    daylight > 0.3 &&
    a.carried < cap * 0.5 &&
    (raidTrek ? hunger < 0.85 && fatigue < 0.7 : hunger < 0.8 && fatigue < 0.55 && hp > 0.6)
  ) {
    let rv = 0;
    let best = 0;
    for (const key in tribe.relations) {
      const rel = tribe.relations[key];
      if (!(rel < SOCIAL_TUNING.warHostile)) continue;
      const et = sim.getTribe(Number(key));
      if (!et || et === tribe || et.extinctTick !== -1) continue;
      // nothing to plunder (raidStockpile takes > 0.5): a raider sent to an empty store re-chose the raid
      // every tick on arrival and stood rooted in the enemy camp
      if (!(et.stockpile > 0.5)) continue;
      const dx = et.homeX - a.x;
      const dy = et.homeY - a.y;
      if (!(dx * dx + dy * dy < RAID_RANGE * RAID_RANGE)) continue; // the walk is never shorter than the line
      const d = walkDistance(sim, et, a.x, a.y);
      if (!(d < RAID_RANGE)) continue;
      const v = (-rel * (0.35 + 0.65 * clamp01(et.stockpile / 80))) / (1 + d / 400);
      // a raider on the march only turns to another enemy camp that is clearly worth more
      const score = et === raidTrek ? 1.25 * v : v;
      if (score > best) {
        best = score;
        rv = v;
        raidTarget = et;
      }
    }
    if (raidTarget) {
      // at war the enemy is the prey: a raid takes over prowling and wins when it is worth more than the
      // other reasons to roam (curiosity, searching for food); a raider already on the march keeps going
      const onTheMarch =
        raidTarget === raidTrek ||
        (a.action === 'explore' &&
          Number.isFinite(a.targetX) &&
          Number.isFinite(a.targetY) &&
          (a.targetX - raidTarget.homeX) * (a.targetX - raidTarget.homeX) + (a.targetY - raidTarget.homeY) * (a.targetY - raidTarget.homeY) < 40 * 40);
      const raidU =
        prowl +
        0.9 * rv * Math.min(1.5, aggEff) * (role === 'warrior' ? 1.3 : 1) * (0.7 + 0.1 * Math.min(3, P.allyN)) * (stockLow ? 1.3 : 1) * (0.7 + 0.6 * hunger) +
        (onTheMarch ? RAID_COMMIT : 0);
      if (raidU > U[I_EXPLORE]) U[I_EXPLORE] = raidU;
      else raidTarget = null;
    }
  }

  // forage: walk to the best known food (comparative advantage via forage skill)
  if (haveFoodTarget && (wantFood || hunger > 0.05)) {
    U[I_FORAGE] = (foodDrive + gatherDrive) * (0.55 + 0.45 * clamp01(fScore / 5)) + (role === 'forager' && hunger > 0.2 ? 0.05 : 0);
  }

  // eat: food underfoot
  if (hereFood >= 0.5 && (hunger > 0.04 || gatherDrive > 0)) {
    U[I_EAT] = foodDrive + gatherDrive + 0.12 * clamp01(hereFood / 4) + (hunger > 0.04 ? 0.05 : 0);
  }

  // rest: fatigue, night (sleep), cold, sickness, wounds — but a starving agent with food at hand eats first
  {
    // away from camp a sociable agent would rather walk home for the night; a raider on the march sleeps where it is
    const awayFromCamp = tribe && campDist > 60 && !raidTrek ? 1 - 0.6 * soc : 1;
    const foodAtHand = hereFood >= 1 || (haveFoodTarget && fDist < 24);
    U[I_REST] = Math.max(
      0.005,
      Math.pow(fatigue, 1.5) * 1.3 +
        (a.energy < 0.12 ? 0.5 : 0) +
        night * (0.16 + 0.3 * fatigue) * awayFromCamp +
        0.08 * chill +
        sick * 0.3 +
        (hp < 0.6 ? (0.6 - hp) * 0.8 : 0) -
        hunger * hunger * (foodAtHand ? 1.6 : 0.5) -
        fear * 0.4,
    );
  }

  // flee: threats (smoothed fear) and dangerous disaster zones
  if (P.threat) {
    // weak threats only make an agent wary; real danger (or wounds) makes it run
    const danger = Math.max(threatNow, fear * 0.8);
    U[I_FLEE] = (0.05 + 1.05 * danger) * (1.2 - 0.4 * Math.min(1, aggEff)) + (1 - hp) * 0.3 * Math.min(1, 2 * danger);
  }
  if (zoneDanger > 0.05) U[I_FLEE] = Math.max(U[I_FLEE], 0.3 + 0.8 * zoneDanger);

  // attack: fight back, defend kin/friends, or start a fight worth having (conflict appraisal above)
  let attackTarget: Agent | null = null;
  let attackWhy = 0; // 1 fight back, 2 defend, else rivalWhy
  {
    let best = 0;
    if (P.avenge) {
      const u = 0.35 + 0.45 * Math.min(1.5, aggEff) + 0.2 * skCombat + (role === 'warrior' ? 0.08 : 0) - (1 - hp) * 0.4;
      if (u > best) {
        best = u;
        attackTarget = P.avenge;
        attackWhy = 1;
      }
    }
    if (defend) {
      const u =
        (defendChild ? 0.55 : 0.3) + 0.3 * Math.min(1.5, aggEff) + 0.25 * Math.min(1, altEff) + 0.15 * skCombat + (role === 'warrior' ? 0.1 : 0);
      if (u > best) {
        best = u;
        attackTarget = defend;
        attackWhy = 2;
      }
    }
    if (rival) {
      // temperament turns a worthwhile fight into an actual one: gentle agents almost never start one
      const temper = 0.15 + 1.3 * Math.min(1.5, aggEff);
      const u =
        rivalScore * temper * (0.4 + 0.6 * hp) -
        (rivalWhy === 3 ? 0 : 0.12 * Math.min(1, altEff)) -
        0.2 * fatigue +
        (role === 'warrior' ? 0.06 : 0);
      if (u > best) {
        best = u;
        attackTarget = rival;
        attackWhy = rivalWhy;
      }
    }
    if (attackTarget) U[I_ATTACK] = Math.max(0, best);
  }

  // share: feed own juvenile children, help hungry kin/friends when I have surplus
  if (P.needy) {
    const giving = Math.min(1, P.surplus / 12) * (1 - 0.5 * hunger);
    U[I_SHARE] = P.needyChild
      ? (0.4 + 0.5 * P.needyHunger) * (0.6 + 0.4 * Math.min(1, altEff)) * giving
      : (0.1 + 0.55 * P.needyHunger) * (P.needyKin ? 1.5 : 1) * (0.2 + 0.8 * Math.min(1.5, altEff)) * giving;
    U[I_SHARE] += (role === 'caretaker' ? 0.1 : 0) + 0.05 * skSocial;
  }

  // mate
  if (P.mate) {
    U[I_MATE] =
      fertEff * (0.25 + 0.45 * (1 - hunger)) * (0.5 + 0.5 * a.energy) * (0.7 + 0.3 * hp) +
      0.08 * clamp(P.mateScore - 0.5, 0, 1) +
      (P.mate.action === 'mate' && P.mate.targetId === a.id ? 0.15 : 0);
  }

  // socialize
  if (P.friend) {
    const lonely = 1 - Math.min(1, P.friendsNear / 3);
    U[I_SOCIAL] =
      soc * (0.1 + 0.3 * lonely) * (1 - hunger) * (0.6 + 0.4 * a.energy) * (1 - 0.6 * sick) * (1 - 0.5 * night) +
      0.06 * skSocial +
      0.05 * clamp(P.friendAff, 0, 1);
  }

  if (tribe) {
    // go home: night (if sociable), cold, fear, wounds, homesickness
    const far = clamp01((campDist - 35) / 150);
    // (a raider on the march does not turn back: it gives up the raid first when hurt, loaded or the war is over)
    U[I_HOME] = raidTrek
      ? 0
      : ((night * (0.2 + 0.6 * soc) + chill * 0.12 * soc) * (1 - 0.7 * hunger) + fear * 0.3 + (hp < 0.45 ? 0.15 : 0)) * far +
        soc * 0.1 * clamp01((campDist - 250) / 400);
    // deposit carried surplus into the stockpile (only while the store has room)
    if (a.carried >= Math.min(6, cap * 0.3) && storeRoom > Math.min(a.carried, 5)) {
      const fill = clamp01(a.carried / cap);
      U[I_DEPOSIT] =
        ((0.12 + 0.6 * fill) * (0.6 + 0.4 * Math.max(Math.min(1, altEff), soc)) * (1 - 0.6 * hunger)) / (1 + campDist / 500) +
        (fill > 0.95 ? 0.15 : 0) +
        (role === 'forager' ? 0.05 : 0);
    }
    // withdraw from the stockpile when hungry
    if (tribe.stockpile > 1 && hunger > 0.4) {
      U[I_WITHDRAW] = ((foodDrive * 0.95 + 0.05) * Math.min(1, tribe.stockpile / 15) * (a.carried > 2 ? 0.3 : 1)) / (1 + campDist / 400);
    }
  }

  // ---- noise (break ties) + hysteresis (avoid dithering)
  const cur = ACTIONS.indexOf(a.action);
  for (let k = 0; k < N_ACTIONS; k++) {
    if (!(U[k] > 0) || !Number.isFinite(U[k])) {
      U[k] = 0;
      continue;
    }
    U[k] += rng.next() * 0.05;
  }
  if (cur >= 0 && U[cur] > 0) U[cur] += 0.06;

  // argmax; a choice whose target cannot be walked to in a straight line (across a river, behind a
  // wall) is dropped in favour of the next best instead of pinning the agent against the obstacle
  let best = I_WANDER;
  for (let attempt = 0; attempt < 5; attempt++) {
    let pick = -1;
    let bu = 0;
    for (let k = 0; k < N_ACTIONS; k++) {
      if (U[k] > bu) {
        bu = U[k];
        pick = k;
      }
    }
    if (pick < 0) break; // nothing left worth doing: wander
    if (targetReachable(sim, a, pick, tribe, attackTarget, raidTarget)) {
      best = pick;
      break;
    }
    if (pick === I_EXPLORE && raidTarget) {
      raidTarget = null;
      U[I_EXPLORE] = exploreBase;
    } else U[pick] = 0;
  }

  // ================================================================ commit
  const prevAction = a.action;
  const prevTargetId = a.targetId;
  const prevTX = a.targetX;
  const prevTY = a.targetY;
  a.targetId = NONE;
  a.targetX = NaN;
  a.targetY = NaN;
  let action: ActionKind = ACTIONS[best];
  let thought = '';
  const hl = hungerLabel(hunger);

  switch (best) {
    case I_FORAGE: {
      a.targetX = fX;
      a.targetY = fY;
      const terr = terrainName(sim, fX, fY);
      if (gatherDrive > foodDrive && tribe) thought = `Gathering food for ${theName(tribe)} stockpile at a ${terr} patch`;
      else
        thought = `${hl} (${pct(hunger)}%) — ${hunger >= 0.7 ? 'racing to' : 'heading to'} ${fFromMemory ? 'remembered ' : ''}${terr} patch${
          fDist > 60 ? ` ${Math.round(fDist)} away` : ''
        }`;
      break;
    }
    case I_EAT: {
      a.targetX = a.x;
      a.targetY = a.y;
      const terr = terrainName(sim, a.x, a.y);
      thought =
        hunger < 0.1 && tribe
          ? `Full — gathering food for the tribe (${Math.round(a.carried)}/${Math.round(cap)})`
          : `Eating at a ${terr} patch (${hl.toLowerCase()}, ${pct(hunger)}%)`;
      if (hereFood >= 4) rememberFood(a, a.x, a.y, hereFood, tick);
      break;
    }
    case I_REST: {
      if (a.energy < 0.15) thought = `Exhausted (energy ${pct(a.energy)}%), resting`;
      else if (sick > 0) thought = 'Feeling sick, resting to recover';
      else if (hp < 0.5) thought = `Wounded (${pct(hp)}% health), resting`;
      else if (night > 0.5)
        thought = raidTrek
          ? `Night, sleeping on the way to raid ${theName(raidTrek)}`
          : tribe && campDist < 60
            ? 'Night, sleeping at camp'
            : 'Night, sleeping';
      else if (chill > 0.5) thought = 'Cold, huddling to save energy';
      else thought = `Tired (energy ${pct(a.energy)}%), resting`;
      break;
    }
    case I_FLEE: {
      let ex = P.escX + zEscX * 2;
      let ey = P.escY + zEscY * 2;
      let el = Math.sqrt(ex * ex + ey * ey);
      if (!(el > 1e-6)) {
        const ang = rng.next() * Math.PI * 2;
        ex = Math.cos(ang);
        ey = Math.sin(ang);
        el = 1;
      }
      let towardCamp = false;
      if (tribe && campDist > 25 && campDist < 300) {
        const cx = (tribe.homeX - a.x) / campDist;
        const cy = (tribe.homeY - a.y) / campDist;
        if (cx * ex + cy * ey > -0.3 * el) {
          ex += cx * 0.8 * el * (1 - campDist / 300);
          ey += cy * 0.8 * el * (1 - campDist / 300);
          el = Math.sqrt(ex * ex + ey * ey) || 1;
          towardCamp = true;
        }
      }
      // run for open ground: rotate the escape heading (0, ±30°, ±60°, ±90°) until the line to the escape
      // point is clear, so cornered agents slip along a shore or wall instead of pressing into it
      const ux = ex / el;
      const uy = ey / el;
      let fx = sim.clampX(a.x + ux * FLEE_DIST);
      let fy = sim.clampY(a.y + uy * FLEE_DIST);
      for (let k = 0; k < FLEE_COS.length; k++) {
        const c = FLEE_COS[k];
        const sn = FLEE_SIN[k];
        const cx = sim.clampX(a.x + (ux * c - uy * sn) * FLEE_DIST);
        const cy = sim.clampY(a.y + (ux * sn + uy * c) * FLEE_DIST);
        if (clearPath(sim, a.x, a.y, cx, cy)) {
          fx = cx;
          fy = cy;
          break;
        }
      }
      a.targetX = fx;
      a.targetY = fy;
      if (P.threat) {
        a.targetId = P.threat.id;
        const ratio = combatPower(P.threat) / P.myPow;
        thought = `${fear > 0.6 ? 'Terrified' : 'Afraid'} of ${P.threat.name}${P.threat.id === a.lastAttackerId ? ' (attacked me)' : ''}${
          ratio > 1.5 ? ', far stronger' : ''
        } — fleeing${towardCamp ? ' toward camp' : ''}`;
      } else {
        thought = `Fleeing the ${zoneKind === 'plague' ? 'plague zone' : zoneKind === 'meteor' ? 'meteor strike' : 'danger'}`;
      }
      break;
    }
    case I_ATTACK: {
      const t = attackTarget as Agent;
      a.targetId = t.id;
      const tt = liveTribe(sim, t);
      const of = tt && tt !== tribe ? ` of ${theName(tt)}` : '';
      if (attackWhy === 1) thought = `Fighting back against ${t.name}`;
      else if (attackWhy === 2) thought = `Defending ${defendChild ? 'my child ' : ''}${defended ? defended.name : 'a friend'} from ${t.name}`;
      else if (attackWhy === 3)
        thought =
          tt && tribe && (tribe.relations[tt.id] ?? 0) < SOCIAL_TUNING.warHostile ? `At war — attacking ${t.name}${of}` : `Settling a score with ${t.name}`;
      else if (attackWhy === 5) thought = `Driving ${t.name}${of} off our land`;
      else if (attackWhy === 6) thought = `${hl} — fighting ${t.name}${of} for a scarce food patch`;
      else if (attackWhy === 7) thought = `Joining the fight against ${t.name}${of}`;
      else thought = t.carried > 1 ? `${hl} and aggressive — robbing ${t.name}${of} of their food` : `${hl} and aggressive — hunting ${t.name}${of}`;
      break;
    }
    case I_SHARE: {
      const t = P.needy as Agent;
      a.targetId = t.id;
      thought = P.needyChild
        ? `Feeding my hungry child ${t.name}`
        : `Sharing food with hungry ${P.needyKin ? 'kin' : 'friend'} ${t.name} (${pct(P.needyHunger)}% hungry)`;
      break;
    }
    case I_MATE: {
      const m = P.mate as Agent;
      a.targetId = m.id;
      thought = `Courting ${m.name}`;
      // courtship: an unhurried partner turns toward me
      if (
        m.targetId !== a.id &&
        (m.action === 'wander' || m.action === 'idle' || m.action === 'explore' || m.action === 'socialize' || (m.action === 'rest' && m.energy > 0.5))
      ) {
        m.action = 'mate';
        m.targetId = a.id;
        m.targetX = NaN;
        m.targetY = NaN;
        m.actionTicks = 0;
        m.thought = `Being courted by ${a.name}`;
        if (m.decisionCooldown < 8) m.decisionCooldown = 8;
      }
      break;
    }
    case I_SOCIAL: {
      const f = P.friend as Agent;
      a.targetId = f.id;
      thought = `Spending time with ${f.name}${relKinLabel(a, f)}`;
      break;
    }
    case I_HOME: {
      const tb = tribe as Tribe;
      a.targetX = tb.homeX;
      a.targetY = tb.homeY;
      thought =
        fear > 0.4
          ? 'Shaken — retreating to camp'
          : night > 0.4
            ? 'Night is falling — heading back to camp'
            : chill > 0.5
              ? 'Cold — heading to the shelter of camp'
              : `Returning to ${theName(tb)} camp`;
      break;
    }
    case I_DEPOSIT: {
      const tb = tribe as Tribe;
      a.targetX = tb.homeX;
      a.targetY = tb.homeY;
      thought = `Carrying ${Math.round(a.carried)} food — bringing it to ${theName(tb)} stockpile`;
      break;
    }
    case I_WITHDRAW: {
      const tb = tribe as Tribe;
      a.targetX = tb.homeX;
      a.targetY = tb.homeY;
      thought = `${hl} (${pct(hunger)}%) — taking food from ${theName(tb)} stockpile (${Math.round(tb.stockpile)})`;
      break;
    }
    case I_EXPLORE: {
      // a raid; a raider already on the march that would rather roam (prowling, searching for food) keeps heading
      // for the enemy camp too
      const raid = raidTarget ?? raidTrek;
      if (raid) {
        a.targetX = raid.homeX;
        a.targetY = raid.homeY;
        // setting out: commit to the march (a trek), across fords and through the night
        if (raidTrek !== raid) a.trek = { x: raid.homeX, y: raid.homeY, until: tick + RAID_TREK_TICKS, kind: 'raid', tribe: raid.id };
        const by = !clearPath(sim, a.x, a.y, raid.homeX, raid.homeY) ? ', the long way round by a ford or pass' : '';
        thought = `At war, raiding the camp of ${theName(raid)}${P.allyN > 1 ? ` with ${P.allyN} others` : ''}${by}`;
        break;
      }
      if (trek) {
        exX = trek.x;
        exY = trek.y;
      } else if (
        prevAction === 'explore' &&
        !(migrateDrive > 0.3) && // a migrant without a destination keeps looking for greener land each time
        Number.isFinite(prevTX) &&
        Number.isFinite(prevTY) &&
        a.actionTicks < 600 &&
        (prevTX - a.x) * (prevTX - a.x) + (prevTY - a.y) * (prevTY - a.y) > 30 * 30 &&
        sameRegion(sim, a.x, a.y, prevTX, prevTY)
      ) {
        exX = prevTX;
        exY = prevTY;
      } else if (!pickExploreTarget(sim, a, tribe, soc, tick, migrateDrive)) {
        action = 'wander';
        thought = 'Restless — wandering';
        break;
      }
      // a migrant commits to the destination it picked — if it really looks like greener land
      if (!trek && migrateDrive > 0.3 && lushness(sim, exX, exY) > 0.35) a.trek = { x: exX, y: exY, until: tick + TREK_TICKS, kind: 'migrate', tribe: NONE };
      a.targetX = exX;
      a.targetY = exY;
      const dir = compass(exX - a.x, exY - a.y);
      const detour = !clearPath(sim, a.x, a.y, exX, exY) && sameRegion(sim, a.x, a.y, exX, exY) ? ' (the long way round, by a ford or pass)' : '';
      if (detour && a.route && !a.route.fail && a.route.pts.length === 0) a.route = undefined; // plan the detour now
      thought =
        trek
          ? `${hl} (${pct(hunger)}%) — still trekking to greener land to the ${dir}`
          : a.trek
          ? `${hl} (${pct(hunger)}%) and the land here is grazed bare — moving on to greener land to the ${dir}`
          : migrateDrive > 0.3
          ? `${hl} (${pct(hunger)}%) and the land here is grazed bare — searching ${dir} for greener land`
          : !haveFoodTarget && hunger > 0.25
          ? `${hl} (${pct(hunger)}%), no food in sight — searching ${dir}`
          : prowl > 0.12
            ? `Prowling ${dir} in search of prey`
            : `Restless — exploring to the ${dir}`;
      thought += detour;
      break;
    }
    case I_IDLE:
      thought = tribe && campDist < 40 ? 'Idling at camp' : 'Idling';
      break;
    default: {
      action = 'wander';
      thought = 'Wandering';
      break;
    }
  }

  if (action === 'wander') {
    if (mother) {
      a.targetId = mother.id;
      thought = motherDist > 30 ? `Following my mother ${mother.name}` : `Playing near my mother ${mother.name}`;
    } else if (P.cohN > 0 && soc > 0.35) {
      a.targetX = P.cohX / P.cohN;
      a.targetY = P.cohY / P.cohN;
      thought = 'Drifting with the group';
    } else if (tribe && soc > 0.5 && campDist > 250) {
      a.targetX = tribe.homeX;
      a.targetY = tribe.homeY;
      thought = 'Wandering back toward camp';
    }
    if (dangerHere > 0.2) {
      // turn away from remembered danger
      const mem = a.memory.danger;
      let ax = 0;
      let ay = 0;
      for (let i = 0; i < mem.length; i++) {
        const dx = a.x - mem[i].x;
        const dy = a.y - mem[i].y;
        const d = Math.sqrt(dx * dx + dy * dy) + 1;
        ax += (dx / d) * mem[i].value;
        ay += (dy / d) * mem[i].value;
      }
      if (ax !== 0 || ay !== 0) a.heading = Math.atan2(ay, ax);
      thought = 'Uneasy — avoiding a dangerous place';
    }
  }

  if (action !== prevAction || a.targetId !== prevTargetId) a.actionTicks = 0;
  a.action = action;
  a.thought = thought;
  // a planned route only serves a move toward a goal; drop it once the agent eats, rests, flees or wanders
  if (a.route && (action === 'eat' || action === 'rest' || action === 'idle' || action === 'flee' || (action === 'wander' && a.targetId === NONE))) a.route = undefined;

  const ut = a.utilities;
  for (let k = 0; k < N_ACTIONS; k++) ut[ACTIONS[k]] = Math.round(U[k] * 1000) / 1000;

  const threatened = P.threat !== null || P.attacked || zoneDanger > 0.05 || action === 'attack';
  a.decisionCooldown = threatened ? 3 + rng.int(3) : 6 + rng.int(9);

  near.length = 0;
  aggressors.length = 0;
  kids.length = 0;
  cands.length = 0;
  engagedN = 0;
  tallyLen = 0;
  P.threat = P.avenge = P.mate = P.needy = P.friend = null;
}

function relKinLabel(a: Agent, b: Agent): string {
  const k = kinFlag(a, b);
  if (k === 1) return b.parents[0] === a.id || b.parents[1] === a.id ? ' (my child)' : ' (my parent)';
  return k === 2 ? ' (sibling)' : '';
}

// ------------------------------------------------------------------ act
/** Execute the current action for one tick (movement, eating, interactions). */
export function act(sim: Simulation, a: Agent): void {
  if (!a.alive) return;
  a.actionTicks++;
  if (!sim.passableAt(a.x, a.y)) {
    // terrain painted underneath (or pushed out of bounds): step out and rethink
    escapeImpassable(sim, a);
    a.decisionCooldown = 0;
    return;
  }
  // being hit while busy with something else → react on the next tick
  if (a.lastAttackerId !== NONE && a.decisionCooldown > 1 && a.action !== 'flee' && a.action !== 'attack') {
    const t = sim.getAgent(a.lastAttackerId);
    if (t && t.action === 'attack' && t.targetId === a.id) {
      const dx = t.x - a.x;
      const dy = t.y - a.y;
      if (dx * dx + dy * dy < 40 * 40) a.decisionCooldown = 0;
    }
  }
  // hungry gatherers snack on what they carry
  const tr = a.traits;
  if (a.carried > 0 && a.food < tr.maxFood * 0.4) {
    const t = Math.min(a.carried, 1.2, tr.maxFood - a.food);
    if (t > 0) {
      a.carried -= t;
      a.food += t;
      a.stats.foodEaten += t;
      a.sinceMeal = 0;
    }
  }

  switch (a.action) {
    case 'eat':
      actEat(sim, a);
      break;
    case 'forage':
      actForage(sim, a);
      break;
    case 'rest':
    case 'idle':
      halt(a);
      break;
    case 'flee':
      actFlee(sim, a);
      break;
    case 'attack':
      actAttack(sim, a);
      break;
    case 'share':
      actShare(sim, a);
      break;
    case 'mate':
      actMate(sim, a);
      break;
    case 'socialize':
      actSocialize(sim, a);
      break;
    case 'gohome':
    case 'deposit':
    case 'withdraw':
      actCamp(sim, a);
      break;
    case 'explore':
      actExplore(sim, a);
      break;
    default:
      actWander(sim, a);
      break;
  }
  // final safety net: never leave an agent on an impassable tile / with bad coords
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) {
    a.x = sim.clampX(Number.isFinite(a.x) ? a.x : sim.worldW / 2);
    a.y = sim.clampY(Number.isFinite(a.y) ? a.y : sim.worldH / 2);
    halt(a);
  }
}

function rethink(a: Agent): void {
  halt(a);
  a.decisionCooldown = 0;
}

function actEat(sim: Simulation, a: Agent): void {
  halt(a);
  const tr = a.traits;
  const here = foodAt(sim, a.x, a.y);
  const tribe = liveTribe(sim, a);
  const cap = carryCapacity(a);
  const room = tr.maxFood - a.food;
  const canGather = tribe !== undefined && isAdult(a) && a.carried < cap - 0.01;
  if (here < 0.05) {
    // patch exhausted: shuffle to the next tile if still hungry / gathering
    if ((room > tr.maxFood * 0.1 || canGather) && adjacentFood(sim, a)) {
      a.action = 'forage';
      a.targetX = fX;
      a.targetY = fY;
      a.actionTicks = 0;
      a.thought = 'Patch grazed bare — moving to the next one';
      return;
    }
    forgetFoodNear(a, a.x, a.y);
    a.decisionCooldown = 0;
    return;
  }
  const bite = 1.2 * tr.efficiency * (1 + 0.3 * clamp01(a.skills.forage));
  let got = 0;
  if (room > 0.01) {
    got = consumeFood(sim, a.x, a.y, Math.min(bite, room));
    if (got > 0) {
      a.food += got;
      if (a.food > tr.maxFood) a.food = tr.maxFood;
      a.stats.foodEaten += got;
      a.sinceMeal = 0;
    }
  }
  // tribe members keep gathering once the stomach is (nearly) full
  if (canGather && a.food >= tr.maxFood * 0.9) {
    const left = bite - got;
    if (left > 0.01) {
      const g = consumeFood(sim, a.x, a.y, Math.min(left, cap - a.carried));
      if (g > 0) {
        a.carried += g;
        got += g;
      }
    }
  }
  if (got > 0) a.skills.forage = Math.min(1, a.skills.forage + 0.0002 * got);
  const full = a.food >= tr.maxFood * 0.995;
  if (got <= 0 || (full && !(canGather && a.carried < cap - 0.01))) a.decisionCooldown = 0;
}

function actForage(sim: Simulation, a: Agent): void {
  const tx = a.targetX;
  const ty = a.targetY;
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
    rethink(a);
    return;
  }
  const tr = a.traits;
  const hunger = hungerOf(a);
  const here = foodAt(sim, a.x, a.y);
  const ti = sim.tileIndex(tx, ty);
  const onTarget = ti >= 0 && sim.tileIndex(a.x, a.y) === ti;
  if ((onTarget && here >= 0.3) || (here >= 2 && hunger > 0.35)) {
    a.route = undefined;
    a.action = 'eat';
    a.actionTicks = 0;
    a.targetX = a.x;
    a.targetY = a.y;
    a.thought = onTarget ? `Arrived — eating at a ${terrainName(sim, a.x, a.y)} patch` : 'Grabbing a bite on the way';
    actEat(sim, a);
    return;
  }
  if (onTarget) {
    // arrived but the food is gone
    forgetFoodNear(a, tx, ty);
    rethink(a);
    return;
  }
  moveToward(sim, a, tx, ty, 0.8 + 0.2 * hunger, 0.5);
  if (a.actionTicks > 600 && tr.speed > 0) a.decisionCooldown = 0;
}

function actFlee(sim: Simulation, a: Agent): void {
  let dx = 0;
  let dy = 0;
  const t = sim.getAgent(a.targetId);
  if (t) {
    const ex = a.x - t.x;
    const ey = a.y - t.y;
    const d = Math.sqrt(ex * ex + ey * ey);
    if (d > a.traits.perception * 1.3) a.decisionCooldown = 0; // lost them
    if (d > 1e-6) {
      dx = ex / d;
      dy = ey / d;
    } else {
      dx = Math.cos(a.heading);
      dy = Math.sin(a.heading);
    }
  }
  if (Number.isFinite(a.targetX) && Number.isFinite(a.targetY)) {
    const ex = a.targetX - a.x;
    const ey = a.targetY - a.y;
    const d = Math.sqrt(ex * ex + ey * ey);
    if (d > 6) {
      dx += (ex / d) * 0.7;
      dy += (ey / d) * 0.7;
    } else if (!t) a.decisionCooldown = 0;
  }
  if (dx === 0 && dy === 0) {
    rethink(a);
    return;
  }
  stepDir(sim, a, dx, dy, 1);
}

function actAttack(sim: Simulation, a: Agent): void {
  const t = sim.getAgent(a.targetId);
  if (!t || t === a) {
    rethink(a);
    return;
  }
  const tr = a.traits;
  if (a.health < tr.maxHealth * FIGHT_MIN_HP || a.actionTicks > 400) {
    rethink(a); // badly hurt or a long fruitless chase: break off
    return;
  }
  const dx = t.x - a.x;
  const dy = t.y - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > tr.perception * 1.4) {
    rethink(a); // target escaped
    return;
  }
  const reach = 3 * tr.size * growthFactor(a) + 3 * t.traits.size * growthFactor(t) + 2;
  if (d > reach) {
    moveToward(sim, a, t.x, t.y, 1, reach * 0.5);
    return;
  }
  // in reach: keep closing in on a target that backs off (a faster pursuer stays in reach until its next
  // blow; halting here let any fleeing target slip out before the strike window came round)
  if (d > reach * 0.6) moveToward(sim, a, t.x, t.y, 1, reach * 0.5);
  else halt(a);
  if (d > 1e-6) a.heading = Math.atan2(dy, dx);
  if ((sim.state.tick + a.id) % ATTACK_INTERVAL === 0) {
    attack(sim, a, t);
    if (!a.alive) return;
    if (!t.alive) a.decisionCooldown = 0;
  }
}

function actShare(sim: Simulation, a: Agent): void {
  const t = sim.getAgent(a.targetId);
  if (!t || t === a) {
    rethink(a);
    return;
  }
  const dx = t.x - a.x;
  const dy = t.y - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > SHARE_RANGE) {
    if (a.actionTicks > 300 || d > a.traits.perception * 1.5) {
      rethink(a);
      return;
    }
    moveToward(sim, a, t.x, t.y, 0.75, SHARE_RANGE * 0.7);
    return;
  }
  halt(a);
  const need = t.traits.maxFood - t.food;
  const surplus = a.carried + Math.max(0, a.food - a.traits.maxFood * 0.5);
  const amount = Math.min(need * 0.7, surplus);
  if (amount >= 0.5) shareFood(sim, a, t, amount);
  a.decisionCooldown = 0;
}

function actMate(sim: Simulation, a: Agent): void {
  const t = sim.getAgent(a.targetId);
  if (!t || t === a || a.actionTicks > 300) {
    rethink(a);
    return;
  }
  const dx = t.x - a.x;
  const dy = t.y - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > MATE_RANGE) {
    if ((sim.state.tick + a.id) % 12 === 0 && !(canMate(sim, a, t) && canMate(sim, t, a))) {
      rethink(a);
      return;
    }
    moveToward(sim, a, t.x, t.y, 0.7, MATE_RANGE * 0.6);
    return;
  }
  halt(a);
  if (canMate(sim, a, t) && canMate(sim, t, a)) {
    const child = reproduce(sim, a, t);
    if (!a.alive) return;
    if (child) a.thought = `Became a parent with ${t.name}`;
  }
  a.decisionCooldown = 0;
  if (t.action === 'mate' && t.targetId === a.id) t.decisionCooldown = 0;
}

function actSocialize(sim: Simulation, a: Agent): void {
  const t = sim.getAgent(a.targetId);
  if (!t || t === a || a.actionTicks > 300) {
    rethink(a);
    return;
  }
  const dx = t.x - a.x;
  const dy = t.y - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > a.traits.perception * 1.5) {
    rethink(a);
    return;
  }
  if (d > SOCIAL_RANGE) {
    moveToward(sim, a, t.x, t.y, 0.55, SOCIAL_RANGE * 0.7);
    return;
  }
  if (d < 3 && d > 1e-6) stepDir(sim, a, -dx, -dy, 0.15); // personal space
  else halt(a);
  if ((sim.state.tick + a.id) % SOCIAL_INTERVAL === 0) {
    const k = kinFlag(a, t);
    adjustRelationship(sim, a, t, 0.03, k);
    adjustRelationship(sim, t, a, 0.03, k);
    a.skills.social = Math.min(1, a.skills.social + 0.002);
  }
}

function actCamp(sim: Simulation, a: Agent): void {
  const tribe = liveTribe(sim, a);
  if (!tribe) {
    rethink(a);
    return;
  }
  const dx = tribe.homeX - a.x;
  const dy = tribe.homeY - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const kind = a.action;
  const range = kind === 'gohome' ? CAMP_RANGE : CAMP_RANGE * 0.6;
  if (d > range) {
    moveToward(sim, a, tribe.homeX, tribe.homeY, kind === 'withdraw' ? 0.85 : 0.75, range * 0.5);
    if (a.actionTicks > 1500) a.decisionCooldown = 0;
    return;
  }
  a.route = undefined; // at camp
  halt(a);
  if (kind === 'deposit') {
    const got = a.carried > 0 ? depositFood(sim, a) : 0;
    // edge closer only while the store has room; at a full store waiting achieves nothing (rethink:
    // the deposit utility is zero until there is room again)
    const room = stockpileCapacity(tribe) - tribe.stockpile;
    if (!(got > 0) && a.carried > 0.5 && room > 0.5 && d > 4 && a.actionTicks < 900) {
      moveToward(sim, a, tribe.homeX, tribe.homeY, 0.5, 3);
      return;
    }
    a.decisionCooldown = 0;
  } else if (kind === 'withdraw') {
    const want = Math.min(a.traits.maxFood - a.food, 40);
    const got = want > 0.5 && tribe.stockpile > 0 ? withdrawFood(sim, a, want) : 0;
    if (got > 0) a.sinceMeal = 0;
    else if (want > 0.5 && tribe.stockpile > 0 && d > 4 && a.actionTicks < 900) {
      moveToward(sim, a, tribe.homeX, tribe.homeY, 0.5, 3);
      return;
    }
    a.decisionCooldown = 0;
  } else {
    // home: sleep if it is night, otherwise reconsider
    if (sim.config.dayNight && sim.state.env.daylight < 0.35) {
      a.action = 'rest';
      a.actionTicks = 0;
      a.thought = 'Home at camp — sleeping';
    } else a.decisionCooldown = 0;
  }
}

function actExplore(sim: Simulation, a: Agent): void {
  const tx = a.targetX;
  const ty = a.targetY;
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
    rethink(a);
    return;
  }
  if (hungerOf(a) > 0.45 && foodAt(sim, a.x, a.y) >= 2) {
    a.action = 'eat';
    a.actionTicks = 0;
    a.thought = 'Found food while exploring';
    actEat(sim, a);
    return;
  }
  if (moveToward(sim, a, tx, ty, 0.75, 10) || a.actionTicks > 900) {
    plunder(sim, a);
    a.targetX = NaN;
    a.targetY = NaN;
    a.decisionCooldown = 0;
  }
}

/** A raider that reached the camp of a tribe its own tribe is at war with grabs from its stockpile. */
function plunder(sim: Simulation, a: Agent): void {
  const own = liveTribe(sim, a);
  if (!own) return;
  for (const key in own.relations) {
    if (!(own.relations[key] < SOCIAL_TUNING.warHostile)) continue;
    const et = sim.getTribe(Number(key));
    if (!et || et === own || et.extinctTick !== -1) continue;
    const dx = et.homeX - a.x;
    const dy = et.homeY - a.y;
    if (dx * dx + dy * dy > SOCIAL_TUNING.campRadius * SOCIAL_TUNING.campRadius) continue;
    const got = raidStockpile(sim, a, et);
    if (got > 0) a.thought = `Raided ${theName(et)} camp — carrying off ${Math.round(got)} food`;
    return;
  }
}

function actWander(sim: Simulation, a: Agent): void {
  const h = (Number.isFinite(a.heading) ? a.heading : 0) + (sim.rng.next() - 0.5) * 0.6;
  let dx = Math.cos(h);
  let dy = Math.sin(h);
  let factor = 0.5;
  if (a.targetId !== NONE) {
    // juvenile following its mother
    const m = sim.getAgent(a.targetId);
    if (m) {
      const ex = m.x - a.x;
      const ey = m.y - a.y;
      const d = Math.sqrt(ex * ex + ey * ey);
      const rt = a.route;
      if (d > 18 && ((rt !== undefined && (rt.pts.length > 0 || rt.wait === true)) || !clearPath(sim, a.x, a.y, m.x, m.y)) && sameRegion(sim, a.x, a.y, m.x, m.y)) {
        // she crossed at a ford (or went round a wall): follow her route instead of pressing into the bank
        moveToward(sim, a, m.x, m.y, 0.5 + 0.4 * Math.min(1, (d - 18) / 60), 18);
        return;
      }
      if (rt !== undefined) a.route = undefined; // following her directly: no leftover route
      if (d > 18) {
        const w = Math.min(1.5, (d - 18) / 40) * 1.5;
        dx += (ex / d) * w;
        dy += (ey / d) * w;
        factor = 0.5 + 0.4 * Math.min(1, (d - 18) / 60);
      } else factor = 0.3;
    } else a.targetId = NONE;
  } else if (Number.isFinite(a.targetX) && Number.isFinite(a.targetY)) {
    // loose cohesion with the group / drift home
    const ex = a.targetX - a.x;
    const ey = a.targetY - a.y;
    const d = Math.sqrt(ex * ex + ey * ey);
    if (d > 30) {
      const w = Math.min(1, (d - 30) / 80) * 0.8;
      dx += (ex / d) * w;
      dy += (ey / d) * w;
    }
  }
  stepDir(sim, a, dx, dy, factor);
}
