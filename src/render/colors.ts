// OWNER: Rendering agent. Colour helpers, cached CSS strings and heatmap ramps.

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

/** CSS linear-gradient-like colour string for legend stops. */
export function rampColor(r: Ramp, t: number): string {
  const i = Math.max(0, Math.min(255, Math.round(t * 255))) * 4;
  return `rgba(${r[i]},${r[i + 1]},${r[i + 2]},${(r[i + 3] / 255).toFixed(3)})`;
}

// stops: [t, r, g, b, a]
export const RAMPS = {
  food: makeRamp([
    [0, 40, 20, 60, 0],
    [0.08, 50, 40, 110, 90],
    [0.35, 32, 140, 150, 150],
    [0.65, 90, 200, 90, 175],
    [1, 250, 240, 90, 200],
  ]),
  fertility: makeRamp([
    [0, 120, 60, 30, 180],
    [0.3, 190, 130, 50, 150],
    [0.6, 200, 200, 80, 120],
    [1, 60, 210, 110, 150],
  ]),
  density: makeRamp([
    [0, 20, 10, 40, 0],
    [0.1, 70, 20, 120, 110],
    [0.4, 200, 50, 110, 165],
    [0.7, 250, 140, 40, 195],
    [1, 255, 250, 180, 225],
  ]),
  disease: makeRamp([
    [0, 30, 60, 10, 0],
    [0.15, 80, 140, 20, 110],
    [0.5, 150, 230, 40, 170],
    [1, 235, 255, 170, 215],
  ]),
  climateDown: makeRamp([
    [0, 255, 70, 50, 0],
    [0.1, 255, 80, 60, 70],
    [1, 255, 40, 30, 190],
  ]),
  climateUp: makeRamp([
    [0, 60, 255, 120, 0],
    [0.1, 70, 255, 130, 70],
    [1, 120, 255, 140, 190],
  ]),
};
