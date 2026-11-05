/**
 * SHARED CONTRACT — every module codes against these types.
 * Owned by the lead engineer. Do not rename or remove fields; if a module needs
 * extra per-agent/per-tribe data, add an OPTIONAL field in the clearly marked
 * "extension" blocks and mention it in your report.
 *
 * Everything inside `SimState` must be JSON-serialisable (typed arrays are
 * base64-encoded by persistence.ts). Derived indexes (maps, spatial hash) live
 * on the Simulation object, never in SimState.
 */

export type AgentId = number;
export type TribeId = number;
/** -1 means "none" for AgentId/TribeId references. */
export const NONE = -1;

// ---------------------------------------------------------------- terrain
export const TERRAIN = {
  DeepWater: 0,
  Water: 1,
  Sand: 2,
  Grass: 3,
  Forest: 4,
  Desert: 5,
  Rock: 6,
  Wall: 7,
} as const;
export type TerrainType = (typeof TERRAIN)[keyof typeof TERRAIN];
export const TERRAIN_COUNT = 8;

export interface TerrainInfo {
  name: string;
  passable: boolean;
  /** Movement speed multiplier (1 = normal, <1 slower). */
  moveCost: number;
  /** Max food a tile of this terrain can hold at fertility 1 (before config.foodCapacity). */
  maxFood: number;
  /** Intrinsic regrowth rate multiplier. */
  regen: number;
  /** Base RGB colour for rendering. */
  color: [number, number, number];
  description: string;
}

// ---------------------------------------------------------------- genetics
/** Genes are normalised floats in [0,1]. Index with GENE_INDEX / G. */
export const GENES = [
  'speed', // movement speed (costly)
  'size', // body size: strength + max health, costly metabolism
  'perception', // vision radius (mildly costly)
  'metabolism', // metabolic rate: high = faster healing/recovery but burns more food
  'aggression', // propensity to fight / steal
  'sociability', // desire for company, tribe affinity
  'altruism', // propensity to share food / help
  'fertility', // reproductive drive (more, cheaper offspring vs fewer, well-provisioned)
  'longevity', // max lifespan (costly upkeep)
  'immunity', // disease resistance (costly upkeep)
  'efficiency', // foraging efficiency: food gained per bite
  'hue', // neutral marker gene → visual colour (drifts, shows lineages)
] as const;
export type GeneName = (typeof GENES)[number];
export const GENE_COUNT = GENES.length;
export const G: Record<GeneName, number> = Object.fromEntries(GENES.map((g, i) => [g, i])) as Record<GeneName, number>;

/** Expressed phenotype in simulation units (computed from genes by genetics.expressTraits). */
export interface Traits {
  speed: number; // world units per tick at full stride (~0.5..2.2)
  size: number; // body scale (~0.6..1.6); render radius = 3 * size * growth
  perception: number; // vision radius in world units (~25..140)
  metabolism: number; // basal burn multiplier (~0.6..1.5)
  aggression: number; // 0..1
  sociability: number; // 0..1
  altruism: number; // 0..1
  fertility: number; // 0..1
  longevity: number; // max age in ticks
  immunity: number; // 0..1
  efficiency: number; // food per bite multiplier (~0.5..1.5)
  hue: number; // 0..360
  maxHealth: number;
  maxFood: number; // stomach capacity
  strength: number; // combat strength
  maturityAge: number; // ticks until adult
}

/** Partial gene template used to create populations with chosen genetics. Values are gene means in [0,1]. */
export type GenomeTemplate = Partial<Record<GeneName, number>> & {
  /** Std-dev of random variation around the template means (normalised units). Default 0.08. */
  spread?: number;
};

// ---------------------------------------------------------------- agents
export type ActionKind =
  | 'idle'
  | 'wander'
  | 'explore'
  | 'forage' // moving toward food
  | 'eat'
  | 'rest'
  | 'flee'
  | 'attack'
  | 'share'
  | 'mate'
  | 'socialize'
  | 'gohome'
  | 'deposit'
  | 'withdraw';

export const ACTIONS: ActionKind[] = [
  'idle', 'wander', 'explore', 'forage', 'eat', 'rest', 'flee', 'attack',
  'share', 'mate', 'socialize', 'gohome', 'deposit', 'withdraw',
];

export type DeathCause = 'starvation' | 'old_age' | 'combat' | 'disease' | 'disaster' | 'removed';
export const DEATH_CAUSES: DeathCause[] = ['starvation', 'old_age', 'combat', 'disease', 'disaster', 'removed'];

export type Role = 'none' | 'forager' | 'warrior' | 'caretaker' | 'explorer';

export interface Relationship {
  id: AgentId;
  /** -1 (enemy) .. +1 (close friend). */
  affinity: number;
  /** 0 = not kin, 1 = parent/child, 2 = sibling. */
  kin: 0 | 1 | 2;
  lastTick: number;
  interactions: number;
}

export interface MemorySpot {
  x: number;
  y: number;
  value: number;
  tick: number;
}

export interface AgentMemory {
  /** Remembered rich food locations (max ~4). */
  food: MemorySpot[];
  /** Remembered dangerous locations (attacks, disasters) (max ~3). */
  danger: MemorySpot[];
}

export interface LifeEvent {
  tick: number;
  text: string;
}

export interface Agent {
  id: AgentId;
  name: string;
  alive: boolean;
  generation: number;
  /** [motherId, fatherId]; NONE when founder. */
  parents: [AgentId, AgentId];
  birthTick: number;
  age: number; // ticks

  // kinematics (world units)
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number; // radians

  genes: number[]; // length GENE_COUNT, each in [0,1]
  traits: Traits;

  // vitals
  health: number; // 0..traits.maxHealth
  food: number; // stomach 0..traits.maxFood (hunger = 1 - food/maxFood)
  energy: number; // stamina 0..1 (fatigue; restored by resting)
  carried: number; // food carried for sharing / depositing (>= 0)

  // behaviour
  action: ActionKind;
  actionTicks: number; // ticks spent in current action
  targetX: number; // NaN when no positional target
  targetY: number;
  targetId: AgentId; // NONE when no agent target
  decisionCooldown: number; // ticks until next think()
  /** Utility scores of the last decision (for the inspector). */
  utilities: Partial<Record<ActionKind, number>>;
  /** Human-readable reason for the current action (for the inspector). */
  thought: string;

  // reproduction
  reproCooldown: number;
  offspring: number;
  children: AgentId[]; // capped list (most recent ~12)

  // social
  tribeId: TribeId;
  relationships: Relationship[]; // capped (~12)
  role: Role;
  skills: { forage: number; combat: number; social: number }; // 0..1, learned by doing

  // disease
  infection: number; // remaining infected ticks (0 = healthy)
  virulence: number; // virulence of current infection 0..1
  immuneTicks: number; // remaining acquired-immunity ticks

  memory: AgentMemory;
  history: LifeEvent[]; // capped (~20) personal life log

  // lifetime counters
  stats: { foodEaten: number; distance: number; kills: number; shared: number; received: number; fights: number };

  deathTick: number; // -1 while alive
  deathCause: DeathCause | null;
  lastAttackerId: AgentId;

  // ---- extension block (optional fields added by modules) ----
  /** Smoothed fear level 0..1 (brain). */
  fear?: number;
  /** Ticks since last meal (brain/lifecycle). */
  sinceMeal?: number;
}

export interface LineageRecord {
  id: AgentId;
  name: string;
  parents: [AgentId, AgentId];
  generation: number;
  birthTick: number;
  deathTick: number; // -1 alive
  deathCause: DeathCause | null;
  hue: number;
  tribeId: TribeId;
  offspring: number;
}

// ---------------------------------------------------------------- tribes
export interface Tribe {
  id: TribeId;
  name: string;
  hue: number; // tribe colour (0..360)
  foundedTick: number;
  founderId: AgentId;
  /** Camp / home location (world units). */
  homeX: number;
  homeY: number;
  /** Shared food store at camp (>= 0). */
  stockpile: number;
  members: number; // recomputed each social update
  peakMembers: number;
  totalJoined: number;
  extinctTick: number; // -1 while alive
  /** Inter-tribe attitude: -1 (war) .. +1 (allied). Keyed by other tribe id. */
  relations: Record<number, number>;
  territory: number; // tiles controlled (computed)
  /** Role counts (recomputed). */
  roles: Record<Role, number>;
  /** Mean genes of members (recomputed periodically). */
  meanGenes: number[];
  parentTribeId: TribeId; // NONE unless formed by fission
}

// ---------------------------------------------------------------- world
export interface WorldState {
  width: number; // tiles
  height: number; // tiles
  tileSize: number; // world units per tile
  terrain: Uint8Array; // TerrainType per tile
  food: Float32Array; // current food per tile (>= 0)
  fertility: Float32Array; // current soil fertility 0..1 (degrades when overgrazed)
  baseFertility: Float32Array; // natural fertility 0..1 (recovery target)
  elevation: Float32Array; // 0..1 (rendering/shading + generation)
  /** Per-tile multiplier on regrowth from active disasters (1 = normal). Written by disasters.ts. */
  climateMod: Float32Array;
  /** Owning tribe per tile (-1 none). Written by social.ts (periodically). */
  territory: Int16Array;
  /** Incremented whenever terrain changes (renderer re-caches). */
  terrainVersion: number;
}

export interface EnvState {
  timeOfDay: number; // 0..1 (0 = midnight, 0.5 = noon)
  daylight: number; // 0..1
  day: number; // days elapsed
  season: 0 | 1 | 2 | 3; // spring, summer, autumn, winter
  seasonProgress: number; // 0..1 within season
  year: number;
  /** Global temperature in °C-ish (seasonal + offsets). */
  temperature: number;
  /** Additive temperature offset from cold snaps etc. */
  tempOffset: number;
  /** Global food-regrowth multiplier from season (computed). */
  seasonGrowth: number;
}

export type DisasterKind = 'drought' | 'blight' | 'bloom' | 'plague' | 'meteor' | 'coldsnap';
export const DISASTER_KINDS: DisasterKind[] = ['drought', 'blight', 'bloom', 'plague', 'meteor', 'coldsnap'];

export interface Disaster {
  id: number;
  kind: DisasterKind;
  x: number; // world units (centre)
  y: number;
  /** Radius in world units; 0 = global. */
  radius: number;
  startTick: number;
  duration: number; // ticks
  intensity: number; // 0..1
  active: boolean;
}

// ---------------------------------------------------------------- config
export interface SimConfig {
  seed: number;
  worldWidth: number; // tiles
  worldHeight: number; // tiles
  tileSize: number; // world units per tile
  maxAgents: number; // hard population cap (performance)
  mutationRate: number; // per-gene mutation probability 0..1
  mutationSize: number; // std-dev of gaussian mutation (normalised gene units)
  reproductionRate: number; // multiplier on reproductive drive / cooldown speed
  foodRegen: number; // multiplier on plant regrowth
  foodCapacity: number; // multiplier on max food per tile
  difficulty: number; // multiplier on metabolic costs & harshness
  disasterRate: number; // random disaster frequency multiplier (0 = none)
  diseaseVirulence: number; // plague transmission/lethality multiplier
  aggressionBias: number; // global multiplier on willingness to fight
  cooperationBias: number; // global multiplier on willingness to share/cooperate
  overgrazing: boolean; // fertility degrades when tiles are stripped bare
  dayNight: boolean;
  seasons: boolean;
  dayLength: number; // ticks per day
  daysPerSeason: number;
  /** Max genetic distance (0..1) between mates — lower means faster speciation. */
  mateCompatibility: number;
  tribesEnabled: boolean;
}

// ---------------------------------------------------------------- interventions
export interface SpawnSpec {
  x: number;
  y: number;
  count: number;
  radius: number;
  template?: GenomeTemplate;
  /** 'new' founds a new tribe, 'none' = unaffiliated, number = join tribe id. */
  tribe?: 'new' | 'none' | number;
  tribeName?: string;
}

export type Intervention =
  | ({ kind: 'spawn' } & SpawnSpec)
  | { kind: 'remove'; x: number; y: number; radius: number }
  | { kind: 'killAgent'; id: AgentId }
  | { kind: 'addFood'; x: number; y: number; radius: number; amount: number }
  | { kind: 'removeFood'; x: number; y: number; radius: number }
  | { kind: 'paintTerrain'; x: number; y: number; radius: number; terrain: TerrainType }
  | { kind: 'fertilize'; x: number; y: number; radius: number; amount: number }
  | { kind: 'disaster'; disaster: DisasterKind; x: number; y: number; radius: number; intensity: number; duration: number }
  | { kind: 'setConfig'; patch: Partial<SimConfig> }
  | { kind: 'boostAgent'; id: AgentId }; // heal + feed a single agent

export interface InterventionRecord {
  tick: number;
  intervention: Intervention;
}

export interface ScheduledEvent {
  tick: number;
  intervention: Intervention;
  note?: string;
  /** If set, repeat every N ticks. */
  repeat?: number;
}

// ---------------------------------------------------------------- events
export type EventCategory =
  | 'population'
  | 'tribe'
  | 'conflict'
  | 'disaster'
  | 'disease'
  | 'evolution'
  | 'environment'
  | 'intervention'
  | 'record';

export interface SimEvent {
  id: number;
  tick: number;
  category: EventCategory;
  severity: 'info' | 'good' | 'bad' | 'major';
  message: string;
  x?: number;
  y?: number;
  agentId?: AgentId;
  tribeId?: TribeId;
}

// ---------------------------------------------------------------- stats
export interface StatsSample {
  tick: number;
  population: number;
  births: number; // since previous sample
  deaths: number; // since previous sample
  deathsByCause: Record<DeathCause, number>; // since previous sample
  avgHealth: number; // 0..1 (fraction of max)
  avgEnergy: number; // 0..1
  avgHunger: number; // 0..1
  avgAge: number; // ticks
  totalFood: number;
  avgFertility: number;
  infected: number;
  tribeCount: number;
  meanGeneration: number;
  maxGeneration: number;
  /** Mean of each gene (normalised 0..1), length GENE_COUNT. */
  geneMeans: number[];
  /** Std-dev of each gene, length GENE_COUNT. */
  geneStd: number[];
  /** HIST_BINS-bin histogram per gene (counts), length GENE_COUNT * HIST_BINS. */
  geneHist: number[];
  /** [tribeId, members] pairs for living tribes. */
  tribePops: [TribeId, number][];
  roles: Record<Role, number>;
  actions: Partial<Record<ActionKind, number>>;
  fights: number; // since previous sample
  shares: number; // since previous sample
}
export const HIST_BINS = 10;

export interface StatsCounters {
  births: number;
  deaths: number;
  deathsByCause: Record<DeathCause, number>;
  fights: number;
  shares: number;
}

export interface StatsState {
  sampleInterval: number; // ticks between samples
  samples: StatsSample[]; // capped ring (oldest dropped / downsampled)
  counters: StatsCounters; // accumulating since last sample
  totals: { births: number; deaths: number; peakPopulation: number; peakTick: number };
}

// ---------------------------------------------------------------- root state
export interface SimState {
  version: number; // save format version
  scenarioId: string;
  config: SimConfig;
  tick: number;
  rngState: number[];
  nextAgentId: number;
  nextTribeId: number;
  nextEventId: number;
  nextDisasterId: number;
  world: WorldState;
  env: EnvState;
  agents: Agent[];
  tribes: Tribe[]; // living + recently extinct (capped)
  lineage: LineageRecord[]; // capped registry of ancestors (for family trees)
  events: SimEvent[]; // capped
  disasters: Disaster[];
  scheduled: ScheduledEvent[];
  interventionLog: InterventionRecord[];
  stats: StatsState;
}

// ---------------------------------------------------------------- scenarios
/** Procedural world-generation knobs (world.ts). All optional; sensible defaults. */
export interface WorldGenOptions {
  /** Fraction-ish threshold for water (0..1). Default 0.3. */
  waterLevel?: number;
  /** Threshold controlling forest coverage (0..1). Default 0.5. */
  forestLevel?: number;
  /** Desert coverage (0..1). Default 0.15. */
  desertLevel?: number;
  /** Mountain coverage (0..1). Default 0.12. */
  mountainLevel?: number;
  /** Noise feature scale in tiles. Default 40. */
  noiseScale?: number;
  /** Global fertility multiplier (0..2). Default 1. */
  fertility?: number;
  /** 'none' | 'river' (vertical river with fords) | 'mountains' (vertical range with passes). */
  divide?: 'none' | 'river' | 'mountains';
  /** Fill the map edge with deep water (island). Default true. */
  island?: boolean;
  /** Initial food fill as fraction of capacity (0..1). Default 0.7. */
  initialFood?: number;
}

/** Declarative, serialisable experiment definition (presets.ts). */
export interface ScenarioDef {
  id: string;
  name: string;
  tagline: string;
  description: string;
  /** What the user should watch for. */
  lookFor: string[];
  config: Partial<SimConfig>;
  world: WorldGenOptions;
  populations: SpawnSpec[];
  scheduled: ScheduledEvent[];
}
