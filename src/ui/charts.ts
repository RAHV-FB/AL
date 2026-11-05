/**
 * Dependency-free Canvas2D chart toolkit (OWNER: Analytics).
 *
 * - DPR-aware, themed from CSS variables (dark by default), recessive grid/axes.
 * - Two stacked canvases per chart: the data layer is redrawn only when data
 *   changes (setData with a new key) or on resize; the hover layer (crosshair,
 *   markers) + an HTML tooltip redraw on pointer move only.
 * - Hidden charts (zero size) skip drawing and repaint when they become visible.
 *
 * Charts: LineChart (multi-series, optional ±band / area fill / reference lines),
 * StackedAreaChart, BarChart (vertical histogram or horizontal ranked bars),
 * Heatmap (x = time, y = value bins, colour = density) and Sparkline.
 */

export interface ChartTheme {
  panel: string;
  text: string;
  muted: string;
  grid: string;
  axis: string;
  accent: string;
  font: string;
}

/** Validated categorical slots (dark-surface steps), used in fixed order. */
export const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
/** Sequential ramp for densities on a dark surface: near-zero recedes into the panel. */
export const HEAT_RAMP = ['#0b1220', '#123058', '#1c5cab', '#3987e5', '#86b6ef', '#e8f1fd'];

const FONT = '10px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

export function readTheme(el: Element): ChartTheme {
  const cs = getComputedStyle(el);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    panel: v('--panel', '#0f1626'),
    text: v('--text', '#d7e3f4'),
    muted: v('--muted', '#8495ad'),
    grid: 'rgba(148,163,184,0.13)',
    axis: 'rgba(148,163,184,0.45)',
    accent: v('--accent', '#3987e5'),
    font: FONT,
  };
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Compact number formatting: 1234 → 1.2k, 0.123 → 0.12. */
export function formatNum(v: number): string {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(0) + 'k';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  if (Number.isInteger(v)) return String(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2).replace(/\.?0+$/, '') || '0';
}

export function formatPct(v: number): string {
  return Number.isFinite(v) ? `${Math.round(v * 100)}%` : '–';
}

/** A "nice" step (1, 2, 2.5, 5 × 10^k) splitting `range` into about `target` intervals. */
export function niceStep(range: number, target: number): number {
  if (!(range > 0)) return 1;
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 2.25 ? 2 : norm < 3.5 ? 2.5 : norm < 7.5 ? 5 : 10;
  return step * mag;
}

/** Nice ticks covering [min,max]. With `extend`, the domain is widened to the outer ticks. */
export function niceTicks(min: number, max: number, target = 4, extend = true): { min: number; max: number; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (max <= min) max = min + (Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1);
  const step = niceStep(max - min, target);
  const lo = extend ? Math.floor(min / step + 1e-9) * step : Math.ceil(min / step - 1e-9) * step;
  const hi = extend ? Math.ceil(max / step - 1e-9) * step : Math.floor(max / step + 1e-9) * step;
  const ticks: number[] = [];
  const dec = Math.max(0, -Math.floor(Math.log10(step)) + 2);
  for (let v = lo, i = 0; v <= hi + step * 1e-6 && i < 50; v = lo + ++i * step) ticks.push(Number(v.toFixed(dec)));
  return extend ? { min: lo, max: hi, ticks } : { min, max, ticks };
}

/** Index of the element in ascending `xs` nearest to v. */
export function nearestIndex(xs: ArrayLike<number>, v: number): number {
  const n = xs.length;
  if (n === 0) return -1;
  let lo = 0;
  let hi = n - 1;
  if (v <= xs[0]) return 0;
  if (v >= xs[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < v) lo = mid;
    else hi = mid;
  }
  return v - xs[lo] <= xs[hi] - v ? lo : hi;
}

/** First index with xs[i] >= v (n when none). */
function lowerBound(xs: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(f, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 256-entry RGB lookup table interpolated through `stops`. */
export function makeRamp(stops: string[]): Uint8ClampedArray {
  const rgb = stops.map(hexToRgb);
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (rgb.length - 1);
    const k = Math.min(rgb.length - 2, Math.floor(t));
    const f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = rgb[k][c] + (rgb[k + 1][c] - rgb[k][c]) * f;
  }
  return lut;
}

// ------------------------------------------------------------------ shared resize observer

const sizeCallbacks = new WeakMap<Element, (w: number, h: number) => void>();
let sharedRO: ResizeObserver | null = null;
function observeSize(el: Element, cb: (w: number, h: number) => void): void {
  if (typeof ResizeObserver === 'undefined') {
    const r = el.getBoundingClientRect();
    cb(r.width, r.height);
    return;
  }
  sharedRO ??= new ResizeObserver((entries) => {
    for (const e of entries) sizeCallbacks.get(e.target)?.(e.contentRect.width, e.contentRect.height);
  });
  sizeCallbacks.set(el, cb);
  sharedRO.observe(el);
}
function unobserveSize(el: Element): void {
  sizeCallbacks.delete(el);
  sharedRO?.unobserve(el);
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ------------------------------------------------------------------ base

export interface BaseOptions {
  /** CSS height in px (default 140). */
  height?: number;
  ariaLabel?: string;
  /** Text shown when there is no data. */
  emptyText?: string;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

abstract class CanvasChart<D, O extends BaseOptions> {
  readonly el: HTMLDivElement;
  protected readonly canvas: HTMLCanvasElement;
  protected readonly overlay: HTMLCanvasElement;
  protected readonly tip: HTMLDivElement;
  protected opts: O;
  protected data: D | null = null;
  protected theme: ChartTheme | null = null;
  protected cw = 0;
  protected ch = 0;
  protected dpr = 1;
  protected hoverPt: { x: number; y: number } | null = null;
  private key: unknown = undefined;
  private dirty = true;

  constructor(parent: HTMLElement, opts: O) {
    this.opts = opts;
    const el = document.createElement('div');
    el.className = 'an-chart';
    el.style.height = `${opts.height ?? 140}px`;
    if (opts.ariaLabel) {
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', opts.ariaLabel);
    }
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'an-chart-base';
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'an-chart-overlay';
    this.tip = document.createElement('div');
    this.tip.className = 'an-tip';
    this.tip.hidden = true;
    el.append(this.canvas, this.overlay, this.tip);
    parent.appendChild(el);
    this.el = el;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.hoverPt = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.drawOverlay();
    });
    el.addEventListener('pointerleave', () => {
      this.hoverPt = null;
      this.drawOverlay();
    });
    observeSize(el, (w, h) => this.setSize(w, h));
  }

  /** Replace the data. When `key` equals the previous key, nothing is redrawn. */
  setData(data: D, key?: unknown): void {
    if (key !== undefined && key === this.key && this.data !== null) return;
    this.key = key;
    this.data = data;
    this.dirty = true;
    this.paint();
  }

  /** Merge option changes (applied on the next data change or invalidate()). */
  setOptions(patch: Partial<O>): void {
    this.opts = { ...this.opts, ...patch };
  }

  /** Force a redraw on the next paint (e.g. theme change). */
  invalidate(): void {
    this.dirty = true;
    this.paint();
  }

  destroy(): void {
    unobserveSize(this.el);
    this.el.remove();
  }

  private setSize(w: number, h: number): void {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    w = Math.floor(w);
    h = Math.floor(h);
    if (w === this.cw && h === this.ch && dpr === this.dpr) return;
    this.cw = w;
    this.ch = h;
    this.dpr = dpr;
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
    }
    this.dirty = true;
    this.paint();
  }

  protected paint(): void {
    if (this.cw < 8 || this.ch < 8) return; // hidden: stay dirty until visible
    if (this.dirty) {
      const ctx = this.canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.cw, this.ch);
      const th = (this.theme = readTheme(this.el));
      ctx.font = th.font;
      if (this.data !== null && !this.isEmpty(this.data)) this.drawBase(ctx, this.cw, this.ch, th, this.data);
      else {
        ctx.fillStyle = th.muted;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.opts.emptyText ?? 'Waiting for data…', this.cw / 2, this.ch / 2);
      }
      this.dirty = false;
    }
    this.drawOverlay();
  }

  protected drawOverlay(): void {
    const ctx = this.overlay.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    const th = this.theme;
    if (!this.hoverPt || this.data === null || !th || this.cw < 8 || this.isEmpty(this.data)) {
      this.tip.hidden = true;
      return;
    }
    ctx.font = th.font;
    const html = this.drawHover(ctx, this.hoverPt.x, this.hoverPt.y, th, this.data);
    if (!html) {
      this.tip.hidden = true;
      return;
    }
    this.tip.innerHTML = html;
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth;
    const tH = this.tip.offsetHeight;
    let x = this.hoverPt.x + 14;
    if (x + tw > this.cw) x = this.hoverPt.x - 14 - tw;
    x = Math.max(0, Math.min(x, this.cw - tw));
    let y = this.hoverPt.y - tH - 10;
    if (y < 0) y = Math.min(this.ch - tH, this.hoverPt.y + 14);
    this.tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.max(0, y))}px)`;
  }

  protected isEmpty(data: D): boolean {
    void data;
    return false;
  }

  protected abstract drawBase(ctx: CanvasRenderingContext2D, w: number, h: number, th: ChartTheme, data: D): void;
  /** Draw hover marks on the overlay; return tooltip HTML (or null for none). */
  protected abstract drawHover(ctx: CanvasRenderingContext2D, x: number, y: number, th: ChartTheme, data: D): string | null;
}

function tipRow(color: string | null, name: string, value: string, strong = false): string {
  const sw = color ? `<i style="background:${color}"></i>` : '<i class="an-tip-nosw"></i>';
  return `<div class="an-tip-r${strong ? ' an-tip-strong' : ''}">${sw}<span>${esc(name)}</span><b>${esc(value)}</b></div>`;
}

// ------------------------------------------------------------------ XY base

export interface XYOptions extends BaseOptions {
  /** Fixed y-domain bounds (auto when undefined). */
  yMin?: number;
  yMax?: number;
  /** Include zero in the auto y-domain (default true). */
  yZero?: boolean;
  yFormat?: (v: number) => string;
  /** x tick labels. */
  xFormat?: (v: number) => string;
  /** Tooltip header for an x value (default xFormat). */
  xHoverFormat?: (v: number) => string;
  /** Horizontal reference lines (e.g. a population cap). */
  refLines?: { y: number; label: string }[];
  yTicks?: number;
}

interface Frame extends Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

abstract class XYChart<D extends { x: ArrayLike<number> }> extends CanvasChart<D, XYOptions> {
  protected frame: Frame | null = null;

  protected override isEmpty(data: D): boolean {
    return data.x.length === 0;
  }

  protected sx(v: number): number {
    const f = this.frame!;
    return f.x + ((v - f.x0) / (f.x1 - f.x0)) * f.w;
  }

  protected sy(v: number): number {
    const f = this.frame!;
    return f.y + f.h - ((v - f.y0) / (f.y1 - f.y0)) * f.h;
  }

  /** Compute the frame for a y-range and draw grid, axes and labels. */
  protected layoutAxes(ctx: CanvasRenderingContext2D, w: number, h: number, th: ChartTheme, xs: ArrayLike<number>, lo: number, hi: number): Frame {
    const o = this.opts;
    if (o.yZero !== false) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    if (o.refLines && o.yMax === undefined) for (const r of o.refLines) hi = Math.max(hi, r.y);
    if (o.yMin !== undefined) lo = o.yMin;
    if (o.yMax !== undefined) hi = Math.max(o.yMax, o.yMin !== undefined ? o.yMin + 1e-9 : hi);
    const fixed = o.yMin !== undefined && o.yMax !== undefined;
    const target = o.yTicks ?? Math.max(2, Math.min(5, Math.floor(h / 32)));
    const yt = niceTicks(lo, hi, target, !fixed);
    const yFmt = o.yFormat ?? formatNum;
    let labelW = 0;
    for (const t of yt.ticks) labelW = Math.max(labelW, ctx.measureText(yFmt(t)).width);
    const x0 = xs[0];
    let x1 = xs[xs.length - 1];
    if (!(x1 > x0)) x1 = x0 + 1;
    const f: Frame = { x: Math.ceil(labelW) + 8, y: 6, w: 0, h: 0, x0, x1, y0: yt.min, y1: yt.max };
    f.w = Math.max(10, w - f.x - 8);
    f.h = Math.max(10, h - f.y - 18);
    this.frame = f;

    // grid + y labels
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of yt.ticks) {
      if (t < f.y0 - 1e-9 || t > f.y1 + 1e-9) continue;
      const y = Math.round(this.sy(t)) + 0.5;
      ctx.strokeStyle = t === 0 ? th.axis : th.grid;
      ctx.beginPath();
      ctx.moveTo(f.x, y);
      ctx.lineTo(f.x + f.w, y);
      ctx.stroke();
      ctx.fillStyle = th.muted;
      ctx.fillText(yFmt(t), f.x - 5, y);
    }
    // x labels
    const xt = niceTicks(f.x0, f.x1, Math.max(2, Math.floor(f.w / 70)), false);
    const xFmt = o.xFormat ?? formatNum;
    ctx.textBaseline = 'top';
    ctx.fillStyle = th.muted;
    let lastRight = -Infinity;
    for (const t of xt.ticks) {
      const x = this.sx(t);
      const label = xFmt(t);
      const lw = ctx.measureText(label).width;
      let lx = x - lw / 2;
      lx = Math.max(f.x - 2, Math.min(lx, f.x + f.w - lw + 2));
      if (lx < lastRight + 6) continue;
      ctx.textAlign = 'left';
      ctx.fillText(label, lx, f.y + f.h + 5);
      lastRight = lx + lw;
      ctx.strokeStyle = th.axis;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, f.y + f.h);
      ctx.lineTo(Math.round(x) + 0.5, f.y + f.h + 3);
      ctx.stroke();
    }
    // baseline
    ctx.strokeStyle = th.axis;
    ctx.beginPath();
    ctx.moveTo(f.x, Math.round(f.y + f.h) + 0.5);
    ctx.lineTo(f.x + f.w, Math.round(f.y + f.h) + 0.5);
    ctx.stroke();
    // reference lines
    if (o.refLines) {
      for (const r of o.refLines) {
        if (r.y < f.y0 || r.y > f.y1) continue;
        const y = Math.round(this.sy(r.y)) + 0.5;
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = th.axis;
        ctx.beginPath();
        ctx.moveTo(f.x, y);
        ctx.lineTo(f.x + f.w, y);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = th.muted;
        ctx.textAlign = 'right';
        const below = y - f.y < 12; // too close to the top edge: label under the line
        ctx.textBaseline = below ? 'top' : 'bottom';
        ctx.fillText(r.label, f.x + f.w - 2, below ? y + 2 : y - 2);
      }
    }
    return f;
  }

  /** Trace a polyline through (xs, ys), min/max-decimated per pixel column when dense. NaN breaks the line. */
  protected trace(ctx: CanvasRenderingContext2D, xs: ArrayLike<number>, ys: ArrayLike<number>): void {
    const n = Math.min(xs.length, ys.length);
    const f = this.frame!;
    let started = false;
    if (n <= f.w * 1.5) {
      for (let i = 0; i < n; i++) {
        const v = ys[i];
        if (!Number.isFinite(v)) {
          started = false;
          continue;
        }
        const X = this.sx(xs[i]);
        const Y = this.sy(v);
        if (started) ctx.lineTo(X, Y);
        else ctx.moveTo(X, Y);
        started = true;
      }
      return;
    }
    let col = NaN;
    let mn = 0;
    let mx = 0;
    let first = 0;
    let last = 0;
    const flush = () => {
      if (Number.isNaN(col)) return;
      const X = col + 0.5;
      if (started) ctx.lineTo(X, this.sy(first));
      else ctx.moveTo(X, this.sy(first));
      started = true;
      if (mx !== mn) {
        ctx.lineTo(X, this.sy(mn));
        ctx.lineTo(X, this.sy(mx));
      }
      ctx.lineTo(X, this.sy(last));
    };
    for (let i = 0; i < n; i++) {
      const v = ys[i];
      if (!Number.isFinite(v)) continue;
      const px = Math.floor(this.sx(xs[i]));
      if (px !== col) {
        flush();
        col = px;
        mn = mx = first = last = v;
      } else {
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        last = v;
      }
    }
    flush();
  }

  protected crosshair(ctx: CanvasRenderingContext2D, th: ChartTheme, X: number): void {
    const f = this.frame!;
    ctx.strokeStyle = th.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(X) + 0.5, f.y);
    ctx.lineTo(Math.round(X) + 0.5, f.y + f.h);
    ctx.stroke();
  }

  protected marker(ctx: CanvasRenderingContext2D, th: ChartTheme, X: number, Y: number, color: string): void {
    ctx.beginPath();
    ctx.arc(X, Y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = th.panel;
    ctx.stroke();
  }

  /** Index under the pointer, or -1 when outside the frame. */
  protected hoverIndex(xs: ArrayLike<number>, x: number, y: number): number {
    const f = this.frame;
    if (!f || x < f.x - 6 || x > f.x + f.w + 6 || y < 0 || y > f.y + f.h + 16) return -1;
    const v = f.x0 + ((x - f.x) / f.w) * (f.x1 - f.x0);
    return nearestIndex(xs, v);
  }

  protected header(v: number): string {
    const fmt = this.opts.xHoverFormat ?? this.opts.xFormat ?? formatNum;
    return `<div class="an-tip-h">${esc(fmt(v))}</div>`;
  }
}

// ------------------------------------------------------------------ line chart

export interface LineSeries {
  name: string;
  color: string;
  values: ArrayLike<number>;
  width?: number;
  dash?: number[];
  /** Fill the area under the line (soft). */
  fill?: boolean;
  /** Shaded band (e.g. mean ± std). */
  band?: { lo: ArrayLike<number>; hi: ArrayLike<number> };
  format?: (v: number) => string;
}

export interface LineData {
  x: ArrayLike<number>;
  series: LineSeries[];
}

export class LineChart extends XYChart<LineData> {
  constructor(parent: HTMLElement, opts: XYOptions = {}) {
    super(parent, opts);
  }

  protected drawBase(ctx: CanvasRenderingContext2D, w: number, h: number, th: ChartTheme, d: LineData): void {
    let lo = Infinity;
    let hi = -Infinity;
    const scan = (a: ArrayLike<number>) => {
      for (let i = 0; i < a.length; i++) {
        const v = a[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    };
    for (const s of d.series) {
      scan(s.values);
      if (s.band) {
        scan(s.band.lo);
        scan(s.band.hi);
      }
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    const f = this.layoutAxes(ctx, w, h, th, d.x, lo, hi);
    ctx.save();
    ctx.beginPath();
    ctx.rect(f.x, f.y - 2, f.w, f.h + 4);
    ctx.clip();
    const n = d.x.length;
    for (const s of d.series) {
      if (s.band && n > 0) {
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const X = this.sx(d.x[i]);
          const Y = this.sy(s.band.hi[i]);
          if (i === 0) ctx.moveTo(X, Y);
          else ctx.lineTo(X, Y);
        }
        for (let i = n - 1; i >= 0; i--) ctx.lineTo(this.sx(d.x[i]), this.sy(s.band.lo[i]));
        ctx.closePath();
        ctx.globalAlpha = 0.2;
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (s.fill && n > 1) {
        ctx.beginPath();
        this.trace(ctx, d.x, s.values);
        ctx.lineTo(this.sx(d.x[n - 1]), this.sy(Math.max(f.y0, 0)));
        ctx.lineTo(this.sx(d.x[0]), this.sy(Math.max(f.y0, 0)));
        ctx.closePath();
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of d.series) {
      ctx.beginPath();
      if (n === 1) {
        ctx.arc(this.sx(d.x[0]), this.sy(s.values[0]), 2.5, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        continue;
      }
      this.trace(ctx, d.x, s.values);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width ?? 1.75;
      ctx.setLineDash(s.dash ?? []);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  protected drawHover(ctx: CanvasRenderingContext2D, x: number, y: number, th: ChartTheme, d: LineData): string | null {
    const i = this.hoverIndex(d.x, x, y);
    if (i < 0) return null;
    const X = this.sx(d.x[i]);
    this.crosshair(ctx, th, X);
    let html = this.header(d.x[i]);
    const yFmt = this.opts.yFormat ?? formatNum;
    for (const s of d.series) {
      const v = s.values[i];
      if (!Number.isFinite(v)) continue;
      this.marker(ctx, th, X, this.sy(v), s.color);
      let val = (s.format ?? yFmt)(v);
      if (s.band) val += ` ± ${(s.format ?? yFmt)((s.band.hi[i] - s.band.lo[i]) / 2)}`;
      html += tipRow(s.color, s.name, val);
    }
    return html;
  }
}

// ------------------------------------------------------------------ stacked area

export interface StackSeries {
  name: string;
  color: string;
  values: ArrayLike<number>;
}

export interface StackData {
  x: ArrayLike<number>;
  /** Bottom → top. */
  series: StackSeries[];
  totalLabel?: string;
}

export class StackedAreaChart extends XYChart<StackData> {
  private cum: Float64Array[] = [];

  constructor(parent: HTMLElement, opts: XYOptions = {}) {
    super(parent, opts);
  }

  protected drawBase(ctx: CanvasRenderingContext2D, w: number, h: number, th: ChartTheme, d: StackData): void {
    const n = d.x.length;
    const cum: Float64Array[] = [];
    let prev = new Float64Array(n);
    let hi = 0;
    for (const s of d.series) {
      const c = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        c[i] = prev[i] + (v > 0 ? v : 0);
        if (c[i] > hi) hi = c[i];
      }
      cum.push(c);
      prev = c;
    }
    this.cum = cum;
    const f = this.layoutAxes(ctx, w, h, th, d.x, 0, hi > 0 ? hi : 1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(f.x, f.y, f.w, f.h);
    ctx.clip();
    const base = new Float64Array(n);
    for (let k = 0; k < cum.length; k++) {
      const top = cum[k];
      const bot = k > 0 ? cum[k - 1] : base;
      ctx.beginPath();
      if (n === 1) {
        const X = this.sx(d.x[0]);
        ctx.rect(X - 2, this.sy(top[0]), 4, this.sy(bot[0]) - this.sy(top[0]));
      } else {
        for (let i = 0; i < n; i++) {
          const X = this.sx(d.x[i]);
          if (i === 0) ctx.moveTo(X, this.sy(top[i]));
          else ctx.lineTo(X, this.sy(top[i]));
        }
        for (let i = n - 1; i >= 0; i--) ctx.lineTo(this.sx(d.x[i]), this.sy(bot[i]));
        ctx.closePath();
      }
      ctx.fillStyle = d.series[k].color;
      ctx.fill();
    }
    // 1px surface separators between layers
    if (n > 1) {
      ctx.strokeStyle = th.panel;
      ctx.lineWidth = 1;
      for (let k = 0; k < cum.length - 1; k++) {
        ctx.beginPath();
        this.trace(ctx, d.x, cum[k]);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  protected drawHover(ctx: CanvasRenderingContext2D, x: number, y: number, th: ChartTheme, d: StackData): string | null {
    const i = this.hoverIndex(d.x, x, y);
    if (i < 0 || !this.cum.length) return null;
    const X = this.sx(d.x[i]);
    this.crosshair(ctx, th, X);
    const yFmt = this.opts.yFormat ?? formatNum;
    let html = this.header(d.x[i]);
    let total = 0;
    for (let k = d.series.length - 1; k >= 0; k--) {
      const v = d.series[k].values[i];
      if (!(v > 0)) continue;
      total += v;
      this.marker(ctx, th, X, this.sy(this.cum[k][i]), d.series[k].color);
      html += tipRow(d.series[k].color, d.series[k].name, yFmt(v));
    }
    html += tipRow(null, d.totalLabel ?? 'Total', yFmt(total), true);
    return html;
  }
}

// ------------------------------------------------------------------ bars

export interface BarDatum {
  label: string;
  value: number;
  color?: string;
  /** Extra tooltip line. */
  note?: string;
}

export interface BarData {
  bars: BarDatum[];
}

export interface BarOptions extends BaseOptions {
  orientation?: 'vertical' | 'horizontal';
  color?: string;
  valueFormat?: (v: number) => string;
  /** Show every k-th category label on the vertical axis (auto when omitted). */
  labelEvery?: number;
  /** Tooltip header for a bar (default its label). */
  tipHeader?: (d: BarDatum, i: number) => string;
  /** Show percentages of the total in the tooltip. */
  showShare?: boolean;
}

export class BarChart extends CanvasChart<BarData, BarOptions> {
  private rects: Rect[] = [];

  constructor(parent: HTMLElement, opts: BarOptions = {}) {
    super(parent, opts);
  }

  protected override isEmpty(d: BarData): boolean {
    return d.bars.length === 0;
  }

  protected drawBase(ctx: CanvasRenderingContext2D, w: number, h: number, th: ChartTheme, d: BarData): void {
    const o = this.opts;
    const fmt = o.valueFormat ?? formatNum;
    const color = o.color ?? th.accent;
    const bars = d.bars;
    const n = bars.length;
    let max = 0;
    for (const b of bars) if (b.value > max) max = b.value;
    this.rects = [];
    if (o.orientation === 'horizontal') {
      let labelW = 0;
      let valW = 0;
      for (const b of bars) {
        labelW = Math.max(labelW, ctx.measureText(b.label).width);
        valW = Math.max(valW, ctx.measureText(fmt(b.value)).width);
      }
      const x0 = Math.ceil(labelW) + 8;
      const maxW = Math.max(10, w - x0 - valW - 10);
      const rowH = Math.min(18, h / Math.max(1, n));
      const barH = Math.max(3, rowH - 5);
      ctx.textBaseline = 'middle';
      for (let i = 0; i < n; i++) {
        const b = bars[i];
        const cy = i * rowH + rowH / 2;
        const bw = max > 0 ? Math.max(b.value > 0 ? 2 : 0, (b.value / max) * maxW) : 0;
        ctx.fillStyle = th.muted;
        ctx.textAlign = 'right';
        ctx.fillText(b.label, x0 - 6, cy);
        ctx.fillStyle = b.color ?? color;
        if (bw > 0) {
          roundRectPath(ctx, x0, cy - barH / 2, bw, barH, 2);
          ctx.fill();
        }
        ctx.fillStyle = th.text;
        ctx.textAlign = 'left';
        ctx.fillText(fmt(b.value), x0 + bw + 4, cy);
        this.rects.push({ x: 0, y: cy - rowH / 2, w, h: rowH });
      }
      return;
    }
    // vertical
    const yt = niceTicks(0, max > 0 ? max : 1, Math.max(2, Math.min(4, Math.floor(h / 34))));
    let labelW = 0;
    for (const t of yt.ticks) labelW = Math.max(labelW, ctx.measureText(fmt(t)).width);
    const fx = Math.ceil(labelW) + 8;
    const fy = 6;
    const fw = Math.max(10, w - fx - 6);
    const fh = Math.max(10, h - fy - 18);
    const sy = (v: number) => fy + fh - (v / yt.max) * fh;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of yt.ticks) {
      const y = Math.round(sy(t)) + 0.5;
      ctx.strokeStyle = t === 0 ? th.axis : th.grid;
      ctx.beginPath();
      ctx.moveTo(fx, y);
      ctx.lineTo(fx + fw, y);
      ctx.stroke();
      ctx.fillStyle = th.muted;
      ctx.fillText(fmt(t), fx - 5, y);
    }
    const slot = fw / Math.max(1, n);
    const gap = Math.min(2, slot * 0.2);
    const every = o.labelEvery ?? Math.max(1, Math.ceil(n / Math.max(1, Math.floor(fw / 30))));
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const x = fx + i * slot + gap / 2;
      const top = sy(Math.max(0, b.value));
      const bh = fy + fh - top;
      ctx.fillStyle = b.color ?? color;
      if (bh > 0.5) {
        // rounded top, square base: draw a taller rounded rect and clip at the baseline
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, fy - 2, slot, fh + 2);
        ctx.clip();
        roundRectPath(ctx, x, top, Math.max(1, slot - gap), bh + 3, 2);
        ctx.fill();
        ctx.restore();
      }
      if (i % every === 0) {
        ctx.fillStyle = th.muted;
        ctx.fillText(b.label, x + (slot - gap) / 2, fy + fh + 5);
      }
      this.rects.push({ x: fx + i * slot, y: fy, w: slot, h: fh + 16 });
    }
  }

  protected drawHover(ctx: CanvasRenderingContext2D, x: number, y: number, th: ChartTheme, d: BarData): string | null {
    let idx = -1;
    for (let i = 0; i < this.rects.length; i++) {
      const r = this.rects[i];
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
        idx = i;
        break;
      }
    }
    if (idx < 0 || idx >= d.bars.length) return null;
    const r = this.rects[idx];
    ctx.fillStyle = 'rgba(148,163,184,0.10)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    void th;
    const b = d.bars[idx];
    const fmt = this.opts.valueFormat ?? formatNum;
    let total = 0;
    for (const bb of d.bars) total += bb.value > 0 ? bb.value : 0;
    const head = this.opts.tipHeader ? this.opts.tipHeader(b, idx) : b.label;
    let html = `<div class="an-tip-h">${esc(head)}</div>` + tipRow(b.color ?? this.opts.color ?? th.accent, 'Count', fmt(b.value));
    if (this.opts.showShare && total > 0) html += tipRow(null, 'Share', formatPct(b.value / total));
    if (b.note) html += `<div class="an-tip-note">${esc(b.note)}</div>`;
    return html;
  }
}

// ------------------------------------------------------------------ heatmap

export interface HeatmapData {
  /** Column end positions (ascending), e.g. sample times in days. */
  x: ArrayLike<number>;
  rows: number;
  /** Column-major values: values[col * rows + row] (row 0 = bottom). Shown as density. */
  values: ArrayLike<number>;
  /** Optional overlay line in y-domain units (0..1), e.g. the gene mean. */
  overlay?: ArrayLike<number>;
  overlayLabel?: string;
  /** Tooltip label for a row. */
  rowLabel?: (row: number) => string;
  /** Tooltip label for a cell value. */
  valueLabel?: (v: number) => string;
}

export interface HeatmapOptions extends XYOptions {
  ramp?: string[];
  /** 'column' (default) normalises each column to its max, emphasising the distribution's shape. */
  normalize?: 'column' | 'global';
}

export class Heatmap extends XYChart<HeatmapData> {
  private lut: Uint8ClampedArray;
  private off: HTMLCanvasElement | null = null;
  private hopts: HeatmapOptions;

  constructor(parent: HTMLElement, opts: HeatmapOptions = {}) {
    super(parent, { yMin: 0, yMax: 1, yZero: false, ...opts });
    this.hopts = opts;
    this.lut = makeRamp(opts.ramp ?? HEAT_RAMP);
  }

  protected drawBase(ctx: CanvasRenderingContext2D, w: number, h: number, th: ChartTheme, d: HeatmapData): void {
    const f = this.layoutAxes(ctx, w, h, th, d.x, 0, 1);
    const n = d.x.length;
    const rows = Math.max(1, d.rows);
    // per-column (or global) maxima
    const colMax = new Float64Array(n);
    let gMax = 0;
    for (let c = 0; c < n; c++) {
      let m = 0;
      for (let r = 0; r < rows; r++) {
        const v = d.values[c * rows + r];
        if (v > m) m = v;
      }
      colMax[c] = m;
      if (m > gMax) gMax = m;
    }
    const global = this.hopts.normalize === 'global';
    const pw = Math.max(1, Math.round(f.w * this.dpr));
    const off = (this.off ??= document.createElement('canvas'));
    if (off.width !== pw) off.width = pw;
    if (off.height !== rows) off.height = rows;
    const octx = off.getContext('2d');
    if (!octx) return;
    const img = octx.createImageData(pw, rows);
    const px = img.data;
    const span = f.x1 - f.x0;
    for (let p = 0; p < pw; p++) {
      const t = f.x0 + ((p + 0.5) / pw) * span;
      let c = n === 1 ? 0 : lowerBound(d.x, t);
      if (c >= n) c = n - 1;
      const m = global ? gMax : colMax[c];
      for (let r = 0; r < rows; r++) {
        const v = m > 0 ? d.values[c * rows + r] / m : 0;
        const li = Math.max(0, Math.min(255, Math.round(Math.sqrt(v > 0 ? v : 0) * 255)));
        const o = ((rows - 1 - r) * pw + p) * 4;
        px[o] = this.lut[li * 3];
        px[o + 1] = this.lut[li * 3 + 1];
        px[o + 2] = this.lut[li * 3 + 2];
        px[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, pw, rows, f.x, f.y, f.w, f.h);
    ctx.restore();
    if (d.overlay && n > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(f.x, f.y, f.w, f.h);
      ctx.clip();
      ctx.lineJoin = 'round';
      ctx.beginPath();
      this.trace(ctx, d.x, d.overlay);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = '#f5d76e';
      ctx.lineWidth = 1.25;
      ctx.stroke();
      ctx.restore();
    }
  }

  protected drawHover(ctx: CanvasRenderingContext2D, x: number, y: number, th: ChartTheme, d: HeatmapData): string | null {
    const f = this.frame;
    if (!f || x < f.x || x > f.x + f.w || y < f.y || y > f.y + f.h) return null;
    const n = d.x.length;
    const t = f.x0 + ((x - f.x) / f.w) * (f.x1 - f.x0);
    let c = n === 1 ? 0 : lowerBound(d.x, t);
    if (c >= n) c = n - 1;
    const rows = Math.max(1, d.rows);
    const r = Math.max(0, Math.min(rows - 1, Math.floor(((f.y + f.h - y) / f.h) * rows)));
    const rh = f.h / rows;
    ctx.strokeStyle = th.text;
    ctx.lineWidth = 1;
    ctx.strokeRect(f.x + 0.5, Math.round(f.y + f.h - (r + 1) * rh) + 0.5, f.w - 1, Math.round(rh) - 1);
    this.crosshair(ctx, th, x);
    const v = d.values[c * rows + r];
    let html = this.header(d.x[c]);
    html += tipRow(null, d.rowLabel ? d.rowLabel(r) : `Row ${r}`, d.valueLabel ? d.valueLabel(v) : formatNum(v));
    if (d.overlay) html += tipRow('#f5d76e', d.overlayLabel ?? 'Mean', formatNum(d.overlay[c]));
    return html;
  }
}

// ------------------------------------------------------------------ sparkline

export interface SparklineOptions {
  height?: number;
  color?: string;
  /** Fixed y bounds (auto when undefined). */
  min?: number;
  max?: number;
  /** Minimum auto y-range (keeps flat-ish series from exaggerating noise). */
  minRange?: number;
}

/** Tiny axis-less trend line (KPI tiles, small multiples). */
export class Sparkline {
  readonly el: HTMLCanvasElement;
  private values: ArrayLike<number> = [];
  private color: string;
  private cw = 0;
  private ch = 0;
  private dpr = 1;
  private key: unknown = undefined;

  constructor(parent: HTMLElement, private opts: SparklineOptions = {}) {
    this.color = opts.color ?? '#3987e5';
    const el = document.createElement('canvas');
    el.className = 'an-spark';
    el.style.height = `${opts.height ?? 26}px`;
    parent.appendChild(el);
    this.el = el;
    observeSize(el, (w, h) => {
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      if (Math.floor(w) === this.cw && Math.floor(h) === this.ch && dpr === this.dpr) return;
      this.cw = Math.floor(w);
      this.ch = Math.floor(h);
      this.dpr = dpr;
      el.width = Math.max(1, Math.round(this.cw * dpr));
      el.height = Math.max(1, Math.round(this.ch * dpr));
      this.draw();
    });
  }

  set(values: ArrayLike<number>, key?: unknown, color?: string): void {
    if (key !== undefined && key === this.key) return;
    this.key = key;
    this.values = values;
    if (color) this.color = color;
    this.draw();
  }

  destroy(): void {
    unobserveSize(this.el);
    this.el.remove();
  }

  private draw(): void {
    const w = this.cw;
    const h = this.ch;
    if (w < 4 || h < 4) return;
    const ctx = this.el.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const v = this.values;
    const n = v.length;
    if (n === 0) return;
    let lo = this.opts.min ?? Infinity;
    let hi = this.opts.max ?? -Infinity;
    if (this.opts.min === undefined || this.opts.max === undefined) {
      for (let i = 0; i < n; i++) {
        if (this.opts.min === undefined && v[i] < lo) lo = v[i];
        if (this.opts.max === undefined && v[i] > hi) hi = v[i];
      }
    }
    const minRange = this.opts.minRange ?? 0;
    if (hi - lo < minRange) {
      const c = (hi + lo) / 2;
      lo = c - minRange / 2;
      hi = c + minRange / 2;
    }
    if (!(hi > lo)) {
      lo -= 0.5;
      hi = lo + 1;
    }
    const pad = 2.5;
    const X = (i: number) => (n === 1 ? w - pad : pad + (i / (n - 1)) * (w - pad * 2));
    const Y = (val: number) => pad + (1 - (val - lo) / (hi - lo)) * (h - pad * 2);
    // decimate to ~2 points per pixel
    const step = Math.max(1, Math.floor(n / (w * 2)));
    ctx.beginPath();
    let first = true;
    for (let i = 0; i < n; i += step) {
      const yy = Y(v[i]);
      if (first) ctx.moveTo(X(i), yy);
      else ctx.lineTo(X(i), yy);
      first = false;
    }
    ctx.lineTo(X(n - 1), Y(v[n - 1]));
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineTo(X(n - 1), h);
    ctx.lineTo(X(0), h);
    ctx.closePath();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(X(n - 1), Y(v[n - 1]), 2.2, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
  }
}
