// OWNER: Persistence & Experiments agent. STUB — replace with the 5+ real scenarios.
import type { ScenarioDef } from './types';

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'eden',
    name: 'Garden of Eden',
    tagline: 'Abundance and rapid growth',
    description: 'Abundant resources, minimal threats.',
    lookFor: ['Rapid population growth'],
    config: { foodRegen: 2 },
    world: {},
    populations: [{ x: 800, y: 500, count: 120, radius: 150, tribe: 'none' }],
    scheduled: [],
  },
];

export function getScenario(id: string): ScenarioDef {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}
