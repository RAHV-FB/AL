// OWNER: UI/UX agent. Tiny dependency-free DOM helpers: element factory, icons,
// styled tooltips, toasts, and reusable controls (slider / toggle / section).

export type Child = Node | string | number | null | undefined | false;
export type Props = Record<string, unknown>;

/** Create an element. `tip` → data-tip (styled tooltip), `on<event>` → listener, `html` → innerHTML. */
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

// ------------------------------------------------------------------ icons
const ICONS: Record<string, string> = {
  logo: '<circle cx="12" cy="12" r="9.2"/><circle cx="12" cy="12" r="3.1" fill="currentColor" stroke="none"/><circle cx="6.6" cy="8.6" r="1.35" fill="currentColor" stroke="none"/><circle cx="17.2" cy="15.4" r="1.7" fill="currentColor" stroke="none"/><circle cx="15.8" cy="7" r="1" fill="currentColor" stroke="none"/><path d="M8 9.4l2.2 1.4M14.6 13.6l1.6 1"/>',
  play: '<path d="M7.5 4.8v14.4L19 12z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.8" width="4" height="14.4" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.8" width="4" height="14.4" rx="1" fill="currentColor" stroke="none"/>',
  step: '<path d="M5.5 4.8v14.4L15.5 12z" fill="currentColor" stroke="none"/><rect x="16.6" y="4.8" width="2.8" height="14.4" rx="1" fill="currentColor" stroke="none"/>',
  inspect: '<path d="M5.5 3.5l12.5 7.6-5.6 1.4-2.9 5.9z"/><path d="M12.4 12.5l4.6 6"/>',
  spawn: '<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20c.8-3.6 3.3-5.6 6.2-5.6s5.4 2 6.2 5.6"/><path d="M19 7.5v7M15.5 11h7"/>',
  remove: '<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20c.8-3.6 3.3-5.6 6.2-5.6s5.4 2 6.2 5.6"/><path d="M16.6 8.6l4.8 4.8M21.4 8.6l-4.8 4.8"/>',
  food: '<path d="M12 7.4c-2.6-1.9-7.6-1.3-7.6 4.6 0 4.8 3.3 8.6 5.6 8.6 1 0 1.4-.5 2-.5s1 .5 2 .5c2.3 0 5.6-3.8 5.6-8.6 0-5.9-5-6.5-7.6-4.6z"/><path d="M12 7.4c0-2 .9-3.6 2.9-4.2"/>',
  nofood: '<path d="M12 7.4c-2.6-1.9-7.6-1.3-7.6 4.6 0 4.8 3.3 8.6 5.6 8.6 1 0 1.4-.5 2-.5s1 .5 2 .5c2.3 0 5.6-3.8 5.6-8.6 0-5.9-5-6.5-7.6-4.6z"/><path d="M3.5 3.5l17 17"/>',
  sprout: '<path d="M12 21v-8.5"/><path d="M12 12.5c0-4.2 2.8-6.6 7.5-6.6 0 4.2-2.8 6.6-7.5 6.6z"/><path d="M12 15c0-3.2-2.2-5.2-6.2-5.2 0 3.2 2.2 5.2 6.2 5.2z"/><path d="M7.5 21h9"/>',
  terrain: '<path d="M2.5 19.5l6.8-10.8 4 6.2 2.9-4 5.3 8.6z"/><path d="M8 12.3l1.3 1.3 1.4-1.2"/>',
  bolt: '<path d="M13.2 2.5L4.6 13.6h6.6l-1 7.9 8.6-11.2h-6.6z"/>',
  heart: '<path d="M12 20s-7.2-4.4-7.2-10.1A4.1 4.1 0 0 1 12 7.4a4.1 4.1 0 0 1 7.2 2.5C19.2 15.6 12 20 12 20z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.7.3-1 .9-1 1.7v.4"/><circle cx="12" cy="16.9" r=".7" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.5 1.5M17.9 17.9l1.5 1.5M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.5-1.5M17.9 6.1l1.5-1.5"/>',
  moon: '<path d="M19.5 14.6A7.9 7.9 0 1 1 9.4 4.5a6.3 6.3 0 0 0 10.1 10.1z"/>',
  users: '<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20c.8-3.6 3.3-5.6 6.2-5.6s5.4 2 6.2 5.6"/><path d="M15.8 4.7a3.4 3.4 0 0 1 0 6.6M18 14.8c1.9.7 3.1 2.4 3.4 5.2"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4.5c4-2 6.5 2 11 0v8.5c-4.5 2-7-2-11 0"/>',
  save: '<path d="M12 3.5v11.5M7.4 10.6L12 15.2l4.6-4.6"/><path d="M4 16.5v3.5h16v-3.5"/>',
  load: '<path d="M12 15.2V3.7M7.4 8.3L12 3.7l4.6 4.6"/><path d="M4 16.5v3.5h16v-3.5"/>',
  panelLeft: '<rect x="3" y="4.5" width="18" height="15" rx="2.2"/><path d="M9 4.5v15"/>',
  panelRight: '<rect x="3" y="4.5" width="18" height="15" rx="2.2"/><path d="M15 4.5v15"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  target: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  restart: '<path d="M4.5 12a7.5 7.5 0 1 0 2.3-5.4"/><path d="M4.2 4.2v4.6h4.6"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.2"/><circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  replay: '<path d="M4.5 12a7.5 7.5 0 1 0 2.3-5.4"/><path d="M4.2 4.2v4.6h4.6"/><path d="M10.6 9.3v5.4l4.4-2.7z" fill="currentColor" stroke="none"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.4 3 14.6 0 18M12 3c-3 3.4-3 14.6 0 18"/>',
  eye: '<path d="M2.5 12s3.4-6.6 9.5-6.6 9.5 6.6 9.5 6.6-3.4 6.6-9.5 6.6S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  flask: '<path d="M9.2 3.5h5.6M10.2 3.5v5.8L4.8 18.4a1.7 1.7 0 0 0 1.5 2.6h11.4a1.7 1.7 0 0 0 1.5-2.6l-5.4-9.1V3.5"/><path d="M7.4 14.6h9.2"/>',
  brush: '<path d="M18.5 3.5l2 2-8.2 8.2-2-2z"/><path d="M10.3 11.7c-2.2-.3-4 1.2-4.2 3.4-.2 1.8-1 3-2.6 3.6 3.4 1.6 7.8.6 8.8-2.8.3-1.1 0-2.6-2-4.2z"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M7.5 15.5l3.5-4.5 3 2.5 5-7"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.8" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.8" cy="17.5" r="1.1" fill="currentColor" stroke="none"/>',
  person: '<circle cx="12" cy="7.5" r="3.6"/><path d="M5 20.5c.9-4 3.7-6.2 7-6.2s6.1 2.2 7 6.2"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 2.5v3M14.5 2.5v3M9.5 18.5v3M14.5 18.5v3M2.5 9.5h3M2.5 14.5h3M18.5 9.5h3M18.5 14.5h3"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9"/>',
};

export function icon(name: string, size = 16, cls = ''): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] ?? ''}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

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
      /* storage unavailable — ignore */
    }
  },
};

// ------------------------------------------------------------------ formatting
export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');
export function fmtNum(v: number, step: number): string {
  const d = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return v.toFixed(d);
}

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
        x = r.right + 10;
        y = r.top + Math.min(r.height, 40) / 2 - tr.height / 2;
      } else if (side === 'left') {
        x = r.left - tr.width - 10;
        y = r.top + Math.min(r.height, 40) / 2 - tr.height / 2;
      } else {
        x = r.left + r.width / 2 - tr.width / 2;
        y = r.bottom + 8;
        if (y + tr.height > window.innerHeight - 6) y = r.top - tr.height - 8;
      }
      x = Math.max(6, Math.min(window.innerWidth - tr.width - 6, x));
      y = Math.max(6, Math.min(window.innerHeight - tr.height - 6, y));
      tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }, 320);
  });
  document.addEventListener('pointerdown', () => {
    hide();
  }, true);
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

export class Toaster {
  readonly el: HTMLElement;
  constructor(parent: HTMLElement) {
    this.el = h('div', { class: 'toasts', 'aria-live': 'polite' });
    parent.append(this.el);
  }

  show(message: string, opts: ToastOpts = {}): void {
    const kind = opts.kind ?? 'info';
    const el = h(
      'div',
      { class: `toast toast-${kind}${opts.onClick ? ' clickable' : ''}`, role: kind === 'error' ? 'alert' : 'status' },
      h('span', { class: 'toast-bar' }),
      h('div', { class: 'toast-body' }, opts.title ? h('div', { class: 'toast-title' }, opts.title) : null, h('div', { class: 'toast-msg' }, message)),
    );
    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      el.classList.add('out');
      window.setTimeout(() => el.remove(), 220);
    };
    el.addEventListener('click', () => {
      opts.onClick?.();
      dismiss();
    });
    this.el.append(el);
    while (this.el.children.length > 4) this.el.firstElementChild?.remove();
    window.setTimeout(dismiss, opts.timeout ?? (kind === 'error' ? 7000 : 4600));
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
  const el = h('label', { class: 'ctl ctl-toggle', tip: o.help }, h('span', { class: 'ctl-label' }, o.label), input, h('span', { class: 'switch', 'aria-hidden': 'true' }));
  return {
    el,
    input,
    set(v: boolean) {
      input.checked = v;
    },
  };
}

export interface SectionCtl {
  el: HTMLElement;
  body: HTMLElement;
  head: HTMLButtonElement;
  open(v?: boolean): void;
}

/** Collapsible sidebar section; open state persisted per viewer. */
export function section(id: string, title: string, iconName: string, defaultOpen = true, extra?: Child): SectionCtl {
  const stored = store.get('sec:' + id);
  const isOpen = stored === null ? defaultOpen : stored === '1';
  const body = h('div', { class: 'sec-body' });
  const head = h(
    'button',
    { class: 'sec-head', type: 'button', 'aria-expanded': String(isOpen) },
    icon(iconName, 15, 'sec-ic'),
    h('span', { class: 'sec-title' }, title),
    extra ?? null,
    icon('chevron', 14, 'sec-chev'),
  );
  const el = h('section', { class: 'sec' + (isOpen ? ' open' : ''), id: 'sec-' + id }, head, body);
  const setOpen = (o: boolean) => {
    el.classList.toggle('open', o);
    head.setAttribute('aria-expanded', String(o));
    store.set('sec:' + id, o ? '1' : '0');
  };
  head.addEventListener('click', () => setOpen(!el.classList.contains('open')));
  return { el, body, head, open: (v = true) => setOpen(v) };
}

/** Segmented choice control (chips). */
export function chips<T extends string | number>(
  items: { value: T; label: string; tip?: string; icon?: string; swatch?: string }[],
  value: T,
  onPick: (v: T) => void,
  cls = '',
): { el: HTMLElement; set(v: T): void } {
  const btns = new Map<T, HTMLButtonElement>();
  const el = h('div', { class: `chips ${cls}`, role: 'radiogroup' });
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
      it.icon ? h('span', { class: 'chip-ic' }, it.icon) : null,
      h('span', null, it.label),
    );
    btns.set(it.value, b);
    el.append(b);
  }
  set(value);
  return { el, set };
}
