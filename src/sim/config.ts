import type { SimConfig } from './types';

export const DEFAULT_CONFIG: SimConfig = {
  seed: 12345,
  worldWidth: 200,
  worldHeight: 125,
  tileSize: 8,
  maxAgents: 1000,
  mutationRate: 0.08,
  mutationSize: 0.07,
  reproductionRate: 1,
  foodRegen: 1,
  foodCapacity: 1,
  difficulty: 1,
  disasterRate: 0.3,
  diseaseVirulence: 0.5,
  aggressionBias: 1,
  cooperationBias: 1,
  overgrazing: true,
  dayNight: true,
  seasons: true,
  dayLength: 600,
  daysPerSeason: 3,
  mateCompatibility: 0.35,
  tribesEnabled: true,
};

/** Slider metadata for runtime-tunable parameters (UI renders these generically). */
export interface ParamSpec {
  key: keyof SimConfig;
  label: string;
  min: number;
  max: number;
  step: number;
  help: string;
}

export const PARAM_SPECS: ParamSpec[] = [
  { key: 'mutationRate', label: 'Mutation rate', min: 0, max: 0.5, step: 0.01, help: 'Chance that each gene mutates when a child is born. Higher values speed up evolution and cause more harmful mutations.' },
  { key: 'mutationSize', label: 'Mutation size', min: 0, max: 0.3, step: 0.01, help: 'Typical size of a mutation, as a standard deviation on the 0 to 1 gene scale.' },
  { key: 'reproductionRate', label: 'Reproduction rate', min: 0.2, max: 3, step: 0.05, help: 'Multiplier on the urge to mate and on how soon parents can breed again.' },
  { key: 'foodRegen', label: 'Plant regrowth', min: 0, max: 3, step: 0.05, help: 'How fast plants regrow on every tile, which sets how many agents the land can feed.' },
  { key: 'foodCapacity', label: 'Food capacity', min: 0.2, max: 3, step: 0.05, help: 'Multiplier on the most food each tile can hold.' },
  { key: 'difficulty', label: 'Environmental harshness', min: 0.3, max: 3, step: 0.05, help: 'Multiplier on metabolic costs, cold stress and starvation damage.' },
  { key: 'disasterRate', label: 'Random disasters', min: 0, max: 3, step: 0.05, help: 'How often disasters start on their own: droughts, blights, plagues, cold snaps, meteors and abundance. 0 turns them off.' },
  { key: 'diseaseVirulence', label: 'Disease virulence', min: 0, max: 2, step: 0.05, help: 'How contagious and deadly plagues are.' },
  { key: 'aggressionBias', label: 'Aggression bias', min: 0, max: 3, step: 0.05, help: 'Multiplier on every agent\'s willingness to fight and steal, on top of its aggression gene.' },
  { key: 'cooperationBias', label: 'Cooperation bias', min: 0, max: 3, step: 0.05, help: 'Multiplier on every agent\'s willingness to share food and help others, on top of its altruism gene.' },
  { key: 'mateCompatibility', label: 'Mate compatibility', min: 0.05, max: 1, step: 0.01, help: 'Largest genetic distance at which two agents can still mate. Low values isolate lineages and lead to separate species.' },
  { key: 'maxAgents', label: 'Population cap', min: 50, max: 2000, step: 50, help: 'Maximum number of living agents, to keep the simulation fast. Nothing is born or spawned at the cap.' },
];
