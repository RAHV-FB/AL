// OWNER: Persistence & Experiments engineer.
/**
 * Pre-built experiments. Each scenario is purely declarative (ScenarioDef): config overrides,
 * world-generation knobs, founding populations and scheduled events. Behaviour comes from the
 * simulation modules, so the scenarios automatically pick up improvements to them.
 *
 * Geometry: the default world is 200×125 tiles × 8 units = 1600×1000 world units, with deep water
 * around the edge (island). Populations are placed on likely-land coordinates away from the coast
 * (x 250–1350, y 200–800); the spawn intervention moves founders to the nearest passable tile.
 *
 * Time: dayLength 600 ticks (DEFAULT_CONFIG) → day N starts at tick 600·N. Every config value stays
 * inside its PARAM_SPECS range so saves round-trip without clamping.
 */
import type { GenomeTemplate, ScenarioDef } from './types';

const DAY = 600;

// Gene means (0..1). Order of genes: speed, size, perception, metabolism, aggression, sociability,
// altruism, fertility, longevity, immunity, efficiency, hue (hue 0 = red, 0.33 = green, 0.66 = blue).

/** Calm, cooperative generalists. */
const gentle = (hue: number): GenomeTemplate => ({
  speed: 0.5, size: 0.45, perception: 0.5, metabolism: 0.45, aggression: 0.1, sociability: 0.75,
  altruism: 0.65, fertility: 0.6, longevity: 0.55, immunity: 0.5, efficiency: 0.55, hue, spread: 0.07,
});

/** Wide random variation around the midpoint — raw material for selection. */
const wild = (spread: number): GenomeTemplate => ({
  speed: 0.5, size: 0.5, perception: 0.5, metabolism: 0.5, aggression: 0.5, sociability: 0.5,
  altruism: 0.5, fertility: 0.5, longevity: 0.5, immunity: 0.5, efficiency: 0.5, hue: 0.5, spread,
});

const PEACEFUL_FORAGERS: GenomeTemplate = {
  speed: 0.45, size: 0.45, perception: 0.6, metabolism: 0.45, aggression: 0.08, sociability: 0.85,
  altruism: 0.8, fertility: 0.6, longevity: 0.6, immunity: 0.55, efficiency: 0.78, hue: 0.35, spread: 0.06,
};

const WARLIKE_RAIDERS: GenomeTemplate = {
  speed: 0.75, size: 0.78, perception: 0.6, metabolism: 0.6, aggression: 0.88, sociability: 0.6,
  altruism: 0.22, fertility: 0.5, longevity: 0.45, immunity: 0.5, efficiency: 0.4, hue: 0.02, spread: 0.06,
};

/** Fast-breeding, cooperative settlers (overshoot-prone). */
const PROLIFIC: GenomeTemplate = {
  speed: 0.5, size: 0.5, perception: 0.5, metabolism: 0.55, aggression: 0.2, sociability: 0.8,
  altruism: 0.6, fertility: 0.85, longevity: 0.5, immunity: 0.5, efficiency: 0.6, hue: 0.12, spread: 0.07,
};

/** Crowd-loving islanders with weak immune systems. */
const ISLANDERS = (hue: number): GenomeTemplate => ({
  speed: 0.45, size: 0.45, perception: 0.5, metabolism: 0.5, aggression: 0.15, sociability: 0.92,
  altruism: 0.7, fertility: 0.6, longevity: 0.55, immunity: 0.3, efficiency: 0.55, hue, spread: 0.08,
});

const PREY = (hue: number): GenomeTemplate => ({
  speed: 0.55, size: 0.4, perception: 0.6, metabolism: 0.45, aggression: 0.08, sociability: 0.8,
  altruism: 0.6, fertility: 0.65, longevity: 0.5, immunity: 0.5, efficiency: 0.65, hue, spread: 0.07,
});

/** Giant, fast, aggressive — and poor plant foragers, so hunger drives them to hunt. */
const PREDATOR: GenomeTemplate = {
  speed: 0.8, size: 0.95, perception: 0.8, metabolism: 0.75, aggression: 0.95, sociability: 0.45,
  altruism: 0.15, fertility: 0.35, longevity: 0.55, immunity: 0.6, efficiency: 0.15, hue: 0.0, spread: 0.04,
};

export const SCENARIOS: ScenarioDef[] = [
  // ------------------------------------------------------------------ 1. Garden of Eden
  {
    id: 'eden',
    name: 'Garden of Eden',
    tagline: 'Endless abundance — how fast can life fill a world?',
    description:
      'A temperate, fertile world: plants regrow twice as fast and tiles hold 50% more food, metabolism is cheap and there are no random disasters. ' +
      'Three small, gentle bands start far apart. This tests unconstrained growth: with selection relaxed, what limits a population except space itself?',
    lookFor: [
      'A J-shaped population curve that bends into a plateau as it approaches the population cap',
      'Bands spreading outward until their territories touch — do they merge, coexist or quarrel?',
      'Starvation is rare; old age becomes the leading cause of death',
      'Relaxed selection: gene spread (std-dev) widens over the generations instead of narrowing',
    ],
    config: {
      foodRegen: 2,
      foodCapacity: 1.5,
      difficulty: 0.6,
      disasterRate: 0,
      diseaseVirulence: 0.2,
      aggressionBias: 0.5,
      cooperationBias: 1.4,
      reproductionRate: 1.3,
      maxAgents: 1000,
    },
    world: { waterLevel: 0.25, desertLevel: 0.03, mountainLevel: 0.07, fertility: 1.4, initialFood: 1 },
    populations: [
      { x: 520, y: 420, count: 50, radius: 80, template: gentle(0.3), tribe: 'new', tribeName: 'Edenites' },
      { x: 1080, y: 400, count: 50, radius: 80, template: gentle(0.55), tribe: 'new', tribeName: 'Dawnfolk' },
      { x: 800, y: 700, count: 50, radius: 80, template: gentle(0.14), tribe: 'new', tribeName: 'Meadowkin' },
    ],
    scheduled: [
      {
        tick: 4 * DAY,
        intervention: { kind: 'disaster', disaster: 'bloom', x: 800, y: 500, radius: 450, intensity: 0.8, duration: 900 },
        note: 'Day 4: An endless summer — the garden blooms even more abundantly.',
      },
    ],
  },

  // ------------------------------------------------------------------ 2. Survival of the Fittest
  {
    id: 'fittest',
    name: 'Survival of the Fittest',
    tagline: 'Scarcity, hardship and conflict — only the best-adapted survive',
    description:
      'Food is scarce and slow to regrow, deserts are widespread, metabolism is costly and agents are quick to fight. ' +
      'Four unaffiliated groups start with highly varied random genomes and a raised mutation rate, then face a dry season, a frost and an epidemic. ' +
      'This tests natural selection under strong pressure: which trait combinations win, and does cooperation emerge anyway?',
    lookFor: [
      'An early crash as poorly adapted genomes starve, then a smaller but tougher population',
      'Gene means shifting quickly — watch efficiency rise and costly traits (speed, longevity) get trimmed',
      'Frequent fights over food, and the combat share of deaths climbing during the drought',
      'Whether tribes still form spontaneously when everyone starts as a loner',
    ],
    config: {
      foodRegen: 0.55,
      foodCapacity: 0.9,
      difficulty: 1.6,
      disasterRate: 0.8,
      diseaseVirulence: 0.8,
      aggressionBias: 1.5,
      cooperationBias: 0.7,
      mutationRate: 0.14,
      mutationSize: 0.1,
      reproductionRate: 1.15,
      maxAgents: 800,
    },
    world: { waterLevel: 0.27, desertLevel: 0.42, mountainLevel: 0.15, fertility: 0.75, initialFood: 0.55 },
    populations: [
      { x: 380, y: 320, count: 45, radius: 90, template: wild(0.25), tribe: 'none' },
      { x: 1220, y: 320, count: 45, radius: 90, template: wild(0.25), tribe: 'none' },
      { x: 380, y: 700, count: 45, radius: 90, template: wild(0.25), tribe: 'none' },
      { x: 1220, y: 700, count: 45, radius: 90, template: wild(0.25), tribe: 'none' },
    ],
    scheduled: [
      {
        tick: 3 * DAY,
        intervention: { kind: 'disaster', disaster: 'drought', x: 800, y: 500, radius: 0, intensity: 0.5, duration: 2 * DAY },
        note: 'Day 3: The dry season — plant growth falters everywhere. Only efficient foragers will make it.',
      },
      {
        tick: 7 * DAY,
        intervention: { kind: 'disaster', disaster: 'coldsnap', x: 800, y: 500, radius: 0, intensity: 0.6, duration: 1.5 * DAY },
        note: 'Day 7: A hard frost. Large, well-fed bodies have the edge now.',
      },
      {
        tick: 10 * DAY,
        intervention: { kind: 'disaster', disaster: 'plague', x: 800, y: 500, radius: 260, intensity: 0.6, duration: 400 },
        note: 'Day 10: Disease emerges in the crowded centre — immunity is put to the test.',
      },
    ],
  },

  // ------------------------------------------------------------------ 3. Two Civilizations
  {
    id: 'two-civs',
    name: 'Two Civilizations',
    tagline: 'Peaceful foragers and warlike raiders, divided by a river',
    description:
      'A river with a few fords splits the world. In the west live the Verdant Foragers — gentle, cooperative and efficient; in the east the Crimson Raiders — big, fast and aggressive. ' +
      'Later a harvest blooms in the west and drought strikes the east. This tests whether cooperation or aggression wins the competition for territory and resources.',
    lookFor: [
      'Raiding parties crossing the fords once the eastern drought bites (day 9)',
      'Territory overlays shifting along the river as the tribes push against each other',
      'Combat deaths spiking where the two peoples meet; inter-tribe relations sliding toward war',
      'Which strategy grows faster: the foragers\' food stockpiles or the raiders\' plunder',
    ],
    config: {
      foodRegen: 1,
      foodCapacity: 1,
      difficulty: 1,
      disasterRate: 0.15,
      aggressionBias: 1.25,
      cooperationBias: 1.25,
      mutationRate: 0.06,
      maxAgents: 1000,
    },
    world: { divide: 'river', waterLevel: 0.22, desertLevel: 0.1, mountainLevel: 0.08 },
    populations: [
      { x: 420, y: 500, count: 110, radius: 120, template: PEACEFUL_FORAGERS, tribe: 'new', tribeName: 'Verdant Foragers' },
      { x: 1180, y: 500, count: 110, radius: 120, template: WARLIKE_RAIDERS, tribe: 'new', tribeName: 'Crimson Raiders' },
    ],
    scheduled: [
      {
        tick: 5 * DAY,
        intervention: { kind: 'disaster', disaster: 'bloom', x: 430, y: 500, radius: 260, intensity: 0.8, duration: 2 * DAY },
        note: 'Day 5: A bumper harvest ripens in the western valleys — across the river, the raiders take notice.',
      },
      {
        tick: 9 * DAY,
        intervention: { kind: 'disaster', disaster: 'drought', x: 1180, y: 500, radius: 340, intensity: 0.75, duration: 4 * DAY },
        note: 'Day 9: Drought scorches the eastern plains. The raiders must cross the fords — or starve.',
      },
    ],
  },

  // ------------------------------------------------------------------ 4. Evolution Laboratory
  {
    id: 'evolab',
    name: 'Evolution Laboratory',
    tagline: 'Fast mutation, shifting climates and the origin of species',
    description:
      'Mutation is three times faster and larger than normal, and mates must be genetically similar, so isolated groups can drift into separate species. ' +
      'Every two days the climate shifts in a different quadrant — drought in the north-west, cold in the north-east, abundance in the south-west, drought in the south-east — in a repeating 8-day cycle. ' +
      'This tests local adaptation and speciation under a changing, patchy environment.',
    lookFor: [
      'Colour clusters (the neutral hue gene) separating by region — the signature of reproductive isolation',
      'Gene histograms becoming bimodal as regional populations adapt to their own climate cycle',
      'Populations migrating away from each stressed quadrant and back again when it recovers',
      'Mountain passes acting as bottlenecks between the eastern and western gene pools',
    ],
    config: {
      mutationRate: 0.25,
      mutationSize: 0.12,
      mateCompatibility: 0.2,
      reproductionRate: 1.4,
      foodRegen: 1.15,
      foodCapacity: 1.1,
      difficulty: 1.1,
      disasterRate: 0,
      diseaseVirulence: 0.4,
      maxAgents: 900,
    },
    world: { divide: 'mountains', waterLevel: 0.28, mountainLevel: 0.16, desertLevel: 0.12 },
    populations: [
      { x: 420, y: 300, count: 45, radius: 90, template: wild(0.2), tribe: 'none' },
      { x: 1180, y: 300, count: 45, radius: 90, template: wild(0.2), tribe: 'none' },
      { x: 420, y: 720, count: 45, radius: 90, template: wild(0.2), tribe: 'none' },
      { x: 1180, y: 720, count: 45, radius: 90, template: wild(0.2), tribe: 'none' },
    ],
    scheduled: [
      {
        tick: 2 * DAY,
        repeat: 8 * DAY,
        intervention: { kind: 'disaster', disaster: 'drought', x: 400, y: 260, radius: 420, intensity: 0.85, duration: 1100 },
        note: 'Climate shift: drought grips the north-west.',
      },
      {
        tick: 4 * DAY,
        repeat: 8 * DAY,
        intervention: { kind: 'disaster', disaster: 'coldsnap', x: 1200, y: 260, radius: 420, intensity: 0.8, duration: 1100 },
        note: 'Climate shift: a cold snap sweeps the north-east.',
      },
      {
        tick: 6 * DAY,
        repeat: 8 * DAY,
        intervention: { kind: 'disaster', disaster: 'bloom', x: 400, y: 740, radius: 420, intensity: 0.8, duration: 1100 },
        note: 'Climate shift: abundance blooms in the south-west.',
      },
      {
        tick: 8 * DAY,
        repeat: 8 * DAY,
        intervention: { kind: 'disaster', disaster: 'drought', x: 1200, y: 740, radius: 420, intensity: 0.85, duration: 1100 },
        note: 'Climate shift: drought moves to the south-east.',
      },
    ],
  },

  // ------------------------------------------------------------------ 5. Civilization Collapse
  {
    id: 'collapse',
    name: 'Civilization Collapse',
    tagline: 'A golden age, an overshoot — and then the rains fail',
    description:
      'One large, prolific tribe starts in a lush, stable world and overgrazing is on, so stripped land loses fertility. ' +
      'On day 8 a long global drought begins and blight hits the heartland, on day 10 a cold snap follows, and the rains only return on day 14, far to the north-east. ' +
      'This tests overshoot and collapse: does the population crash below its old level, and can survivors migrate and recover?',
    lookFor: [
      'Boom: rapid growth while food is plentiful, then mean fertility of the soil sliding as the land is overgrazed',
      'Bust: starvation deaths spiking after day 8, stockpiles draining, the tribe splintering or turning on itself',
      'Survivors clustering on the last fertile patches; recovery (or not) after the rains return on day 14',
      'Selection during the crash: efficiency and low metabolism should rise in the survivors',
    ],
    config: {
      foodRegen: 1.4,
      foodCapacity: 1.6,
      difficulty: 0.85,
      overgrazing: true,
      reproductionRate: 1.6,
      disasterRate: 0,
      aggressionBias: 0.8,
      cooperationBias: 1.2,
      diseaseVirulence: 0.6,
      maxAgents: 1400,
    },
    world: { waterLevel: 0.26, desertLevel: 0.06, mountainLevel: 0.08, fertility: 1.3, initialFood: 1 },
    populations: [{ x: 800, y: 500, count: 160, radius: 150, template: PROLIFIC, tribe: 'new', tribeName: 'The Golden Realm' }],
    scheduled: [
      {
        tick: 8 * DAY,
        intervention: { kind: 'disaster', disaster: 'drought', x: 800, y: 500, radius: 0, intensity: 0.85, duration: 6 * DAY },
        note: 'Day 8: The Great Drought — the rains fail across the entire world.',
      },
      {
        tick: 8 * DAY + 60,
        intervention: { kind: 'disaster', disaster: 'blight', x: 800, y: 500, radius: 300, intensity: 0.9, duration: 3 * DAY },
        note: 'Blight sweeps through the heartland, rotting the overworked fields.',
      },
      {
        tick: 10 * DAY,
        intervention: { kind: 'disaster', disaster: 'coldsnap', x: 800, y: 500, radius: 0, intensity: 0.8, duration: 2.5 * DAY },
        note: 'Day 10: A bitter cold snap arrives while the granaries are empty.',
      },
      {
        tick: 14 * DAY,
        intervention: { kind: 'disaster', disaster: 'bloom', x: 1250, y: 280, radius: 300, intensity: 0.8, duration: 2 * DAY },
        note: 'Day 14: The rains return — but only in the far north-east. Will the survivors find it?',
      },
    ],
  },

  // ------------------------------------------------------------------ 6. Plague Island (bonus)
  {
    id: 'plague-island',
    name: 'Plague Island',
    tagline: 'A crowded archipelago meets a deadly epidemic',
    description:
      'Five sociable island tribes with weak immune systems live packed together on an archipelago. On day 3 plague breaks out in the central harbour, and on day 10 a second strain arrives by sea in the south-east. ' +
      'This tests epidemic dynamics: how social contact spreads disease, whether water acts as a quarantine, and how fast immunity evolves.',
    lookFor: [
      'The infected count rising and falling in waves — compare islands reached early with isolated ones',
      'Disease deaths concentrated in dense, social clusters; loners and remote islands surviving',
      'Mean immunity climbing in the generations after each outbreak (and sociability possibly dipping)',
      'Recovered agents with acquired immunity shielding their tribe from the second strain',
    ],
    config: {
      diseaseVirulence: 1.5,
      cooperationBias: 1.5,
      aggressionBias: 0.6,
      foodRegen: 1.2,
      foodCapacity: 1.1,
      difficulty: 0.9,
      disasterRate: 0,
      mutationRate: 0.1,
      reproductionRate: 1.2,
      maxAgents: 1000,
    },
    world: { waterLevel: 0.5, noiseScale: 22, island: true, mountainLevel: 0.05, desertLevel: 0.04, fertility: 1.2 },
    populations: [
      { x: 800, y: 500, count: 45, radius: 55, template: ISLANDERS(0.58), tribe: 'new', tribeName: 'Harbourfolk' },
      { x: 430, y: 330, count: 40, radius: 55, template: ISLANDERS(0.3), tribe: 'new', tribeName: 'Reefkin' },
      { x: 1170, y: 330, count: 40, radius: 55, template: ISLANDERS(0.8), tribe: 'new', tribeName: 'Saltclan' },
      { x: 430, y: 690, count: 40, radius: 55, template: ISLANDERS(0.12), tribe: 'new', tribeName: 'Tidewardens' },
      { x: 1170, y: 690, count: 40, radius: 55, template: ISLANDERS(0.45), tribe: 'new', tribeName: 'Lagoonari' },
    ],
    scheduled: [
      {
        tick: 3 * DAY,
        intervention: { kind: 'disaster', disaster: 'plague', x: 800, y: 500, radius: 140, intensity: 0.9, duration: 300 },
        note: 'Day 3: Plague breaks out in the crowded central harbour!',
      },
      {
        tick: 10 * DAY,
        intervention: { kind: 'disaster', disaster: 'plague', x: 1170, y: 690, radius: 140, intensity: 0.8, duration: 300 },
        note: 'Day 10: A new strain arrives by sea in the south-east.',
      },
    ],
  },

  // ------------------------------------------------------------------ 7. Wolves Among Sheep (bonus)
  {
    id: 'predators',
    name: 'Wolves Among Sheep',
    tagline: 'A few giant raiders stalk a land of peaceful foragers',
    description:
      'Two hundred small, peaceful foragers share a modestly fertile land with a pack of twelve giant, fast, aggressive raiders who are poor at gathering plants; a second pack appears on day 6. ' +
      'This tests predator–prey dynamics between agents: once the land fills up and food runs short, hunger turns the raiders into hunters — do the foragers survive through numbers, speed and vigilance?',
    lookFor: [
      'Raids beginning as plant food grows scarce (watch the fights counter climb from around day 5)',
      'Raider numbers lagging behind forager numbers in boom-and-bust cycles (Lotka–Volterra style)',
      'Foragers evolving higher speed and perception, or banding tightly together for safety',
      'Raiders starving when prey is scarce or well defended — aggression is costly without victims',
    ],
    config: {
      aggressionBias: 1.8,
      cooperationBias: 1.2,
      foodRegen: 0.9,
      foodCapacity: 0.95,
      difficulty: 1,
      disasterRate: 0.1,
      mutationRate: 0.1,
      maxAgents: 1000,
    },
    world: { waterLevel: 0.25, desertLevel: 0.08, mountainLevel: 0.1 },
    populations: [
      { x: 500, y: 380, count: 70, radius: 110, template: PREY(0.38), tribe: 'new', tribeName: 'Gentle Grazers' },
      { x: 1100, y: 660, count: 70, radius: 110, template: PREY(0.6), tribe: 'new', tribeName: 'Quiet Herd' },
      { x: 620, y: 720, count: 60, radius: 110, template: PREY(0.25), tribe: 'none' },
      { x: 1150, y: 320, count: 12, radius: 40, template: PREDATOR, tribe: 'new', tribeName: 'The Wolf Pack' },
    ],
    scheduled: [
      {
        tick: 6 * DAY,
        intervention: { kind: 'spawn', x: 320, y: 760, count: 10, radius: 40, template: PREDATOR, tribe: 'new', tribeName: 'The Second Pack' },
        note: 'Day 6: A second raider pack emerges from the south-western wilds.',
      },
    ],
  },
];

/** Scenario by id, or undefined. */
export function findScenario(id: string): ScenarioDef | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/**
 * Scenario by id (falls back to the first scenario for unknown ids). Returns a fresh deep copy,
 * so callers may tweak it (e.g. custom config) without altering the preset.
 */
export function getScenario(id: string): ScenarioDef {
  const sc = findScenario(id) ?? SCENARIOS[0];
  return JSON.parse(JSON.stringify(sc)) as ScenarioDef;
}
