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
    tagline: 'Plenty of food and no disasters, so the bands grow until the population cap',
    description:
      'Plants regrow twice as fast as normal, each tile holds 50% more food, metabolism is cheap and there are no random disasters. ' +
      'Three small, gentle bands start far apart. The run shows how a population grows when selection is relaxed, and what finally stops it.',
    lookFor: [
      'The population rising steeply, then levelling off at the population cap',
      'Bands spreading out until their territories meet, then sharing or contesting the border',
      'Few deaths from starvation: old age is the main cause of death',
      'Gene spread (standard deviation) widening over the generations instead of narrowing, because selection is weak',
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
        note: 'Day 4: plants bloom across the centre of the island.',
      },
    ],
  },

  // ------------------------------------------------------------------ 2. Survival of the Fittest
  {
    id: 'fittest',
    name: 'Survival of the Fittest',
    tagline: 'Scarce food and a harsh climate put strong selection on varied loners',
    description:
      'Food is scarce and slow to regrow, deserts are widespread, metabolism is costly and agents fight readily. ' +
      'Four groups of loners start with widely varied genomes and a raised mutation rate. A dry season comes on day 3, a frost on day 7 and a plague on day 10. ' +
      'The run shows which trait combinations come through strong selection, and whether the loners still band together.',
    lookFor: [
      'A short boom, then a starvation crash that leaves a smaller population',
      'Gene means shifting fast: survivors get faster and leaner (speed up, metabolism down) while efficiency and fertility rise',
      'Frequent fights over food, with more combat deaths during the drought',
      'Whether tribes form at all when everyone starts as a loner',
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
        note: 'Day 3: a dry season slows plant growth everywhere. Efficient foragers cope best.',
      },
      {
        tick: 7 * DAY,
        intervention: { kind: 'disaster', disaster: 'coldsnap', x: 800, y: 500, radius: 0, intensity: 0.6, duration: 1.5 * DAY },
        note: 'Day 7: a hard frost. Large, well-fed bodies resist the cold best.',
      },
      {
        tick: 10 * DAY,
        intervention: { kind: 'disaster', disaster: 'plague', x: 800, y: 500, radius: 260, intensity: 0.6, duration: 400 },
        note: 'Day 10: a plague breaks out in the crowded centre of the island.',
      },
    ],
  },

  // ------------------------------------------------------------------ 3. Two Civilizations
  {
    id: 'two-civs',
    name: 'Two Civilizations',
    tagline: 'Peaceful foragers and warlike raiders, old enemies on either side of a river',
    description:
      'A river with three fords splits the island. The Verdant Foragers in the west are gentle and gather food well; the Crimson Raiders in the east are big and aggressive. ' +
      'The two peoples start at war. Raiding parties cross the fords, sleep out on the march, plunder the foragers\' stockpile and carry the loot home. ' +
      'A harvest ripens in the west on day 5 and a drought hits the east on day 9.',
    lookFor: [
      'Raiding parties crossing the fords to the foragers\' camps and carrying the loot home',
      'Combat deaths where the raiders reach the foragers, and the war deepening with every raid',
      'The foragers\' stockpile shrinking with each raid, and loot arriving at the raiders\' camp',
      'Which people grows faster: the foragers who gather food or the raiders who take it',
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
    // the two peoples start at war; their enmity cools only slowly (social.ts: rivalDrift)
    rivalries: [{ a: 'Crimson Raiders', b: 'Verdant Foragers', relation: -0.6 }],
    scheduled: [
      {
        tick: 5 * DAY,
        intervention: { kind: 'disaster', disaster: 'bloom', x: 430, y: 500, radius: 260, intensity: 0.8, duration: 2 * DAY },
        note: 'Day 5: a bumper harvest ripens in the western valleys.',
      },
      {
        tick: 9 * DAY,
        intervention: { kind: 'disaster', disaster: 'drought', x: 1180, y: 500, radius: 340, intensity: 0.75, duration: 4 * DAY },
        note: 'Day 9: a drought hits the eastern plains, where the raiders live.',
      },
    ],
  },

  // ------------------------------------------------------------------ 4. Evolution Laboratory
  {
    id: 'evolab',
    name: 'Evolution Laboratory',
    tagline: 'Fast mutation and regional climate shifts, with mates that must be genetically similar',
    description:
      'Mutations are about three times as frequent as normal and larger, and mates must be genetically similar, so isolated groups can drift apart into separate species. ' +
      'Every two days the climate shifts in another quadrant, in an 8-day cycle: drought in the north-west, cold in the north-east, a bloom in the south-west, then drought in the south-east. ' +
      'A mountain range with passes divides east from west.',
    lookFor: [
      'Colour clusters (the neutral hue gene) separating by region, a sign of reproductive isolation',
      'Gene histograms with two peaks as regional populations adapt to their own climate',
      'Populations moving away from each stressed quadrant and back again when it recovers',
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
        note: 'Climate shift: drought in the north-west.',
      },
      {
        tick: 4 * DAY,
        repeat: 8 * DAY,
        intervention: { kind: 'disaster', disaster: 'coldsnap', x: 1200, y: 260, radius: 420, intensity: 0.8, duration: 1100 },
        note: 'Climate shift: a cold snap in the north-east.',
      },
      {
        tick: 6 * DAY,
        repeat: 8 * DAY,
        intervention: { kind: 'disaster', disaster: 'bloom', x: 400, y: 740, radius: 420, intensity: 0.8, duration: 1100 },
        note: 'Climate shift: plants bloom in the south-west.',
      },
      {
        tick: 8 * DAY,
        repeat: 8 * DAY,
        intervention: { kind: 'disaster', disaster: 'drought', x: 1200, y: 740, radius: 420, intensity: 0.85, duration: 1100 },
        note: 'Climate shift: drought in the south-east.',
      },
    ],
  },

  // ------------------------------------------------------------------ 5. Civilization Collapse
  {
    id: 'collapse',
    name: 'Civilization Collapse',
    tagline: 'One big tribe outgrows its land, then a long drought starts',
    description:
      'One large, fast-breeding tribe starts on lush land with overgrazing on, so land grazed bare loses fertility. ' +
      'On day 8 a long drought starts across the whole island and blight hits the heartland. A cold snap follows on day 10, and on day 14 rain returns, but only in the far north-east. ' +
      'The run shows overshoot and collapse, and whether the survivors move and recover.',
    lookFor: [
      'Rapid growth while food is plentiful, then fewer births as the land around the camps is grazed down',
      'Starvation deaths rising after day 8 as the stockpiles drain, and the tribe splitting up',
      'Survivors gathering on the last fertile patches, and whether they recover after the rain returns on day 14',
      'Which genomes come through the famine (compare the gene charts before and after)',
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
        note: 'Day 8: the rain fails across the whole island.',
      },
      {
        tick: 8 * DAY + 60,
        intervention: { kind: 'disaster', disaster: 'blight', x: 800, y: 500, radius: 300, intensity: 0.9, duration: 3 * DAY },
        note: 'Blight destroys food and soil fertility in the heartland.',
      },
      {
        tick: 10 * DAY,
        intervention: { kind: 'disaster', disaster: 'coldsnap', x: 800, y: 500, radius: 0, intensity: 0.8, duration: 2.5 * DAY },
        note: 'Day 10: a cold snap across the island.',
      },
      {
        tick: 14 * DAY,
        intervention: { kind: 'disaster', disaster: 'bloom', x: 1250, y: 280, radius: 300, intensity: 0.8, duration: 2 * DAY },
        note: 'Day 14: rain returns, but only in the far north-east.',
      },
    ],
  },

  // ------------------------------------------------------------------ 6. Plague Island (bonus)
  {
    id: 'plague-island',
    name: 'Plague Island',
    tagline: 'Crowded islands with weak immune systems and two outbreaks of plague',
    description:
      'Five sociable tribes with weak immune systems live crowded together on an archipelago, and disease is 1.5 times as virulent as normal. ' +
      'Plague breaks out in the central harbour on day 3, and a second strain appears in the south-east on day 10. ' +
      'The run shows how contact spreads disease, whether water works as a quarantine and how fast immunity evolves.',
    lookFor: [
      'The infected count rising and falling in waves; compare islands reached early with isolated ones',
      'Disease deaths concentrated in dense, sociable clusters, while loners and remote islands do better',
      'Mean immunity rising in the generations after each outbreak, and perhaps sociability falling',
      'Recovered agents, immune for a while, slowing the second strain in their tribe',
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
        note: 'Day 3: plague breaks out in the crowded central harbour.',
      },
      {
        tick: 10 * DAY,
        intervention: { kind: 'disaster', disaster: 'plague', x: 1170, y: 690, radius: 140, intensity: 0.8, duration: 300 },
        note: 'Day 10: a second plague strain appears in the south-east.',
      },
    ],
  },

  // ------------------------------------------------------------------ 7. Wolves Among Sheep (bonus)
  {
    id: 'predators',
    name: 'Wolves Among Sheep',
    tagline: 'A dozen giant raiders among two hundred peaceful foragers',
    description:
      'Two hundred small, peaceful foragers share the land with a pack of twelve giant, aggressive raiders who are poor at gathering plants. A second pack of ten appears on day 6. ' +
      'Once food runs short, hungry raiders hunt the foragers, and the run shows whether numbers and speed keep the foragers alive.',
    lookFor: [
      'Attacks starting as plant food grows scarce, from around day 5',
      'Raider numbers rising and falling behind forager numbers, as in predator and prey cycles',
      'Foragers evolving higher speed and perception, or banding tightly together for safety',
      'Raiders starving when prey is scarce or well defended',
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
        note: 'Day 6: a second pack of ten raiders appears in the south-west.',
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
