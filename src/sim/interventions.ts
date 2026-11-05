// OWNER: Simulation Core agent.
/**
 * User / scenario interventions. Every handler validates its (possibly
 * deserialised, hand-edited) input, is deterministic (randomness only from
 * sim.rng, agents walked in array order) and logs a short 'intervention' event.
 */
import type { Simulation } from './simulation';
import { DEFAULT_CONFIG, PARAM_SPECS } from './config';
import { TERRAIN_INFO } from './constants';
import { DISASTER_INFO, startDisaster } from './disasters';
import { expressTraits, randomGenes } from './genetics';
import { addHistory, createAgent } from './lifecycle';
import { foundTribe, joinTribe } from './social';
import { defaultFertility, findPassableNear } from './world';
import {
  DISASTER_KINDS,
  NONE,
  TERRAIN_COUNT,
  type Agent,
  type DisasterKind,
  type Intervention,
  type SimConfig,
  type SpawnSpec,
  type TerrainType,
  type Tribe,
} from './types';

/** One-sentence explanations of every intervention (for tooltips / help panels). */
export const INTERVENTION_HELP: Record<Intervention['kind'], string> = {
  spawn: 'Drop a group of new adult agents with the chosen genetics, unaffiliated, as a brand-new tribe or as reinforcements for an existing one.',
  remove: 'Remove every agent inside the brush circle from the world.',
  killAgent: 'Remove one specific agent from the world.',
  addFood: "Add food to every tile under the brush (up to 1.5x the tile's normal capacity).",
  removeFood: 'Strip all standing food from the tiles under the brush, creating an instant famine zone.',
  paintTerrain: 'Reshape the land by painting terrain; agents caught on newly impassable tiles are pushed to the nearest open ground.',
  fertilize: 'Enrich the soil under the brush so it holds more food and regrows faster (negative amounts deplete it).',
  disaster: 'Unleash a drought, blight, bloom, plague, meteor or cold snap centred on a point (radius 0 = whole world).',
  setConfig: 'Change simulation parameters such as mutation rate, plant regrowth or aggression while the run continues.',
  boostAgent: 'Fully heal, feed and rest one specific agent.',
};

// ------------------------------------------------------------------ helpers

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const isPoint = (x: unknown, y: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y);
const fmt = (v: number): string => String(Math.round(v * 100) / 100);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Largest float32 <= v, so values stored in Float32Arrays never exceed their clamp. */
function f32AtMost(v: number): number {
  const r = Math.fround(v);
  return r <= v ? r : Math.fround(v - Math.abs(v) * 1.2e-7);
}
/** Upper bound for (base) fertility raised by fertilize. */
const MAX_FERTILITY = f32AtMost(1.2);
/** Clamp a fertility value to [0, 1.2], snapping float32 residue near zero to 0. */
const clampFertility = (v: number): number => {
  const c = clamp(v, 0, MAX_FERTILITY);
  return c < 1e-6 ? 0 : c;
};

/** Food capacity of a tile (same formula as ecology.tileCapacity). */
function capacity(sim: Simulation, i: number): number {
  const w = sim.state.world;
  return TERRAIN_INFO[w.terrain[i] as TerrainType].maxFood * w.fertility[i] * sim.config.foodCapacity;
}

/** Brush radius in world units: finite, >= 0, at most the world's larger dimension. */
function brushRadius(sim: Simulation, r: unknown): number {
  return clamp(num(r, 0), 0, Math.max(sim.worldW, sim.worldH));
}

/**
 * Call fn for every tile whose centre lies within `radius` of (x, y); the tile
 * under (x, y) is always included. Returns the number of tiles visited.
 */
function forTilesInRadius(sim: Simulation, x: number, y: number, radius: number, fn: (i: number) => void): number {
  const w = sim.state.world;
  const ts = w.tileSize;
  const tx0 = Math.max(0, Math.floor((x - radius) / ts));
  const tx1 = Math.min(w.width - 1, Math.floor((x + radius) / ts));
  const ty0 = Math.max(0, Math.floor((y - radius) / ts));
  const ty1 = Math.min(w.height - 1, Math.floor((y + radius) / ts));
  const r2 = radius * radius;
  const centre = sim.tileIndex(x, y);
  let n = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const i = ty * w.width + tx;
      const dx = (tx + 0.5) * ts - x;
      const dy = (ty + 0.5) * ts - y;
      if (dx * dx + dy * dy <= r2 || i === centre) {
        fn(i);
        n++;
      }
    }
  }
  if (n === 0 && centre >= 0) {
    fn(centre);
    n = 1;
  }
  return n;
}

/** Living agents within radius of (x, y), in array order (safe to kill afterwards). */
function agentsInRadius(sim: Simulation, x: number, y: number, radius: number): Agent[] {
  const out: Agent[] = [];
  const r2 = radius * radius;
  for (const a of sim.state.agents) {
    if (!a.alive) continue;
    const dx = a.x - x;
    const dy = a.y - y;
    if (dx * dx + dy * dy <= r2) out.push(a);
  }
  return out;
}

// ------------------------------------------------------------------ main entry

/** Apply one intervention immediately (called by Simulation at tick start). Must be deterministic. */
export function applyIntervention(sim: Simulation, iv: Intervention): void {
  if (!iv || typeof iv !== 'object') return;
  switch (iv.kind) {
    case 'spawn':
      spawn(sim, iv);
      break;
    case 'remove':
      remove(sim, iv.x, iv.y, iv.radius);
      break;
    case 'killAgent': {
      const a = sim.getAgent(iv.id);
      if (!a) break;
      sim.killAgent(a, 'removed');
      sim.log('intervention', 'bad', `${a.name} was removed`, { x: a.x, y: a.y, agentId: a.id });
      break;
    }
    case 'boostAgent': {
      const a = sim.getAgent(iv.id);
      if (!a) break;
      a.health = num(a.traits.maxHealth, a.health);
      a.food = num(a.traits.maxFood, a.food);
      a.energy = 1;
      if (a.sinceMeal !== undefined) a.sinceMeal = 0;
      addHistory(sim, a, 'Healed and fed by the experimenter');
      sim.log('intervention', 'good', `${a.name} was healed and fed`, { x: a.x, y: a.y, agentId: a.id });
      break;
    }
    case 'addFood':
      addFood(sim, iv.x, iv.y, iv.radius, iv.amount);
      break;
    case 'removeFood':
      removeFood(sim, iv.x, iv.y, iv.radius);
      break;
    case 'fertilize':
      fertilize(sim, iv.x, iv.y, iv.radius, iv.amount);
      break;
    case 'paintTerrain':
      paintTerrain(sim, iv.x, iv.y, iv.radius, iv.terrain);
      break;
    case 'disaster':
      disaster(sim, iv.disaster, iv.x, iv.y, iv.radius, iv.intensity, iv.duration);
      break;
    case 'setConfig':
      setConfig(sim, iv.patch);
      break;
    default:
      break; // unknown kinds (corrupt saves) are ignored
  }
}

// ------------------------------------------------------------------ spawn

function spawn(sim: Simulation, iv: SpawnSpec): void {
  const count = clamp(Math.floor(num(iv.count, 0)), 0, 5000);
  if (count === 0 || !isPoint(iv.x, iv.y)) return;
  const ts = sim.state.world.tileSize;
  const radius = Math.max(brushRadius(sim, iv.radius), ts * 0.75); // never stack agents on one point
  const cx = sim.clampX(iv.x);
  const cy = sim.clampY(iv.y);
  const search = Math.max(radius, ts * 4) + ts * 40;
  const made: Agent[] = [];
  let capped = false;
  for (let k = 0; k < count; k++) {
    if (!sim.canSpawn()) {
      capped = true;
      break;
    }
    // uniform point in the disc (rejection sampling keeps it trig-free)
    let dx = 0;
    let dy = 0;
    do {
      dx = sim.rng.next() * 2 - 1;
      dy = sim.rng.next() * 2 - 1;
    } while (dx * dx + dy * dy > 1);
    const px = sim.clampX(cx + dx * radius);
    const py = sim.clampY(cy + dy * radius);
    const p = findPassableNear(sim, px, py, search, true) ?? findPassableNear(sim, px, py, search, false);
    if (!p) continue;
    const genes = randomGenes(sim.rng, iv.template);
    const traits = expressTraits(genes);
    const maturity = Math.max(0, num(traits.maturityAge, 600));
    let age = Math.round(maturity * (1 + 0.2 * sim.rng.next())); // young adults
    const longevity = num(traits.longevity, Infinity);
    if (age > longevity * 0.5) age = Math.floor(longevity * 0.5);
    const food = Math.max(0, num(traits.maxFood, 100)) * 0.85;
    const a = createAgent(sim, { x: p.x, y: p.y, genes, age, food });
    sim.addAgent(a);
    made.push(a);
  }

  if (made.length === 0) {
    sim.log('intervention', 'bad', capped ? 'Spawn blocked: population cap reached' : 'Spawn failed: no open ground nearby', { x: cx, y: cy });
    return;
  }

  let tribe: Tribe | undefined;
  let founded = false;
  if (sim.config.tribesEnabled !== false) {
    if (iv.tribe === 'new') {
      const hueGene = iv.template?.hue;
      const hue = typeof hueGene === 'number' && Number.isFinite(hueGene) ? (clamp(hueGene, 0, 1) * 360) % 360 : undefined;
      const name = typeof iv.tribeName === 'string' && iv.tribeName.trim() ? iv.tribeName.trim().slice(0, 40) : undefined;
      tribe = foundTribe(sim, made[0], made.slice(1), name, hue);
      founded = true;
      // camp at the centre of the group rather than wherever the first founder landed
      let mx = 0;
      let my = 0;
      for (const a of made) {
        mx += a.x;
        my += a.y;
      }
      const home = findPassableNear(sim, mx / made.length, my / made.length, search, true);
      if (home) {
        tribe.homeX = home.x;
        tribe.homeY = home.y;
      }
    } else if (typeof iv.tribe === 'number') {
      const t = sim.getTribe(iv.tribe); // joinTribe revives a recently extinct tribe
      if (t) {
        tribe = t;
        for (const a of made) joinTribe(sim, a, t.id);
      }
    }
  }

  for (const a of made) {
    const rec = sim.lineageById.get(a.id);
    if (rec) rec.tribeId = a.tribeId;
    addHistory(sim, a, tribe ? (founded ? `Founded the ${tribe.name}` : `Arrived to join the ${tribe.name}`) : 'Arrived in the world');
  }

  let msg = `Spawned ${plural(made.length, 'agent')}`;
  if (tribe) msg += founded ? ` founding the ${tribe.name}` : ` into the ${tribe.name}`;
  if (made.length < count) msg += capped ? ' (population cap reached)' : ` (${count - made.length} found no room)`;
  sim.log('intervention', 'info', msg, { x: cx, y: cy, tribeId: tribe ? tribe.id : NONE });
}

// ------------------------------------------------------------------ agents

function remove(sim: Simulation, x: number, y: number, r: number): void {
  if (!isPoint(x, y)) return;
  const victims = agentsInRadius(sim, x, y, brushRadius(sim, r));
  for (const a of victims) sim.killAgent(a, 'removed');
  if (victims.length) sim.log('intervention', 'bad', `Removed ${plural(victims.length, 'agent')}`, { x, y });
}

// ------------------------------------------------------------------ food & soil

function addFood(sim: Simulation, x: number, y: number, r: number, amount: number): void {
  const amt = clamp(num(amount, 0), 0, 1e4);
  if (!isPoint(x, y) || amt <= 0) return;
  const food = sim.state.world.food;
  let total = 0;
  forTilesInRadius(sim, x, y, brushRadius(sim, r), (i) => {
    const cur = food[i] >= 0 ? food[i] : 0;
    const limit = f32AtMost(Math.max(0, capacity(sim, i) * 1.5));
    const next = Math.max(cur, Math.min(cur + amt, limit));
    food[i] = next;
    total += next - cur;
  });
  if (total > 0) sim.log('intervention', 'good', `Added ${fmt(total)} food`, { x, y });
}

function removeFood(sim: Simulation, x: number, y: number, r: number): void {
  if (!isPoint(x, y)) return;
  const food = sim.state.world.food;
  let total = 0;
  forTilesInRadius(sim, x, y, brushRadius(sim, r), (i) => {
    if (food[i] > 0) total += food[i];
    food[i] = 0;
  });
  sim.log('intervention', 'bad', `Destroyed ${fmt(total)} food`, { x, y });
}

function fertilize(sim: Simulation, x: number, y: number, r: number, amount: number): void {
  const amt = clamp(num(amount, 0), -1.2, 1.2);
  if (!isPoint(x, y) || amt === 0) return;
  const w = sim.state.world;
  let tiles = 0;
  forTilesInRadius(sim, x, y, brushRadius(sim, r), (i) => {
    if (TERRAIN_INFO[w.terrain[i] as TerrainType].maxFood <= 0) return; // barren by nature
    w.fertility[i] = clampFertility(num(w.fertility[i], 0) + amt);
    w.baseFertility[i] = clampFertility(num(w.baseFertility[i], 0) + amt);
    if (amt < 0) {
      const cap = Math.max(0, capacity(sim, i));
      if (!(w.food[i] <= cap)) w.food[i] = cap;
    }
    tiles++;
  });
  if (tiles > 0) sim.log('intervention', amt > 0 ? 'good' : 'bad', `${amt > 0 ? 'Fertilized' : 'Depleted'} ${plural(tiles, 'tile')} (${amt > 0 ? '+' : ''}${fmt(amt)})`, { x, y });
}

// ------------------------------------------------------------------ terrain

function paintTerrain(sim: Simulation, x: number, y: number, r: number, terrain: TerrainType): void {
  if (!isPoint(x, y) || typeof terrain !== 'number' || !Number.isInteger(terrain) || terrain < 0 || terrain >= TERRAIN_COUNT) return;
  const w = sim.state.world;
  const info = TERRAIN_INFO[terrain];
  const radius = brushRadius(sim, r);
  let changed = 0;
  forTilesInRadius(sim, x, y, radius, (i) => {
    if (w.terrain[i] === terrain) return;
    w.terrain[i] = terrain;
    const base = info.maxFood > 0 ? defaultFertility(terrain) : 0;
    w.baseFertility[i] = base;
    w.fertility[i] = base;
    const cap = Math.max(0, capacity(sim, i));
    if (info.maxFood <= 0) w.food[i] = 0;
    else if (!(w.food[i] <= cap)) w.food[i] = cap;
    changed++;
  });
  if (changed === 0) return;
  w.terrainVersion++;

  // agents (and camps) left on impassable ground move to the nearest open tile
  const ts = w.tileSize;
  const search = radius + ts * 24;
  let moved = 0;
  const doomed: Agent[] = [];
  for (const a of sim.state.agents) {
    if (!a.alive || sim.passableAt(a.x, a.y)) continue;
    const p = findPassableNear(sim, a.x, a.y, search);
    if (p) {
      a.x = p.x;
      a.y = p.y;
      a.vx = 0;
      a.vy = 0;
      a.decisionCooldown = 0;
      moved++;
    } else doomed.push(a);
  }
  for (const a of doomed) sim.killAgent(a, 'disaster');
  for (const t of sim.state.tribes) {
    if (t.extinctTick !== -1 || sim.passableAt(t.homeX, t.homeY)) continue;
    const p = findPassableNear(sim, t.homeX, t.homeY, search);
    if (p) {
      t.homeX = p.x;
      t.homeY = p.y;
    }
  }

  let msg = `Painted ${info.name.toLowerCase()} (${plural(changed, 'tile')})`;
  if (moved) msg += `, ${moved} displaced`;
  if (doomed.length) msg += `, ${doomed.length} trapped and killed`;
  sim.log('intervention', doomed.length ? 'bad' : 'info', msg, { x, y });
}

// ------------------------------------------------------------------ disasters

function disaster(sim: Simulation, kind: DisasterKind, x: number, y: number, r: number, intensity: number, duration: number): void {
  if (!DISASTER_KINDS.includes(kind)) return;
  const dx = sim.clampX(num(x, sim.worldW / 2));
  const dy = sim.clampY(num(y, sim.worldH / 2));
  const radius = brushRadius(sim, num(r, 80));
  const inten = clamp(num(intensity, 0.7), 0.05, 1);
  const dur = Math.round(clamp(num(duration, 600), 1, 100000));
  const label = DISASTER_INFO[kind]?.label ?? kind;
  // log the cause before startDisaster logs its immediate effects
  sim.log('intervention', kind === 'bloom' ? 'good' : 'bad', `${label} unleashed${radius === 0 ? ' worldwide' : ''}`, { x: dx, y: dy });
  startDisaster(sim, kind, dx, dy, radius, inten, dur);
}

// ------------------------------------------------------------------ config

/** Keys that define the world itself and can never change at runtime. */
const FROZEN_KEYS = new Set<keyof SimConfig>(['seed', 'worldWidth', 'worldHeight', 'tileSize']);
/** Integer-valued keys. */
const INT_KEYS = new Set<keyof SimConfig>(['maxAgents', 'dayLength', 'daysPerSeason']);
/** Ranges for numeric keys without a PARAM_SPEC. */
const EXTRA_RANGES: Partial<Record<keyof SimConfig, [number, number]>> = {
  dayLength: [60, 100000],
  daysPerSeason: [1, 1000],
};
const LABELS: Partial<Record<keyof SimConfig, string>> = {
  overgrazing: 'Overgrazing',
  dayNight: 'Day/night cycle',
  seasons: 'Seasons',
  dayLength: 'Day length',
  daysPerSeason: 'Days per season',
  tribesEnabled: 'Tribes',
};

function setConfig(sim: Simulation, patch: Partial<SimConfig>): void {
  if (!patch || typeof patch !== 'object') return;
  const cfg = sim.state.config as unknown as Record<string, number | boolean>;
  const changes: string[] = [];
  for (const key of Object.keys(patch) as (keyof SimConfig)[]) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key) || FROZEN_KEYS.has(key)) continue;
    const def = DEFAULT_CONFIG[key];
    const v: unknown = (patch as Record<string, unknown>)[key];
    const spec = PARAM_SPECS.find((s) => s.key === key);
    const label = spec?.label ?? LABELS[key] ?? key;
    if (typeof def === 'boolean') {
      if (typeof v !== 'boolean') continue;
      if (cfg[key] !== v) changes.push(`${label} ${v ? 'on' : 'off'}`);
      cfg[key] = v;
    } else if (typeof def === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const range: [number, number] | undefined = spec ? [spec.min, spec.max] : EXTRA_RANGES[key];
      let val = range ? clamp(v, range[0], range[1]) : v;
      if (INT_KEYS.has(key)) val = Math.round(val);
      if (cfg[key] !== val) changes.push(`${label} ${fmt(val)}`);
      cfg[key] = val;
    }
  }
  if (changes.length === 0) return;
  const shown = changes.slice(0, 3).join(', ') + (changes.length > 3 ? ` (+${changes.length - 3} more)` : '');
  sim.log('intervention', 'info', `Settings changed: ${shown}`);
}
