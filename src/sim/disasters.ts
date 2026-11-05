// OWNER: Disasters & Disease agent.
/**
 * Natural disasters — droughts, blights (resource collapse), blooms (abundance),
 * plagues, meteor strikes and cold snaps — started by the user (interventions),
 * scenarios (scheduled events) or at random (config.disasterRate).
 *
 *  - Immediate effects (startDisaster): food / fertility / terrain changes, kills,
 *    infections, danger memories, event log.
 *  - Ongoing effects while active: world.climateMod (per-tile regrowth multiplier
 *    read by ecology, smooth falloff at the edge of the radius, gradual recovery
 *    over the last ~15% of the duration) and env.tempOffset (cold snaps).
 *
 * Determinism: randomness only via sim.rng. climateMod is a pure function of
 * (active disasters, tick quantised to CLIMATE_INTERVAL) and tempOffset of
 * (active disasters, tick), so recomputing them at any moment (e.g. right after
 * loading a save) yields identical values; module state is only a cache key.
 */
import type { Simulation } from './simulation';
import { LIMITS } from './constants';
import { tileCapacity } from './ecology';
import { infect } from './disease';
import { DISASTER_KINDS, TERRAIN, type Agent, type Disaster, type DisasterKind } from './types';

/** Human-readable explanations (shown in the UI). */
export const DISASTER_INFO: Record<DisasterKind, { label: string; icon: string; help: string }> = {
  drought: { label: 'Drought', icon: '☀', help: 'Plant regrowth collapses inside the area for the duration.' },
  blight: { label: 'Blight', icon: '☣', help: 'Resource collapse: destroys standing food and damages soil fertility.' },
  bloom: { label: 'Abundance', icon: '✿', help: 'Food bursts to capacity and regrowth is boosted for a while.' },
  plague: { label: 'Plague', icon: '✚', help: 'Infects agents in the area with a contagious disease.' },
  meteor: { label: 'Meteor', icon: '☄', help: 'Kills agents at the impact point, scorches terrain and food.' },
  coldsnap: { label: 'Cold snap', icon: '❄', help: 'Temperature plunges: higher metabolic cost and stunted growth.' },
};

/** Tunable disaster constants. */
export const DISASTER_TUNING = {
  /** Hard cap on stored disasters (active + fading). */
  maxDisasters: 64,
  /** Finished disasters are kept this many ticks for render fade-out. */
  fadeTicks: 100,
  /** climateMod is recomputed when the active set changes and on multiples of this tick count. */
  climateInterval: 30,
  /** Effects fade out over the last rampOutFrac of the duration (at most rampOutMax ticks). */
  rampOutFrac: 0.15,
  rampOutMax: 120,
  /** Full effect inside edgeInner·radius, smooth falloff to 0 at the radius. */
  edgeInner: 0.75,
  maxClimateMod: 5,
  minTempOffset: -35,
  /** Expected random disasters per in-game day at disasterRate = 1. */
  randomPerDay: 0.5,
  /** No random disaster starts while this many are active. */
  randomMaxActive: 6,
  randomWeights: [
    ['drought', 0.3],
    ['blight', 0.15],
    ['plague', 0.2],
    ['coldsnap', 0.15],
    ['meteor', 0.1],
    ['bloom', 0.1],
  ] as [DisasterKind, number][],
  randomRadius: [120, 350] as [number, number],
  randomMeteorRadius: [50, 130] as [number, number],
  randomIntensity: [0.4, 1] as [number, number],
  randomDays: [1, 3] as [number, number],
  /** Chance a random cold snap is global. */
  randomGlobalColdsnap: 0.3,
  meteorKillFrac: 0.45,
  meteorDamage: 40,
  meteorDuration: 60,
  plagueGlobalFrac: 0.06,
  plagueGlobalMin: 3,
  /** Local plague areas stay contagious: chance per check per susceptible agent inside (× intensity). */
  plagueReservoir: 0.025,
  reservoirInterval: 30,
};
const T = DISASTER_TUNING;

// ---------------------------------------------------------------- helpers

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dayLength(sim: Simulation): number {
  const dl = sim.config.dayLength;
  return dl > 0 ? dl : 600;
}

function configVirulence(sim: Simulation): number {
  const v = sim.config.diseaseVirulence;
  return v > 0 ? Math.min(v, 5) : 0;
}

function immunityOf(a: Agent): number {
  const v = a.traits.immunity;
  return v >= 0 ? (v <= 1 ? v : 1) : Number.isNaN(v) ? 0.5 : 0;
}

/** Regrowth multiplier of a disaster at full strength (1 = no climate effect). */
function climateFactor(d: Disaster): number {
  switch (d.kind) {
    case 'drought':
      return 1 - 0.9 * d.intensity;
    case 'blight':
      return 1 - 0.6 * d.intensity;
    case 'bloom':
      return 1 + 2 * d.intensity;
    case 'coldsnap':
      return 0.5;
    default:
      return 1;
  }
}

/** 0..1 strength of an active disaster's ongoing effects at tick t (gradual recovery at the end). */
function envelope(d: Disaster, t: number): number {
  const ramp = Math.max(1, Math.min(T.rampOutMax, d.duration * T.rampOutFrac));
  const remaining = d.startTick + d.duration - t;
  return remaining >= ramp ? 1 : remaining <= 0 ? 0 : remaining / ramp;
}

/** 1 inside edgeInner·r, smoothstep down to 0 at r. */
function edgeWeight(dist: number, r: number): number {
  if (r <= 0) return 1;
  if (dist >= r) return 0;
  const inner = r * T.edgeInner;
  if (dist <= inner) return 1;
  const t = (r - dist) / (r - inner);
  return t * t * (3 - 2 * t);
}

/** Visit every tile whose centre lies within r of (x,y) (all tiles when r <= 0). */
function forEachTile(sim: Simulation, x: number, y: number, r: number, fn: (idx: number, dist: number) => void): void {
  const w = sim.state.world;
  if (r <= 0) {
    const n = w.width * w.height;
    for (let i = 0; i < n; i++) fn(i, 0);
    return;
  }
  const ts = w.tileSize;
  const tx0 = Math.max(0, Math.floor((x - r) / ts));
  const tx1 = Math.min(w.width - 1, Math.floor((x + r) / ts));
  const ty0 = Math.max(0, Math.floor((y - r) / ts));
  const ty1 = Math.min(w.height - 1, Math.floor((y + r) / ts));
  const r2 = r * r;
  for (let ty = ty0; ty <= ty1; ty++) {
    const dy = (ty + 0.5) * ts - y;
    for (let tx = tx0; tx <= tx1; tx++) {
      const dx = (tx + 0.5) * ts - x;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) fn(ty * w.width + tx, Math.sqrt(d2));
    }
  }
}

function pushHistory(sim: Simulation, a: Agent, text: string): void {
  a.history.push({ tick: sim.state.tick, text });
  if (a.history.length > LIMITS.history) a.history.splice(0, a.history.length - LIMITS.history);
}

function addDanger(a: Agent, x: number, y: number, value: number, tick: number): void {
  const mem = a.memory.danger;
  mem.push({ x, y, value, tick });
  if (mem.length > LIMITS.dangerMemory) mem.splice(0, mem.length - LIMITS.dangerMemory);
}

function inside(d: Disaster, x: number, y: number): boolean {
  if (d.radius <= 0) return true;
  const dx = x - d.x;
  const dy = y - d.y;
  return dx * dx + dy * dy <= d.radius * d.radius;
}

// ---------------------------------------------------------------- climate (regrowth + temperature)

/** Cache of the active-set signature last used to compute climateMod (perf only). */
const climateCache = new WeakMap<Simulation, string>();

function climateSignature(list: Disaster[]): string {
  let sig = '';
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (d.active && climateFactor(d) !== 1) sig += d.id + ',';
  }
  return sig;
}

/** Recompute world.climateMod from all active disasters. */
function refreshClimate(sim: Simulation): void {
  const s = sim.state;
  const w = s.world;
  const n = w.width * w.height;
  if (!(w.climateMod instanceof Float32Array) || w.climateMod.length !== n) w.climateMod = new Float32Array(n);
  const mod = w.climateMod;
  mod.fill(1);
  const qt = s.tick - (s.tick % T.climateInterval);
  let touched = false;
  for (const d of s.disasters) {
    if (!d.active) continue;
    const f = climateFactor(d);
    if (f === 1) continue;
    const e = envelope(d, Math.max(qt, d.startTick));
    if (e <= 0) continue;
    const delta = (f - 1) * e;
    touched = true;
    if (d.radius <= 0) {
      const k = 1 + delta;
      for (let i = 0; i < n; i++) mod[i] *= k;
    } else {
      const r = d.radius;
      forEachTile(sim, d.x, d.y, r, (i, dist) => {
        const wt = edgeWeight(dist, r);
        if (wt > 0) mod[i] *= 1 + delta * wt;
      });
    }
  }
  if (touched) {
    for (let i = 0; i < n; i++) {
      const m = mod[i];
      if (!(m >= 0)) mod[i] = m < 0 ? 0 : 1;
      else if (m > T.maxClimateMod) mod[i] = T.maxClimateMod;
    }
  }
  climateCache.set(sim, climateSignature(s.disasters));
}

/** Magnitude (°C at intensity 1) of a cold snap: global 20°, local 12–20° growing with radius. */
function coldMagnitude(d: Disaster): number {
  return d.radius <= 0 ? 20 : 12 + 8 * Math.min(1, d.radius / 400);
}

/** Combined temperature offset of all active cold snaps at tick t. */
function coldOffset(sim: Simulation, t: number): number {
  let off = 0;
  for (const d of sim.state.disasters) {
    if (d.active && d.kind === 'coldsnap') off -= coldMagnitude(d) * d.intensity * envelope(d, t);
  }
  return off < T.minTempOffset ? T.minTempOffset : off === 0 ? 0 : off;
}

// ---------------------------------------------------------------- immediate effects

function blightArea(sim: Simulation, d: Disaster): void {
  const w = sim.state.world;
  const I = d.intensity;
  forEachTile(sim, d.x, d.y, d.radius, (i, dist) => {
    const wt = edgeWeight(dist, d.radius);
    if (wt <= 0) return;
    const f = w.food[i] * (1 - wt * (0.95 + 0.05 * I));
    w.food[i] = f > 0 ? f : 0;
    w.fertility[i] *= 1 - 0.6 * I * wt;
    w.baseFertility[i] *= 1 - 0.12 * I * wt;
  });
}

function bloomArea(sim: Simulation, d: Disaster): void {
  const w = sim.state.world;
  forEachTile(sim, d.x, d.y, d.radius, (i, dist) => {
    const wt = edgeWeight(dist, d.radius);
    if (wt <= 0) return;
    const cap = tileCapacity(sim, i);
    if (!(cap > 0)) return;
    const target = cap * wt;
    if (!(w.food[i] >= target)) w.food[i] = target;
  });
}

/** Infect agents in the area (global: a random ~6% of agents). Returns the number infected. */
function plagueOutbreak(sim: Simulation, d: Disaster): number {
  const v = d.intensity * configVirulence(sim);
  if (!(v > 0)) return 0;
  const rng = sim.rng;
  const agents = sim.state.agents;
  let n = 0;
  if (d.radius <= 0) {
    const cands: Agent[] = [];
    let alive = 0;
    for (const a of agents) {
      if (!a.alive) continue;
      alive++;
      if (a.infection <= 0 && !(a.immuneTicks > 0)) cands.push(a);
    }
    const k = Math.min(cands.length, Math.max(T.plagueGlobalMin, Math.round(alive * T.plagueGlobalFrac)));
    for (let i = 0; i < k; i++) {
      const j = i + rng.int(cands.length - i);
      const t = cands[j];
      cands[j] = cands[i];
      cands[i] = t;
      if (infect(sim, t, v)) n++;
    }
    return n;
  }
  const p0 = 0.3 + 0.5 * d.intensity;
  let nearest: Agent | null = null;
  let nearestD2 = Infinity;
  const r2 = d.radius * d.radius;
  for (const a of agents) {
    if (!a.alive || a.infection > 0 || a.immuneTicks > 0) continue;
    const dx = a.x - d.x;
    const dy = a.y - d.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    if (d2 < nearestD2) {
      nearestD2 = d2;
      nearest = a;
    }
    if (rng.next() < p0 * (1 - 0.5 * immunityOf(a)) && infect(sim, a, v)) n++;
  }
  // A plague dropped on a group always takes hold somewhere.
  if (n === 0 && nearest && infect(sim, nearest, v)) n++;
  return n;
}

/** Kills, injuries, danger memories and crater. Returns [killed, injured]. */
function meteorImpact(sim: Simulation, d: Disaster): [number, number] {
  const s = sim.state;
  const w = s.world;
  const r = d.radius;
  const I = d.intensity;
  const killR = r * T.meteorKillFrac;
  const r2 = r * r;
  const k2 = killR * killR;
  const warn2 = 4 * r2;
  const victims: Agent[] = [];
  let injured = 0;
  for (const a of s.agents) {
    if (!a.alive) continue;
    const dx = a.x - d.x;
    const dy = a.y - d.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > warn2) continue;
    if (d2 <= k2) {
      victims.push(a);
      continue;
    }
    if (d2 <= r2) {
      const fall = clamp(1 - (Math.sqrt(d2) - killR) / Math.max(1e-6, r - killR), 0, 1);
      a.health -= T.meteorDamage * I * fall;
      if (!(a.health > 0)) {
        victims.push(a);
        continue;
      }
      injured++;
      pushHistory(sim, a, 'Survived a meteor strike');
    }
    addDanger(a, d.x, d.y, 1, s.tick);
  }
  // Kill after the scan: outside a tick killAgent compacts s.agents immediately.
  for (const v of victims) sim.killAgent(v, 'disaster');

  // Crater: rock core, sand rim, scorched surroundings. Water is left as water.
  let changed = false;
  const core = r * 0.3;
  const rim = r * 0.55;
  forEachTile(sim, d.x, d.y, r, (i, dist) => {
    const t = w.terrain[i];
    const wet = t === TERRAIN.DeepWater || t === TERRAIN.Water;
    if (dist <= rim) {
      w.food[i] = 0;
      if (dist <= core) {
        if (!wet && t !== TERRAIN.Rock) {
          w.terrain[i] = TERRAIN.Rock;
          changed = true;
        }
        w.fertility[i] *= 0.1;
      } else {
        if (!wet && t !== TERRAIN.Rock && t !== TERRAIN.Sand) {
          w.terrain[i] = TERRAIN.Sand;
          changed = true;
        }
        w.fertility[i] *= 0.3;
      }
    } else {
      const k = I * (1 - dist / r);
      const f = w.food[i] * (1 - 0.8 * k);
      w.food[i] = f > 0 ? f : 0;
      w.fertility[i] *= 1 - 0.5 * k;
    }
  });
  const ci = sim.tileIndex(sim.clampX(d.x), sim.clampY(d.y));
  if (ci >= 0) {
    const t = w.terrain[ci];
    if (t !== TERRAIN.DeepWater && t !== TERRAIN.Water && t !== TERRAIN.Rock) {
      w.terrain[ci] = TERRAIN.Rock;
      changed = true;
    }
    w.food[ci] = 0;
  }
  if (changed) w.terrainVersion++;
  return [victims.length, injured];
}

function article(d: Disaster, noun: string): string {
  const adj = d.intensity >= 0.8 ? 'severe ' : d.intensity < 0.5 ? 'mild ' : '';
  return `A ${adj}${noun}`;
}

function applyImmediate(sim: Simulation, d: Disaster): void {
  const at = { x: d.x, y: d.y };
  const big = d.radius <= 0 || d.radius >= 250 || d.intensity >= 0.85;
  const where = d.radius <= 0 ? ' across the whole world' : '';
  const sev = big ? 'major' : 'bad';
  switch (d.kind) {
    case 'drought':
      sim.log('disaster', sev, `${article(d, 'drought')} strikes${where} — plant regrowth down ${Math.round(90 * d.intensity)}%`, at);
      break;
    case 'blight':
      blightArea(sim, d);
      sim.log('disaster', sev, `${article(d, 'blight')} strikes${where} — crops wither and the soil sickens`, at);
      break;
    case 'bloom':
      bloomArea(sim, d);
      sim.log('disaster', 'good', `A season of abundance${where} — plants burst into bloom`, at);
      break;
    case 'plague': {
      const n = plagueOutbreak(sim, d);
      const v = Math.min(1, d.intensity * configVirulence(sim));
      if (n > 0) {
        sim.log('disease', n >= 20 || d.radius <= 0 ? 'major' : 'bad', `Plague outbreak${where} — ${n} infected (virulence ${v.toFixed(2)})`, at);
      } else {
        sim.log('disease', 'info', 'A plague outbreak fails to take hold', at);
      }
      break;
    }
    case 'meteor': {
      const [killed, injured] = meteorImpact(sim, d);
      sim.log('disaster', 'major', `Meteor strike! ${killed} killed, ${injured} injured`, at);
      break;
    }
    case 'coldsnap':
      sim.log('disaster', sev, `${article(d, 'cold snap')} grips the land — temperatures plunge ${Math.round(coldMagnitude(d) * d.intensity)}°`, at);
      break;
  }
}

function logEnd(sim: Simulation, d: Disaster): void {
  const at = { x: d.x, y: d.y };
  switch (d.kind) {
    case 'drought':
      sim.log('disaster', 'good', 'The drought has broken — plants can regrow', at);
      break;
    case 'blight':
      sim.log('disaster', 'good', 'The blight has run its course; the soil begins to recover', at);
      break;
    case 'bloom':
      sim.log('disaster', 'info', 'The season of abundance has ended', at);
      break;
    case 'coldsnap':
      sim.log('disaster', 'good', 'The cold snap has ended; temperatures recover', at);
      break;
    case 'plague':
      if (d.radius > 0) sim.log('disease', 'info', 'The plague-ridden area is no longer contagious', at);
      break;
    default:
      break;
  }
}

/** Keep the disaster list bounded: drop the oldest finished ones first, then the oldest active. */
function enforceCap(list: Disaster[]): void {
  while (list.length > T.maxDisasters) {
    let idx = list.findIndex((d) => !d.active);
    if (idx < 0) idx = 0;
    list.splice(idx, 1);
  }
}

// ---------------------------------------------------------------- public API

/**
 * Start a disaster (from interventions, scenarios or random events). radius <= 0 = global.
 * Inputs are clamped: intensity 0.05..1, duration 1 tick..60 days; meteors are always
 * local (default radius 100, max 400) and last 60 ticks (impact effects are immediate).
 */
export function startDisaster(
  sim: Simulation,
  kind: DisasterKind,
  x: number,
  y: number,
  radius: number,
  intensity: number,
  duration: number,
): Disaster {
  const s = sim.state;
  if (!Array.isArray(s.disasters)) s.disasters = [];
  if (!DISASTER_KINDS.includes(kind)) kind = 'drought';
  if (!(s.nextDisasterId >= 1)) s.nextDisasterId = 1 + s.disasters.reduce((m, d) => Math.max(m, d.id), 0);
  const ts = s.world.tileSize;
  const cx = Number.isFinite(x) ? clamp(x, 0, sim.worldW) : sim.worldW / 2;
  const cy = Number.isFinite(y) ? clamp(y, 0, sim.worldH) : sim.worldH / 2;
  let r = Number.isFinite(radius) && radius > 0 ? clamp(radius, ts, Math.hypot(sim.worldW, sim.worldH)) : 0;
  if (kind === 'meteor') r = r > 0 ? clamp(r, 2 * ts, 400) : 100;
  const I = Number.isFinite(intensity) ? clamp(intensity, 0.05, 1) : 0.6;
  const dayLen = dayLength(sim);
  let dur = Number.isFinite(duration) ? Math.round(clamp(duration, 1, 60 * dayLen)) : 2 * dayLen;
  if (kind === 'meteor') dur = T.meteorDuration;

  const d: Disaster = { id: s.nextDisasterId++, kind, x: cx, y: cy, radius: r, startTick: s.tick, duration: dur, intensity: I, active: true };
  s.disasters.push(d);
  enforceCap(s.disasters);
  applyImmediate(sim, d);
  refreshClimate(sim);
  s.env.tempOffset = coldOffset(sim, s.tick);
  return d;
}

/** Progress active disasters, maintain world.climateMod / env.tempOffset, spawn random disasters. */
export function updateDisasters(sim: Simulation): void {
  const s = sim.state;
  if (!Array.isArray(s.disasters)) s.disasters = [];
  const list = s.disasters;
  const tick = s.tick;

  // 1. expire finished disasters; drop them after the render fade-out window
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (d.active && tick >= d.startTick + d.duration) {
      d.active = false;
      logEnd(sim, d);
    }
    if (d.active || tick - (d.startTick + d.duration) < T.fadeTicks) list[w++] = d;
  }
  list.length = w;

  // 2. random disasters
  maybeRandomDisaster(sim);

  // 3. ongoing effects: local plague zones stay contagious
  plagueReservoirs(sim);

  // 4. regrowth modifiers (only when the active set changes, or periodically for fade-outs)
  const sig = climateSignature(list);
  const cached = climateCache.get(sim);
  if (cached === undefined || cached !== sig || (sig !== '' && tick % T.climateInterval === 0)) refreshClimate(sim);

  // 5. temperature
  s.env.tempOffset = coldOffset(sim, tick);
}

function plagueReservoirs(sim: Simulation): void {
  const s = sim.state;
  const cfgV = configVirulence(sim);
  if (cfgV <= 0) return;
  for (const d of s.disasters) {
    if (!d.active || d.kind !== 'plague' || d.radius <= 0) continue;
    const age = s.tick - d.startTick;
    if (age <= 0 || age % T.reservoirInterval !== 0) continue;
    const p = T.plagueReservoir * d.intensity;
    const v = d.intensity * cfgV;
    const r2 = d.radius * d.radius;
    for (const a of s.agents) {
      if (!a.alive || a.infection > 0 || a.immuneTicks > 0) continue;
      const dx = a.x - d.x;
      const dy = a.y - d.y;
      if (dx * dx + dy * dy > r2) continue;
      if (sim.rng.next() < p * (1 - 0.8 * immunityOf(a))) infect(sim, a, v);
    }
  }
}

function pickKind(u: number): DisasterKind {
  let total = 0;
  for (const [, wgt] of T.randomWeights) total += wgt;
  let acc = 0;
  for (const [kind, wgt] of T.randomWeights) {
    acc += wgt / total;
    if (u < acc) return kind;
  }
  return T.randomWeights[T.randomWeights.length - 1][0];
}

/** Half the time near a random agent (disasters hit where life is), otherwise a random land tile. */
function pickLocation(sim: Simulation, radius: number): { x: number; y: number } {
  const rng = sim.rng;
  const agents = sim.state.agents;
  if (agents.length > 0 && rng.next() < 0.5) {
    const a = agents[rng.int(agents.length)];
    const ang = rng.next() * Math.PI * 2;
    const off = rng.next() * Math.max(20, radius) * 0.4;
    return { x: sim.clampX(a.x + Math.cos(ang) * off), y: sim.clampY(a.y + Math.sin(ang) * off) };
  }
  let x = sim.worldW / 2;
  let y = sim.worldH / 2;
  for (let k = 0; k < 12; k++) {
    x = rng.next() * sim.worldW;
    y = rng.next() * sim.worldH;
    const t = sim.terrainAt(x, y);
    if (t !== -1 && t !== TERRAIN.DeepWater && t !== TERRAIN.Water && t !== TERRAIN.Wall) break;
  }
  return { x, y };
}

function maybeRandomDisaster(sim: Simulation): void {
  const rate = sim.config.disasterRate;
  if (!(rate > 0)) return;
  const dayLen = dayLength(sim);
  const rng = sim.rng;
  if (rng.next() >= Math.min(1, (rate * T.randomPerDay) / dayLen)) return;
  let active = 0;
  for (const d of sim.state.disasters) if (d.active) active++;
  if (active >= T.randomMaxActive) return;
  const kind = pickKind(rng.next());
  const [r0, r1] = kind === 'meteor' ? T.randomMeteorRadius : T.randomRadius;
  let radius = rng.range(r0, r1);
  if (kind === 'coldsnap' && rng.next() < T.randomGlobalColdsnap) radius = 0;
  const intensity = rng.range(T.randomIntensity[0], T.randomIntensity[1]);
  const duration = Math.round(rng.range(T.randomDays[0], T.randomDays[1]) * dayLen);
  const pos = pickLocation(sim, radius);
  startDisaster(sim, kind, pos.x, pos.y, radius, intensity, duration);
}

/**
 * The most relevant active disaster covering (x,y), or null. Local disasters take
 * precedence over global ones, then higher intensity. (For the UI and agent brains.)
 */
export function activeDisasterAt(sim: Simulation, x: number, y: number): Disaster | null {
  let best: Disaster | null = null;
  let bestScore = -Infinity;
  for (const d of sim.state.disasters) {
    if (!d.active || !inside(d, x, y)) continue;
    const score = d.intensity + (d.radius > 0 ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Fraction 0..1 of the disaster's lifetime elapsed (≥ 1 once finished) — handy for rendering. */
export function disasterProgress(sim: Simulation, d: Disaster): number {
  return d.duration > 0 ? Math.max(0, (sim.state.tick - d.startTick) / d.duration) : 1;
}
