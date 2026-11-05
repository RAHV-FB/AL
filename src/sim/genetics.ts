// OWNER: Genetics & Evolution agent. STUB — replace with the real implementation.
import type { Rng } from './rng';
import type { Simulation } from './simulation';
import { GENE_COUNT, GENES, type Agent, type GenomeTemplate, type Traits } from './types';

/** Random genome, optionally centred on a template (gene means) with `template.spread` variation. */
export function randomGenes(rng: Rng, template?: GenomeTemplate): number[] {
  const g: number[] = new Array(GENE_COUNT);
  const spread = template?.spread ?? 0.08;
  for (let i = 0; i < GENE_COUNT; i++) {
    const mean = template?.[GENES[i]];
    const v = mean === undefined ? rng.next() * 0.5 + 0.25 : rng.normal(mean, spread);
    g[i] = Math.min(1, Math.max(0, v));
  }
  return g;
}

/** Map genes (0..1) to phenotype traits in simulation units. Pure function. */
export function expressTraits(genes: number[]): Traits {
  const [speed, size, perception, metabolism, aggression, sociability, altruism, fertility, longevity, immunity, efficiency, hue] = genes;
  const sz = 0.6 + size;
  return {
    speed: 0.5 + speed * 1.7,
    size: sz,
    perception: 25 + perception * 115,
    metabolism: 0.6 + metabolism * 0.9,
    aggression,
    sociability,
    altruism,
    fertility,
    longevity: 3000 + longevity * 5000,
    immunity,
    efficiency: 0.5 + efficiency,
    hue: hue * 360,
    maxHealth: 60 + 60 * sz,
    maxFood: 60 + 60 * sz,
    strength: sz,
    maturityAge: 600,
  };
}

/** Uniform crossover of two parent genomes. */
export function crossover(rng: Rng, a: number[], b: number[]): number[] {
  const c = new Array(GENE_COUNT);
  for (let i = 0; i < GENE_COUNT; i++) c[i] = rng.next() < 0.5 ? a[i] : b[i];
  return c;
}

/** Gaussian point mutation in place (each gene with probability `rate`, std-dev `size`), clamped to [0,1]. */
export function mutate(rng: Rng, genes: number[], rate: number, size: number): number[] {
  for (let i = 0; i < genes.length; i++) {
    if (rng.next() < rate) genes[i] = Math.min(1, Math.max(0, genes[i] + rng.normal(0, size)));
  }
  return genes;
}

/** Normalised genetic distance in [0,1] (excluding nothing; hue counts). */
export function geneticDistance(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < GENE_COUNT; i++) d += Math.abs(a[i] - b[i]);
  return d / GENE_COUNT;
}

/** Whether a and b can mate right now (adults, cooldowns, energy, compatibility). */
export function canMate(sim: Simulation, a: Agent, b: Agent): boolean {
  void sim; void a; void b;
  return false;
}

/** Produce a child from parents a & b (pays costs, registers child via sim.addAgent). Null if not possible. */
export function reproduce(sim: Simulation, a: Agent, b: Agent): Agent | null {
  void sim; void a; void b;
  return null;
}
