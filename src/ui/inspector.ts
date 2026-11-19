/**
 * Agent tab (OWNER: UI panels). The DOM is built once per selected id; afterwards text, bars and keyed
 * lists are updated in place (throttled). A dead agent keeps its last snapshot (with the cause of death);
 * an id known only from the lineage registry shows its lineage record.
 *
 * Reading order: who it is, what it is doing now and its needs, why (the options it weighed), the agents it
 * knows and its family; genes, skills and its life story are folded.
 */
import './analytics.css';
import type { Simulation } from '../sim/simulation';
import { GENES, NONE, type ActionKind, type Agent, type AgentId, type GeneName, type LineageRecord, type Relationship, type Traits } from '../sim/types';
import { ACTION_LABELS, OPTION_LABELS, GENE_DESCRIPTIONS, GENE_LABELS, ROLE_LABELS, clockOfTick, dayOfTick, plainText, tribeColor } from './analytics';
import { REPRO, mateFoodThreshold, rangeFoodThreshold } from '../sim/genetics';
import { localFoodFraction } from '../sim/ecology';
import { SOCIAL_TUNING, carryCapacity, theTribe } from '../sim/social';

export interface InspectorHandlers {
  onSelect(id: number): void; // select another agent (e.g. click a relative)
  onFollow(id: number): void; // camera follows agent
  onKill(id: number): void; // enqueue killAgent
  onBoost(id: number): void; // enqueue boostAgent
  /** Move the camera to this agent without following it (optional). */
  onShowOnMap?(id: number): void;
}

export interface Inspector {
  update(sim: Simulation, selectedId: number): void;
}

/** What the agent is doing, as one short sentence ("Fighting Ada Brook."). Pure; also used by the map's hover card. */
export function describeAction(sim: Simulation, a: Agent): string {
  if (!a.alive) return 'Dead.';
  const t = a.targetId !== NONE ? sim.getAgent(a.targetId) : undefined;
  const who = t && t.alive && t.id !== a.id ? t.name : '';
  const tribe = a.tribeId !== NONE ? sim.getTribe(a.tribeId) : undefined;
  switch (a.action) {
    case 'attack':
      return who ? `Fighting ${who}.` : 'Fighting.';
    case 'flee':
      return who ? `Fleeing from ${who}.` : 'Fleeing from danger.';
    case 'share':
      return who ? `Sharing food with ${who}.` : 'Sharing food.';
    case 'mate':
      return who ? `Courting ${who}.` : 'Courting.';
    case 'socialize':
      return who ? `Spending time with ${who}.` : 'Spending time with others.';
    case 'gohome':
      return tribe ? `Going back to the camp of ${theTribe(tribe)}.` : 'Going home.';
    case 'deposit':
      return 'Storing food at the camp.';
    case 'withdraw':
      return 'Taking food from the camp store.';
    default:
      return `${ACTION_LABELS[a.action] ?? a.action}.`;
  }
}

// ------------------------------------------------------------------ tiny DOM helpers

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function setWidth(el: HTMLElement, frac: number): void {
  const w = `${(Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0)) * 100).toFixed(1)}%`;
  if (el.style.width !== w) el.style.width = w;
}

interface Meter {
  root: HTMLElement;
  fill: HTMLElement;
  val: HTMLElement;
}

function meter(parent: HTMLElement, label: string, cls = ''): Meter {
  const root = h('div', `insp-meter ${cls}`);
  const lab = h('span', 'insp-meter-label', label);
  const track = h('span', 'insp-track');
  const fill = h('span', 'insp-fill');
  track.append(fill);
  const val = h('span', 'insp-meter-val');
  root.append(lab, track, val);
  parent.append(root);
  return { root, fill, val };
}

function setMeter(m: Meter, frac: number, text: string): void {
  setWidth(m.fill, frac);
  setText(m.val, text);
}

/** Keyed list reconciliation: reuses elements by key, reorders minimally, removes stale ones. */
function syncList<T>(
  host: HTMLElement,
  cache: Map<string | number, HTMLElement>,
  items: T[],
  key: (t: T) => string | number,
  create: (t: T) => HTMLElement,
  update: (el: HTMLElement, t: T) => void,
): void {
  const seen = new Set<string | number>();
  for (let i = 0; i < items.length; i++) {
    const k = key(items[i]);
    seen.add(k);
    let el = cache.get(k);
    if (!el) {
      el = create(items[i]);
      cache.set(k, el);
    }
    update(el, items[i]);
    if (host.children[i] !== el) host.insertBefore(el, host.children[i] ?? null);
  }
  for (const [k, el] of cache) {
    if (!seen.has(k)) {
      el.remove();
      cache.delete(k);
    }
  }
}

/** A plain section with a heading (always open). */
function block(parent: HTMLElement, title: string): HTMLElement {
  const sec = h('section', 'insp-block');
  sec.append(h('h3', 'insp-h', title));
  const body = h('div', 'insp-block-body');
  sec.append(body);
  parent.append(sec);
  return body;
}

/** A folded section. */
function folded(parent: HTMLElement, title: string): HTMLElement {
  const d = h('details', 'insp-sec');
  d.append(h('summary', 'insp-sec-title', title));
  const body = h('div', 'insp-sec-body');
  d.append(body);
  parent.append(d);
  return body;
}

function phenotype(g: GeneName, t: Traits, dayLen: number): string {
  switch (g) {
    case 'speed':
      return `${t.speed.toFixed(2)} units per tick`;
    case 'size':
      return `${t.size.toFixed(2)} times`;
    case 'perception':
      return `${Math.round(t.perception)} units`;
    case 'metabolism':
      return `${t.metabolism.toFixed(2)} times`;
    case 'longevity':
      return `${(t.longevity / dayLen).toFixed(1)} days`;
    case 'efficiency':
      return `${t.efficiency.toFixed(2)} times`;
    case 'hue':
      return `${Math.round(t.hue)} degrees`;
    default:
      return `${Math.round((t[g] as number) * 100)}%`;
  }
}

const days = (ticks: number, dl: number): string => {
  const d = ticks / dl;
  return `${d.toFixed(1)} ${d.toFixed(1) === '1.0' ? 'day' : 'days'}`;
};

// ------------------------------------------------------------------ lineage helpers

interface PersonRef {
  id: AgentId;
  name: string;
  alive: boolean;
  known: boolean;
}

function personRef(sim: Simulation, id: AgentId): PersonRef {
  const a = sim.getAgent(id);
  if (a) return { id, name: a.name, alive: true, known: true };
  const rec = sim.lineageById.get(id);
  if (rec) return { id, name: rec.name, alive: false, known: true };
  return { id, name: `Agent ${id}`, alive: false, known: false };
}

function parentsOf(sim: Simulation, id: AgentId): [AgentId, AgentId] | null {
  const a = sim.getAgent(id);
  if (a) return a.parents;
  const rec = sim.lineageById.get(id);
  return rec ? rec.parents : null;
}

/** parent id to child ids, built from the lineage registry (cached by the caller). */
function buildChildIndex(sim: Simulation): Map<AgentId, AgentId[]> {
  const idx = new Map<AgentId, AgentId[]>();
  for (const rec of sim.state.lineage) {
    for (const p of rec.parents) {
      if (p === NONE) continue;
      let arr = idx.get(p);
      if (!arr) idx.set(p, (arr = []));
      if (!arr.includes(rec.id)) arr.push(rec.id);
    }
  }
  return idx;
}

function countDescendants(sim: Simulation, idx: Map<AgentId, AgentId[]>, root: AgentId): { living: number; total: number } {
  const seen = new Set<AgentId>([root]);
  const stack = [root];
  let living = 0;
  let total = 0;
  while (stack.length) {
    const id = stack.pop()!;
    const kids = idx.get(id);
    if (!kids) continue;
    for (const k of kids) {
      if (seen.has(k)) continue;
      seen.add(k);
      total++;
      if (sim.getAgent(k)) living++;
      stack.push(k);
    }
  }
  return { living, total };
}

const CAUSE_PHRASE: Record<string, string> = {
  starvation: 'of starvation',
  old_age: 'of old age',
  combat: 'in a fight',
  disease: 'of disease',
  disaster: 'in a disaster',
};

// ------------------------------------------------------------------ inspector

interface View {
  id: AgentId;
  root: HTMLElement;
  refresh(sim: Simulation, a: Agent | null, rec: LineageRecord | null, force: boolean): void;
}

export function createInspector(container: HTMLElement, handlers: InspectorHandlers): Inspector {
  container.textContent = '';
  container.classList.add('insp-root');
  const empty = h('div', 'insp-empty');
  empty.append(h('p', '', 'Click an agent on the map to see what it is doing and why.'));
  container.append(empty);

  let sim: Simulation | null = null;
  let view: View | null = null;
  let lastAgent: Agent | null = null; // snapshot kept after death
  let lastTick = -1;
  let lastTime = 0;
  let childIdx: Map<AgentId, AgentId[]> | null = null;
  let childIdxTick = -1;
  let desc = { living: 0, total: 0, tick: -1, id: NONE as AgentId };

  const getChildIndex = (s: Simulation) => {
    if (!childIdx || s.state.tick - childIdxTick >= 120 || s.state.tick < childIdxTick) {
      childIdx = buildChildIndex(s);
      childIdxTick = s.state.tick;
    }
    return childIdx;
  };
  const descendants = (s: Simulation, id: AgentId) => {
    if (desc.id !== id || s.state.tick - desc.tick >= 120 || s.state.tick < desc.tick) {
      const r = countDescendants(s, getChildIndex(s), id);
      desc = { ...r, tick: s.state.tick, id };
    }
    return desc;
  };

  const pick = (p: PersonRef) => {
    handlers.onSelect(p.id);
    if (p.alive) handlers.onShowOnMap?.(p.id);
  };

  /** Clickable name (a living agent or a recorded dead one can be selected). */
  const personEl = (p: PersonRef, tip?: string): HTMLElement => {
    const el = h(p.known ? 'button' : 'span', `insp-person${p.alive ? '' : ' insp-dead'}`);
    if (el instanceof HTMLButtonElement) {
      el.type = 'button';
      el.addEventListener('click', () => pick(p));
      el.title = tip ?? (p.alive ? `Select ${p.name} and show it on the map` : `${p.name} is dead. Select to see its record.`);
    }
    el.textContent = p.alive ? p.name : `${p.name} (dead)`;
    return el;
  };

  /** A labelled row of names, at most `max` shown. */
  const nameRow = (host: HTMLElement, label: string, people: { ref: PersonRef; tip?: string }[], emptyText: string, extra = '', max = 6) => {
    host.textContent = '';
    host.append(h('span', 'insp-row-label', label));
    const list = h('span', 'insp-names');
    if (!people.length) list.append(h('span', 'insp-muted', emptyText));
    for (const p of people.slice(0, max)) list.append(personEl(p.ref, p.tip));
    const more = people.length > max ? `and ${people.length - max} more` : '';
    const tail = [more, extra].filter(Boolean).join(', ');
    if (tail) list.append(h('span', 'insp-muted', tail));
    host.append(list);
  };

  function buildView(s: Simulation, id: AgentId): View {
    const root = h('div', 'insp-body');
    const dayLen = () => Math.max(1, s.config.dayLength || 600);

    // ---------------------------------------------------------------- header
    const head = h('div', 'insp-head');
    const nameLine = h('div', 'insp-name-line');
    const name = h('div', 'insp-name');
    const badge = h('span', 'insp-badge', 'Dead');
    nameLine.append(name, badge);
    const meta1 = h('div', 'insp-meta');
    const sw = h('i', 'insp-swatch');
    const tribeName = h('span', 'insp-tribe');
    meta1.append(sw, tribeName);
    const meta2 = h('div', 'insp-meta insp-meta-2');
    head.append(nameLine, meta1, meta2);
    root.append(head);

    const deathLine = h('p', 'insp-death');
    deathLine.hidden = true;
    root.append(deathLine);

    // buttons: two for the camera, two small ones that act on the agent
    const btns = h('div', 'insp-btns');
    const bFollow = h('button', 'insp-btn insp-btn-primary', 'Follow');
    const bShow = h('button', 'insp-btn', 'Show on map');
    const bBoost = h('button', 'insp-btn insp-btn-small', 'Bless');
    const bKill = h('button', 'insp-btn insp-btn-small insp-btn-bad', 'Smite');
    for (const b of [bFollow, bShow, bBoost, bKill]) b.type = 'button';
    bFollow.title = 'Keep the camera on this agent';
    bShow.title = 'Move the camera to this agent';
    bBoost.title = 'Fully heal and feed this agent';
    bKill.title = 'Kill this agent';
    bFollow.addEventListener('click', () => handlers.onFollow(id));
    bShow.addEventListener('click', () => (handlers.onShowOnMap ? handlers.onShowOnMap(id) : handlers.onSelect(id)));
    bBoost.addEventListener('click', () => handlers.onBoost(id));
    bKill.addEventListener('click', () => handlers.onKill(id));
    const actGroup = h('span', 'insp-btns-act');
    actGroup.append(bBoost, bKill);
    btns.append(bFollow, bShow, actGroup);
    root.append(btns);

    // ---------------------------------------------------------------- now
    const nowB = block(root, 'Now');
    const nowSec = nowB.parentElement as HTMLElement;
    const doing = h('p', 'insp-doing');
    const thought = h('p', 'insp-thought');
    nowB.append(doing, thought);
    const needs = h('div', 'insp-needs');
    nowB.append(needs);
    const mHealth = meter(needs, 'Health', 'insp-m-health');
    const mHunger = meter(needs, 'Hunger', 'insp-m-hunger');
    const mEnergy = meter(needs, 'Energy', 'insp-m-energy');
    const mCarried = meter(needs, 'Carrying', 'insp-m-carried');
    const mFear = meter(needs, 'Fear', 'insp-m-fear');
    mFear.root.hidden = true;
    const disease = h('p', 'insp-status');
    const repro = h('p', 'insp-status');
    const navLine = h('p', 'insp-status');
    navLine.hidden = true;
    repro.title =
      'To breed, an agent must be an adult and not too old, past the rest after its last birth, well fed (how full depends on its fertility gene), rested and healthy, with a willing partner nearby.';
    nowB.append(disease, repro, navLine);

    // ---------------------------------------------------------------- why
    const whyB = block(root, 'Why');
    const whySec = whyB.parentElement as HTMLElement;
    whyB.append(h('p', 'insp-explain', 'How much each option appealed to it at its last decision.'));
    const utilList = h('div', 'insp-utils');
    whyB.append(utilList);
    const utilNote = h('p', 'insp-explain insp-util-note', 'It has changed what it is doing since that decision.');
    utilNote.hidden = true;
    whyB.append(utilNote);
    const utilEmpty = h('p', 'insp-muted', 'No decision yet.');
    whyB.append(utilEmpty);
    const utilCache = new Map<string | number, HTMLElement>();

    // ---------------------------------------------------------------- relationships
    const relB = block(root, 'Relationships');
    const relSec = relB.parentElement as HTMLElement;
    const relFriends = h('div', 'insp-row');
    const relEnemies = h('div', 'insp-row');
    const relOthers = h('div', 'insp-row');
    relB.append(relFriends, relEnemies, relOthers);
    let relKey = '';

    // ---------------------------------------------------------------- family
    const famB = block(root, 'Family');
    const famParents = h('div', 'insp-row');
    const famGrand = h('div', 'insp-row');
    const famSibs = h('div', 'insp-row');
    const famKids = h('div', 'insp-row');
    const famDesc = h('div', 'insp-row');
    famB.append(famParents, famGrand, famSibs, famKids, famDesc);
    let famKey = '';

    // ---------------------------------------------------------------- folded details
    const traitSec = folded(root, 'Genes');
    traitSec.append(h('p', 'insp-explain', 'Gene values from 0 to 1, with what they mean for this body.'));
    const traitTable = h('div', 'insp-traits');
    traitSec.append(traitTable);
    const traitRows = GENES.map((g) => {
      const row = h('div', 'insp-trait');
      row.title = GENE_DESCRIPTIONS[g];
      const lab = h('span', 'insp-trait-name', GENE_LABELS[g]);
      const track = h('span', 'insp-track insp-track-thin');
      const fill = h('span', 'insp-fill insp-fill-gene');
      track.append(fill);
      const val = h('span', 'insp-trait-val');
      row.append(lab, track, val);
      traitTable.append(row);
      return { g, fill, val };
    });
    const derived = h('p', 'insp-derived');
    traitSec.append(derived);

    const skillSec = folded(root, 'Skills and lifetime');
    const sForage = meter(skillSec, 'Foraging');
    const sCombat = meter(skillSec, 'Fighting');
    const sSocial = meter(skillSec, 'Social');
    const statList = h('dl', 'insp-stats');
    skillSec.append(statList);
    const statCells: Record<string, HTMLElement> = {};
    for (const k of ['Children', 'Food eaten', 'Distance walked', 'Fights', 'Kills', 'Food shared', 'Food received']) {
      const dt = h('dt', '', k);
      const dd = h('dd', '', '');
      statList.append(dt, dd);
      statCells[k] = dd;
    }

    const histSec = folded(root, 'Life story');
    const histList = h('ol', 'insp-hist');
    histSec.append(histList);
    const histCache = new Map<string | number, HTMLElement>();

    function refresh(s2: Simulation, a: Agent | null, rec: LineageRecord | null, force: boolean): void {
      const dl = dayLen();
      const alive = !!a && a.alive;
      const nm = a ? a.name : rec ? rec.name : `Agent ${id}`;
      const gen = a ? a.generation : rec ? rec.generation : 0;
      const hue = a ? a.traits.hue : rec ? rec.hue : 0;
      const tribeId = a ? a.tribeId : rec ? rec.tribeId : NONE;
      setText(name, nm);
      badge.hidden = alive;
      const tribe = s2.getTribe(tribeId);
      const swc = tribe ? tribeColor(tribe.hue) : tribeColor(hue);
      if (sw.style.background !== swc) sw.style.background = swc;
      setText(tribeName, tribe ? tribe.name + (tribe.extinctTick !== -1 ? ' (died out)' : '') : 'No tribe');
      tribeName.title = tribe ? `${tribe.name}: ${tribe.members} members` : 'Not a member of any tribe';
      const role = a ? a.role : 'none';
      const birth = a ? a.birthTick : rec ? rec.birthTick : 0;
      const deathTick = a ? a.deathTick : rec ? rec.deathTick : -1;
      const ageTicks = a ? a.age : (deathTick >= 0 ? deathTick : s2.state.tick) - birth;
      const adult = a ? a.age >= a.traits.maturityAge : true;
      const roleText = a && role !== 'none' ? `${ROLE_LABELS[role]}, ` : '';
      const ageText = `${days(ageTicks, dl)} old${a && !adult ? ', not yet adult' : ''}, generation ${gen}`;
      setText(meta2, roleText ? roleText + ageText : ageText[0].toUpperCase() + ageText.slice(1));

      // death line
      const cause = a ? a.deathCause : rec ? rec.deathCause : null;
      deathLine.hidden = alive;
      if (!alive) {
        const day = deathTick >= 0 ? dayOfTick(s2, deathTick) : NaN;
        const on = Number.isFinite(day) ? ` on day ${day}` : '';
        if (cause === 'removed') setText(deathLine, `Removed by you${on}, aged ${days(ageTicks, dl)}.`);
        else setText(deathLine, `Died${on}${cause ? ` ${CAUSE_PHRASE[cause] ?? ''}` : ''}, aged ${days(ageTicks, dl)}.`);
      }
      for (const b of [bFollow, bShow, bBoost, bKill]) b.disabled = !alive;

      // sections that need a full agent snapshot
      for (const sec of [nowSec, whySec, relSec]) sec.hidden = !a;
      for (const sec of [traitSec, skillSec, histSec]) (sec.parentElement as HTMLElement).hidden = !a;
      if (a) {
        const tr = a.traits;
        setText(doing, alive ? describeAction(s2, a) : 'Dead.');
        setText(thought, alive && a.thought ? plainText(a.thought) : '');
        thought.hidden = !alive || !a.thought;

        setMeter(mHealth, a.health / tr.maxHealth, `${Math.round(a.health)} of ${Math.round(tr.maxHealth)}`);
        const hunger = 1 - a.food / tr.maxFood;
        setMeter(mHunger, hunger, `${Math.round(hunger * 100)}%`);
        mHunger.root.classList.toggle('insp-warn', hunger > 0.75);
        setMeter(mEnergy, a.energy, `${Math.round(a.energy * 100)}%`);
        const carryMax = carryCapacity(a) || tr.maxFood;
        setMeter(mCarried, carryMax > 0 ? a.carried / carryMax : 0, a.carried >= 0.5 ? `${Math.round(a.carried)} food` : 'nothing');
        const fear = a.fear ?? 0;
        mFear.root.hidden = !(alive && fear > 0.15);
        if (!mFear.root.hidden) setMeter(mFear, fear, `${Math.round(fear * 100)}%`);

        let st: string;
        let cls = '';
        if (a.infection > 0) {
          st = `Ill: strain virulence ${Math.round(a.virulence * 100)}%, ${days(a.infection, dl)} left.`;
          cls = 'insp-status-bad';
        } else if (a.immuneTicks > 0) {
          st = `Immune after an illness for ${days(a.immuneTicks, dl)} more.`;
          cls = 'insp-status-good';
        } else st = 'Not ill.';
        st += ` Disease resistance ${Math.round(tr.immunity * 100)}%.`;
        setText(disease, st);
        disease.className = `insp-status ${cls}`;

        // reproductive status (mirrors genetics.isFertile, with the first unmet condition spelled out)
        let rs: string;
        let rcls = '';
        if (a.age < tr.maturityAge) rs = `Not yet adult: grown up in ${days(tr.maturityAge - a.age, dl)}.`;
        else if (a.age >= REPRO.maxAgeFrac * tr.longevity) rs = 'Too old to breed.';
        else if (a.reproCooldown > 0) rs = `Resting after a birth: fertile again in ${days(a.reproCooldown, dl)}.`;
        else if (a.food < mateFoodThreshold(tr) * tr.maxFood) rs = `Not fertile: needs a stomach ${Math.round(mateFoodThreshold(tr) * 100)}% full to breed.`;
        else if (a.energy <= REPRO.minEnergy) rs = 'Not fertile: too tired.';
        else if (a.health < REPRO.minHealthFrac * tr.maxHealth) rs = 'Not fertile: too injured or sick.';
        else {
          // canMate also needs a lush home range around the couple (grazed-down land stops births)
          const range = localFoodFraction(s2, a.x, a.y, REPRO.rangeTiles, REPRO.rangeStride);
          const need = rangeFoodThreshold(tr);
          if (range < need) rs = `Fertile, but the land around is grazed down (${Math.round(range * 100)}% food, needs ${Math.round(need * 100)}%).`;
          else {
            rs = 'Fertile and ready to mate.';
            rcls = 'insp-status-good';
          }
        }
        setText(repro, rs);
        repro.className = `insp-status ${rcls}`;

        // navigation: a planned route (dashed line on the map) and a committed trek
        const rt = a.route;
        const parts: string[] = [];
        if (a.trek) {
          const left = days(Math.max(0, a.trek.until - s2.state.tick), dl);
          const target = a.trek.kind === 'raid' && a.trek.tribe !== undefined ? s2.getTribe(a.trek.tribe) : undefined;
          if (a.trek.kind === 'raid') parts.push(`On a raid against ${target ? theTribe(target) : 'an enemy camp'}; it gives up in ${left} at the latest.`);
          else parts.push(`Migrating to greener land; the trek ends in ${left} at the latest.`);
        }
        const moving = a.vx !== 0 || a.vy !== 0;
        if (rt && rt.wait) parts.push('Working out a route.');
        else if (rt && !rt.fail && rt.pts.length > 0 && moving) {
          const left = Math.max(0, (rt.pts.length - rt.i) / 2);
          let len = 0;
          let px = a.x;
          let py = a.y;
          for (let k = rt.i; k + 1 < rt.pts.length; k += 2) {
            len += Math.hypot(rt.pts[k] - px, rt.pts[k + 1] - py);
            px = rt.pts[k];
            py = rt.pts[k + 1];
          }
          parts.push(`Following a route around water or walls: ${left} ${left === 1 ? 'waypoint' : 'waypoints'}, about ${Math.round(len)} units to go.`);
        } else if (rt && rt.fail) parts.push('There is no way there on foot right now; it will look again.');
        const nav = parts.join(' ');
        setText(navLine, nav);
        navLine.hidden = !nav;

        // why: the options of the last decision, strongest first
        const utils = (Object.entries(a.utilities) as [ActionKind, number][]).filter((e) => Number.isFinite(e[1])).sort((x, y) => y[1] - x[1]).slice(0, 6);
        let umax = 0;
        for (const [, v] of utils) if (v > umax) umax = v;
        syncList(
          utilList,
          utilCache,
          utils,
          (u) => u[0],
          (u) => {
            const row = h('div', 'insp-util');
            const lab = h('span', 'insp-util-name');
            lab.append(h('span', '', OPTION_LABELS[u[0]] ?? u[0]), h('span', 'insp-chosen', 'doing now'));
            const track = h('span', 'insp-track insp-track-thin');
            track.append(h('span', 'insp-fill'));
            row.append(lab, track, h('span', 'insp-util-val'));
            return row;
          },
          (row, u) => {
            setWidth(row.children[1].firstChild as HTMLElement, umax > 0 ? u[1] / umax : 0);
            setText(row.children[2] as HTMLElement, u[1].toFixed(2));
            row.classList.toggle('insp-on', alive && u[0] === a.action);
          },
        );
        utilEmpty.hidden = utils.length > 0;
        utilNote.hidden = !alive || !utils.length || utils[0][0] === a.action;

        // relationships (rebuilt only when the people or their groups change)
        const rels = [...a.relationships];
        const friends = rels.filter((r) => r.affinity >= SOCIAL_TUNING.friend).sort((x, y) => y.affinity - x.affinity);
        const enemies = rels.filter((r) => r.affinity <= SOCIAL_TUNING.grudge).sort((x, y) => x.affinity - y.affinity);
        const others = rels
          .filter((r) => r.affinity < SOCIAL_TUNING.friend && r.affinity > SOCIAL_TUNING.grudge)
          .sort((x, y) => Math.abs(y.affinity) - Math.abs(x.affinity));
        const refOf = (r: Relationship) => {
          const p = personRef(s2, r.id);
          const kin = r.kin === 1 ? ' Parent or child.' : r.kin === 2 ? ' Sibling.' : '';
          const aff = `${r.affinity >= 0 ? '+' : ''}${r.affinity.toFixed(2)}`;
          const meet = `${r.interactions} ${r.interactions === 1 ? 'meeting' : 'meetings'}`;
          return { ref: p, tip: `Affinity ${aff} after ${meet}.${kin}${p.alive ? ' Click to select.' : ' Dead.'}` };
        };
        const rk = [friends, enemies, others].map((g) => g.map((r) => `${r.id}${personRef(s2, r.id).alive ? 1 : 0}`).join(',')).join('|');
        if (force || rk !== relKey) {
          relKey = rk;
          nameRow(relFriends, 'Friends', friends.map(refOf), 'None');
          nameRow(relEnemies, 'Enemies', enemies.map(refOf), 'None');
          nameRow(relOthers, 'Knows', others.map(refOf), 'Nobody else yet');
        }

        // life story (newest first)
        const hist = [...a.history].reverse();
        syncList(
          histList,
          histCache,
          hist,
          (e) => `${e.tick}|${e.text}`,
          (e) => {
            const li = h('li');
            li.append(h('span', 'insp-hist-t', clockOfTick(s2, e.tick)), h('span', 'insp-hist-x', plainText(e.text)));
            return li;
          },
          () => {},
        );
        if (!hist.length) {
          if (!histList.childElementCount) histList.append(h('li', 'insp-muted', 'Nothing remarkable yet.'));
        } else histList.querySelector('.insp-muted')?.remove();

        for (const r of traitRows) {
          const gv = a.genes[GENES.indexOf(r.g)] ?? 0;
          setWidth(r.fill, gv);
          setText(r.val, phenotype(r.g, tr, dl));
        }
        setText(
          derived,
          `Maximum health ${Math.round(tr.maxHealth)}, stomach ${Math.round(tr.maxFood)}, strength ${tr.strength.toFixed(2)}, adult at ${days(tr.maturityAge, dl)}.`,
        );

        setMeter(sForage, a.skills.forage, `${Math.round(a.skills.forage * 100)}%`);
        setMeter(sCombat, a.skills.combat, `${Math.round(a.skills.combat * 100)}%`);
        setMeter(sSocial, a.skills.social, `${Math.round(a.skills.social * 100)}%`);
        const stt = a.stats;
        setText(statCells['Children'], String(a.offspring));
        setText(statCells['Food eaten'], Math.round(stt.foodEaten).toLocaleString('en-US'));
        setText(statCells['Distance walked'], `${Math.round(stt.distance).toLocaleString('en-US')} units`);
        setText(statCells['Fights'], String(stt.fights));
        setText(statCells['Kills'], String(stt.kills));
        setText(statCells['Food shared'], Math.round(stt.shared).toLocaleString('en-US'));
        setText(statCells['Food received'], Math.round(stt.received).toLocaleString('en-US'));
      }

      // family (rebuilt only when its content changes)
      const parents = a ? a.parents : rec ? rec.parents : ([NONE, NONE] as [AgentId, AgentId]);
      const pRefs = parents.filter((p) => p !== NONE).map((p) => personRef(s2, p));
      const gRefs: PersonRef[] = [];
      let parentsKnown = 0;
      let parentsFounders = 0;
      for (const p of parents) {
        if (p === NONE) continue;
        const pp = parentsOf(s2, p);
        if (!pp) continue;
        parentsKnown++;
        if (pp[0] === NONE && pp[1] === NONE) parentsFounders++;
        for (const g of pp) if (g !== NONE && !gRefs.some((r) => r.id === g)) gRefs.push(personRef(s2, g));
      }
      const idx = getChildIndex(s2);
      const sibIds: AgentId[] = [];
      for (const p of parents) {
        if (p === NONE) continue;
        for (const c of idx.get(p) ?? []) if (c !== id && !sibIds.includes(c)) sibIds.push(c);
      }
      const sRefs = sibIds.map((k) => personRef(s2, k)).sort((x, y) => Number(y.alive) - Number(x.alive));
      const kids = a ? a.children : (idx.get(id) ?? []);
      const kRefs = kids.map((k) => personRef(s2, k));
      const offspring = a ? a.offspring : rec ? rec.offspring : kids.length;
      const d = descendants(s2, id);
      const key = [
        pRefs.map((p) => `${p.id}${p.alive}`).join(','),
        gRefs.map((p) => `${p.id}${p.alive}`).join(','),
        sRefs.map((p) => `${p.id}${p.alive}`).join(','),
        kRefs.map((p) => `${p.id}${p.alive}`).join(','),
        offspring,
        d.living,
        d.total,
      ].join('|');
      if (force || key !== famKey) {
        famKey = key;
        const founder = parents[0] === NONE && parents[1] === NONE;
        nameRow(famParents, 'Parents', pRefs.map((ref) => ({ ref })), founder ? 'None, a founder' : 'Unknown');
        const noGrand = founder ? 'None' : parentsKnown > 0 && parentsFounders === parentsKnown ? 'None, the parents are founders' : 'Unknown';
        nameRow(famGrand, 'Grandparents', gRefs.map((ref) => ({ ref })), noGrand);
        nameRow(famSibs, 'Siblings', sRefs.map((ref) => ({ ref })), 'None known');
        const unlisted = offspring > kRefs.length ? `${offspring - kRefs.length} earlier ones not listed` : '';
        nameRow(famKids, 'Children', kRefs.map((ref) => ({ ref })), 'None yet', unlisted, 8);
        famDesc.textContent = '';
        famDesc.append(
          h('span', 'insp-row-label', 'Descendants'),
          h('span', 'insp-names', d.total ? `${d.living} living, ${d.total} known in all` : 'None yet'),
        );
      }
    }

    return { id, root, refresh };
  }

  function update(s: Simulation, selectedId: number): void {
    const id = selectedId ?? NONE;
    if (s !== sim) {
      sim = s;
      if (view) view.root.remove();
      view = null;
      lastAgent = null;
      childIdx = null;
      desc = { living: 0, total: 0, tick: -1, id: NONE };
    }
    if (id === NONE || id === undefined || id === null) {
      if (view) {
        view.root.remove();
        view = null;
      }
      lastAgent = null;
      empty.hidden = false;
      return;
    }
    const live = s.getAgent(id) ?? null;
    let force = false;
    if (!view || view.id !== id) {
      if (view) view.root.remove();
      view = buildView(s, id);
      container.append(view.root);
      lastAgent = live;
      force = true;
    }
    if (live) lastAgent = live;
    const agent = live ?? (lastAgent && lastAgent.id === id ? lastAgent : null);
    const rec = s.lineageById.get(id) ?? null;
    if (!agent && !rec) {
      // unknown id (pruned from lineage): show the empty state
      view.root.hidden = true;
      empty.hidden = false;
      return;
    }
    view.root.hidden = false;
    empty.hidden = true;
    // throttle: once per tick change, at most about 8 times a second
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (!force && (s.state.tick === lastTick || now - lastTime < 120)) return;
    lastTick = s.state.tick;
    lastTime = now;
    view.refresh(s, agent, rec, force);
  }

  return { update };
}
