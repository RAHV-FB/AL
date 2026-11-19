// OWNER: map agents engineer. Palette tokens, colour helpers, cached CSS strings and heatmap ramps.

/** Palette tokens shared by the canvas layers (same values as the CSS tokens of the UI). */
export const PAL = {
  bg: '#131210',
  panel: '#1c1b18',
  border: '#302e29',
  border2: '#3e3b34',
  text: '#e8e3d8',
  muted: '#aba596',
  faint: '#938d7f',
  sage: '#8fb573',
  ochre: '#d6a648',
  rust: '#cf5b45',
  water: '#6f9fc2',
  sand: '#c8b48a',
  /** Dark ink for outlines under text and marks. */
  ink: 'rgba(19,18,16,0.88)',
} as const;

/** Line colours of the connections between agents. */
export const TIE = {
  family: PAL.sand,
  friend: PAL.sage,
  enemy: PAL.rust,
} as const;

/** HSL (h 0..360, s/l 0..1) → packed [r,g,b] 0..255 written into `out`. */
export function hslToRgb(h: number, s: number, l: number, out: number[] = [0, 0, 0]): number[] {
  h = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  out[0] = Math.round(f(h + 1 / 3) * 255);
  out[1] = Math.round(f(h) * 255);
  out[2] = Math.round(f(h - 1 / 3) * 255);
  return out;
}

/** Number of hue buckets used for batched agent drawing. */
export const HUE_BUCKETS = 36;

export function hueBucket(h: number): number {
  const b = Math.floor(((((h % 360) + 360) % 360) / 360) * HUE_BUCKETS);
  return b < 0 ? 0 : b >= HUE_BUCKETS ? HUE_BUCKETS - 1 : b;
}

/** Cached `hsl()` strings per hue bucket for a fixed saturation/lightness (no per-frame allocation). */
export function bucketPalette(s: number, l: number, a = 1): string[] {
  const out: string[] = [];
  for (let i = 0; i < HUE_BUCKETS; i++) {
    const h = ((i + 0.5) / HUE_BUCKETS) * 360;
    out.push(a >= 1 ? `hsl(${h.toFixed(0)},${(s * 100).toFixed(0)}%,${(l * 100).toFixed(0)}%)` : `hsla(${h.toFixed(0)},${(s * 100).toFixed(0)}%,${(l * 100).toFixed(0)}%,${a})`);
  }
  return out;
}

const strCache = new Map<number, string>();
/** Cached `hsla()` string for an arbitrary hue (rounded to 1°) and a style slot (s,l,a combos). */
export function hueColor(h: number, s: number, l: number, a = 1): string {
  const hi = ((Math.round(h) % 360) + 360) % 360;
  const key = hi * 1e6 + Math.round(s * 99) * 1e4 + Math.round(l * 99) * 100 + Math.round(a * 99);
  let v = strCache.get(key);
  if (v === undefined) {
    v = `hsla(${hi},${Math.round(s * 100)}%,${Math.round(l * 100)}%,${Math.round(a * 100) / 100})`;
    if (strCache.size > 4000) strCache.clear();
    strCache.set(key, v);
  }
  return v;
}

/** Tribe colour, the same everywhere (map bodies, territory, charts, swatches): hsl(hue, 45%, 58%). */
export function tribeColor(hue: number, a = 1): string {
  return hueColor(hue, 0.45, 0.58, a);
}

/** Darker shade of a tribe colour, for outlines on the map. */
export function tribeShade(hue: number, a = 1): string {
  return hueColor(hue, 0.4, 0.26, a);
}

/** 256-entry RGBA lookup table (Uint8ClampedArray, 1024 bytes) built from colour stops. */
export type Ramp = Uint8ClampedArray;

export function makeRamp(stops: [number, number, number, number, number][]): Ramp {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    while (j < stops.length - 2 && t > stops[j + 1][0]) j++;
    const a = stops[j];
    const b = stops[Math.min(stops.length - 1, j + 1)];
    const span = b[0] - a[0];
    const u = span > 0 ? Math.min(1, Math.max(0, (t - a[0]) / span)) : 0;
    for (let c = 0; c < 4; c++) lut[i * 4 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * u;
  }
  return lut;
}

/** CSS colour string of a ramp at t (legend stops). */
export function rampColor(r: Ramp, t: number): string {
  const i = Math.max(0, Math.min(255, Math.round(t * 255))) * 4;
  return `rgba(${r[i]},${r[i + 1]},${r[i + 2]},${(r[i + 3] / 255).toFixed(3)})`;
}

// Heatmap ramps for the data overlays, built from the palette (sand, ochre, sage, rust, water).
// stops: [t, r, g, b, a]
export const RAMPS = {
  food: makeRamp([
    [0, 90, 70, 45, 0],
    [0.06, 150, 112, 66, 90],
    [0.35, 200, 180, 120, 135],
    [0.7, 143, 181, 115, 170],
    [1, 205, 226, 168, 200],
  ]),
  fertility: makeRamp([
    [0, 160, 86, 60, 180],
    [0.3, 196, 146, 82, 150],
    [0.6, 205, 190, 125, 120],
    [1, 143, 181, 115, 160],
  ]),
  density: makeRamp([
    [0, 60, 50, 35, 0],
    [0.1, 150, 120, 70, 110],
    [0.4, 214, 166, 72, 165],
    [0.7, 207, 91, 69, 195],
    [1, 240, 222, 196, 225],
  ]),
  disease: makeRamp([
    [0, 80, 80, 30, 0],
    [0.15, 128, 132, 58, 110],
    [0.5, 172, 176, 92, 170],
    [1, 228, 226, 168, 215],
  ]),
  climateDown: makeRamp([
    [0, 207, 91, 69, 0],
    [0.1, 207, 91, 69, 70],
    [1, 207, 91, 69, 190],
  ]),
  climateUp: makeRamp([
    [0, 143, 181, 115, 0],
    [0.1, 143, 181, 115, 70],
    [1, 165, 205, 135, 190],
  ]),
};

/** Plain panel for canvas legends and notes: flat fill, 1px border, 2px radius (screen space). */
export function flatPanel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const r = 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = PAL.panel;
  ctx.fill();
  ctx.strokeStyle = PAL.border2;
  ctx.lineWidth = 1;
  ctx.stroke();
}
