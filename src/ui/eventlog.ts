/**
 * Events tab (OWNER: UI panels): newest-first feed of sim.state.events with category filter chips, plain
 * times ("Day 3, 14:00") and click-to-jump. Rows are appended incrementally (tracks the last event id) and
 * the DOM is capped at MAX_ROWS.
 */
import './analytics.css';
import type { Simulation } from '../sim/simulation';
import type { EventCategory, SimEvent } from '../sim/types';
import { clockOfTick, plainText } from './analytics';
import { icon } from './dom';

export interface EventLogPanel {
  update(sim: Simulation): void;
}

const MAX_ROWS = 300;

/** Categories in filter order, with the icon name (dom.ts icon set) and the filter label. */
export const EVENT_CATEGORIES: { id: EventCategory; label: string; icon: string }[] = [
  { id: 'population', label: 'Population', icon: 'users' },
  { id: 'tribe', label: 'Tribes', icon: 'flag' },
  { id: 'conflict', label: 'Conflict', icon: 'swords' },
  { id: 'disaster', label: 'Disasters', icon: 'bolt' },
  { id: 'disease', label: 'Disease', icon: 'virus' },
  { id: 'evolution', label: 'Evolution', icon: 'dna' },
  { id: 'environment', label: 'Environment', icon: 'sun' },
  { id: 'intervention', label: 'Your actions', icon: 'hand' },
  { id: 'record', label: 'Records', icon: 'star' },
];
const CAT = new Map(EVENT_CATEGORIES.map((c) => [c.id, c]));

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function safeIcon(name: string, size: number): Element {
  try {
    return icon(name, size, 'ev-ic');
  } catch {
    return h('span', 'ev-ic');
  }
}

/** onJump(x, y) moves the camera to an event's location. */
export function createEventLog(container: HTMLElement, onJump: (x: number, y: number) => void): EventLogPanel {
  container.textContent = '';
  container.classList.add('ev-root');

  const hidden = new Set<EventCategory>();
  const counts = new Map<EventCategory, number>();

  // filter chips: one compact row of icons, with the label and count in the tooltip
  const chips = h('div', 'ev-chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Show or hide kinds of events');
  const allChip = h('button', 'ev-chip ev-chip-all', 'All');
  allChip.type = 'button';
  allChip.setAttribute('aria-pressed', 'true');
  allChip.dataset.tip = 'Show every kind of event, or hide them all';
  chips.append(allChip);
  const chipEls = new Map<EventCategory, { btn: HTMLButtonElement; label: string }>();
  const chipTip = (c: { id: EventCategory; label: string }) => {
    const n = counts.get(c.id) ?? 0;
    return `${c.label} (${n > 999 ? '999+' : n}). Click to show or hide, double-click to show only these.`;
  };
  for (const c of EVENT_CATEGORIES) {
    const btn = h('button', `ev-chip ev-c-${c.id}`);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'true');
    btn.setAttribute('aria-label', c.label);
    btn.dataset.tip = chipTip(c);
    btn.append(safeIcon(c.icon, 15));
    btn.addEventListener('click', () => {
      if (hidden.has(c.id)) hidden.delete(c.id);
      else hidden.add(c.id);
      applyFilter();
    });
    btn.addEventListener('dblclick', () => {
      hidden.clear();
      for (const o of EVENT_CATEGORIES) if (o.id !== c.id) hidden.add(o.id);
      applyFilter();
    });
    chipEls.set(c.id, { btn, label: c.label });
    chips.append(btn);
  }
  allChip.addEventListener('click', () => {
    if (hidden.size === 0) for (const c of EVENT_CATEGORIES) hidden.add(c.id);
    else hidden.clear();
    applyFilter();
  });
  container.append(chips);
  const filterNote = h('p', 'ev-filter-note');
  filterNote.hidden = true;
  container.append(filterNote);

  const list = h('ol', 'ev-list');
  list.setAttribute('aria-live', 'polite');
  container.append(list);
  const empty = h('p', 'ev-empty', 'No events yet. They appear here as they happen, newest first.');
  container.append(empty);

  function applyFilter(): void {
    for (const c of EVENT_CATEGORIES) {
      const on = !hidden.has(c.id);
      chipEls.get(c.id)!.btn.setAttribute('aria-pressed', String(on));
      list.classList.toggle(`ev-hide-${c.id}`, !on);
    }
    allChip.setAttribute('aria-pressed', String(hidden.size === 0));
    if (hidden.size === 0) filterNote.hidden = true;
    else {
      const shown = EVENT_CATEGORIES.filter((c) => !hidden.has(c.id)).map((c) => c.label.toLowerCase());
      filterNote.textContent = shown.length ? `Showing ${shown.join(', ')}.` : 'All kinds of events are hidden.';
      filterNote.hidden = false;
    }
  }

  let sim: Simulation | null = null;
  let lastId = 0;
  let firstId = 0;

  function reset(): void {
    list.textContent = '';
    lastId = 0;
    firstId = 0;
    counts.clear();
    for (const c of EVENT_CATEGORIES) chipEls.get(c.id)!.btn.dataset.tip = chipTip(c);
  }

  function row(ev: SimEvent, s: Simulation): HTMLElement {
    const c = CAT.get(ev.category) ?? { id: ev.category, label: ev.category, icon: '' };
    const li = h('li', `ev-row ev-c-${ev.category} ev-s-${ev.severity}`);
    li.dataset.id = String(ev.id);
    const ic = h('span', 'ev-icon');
    ic.append(safeIcon(c.icon, 15));
    ic.title = c.label;
    const body = h('span', 'ev-body');
    const msg = h('span', 'ev-msg', plainText(ev.message));
    const time = h('span', 'ev-time', clockOfTick(s, ev.tick));
    time.title = `Tick ${ev.tick}`;
    body.append(msg, time);
    li.append(ic, body);
    const hasPos = typeof ev.x === 'number' && typeof ev.y === 'number' && Number.isFinite(ev.x) && Number.isFinite(ev.y);
    if (hasPos || ev.agentId !== undefined) {
      li.classList.add('ev-jump');
      li.tabIndex = 0;
      li.title = hasPos ? 'Show this place on the map' : 'Show this agent on the map, if it is still alive';
      const go = () => {
        if (hasPos) onJump(ev.x as number, ev.y as number);
        else if (sim && ev.agentId !== undefined) {
          const a = sim.getAgent(ev.agentId);
          if (a) onJump(a.x, a.y);
        }
      };
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      });
    }
    return li;
  }

  function update(s: Simulation): void {
    const events = s.state.events;
    // new simulation, restart or load: rebuild
    if (s !== sim || (events.length && events[0].id < firstId && lastId > 0) || (events.length && events[events.length - 1].id < lastId)) {
      sim = s;
      reset();
    }
    if (!events.length) {
      empty.hidden = list.childElementCount > 0;
      return;
    }
    const newest = events[events.length - 1].id;
    if (newest <= lastId) return;
    // collect new events (they are appended in id order)
    let i = events.length - 1;
    while (i > 0 && events[i - 1].id > lastId) i--;
    const start = Math.max(i, events.length - MAX_ROWS);
    const frag = document.createDocumentFragment();
    for (let k = events.length - 1; k >= start; k--) frag.append(row(events[k], s));
    for (let k = i; k < events.length; k++) {
      const cat = events[k].category;
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    list.insertBefore(frag, list.firstChild);
    while (list.childElementCount > MAX_ROWS) list.lastElementChild!.remove();
    lastId = newest;
    firstId = events[0].id;
    for (const c of EVENT_CATEGORIES) chipEls.get(c.id)!.btn.dataset.tip = chipTip(c);
    empty.hidden = true;
  }

  applyFilter();
  return { update };
}
