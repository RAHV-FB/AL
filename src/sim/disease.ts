// OWNER: Disasters & Disease agent.
/**
 * Infectious disease.
 *
 *  - Transmission (every DISEASE.transmitInterval ticks): each infected agent may
 *    infect susceptible neighbours within DISEASE.transmitRadius. Probability ∝
 *    strain virulence × config.diseaseVirulence × (1 − 0.8·immunity) × closeness,
 *    so dense, sociable groups spread disease fastest (emerges from proximity).
 *  - Pathogen evolution: each transmission mutates the strain's virulence by up to
 *    ±DISEASE.mutation (clamped 0.05..1). Virulent strains spread faster but kill
 *    (and exhaust) their hosts sooner.
 *  - Progression (every tick): continuous health drain + random acute crises
 *    (∝ virulence × (1 − 0.75·immunity) × lethality × vulnerability), energy loss,
 *    natural healing partly suppressed. Death (health ≤ 0) → killAgent(a, 'disease').
 *    Tuned (with lifecycle healing) so mortality ≈ 20–35% at virulence 0.6 / immunity 0.5 / default config.
 *  - Recovery grants acquired immunity for DISEASE.immuneMin..immuneMax ticks.
 *
 * Determinism: randomness only via sim.rng. Module state (WeakMap) only drives
 * epidemic event logging, never the simulation trajectory, so save/load is exact.
 */
import type { Simulation } from './simulation';
import { LIMITS } from './constants';
import type { Agent } from './types';

/** Tunable disease constants. */
export const DISEASE = {
  /** Contact radius (world units) for transmission. */
  transmitRadius: 10,
  /** Transmission is evaluated every N ticks (progression runs every tick). */
  transmitInterval: 2,
  /** Base per-contact-check transmission probability (× virulence × config.diseaseVirulence × susceptibility). */
  beta: 0.08,
  /** Max strain-virulence drift per transmission (uniform ±). */
  mutation: 0.03,
  minVirulence: 0.05,
  maxVirulence: 1,
  /** Infection length (ticks) before immunity shortening. */
  durationMin: 500,
  durationMax: 900,
  /** Fraction by which immunity 1 shortens the infection. */
  immunityShortening: 0.35,
  /** Damage reduction from the immunity trait: × (1 − k·immunity). */
  immunityProtection: 0.75,
  /** Infection-chance reduction from the immunity trait: × (1 − k·immunity). */
  immunityResistance: 0.8,
  /** Continuous health loss per tick, as a fraction of maxHealth per unit severity. */
  drain: 0.0024,
  /** Per-tick chance (per unit severity) of an acute crisis. */
  crisisChance: 0.0095,
  /** Crisis damage range as a fraction of maxHealth. */
  crisisMin: 0.12,
  crisisMax: 0.32,
  /** Fraction of natural healing (since the last disease update) blocked while infected. */
  healSuppression: 0.8,
  /** Stamina lost per tick per unit virulence. */
  energyDrain: 0.0012,
  /** Acquired immunity after recovery (ticks). */
  immuneMin: 2500,
  immuneMax: 4000,
  /** Infected count above which an epidemic is declared (event log). */
  epidemicThreshold: 10,
};

// ---------------------------------------------------------------- helpers

/** Clamp to [0,1]; NaN → fallback. */
function unit(v: number, fallback: number): number {
  if (v >= 0) return v <= 1 ? v : 1;
  return Number.isNaN(v) ? fallback : 0;
}

function clampVirulence(v: number): number {
  if (!(v >= DISEASE.minVirulence)) return DISEASE.minVirulence; // also catches NaN
  return v > DISEASE.maxVirulence ? DISEASE.maxVirulence : v;
}

function immunityOf(a: Agent): number {
  return unit(a.traits.immunity, 0.5);
}

/** Global plague multiplier from config (NaN/negative → 0). */
function configVirulence(sim: Simulation): number {
  const v = sim.config.diseaseVirulence;
  return v > 0 ? Math.min(v, 5) : 0;
}

/** Lethality multiplier: 1 at the default config.diseaseVirulence (0.5). */
function lethality(cfgV: number): number {
  return 0.5 + cfgV;
}

/** Young, elderly and malnourished hosts suffer more. */
function vulnerability(a: Agent): number {
  const t = a.traits;
  let m = 1;
  if (a.age < t.maturityAge) m *= 1.25;
  else if (t.longevity > 0 && a.age > 0.85 * t.longevity) m *= 1.4;
  if (t.maxFood > 0 && a.food < 0.2 * t.maxFood) m *= 1.3;
  return m;
}

function pushHistory(sim: Simulation, a: Agent, text: string): void {
  a.history.push({ tick: sim.state.tick, text });
  if (a.history.length > LIMITS.history) a.history.splice(0, a.history.length - LIMITS.history);
}

// ---------------------------------------------------------------- epidemic tracking (logging only)

interface EpidemicState {
  fresh: boolean;
  active: boolean;
  pandemic: boolean;
  deaths: number;
  peak: number;
}

const epidemics = new WeakMap<Simulation, EpidemicState>();

function epidemicState(sim: Simulation): EpidemicState {
  let st = epidemics.get(sim);
  if (!st) {
    st = { fresh: true, active: false, pandemic: false, deaths: 0, peak: 0 };
    epidemics.set(sim, st);
  }
  return st;
}

function trackEpidemic(sim: Simulation, st: EpidemicState, infected: number): void {
  const threshold = DISEASE.epidemicThreshold;
  if (st.fresh) {
    st.fresh = false;
    // Loaded mid-run with an epidemic under way: adopt it silently (no duplicate log).
    if (sim.state.tick > 0 && infected > threshold) {
      st.active = true;
      st.peak = infected;
      return;
    }
  }
  if (infected > st.peak) st.peak = infected;
  if (!st.active && infected > threshold) {
    st.active = true;
    sim.log('disease', 'bad', `Epidemic spreading: ${infected} infected`);
  }
  if (st.active && !st.pandemic) {
    const pop = sim.state.agents.length;
    if (infected > Math.max(50, 0.25 * pop)) {
      st.pandemic = true;
      const pct = pop > 0 ? Math.round((100 * infected) / pop) : 100;
      sim.log('disease', 'major', `Pandemic: ${infected} infected (${pct}% of the population)`);
    }
  }
  if (infected === 0) {
    if (st.active) {
      sim.log('disease', 'good', `The epidemic has burned out — ${st.deaths} died (peak ${st.peak} infected)`);
    }
    st.active = false;
    st.pandemic = false;
    st.deaths = 0;
    st.peak = 0;
  }
}

// ---------------------------------------------------------------- public API

/**
 * Infect an agent with a strain of the given virulence (respecting acquired
 * immunity and current infection). Returns true if newly infected.
 * Duration ≈ 500–900 ticks, shortened by the immunity trait.
 */
export function infect(sim: Simulation, agent: Agent, virulence: number): boolean {
  if (!agent.alive || agent.infection > 0 || agent.immuneTicks > 0) return false;
  if (!(virulence > 0)) return false;
  const v = clampVirulence(virulence);
  const imm = immunityOf(agent);
  const base = DISEASE.durationMin + sim.rng.next() * (DISEASE.durationMax - DISEASE.durationMin);
  agent.infection = Math.max(1, Math.round(base * (1 - DISEASE.immunityShortening * imm)));
  agent.virulence = v;
  agent.diseaseHp = undefined;
  pushHistory(sim, agent, `Fell ill (strain virulence ${v.toFixed(2)})`);
  return true;
}

/** Number of living infected agents. */
export function infectedCount(sim: Simulation): number {
  let n = 0;
  const agents = sim.state.agents;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    if (a.alive && a.infection > 0) n++;
  }
  return n;
}

// Reusable scratch arrays (never held across calls).
const sickScratch: Agent[] = [];
const nearScratch: Agent[] = [];

/** One transmission round from `src`. Returns the number of new infections. */
function spread(sim: Simulation, src: Agent, cfgV: number): number {
  const R = DISEASE.transmitRadius;
  const near = sim.spatial.query(src.x, src.y, R, nearScratch, src);
  if (near.length === 0) return 0;
  const rng = sim.rng;
  const base = DISEASE.beta * src.virulence * cfgV;
  let n = 0;
  for (let i = 0; i < near.length; i++) {
    const t = near[i];
    if (!t.alive || t.infection > 0 || t.immuneTicks > 0) continue;
    const dx = t.x - src.x;
    const dy = t.y - src.y;
    const closeness = 1 - (0.5 * Math.sqrt(dx * dx + dy * dy)) / R;
    const p = base * (1 - DISEASE.immunityResistance * immunityOf(t)) * closeness;
    if (rng.next() < p) {
      const strain = src.virulence + (rng.next() * 2 - 1) * DISEASE.mutation;
      if (infect(sim, t, clampVirulence(strain))) n++;
    }
  }
  near.length = 0;
  return n;
}

function recover(sim: Simulation, a: Agent): void {
  a.infection = 0;
  a.virulence = 0;
  a.diseaseHp = undefined;
  a.immuneTicks = Math.round(DISEASE.immuneMin + sim.rng.next() * (DISEASE.immuneMax - DISEASE.immuneMin));
  pushHistory(sim, a, 'Recovered from illness (now immune)');
}

/** Transmission, progression, recovery, immunity, disease deaths. */
export function updateDisease(sim: Simulation): void {
  const s = sim.state;
  const agents = s.agents;
  const st = epidemicState(sim);

  // Phase 0: acquired-immunity countdown + snapshot of currently infected agents
  // (agents infected during this call start progressing/transmitting next tick).
  const sick = sickScratch;
  sick.length = 0;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    if (!a.alive) continue;
    const it = a.immuneTicks;
    if (it > 0) a.immuneTicks = it > 1 ? it - 1 : 0;
    else if (it !== 0) a.immuneTicks = 0; // sanitise negatives / NaN
    if (a.infection > 0) sick.push(a);
  }
  if (sick.length === 0) {
    trackEpidemic(sim, st, 0);
    return;
  }

  const cfgV = configVirulence(sim);

  // Phase 1: transmission.
  let newCases = 0;
  if (cfgV > 0 && s.tick % DISEASE.transmitInterval === 0) {
    for (let i = 0; i < sick.length; i++) {
      const a = sick[i];
      if (!(a.virulence > 0)) a.virulence = DISEASE.minVirulence;
      newCases += spread(sim, a, cfgV);
    }
  }

  // Phase 2: progression. (killAgent may flush s.agents outside a tick; we iterate the snapshot.)
  const L = lethality(cfgV);
  const rng = sim.rng;
  let deaths = 0;
  let recovered = 0;
  for (let i = 0; i < sick.length; i++) {
    const a = sick[i];
    if (!a.alive) continue;
    const v = clampVirulence(a.virulence);
    a.virulence = v;
    const imm = immunityOf(a);
    const maxH = a.traits.maxHealth > 0 ? a.traits.maxHealth : 100;

    // The immune response consumes the body's resources: most natural healing since
    // our last update is cancelled (large jumps, e.g. user "boost", are left alone).
    const prev = a.diseaseHp;
    if (prev !== undefined && a.health > prev) {
      const healed = a.health - prev;
      if (healed < 0.05 * maxH) a.health -= healed * DISEASE.healSuppression;
    }

    const sev = v * (1 - DISEASE.immunityProtection * imm) * L * vulnerability(a);
    let dmg = maxH * DISEASE.drain * sev;
    if (rng.next() < DISEASE.crisisChance * sev) {
      dmg += maxH * (DISEASE.crisisMin + rng.next() * (DISEASE.crisisMax - DISEASE.crisisMin));
    }
    a.health -= dmg;
    if (a.energy > 0) {
      const e = a.energy - DISEASE.energyDrain * v * (1 - 0.5 * imm);
      a.energy = e > 0 ? e : 0;
    } else if (a.energy !== 0) a.energy = 0;

    if (!(a.health > 0)) {
      deaths++;
      st.deaths++;
      a.diseaseHp = undefined;
      sim.killAgent(a, 'disease');
      continue;
    }
    a.diseaseHp = a.health;
    a.infection -= 1;
    if (a.infection <= 0) {
      recover(sim, a);
      recovered++;
    }
  }
  const infectedNow = sick.length - deaths - recovered + newCases;
  sick.length = 0;
  trackEpidemic(sim, st, infectedNow);
}
