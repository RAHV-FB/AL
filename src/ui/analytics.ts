/**
 * Overview panel (OWNER: UI panels). From top to bottom: a few plain sentences about what is happening now
 * (describeNow), key numbers with small trend lines, one population chart, the tribes list, and the detailed
 * charts folded under "More charts". Everything is read from the simulation (sim.state, sim.state.stats).
 * Cheap when nothing changed: charts are rebuilt only when a new sample arrives (or the range or gene changes).
 *
 * This module also holds the labels, colours and calendar helpers shared with the inspector and the event log.
 * It has no DOM access at import time, so its pure helpers (describeNow, tribeSummaries, dayOfTick, ...) run
 * in node tests.
 */
import './analytics.css';
import type { Simulation } from '../sim/simulation';
import {
  DEATH_CAUSES,
  GENE_COUNT,
  GENES,
  HIST_BINS,
  NONE,
  type ActionKind,
  type DeathCause,
  type Disaster,
  type DisasterKind,
  type GeneName,
  type Role,
  type SimEvent,
  type StatsSample,
  type Tribe,
  type TribeId,
} from '../sim/types';
import { ROLES, currentSummary } from '../sim/stats';
import { DAY_START, estimateCarryingCapacity, tileCapacity } from '../sim/ecology';
import { SOCIAL_TUNING } from '../sim/social';
import { BarChart, COLORS, Heatmap, LineChart, Sparkline, StackedAreaChart, esc, formatNum, formatPct } from './charts';

export interface AnalyticsPanel {
  /** Refresh from the simulation (called a few times a second by the app; cheap when nothing changed). */
  update(sim: Simulation, force?: boolean): void;
}

export interface AnalyticsPanelOptions {
  /** Move the camera to a world position (a tribe row calls it with the tribe's camp position). */
  onJump?(x: number, y: number): void;
}

// ------------------------------------------------------------------ shared labels and colours

const NEUTRAL = '#6b675d';
const OTHER = COLORS.slate;

/** What an agent is doing, as a short phrase ("Looking for food"). */
export const ACTION_LABELS: Record<ActionKind, string> = {
  idle: 'Idling',
  wander: 'Wandering',
  explore: 'Exploring',
  forage: 'Looking for food',
  eat: 'Eating',
  rest: 'Resting',
  flee: 'Fleeing',
  attack: 'Fighting',
  share: 'Sharing food',
  mate: 'Courting',
  socialize: 'Socializing',
  gohome: 'Going home',
  deposit: 'Storing food at camp',
  withdraw: 'Taking food from camp',
};

/** The same actions as options the brain weighs (the inspector's "Why" list). */
export const OPTION_LABELS: Record<ActionKind, string> = {
  idle: 'Idle',
  wander: 'Wander',
  explore: 'Explore',
  forage: 'Look for food',
  eat: 'Eat',
  rest: 'Rest',
  flee: 'Flee',
  attack: 'Attack',
  share: 'Share food',
  mate: 'Court a mate',
  socialize: 'Socialize',
  gohome: 'Go home',
  deposit: 'Store food at camp',
  withdraw: 'Take food from camp',
};

export const CAUSE_LABELS: Record<DeathCause, string> = {
  starvation: 'Starvation',
  old_age: 'Old age',
  combat: 'Combat',
  disease: 'Disease',
  disaster: 'Disaster',
  removed: 'Removed by you',
};
export const CAUSE_COLORS: Record<DeathCause, string> = {
  starvation: COLORS.ochre,
  old_age: COLORS.slate,
  combat: COLORS.rust,
  disease: COLORS.moss,
  disaster: COLORS.water,
  removed: COLORS.sand,
};
export const ROLE_LABELS: Record<Role, string> = { none: 'Unassigned', forager: 'Forager', warrior: 'Warrior', caretaker: 'Caretaker', explorer: 'Explorer' };
export const ROLE_COLORS: Record<Role, string> = { none: NEUTRAL, forager: COLORS.sage, warrior: COLORS.rust, caretaker: COLORS.sand, explorer: COLORS.water };

export const GENE_LABELS: Record<GeneName, string> = {
  speed: 'Speed',
  size: 'Size',
  perception: 'Perception',
  metabolism: 'Metabolism',
  aggression: 'Aggression',
  sociability: 'Sociability',
  altruism: 'Altruism',
  fertility: 'Fertility',
  longevity: 'Longevity',
  immunity: 'Immunity',
  efficiency: 'Efficiency',
  hue: 'Hue',
};
export const GENE_DESCRIPTIONS: Record<GeneName, string> = {
  speed: 'Movement speed. A fast agent reaches food first but burns more energy.',
  size: 'Body size. More strength and health, but more food to stay alive.',
  perception: 'How far it sees food and danger.',
  metabolism: 'Metabolic rate. It heals faster but gets hungry sooner.',
  aggression: 'How readily it fights and steals.',
  sociability: 'How much it seeks company. It holds tribes together.',
  altruism: 'How readily it shares food and helps others.',
  fertility: 'Reproductive drive: many cheap offspring or a few well-fed ones.',
  longevity: 'Maximum lifespan. It costs extra food to sustain.',
  immunity: 'Resistance to disease. It costs extra food to sustain.',
  efficiency: 'Food gained per bite.',
  hue: 'Color only. It drifts at random, so it traces family lines.',
};

/** Tribe colour used everywhere (map bodies, territory, charts, swatches). */
export function tribeColor(hue: number): string {
  const h = Number.isFinite(hue) ? Math.round(((hue % 360) + 360) % 360) : 0;
  return `hsl(${h}, 45%, 58%)`;
}

// ------------------------------------------------------------------ calendar

function dayLenOf(sim: Simulation): number {
  return Math.max(1, Math.round(sim.config.dayLength || 600));
}

/**
 * Calendar day (1-based) of a tick, numbered exactly like the top-bar clock: "Day 1" is the first
 * day, and the clock starts DAY_START into it (same formula as ecology's clock), so the event log,
 * inspector and stats never label a moment with a different day than the clock showed.
 */
export function dayOfTick(sim: Simulation, tick: number): number {
  const dl = dayLenOf(sim);
  return Math.floor((Math.max(0, tick) + Math.round(DAY_START * dl)) / dl) + 1;
}

/**
 * The same calendar as a continuous position for chart x axes ("Day 7.5" = half way through the
 * clock's Day 7): Math.floor(dayPosOfTick(t)) === dayOfTick(t), so a chart and the event log agree.
 */
export function dayPosOfTick(sim: Simulation, tick: number): number {
  const dl = dayLenOf(sim);
  return (Math.max(0, tick) + Math.round(DAY_START * dl)) / dl + 1;
}

/** "Day 3, 14:00": the calendar day and the clock time (to 10 minutes) of a tick. */
export function clockOfTick(sim: Simulation, tick: number): string {
  const pos = dayPosOfTick(sim, tick);
  const day = Math.floor(pos);
  const mins = Math.min(24 * 60 - 1, Math.floor((pos - day) * 24 * 60 + 1e-6));
  const hh = Math.floor(mins / 60);
  const mm = Math.floor((mins % 60) / 10) * 10;
  return `Day ${day}, ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ plain-language summaries (pure)

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');
const plural = (n: number, noun: string, many = `${noun}s`): string => `${fmtInt(n)} ${Math.round(n) === 1 ? noun : many}`;

/** "A", "A and B", "A, B and C", "A, B and 3 others". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/** A round figure for "about N": 2 significant digits. */
function roundAbout(v: number): number {
  if (!(v > 0)) return 0;
  const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(v)) - 1));
  return Math.round(v / mag) * mag;
}

/** Standing plant food on the map and the most it can hold now (sum of tile capacities). */
export function landFood(sim: Simulation): { food: number; capacity: number } {
  const w = sim.state.world;
  let food = 0;
  let capacity = 0;
  for (let i = 0; i < w.food.length; i++) {
    const f = w.food[i];
    if (f > 0) food += f;
    capacity += tileCapacity(sim, i);
  }
  return { food, capacity };
}

/** Living agents per tribe (from the agents themselves, so the numbers match the population). */
function census(sim: Simulation): { pop: number; loners: number; infected: number; members: Map<TribeId, number> } {
  let pop = 0;
  let loners = 0;
  let infected = 0;
  const members = new Map<TribeId, number>();
  for (const a of sim.state.agents) {
    if (!a.alive) continue;
    pop++;
    if (a.infection > 0) infected++;
    if (a.tribeId === NONE) loners++;
    else members.set(a.tribeId, (members.get(a.tribeId) ?? 0) + 1);
  }
  return { pop, loners, infected, members };
}

const PAIR = 1048576; // social.ts pair keys: smaller id * 2^20 + larger id

/**
 * Pairs of living tribes at war and allied: as the event log announced them (state.diplomacy), or from the
 * tribe relations with the same thresholds when an older save has no diplomacy record.
 */
export function tribePairs(sim: Simulation, ids: ReadonlySet<TribeId>): { wars: [TribeId, TribeId][]; alliances: [TribeId, TribeId][] } {
  const wars: [TribeId, TribeId][] = [];
  const alliances: [TribeId, TribeId][] = [];
  const d = sim.state.diplomacy;
  if (d && Array.isArray(d.wars) && Array.isArray(d.alliances)) {
    const decode = (k: number, out: [TribeId, TribeId][]) => {
      const a = Math.floor(k / PAIR);
      const b = k - a * PAIR;
      if (ids.has(a) && ids.has(b) && a !== b) out.push([a, b]);
    };
    for (const k of d.wars) decode(k, wars);
    for (const k of d.alliances) decode(k, alliances);
    return { wars, alliances };
  }
  const list = [...ids].sort((a, b) => a - b);
  for (let i = 0; i < list.length; i++) {
    const ta = sim.getTribe(list[i]);
    if (!ta) continue;
    for (let j = i + 1; j < list.length; j++) {
      const tb = sim.getTribe(list[j]);
      if (!tb) continue;
      const m = meanRelation(ta, tb);
      if (m < SOCIAL_TUNING.warDeclare) wars.push([ta.id, tb.id]);
      else if (m > SOCIAL_TUNING.alliance) alliances.push([ta.id, tb.id]);
    }
  }
  return { wars, alliances };
}

function meanRelation(a: Tribe, b: Tribe): number {
  const v = ((a.relations[b.id] ?? 0) + (b.relations[a.id] ?? 0)) / 2;
  return Number.isFinite(v) ? v : 0;
}

export interface TribeSummary {
  id: TribeId;
  name: string;
  hue: number;
  /** Living members. */
  members: number;
  /** Food in the camp store. */
  stored: number;
  /** Camp position (world units). */
  x: number;
  y: number;
  /** Relations to the other living tribes in words, e.g. "At war with Crimson Raiders". */
  relations: string;
}

/** Living tribes, largest first, with their relations in words. */
export function tribeSummaries(sim: Simulation): TribeSummary[] {
  const { members } = census(sim);
  const living = sim.state.tribes.filter((t) => t.extinctTick === -1 && (members.get(t.id) ?? 0) > 0);
  const ids = new Set(living.map((t) => t.id));
  const { wars, alliances } = tribePairs(sim, ids);
  const warWith = new Map<TribeId, TribeId[]>();
  const allyWith = new Map<TribeId, TribeId[]>();
  const note = (map: Map<TribeId, TribeId[]>, a: TribeId, b: TribeId) => {
    let arr = map.get(a);
    if (!arr) map.set(a, (arr = []));
    arr.push(b);
  };
  for (const [a, b] of wars) {
    note(warWith, a, b);
    note(warWith, b, a);
  }
  for (const [a, b] of alliances) {
    note(allyWith, a, b);
    note(allyWith, b, a);
  }
  const bySize = (a: TribeId, b: TribeId) => (members.get(b) ?? 0) - (members.get(a) ?? 0) || a - b;
  const nameOf = (id: TribeId) => sim.getTribe(id)?.name ?? `Tribe ${id}`;
  const out: TribeSummary[] = living.map((t) => {
    const atWar = (warWith.get(t.id) ?? []).sort(bySize);
    const allied = (allyWith.get(t.id) ?? []).sort(bySize);
    // hostile without a declared war: members of the two tribes treat each other as enemies
    const hostile = living
      .filter((o) => o.id !== t.id && !atWar.includes(o.id) && !allied.includes(o.id) && meanRelation(t, o) <= SOCIAL_TUNING.warHostile)
      .map((o) => o.id)
      .sort(bySize);
    const parts: string[] = [];
    if (atWar.length) parts.push(`at war with ${listNames(atWar.map(nameOf))}`);
    if (hostile.length) parts.push(`hostile toward ${listNames(hostile.map(nameOf))}`);
    if (allied.length) parts.push(`allied with ${listNames(allied.map(nameOf))}`);
    let relations = parts.join('; ');
    if (!relations) relations = living.length > 1 ? 'at peace' : 'the only tribe';
    relations = relations[0].toUpperCase() + relations.slice(1);
    const stored = Number.isFinite(t.stockpile) ? Math.max(0, t.stockpile) : 0;
    return { id: t.id, name: t.name, hue: t.hue, members: members.get(t.id) ?? 0, stored, x: t.homeX, y: t.homeY, relations };
  });
  out.sort((a, b) => b.members - a.members || a.id - b.id);
  return out;
}

const DISASTER_NOUN: Record<DisasterKind, string> = {
  drought: 'a drought',
  blight: 'a blight',
  bloom: 'a period of abundance',
  plague: 'a plague outbreak',
  meteor: 'a meteor strike',
  coldsnap: 'a cold snap',
};

function daysLeftText(d: Disaster, tick: number, dl: number): string {
  const left = Math.max(0, d.startTick + d.duration - tick) / dl;
  if (left >= 1.5) return `${Math.round(left)} days left`;
  if (left >= 0.75) return 'about a day left';
  return 'less than a day left';
}

const capFirst = (t: string): string => (t ? t[0].toUpperCase() + t.slice(1) : t);

/**
 * Text written by the simulation (thoughts, life stories, event messages), shown without dashes: a spaced dash
 * between two clauses becomes a comma, a dash between numbers becomes "to".
 */
export function plainText(t: string): string {
  if (!t || !/[\u2012-\u2015]/.test(t)) return t;
  return t
    .replace(/(\d)\s*[\u2012-\u2015]\s*(\d)/g, '$1 to $2')
    .replace(/\s*[\u2012-\u2015]\s*/g, ', ')
    .replace(/,\s*,/g, ',');
}

/**
 * Three to six short plain sentences about what is happening now, from the simulation's real state only:
 * the population and its tribes, the change over the last day, food against what the land can hold and
 * feed, wars, disease, disasters under way and the latest major event. A sentence is left out when its
 * data is missing (no samples yet, a single tribe, nobody sick, ...).
 */
export function describeNow(sim: Simulation): string[] {
  const s = sim.state;
  const tick = s.tick;
  const dl = dayLenOf(sim);
  const lines: { order: number; prio: number; text: string }[] = [];
  const add = (order: number, prio: number, text: string) => lines.push({ order, prio, text });
  const { pop, loners, infected, members } = census(sim);
  const tribes = members.size;

  // 1. who is alive
  if (pop === 0) add(0, 0, 'No agents are alive.');
  else if (tribes === 0) add(0, 0, `${plural(pop, 'agent')} ${pop === 1 ? 'is' : 'are'} alive${s.config.tribesEnabled ? ', none of them in a tribe' : ''}.`);
  else if (loners === 0) add(0, 0, `${plural(pop, 'agent')} ${pop === 1 ? 'lives' : 'live'} in ${plural(tribes, 'tribe')}.`);
  else add(0, 0, `${plural(pop, 'agent')}: ${fmtInt(pop - loners)} in ${plural(tribes, 'tribe')} and ${fmtInt(loners)} on ${loners === 1 ? 'its' : 'their'} own.`);

  // 2. change over the last day (or since the first sample when the run is younger than a day)
  const samples = s.stats.samples;
  let ref: StatsSample | null = null;
  let since = false;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].tick <= tick - dl) {
      ref = samples[i];
      break;
    }
  }
  if (!ref && samples.length && samples[0].tick <= tick - dl * 0.1) {
    ref = samples[0];
    since = true;
  }
  if (ref) {
    let births = s.stats.counters.births;
    let deaths = s.stats.counters.deaths;
    for (let i = samples.length - 1; i >= 0 && samples[i].tick > ref.tick; i--) {
      births += samples[i].births;
      deaths += samples[i].deaths;
    }
    const delta = pop - ref.population;
    const steady = Math.abs(delta) <= Math.max(1, Math.round(ref.population * 0.01));
    const when = since ? 'since the start' : 'over the last day';
    let text: string;
    if (steady) text = since ? `The population has held steady ${when}` : `The population held steady ${when}`;
    else if (delta > 0) text = since ? `The population has grown by ${fmtInt(delta)} ${when}` : `The population grew by ${fmtInt(delta)} ${when}`;
    else text = since ? `The population has fallen by ${fmtInt(-delta)} ${when}` : `The population fell by ${fmtInt(-delta)} ${when}`;
    if (births > 0 || deaths > 0) text += ` (${plural(births, 'birth')}, ${plural(deaths, 'death')})`;
    add(1, 1, `${text}.`);
  }

  // the hard population cap (a setting): births and spawns stop there, whatever the food
  const maxAgents = s.config.maxAgents;
  if (maxAgents > 0 && pop >= maxAgents) add(0.5, 1.5, `The population has reached the cap of ${fmtInt(maxAgents)} set for this world, so no more can be born.`);

  // 3. food against what the land can hold, and how many its regrowth could feed
  const { food, capacity: cap } = landFood(sim);
  if (cap > 0 && Number.isFinite(food)) {
    let text = `Food stands at ${Math.round((100 * food) / cap)}% of what the land can hold`;
    let feed = NaN;
    try {
      feed = estimateCarryingCapacity(sim);
    } catch {
      /* informational only */
    }
    if (Number.isFinite(feed)) {
      if (feed < 1) text += '; its regrowth could not feed a single agent right now';
      else text += `; its regrowth could feed at most about ${fmtInt(roundAbout(feed))} agents${pop > feed ? ', fewer than are alive now' : ''}`;
    }
    add(2, 5, `${text}.`);
  }

  // 4. wars and alliances (two or more living tribes)
  const living = s.tribes.filter((t) => t.extinctTick === -1 && (members.get(t.id) ?? 0) > 0);
  if (living.length >= 2) {
    const ids = new Set(living.map((t) => t.id));
    const { wars, alliances } = tribePairs(sim, ids);
    const size = (p: [TribeId, TribeId]) => (members.get(p[0]) ?? 0) + (members.get(p[1]) ?? 0);
    const name = (id: TribeId) => sim.getTribe(id)?.name ?? `Tribe ${id}`;
    const pair = (p: [TribeId, TribeId]) => `${name(p[0])} and ${name(p[1])}`;
    wars.sort((a, b) => size(b) - size(a));
    alliances.sort((a, b) => size(b) - size(a));
    if (wars.length === 1) add(3, 2, `${pair(wars[0])} are at war.`);
    else if (wars.length === 2) add(3, 2, `${pair(wars[0])} are at war, and so are ${pair(wars[1])}.`);
    else if (wars.length > 2) add(3, 2, `${wars.length} pairs of tribes are at war, among them ${pair(wars[0])}.`);
    else if (alliances.length === 1) add(3, 7, `No tribes are at war; ${pair(alliances[0])} are allies.`);
    else if (alliances.length > 1) add(3, 7, `No tribes are at war; ${alliances.length} pairs are allies, among them ${pair(alliances[0])}.`);
    else add(3, 7, 'No tribes are at war.');
  }

  // 5. disease
  if (infected > 0) {
    const ep = s.epidemic;
    if (ep && ep.active) {
      const dead = ep.deaths > 0 ? `, ${fmtInt(ep.deaths)} dead so far` : '';
      add(4, 3, `${ep.pandemic ? 'A pandemic' : 'An epidemic'} is spreading: ${fmtInt(infected)} infected now${dead}.`);
    } else add(4, 3, `${plural(infected, 'agent')} ${infected === 1 ? 'is' : 'are'} sick.`);
  }

  // 6. disasters (and abundance) under way; meteor strikes are instant, the event log reports them
  const active = s.disasters.filter((d) => d.active && d.kind !== 'meteor' && d.startTick <= tick && d.startTick + d.duration > tick);
  if (active.length) {
    active.sort((a, b) => b.intensity - a.intensity || a.id - b.id);
    const what = (d: Disaster) => `${DISASTER_NOUN[d.kind] ?? 'a disaster'}${d.radius <= 0 ? ' across the whole map' : ''}`;
    if (active.length === 1) add(5, 4, `${capFirst(what(active[0]))} is under way (${daysLeftText(active[0], tick, dl)}).`);
    else add(5, 4, `${capFirst(listNames(active.map((d) => `${what(d)} (${daysLeftText(d, tick, dl)})`)))} are under way.`);
  }

  // 7. the latest major event of the last two days, unless a sentence above already covers it (the war it
  // declared, the epidemic, the disaster under way)
  const evs = s.events;
  let latest: SimEvent | null = null;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.tick < tick - 2 * dl) break;
    if (e.severity === 'major' && e.category !== 'intervention') {
      latest = e;
      break;
    }
  }
  const said = (order: number) => lines.some((l) => l.order === order);
  if (latest) {
    const m = latest.message;
    if (latest.category === 'conflict' && /\bwar\b/i.test(m) && lines.some((l) => l.order === 3 && /at war/.test(l.text))) latest = null;
    else if (latest.category === 'disease' && said(4)) latest = null;
    else if (latest.category === 'disaster' && said(5) && !/meteor/i.test(m)) latest = null;
  }
  if (latest && latest.message) {
    const msg = plainText(latest.message.trim());
    add(6, 6, `Day ${dayOfTick(sim, latest.tick)}: ${/[.!?]$/.test(msg) ? msg : `${msg}.`}`);
  }

  // at most six: drop the least important first, keep the reading order
  const keep = [...lines].sort((a, b) => a.prio - b.prio).slice(0, 6);
  return keep.sort((a, b) => a.order - b.order).map((l) => l.text);
}

// ------------------------------------------------------------------ DOM helpers

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

const legendCache = new WeakMap<HTMLElement, string>();
function renderLegend(el: HTMLElement, items: { name: string; color: string; value?: string }[], empty?: string): void {
  const html = items.length
    ? items.map((it) => `<span class="an-leg-item"><i style="background:${it.color}"></i>${esc(it.name)}${it.value !== undefined ? ` <b>${esc(it.value)}</b>` : ''}</span>`).join('')
    : `<span class="an-leg-empty">${esc(empty ?? '')}</span>`;
  if (legendCache.get(el) === html) return;
  legendCache.set(el, html);
  el.innerHTML = html;
}

/** Trailing-window rate per day of a flow counter (window in ticks). */
function rollingRate(samples: StatsSample[], get: (s: StatsSample) => number, windowTicks: number, dayLen: number, interval: number): Float64Array {
  const n = samples.length;
  const out = new Float64Array(n);
  let first = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += get(samples[i]);
    while (first < i && samples[i].tick - samples[first].tick >= windowTicks) {
      sum -= get(samples[first]);
      first++;
    }
    const startTick = first > 0 ? samples[first - 1].tick : samples[0].tick - interval;
    out[i] = (sum / Math.max(1, samples[i].tick - startTick)) * dayLen;
  }
  return out;
}

const dayFmt = (v: number) => `Day ${formatNum(v)}`;
// truncated, not rounded: "Day 11.0" late on Day 10 would contradict the clock
const dayHover = (v: number) => {
  const k = v < 10 ? 100 : 10;
  return `Day ${(Math.floor(v * k + 1e-6) / k).toFixed(v < 10 ? 2 : 1)}`;
};
const pctFmt = (v: number) => `${Math.round(v * 100)}%`;
const rateFmt = (v: number) => (Number.isInteger(v) ? formatNum(v) : v < 10 ? v.toFixed(1) : formatNum(Math.round(v)));

const RANGES: { label: string; days: number }[] = [
  { label: 'All', days: Infinity },
  { label: '20 days', days: 20 },
  { label: '5 days', days: 5 },
  { label: '1 day', days: 1 },
];

interface KeyRow {
  root: HTMLElement;
  value: HTMLElement;
  spark: Sparkline;
}

interface TribeRow {
  el: HTMLButtonElement;
  sw: HTMLElement;
  name: HTMLElement;
  count: HTMLElement;
  rel: HTMLElement;
  pos: { x: number; y: number };
}

// ------------------------------------------------------------------ panel

export function createAnalyticsPanel(container: HTMLElement, opts: AnalyticsPanelOptions = {}): AnalyticsPanel {
  container.textContent = '';
  container.classList.add('an-root');

  const block = (title: string, cls = ''): { root: HTMLElement; head: HTMLElement; body: HTMLElement } => {
    const root = h('section', `an-block${cls ? ` ${cls}` : ''}`);
    const head = h('h3', 'an-h', title);
    const body = h('div', 'an-block-body');
    root.append(head, body);
    container.append(root);
    return { root, head, body };
  };

  // --- now
  const nowB = block('Now', 'an-now');
  const nowText = h('div', 'an-now-text');
  nowB.body.append(nowText);
  let nowKey = '';

  // --- key numbers
  const keyB = block('Key numbers');
  const keys = h('div', 'an-keys');
  keyB.body.append(keys);
  const keyRow = (label: string, title: string, color: string = COLORS.sand): KeyRow => {
    const root = h('div', 'an-key');
    root.dataset.tip = title;
    const value = h('span', 'an-key-value', '');
    root.append(h('span', 'an-key-label', label), value);
    keys.append(root);
    const spark = new Sparkline(root, { color, height: 16, zero: true });
    return { root, value, spark };
  };
  const kPop = keyRow('Population', 'Agents alive now, and the recent trend.');
  const kBirths = keyRow('Births per day', 'Births over the last day.');
  const kDeaths = keyRow('Deaths per day', 'Deaths over the last day.');
  const kTribes = keyRow('Tribes', 'Tribes with at least one living member.');
  const kGen = keyRow('Highest generation', 'The highest generation among living agents. Founders are generation 0.');
  const kInf = keyRow('Infected', 'Agents carrying a disease now.');
  const kFood = keyRow('Food', 'Plant food on the map, as a share of what the land can hold.');

  // --- population chart
  const popB = block('Population');
  const popChart = new LineChart(popB.body, { height: 120, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Population over time' });

  // --- tribes
  const triB = block('Tribes', 'an-tribes-block');
  const triCount = h('span', 'an-h-n', '');
  triB.head.append(triCount);
  const triList = h('div', 'an-tribes');
  const triEmpty = h('p', 'an-empty', 'No tribes yet.');
  const triMore = h('button', 'an-link', '');
  triMore.type = 'button';
  triMore.hidden = true;
  triB.body.append(triList, triEmpty, triMore);
  const TRIBES_SHOWN = 8;
  let showAllTribes = false;
  triMore.addEventListener('click', () => {
    showAllTribes = !showAllTribes;
    if (sim) updateTribes(sim);
  });
  const triRows = new Map<TribeId, TribeRow>();
  const makeTribeRow = (): TribeRow => {
    const el = h('button', 'an-tribe');
    el.type = 'button';
    const sw = h('i', 'an-sw');
    const name = h('span', 'an-tribe-name');
    const count = h('span', 'an-tribe-n');
    const rel = h('span', 'an-tribe-rel');
    const top = h('span', 'an-tribe-top');
    top.append(sw, name, count);
    el.append(top, rel);
    const row: TribeRow = { el, sw, name, count, rel, pos: { x: NaN, y: NaN } };
    el.addEventListener('click', () => {
      if (opts.onJump && Number.isFinite(row.pos.x) && Number.isFinite(row.pos.y)) opts.onJump(row.pos.x, row.pos.y);
    });
    return row;
  };

  // --- more charts (folded)
  const more = h('details', 'an-more');
  const moreSum = h('summary', 'an-more-title', 'More charts');
  more.append(moreSum);
  container.append(more);
  const bar = h('div', 'an-toolbar');
  bar.append(h('span', 'an-toolbar-label', 'Time range'));
  const seg = h('div', 'an-segs');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Time range of the charts');
  bar.append(seg);
  const rangeBtns: HTMLButtonElement[] = [];
  let rangeIdx = 0;
  RANGES.forEach((r, i) => {
    const b = h('button', 'an-seg', r.label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(i === rangeIdx));
    b.addEventListener('click', () => {
      rangeIdx = i;
      rangeBtns.forEach((bb, j) => bb.setAttribute('aria-pressed', String(j === i)));
      refresh(true);
    });
    rangeBtns.push(b);
    seg.append(b);
  });
  more.append(bar);

  const sections: HTMLDetailsElement[] = [];
  const section = (title: string, explain: string, open = false): HTMLElement => {
    const d = h('details', 'an-sec');
    d.open = open;
    d.append(h('summary', 'an-sec-title', title), h('p', 'an-explain', explain));
    const body = h('div', 'an-sec-body');
    d.append(body);
    more.append(d);
    sections.push(d);
    return body;
  };
  const sub = (parent: HTMLElement, title: string): HTMLElement => {
    const w = h('div', 'an-sub');
    w.append(h('div', 'an-sub-title', title));
    parent.append(w);
    return w;
  };

  // births and deaths
  const secBD = section('Births and deaths', 'Births and deaths per day. While births are above deaths, the population grows.', true);
  const bdLegend = h('div', 'an-legend');
  secBD.append(bdLegend);
  const bdChart = new LineChart(secBD, { height: 110, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Births and deaths per day' });
  renderLegend(bdLegend, [
    { name: 'Births per day', color: COLORS.sage },
    { name: 'Deaths per day', color: COLORS.rust },
  ]);

  // vitals
  const secVit = section('Health, energy and hunger', 'Averages over the living agents, from 0 to 100%. Hunger rises before starvation deaths do.');
  const vitLegend = h('div', 'an-legend');
  secVit.append(vitLegend);
  renderLegend(vitLegend, [
    { name: 'Health', color: COLORS.sage },
    { name: 'Energy', color: COLORS.water },
    { name: 'Hunger', color: COLORS.ochre },
  ]);
  const vitChart = new LineChart(secVit, { height: 120, yMin: 0, yMax: 1, yFormat: pctFmt, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Average health, energy and hunger' });

  // resources
  const secRes = section('Food and soil', 'Plant food on the whole map, and the average fertility of the soil on land. Overgrazing lowers fertility, and it recovers slowly.');
  const foodChart = new LineChart(sub(secRes, 'Food on the map'), { height: 100, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Total food' });
  const fertChart = new LineChart(sub(secRes, 'Average fertility'), { height: 100, yMin: 0, yMax: 1, yFormat: pctFmt, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Average fertility' });

  // tribes
  const secTribes = section('Tribe sizes', 'Members per tribe, stacked, in the tribe colors of the map. Tribes beyond the 8 largest are grouped as other tribes.');
  const tribeChart = new StackedAreaChart(secTribes, { height: 140, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Tribe sizes' });
  const tribeLegend = h('div', 'an-legend');
  secTribes.append(tribeLegend);

  // deaths
  const secDeaths = section('Causes of death', 'Deaths per day by cause, stacked. The legend shows the totals since the start.');
  const deathChart = new StackedAreaChart(secDeaths, {
    height: 130,
    xFormat: dayFmt,
    xHoverFormat: dayHover,
    emptyText: 'No deaths in this time range',
    ariaLabel: 'Deaths by cause',
  });
  const deathLegend = h('div', 'an-legend');
  secDeaths.append(deathLegend);

  // genetics
  const secGen = section(
    'Genes',
    'Pick a gene. The line is its average, with a band one standard deviation wide. The heat map shows how values spread over time: a band that moves means selection, a band that widens means more variety.',
  );
  const geneChips = h('div', 'an-chips');
  secGen.append(geneChips);
  let gene = 0;
  const chipEls: HTMLButtonElement[] = [];
  GENES.forEach((g, i) => {
    const b = h('button', 'an-chip', GENE_LABELS[g]);
    b.type = 'button';
    b.dataset.tip = GENE_DESCRIPTIONS[g];
    b.setAttribute('aria-pressed', String(i === gene));
    b.addEventListener('click', () => selectGene(i));
    chipEls.push(b);
    geneChips.append(b);
  });
  const geneDesc = h('p', 'an-gene-desc');
  secGen.append(geneDesc);
  const geneLine = new LineChart(sub(secGen, 'Average and spread'), { height: 100, yMin: 0, yMax: 1, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Gene average over time' });
  const geneHeat = new Heatmap(sub(secGen, 'Spread over time'), {
    height: 110,
    xFormat: dayFmt,
    xHoverFormat: dayHover,
    yTicks: 2,
    ariaLabel: 'Gene values over time',
  });
  const geneHist = new BarChart(sub(secGen, 'Values now'), {
    height: 90,
    orientation: 'vertical',
    labelEvery: 2,
    showShare: true,
    color: COLORS.sage,
    tipHeader: (_d, i) => `Gene value ${(i / HIST_BINS).toFixed(1)} to ${((i + 1) / HIST_BINS).toFixed(1)}`,
    ariaLabel: 'Gene values now',
  });
  secGen.append(h('div', 'an-sub-title', 'All genes, average over time. Click one to pick it.'));
  const multiGrid = h('div', 'an-multi');
  secGen.append(multiGrid);
  const multis = GENES.map((g, i) => {
    const cell = h('button', 'an-multi-cell');
    cell.type = 'button';
    cell.dataset.tip = GENE_DESCRIPTIONS[g];
    const head = h('div', 'an-multi-head');
    const name = h('span', 'an-multi-name', GENE_LABELS[g]);
    const val = h('span', 'an-multi-val', '');
    head.append(name, val);
    cell.append(head);
    const spark = new Sparkline(cell, { color: COLORS.sand, height: 20, minRange: 0.1 });
    cell.addEventListener('click', () => selectGene(i));
    multiGrid.append(cell);
    return { cell, val, spark };
  });

  // behaviour
  const secBeh = section('Behavior', 'What the agents are doing right now, and how many hold each role over time.');
  const actChart = new BarChart(sub(secBeh, 'Doing now'), { height: 190, orientation: 'horizontal', color: COLORS.sage, showShare: true, ariaLabel: 'What agents are doing now' });
  const roleWrap = sub(secBeh, 'Roles over time');
  const roleChart = new StackedAreaChart(roleWrap, { height: 130, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Roles over time' });
  const roleLegend = h('div', 'an-legend');
  roleWrap.append(roleLegend);

  // ------------------------------------------------------------------ state
  let sim: Simulation | null = null;
  let lastTick = -1;
  let lastKey = '';
  let lastTribeT = -Infinity;
  let view: { samples: StatsSample[]; x: Float64Array; key: string } | null = null;

  function selectGene(i: number): void {
    gene = i;
    chipEls.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
    multis.forEach((m, j) => m.cell.classList.toggle('an-on', j === i));
    if (sim && view) renderGenetics(view.samples, view.x, view.key);
  }
  multis[0].cell.classList.add('an-on');

  function refresh(force: boolean): void {
    if (sim) update(sim, force);
  }

  let lastSlowT = -Infinity;
  let landShare = '';
  let landTitle = '';

  function updateNow(s: Simulation): void {
    let lines: string[] = [];
    try {
      lines = describeNow(s);
    } catch {
      lines = [];
    }
    const key = lines.join('\n');
    if (key === nowKey) return;
    nowKey = key;
    nowText.textContent = '';
    for (const l of lines) nowText.append(h('p', '', l));
  }

  function updateKeys(s: Simulation): void {
    const sum = currentSummary(s);
    setText(kPop.value, fmtInt(sum.population));
    kPop.root.dataset.tip = `Agents alive now, and the recent trend. The highest so far was ${fmtInt(sum.peakPopulation)}, on day ${dayOfTick(s, sum.peakTick)}.`;
    // in the first hours a rate per day would be extrapolated from a few ticks: show the counts so far
    const young = s.state.tick < Math.max(1, s.config.dayLength || 600) / 4;
    setText(kBirths.value, young ? `${fmtInt(sum.totalBirths)} so far` : rateFmt(sum.birthsPerDay));
    kBirths.root.dataset.tip = young ? 'Births since the start. The rate per day shows once the run is a few hours old.' : `Births over the last day. ${fmtInt(sum.totalBirths)} since the start.`;
    setText(kDeaths.value, young ? `${fmtInt(sum.totalDeaths)} so far` : rateFmt(sum.deathsPerDay));
    kDeaths.root.dataset.tip = young ? 'Deaths since the start. The rate per day shows once the run is a few hours old.' : `Deaths over the last day. ${fmtInt(sum.totalDeaths)} since the start.`;
    setText(kTribes.value, fmtInt(sum.tribes));
    setText(kGen.value, fmtInt(sum.maxGeneration));
    kGen.root.dataset.tip = `The highest generation among living agents (average ${sum.meanGeneration.toFixed(1)}). Founders are generation 0.`;
    setText(kInf.value, sum.population && sum.infected ? `${fmtInt(sum.infected)} (${formatPct(sum.infected / sum.population)})` : fmtInt(sum.infected));
    kInf.root.classList.toggle('an-alert', sum.infected > 0 && sum.infected >= sum.population * 0.1);
    setText(kFood.value, landShare);
    kFood.root.dataset.tip = landTitle;
  }

  /** The parts that scan every tile (the sentences and the food share): about once a second. */
  function updateSlow(s: Simulation, force: boolean): void {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (!force && now - lastSlowT < 900) return;
    lastSlowT = now;
    const { food, capacity } = landFood(s);
    landShare = capacity > 0 ? `${Math.round((100 * food) / capacity)}%` : fmtInt(food);
    landTitle = `Plant food on the map (${formatNum(Math.round(food))} units), as a share of what the land can hold.`;
    updateNow(s);
  }

  function updateTribes(s: Simulation): void {
    const list = tribeSummaries(s);
    setText(triCount, list.length ? String(list.length) : '');
    triEmpty.hidden = list.length > 0;
    triEmpty.textContent = s.config.tribesEnabled ? 'No tribes yet.' : 'Tribes are turned off in this run.';
    const shown = showAllTribes ? list : list.slice(0, TRIBES_SHOWN);
    triMore.hidden = list.length <= TRIBES_SHOWN;
    setText(triMore, showAllTribes ? 'Show fewer' : `Show all ${list.length} tribes`);
    const seen = new Set<TribeId>();
    shown.forEach((t, i) => {
      seen.add(t.id);
      let row = triRows.get(t.id);
      if (!row) triRows.set(t.id, (row = makeTribeRow()));
      row.pos.x = t.x;
      row.pos.y = t.y;
      const c = tribeColor(t.hue);
      if (row.sw.style.background !== c) row.sw.style.background = c;
      setText(row.name, t.name);
      setText(row.count, `${plural(t.members, 'member')}, ${fmtInt(t.stored)} food`);
      setText(row.rel, t.relations);
      row.el.dataset.tip = `${t.name}: ${plural(t.members, 'member')}, ${fmtInt(t.stored)} food stored at the camp.${opts.onJump ? ' Click to show the camp on the map.' : ''}`;
      if (triList.children[i] !== row.el) triList.insertBefore(row.el, triList.children[i] ?? null);
    });
    for (const [id, row] of triRows) {
      if (!seen.has(id)) {
        row.el.remove();
        triRows.delete(id);
      }
    }
  }

  function renderGenetics(samples: StatsSample[], x: Float64Array, key: string): void {
    const n = samples.length;
    const g = gene;
    const gname = GENES[g];
    setText(geneDesc, `${GENE_LABELS[gname]}: ${GENE_DESCRIPTIONS[gname]}`);
    const gkey = `${key}|${g}`;
    const mean = new Float64Array(n);
    const lo = new Float64Array(n);
    const hi = new Float64Array(n);
    const heat = new Float32Array(n * HIST_BINS);
    for (let i = 0; i < n; i++) {
      const sm = samples[i];
      const m = sm.geneMeans[g] ?? 0;
      const sd = sm.geneStd[g] ?? 0;
      mean[i] = m;
      lo[i] = Math.max(0, m - sd);
      hi[i] = Math.min(1, m + sd);
      let tot = 0;
      for (let b = 0; b < HIST_BINS; b++) tot += sm.geneHist[g * HIST_BINS + b] ?? 0;
      for (let b = 0; b < HIST_BINS; b++) heat[i * HIST_BINS + b] = tot > 0 ? (sm.geneHist[g * HIST_BINS + b] ?? 0) / tot : 0;
    }
    geneLine.setData({ x, series: [{ name: `Average ${GENE_LABELS[gname].toLowerCase()}`, color: COLORS.sage, values: mean, band: { lo, hi } }] }, gkey);
    geneHeat.setData(
      {
        x,
        rows: HIST_BINS,
        values: heat,
        overlay: mean,
        overlayLabel: 'Average',
        rowLabel: (r) => `Value ${(r / HIST_BINS).toFixed(1)} to ${((r + 1) / HIST_BINS).toFixed(1)}`,
        valueLabel: (v) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}% of agents`,
      },
      gkey,
    );
    const last = samples[n - 1];
    const bars = [];
    for (let b = 0; b < HIST_BINS; b++) {
      bars.push({ label: (b / HIST_BINS).toFixed(1), value: last ? Math.round(last.geneHist[g * HIST_BINS + b] ?? 0) : 0 });
    }
    geneHist.setData({ bars }, gkey);
  }

  function update(s: Simulation, force = false): void {
    if (s !== sim) {
      sim = s;
      force = true;
      lastTribeT = -Infinity;
      lastSlowT = -Infinity;
    }
    const tick = s.state.tick;
    if (!force && tick === lastTick) return;
    lastTick = tick;
    updateSlow(s, force);
    updateKeys(s);
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (force || now - lastTribeT > 450) {
      lastTribeT = now;
      updateTribes(s);
    }
    const st = s.state.stats;
    const all = st.samples;
    const n0 = all.length;
    const lastSample = all[n0 - 1];
    const key = `${n0}|${lastSample ? lastSample.tick : -1}|${rangeIdx}|${s.config.maxAgents}`;
    if (!force && key === lastKey) return;
    lastKey = key;

    const dayLen = Math.max(1, s.config.dayLength || 600);
    const interval = Math.max(1, st.sampleInterval);
    seg.dataset.tip = n0 ? `${fmtInt(n0)} samples, one every ${interval} ticks` : 'No samples yet';
    // rates over the full history, then sliced to the selected range
    const halfDay = dayLen / 2;
    const birthsAll = rollingRate(all, (x) => x.births, halfDay, dayLen, interval);
    const deathsAll = rollingRate(all, (x) => x.deaths, halfDay, dayLen, interval);
    const causeAll = DEATH_CAUSES.map((c) => rollingRate(all, (x) => x.deathsByCause[c] ?? 0, dayLen, dayLen, interval));
    const xAll = new Float64Array(n0);
    for (let i = 0; i < n0; i++) xAll[i] = dayPosOfTick(s, all[i].tick); // the clock's day numbering

    // key number trend lines (last ~300 samples)
    const sp0 = Math.max(0, n0 - 300);
    const col = (get: (x: StatsSample) => number) => {
      const out = new Float64Array(n0 - sp0);
      for (let i = sp0; i < n0; i++) out[i - sp0] = get(all[i]);
      return out;
    };
    kPop.spark.set(col((v) => v.population), key);
    kBirths.spark.set(birthsAll.subarray(sp0), key);
    kDeaths.spark.set(deathsAll.subarray(sp0), key);
    kTribes.spark.set(col((v) => v.tribeCount), key);
    kGen.spark.set(col((v) => v.maxGeneration), key);
    kInf.spark.set(col((v) => v.infected), key);
    kFood.spark.set(col((v) => v.totalFood), key);

    // overview population chart: the whole run, the cap shown once the population approaches it
    const popAll = new Float64Array(n0);
    let popMaxAll = 0;
    for (let i = 0; i < n0; i++) {
      popAll[i] = all[i].population;
      if (popAll[i] > popMaxAll) popMaxAll = popAll[i];
    }
    const capLine = popMaxAll >= s.config.maxAgents * 0.6 ? [{ y: s.config.maxAgents, label: `Cap ${fmtInt(s.config.maxAgents)}` }] : [];
    popChart.setOptions({ refLines: capLine });
    popChart.setData({ x: xAll, series: [{ name: 'Population', color: COLORS.sage, values: popAll, fill: true }] }, key);

    // the folded charts use the selected range
    const range = RANGES[rangeIdx];
    let start = 0;
    if (Number.isFinite(range.days) && lastSample) {
      const from = lastSample.tick - range.days * dayLen;
      while (start < n0 - 1 && all[start].tick < from) start++;
    }
    const samples = start > 0 ? all.slice(start) : all;
    const n = samples.length;
    const x = start > 0 ? xAll.slice(start) : xAll;
    view = { samples, x, key };
    const series = (get: (x: StatsSample) => number) => {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = get(samples[i]);
      return out;
    };

    bdChart.setData(
      {
        x,
        series: [
          { name: 'Births per day', color: COLORS.sage, values: birthsAll.subarray(start), format: rateFmt },
          { name: 'Deaths per day', color: COLORS.rust, values: deathsAll.subarray(start), format: rateFmt },
        ],
      },
      key,
    );

    vitChart.setData(
      {
        x,
        series: [
          { name: 'Health', color: COLORS.sage, values: series((v) => v.avgHealth) },
          { name: 'Energy', color: COLORS.water, values: series((v) => v.avgEnergy) },
          { name: 'Hunger', color: COLORS.ochre, values: series((v) => v.avgHunger) },
        ],
      },
      key,
    );

    foodChart.setData({ x, series: [{ name: 'Food on the map', color: COLORS.ochre, values: series((v) => v.totalFood), fill: true }] }, key);
    fertChart.setData({ x, series: [{ name: 'Average fertility', color: COLORS.moss, values: series((v) => v.avgFertility) }] }, key);

    // tribes: top 8 by peak in range, the rest folded into "Other tribes"
    const peak = new Map<number, number>();
    for (const sm of samples) for (const [id, m] of sm.tribePops) if (m > (peak.get(id) ?? 0)) peak.set(id, m);
    const top = [...peak.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, 8)
      .map((e) => e[0])
      .sort((a, b) => a - b);
    const slot = new Map<number, number>(top.map((id, k) => [id, k]));
    const tVals = top.map(() => new Float64Array(n));
    const other = new Float64Array(n);
    const none = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const sm = samples[i];
      let inTribes = 0;
      for (const [id, m] of sm.tribePops) {
        inTribes += m;
        const k = slot.get(id);
        if (k === undefined) other[i] += m;
        else tVals[k][i] = m;
      }
      none[i] = Math.max(0, sm.population - inTribes);
    }
    const lastTP = new Map<number, number>(samples.length ? samples[n - 1].tribePops : []);
    const tSeries = [{ name: 'No tribe', color: NEUTRAL, values: none }];
    const tLegend: { name: string; color: string; value?: string }[] = [];
    top.forEach((id, k) => {
      const t = s.getTribe(id);
      const alive = lastTP.has(id);
      const name = (t ? t.name : `Tribe ${id}`) + (alive ? '' : ' (died out)');
      const color = tribeColor(t ? t.hue : (id * 137.508) % 360);
      tSeries.push({ name, color, values: tVals[k] });
      tLegend.push({ name, color, value: String(lastTP.get(id) ?? 0) });
    });
    let anyOther = false;
    for (let i = 0; i < n; i++) if (other[i] > 0) anyOther = true;
    if (anyOther) {
      tSeries.push({ name: 'Other tribes', color: OTHER, values: other });
      tLegend.push({ name: 'Other tribes', color: OTHER, value: formatNum(other[n - 1] ?? 0) });
    }
    tLegend.push({ name: 'No tribe', color: NEUTRAL, value: formatNum(none[n - 1] ?? 0) });
    tribeChart.setData({ x, series: tSeries, totalLabel: 'Population' }, key);
    renderLegend(tribeLegend, top.length || anyOther ? tLegend : [], 'No tribes have formed yet.');

    // deaths by cause (per day, 1-day window)
    const totals: Record<DeathCause, number> = { starvation: 0, old_age: 0, combat: 0, disease: 0, disaster: 0, removed: 0 };
    for (const sm of all) for (const c of DEATH_CAUSES) totals[c] += sm.deathsByCause[c] ?? 0;
    for (const c of DEATH_CAUSES) totals[c] += st.counters.deathsByCause[c] ?? 0;
    let anyDeath = false;
    for (const arr of causeAll) for (let i = start; i < n0 && !anyDeath; i++) if (arr[i] > 0) anyDeath = true;
    deathChart.setData(
      {
        x: anyDeath ? x : new Float64Array(0),
        series: DEATH_CAUSES.map((c, k) => ({ name: CAUSE_LABELS[c], color: CAUSE_COLORS[c], values: causeAll[k].subarray(start) })),
        totalLabel: 'All deaths per day',
      },
      key,
    );
    renderLegend(
      deathLegend,
      DEATH_CAUSES.map((c) => ({ name: CAUSE_LABELS[c], color: CAUSE_COLORS[c], value: formatNum(totals[c]) })),
    );

    // genetics
    renderGenetics(samples, x, key);
    for (let g = 0; g < GENE_COUNT; g++) {
      const m = multis[g];
      const vals = col((v) => v.geneMeans[g] ?? 0);
      m.spark.set(vals, key);
      const cur = vals.length ? vals[vals.length - 1] : NaN;
      const first = all.length ? (all[0].geneMeans[g] ?? NaN) : NaN;
      const d = cur - first;
      setText(m.val, Number.isFinite(cur) ? cur.toFixed(2) : '');
      const change = !Number.isFinite(d) || Math.abs(d) < 0.02 ? 'about the same as at the start' : `${d > 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(2)} since the start`;
      m.cell.dataset.tip = `${GENE_DESCRIPTIONS[GENES[g]]} Average now ${Number.isFinite(cur) ? cur.toFixed(2) : 'unknown'}, ${change}.`;
      m.cell.setAttribute('aria-label', `${GENE_LABELS[GENES[g]]}: average ${Number.isFinite(cur) ? cur.toFixed(2) : 'unknown'}, ${change}`);
    }

    // behaviour
    const lastS = samples[n - 1];
    if (lastS) {
      const acts = (Object.entries(lastS.actions) as [ActionKind, number][]).filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const hgt = `${Math.max(60, acts.length * 18 + 4)}px`;
      if (actChart.el.style.height !== hgt) actChart.el.style.height = hgt; // the resize observer repaints
      actChart.setData({ bars: acts.map(([k, v]) => ({ label: ACTION_LABELS[k] ?? k, value: Math.round(v) })) }, key);
    }
    roleChart.setData(
      { x, series: ROLES.map((r) => ({ name: ROLE_LABELS[r], color: ROLE_COLORS[r], values: series((v) => v.roles[r] ?? 0) })), totalLabel: 'Population' },
      key,
    );
    renderLegend(
      roleLegend,
      ROLES.map((r) => ({ name: ROLE_LABELS[r], color: ROLE_COLORS[r], value: lastS ? formatNum(Math.round(lastS.roles[r] ?? 0)) : '0' })),
    );
  }

  return { update };
}
