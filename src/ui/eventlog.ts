/**
 * Event log (OWNER: Analytics): newest-first feed of sim.state.events with
 * category filter chips, severity styling and click-to-jump. Rows are appended
 * incrementally (tracks the last event id) and the DOM is capped at MAX_ROWS.
 */
import './analytics.css';
import type { Simulation } from '../sim/simulation';
import type { EventCategory, SimEvent } from '../sim/types';

export interface EventLogPanel {
  update(sim: Simulation): void;
}

const MAX_ROWS = 300;

export const EVENT_CATEGORIES: { id: EventCategory; label: string; icon: string }[] = [
  { id: 'population', label: 'Population', icon: '●' },
  { id: 'tribe', label: 'Tribes', icon: '⚑' },
  { id: 'conflict', label: 'Conflict', icon: '⚔' },
  { id: 'disaster', label: 'Disasters', icon: '☄' },
  { id: 'disease', label: 'Disease', icon: '☣' },
  { id: 'evolution', label: 'Evolution', icon: '⧖' },
  { id: 'environment', label: 'Environment', icon: '☀' },
  { id: 'intervention', label: 'You', icon: '✋' },
  { id: 'record', label: 'Records', icon: '★' },
];
const CAT = new Map(EVENT_CATEGORIES.map((c) => [c.id, c]));

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** onJump(x,y) pans the camera to an event location. */
export function createEventLog(container: HTMLElement, onJump: (x: number, y: number) => void): EventLogPanel {
  container.textContent = '';
  container.classList.add('ev-root');

  const hidden = new Set<EventCategory>();
  const counts = new Map<EventCategory, number>();

  // filter chips
  const chips = h('div', 'ev-chips');
  const allChip = h('button', 'ev-chip ev-chip-all', 'All');
  allChip.type = 'button';
  allChip.setAttribute('aria-pressed', 'true');
  chips.append(allChip);
  const chipEls = new Map<EventCategory, { btn: HTMLButtonElement; count: HTMLElement }>();
  for (const c of EVENT_CATEGORIES) {
    const btn = h('button', `ev-chip ev-c-${c.id}`);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'true');
    btn.title = `Show/hide ${c.label.toLowerCase()} events (double-click: show only these)`;
    const count = h('span', 'ev-chip-n', '0');
    btn.append(h('span', 'ev-icon', c.icon), document.createTextNode(c.label), count);
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
    chipEls.set(c.id, { btn, count });
    chips.append(btn);
  }
  allChip.addEventListener('click', () => {
    if (hidden.size === 0) for (const c of EVENT_CATEGORIES) hidden.add(c.id);
    else hidden.clear();
    applyFilter();
  });
  container.append(chips);

  const list = h('ol', 'ev-list');
  list.setAttribute('aria-live', 'polite');
  container.append(list);
  const empty = h('div', 'ev-empty', 'No events yet — history will be written here as it happens.');
  container.append(empty);

  function applyFilter(): void {
    for (const c of EVENT_CATEGORIES) {
      const on = !hidden.has(c.id);
      chipEls.get(c.id)!.btn.setAttribute('aria-pressed', String(on));
      list.classList.toggle(`ev-hide-${c.id}`, !on);
    }
    allChip.setAttribute('aria-pressed', String(hidden.size === 0));
  }

  let sim: Simulation | null = null;
  let lastId = 0;
  let firstId = 0;

  function reset(): void {
    list.textContent = '';
    lastId = 0;
    firstId = 0;
    counts.clear();
    for (const { count } of chipEls.values()) count.textContent = '0';
  }

  function row(ev: SimEvent, dayLen: number): HTMLElement {
    const c = CAT.get(ev.category) ?? { id: ev.category, label: ev.category, icon: '•' };
    const li = h('li', `ev-row ev-c-${ev.category} ev-s-${ev.severity}`);
    li.dataset.id = String(ev.id);
    const icon = h('span', 'ev-icon', c.icon);
    icon.title = c.label;
    const day = Math.floor(ev.tick / dayLen);
    const time = h('span', 'ev-time', `Day ${day}`);
    time.title = `Tick ${ev.tick}`;
    const msg = h('span', 'ev-msg', ev.message);
    li.append(icon, time, msg);
    const hasPos = typeof ev.x === 'number' && typeof ev.y === 'number' && Number.isFinite(ev.x) && Number.isFinite(ev.y);
    if (hasPos || ev.agentId !== undefined) {
      li.classList.add('ev-jump');
      li.tabIndex = 0;
      li.title = hasPos ? 'Click to jump to this location' : 'Click to jump to this agent (if still alive)';
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
      if (hasPos) li.append(h('span', 'ev-pin', '⌖'));
    }
    return li;
  }

  function update(s: Simulation): void {
    const events = s.state.events;
    // new simulation / restart / load: rebuild
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
    const dayLen = Math.max(1, s.config.dayLength || 600);
    const start = Math.max(i, events.length - MAX_ROWS);
    const frag = document.createDocumentFragment();
    for (let k = events.length - 1; k >= start; k--) frag.append(row(events[k], dayLen));
    for (let k = i; k < events.length; k++) {
      const cat = events[k].category;
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    list.insertBefore(frag, list.firstChild);
    while (list.childElementCount > MAX_ROWS) list.lastElementChild!.remove();
    lastId = newest;
    firstId = events[0].id;
    for (const [cat, n] of counts) {
      const el = chipEls.get(cat);
      if (el) el.count.textContent = n > 999 ? '999+' : String(n);
    }
    empty.hidden = true;
  }

  applyFilter();
  return { update };
}
