import { TERRAIN, type TerrainInfo, type TerrainType } from './types';

/** Terrain rules (shared by ecology, brain movement, rendering, UI help). */
export const TERRAIN_INFO: Record<TerrainType, TerrainInfo> = {
  [TERRAIN.DeepWater]: { name: 'Deep water', passable: false, moveCost: 0, maxFood: 0, regen: 0, color: [18, 42, 74], description: 'Impassable ocean. Blocks movement and separates populations.' },
  [TERRAIN.Water]: { name: 'Shallows', passable: true, moveCost: 0.45, maxFood: 1.5, regen: 0.6, color: [36, 86, 124], description: 'Wadeable water. Very slow to cross; a little aquatic food.' },
  [TERRAIN.Sand]: { name: 'Sand', passable: true, moveCost: 0.85, maxFood: 2, regen: 0.5, color: [176, 160, 112], description: 'Beaches and dunes. Sparse food.' },
  [TERRAIN.Grass]: { name: 'Grassland', passable: true, moveCost: 1, maxFood: 10, regen: 1, color: [70, 122, 60], description: 'Fertile plains. Good food, fast regrowth, easy travel.' },
  [TERRAIN.Forest]: { name: 'Forest', passable: true, moveCost: 0.7, maxFood: 16, regen: 0.7, color: [34, 84, 46], description: 'Rich food but slow to traverse and slower to regrow.' },
  [TERRAIN.Desert]: { name: 'Desert', passable: true, moveCost: 0.9, maxFood: 1, regen: 0.25, color: [150, 120, 78], description: 'Barren. Almost no food; overgrazed land decays into desert-like fertility.' },
  [TERRAIN.Rock]: { name: 'Mountain', passable: true, moveCost: 0.4, maxFood: 0.5, regen: 0.2, color: [108, 104, 100], description: 'Rocky highlands. Very slow travel, almost no food — natural refuge.' },
  [TERRAIN.Wall]: { name: 'Wall', passable: false, moveCost: 0, maxFood: 0, regen: 0, color: [62, 58, 66], description: 'Player-built obstacle. Impassable and barren.' },
};

export const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;

/** Save format version (bump on incompatible SimState changes). */
export const SAVE_VERSION = 1;

/** Caps that keep memory bounded on long runs. */
export const LIMITS = {
  events: 400,
  lineage: 6000,
  tribesKept: 64, // living + most recent extinct
  relationships: 12,
  children: 12,
  history: 20,
  foodMemory: 4,
  dangerMemory: 3,
  statSamples: 1200,
  interventionLog: 5000,
};
