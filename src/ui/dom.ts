// OWNER: UI shell. Tiny dependency-free DOM helpers: element factory, the icon set,
// styled tooltips, toasts and reusable controls (slider, toggle, fold, choice list).

export type Child = Node | string | number | null | undefined | false;
export type Props = Record<string, unknown>;

/** Create an element. `tip` sets data-tip (styled tooltip), `on<event>` adds a listener, `html` sets innerHTML. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k === 'tip') el.setAttribute('data-tip', String(v));
      else if (k === 'html') el.innerHTML = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: (Child | Child[])[]): void {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else if (typeof c === 'string' || typeof c === 'number') el.append(document.createTextNode(String(c)));
    else el.append(c);
  }
}

/** Replace an element's children (null, undefined and false are skipped). */
export function fill(el: Element, ...children: (Child | Child[])[]): void {
  el.replaceChildren();
  append(el, children);
}

// ------------------------------------------------------------------ icons
// One icon set for the whole app: 24-unit viewBox, 1.5 stroke, round caps and joins,
// currentColor. Small filled dots only where a dot is part of the drawing.
const dot = (cx: number, cy: number, r = 1): string => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`;
const PERSON = '<circle cx="9.5" cy="8" r="3.5"/><path d="M3.5 19.5c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5"/>';
const APPLE = '<path d="M12 7.6c-2.5-1.8-7.5-1.2-7.5 4.4 0 4.6 3.2 8.4 5.5 8.4.9 0 1.4-.5 2-.5s1.1.5 2 .5c2.3 0 5.5-3.8 5.5-8.4 0-5.6-5-6.2-7.5-4.4z"/><path d="M12 7.6c0-2 .9-3.5 2.8-4.1"/>';
const VIRUS =
  '<circle cx="12" cy="12" r="5"/><path d="M12 7V4M12 20v-3M7 12H4M20 12h-3M10.5 4h3M10.5 20h3M4 10.5v3M20 10.5v3M8.5 8.5L7 7M15.5 15.5L17 17M8.5 15.5L7 17M15.5 8.5L17 7"/>' +
  dot(10.6, 11, 0.9) +
  dot(13.4, 13.3, 0.9);
const GEAR =
  '<path d="M19.02 10.38L21.21 10.71A9.3 9.3 0 0 1 21.21 13.29L19.02 13.62A7.2 7.2 0 0 1 18.11 15.82L19.43 17.6A9.3 9.3 0 0 1 17.6 19.43L15.82 18.11A7.2 7.2 0 0 1 13.62 19.02L13.29 21.21A9.3 9.3 0 0 1 10.71 21.21L10.38 19.02A7.2 7.2 0 0 1 8.18 18.11L6.4 19.43A9.3 9.3 0 0 1 4.57 17.6L5.89 15.82A7.2 7.2 0 0 1 4.98 13.62L2.79 13.29A9.3 9.3 0 0 1 2.79 10.71L4.98 10.38A7.2 7.2 0 0 1 5.89 8.18L4.57 6.4A9.3 9.3 0 0 1 6.4 4.57L8.18 5.89A7.2 7.2 0 0 1 10.38 4.98L10.71 2.79A9.3 9.3 0 0 1 13.29 2.79L13.62 4.98A7.2 7.2 0 0 1 15.82 5.89L17.6 4.57A9.3 9.3 0 0 1 19.43 6.4L18.11 8.18A7.2 7.2 0 0 1 19.02 10.38Z"/><circle cx="12" cy="12" r="3"/>';

const ICONS: Record<string, string> = {
  logo: '<circle cx="12" cy="12" r="9"/><path d="M12 17.5v-5.5"/><path d="M12 12c0-2.8 1.8-4.5 4.5-4.5 0 2.8-1.8 4.5-4.5 4.5z"/><path d="M12 13.6c0-2.1-1.4-3.4-3.5-3.4 0 2.1 1.4 3.4 3.5 3.4z"/>',
  // transport
  play: '<path d="M7.5 5v14l11-7z"/>',
  pause: '<rect x="6.5" y="5" width="3.5" height="14" rx=".8"/><rect x="14" y="5" width="3.5" height="14" rx=".8"/>',
  step: '<path d="M6.5 5.5v13l9-6.5z"/><path d="M18.5 5.5v13"/>',
  slower: '<path d="M11.5 7l-5 5 5 5M18 7l-5 5 5 5"/>',
  faster: '<path d="M12.5 7l5 5-5 5M6 7l5 5-5 5"/>',
  // tools
  inspect: '<path d="M5 4.5l14.5 6-6.3 1.9-2 6.6z"/>',
  spawn: `${PERSON}<path d="M18.5 8v6M15.5 11h6"/>`,
  remove: `${PERSON}<path d="M15.5 11h6"/>`,
  food: APPLE,
  nofood: `${APPLE}<path d="M4 4l16 16"/>`,
  sprout: '<path d="M12 20.5v-8"/><path d="M12 12.5c0-4 2.7-6.5 7-6.5 0 4-2.7 6.5-7 6.5z"/><path d="M12 15c0-3-2-5-5.5-5 0 3 2 5 5.5 5z"/><path d="M8 20.5h8"/>',
  terrain: '<path d="M2.5 19.5l7-11.5 4.2 6.6 2.6-3.6 5.2 8.5z"/>',
  bolt: '<path d="M13 2.8L4.8 13.4h6.4l-.9 7.8 8.2-10.6h-6.4z"/>',
  hand: '<path d="M8 13.5V6.6a1.3 1.3 0 0 1 2.6 0V11"/><path d="M10.6 11V4.9a1.3 1.3 0 0 1 2.6 0V11"/><path d="M13.2 11V5.9a1.3 1.3 0 0 1 2.6 0V11"/><path d="M15.8 11V8.1a1.3 1.3 0 0 1 2.6 0v5.4c0 4-2.6 6.9-6.4 6.9-2.6 0-4.1-1.1-5.4-3.1L4.4 13.7a1.3 1.3 0 0 1 2.2-1.4L8 14"/>',
  brush: '<path d="M18.5 3.5l2 2-8.2 8.2-2-2z"/><path d="M10.3 11.7c-2.2-.3-4 1.2-4.2 3.4-.2 1.8-1 3-2.6 3.6 3.4 1.6 7.8.6 8.8-2.8.3-1.1 0-2.6-2-4.2z"/>',
  // people and society
  person: '<circle cx="12" cy="7.5" r="3.5"/><path d="M5.5 20c.7-3.8 3.3-6 6.5-6s5.8 2.2 6.5 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.8 19.5c.6-3.4 3-5.5 6.2-5.5s5.6 2.1 6.2 5.5"/><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4"/><path d="M18 14.4c1.8.7 3 2.4 3.3 5.1"/>',
  flag: '<path d="M5.5 21V3.5"/><path d="M5.5 4.5c3.8-1.8 6.2 1.8 10.5 0v8.5c-4.3 1.8-6.7-1.8-10.5 0"/>',
  camp: '<path d="M3.5 19.5h17"/><path d="M5.5 19.5L12 6.5l6.5 13"/><path d="M12 6.5L10.3 3.8M12 6.5l1.7-2.7"/><path d="M9.8 19.5L12 15l2.2 4.5"/>',
  swords: '<path d="M14 17.2L3.5 6.7V3.5h3.2L17.2 14"/><path d="M12.8 18.8l6-6M15.9 15.9l3.8 3.8M18.6 20.9l2.3-2.3"/><path d="M14.6 6.6l2.9-3.1h3v3l-3 2.9"/><path d="M5.2 13.2l5.6 5.6M7.6 16.4l-3.5 3.5M3.1 18.6l2.3 2.3"/>',
  network: '<circle cx="6" cy="17.5" r="2.3"/><circle cx="18" cy="17.5" r="2.3"/><circle cx="12" cy="6.5" r="2.3"/><path d="M7.1 15.5l3.8-7M16.9 15.5l-3.8-7M8.3 17.5h7.4"/>',
  heart: '<path d="M12 19.5s-7.5-4.4-7.5-10A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7.5 2.5c0 5.6-7.5 10-7.5 10z"/>',
  dna: '<path d="M7.5 3c0 4.5 9 4.5 9 9s-9 4.5-9 9"/><path d="M16.5 3c0 4.5-9 4.5-9 9s9 4.5 9 9"/><path d="M8.6 5h6.8M8.6 10h6.8M8.6 14h6.8M8.6 19h6.8"/>',
  virus: VIRUS,
  skull: '<path d="M12 3.5c-4.4 0-7.5 3-7.5 7 0 2.4 1.1 4.2 3 5.2V19a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-3.3c1.9-1 3-2.8 3-5.2 0-4-3.1-7-7.5-7z"/><circle cx="9.2" cy="11" r="1.6"/><circle cx="14.8" cy="11" r="1.6"/><path d="M10.5 20v-2M13.5 20v-2"/>',
  star: '<path d="M12 3.8L14.29 9.44L20.37 9.88L15.71 13.81L17.17 19.72L12 16.5L6.83 19.72L8.29 13.81L3.63 9.88L9.71 9.44Z"/>',
  // world and time
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A7.8 7.8 0 1 1 9.5 4.5a6.2 6.2 0 0 0 10 10z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.4 3 14.6 0 18M12 3c-3 3.4-3 14.6 0 18"/>',
  map: '<path d="M3.5 6.5l5-2 7 2.5 5-2v13l-5 2-7-2.5-5 2z"/><path d="M8.5 4.5v13M15.5 7v13"/>',
  // disasters (DisasterKind names)
  drought: '<circle cx="12" cy="9.5" r="3.5"/><path d="M12 3v1.2M6 9.5H4.8M19.2 9.5H18M7.6 5.1l.9.9M16.4 5.1l-.9.9"/><path d="M3.5 16.5h17"/><path d="M9 16.5l1.3 2.2-1 1.8M15 16.5l-.8 1.6 1.3 1.9"/>',
  blight: `<path d="M5.5 18.5C5.5 10.5 10 5.5 19 5c-.3 8.8-5 13.5-13.5 13.5z"/><path d="M5.5 18.5L12.5 11.5"/>${dot(14.6, 8.9)}${dot(10.4, 15)}`,
  bloom: '<path d="M12 20.5V13"/><path d="M8 5.5l2 1.8L12 4.5l2 2.8 2-1.8v4a4 4 0 0 1-8 0z"/><path d="M12 17.5c-1.5-2.2-3.6-2.8-5.5-2.6.3 2.1 2.4 3.3 5.5 2.6z"/>',
  plague: VIRUS,
  meteor: '<circle cx="14.5" cy="14.5" r="4.5"/><path d="M11.3 11.3L4.5 4.5M14 9.8L8.6 4.4M9.8 14L4.4 8.6"/>',
  coldsnap: '<path d="M12 3v18M19.79 7.5L4.21 16.5M19.79 16.5L4.21 7.5"/><path d="M14.3 4L12 6.4L9.7 4M9.7 20L12 17.6L14.3 20M20.08 9.99L16.85 9.2L17.78 6.01M3.92 14.01L7.15 14.8L6.22 17.99M6.22 6.01L7.15 9.2L3.92 9.99M17.78 17.99L16.85 14.8L20.08 14.01"/>',
  // app chrome
  layers: '<path d="M12 4.5l8.5 4.5-8.5 4.5L3.5 9z"/><path d="M3.5 14l8.5 4.5 8.5-4.5"/>',
  gear: GEAR,
  help: `<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/>${dot(12, 17)}`,
  info: `<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/>${dot(12, 7.8)}`,
  warning: `<path d="M10.3 4.6L3 17.5a2 2 0 0 0 1.7 3h14.6a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z"/><path d="M12 9.5V14"/>${dot(12, 17)}`,
  panelRight: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M14.5 4.5v15"/>',
  panelLeft: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M9.5 4.5v15"/>',
  zoomIn: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5M10.5 8v5M8 10.5h5"/>',
  zoomOut: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5M8 10.5h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  restart: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>',
  replay: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/><path d="M10.5 9.3v5.4l4.3-2.7z"/>',
  dice: `<rect x="4" y="4" width="16" height="16" rx="2.5"/>${dot(8.5, 8.5, 1.2)}${dot(12, 12, 1.2)}${dot(15.5, 15.5, 1.2)}`,
  save: '<path d="M12 4v10.5M7.5 10L12 14.5 16.5 10"/><path d="M4.5 16v3.5h15V16"/>',
  load: '<path d="M12 14.5V4M7.5 8.5L12 4l4.5 4.5"/><path d="M4.5 16v3.5h15V16"/>',
  chart: '<path d="M4 4v16h16"/><path d="M7.5 15l3.5-4.5 3 2.5 4.5-6"/>',
  list: `<path d="M9 6.5h11M9 12h11M9 17.5h11"/>${dot(5, 6.5)}${dot(5, 12)}${dot(5, 17.5)}`,
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  flask: '<path d="M9.2 3.5h5.6M10.2 3.5v5.8L4.8 18.4a1.7 1.7 0 0 0 1.5 2.6h11.4a1.7 1.7 0 0 0 1.5-2.6l-5.4-9.1V3.5"/><path d="M7.4 14.6h9.2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="1.5"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9.5 2.5v3M14.5 2.5v3M9.5 18.5v3M14.5 18.5v3M2.5 9.5h3M2.5 14.5h3M18.5 9.5h3M18.5 14.5h3"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevron: '<path d="M9.5 6l6 6-6 6"/>',
  chevronLeft: '<path d="M14.5 6l-6 6 6 6"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  chevronUp: '<path d="M6 14.5l6-6 6 6"/>',
};

/** True when `name` is part of the icon set. */
export function hasIcon(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

/** Icon as an inline SVG element; an unknown name gives an empty SVG (never throws). */
export function icon(name: string, size = 16, cls = ''): SVGSVGElement {
  const body = hasIcon(name) ? ICONS[name] : '';
  const px = Number.isFinite(size) && size > 0 ? size : 16;
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg class="ic ${cls}" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

/** Every icon name (for the design check page and tests). */
export const ICON_NAMES: readonly string[] = Object.keys(ICONS);

// ------------------------------------------------------------------ storage (per-viewer conveniences only)
export const store = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem('al:' + key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem('al:' + key, value);
    } catch {
      /* storage unavailable: ignore */
    }
  },
};

// ------------------------------------------------------------------ formatting
export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');
export function fmtNum(v: number, step: number): string {
  const d = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return v.toFixed(d);
}
export const plural = (n: number, one: string, many = one + 's'): string => `${fmtInt(n)} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------ tooltips
/** One floating tooltip for every element with data-tip. Side from nearest [data-tip-side]. */
export function installTooltips(): void {
  const tip = h('div', { class: 'tip', role: 'tooltip' });
  document.body.append(tip);
  let cur: HTMLElement | null = null;
  let timer = 0;
  const hide = () => {
    window.clearTimeout(timer);
    tip.classList.remove('show');
  };
  document.addEventListener('pointerover', (e) => {
    const target = e.target as Element | null;
    const t = (target && typeof target.closest === 'function' ? target.closest('[data-tip]') : null) as HTMLElement | null;
    if (t === cur) return;
    cur = t;
    hide();
    if (!t || !t.dataset.tip) return;
    timer = window.setTimeout(() => {
      if (cur !== t || !t.isConnected || !t.dataset.tip) return;
      tip.textContent = t.dataset.tip;
      tip.style.transform = 'translate(-9999px,-9999px)';
      tip.classList.add('show');
      const r = t.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      const side = t.closest('[data-tip-side]')?.getAttribute('data-tip-side') ?? 'bottom';
      let x: number;
      let y: number;
      if (side === 'right') {
        x = r.right + 8;
        y = r.top + Math.min(r.height, 40) / 2 - tr.height / 2;
      } else if (side === 'left') {
        x = r.left - tr.width - 8;
        y = r.top + Math.min(r.height, 40) / 2 - tr.height / 2;
      } else {
        x = r.left + r.width / 2 - tr.width / 2;
        y = r.bottom + 6;
        if (y + tr.height > window.innerHeight - 6) y = r.top - tr.height - 6;
      }
      x = Math.max(6, Math.min(window.innerWidth - tr.width - 6, x));
      y = Math.max(6, Math.min(window.innerHeight - tr.height - 6, y));
      tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }, 350);
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('wheel', hide, { passive: true, capture: true });
}

// ------------------------------------------------------------------ toasts
export type ToastKind = 'info' | 'good' | 'bad' | 'major' | 'error';
export interface ToastOpts {
  kind?: ToastKind;
  title?: string;
  timeout?: number;
  onClick?: () => void;
}

/** At most one notice at a time: a new one replaces the one on screen. */
export class Toaster {
  readonly el: HTMLElement;
  private cur: HTMLElement | null = null;
  private timer = 0;
  /** performance.now() of the last show(). */
  lastShown = -Infinity;

  constructor(parent: HTMLElement) {
    this.el = h('div', { class: 'toasts', 'aria-live': 'polite' });
    parent.append(this.el);
  }

  get visible(): boolean {
    return this.cur !== null;
  }

  show(message: string, opts: ToastOpts = {}): void {
    const kind = opts.kind ?? 'info';
    this.clear();
    const close = h('button', { type: 'button', class: 'toast-x', 'aria-label': 'Dismiss' }, icon('x', 14));
    const el = h(
      'div',
      { class: `toast toast-${kind}${opts.onClick ? ' clickable' : ''}`, role: kind === 'error' ? 'alert' : 'status' },
      h('div', { class: 'toast-body' }, opts.title ? h('span', { class: 'toast-title' }, opts.title) : null, message ? h('span', { class: 'toast-msg' }, message) : null),
      close,
    );
    const dismiss = () => {
      if (this.cur !== el) return;
      this.clear();
    };
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
    });
    el.addEventListener('click', () => {
      opts.onClick?.();
      dismiss();
    });
    this.el.append(el);
    this.cur = el;
    this.lastShown = performance.now();
    this.timer = window.setTimeout(dismiss, opts.timeout ?? (kind === 'error' ? 8000 : 4000));
  }

  clear(): void {
    window.clearTimeout(this.timer);
    if (this.cur) this.cur.remove();
    this.cur = null;
  }
}

// ------------------------------------------------------------------ controls
export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  help?: string;
  fmt?: (v: number) => string;
  onInput?: (v: number) => void;
  onChange?: (v: number) => void;
  cls?: string;
}
export interface SliderCtl {
  el: HTMLElement;
  input: HTMLInputElement;
  set(v: number): void;
  readonly value: number;
}

export function slider(o: SliderOpts): SliderCtl {
  const fmt = o.fmt ?? ((v: number) => fmtNum(v, o.step));
  const val = h('span', { class: 'ctl-val' });
  const input = h('input', { type: 'range', min: o.min, max: o.max, step: o.step, 'aria-label': o.label });
  input.value = String(o.value);
  const paint = () => {
    const v = Number(input.value);
    val.textContent = fmt(v);
    const p = o.max > o.min ? ((v - o.min) / (o.max - o.min)) * 100 : 0;
    input.style.setProperty('--p', `${p.toFixed(1)}%`);
  };
  input.addEventListener('input', () => {
    paint();
    o.onInput?.(Number(input.value));
  });
  input.addEventListener('change', () => o.onChange?.(Number(input.value)));
  const el = h('div', { class: `ctl ctl-slider ${o.cls ?? ''}`, tip: o.help }, h('div', { class: 'ctl-row' }, h('span', { class: 'ctl-label' }, o.label), val), input);
  paint();
  return {
    el,
    input,
    set(v: number) {
      input.value = String(v);
      paint();
    },
    get value() {
      return Number(input.value);
    },
  };
}

export interface ToggleCtl {
  el: HTMLElement;
  input: HTMLInputElement;
  set(v: boolean): void;
}

export function toggle(o: { label: string; value: boolean; help?: string; onChange: (v: boolean) => void }): ToggleCtl {
  const input = h('input', { type: 'checkbox' });
  input.checked = o.value;
  input.addEventListener('change', () => o.onChange(input.checked));
  const el = h('label', { class: 'ctl ctl-toggle', tip: o.help }, input, h('span', { class: 'box', 'aria-hidden': 'true' }), h('span', { class: 'ctl-label' }, o.label));
  return {
    el,
    input,
    set(v: boolean) {
      input.checked = v;
    },
  };
}

export interface FoldCtl {
  el: HTMLDetailsElement;
  body: HTMLElement;
  open(v?: boolean): void;
}

/** Folded section ("More settings"): closed by default, open state remembered per viewer when `id` is given. */
export function fold(title: string, id?: string, defaultOpen = false): FoldCtl {
  const stored = id ? store.get('fold:' + id) : null;
  const body = h('div', { class: 'fold-body' });
  const el = h('details', { class: 'fold' }, h('summary', { class: 'fold-head' }, h('span', null, title), icon('chevronDown', 14, 'fold-chev')), body);
  el.open = stored === null ? defaultOpen : stored === '1';
  if (id) el.addEventListener('toggle', () => store.set('fold:' + id, el.open ? '1' : '0'));
  return {
    el,
    body,
    open(v = true) {
      el.open = v;
    },
  };
}

export interface ChoiceItem<T> {
  value: T;
  label: string;
  tip?: string;
  /** Icon name from the icon set. */
  icon?: string;
  /** CSS colour of a small square in front of the label. */
  swatch?: string;
  /** Second line under the label. */
  sub?: string;
}

/** Single choice from a few options (role radiogroup). Layout from `cls`: 'chips' (wrapping), 'rows' (one per line), 'rows two' (two columns). */
export function chips<T extends string | number>(items: ChoiceItem<T>[], value: T, onPick: (v: T) => void, cls = ''): { el: HTMLElement; set(v: T): void } {
  const btns = new Map<T, HTMLButtonElement>();
  const el = h('div', { class: `choice ${cls || 'chips'}`, role: 'radiogroup' });
  const set = (v: T) => {
    for (const [k, b] of btns) {
      b.classList.toggle('on', k === v);
      b.setAttribute('aria-checked', String(k === v));
    }
  };
  for (const it of items) {
    const b = h(
      'button',
      { type: 'button', class: 'chip', role: 'radio', tip: it.tip, onclick: () => { set(it.value); onPick(it.value); } },
      it.swatch ? h('span', { class: 'swatch', style: `background:${it.swatch}` }) : null,
      it.icon ? icon(it.icon, 15, 'chip-ic') : null,
      it.sub ? h('span', { class: 'chip-text' }, h('span', { class: 'chip-label' }, it.label), h('span', { class: 'chip-sub' }, it.sub)) : h('span', { class: 'chip-label' }, it.label),
    );
    btns.set(it.value, b);
    el.append(b);
  }
  set(value);
  return { el, set };
}
