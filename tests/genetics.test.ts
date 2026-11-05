import { describe, expect, it, vi } from 'vitest';

// Spy on social.adjustRelationship (calls through to the real implementation) to verify kin bonds.
vi.mock('../src/sim/social', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/sim/social')>();
  return { ...mod, adjustRelationship: vi.fn(mod.adjustRelationship) };
});

import * as social from '../src/sim/social';
import { Rng } from '../src/sim/rng';
import { Simulation } from '../src/sim/simulation';
import { LIMITS } from '../src/sim/constants';
import {
  basalBurn,
  canMate,
  crossover,
  expressTraits,
  geneticDistance,
  isFertile,
  mateFoodThreshold,
  mutate,
  parentalInvestment,
  randomGenes,
  reproCooldownFor,
  reproduce,
  TRAIT_RANGES,
} from '../src/sim/genetics';
import { createAgent, type CreateAgentOpts } from '../src/sim/lifecycle';
import { GENE_COUNT, G, NONE, TERRAIN, type Agent, type GeneName, type ScenarioDef, type SimConfig } from '../src/sim/types';

const TEST_SCENARIO: ScenarioDef = {
  id: 'genetics-test',
  name: 'Genetics test',
  tagline: '',
  description: '',
  lookFor: [],
  config: { worldWidth: 60, worldHeight: 40, disasterRate: 0 },
  world: { island: false, divide: 'none' },
  populations: [],
  scheduled: [],
};

function makeSim(config: Partial<SimConfig> = {}): Simulation {
  const sim = Simulation.create({ scenario: TEST_SCENARIO, seed: 1, config });
  sim.state.world.terrain.fill(TERRAIN.Grass);
  sim.state.env.temperature = 15;
  sim.state.env.daylight = 1;
  return sim;
}

function genome(v = 0.5, overrides: Partial<Record<GeneName, number>> = {}): number[] {
  const g = new Array<number>(GENE_COUNT).fill(v);
  for (const [k, val] of Object.entries(overrides)) g[G[k as GeneName]] = val as number;
  return g;
}

function spawnAdult(sim: Simulation, genes = genome(), extra: Partial<CreateAgentOpts> = {}): Agent {
  const a = createAgent(sim, { x: 200, y: 160, genes, age: 2000, food: 1e9, ...extra });
  sim.addAgent(a);
  return a;
}

const traitsWith = (gene: GeneName, v: number) => expressTraits(genome(0.5, { [gene]: v }));

describe('expressTraits', () => {
  it('maps the gene extremes onto the documented phenotype ranges', () => {
    const lo = expressTraits(genome(0));
    const hi = expressTraits(genome(1));
    expect(lo.speed).toBeCloseTo(0.5);
    expect(hi.speed).toBeCloseTo(2.2);
    expect(lo.size).toBeCloseTo(0.6);
    expect(hi.size).toBeCloseTo(1.6);
    expect(lo.perception).toBeCloseTo(25);
    expect(hi.perception).toBeCloseTo(140);
    expect(lo.metabolism).toBeCloseTo(0.6);
    expect(hi.metabolism).toBeCloseTo(1.5);
    expect(lo.longevity).toBe(3500);
    expect(hi.longevity).toBe(9000);
    expect(lo.efficiency).toBeCloseTo(0.5);
    expect(hi.efficiency).toBeCloseTo(1.5);
    expect(lo.maturityAge).toBe(700);
    expect(hi.maturityAge).toBe(1100);
    expect(lo.hue).toBe(0);
    expect(hi.hue).toBe(360);
  });

  it('keeps every random genome inside the ranges and finite', () => {
    const rng = new Rng(3);
    for (let n = 0; n < 500; n++) {
      const g = genome(0).map(() => rng.next());
      const t = expressTraits(g);
      for (const v of Object.values(t)) expect(Number.isFinite(v)).toBe(true);
      expect(t.speed).toBeGreaterThanOrEqual(TRAIT_RANGES.speed[0]);
      expect(t.speed).toBeLessThanOrEqual(TRAIT_RANGES.speed[1]);
      expect(t.perception).toBeGreaterThanOrEqual(25);
      expect(t.perception).toBeLessThanOrEqual(140);
      expect(t.maxHealth).toBeGreaterThan(0);
      expect(t.maxFood).toBeGreaterThan(0);
    }
  });

  it('sanitises NaN / out-of-range / missing genes', () => {
    const t = expressTraits([NaN, -3, 7, Infinity, -Infinity] as number[]);
    for (const v of Object.values(t)) expect(Number.isFinite(v)).toBe(true);
    expect(t.size).toBeCloseTo(0.6); // -3 → 0
    expect(t.perception).toBeCloseTo(140); // 7 → 1
    expect(t.speed).toBeCloseTo(expressTraits(genome(0.5)).speed); // NaN → 0.5
  });

  it('size buys health, stomach, strength and cold-resistance but costs upkeep and maturity time', () => {
    let prev = traitsWith('size', 0);
    for (const v of [0.25, 0.5, 0.75, 1]) {
      const t = traitsWith('size', v);
      expect(t.maxHealth).toBeGreaterThan(prev.maxHealth);
      expect(t.maxFood).toBeGreaterThan(prev.maxFood);
      expect(t.strength).toBeGreaterThan(prev.strength);
      expect(t.maturityAge).toBeGreaterThan(prev.maturityAge);
      expect(basalBurn(t)).toBeGreaterThan(basalBurn(prev));
      prev = t;
    }
    // ...yet big bodies endure fasting longer (stomach grows faster than burn)
    const small = traitsWith('size', 0);
    const big = traitsWith('size', 1);
    expect(big.maxFood / basalBurn(big)).toBeGreaterThan(small.maxFood / basalBurn(small));
  });

  it('every costly trait raises basal burn monotonically together with its benefit', () => {
    const cases: [GeneName, keyof ReturnType<typeof expressTraits>][] = [
      ['speed', 'speed'],
      ['perception', 'perception'],
      ['metabolism', 'metabolism'],
      ['longevity', 'longevity'],
      ['immunity', 'immunity'],
      ['efficiency', 'efficiency'],
    ];
    for (const [gene, trait] of cases) {
      let prev = traitsWith(gene, 0);
      for (const v of [0.2, 0.4, 0.6, 0.8, 1]) {
        const t = traitsWith(gene, v);
        expect(t[trait], `${gene} benefit`).toBeGreaterThan(prev[trait]);
        expect(basalBurn(t), `${gene} cost`).toBeGreaterThan(basalBurn(prev));
        prev = t;
      }
    }
  });

  it('behavioural and marker genes are metabolically neutral', () => {
    for (const gene of ['aggression', 'sociability', 'altruism', 'fertility', 'hue'] as GeneName[]) {
      expect(basalBurn(traitsWith(gene, 0))).toBeCloseTo(basalBurn(traitsWith(gene, 1)), 12);
    }
  });

  it('average genome burns ≈0.073 food/tick at rest', () => {
    const b = basalBurn(expressTraits(genome(0.5)));
    expect(b).toBeGreaterThan(0.065);
    expect(b).toBeLessThan(0.08);
  });

  it('fertility trades offspring quantity for quality', () => {
    const lo = traitsWith('fertility', 0);
    const hi = traitsWith('fertility', 1);
    expect(mateFoodThreshold(lo)).toBeCloseTo(0.72);
    expect(mateFoodThreshold(hi)).toBeCloseTo(0.5);
    expect(reproCooldownFor(lo, 1)).toBe(1100);
    expect(reproCooldownFor(hi, 1)).toBe(500);
    expect(reproCooldownFor(lo, 2)).toBe(550);
    expect(parentalInvestment(hi)).toBeLessThan(parentalInvestment(lo));
  });
});

describe('genome operators', () => {
  it('randomGenes produces valid genomes, honours templates and is deterministic', () => {
    const r1 = new Rng(9);
    const r2 = new Rng(9);
    for (let i = 0; i < 50; i++) expect(randomGenes(r1)).toEqual(randomGenes(r2));
    const rng = new Rng(10);
    let sum = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const g = randomGenes(rng, { size: 0.9, spread: 0.05 });
      expect(g).toHaveLength(GENE_COUNT);
      for (const v of g) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(g[G.speed]).toBeGreaterThanOrEqual(0.25);
      expect(g[G.speed]).toBeLessThanOrEqual(0.75);
      sum += g[G.size];
    }
    expect(sum / N).toBeCloseTo(0.9, 1);
  });

  it('mutate with rate 0 or size 0 leaves genes identical', () => {
    const rng = new Rng(1);
    const g = randomGenes(rng);
    const copy = g.slice();
    expect(mutate(rng, g, 0, 0.2)).toBe(g);
    expect(g).toEqual(copy);
    mutate(rng, g, 1, 0);
    expect(g).toEqual(copy);
  });

  it('mutate keeps genes in [0,1] even with huge steps', () => {
    const rng = new Rng(2);
    for (let i = 0; i < 300; i++) {
      const g = mutate(rng, randomGenes(rng), 1, 5);
      for (const v of g) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    const edge = mutate(rng, genome(1), 1, 0.3);
    for (const v of edge) expect(v).toBeLessThanOrEqual(1);
  });

  it('mutation is unbiased with std ≈ size and hits ≈ rate of the genes', () => {
    const rng = new Rng(4);
    let n = 0, sum = 0, sum2 = 0, changed = 0, total = 0;
    for (let i = 0; i < 4000; i++) {
      const g = mutate(rng, genome(0.5), 1, 0.05);
      for (const v of g) {
        const d = v - 0.5;
        n++;
        sum += d;
        sum2 += d * d;
      }
      const h = mutate(rng, genome(0.5), 0.3, 0.05);
      for (const v of h) {
        total++;
        if (v !== 0.5) changed++;
      }
    }
    const mean = sum / n;
    const sd = Math.sqrt(sum2 / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.002);
    expect(sd).toBeGreaterThan(0.047);
    expect(sd).toBeLessThan(0.053);
    expect(changed / total).toBeGreaterThan(0.28);
    expect(changed / total).toBeLessThan(0.32);
  });

  it('crossover only uses parent alleles, mixes both parents and shows mild linkage', () => {
    const rng = new Rng(5);
    let fromA = 0, total = 0, sameAdj = 0, adj = 0;
    for (let n = 0; n < 3000; n++) {
      const a = genome(0).map((_, i) => 0.01 + i * 0.01); // distinct alleles
      const b = genome(0).map((_, i) => 0.51 + i * 0.01);
      const c = crossover(rng, a, b);
      expect(c).toHaveLength(GENE_COUNT);
      let prevA: boolean | null = null;
      for (let i = 0; i < GENE_COUNT; i++) {
        expect(c[i] === a[i] || c[i] === b[i]).toBe(true);
        const isA = c[i] === a[i];
        if (isA) fromA++;
        total++;
        if (prevA !== null) {
          adj++;
          if (prevA === isA) sameAdj++;
        }
        prevA = isA;
      }
    }
    expect(fromA / total).toBeGreaterThan(0.45);
    expect(fromA / total).toBeLessThan(0.55);
    // switch probability 0.4 ⇒ neighbouring genes come from the same parent ~60% of the time
    expect(sameAdj / adj).toBeGreaterThan(0.56);
    expect(sameAdj / adj).toBeLessThan(0.64);
  });

  it('geneticDistance is the mean absolute difference in [0,1]', () => {
    expect(geneticDistance(genome(0.3), genome(0.3))).toBe(0);
    expect(geneticDistance(genome(0), genome(1))).toBe(1);
    expect(geneticDistance(genome(0.2), genome(0.5))).toBeCloseTo(0.3);
    const a = genome(0.5, { speed: 0.9 });
    const b = genome(0.5);
    expect(geneticDistance(a, b)).toBeCloseTo(0.4 / GENE_COUNT);
    expect(geneticDistance(a, b)).toBe(geneticDistance(b, a));
  });
});

describe('canMate', () => {
  it('accepts two fed, rested, compatible, unrelated adults', () => {
    const sim = makeSim();
    const a = spawnAdult(sim);
    const b = spawnAdult(sim);
    expect(isFertile(a)).toBe(true);
    expect(canMate(sim, a, b)).toBe(true);
    expect(canMate(sim, a, a)).toBe(false);
  });

  it('rejects juveniles, the senescent, cooldowns, hunger, fatigue, injury and the dead', () => {
    const sim = makeSim();
    const b = spawnAdult(sim);
    const cases: [string, (a: Agent) => void][] = [
      ['juvenile', (a) => (a.age = a.traits.maturityAge - 1)],
      ['senescent', (a) => (a.age = Math.ceil(a.traits.longevity * 0.9))],
      ['cooldown', (a) => (a.reproCooldown = 5)],
      ['hungry', (a) => (a.food = a.traits.maxFood * (mateFoodThreshold(a.traits) - 0.01))],
      ['tired', (a) => (a.energy = 0.25)],
      ['injured', (a) => (a.health = a.traits.maxHealth * 0.2)],
      ['dead', (a) => sim.killAgent(a, 'removed')],
    ];
    for (const [label, mutateAgent] of cases) {
      const a = spawnAdult(sim);
      expect(canMate(sim, a, b), `${label} baseline`).toBe(true);
      mutateAgent(a);
      expect(canMate(sim, a, b), label).toBe(false);
      expect(canMate(sim, b, a), `${label} (reversed)`).toBe(false);
    }
  });

  it('fertile genomes breed on emptier stomachs', () => {
    const sim = makeSim();
    const lo = spawnAdult(sim, genome(0.5, { fertility: 0 }));
    const hi = spawnAdult(sim, genome(0.5, { fertility: 1 }));
    lo.food = lo.traits.maxFood * 0.6;
    hi.food = hi.traits.maxFood * 0.6;
    expect(isFertile(lo)).toBe(false);
    expect(isFertile(hi)).toBe(true);
  });

  it('rejects parent/child, full and half siblings', () => {
    const sim = makeSim();
    const p = spawnAdult(sim);
    const q = spawnAdult(sim);
    const r = spawnAdult(sim);
    const child = spawnAdult(sim, genome(), { parents: [p.id, q.id] });
    const full = spawnAdult(sim, genome(), { parents: [p.id, q.id] });
    const half = spawnAdult(sim, genome(), { parents: [r.id, q.id] });
    const stranger = spawnAdult(sim);
    expect(canMate(sim, p, child)).toBe(false);
    expect(canMate(sim, child, q)).toBe(false);
    expect(canMate(sim, child, full)).toBe(false);
    expect(canMate(sim, child, half)).toBe(false);
    expect(canMate(sim, child, stranger)).toBe(true);
    expect(canMate(sim, p, r)).toBe(true); // founders share NONE parents but are not siblings
  });

  it('rejects genetically incompatible partners and respects the population cap', () => {
    const sim = makeSim({ mateCompatibility: 0.1 });
    const a = spawnAdult(sim, genome(0.4));
    const near = spawnAdult(sim, genome(0.45));
    const far = spawnAdult(sim, genome(0.6));
    expect(canMate(sim, a, near)).toBe(true);
    expect(canMate(sim, a, far)).toBe(false);
    sim.state.config.maxAgents = sim.population;
    expect(canMate(sim, a, near)).toBe(false);
  });
});

describe('reproduce', () => {
  it('returns null and changes nothing when the pair cannot mate', () => {
    const sim = makeSim();
    const a = spawnAdult(sim);
    const b = spawnAdult(sim);
    b.reproCooldown = 10;
    const before = JSON.stringify([a, b]);
    const pop = sim.population;
    expect(reproduce(sim, a, b)).toBeNull();
    expect(JSON.stringify([a, b])).toBe(before);
    expect(sim.population).toBe(pop);
  });

  it('creates a registered child that inherits parental alleles, generation and the mother’s tribe', () => {
    const sim = makeSim({ mutationRate: 0 });
    const rng = new Rng(77);
    const a = spawnAdult(sim, randomGenes(rng), { generation: 3, tribeId: 5 });
    const b = spawnAdult(sim, randomGenes(rng), { generation: 7, tribeId: 9 });
    b.x += 4;
    const child = reproduce(sim, a, b)!;
    expect(child).not.toBeNull();
    expect(child.alive).toBe(true);
    expect(child.age).toBe(0);
    expect(child.generation).toBe(8);
    expect(child.parents).toEqual([a.id, b.id]);
    expect(child.tribeId).toBe(5);
    for (let i = 0; i < GENE_COUNT; i++) expect(child.genes[i] === a.genes[i] || child.genes[i] === b.genes[i]).toBe(true);
    expect(sim.getAgent(child.id)).toBe(child);
    expect(sim.lineageById.get(child.id)?.generation).toBe(8);
    expect(sim.state.stats.totals.births).toBe(1);
    expect(sim.passableAt(child.x, child.y)).toBe(true);
    expect(Math.hypot(child.x - (a.x + b.x) / 2, child.y - (a.y + b.y) / 2)).toBeLessThanOrEqual(6.01);
    // falls back to the father's tribe when the mother has none
    a.reproCooldown = b.reproCooldown = 0;
    a.food = a.traits.maxFood;
    b.food = b.traits.maxFood;
    a.energy = b.energy = 1;
    a.tribeId = NONE;
    expect(reproduce(sim, a, b)!.tribeId).toBe(9);
  });

  it('feeds the child from both parents, costs stamina and starts fertility-dependent cooldowns', () => {
    const sim = makeSim();
    const a = spawnAdult(sim, genome(0.5, { fertility: 0 }));
    const b = spawnAdult(sim, genome(0.5, { fertility: 1 }));
    const fa = a.food, fb = b.food;
    const child = reproduce(sim, a, b)!;
    const paidA = fa - a.food;
    const paidB = fb - b.food;
    expect(paidA).toBeCloseTo(parentalInvestment(a.traits) * a.traits.maxFood);
    expect(paidB).toBeCloseTo(parentalInvestment(b.traits) * b.traits.maxFood);
    expect(paidB).toBeLessThan(paidA); // fertile parent invests less
    expect(child.food).toBeCloseTo(paidA + paidB); // food is conserved
    expect(child.food).toBeLessThanOrEqual(child.traits.maxFood);
    expect(child.health).toBe(child.traits.maxHealth);
    expect(a.energy).toBeCloseTo(0.88);
    expect(b.energy).toBeCloseTo(0.88);
    expect(a.reproCooldown).toBe(1100);
    expect(b.reproCooldown).toBe(500);
    expect(canMate(sim, a, b)).toBe(false);
  });

  it('scales cooldowns by config.reproductionRate', () => {
    const sim = makeSim({ reproductionRate: 2 });
    const a = spawnAdult(sim);
    const b = spawnAdult(sim);
    reproduce(sim, a, b);
    expect(a.reproCooldown).toBe(400);
  });

  it('records children, offspring, history and kin bonds in both directions', () => {
    const sim = makeSim();
    const a = spawnAdult(sim);
    const b = spawnAdult(sim);
    const spy = vi.mocked(social.adjustRelationship);
    spy.mockClear();
    const c1 = reproduce(sim, a, b)!;
    expect(a.children).toEqual([c1.id]);
    expect(b.children).toEqual([c1.id]);
    expect(a.offspring).toBe(1);
    expect(b.offspring).toBe(1);
    expect(a.history.at(-1)?.text).toContain(c1.name);
    expect(c1.history.at(-1)?.text).toContain(a.name);
    void spy;
    for (const p of [a, b]) {
      expect(p.relationships.some((r) => r.id === c1.id && r.kin === 1)).toBe(true);
      expect(c1.relationships.some((r) => r.id === p.id && r.kin === 1)).toBe(true);
    }
    // a younger sibling bonds with the older one (kin 2)
    spy.mockClear();
    a.reproCooldown = b.reproCooldown = 0;
    a.food = a.traits.maxFood;
    b.food = b.traits.maxFood;
    a.energy = b.energy = 1;
    const c2 = reproduce(sim, a, b)!;
    expect(c2.relationships.some((r) => r.id === c1.id && r.kin === 2)).toBe(true);
    expect(c1.relationships.some((r) => r.id === c2.id && r.kin === 2)).toBe(true);
    // the children list is capped
    for (let i = 0; i < LIMITS.children + 3; i++) {
      a.reproCooldown = b.reproCooldown = 0;
      a.food = a.traits.maxFood;
      b.food = b.traits.maxFood;
      a.energy = b.energy = 1;
      expect(reproduce(sim, a, b)).not.toBeNull();
    }
    expect(a.children.length).toBe(LIMITS.children);
    expect(a.offspring).toBe(LIMITS.children + 5);
  });

  it('logs generation milestones once and prolific-parent records', () => {
    const sim = makeSim();
    const a = spawnAdult(sim, genome(), { generation: 9 });
    const b = spawnAdult(sim, genome(), { generation: 4 });
    a.offspring = 9;
    const reset = () => {
      a.reproCooldown = b.reproCooldown = 0;
      a.food = a.traits.maxFood;
      b.food = b.traits.maxFood;
      a.energy = b.energy = 1;
    };
    reproduce(sim, a, b);
    const evo = () => sim.state.events.filter((e) => e.category === 'evolution' && e.message.includes('Generation 10'));
    expect(evo()).toHaveLength(1);
    expect(sim.state.events.some((e) => e.category === 'record' && e.agentId === a.id)).toBe(true);
    reset();
    reproduce(sim, a, b);
    expect(evo()).toHaveLength(1); // not repeated for later generation-10 births
  });

  it('works mid-tick: the child joins the world at the end of the tick', () => {
    const sim = makeSim();
    const a = spawnAdult(sim);
    const b = spawnAdult(sim);
    const n = sim.state.agents.length;
    // Simulate being inside step() (brain calls reproduce mid-tick) without depending on other modules.
    (sim as unknown as { stepping: boolean }).stepping = true;
    const child = reproduce(sim, a, b)!;
    expect(sim.state.agents.length).toBe(n);
    expect(sim.population).toBe(n + 1);
    (sim as unknown as { stepping: boolean }).stepping = false;
    sim.flush();
    expect(sim.state.agents).toContain(child);
  });
});
