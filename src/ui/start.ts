// OWNER: UI shell. Start screen: pick an experiment, optionally a seed, then Start.
// The map behind it shows a paused preview of the chosen world (App renders it).
import { DEFAULT_CONFIG } from '../sim/config';
import { SCENARIOS } from '../sim/presets';
import type { ScenarioDef } from '../sim/types';
import { fill, h, icon } from './dom';

export interface StartHandlers {
  /** The selection or seed changed: regenerate the preview (seed undefined = experiment default). */
  onPick(sc: ScenarioDef, seed: number | undefined): void;
  onStart(): void;
  onBack(): void;
  onLoad(): void;
  onHelp(): void;
}

export interface StartScreen {
  el: HTMLElement;
  /** Show the screen with `sc` selected and the seed box set (null = default seed). */
  show(sc: ScenarioDef, seed: number | null, canGoBack: boolean): void;
  readonly selected: ScenarioDef;
  /** Seed in the box, or undefined for the experiment's default seed. */
  readonly seed: number | undefined;
  /** The experiment's own seed (used when the box is empty). */
  defaultSeed(sc: ScenarioDef): number;
}

const MAX_SEED = 4294967295;

export function defaultSeedOf(sc: ScenarioDef): number {
  const s = sc.config.seed ?? DEFAULT_CONFIG.seed;
  return Number.isFinite(s) ? s >>> 0 : 0;
}

/** Seed typed in the box (digits only, up to 2^32 - 1), or undefined when empty or not a number. */
export function parseSeed(text: string): number | undefined {
  const t = text.trim();
  if (!/^\d{1,10}$/.test(t)) return undefined;
  const v = Number(t);
  return v <= MAX_SEED ? v : undefined;
}

export function buildStartScreen(handlers: StartHandlers): StartScreen {
  let selected: ScenarioDef = SCENARIOS[0];
  const rows = new Map<string, HTMLButtonElement>();
  const list = h('div', { class: 'st-list', role: 'listbox', 'aria-label': 'Experiments' });
  for (const sc of SCENARIOS) {
    const b = h(
      'button',
      { type: 'button', class: 'st-item', role: 'option', 'aria-selected': 'false', onclick: () => pick(sc) },
      h('span', { class: 'st-item-name' }, sc.name),
      h('span', { class: 'st-item-tag' }, sc.tagline),
    );
    rows.set(sc.id, b);
    list.append(b);
  }

  const detail = h('div', { class: 'st-detail', 'aria-live': 'polite' });
  const seedInput = h('input', { type: 'text', inputmode: 'numeric', class: 'text seed-input', maxlength: 10, 'aria-label': 'Seed', id: 'st-seed', autocomplete: 'off', spellcheck: 'false' });
  const seedNote = h('p', { class: 'st-note' });
  const startBtn = h('button', { type: 'button', class: 'btn primary st-start', onclick: () => handlers.onStart() }, icon('play', 16), h('span', null, 'Start'));
  const backBtn = h('button', { type: 'button', class: 'btn st-back', onclick: () => handlers.onBack() }, 'Back to current run');

  let seedTimer = 0;
  let lastSeed: number | undefined;
  const readSeed = (): number | undefined => parseSeed(seedInput.value);
  const paintSeedNote = () => {
    const raw = seedInput.value.trim();
    const v = readSeed();
    seedInput.classList.toggle('bad', raw !== '' && v === undefined);
    seedNote.textContent = raw !== '' && v === undefined ? 'A seed is a whole number from 0 to 4294967295.' : 'The same seed always gives the same world.';
  };
  seedInput.addEventListener('input', () => {
    paintSeedNote();
    window.clearTimeout(seedTimer);
    seedTimer = window.setTimeout(() => {
      const v = readSeed();
      if (seedInput.value.trim() !== '' && v === undefined) return;
      if (v === lastSeed) return;
      lastSeed = v;
      handlers.onPick(selected, v);
    }, 350);
  });
  seedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      flushSeed();
      handlers.onStart();
    }
  });
  const flushSeed = () => {
    window.clearTimeout(seedTimer);
    const v = readSeed();
    if (v !== lastSeed && !(seedInput.value.trim() !== '' && v === undefined)) {
      lastSeed = v;
      handlers.onPick(selected, v);
    }
  };
  const newSeed = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      onclick: () => {
        const v = 1 + Math.floor(Math.random() * 999_999_999);
        seedInput.value = String(v);
        paintSeedNote();
        lastSeed = v;
        handlers.onPick(selected, v);
      },
    },
    icon('dice', 15),
    'New seed',
  );

  const paintDetail = () => {
    const sc = selected;
    const look = (sc.lookFor ?? []).slice(0, 4);
    fill(
      detail,
      h('h2', { class: 'st-name' }, sc.name),
      sc.description ? h('p', { class: 'st-desc' }, sc.description) : null,
      look.length ? h('h3', null, 'What to watch for') : null,
      look.length ? h('ul', { class: 'st-look' }, ...look.map((l) => h('li', null, l))) : null,
    );
    seedInput.placeholder = `${defaultSeedOf(sc)} (default)`;
  };

  const pick = (sc: ScenarioDef, notify = true) => {
    selected = sc;
    for (const [id, b] of rows) {
      const on = id === sc.id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    paintDetail();
    if (notify) {
      window.clearTimeout(seedTimer);
      const v = readSeed();
      lastSeed = v;
      handlers.onPick(sc, v);
    }
  };

  // arrow keys move through the list
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const i = SCENARIOS.findIndex((s) => s.id === selected.id);
    const next = SCENARIOS[(i + (e.key === 'ArrowDown' ? 1 : SCENARIOS.length - 1)) % SCENARIOS.length];
    pick(next);
    rows.get(next.id)?.focus();
  });

  const el = h(
    'div',
    { class: 'start', role: 'dialog', 'aria-label': 'Choose an experiment' },
    h(
      'div',
      { class: 'st-head' },
      h('div', { class: 'st-brand' }, icon('logo', 22), h('h1', null, 'Artificial Life')),
      h('p', { class: 'st-lead' }, 'A simulated world where creatures with genes and needs forage, raise families, form tribes, fight and evolve.'),
    ),
    h('div', { class: 'st-scroll' }, h('h3', { class: 'st-label' }, 'Experiments'), list, detail),
    h(
      'div',
      { class: 'st-foot' },
      h('div', { class: 'seed-row' }, h('label', { class: 'ctl-label', for: 'st-seed' }, 'Seed'), seedInput, newSeed),
      seedNote,
      h('div', { class: 'st-actions' }, startBtn, backBtn),
      h(
        'div',
        { class: 'st-links' },
        h('button', { type: 'button', class: 'link', onclick: () => handlers.onLoad() }, icon('load', 15), 'Load a saved world'),
        h('button', { type: 'button', class: 'link', onclick: () => handlers.onHelp() }, icon('keyboard', 15), 'Keyboard shortcuts'),
      ),
    ),
  );

  return {
    el,
    show(sc, seed, canGoBack) {
      window.clearTimeout(seedTimer);
      seedInput.value = seed === null ? '' : String(seed);
      lastSeed = seed === null ? undefined : seed;
      paintSeedNote();
      pick(sc, false);
      backBtn.style.display = canGoBack ? '' : 'none';
      window.setTimeout(() => rows.get(sc.id)?.scrollIntoView({ block: 'nearest' }), 0);
    },
    get selected() {
      return selected;
    },
    get seed() {
      return readSeed();
    },
    defaultSeed: defaultSeedOf,
  };
}
