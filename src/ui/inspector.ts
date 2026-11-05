/**
 * Agent inspector (OWNER: Analytics). The DOM skeleton is built once per selected
 * id; afterwards text, bars and keyed lists are updated in place (throttled).
 * A dead agent keeps its last snapshot (with cause of death); an id known only
 * from the lineage registry shows its lineage record.
 */
import './analytics.css';
import type { Simulation } from '../sim/simulation';
import { GENES, NONE, type ActionKind, type Agent, type AgentId, type GeneName, type LineageRecord, type Traits } from '../sim/types';
import { CAUSE_LABELS, GENE_DESCRIPTIONS, GENE_LABELS, ROLE_LABELS, tribeColor } from './analytics';

export interface InspectorHandlers {
  onSelect(id: number): void; // select another agent (e.g. click a relative)
  onFollow(id: number): void; // camera follows agent
  onKill(id: number): void; // enqueue killAgent
  onBoost(id: number): void; // enqueue boostAgent
}

export interface Inspector {
  update(sim: Simulation, selectedId: number): void;
}

const ACTION_LABELS: Record<ActionKind, string> = {
  idle: 'Idling',
  wander: 'Wandering',
  explore: 'Exploring',
  forage: 'Foraging',
  eat: 'Eating',
  rest: 'Resting',
  flee: 'Fleeing',
  attack: 'Attacking',
  share: 'Sharing food',
  mate: 'Courting',
  socialize: 'Socialising',
  gohome: 'Heading home',
  deposit: 'Storing food',
  withdraw: 'Taking from store',
};

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

function section(parent: HTMLElement, title: string, open = true): HTMLElement {
  const d = h('details', 'insp-sec');
  d.open = open;
  d.append(h('summary', 'insp-sec-title', title));
  const body = h('div', 'insp-sec-body');
  d.append(body);
  parent.append(d);
  return body;
}

function phenotype(g: GeneName, t: Traits, dayLen: number): string {
  switch (g) {
    case 'speed':
      return `${t.speed.toFixed(2)} u/tick`;
    case 'size':
      return `×${t.size.toFixed(2)}`;
    case 'perception':
      return `${Math.round(t.perception)} u`;
    case 'metabolism':
      return `×${t.metabolism.toFixed(2)} burn`;
    case 'longevity':
      return `${(t.longevity / dayLen).toFixed(1)} days`;
    case 'efficiency':
      return `×${t.efficiency.toFixed(2)} /bite`;
    case 'hue':
      return `${Math.round(t.hue)}°`;
    default:
      return `${Math.round((t[g] as number) * 100)}%`;
  }
}

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
  return { id, name: `#${id}`, alive: false, known: false };
}

function parentsOf(sim: Simulation, id: AgentId): [AgentId, AgentId] | null {
  const a = sim.getAgent(id);
  if (a) return a.parents;
  const rec = sim.lineageById.get(id);
  return rec ? rec.parents : null;
}

/** parent id → child ids, built from the lineage registry (cached by the caller). */
function buildChildIndex(sim: Simulation): Map<AgentId, AgentId[]> {
  const idx = new Map<AgentId, AgentId[]>();
  for (const rec of sim.state.lineage) {
    for (const p of rec.parents) {
      if (p === NONE) continue;
      let arr = idx.get(p);
      if (!arr) idx.set(p, (arr = []));
      arr.push(rec.id);
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
  empty.append(h('div', 'insp-empty-icon', '◎'), h('div', '', 'Click an agent to inspect it'), h('div', 'insp-empty-sub', 'Its genes, needs, thoughts, relationships and family appear here.'));
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

  /** Clickable person link (alive or recorded dead → selectable). */
  const personEl = (p: PersonRef, extra = ''): HTMLElement => {
    const el = h(p.known ? 'button' : 'span', `insp-person${p.alive ? '' : ' insp-dead'}`);
    if (el instanceof HTMLButtonElement) {
      el.type = 'button';
      el.addEventListener('click', () => handlers.onSelect(p.id));
      el.title = p.alive ? `Inspect ${p.name}` : `${p.name} (deceased) — show lineage record`;
    }
    el.textContent = `${p.name}${p.alive ? '' : ' †'}${extra}`;
    return el;
  };

  function buildView(s: Simulation, id: AgentId): View {
    const root = h('div', 'insp-body');
    const dayLen = () => Math.max(1, s.config.dayLength || 600);

    // header
    const head = h('div', 'insp-head');
    const sw = h('span', 'insp-swatch');
    const titleBox = h('div', 'insp-title');
    const name = h('div', 'insp-name');
    const idLine = h('div', 'insp-idline');
    titleBox.append(name, idLine);
    const badge = h('span', 'insp-badge');
    head.append(sw, titleBox, badge);
    root.append(head);
    const chipRow = h('div', 'insp-chiprow');
    const tribeChip = h('span', 'insp-chip');
    const tribeDot = h('i');
    const tribeName = h('span');
    tribeChip.append(tribeDot, tribeName);
    const roleChip = h('span', 'insp-chip insp-chip-plain');
    const ageChip = h('span', 'insp-chip insp-chip-plain');
    chipRow.append(tribeChip, roleChip, ageChip);
    root.append(chipRow);

    const deathBanner = h('div', 'insp-death');
    deathBanner.hidden = true;
    root.append(deathBanner);

    // thought
    const doing = h('div', 'insp-doing');
    const actionEl = h('div', 'insp-action');
    const thought = h('div', 'insp-thought');
    doing.append(actionEl, thought);
    root.append(doing);

    // buttons
    const btns = h('div', 'insp-btns');
    const bFollow = h('button', 'insp-btn', 'Follow');
    const bBoost = h('button', 'insp-btn insp-btn-good', 'Feed & heal');
    const bKill = h('button', 'insp-btn insp-btn-bad', 'Smite');
    for (const b of [bFollow, bBoost, bKill]) b.type = 'button';
    bFollow.title = 'Camera follows this agent';
    bBoost.title = 'Restore health and fill its stomach';
    bKill.title = 'Strike this agent down';
    bFollow.addEventListener('click', () => handlers.onFollow(id));
    bBoost.addEventListener('click', () => handlers.onBoost(id));
    bKill.addEventListener('click', () => handlers.onKill(id));
    btns.append(bFollow, bBoost, bKill);
    root.append(btns);

    // vitals
    const vit = section(root, 'Condition');
    const mHealth = meter(vit, 'Health', 'insp-m-health');
    const mHunger = meter(vit, 'Hunger', 'insp-m-hunger');
    const mEnergy = meter(vit, 'Energy', 'insp-m-energy');
    const mCarried = meter(vit, 'Carried', 'insp-m-carried');
    const disease = h('div', 'insp-status');
    vit.append(disease);

    // traits
    const traitSec = section(root, 'Genes & traits');
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
    const derived = h('div', 'insp-derived');
    traitSec.append(derived);

    // decision
    const decSec = section(root, 'Last decision');
    const utilList = h('div', 'insp-utils');
    decSec.append(utilList);
    const utilCache = new Map<string | number, HTMLElement>();

    // skills
    const skillSec = section(root, 'Skills', false);
    const sForage = meter(skillSec, 'Foraging');
    const sCombat = meter(skillSec, 'Combat');
    const sSocial = meter(skillSec, 'Social');

    // relationships
    const relSec = section(root, 'Relationships');
    const relList = h('div', 'insp-rels');
    const relEmpty = h('div', 'insp-muted', 'No relationships yet.');
    relSec.append(relList, relEmpty);
    const relCache = new Map<string | number, HTMLElement>();

    // family
    const famSec = section(root, 'Family');
    const famParents = h('div', 'insp-fam-row');
    const famGrand = h('div', 'insp-fam-row');
    const famKids = h('div', 'insp-fam-row');
    const famDesc = h('div', 'insp-fam-row');
    famSec.append(famParents, famGrand, famKids, famDesc);
    let famKey = '';

    // history
    const histSec = section(root, 'Life story');
    const histList = h('ol', 'insp-hist');
    histSec.append(histList);
    const histCache = new Map<string | number, HTMLElement>();

    // lifetime stats
    const statSec = section(root, 'Lifetime', false);
    const statGrid = h('div', 'insp-stats');
    statSec.append(statGrid);
    const statCells: Record<string, HTMLElement> = {};
    for (const k of ['Offspring', 'Food eaten', 'Distance', 'Fights', 'Kills', 'Shared', 'Received']) {
      const cell = h('div', 'insp-stat');
      const v = h('b', '', '–');
      cell.append(v, h('span', '', k));
      statGrid.append(cell);
      statCells[k] = v;
    }

    const famLabel = (label: string, host: HTMLElement, people: (PersonRef | null)[], emptyText: string, extra?: string) => {
      host.textContent = '';
      host.append(h('span', 'insp-fam-label', label));
      const list = h('span', 'insp-fam-list');
      const ps = people.filter((p): p is PersonRef => !!p);
      if (!ps.length) list.append(h('span', 'insp-muted', emptyText));
      for (const p of ps) list.append(personEl(p));
      if (extra) list.append(h('span', 'insp-muted', extra));
      host.append(list);
    };

    function refresh(s2: Simulation, a: Agent | null, rec: LineageRecord | null, force: boolean): void {
      const dl = dayLen();
      const alive = !!a && a.alive;
      const nm = a ? a.name : rec ? rec.name : `#${id}`;
      const gen = a ? a.generation : rec ? rec.generation : 0;
      const hue = a ? a.traits.hue : rec ? rec.hue : 0;
      const tribeId = a ? a.tribeId : rec ? rec.tribeId : NONE;
      setText(name, nm + (alive ? '' : ' †'));
      setText(idLine, `#${id} · generation ${gen}`);
      sw.style.background = `hsl(${Math.round(hue)}, 70%, 58%)`;
      setText(badge, alive ? 'Alive' : 'Dead');
      badge.classList.toggle('insp-badge-dead', !alive);
      const tribe = s2.getTribe(tribeId);
      tribeChip.hidden = !tribe;
      if (tribe) {
        tribeDot.style.background = tribeColor(tribe.hue);
        setText(tribeName, tribe.name + (tribe.extinctTick !== -1 ? ' (extinct)' : ''));
        tribeChip.title = `Tribe ${tribe.name}: ${tribe.members} members`;
      }
      const role = a ? a.role : 'none';
      roleChip.hidden = !a || role === 'none';
      setText(roleChip, ROLE_LABELS[role]);
      const birth = a ? a.birthTick : rec ? rec.birthTick : 0;
      const deathTick = a ? a.deathTick : rec ? rec.deathTick : -1;
      const ageTicks = a ? a.age : (deathTick >= 0 ? deathTick : s2.state.tick) - birth;
      const adult = a ? a.age >= a.traits.maturityAge : true;
      setText(ageChip, `${(ageTicks / dl).toFixed(1)} days old${a && !adult ? ' · juvenile' : ''}`);

      // death banner
      const cause = a ? a.deathCause : rec ? rec.deathCause : null;
      deathBanner.hidden = alive;
      if (!alive) {
        const when = deathTick >= 0 ? ` on day ${Math.floor(deathTick / dl)}` : '';
        setText(deathBanner, `Died${when}${cause ? ` — ${CAUSE_LABELS[cause].toLowerCase()}` : ''}, aged ${(ageTicks / dl).toFixed(1)} days.`);
      }
      for (const b of [bFollow, bBoost, bKill]) b.disabled = !alive;

      // sections that need a full agent snapshot
      doing.hidden = !a;
      for (const sec of [vit, traitSec, decSec, skillSec, relSec, histSec]) (sec.parentElement as HTMLElement).hidden = !a;
      if (a) {
        const tr = a.traits;
        setText(actionEl, alive ? ACTION_LABELS[a.action] ?? a.action : 'Deceased');
        const extras: string[] = [];
        if (a.fear !== undefined && a.fear > 0.15) extras.push(`fear ${Math.round(a.fear * 100)}%`);
        setText(thought, alive ? (a.thought ? `“${a.thought}”` : '') + (extras.length ? ` (${extras.join(', ')})` : '') : '');

        setMeter(mHealth, a.health / tr.maxHealth, `${Math.round(a.health)} / ${Math.round(tr.maxHealth)}`);
        const hunger = 1 - a.food / tr.maxFood;
        setMeter(mHunger, hunger, `${Math.round(hunger * 100)}%`);
        mHunger.root.classList.toggle('insp-warn', hunger > 0.75);
        setMeter(mEnergy, a.energy, `${Math.round(a.energy * 100)}%`);
        setMeter(mCarried, a.carried / tr.maxFood, a.carried > 0 ? a.carried.toFixed(1) : '0');
        let st = '';
        let cls = '';
        if (a.infection > 0) {
          st = `Infected — virulence ${Math.round(a.virulence * 100)}%, ${(a.infection / dl).toFixed(1)} days left`;
          cls = 'insp-status-bad';
        } else if (a.immuneTicks > 0) {
          st = `Immune (recovered) — ${(a.immuneTicks / dl).toFixed(1)} days left`;
          cls = 'insp-status-good';
        } else st = 'Healthy';
        st += ` · resistance ${Math.round(tr.immunity * 100)}%`;
        setText(disease, st);
        disease.className = `insp-status ${cls}`;

        for (const r of traitRows) {
          const gv = a.genes[GENES.indexOf(r.g)] ?? 0;
          setWidth(r.fill, gv);
          setText(r.val, phenotype(r.g, tr, dl));
        }
        setText(
          derived,
          `Max health ${Math.round(tr.maxHealth)} · stomach ${Math.round(tr.maxFood)} · strength ${tr.strength.toFixed(2)} · adult at ${(tr.maturityAge / dl).toFixed(1)} d`,
        );

        // utilities
        const utils = (Object.entries(a.utilities) as [ActionKind, number][]).filter((e) => Number.isFinite(e[1])).sort((x, y) => y[1] - x[1]).slice(0, 8);
        let umax = 0;
        for (const [, v] of utils) if (v > umax) umax = v;
        syncList(
          utilList,
          utilCache,
          utils,
          (u) => u[0],
          (u) => {
            const row = h('div', 'insp-util');
            const lab = h('span', 'insp-util-name', ACTION_LABELS[u[0]] ?? u[0]);
            const track = h('span', 'insp-track insp-track-thin');
            track.append(h('span', 'insp-fill'));
            row.append(lab, track, h('span', 'insp-util-val'));
            return row;
          },
          (row, u) => {
            setWidth(row.children[1].firstChild as HTMLElement, umax > 0 ? u[1] / umax : 0);
            setText(row.children[2] as HTMLElement, u[1].toFixed(2));
            row.classList.toggle('insp-on', u[0] === a.action);
          },
        );
        if (!utils.length && !utilList.querySelector('.insp-muted')) utilList.append(h('div', 'insp-muted', 'No decision yet.'));
        else if (utils.length) utilList.querySelector('.insp-muted')?.remove();

        setMeter(sForage, a.skills.forage, `${Math.round(a.skills.forage * 100)}%`);
        setMeter(sCombat, a.skills.combat, `${Math.round(a.skills.combat * 100)}%`);
        setMeter(sSocial, a.skills.social, `${Math.round(a.skills.social * 100)}%`);

        // relationships
        const rels = [...a.relationships].sort((x, y) => y.affinity - x.affinity);
        relEmpty.hidden = rels.length > 0;
        syncList(
          relList,
          relCache,
          rels,
          (r) => r.id,
          (r) => {
            const row = h('div', 'insp-rel');
            const p = personRef(s2, r.id);
            const who = personEl(p);
            const kin = h('span', 'insp-kin');
            const track = h('span', 'insp-aff');
            const fill = h('span', 'insp-aff-fill');
            track.append(h('span', 'insp-aff-mid'), fill);
            row.append(who, kin, track);
            row.dataset.alive = String(p.alive);
            return row;
          },
          (row, r) => {
            const p = personRef(s2, r.id);
            if (row.dataset.alive !== String(p.alive)) {
              const fresh = personEl(p);
              row.replaceChild(fresh, row.firstChild as HTMLElement);
              row.dataset.alive = String(p.alive);
            }
            setText(row.children[1] as HTMLElement, r.kin === 1 ? 'parent/child' : r.kin === 2 ? 'sibling' : '');
            const fill = (row.children[2] as HTMLElement).children[1] as HTMLElement;
            const aff = Math.max(-1, Math.min(1, r.affinity));
            const left = aff < 0 ? 50 + aff * 50 : 50;
            const l = `${left.toFixed(1)}%`;
            if (fill.style.left !== l) fill.style.left = l;
            setWidth(fill, Math.abs(aff) / 2);
            fill.classList.toggle('insp-aff-neg', aff < 0);
            row.title = `Affinity ${aff >= 0 ? '+' : ''}${aff.toFixed(2)} · ${r.interactions} interactions`;
          },
        );

        // history (newest first)
        const hist = [...a.history].reverse();
        syncList(
          histList,
          histCache,
          hist,
          (e) => `${e.tick}|${e.text}`,
          (e) => {
            const li = h('li');
            li.append(h('span', 'insp-hist-t', `Day ${(e.tick / dl).toFixed(1)}`), h('span', 'insp-hist-x', e.text));
            return li;
          },
          () => {},
        );
        if (!hist.length) {
          if (!histList.childElementCount) histList.append(h('li', 'insp-muted', 'Nothing remarkable yet.'));
        } else histList.querySelector('.insp-muted')?.remove();

        const stt = a.stats;
        setText(statCells['Offspring'], String(a.offspring));
        setText(statCells['Food eaten'], Math.round(stt.foodEaten).toString());
        setText(statCells['Distance'], Math.round(stt.distance).toString());
        setText(statCells['Fights'], String(stt.fights));
        setText(statCells['Kills'], String(stt.kills));
        setText(statCells['Shared'], Math.round(stt.shared).toString());
        setText(statCells['Received'], Math.round(stt.received).toString());
      } else if (rec) {
        setText(statCells['Offspring'], String(rec.offspring));
      }
      (statSec.parentElement as HTMLElement).hidden = !a && !rec;

      // family (rebuilt only when its content changes)
      const parents = a ? a.parents : rec ? rec.parents : ([NONE, NONE] as [AgentId, AgentId]);
      const pRefs = parents.map((p) => (p === NONE ? null : personRef(s2, p)));
      const gRefs: (PersonRef | null)[] = [];
      for (const p of parents) {
        if (p === NONE) continue;
        const pp = parentsOf(s2, p);
        if (pp) for (const g of pp) if (g !== NONE) gRefs.push(personRef(s2, g));
      }
      const kids = a ? a.children : (getChildIndex(s2).get(id) ?? []);
      const kRefs = kids.map((k) => personRef(s2, k));
      const offspring = a ? a.offspring : rec ? rec.offspring : kids.length;
      const d = descendants(s2, id);
      const key = [
        pRefs.map((p) => (p ? `${p.id}${p.alive}` : '-')).join(','),
        gRefs.map((p) => (p ? `${p.id}${p.alive}` : '-')).join(','),
        kRefs.map((p) => `${p.id}${p.alive}`).join(','),
        offspring,
        d.living,
        d.total,
      ].join('|');
      if (force || key !== famKey) {
        famKey = key;
        const founder = parents[0] === NONE && parents[1] === NONE;
        famLabel('Parents', famParents, pRefs, founder ? 'Founder — no parents' : 'Unknown');
        famLabel('Grandparents', famGrand, gRefs, founder ? '—' : 'Unknown');
        const more = offspring > kRefs.length ? ` +${offspring - kRefs.length} more` : '';
        famLabel('Children', famKids, kRefs, 'None yet', more);
        famDesc.textContent = '';
        famDesc.append(
          h('span', 'insp-fam-label', 'Descendants'),
          h('span', 'insp-fam-list', `${d.living} living · ${d.total} known in total`),
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
    // throttle: once per tick change, at most ~8 Hz
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (!force && (s.state.tick === lastTick || now - lastTime < 120)) return;
    lastTick = s.state.tick;
    lastTime = now;
    view.refresh(s, agent, rec, force);
  }

  return { update };
}
