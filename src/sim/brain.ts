// OWNER: Agent Intelligence agent.
/**
 * Agent mind — a utility-based autonomous controller.
 *
 * think(sim, a)  (every ~6–14 ticks per agent, staggered; shorter when threatened)
 *   1. needs: hunger, fatigue, health, infection; environment: night, winter/cold.
 *   2. perception (radius = perception × (0.55 + 0.45·daylight)): neighbours are
 *      classified into threats, fight-back / prey / enemy targets, potential mates,
 *      needy friends & own children, friends to socialise with, tribe cohesion.
 *   3. food: tile underfoot, a cheap local scan, ecology.findFood, and remembered
 *      rich spots (memory.food); danger memory and active disasters are avoided.
 *   4. a utility for every ActionKind (traits × config biases × skills × role ×
 *      tribe logistics), small rng noise + hysteresis, argmax → action, target,
 *      readable thought, a.utilities, a.decisionCooldown, smoothed a.fear.
 * act(sim, a)    (every tick, allocation-free; targets re-resolved by id)
 *   steering with obstacle avoidance (steering.ts) and the action's effect:
 *   eat/gather, flee, attack, share, mate, socialise, camp deposit/withdraw,
 *   explore, wander (juveniles stay near their mother), rest/idle.
 */
import type { Simulation } from './simulation';
import { ACTIONS, NONE, type ActionKind, type Agent, type TerrainType, type Tribe } from './types';
import { LIMITS, TERRAIN_INFO } from './constants';
import { consumeFood, findFood, foodAt, tileCapacity } from './ecology';
import { adjustRelationship, attack, depositFood, isFriendly, isHostile, shareFood, withdrawFood } from './social';
import { canMate, reproduce } from './genetics';
import { growthFactor, isAdult } from './lifecycle';
import { escapeImpassable, halt, moveToward, stepDir } from './steering';

// ------------------------------------------------------------------ tuning
const MAX_NEIGHBOURS = 48;
const LOCAL_SCAN_TILES = 3;
const FOOD_MEMORY_TTL = 5000;
const DANGER_MEMORY_TTL = 1500;
const DANGER_RADIUS = 60;
const ATTACK_INTERVAL = 15;
const SOCIAL_INTERVAL = 10;
const SHARE_RANGE = 8;
const MATE_RANGE = 8;
const SOCIAL_RANGE = 10;
const CAMP_RANGE = 20;
const CARRY_PER_SIZE = 25;
const MAX_MATE_CHECKS = 8;

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

// ------------------------------------------------------------------ scratch (module-level, reused)
const near: Agent[] = [];
const aggressors: Agent[] = [];
const kids: Agent[] = [];
const U = new Float64Array(N_ACTIONS);

/** Per-think perception results (reset at the start of every think). */
const P = {
  r: 1,
  myPow: 1,
  aggEff: 0,
  hp: 1,
  adult: true,
  matingReady: false,
  mateChecks: 0,
  surplus: 0,
  sawAttacker: false,
  attacked: false,
  threat: null as Agent | null,
  threatW: 0,
  threatLevel: 0,
  escX: 0,
  escY: 0,
  avenge: null as Agent | null,
  avengeScore: 0,
  prey: null as Agent | null,
  preyScore: 0,
  preyHostile: false,
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
  P.attacked = false;
  P.threat = null;
  P.threatW = 0;
  P.threatLevel = 0;
  P.escX = 0;
  P.escY = 0;
  P.avenge = null;
  P.avengeScore = 0;
  P.prey = null;
  P.preyScore = 0;
  P.preyHostile = false;
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

// best food candidate (think only)
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
  return h >= 0.8 ? 'Starving' : h >= 0.55 ? 'Hungry' : h >= 0.3 ? 'Peckish' : 'Sated';
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

/** How much food an agent can carry for its tribe. */
export function carryCapacity(a: Agent): number {
  return CARRY_PER_SIZE * a.traits.size;
}

/** Effective fighting power (strength × growth × condition × combat skill). */
export function combatPower(b: Agent): number {
  const t = b.traits;
  const hpF = clamp01(b.health / (t.maxHealth > 0 ? t.maxHealth : 1));
  const p = t.strength * growthFactor(b) * (0.3 + 0.7 * hpF) * (0.75 + 0.5 * clamp01(b.skills.combat));
  return p > 0.01 && Number.isFinite(p) ? p : 0.01;
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
function considerFood(a: Agent, x: number, y: number, food: number, bonus: number, fromMemory: boolean, tick: number): void {
  if (!(food >= 0.75) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const dx = x - a.x;
  const dy = y - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const sc = (food * bonus * (1 - 0.8 * dangerAt(a, x, y, tick))) / (1 + d / 60);
  if (sc > fScore) {
    fScore = sc;
    fX = x;
    fY = y;
    fFood = food;
    fDist = d;
    fFromMemory = fromMemory;
  }
}

/** Cheap scan of the tiles around the agent (excluding the one underfoot). */
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
      if (ox === 0 && oy === 0) continue;
      const tx = tx0 + ox;
      if (tx < 0 || tx >= w.width) continue;
      const idx = ty * w.width + tx;
      const f = w.food[idx];
      if (!(f >= 0.75)) continue;
      if (!TERRAIN_INFO[w.terrain[idx] as TerrainType].passable) continue;
      considerFood(a, (tx + 0.5) * ts, (ty + 0.5) * ts, f, 1, false, tick);
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
function perceive(sim: Simulation, a: Agent, b: Agent): void {
  if (!b.alive || b === a) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const prox = clamp01(1 - d / P.r);
  relationTo(a, b);
  const kin = relKin;
  const aff = relAff;
  const attackingMe = b.action === 'attack' && b.targetId === a.id;
  const grudge = b.id === a.lastAttackerId;
  if (grudge) P.sawAttacker = true;
  const friendly = !attackingMe && (kin > 0 || aff > 0.3 || isFriendly(sim, a, b));
  const bAdult = isAdult(b);

  if (!friendly || grudge) {
    const ratio = combatPower(b) / P.myPow;
    const hostile = attackingMe || grudge || isHostile(sim, a, b);
    if ((hostile || (b.action === 'attack' && b.targetId !== NONE)) && aggressors.length < 8) aggressors.push(b);
    // ratio below which I stand my ground when attacked
    const brave = 0.8 + 0.6 * Math.min(1.5, P.aggEff) + 0.3 * clamp01(a.skills.combat) - 0.7 * (1 - P.hp);
    if ((attackingMe || grudge) && P.adult && ratio < brave) {
      const sc = (attackingMe ? 1.5 : 0.8) * (0.5 + 0.5 * prox) * (brave - ratio + 0.2);
      if (sc > P.avengeScore) {
        P.avengeScore = sc;
        P.avenge = b;
      }
      if (attackingMe) P.attacked = true;
    } else if (
      attackingMe ||
      (grudge && prox > 0.25) ||
      (hostile && ratio > 1.1) ||
      (!P.adult && hostile) ||
      (b.action === 'attack' && ratio > 1.6 && b.traits.aggression > 0.6 && prox > 0.5)
    ) {
      const w = clamp(ratio, 0.3, 3) * (0.25 + 0.75 * prox) * (attackingMe ? 1.6 : hostile ? 1 : 0.5);
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
    // prey / enemy to attack (initiated by me)
    if (!friendly && P.adult && !attackingMe && kin === 0) {
      let sc = 0;
      if (ratio < 0.87) {
        const loot = b.carried > 1 || b.food > b.traits.maxFood * 0.4 ? 1 : 0.6;
        sc = (1 - ratio) * loot * (bAdult ? 1 : 0.4);
      }
      if (hostile && ratio < 1.15) sc += 0.35 * (1.35 - ratio);
      sc *= 0.5 + 0.5 * prox;
      if (sc > P.preyScore) {
        P.preyScore = sc;
        P.prey = b;
        P.preyHostile = hostile;
      }
    }
  }

  if (friendly) {
    P.cohX += b.x;
    P.cohY += b.y;
    P.cohN++;
    if (d < 40) P.friendsNear++;
    const myChild = kin === 1 && (b.parents[0] === a.id || b.parents[1] === a.id);
    if (myChild && !bAdult && kids.length < 4) kids.push(b);
    // needy friend / kin / own child (I share when I have surplus)
    if (P.surplus >= 3) {
      const bh = hungerOf(b);
      const juvenileChild = myChild && !bAdult;
      if (bh > 0.5 || (juvenileChild && bh > 0.35)) {
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

// ------------------------------------------------------------------ explore target
function pickExploreTarget(sim: Simulation, a: Agent, tribe: Tribe | undefined, soc: number, tick: number): boolean {
  const margin = sim.state.world.tileSize * 2;
  const W = sim.worldW;
  const H = sim.worldH;
  const reach = 120 + 0.8 * a.traits.perception;
  let best = -Infinity;
  exX = NaN;
  exY = NaN;
  for (let k = 0; k < 6; k++) {
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
      sc += (1 - soc) * Math.min(1, dh / 500) * 0.5 - (soc * Math.max(0, dh - 350)) / 400;
    }
    sc -= dangerAt(a, tx, ty, tick) * 2;
    if (sc > best) {
      best = sc;
      exX = tx;
      exY = ty;
    }
  }
  return best > -Infinity;
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
  const cold = clamp01((8 - env.temperature) / 18);
  const chill = Math.max(winter, cold);
  const adult = isAdult(a);
  const aggEff = clamp(tr.aggression * cfg.aggressionBias, 0, 2);
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
  P.hp = hp;
  P.adult = adult;
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
  for (let i = 0; i < n; i++) perceive(sim, a, near[i]);
  if (!P.sawAttacker && a.lastAttackerId !== NONE) {
    const atk = sim.getAgent(a.lastAttackerId);
    if (atk) {
      const dx = atk.x - a.x;
      const dy = atk.y - a.y;
      if (dx * dx + dy * dy <= percR * percR) perceive(sim, a, atk);
    }
  }

  // ---- protect own children / friends under attack
  let defend: Agent | null = null;
  let defended: Agent | null = null;
  let defendScore = 0;
  let defendChild = false;
  if (adult) {
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
  const gatherDrive =
    tribe && adult && hunger < 0.3 && a.carried < cap * 0.9
      ? (0.06 + 0.16 * skForage + 0.12 * Math.min(1, altEff) * (stockLow ? 1 : 0.35) + 0.06 * soc + (role === 'forager' ? 0.1 : 0)) *
        (1 - 0.6 * night)
      : 0;
  const wantFood = hunger > 0.12 || gatherDrive > 0;
  fX = NaN;
  fY = NaN;
  fFood = 0;
  fScore = 0;
  fDist = 0;
  fFromMemory = false;
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
  const haveFoodTarget = fScore > 0;

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
  const foodDrive = hungerDrive * (1 + 0.25 * skForage);
  U.fill(0);

  // idle: loiter at camp when content
  U[I_IDLE] = 0.04 + (tribe && campDist < 40 && hunger < 0.4 ? 0.08 * soc : 0);

  // wander (juveniles: follow mother)
  U[I_WANDER] = 0.1 + 0.04 * (1 - soc) + (mother && motherDist > 30 ? 0.25 + 0.3 * clamp01((motherDist - 30) / 80) : 0);

  // explore: curious, fast, perceptive, unsociable agents; or hungry with no food in sight
  const curiosity = 0.5 * (clamp01((tr.perception - 25) / 115) + clamp01((tr.speed - 0.5) / 1.7));
  U[I_EXPLORE] =
    (0.04 + 0.2 * curiosity) * (1 - 0.5 * soc) * (1 - 0.7 * fatigue) * (adult ? 1 : 0.25) * (1 - 0.6 * night) +
    (!haveFoodTarget && hunger > 0.25 ? hunger * 0.55 : 0) +
    (role === 'explorer' ? 0.1 : 0);

  // forage: walk to the best known food (comparative advantage via forage skill)
  if (haveFoodTarget && (wantFood || hunger > 0.05)) {
    U[I_FORAGE] = (foodDrive + gatherDrive) * (0.55 + 0.45 * clamp01(fScore / 5)) + (role === 'forager' && hunger > 0.2 ? 0.05 : 0);
  }

  // eat: food underfoot
  if (hereFood >= 0.5 && (hunger > 0.04 || gatherDrive > 0)) {
    U[I_EAT] = foodDrive + gatherDrive + 0.12 * clamp01(hereFood / 4) + (hunger > 0.04 ? 0.05 : 0);
  }

  // rest: fatigue, night (sleep), cold, sickness, wounds
  {
    const awayFromCamp = tribe && campDist > 60 ? 1 - 0.6 * soc : 1;
    U[I_REST] = Math.max(
      0.005,
      Math.pow(fatigue, 1.5) * 1.3 +
        (a.energy < 0.12 ? 0.5 : 0) +
        night * (0.16 + 0.3 * fatigue) * awayFromCamp +
        0.08 * chill +
        sick * 0.3 +
        (hp < 0.6 ? (0.6 - hp) * 0.8 : 0) -
        hunger * hunger * 0.5 -
        fear * 0.4,
    );
  }

  // flee: threats (smoothed fear) and dangerous disaster zones
  if (P.threat) {
    U[I_FLEE] = (0.2 + 0.9 * Math.max(threatNow, fear * 0.8)) * (1.2 - 0.4 * Math.min(1, aggEff)) + (1 - hp) * 0.3;
  }
  if (zoneDanger > 0.05) U[I_FLEE] = Math.max(U[I_FLEE], 0.3 + 0.8 * zoneDanger);

  // attack: fight back, defend kin/friends, or prey on the weak / attack enemies
  let attackTarget: Agent | null = null;
  let attackWhy = 0; // 1 fight back, 2 defend, 3 enemy, 4 hunt
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
    if (P.prey && adult) {
      const scarce = !haveFoodTarget || fScore < 1.5;
      const u =
        aggEff *
          (0.1 + 0.8 * Math.pow(hunger, 1.3) * (scarce ? 1.2 : 0.7)) *
          clamp(P.preyScore, 0, 1.2) *
          (0.8 + 0.4 * skCombat) *
          (0.4 + 0.6 * hp) +
        (P.preyHostile ? 0.18 * Math.min(1.5, aggEff) : 0) +
        (role === 'warrior' ? 0.06 : 0) -
        0.15 * Math.min(1, altEff) -
        0.2 * fatigue;
      if (u > best) {
        best = u;
        attackTarget = P.prey;
        attackWhy = P.preyHostile ? 3 : 4;
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
    U[I_HOME] =
      (night * (0.2 + 0.6 * soc) + chill * 0.12 * soc + fear * 0.3 + (hp < 0.45 ? 0.15 : 0)) * far +
      soc * 0.1 * clamp01((campDist - 250) / 400);
    // deposit carried surplus into the stockpile
    if (a.carried >= Math.min(6, cap * 0.3)) {
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

  let best = I_WANDER;
  let bu = 0;
  for (let k = 0; k < N_ACTIONS; k++) {
    if (U[k] > bu) {
      bu = U[k];
      best = k;
    }
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
      if (gatherDrive > foodDrive && tribe) thought = `Gathering food for the ${tribe.name} stockpile at a ${terr} patch`;
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
      if (a.energy < 0.15) thought = `Exhausted (energy ${pct(a.energy)}%) — resting`;
      else if (sick > 0) thought = 'Feeling sick — resting to recover';
      else if (hp < 0.5) thought = `Wounded (${pct(hp)}% health) — resting`;
      else if (night > 0.5) thought = tribe && campDist < 60 ? 'Night — sleeping at camp' : 'Night — sleeping';
      else if (chill > 0.5) thought = 'Cold — huddling to conserve energy';
      else thought = `Tired (energy ${pct(a.energy)}%) — resting`;
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
      a.targetX = sim.clampX(a.x + (ex / el) * 80);
      a.targetY = sim.clampY(a.y + (ey / el) * 80);
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
      if (attackWhy === 1) thought = `Fighting back against ${t.name}`;
      else if (attackWhy === 2) thought = `Defending ${defendChild ? 'my child ' : ''}${defended ? defended.name : 'a friend'} from ${t.name}`;
      else if (attackWhy === 3) thought = `Attacking enemy ${t.name}${tt ? ` of the ${tt.name}` : ''}`;
      else thought = `${hl} and aggressive — hunting ${t.name}${t.carried > 1 ? ' for their food' : ''}`;
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
              : `Returning to the ${tb.name} camp`;
      break;
    }
    case I_DEPOSIT: {
      const tb = tribe as Tribe;
      a.targetX = tb.homeX;
      a.targetY = tb.homeY;
      thought = `Carrying ${Math.round(a.carried)} food — bringing it to the ${tb.name} stockpile`;
      break;
    }
    case I_WITHDRAW: {
      const tb = tribe as Tribe;
      a.targetX = tb.homeX;
      a.targetY = tb.homeY;
      thought = `${hl} (${pct(hunger)}%) — taking food from the ${tb.name} stockpile (${Math.round(tb.stockpile)})`;
      break;
    }
    case I_EXPLORE: {
      if (
        prevAction === 'explore' &&
        Number.isFinite(prevTX) &&
        Number.isFinite(prevTY) &&
        a.actionTicks < 600 &&
        (prevTX - a.x) * (prevTX - a.x) + (prevTY - a.y) * (prevTY - a.y) > 30 * 30
      ) {
        exX = prevTX;
        exY = prevTY;
      } else if (!pickExploreTarget(sim, a, tribe, soc, tick)) {
        action = 'wander';
        thought = 'Restless — wandering';
        break;
      }
      a.targetX = exX;
      a.targetY = exY;
      const dir = compass(exX - a.x, exY - a.y);
      thought = !haveFoodTarget && hunger > 0.25 ? `${hl} (${pct(hunger)}%), no food in sight — searching ${dir}` : `Restless — exploring to the ${dir}`;
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

  const ut = a.utilities;
  for (let k = 0; k < N_ACTIONS; k++) ut[ACTIONS[k]] = Math.round(U[k] * 1000) / 1000;

  const threatened = P.threat !== null || P.attacked || zoneDanger > 0.05 || action === 'attack';
  a.decisionCooldown = threatened ? 3 + rng.int(3) : 6 + rng.int(9);

  near.length = 0;
  aggressors.length = 0;
  kids.length = 0;
  P.threat = P.avenge = P.prey = P.mate = P.needy = P.friend = null;
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
    a.action = 'eat';
    a.actionTicks = 0;
    a.targetX = a.x;
    a.targetY = a.y;
    if (!onTarget) a.thought = 'Grabbing a bite on the way';
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
  if (a.health < tr.maxHealth * 0.25 || a.actionTicks > 400) {
    rethink(a); // hurt or exhausted chase: give up
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
    moveToward(sim, a, t.x, t.y, 1, reach * 0.8);
    return;
  }
  halt(a);
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
  halt(a);
  if (kind === 'deposit') {
    const got = a.carried > 0 ? depositFood(sim, a) : 0;
    if (!(got > 0) && a.carried > 0.5 && d > 4 && a.actionTicks < 900) {
      moveToward(sim, a, tribe.homeX, tribe.homeY, 0.5, 3); // edge closer to the stockpile
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
    a.targetX = NaN;
    a.targetY = NaN;
    a.decisionCooldown = 0;
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
