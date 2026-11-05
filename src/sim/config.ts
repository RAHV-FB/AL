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
  { key: 'mutationRate', label: 'Mutation rate', min: 0, max: 0.5, step: 0.01, help: 'Probability that each gene mutates when a child is born. Higher = faster evolution but more harmful mutations.' },
  { key: 'mutationSize', label: 'Mutation size', min: 0, max: 0.3, step: 0.01, help: 'How large each mutation is (std-dev in normalised gene units).' },
  { key: 'reproductionRate', label: 'Reproduction rate', min: 0.2, max: 3, step: 0.05, help: 'Multiplier on reproductive drive and how fast parents recover between births.' },
  { key: 'foodRegen', label: 'Plant regrowth', min: 0, max: 3, step: 0.05, help: 'How fast food regrows on every tile. Sets the world\'s carrying capacity.' },
  { key: 'foodCapacity', label: 'Food capacity', min: 0.2, max: 3, step: 0.05, help: 'Maximum food each tile can hold.' },
  { key: 'difficulty', label: 'Environmental harshness', min: 0.3, max: 3, step: 0.05, help: 'Multiplier on metabolic costs, cold stress and starvation damage.' },
  { key: 'disasterRate', label: 'Random disasters', min: 0, max: 3, step: 0.05, help: 'Frequency of spontaneous droughts, blights, plagues, cold snaps and meteors (0 = off).' },
  { key: 'diseaseVirulence', label: 'Disease virulence', min: 0, max: 2, step: 0.05, help: 'How contagious and deadly plagues are.' },
  { key: 'aggressionBias', label: 'Aggression bias', min: 0, max: 3, step: 0.05, help: 'Global multiplier on willingness to fight and steal (applied on top of each agent\'s genes).' },
  { key: 'cooperationBias', label: 'Cooperation bias', min: 0, max: 3, step: 0.05, help: 'Global multiplier on willingness to share food and help others.' },
  { key: 'mateCompatibility', label: 'Mate compatibility', min: 0.05, max: 1, step: 0.01, help: 'Maximum genetic distance allowed between mates. Low values cause reproductive isolation and speciation.' },
  { key: 'maxAgents', label: 'Population cap', min: 50, max: 2000, step: 50, help: 'Hard cap on living agents (performance safety). Births are blocked at the cap.' },
];
