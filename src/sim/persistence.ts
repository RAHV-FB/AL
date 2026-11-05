// OWNER: Persistence & Experiments engineer.
/**
 * Save / load of complete simulations.
 *
 * FILE FORMAT (JSON text):
 *   {
 *     "format": "artificial-life-save",
 *     "version": SAVE_VERSION,
 *     "savedAt": "2026-11-05T12:00:00.000Z",   // informational only (never read back)
 *     "scenarioId": "...", "tick": 1234, "population": 321,   // informational header
 *     "state": SimState
 *   }
 * Inside `state`, values plain JSON cannot represent are tagged:
 *   - typed arrays (world layers) → { "$typed": "Float32Array", "b64": "<base64 of the raw little-endian bytes>" }
 *   - NaN, ±Infinity and -0       → { "$num": "NaN" | "Infinity" | "-Infinity" | "-0" }
 *     (e.g. Agent.targetX is NaN when there is no target; plain JSON would turn it into null).
 *
 * ROUND-TRIP GUARANTEE: for a save taken between ticks,
 *   Simulation.fromState(deserializeState(serializeSim(sim)))
 * is indistinguishable from `sim` — same hash() now and after any number of further ticks.
 * Floats are exact (typed arrays as raw bytes, JS numbers via shortest round-trip JSON).
 * The RNG state is captured from `sim.rng` directly, so saving right after Simulation.create()
 * (before any step) is also exact.
 * NOT saved: the Simulation's private, not-yet-applied user-intervention queue (enqueue()d this
 * frame, applied at the start of the next step) and a pending "restart & replay" queue. Interventions
 * already applied are in `state.interventionLog`. If that matters, step once before saving.
 *
 * LOADING treats the file as untrusted input: size limit, friendly JSON errors, format/version check,
 * then every field is validated & sanitised (see sanitizeState). Fatal problems (not a save, wrong
 * version, missing/corrupt world or tick) throw an Error with a human-readable message; everything
 * else is repaired and reported through `options.warnings` / validateSave().warnings.
 * Sanitisation is the identity on any state a correct simulation can produce: references to agents
 * or tribes that merely died are kept (the live simulation keeps them too); only ids that were never
 * allocated (≥ nextAgentId / nextTribeId, non-integers, …) are dropped.
 */
import { Simulation } from './simulation';
import { Rng } from './rng';
import { DEFAULT_CONFIG, PARAM_SPECS } from './config';
import { LIMITS, SAVE_VERSION } from './constants';
import { expressTraits } from './genetics';
import { initEnvironment } from './ecology';
import { createStatsState } from './stats';
import {
  ACTIONS,
  DEATH_CAUSES,
  DISASTER_KINDS,
  GENE_COUNT,
  GENES,
  HIST_BINS,
  NONE,
  TERRAIN,
  TERRAIN_COUNT,
  type ActionKind,
  type DeathCause,
  type DisasterKind,
  type EnvState,
  type EventCategory,
  type GenomeTemplate,
  type Intervention,
  type Role,
  type SimConfig,
  type SimState,
  type StatsState,
  type TerrainType,
  type WorldState,
} from './types';

export const SAVE_FORMAT = 'artificial-life-save';
/** Largest save text accepted by deserializeState (characters ≈ bytes for this ASCII format). */
export const MAX_SAVE_CHARS = 100 * 1024 * 1024;

// ---------------------------------------------------------------- bounds
const MIN_DIM = 4;
const MAX_DIM = 4096;
const MAX_TILES = 4_000_000;
const MAX_TILE_SIZE = 64;
const MAX_TICK = 1e12;
const MAX_ID = 2 ** 31 - 2;
/** Generous bound for counters / timers / cooldowns (only rejects absurd or non-finite values). */
const BIG = 1e12;
const MAX_COORD = 1e7;
const MAX_TILE_FOOD = 1e6;
const MAX_AGENTS_HARD = 20_000;
const MAX_TRIBES_HARD = 2_000;
const MAX_DISASTERS = 1_000;
const MAX_SCHEDULED = 5_000;
const MAX_REPAIR_MESSAGES = 60;
/**
 * Per-agent list caps. Twice the shared LIMITS: still bounds memory for hostile files, but never
 * truncates (and so never changes) a list that a module legitimately keeps at its own cap.
 */
const AGENT_CAPS = {
  relationships: LIMITS.relationships * 2,
  children: LIMITS.children * 2,
  history: LIMITS.history * 2,
  foodMemory: LIMITS.foodMemory * 2,
  dangerMemory: LIMITS.dangerMemory * 2,
};

const ROLES: Role[] = ['none', 'forager', 'warrior', 'caretaker', 'explorer'];
const EVENT_CATEGORIES: EventCategory[] = ['population', 'tribe', 'conflict', 'disaster', 'disease', 'evolution', 'environment', 'intervention', 'record'];
const SEVERITIES = ['info', 'good', 'bad', 'major'] as const;
const ACTION_SET = new Set<string>(ACTIONS);
const ROLE_SET = new Set<string>(ROLES);
const CAUSE_SET = new Set<string>(DEATH_CAUSES);
const DISASTER_SET = new Set<string>(DISASTER_KINDS);
const CATEGORY_SET = new Set<string>(EVENT_CATEGORIES);
const SEVERITY_SET = new Set<string>(SEVERITIES);

// ---------------------------------------------------------------- small helpers
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const has = (o: Obj, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Collects non-fatal repairs; aggregated per field so a broken file yields a short, readable list. */
class Repairs {
  private readonly counts = new Map<string, number>();
  private readonly notes: string[] = [];

  fix(field: string, n = 1): void {
    this.counts.set(field, (this.counts.get(field) ?? 0) + n);
  }

  note(msg: string): void {
    this.notes.push(msg);
  }

  list(): string[] {
    const out = [...this.notes];
    for (const [k, n] of this.counts) out.push(`${k}: repaired ${n} invalid value${n === 1 ? '' : 's'}`);
    if (out.length > MAX_REPAIR_MESSAGES) {
      const extra = out.length - MAX_REPAIR_MESSAGES;
      out.length = MAX_REPAIR_MESSAGES;
      out.push(`…and ${extra} more`);
    }
    return out;
  }
}

/** Number in [min,max]; NaN / non-numbers → def, out of range → clamped. Identity on valid values (incl. -0). */
function num(r: Repairs, field: string, v: unknown, def: number, min = -BIG, max = BIG): number {
  if (typeof v !== 'number' || v !== v) {
    r.fix(field);
    return def;
  }
  if (v < min) {
    r.fix(field);
    return min;
  }
  if (v > max) {
    r.fix(field);
    return max;
  }
  return v;
}

/** Integer in [min,max]; non-integers are rounded. */
function int(r: Repairs, field: string, v: unknown, def: number, min: number, max: number): number {
  if (!isFiniteNum(v)) {
    r.fix(field);
    return def;
  }
  const i = clamp(Math.round(v), min, max);
  if (i !== v) r.fix(field);
  return i;
}

function str(r: Repairs, field: string, v: unknown, def: string, maxLen: number): string {
  if (typeof v !== 'string') {
    r.fix(field);
    return def;
  }
  if (v.length > maxLen) {
    r.fix(field);
    return v.slice(0, maxLen);
  }
  return v;
}

function bool(r: Repairs, field: string, v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  r.fix(field);
  return def;
}

// ---------------------------------------------------------------- base64 (browser + Node, no Buffer/btoa)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_ENC = new Uint8Array(64);
const B64_DEC = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) {
  B64_ENC[i] = B64.charCodeAt(i);
  B64_DEC[B64.charCodeAt(i)] = i;
}
const PAD = 61; // '='

/** Standard base64 (RFC 4648, with padding) of raw bytes. */
export function bytesToBase64(bytes: Uint8Array): string {
  const n = bytes.length;
  const out = new Uint8Array(Math.ceil(n / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = B64_ENC[v >>> 18];
    out[o++] = B64_ENC[(v >>> 12) & 63];
    out[o++] = B64_ENC[(v >>> 6) & 63];
    out[o++] = B64_ENC[v & 63];
  }
  const rem = n - i;
  if (rem === 1) {
    const v = bytes[i] << 16;
    out[o++] = B64_ENC[v >>> 18];
    out[o++] = B64_ENC[(v >>> 12) & 63];
    out[o++] = PAD;
    out[o++] = PAD;
  } else if (rem === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out[o++] = B64_ENC[v >>> 18];
    out[o++] = B64_ENC[(v >>> 12) & 63];
    out[o++] = B64_ENC[(v >>> 6) & 63];
    out[o++] = PAD;
  }
  // Output is pure ASCII, so decoding it as UTF-8 is exact (and fast, without call-stack limits).
  return new TextDecoder().decode(out);
}

const b64val = (code: number): number => (code < 128 ? B64_DEC[code] : -1);

/** Decode standard base64 (padding optional). Throws on any invalid character or length. */
export function base64ToBytes(b64: string): Uint8Array {
  let end = b64.length;
  if (end > 0 && b64.charCodeAt(end - 1) === PAD) end--;
  if (end > 0 && b64.charCodeAt(end - 1) === PAD) end--;
  if (end < b64.length && b64.length % 4 !== 0) throw new Error('invalid base64 padding');
  const rem = end % 4;
  if (rem === 1) throw new Error('invalid base64 length');
  const out = new Uint8Array((end >> 2) * 3 + (rem ? rem - 1 : 0));
  const full = end - rem;
  let o = 0;
  for (let i = 0; i < full; i += 4) {
    const a = b64val(b64.charCodeAt(i));
    const b = b64val(b64.charCodeAt(i + 1));
    const c = b64val(b64.charCodeAt(i + 2));
    const d = b64val(b64.charCodeAt(i + 3));
    if ((a | b | c | d) < 0) throw new Error(`invalid base64 character near offset ${i}`);
    const v = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = v >>> 16;
    out[o++] = (v >>> 8) & 255;
    out[o++] = v & 255;
  }
  if (rem) {
    const a = b64val(b64.charCodeAt(full));
    const b = b64val(b64.charCodeAt(full + 1));
    const c = rem === 3 ? b64val(b64.charCodeAt(full + 2)) : 0;
    if ((a | b | c) < 0) throw new Error(`invalid base64 character near offset ${full}`);
    const v = (a << 18) | (b << 12) | (c << 6);
    out[o++] = v >>> 16;
    if (rem === 3) out[o++] = (v >>> 8) & 255;
  }
  return out;
}

// ---------------------------------------------------------------- typed arrays
type TypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;
type TypedCtor = { new (buffer: ArrayBuffer, byteOffset: number, length: number): TypedArray; new (length: number): TypedArray; BYTES_PER_ELEMENT: number };

const TYPED_CTORS: Record<string, TypedCtor> = {
  Int8Array: Int8Array as unknown as TypedCtor,
  Uint8Array: Uint8Array as unknown as TypedCtor,
  Uint8ClampedArray: Uint8ClampedArray as unknown as TypedCtor,
  Int16Array: Int16Array as unknown as TypedCtor,
  Uint16Array: Uint16Array as unknown as TypedCtor,
  Int32Array: Int32Array as unknown as TypedCtor,
  Uint32Array: Uint32Array as unknown as TypedCtor,
  Float32Array: Float32Array as unknown as TypedCtor,
  Float64Array: Float64Array as unknown as TypedCtor,
};

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Realm-independent typed-array kind, e.g. "Float32Array". */
const typedTag = (v: ArrayBufferView): string => Object.prototype.toString.call(v).slice(8, -1);

/** Reverse the byte order of every element in place (only used on big-endian hosts). */
function swapBytes(bytes: Uint8Array, bpe: number): Uint8Array {
  for (let i = 0; i + bpe <= bytes.length; i += bpe) {
    for (let a = i, b = i + bpe - 1; a < b; a++, b--) {
      const t = bytes[a];
      bytes[a] = bytes[b];
      bytes[b] = t;
    }
  }
  return bytes;
}

function encodeTyped(v: ArrayBufferView): { $typed: string; b64: string } {
  const tag = typedTag(v);
  const Ctor = TYPED_CTORS[tag];
  if (!Ctor) throw new Error(`Cannot save: unsupported binary data type ${tag}.`);
  let bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (!LITTLE_ENDIAN && Ctor.BYTES_PER_ELEMENT > 1) bytes = swapBytes(bytes.slice(), Ctor.BYTES_PER_ELEMENT);
  return { $typed: tag, b64: bytesToBase64(bytes) };
}

function decodeTyped(kind: string, b64: string, key: string): TypedArray {
  const Ctor = has(TYPED_CTORS, kind) ? TYPED_CTORS[kind] : undefined;
  if (!Ctor) throw new Error(`field "${key}" uses an unsupported binary data type "${kind}"`);
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(b64);
  } catch (e) {
    throw new Error(`binary field "${key}" is corrupted (${errMsg(e)})`);
  }
  const bpe = Ctor.BYTES_PER_ELEMENT;
  if (bytes.length % bpe !== 0) throw new Error(`binary field "${key}" is corrupted (${bytes.length} bytes is not a whole number of ${kind} elements)`);
  if (!LITTLE_ENDIAN && bpe > 1) swapBytes(bytes, bpe);
  return new Ctor(bytes.buffer as ArrayBuffer, 0, bytes.length / bpe);
}

// ---------------------------------------------------------------- JSON hooks
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'number') {
    if (value !== value) return { $num: 'NaN' };
    if (value === Infinity) return { $num: 'Infinity' };
    if (value === -Infinity) return { $num: '-Infinity' };
    if (value === 0 && 1 / value < 0) return { $num: '-0' };
    return value;
  }
  if (typeof value === 'object' && value !== null && ArrayBuffer.isView(value)) return encodeTyped(value);
  return value;
}

function reviver(key: string, value: unknown): unknown {
  if (key === '__proto__') return undefined; // never let a file smuggle a prototype key into our objects
  if (isObj(value)) {
    const tag = value.$num;
    if (typeof tag === 'string') {
      if (tag === 'NaN') return NaN;
      if (tag === 'Infinity') return Infinity;
      if (tag === '-Infinity') return -Infinity;
      if (tag === '-0') return -0;
      return value;
    }
    if (typeof value.$typed === 'string' && typeof value.b64 === 'string') return decodeTyped(value.$typed, value.b64, key);
  }
  return value;
}

// ---------------------------------------------------------------- public API

/** Serialise a simulation to JSON text (typed arrays → base64). Take saves between ticks. */
export function serializeSim(sim: Simulation, opts: { savedAt?: string; pretty?: boolean } = {}): string {
  const s = sim.state;
  // state.rngState is only refreshed at the end of step(); take the live generator state so a save made
  // after RNG use outside a tick (e.g. right after Simulation.create spawned the founders) is exact.
  const state: SimState = { ...s, version: SAVE_VERSION, rngState: sim.rng.getState() };
  const file = {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: opts.savedAt ?? new Date().toISOString(),
    scenarioId: s.scenarioId,
    tick: s.tick,
    population: s.agents.length,
    state,
  };
  return JSON.stringify(file, replacer, opts.pretty ? 1 : undefined);
}

export interface LoadOptions {
  /** Receives human-readable descriptions of every non-fatal repair made while loading. */
  warnings?: string[];
  /** Override the size limit (characters). Default MAX_SAVE_CHARS (100 MB). */
  maxChars?: number;
}

/** Parse + validate a save file. Throws Error with a human-readable message on invalid input. */
export function deserializeState(json: string, options: LoadOptions = {}): SimState {
  if (typeof json !== 'string') throw new Error('Cannot load: save data must be JSON text.');
  const limit = options.maxChars ?? MAX_SAVE_CHARS;
  if (json.length > limit) {
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
    throw new Error(`Cannot load: the file is too large (${mb(json.length)} MB; the limit is ${mb(limit)} MB).`);
  }
  const text = json.charCodeAt(0) === 0xfeff ? json.slice(1) : json; // tolerate a UTF-8 BOM
  if (/^\s*$/.test(text)) throw new Error('Cannot load: the file is empty.');

  let root: unknown;
  try {
    root = JSON.parse(text, reviver);
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Cannot load: the file is not valid JSON — it may be truncated or not a save file (${e.message}).`);
    }
    throw new Error(`Cannot load: ${errMsg(e)}.`);
  }
  if (!isObj(root) || root.format !== SAVE_FORMAT) {
    throw new Error(`Cannot load: this is not an Artificial Life save file (expected "format": "${SAVE_FORMAT}").`);
  }
  const version = root.version;
  if (!isInt(version) || version < 1) throw new Error('Cannot load: the save file has no valid format version.');
  if (version > SAVE_VERSION) {
    throw new Error(
      `Cannot load: this save was written by a newer version of Artificial Life (save format v${version}; this build reads up to v${SAVE_VERSION}).`,
    );
  }
  if (!isObj(root.state)) throw new Error('Cannot load: the save file contains no simulation state.');

  const r = new Repairs();
  if (version < SAVE_VERSION) r.note(`Save format v${version} upgraded to v${SAVE_VERSION}; missing fields were filled with defaults.`);
  const state = sanitizeState(root.state, r);
  if (options.warnings) options.warnings.push(...r.list());
  return state;
}

export interface SaveValidation {
  ok: boolean;
  /** Fatal problems (the save cannot be loaded). */
  errors: string[];
  /** Non-fatal problems that loading repairs automatically. */
  warnings: string[];
}

/** Check a save without loading it into a simulation. */
export function validateSave(json: string): SaveValidation {
  const warnings: string[] = [];
  try {
    deserializeState(json, { warnings });
    return { ok: true, errors: [], warnings };
  } catch (e) {
    return { ok: false, errors: [errMsg(e)], warnings };
  }
}

/** Convenience: parse, validate and rebuild a runnable Simulation. */
export function loadSim(json: string, options: LoadOptions = {}): Simulation {
  return Simulation.fromState(deserializeState(json, options));
}

/** Suggested download name, e.g. "artificial-life_two-civs_seed42_day3_t2100.json". */
export function saveFileName(sim: Simulation): string {
  const s = sim.state;
  const scen = String(s.scenarioId || 'custom')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'custom';
  const day = Math.floor(s.tick / Math.max(1, s.config.dayLength));
  return `artificial-life_${scen}_seed${s.config.seed >>> 0}_day${day}_t${s.tick}.json`;
}

// ---------------------------------------------------------------- sanitising

interface Refs {
  tick: number;
  W: number; // world size in world units
  H: number;
  nextAgentId: number;
  nextTribeId: number;
  /** Tribes present in state.tribes (agents may only belong to these). */
  tribeIds: Set<number>;
}

/** An agent id that was allocated at some point (living or dead). */
const allocatedAgent = (refs: Refs, v: unknown): v is number => isInt(v) && v >= 1 && v < refs.nextAgentId;
const allocatedTribe = (refs: Refs, v: unknown): v is number => isInt(v) && v >= 1 && v < refs.nextTribeId;

function agentRef(r: Repairs, field: string, refs: Refs, v: unknown): number {
  if (v === NONE || allocatedAgent(refs, v)) return v as number;
  r.fix(field);
  return NONE;
}

function tribeRef(r: Repairs, field: string, refs: Refs, v: unknown): number {
  if (v === NONE || allocatedTribe(refs, v)) return v as number;
  r.fix(field);
  return NONE;
}

function parentPair(r: Repairs, field: string, refs: Refs, v: unknown): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) {
    r.fix(field);
    return [NONE, NONE];
  }
  return [agentRef(r, field, refs, v[0]), agentRef(r, field, refs, v[1])];
}

/** Position inside [0, size); anything else is clamped to the simulation's own margin. */
function coordInside(r: Repairs, field: string, v: unknown, size: number): number {
  if (!isFiniteNum(v)) {
    r.fix(field);
    return size / 2;
  }
  if (v >= 0 && v < size) return v;
  r.fix(field);
  return clamp(v, 0.5, size - 0.5);
}

function fixedNumArray(r: Repairs, field: string, v: unknown, len: number, def: number, min: number, max: number): number[] {
  const src = Array.isArray(v) ? v : ArrayBuffer.isView(v) ? Array.from(v as TypedArray) : null;
  if (!src) {
    r.fix(field);
    return new Array<number>(len).fill(def);
  }
  if (src.length !== len) r.fix(field);
  const out = new Array<number>(len);
  for (let i = 0; i < len; i++) out[i] = i < src.length ? num(r, field, src[i], def, min, max) : def;
  return out;
}

function causeRecord(r: Repairs, field: string, v: unknown): Record<DeathCause, number> {
  const src = isObj(v) ? v : (r.fix(field), {} as Obj);
  const out = {} as Record<DeathCause, number>;
  for (const c of DEATH_CAUSES) out[c] = has(src, c) ? num(r, field, src[c], 0, 0, BIG) : 0;
  return out;
}

function roleRecord(r: Repairs, field: string, v: unknown): Record<Role, number> {
  const src = isObj(v) ? v : (r.fix(field), {} as Obj);
  const out = {} as Record<Role, number>;
  for (const k of ROLES) out[k] = has(src, k) ? num(r, field, src[k], 0, 0, BIG) : 0;
  return out;
}

/** Keep only ActionKind keys with numeric values (in place, preserving order). */
function actionRecord(r: Repairs, field: string, v: unknown): Partial<Record<ActionKind, number>> {
  if (!isObj(v)) {
    if (v !== undefined) r.fix(field);
    return {};
  }
  for (const k of Object.keys(v)) {
    if (!ACTION_SET.has(k) || typeof v[k] !== 'number') {
      delete v[k];
      r.fix(field);
    }
  }
  return v as Partial<Record<ActionKind, number>>;
}

/** Take a list, dropping entries that fail `keep`, capped to `cap` (keeping the first or last entries). */
function list<T>(r: Repairs, field: string, v: unknown, cap: number, keepLast: boolean, keep: (e: unknown) => T | null): T[] {
  if (!Array.isArray(v)) {
    if (v !== undefined) r.fix(field);
    return [];
  }
  let src: unknown[] = v;
  if (src.length > cap) {
    r.fix(field, src.length - cap);
    src = keepLast ? src.slice(src.length - cap) : src.slice(0, cap);
  }
  const out: T[] = [];
  for (const e of src) {
    const k = keep(e);
    if (k === null) r.fix(field);
    else out.push(k);
  }
  return out;
}

// ---------------------------------------------------------------- config

const SPEC_BY_KEY = new Map<string, { min: number; max: number }>(PARAM_SPECS.map((p) => [p.key, p]));
const EXTRA_BOUNDS: Record<string, [number, number]> = {
  worldWidth: [MIN_DIM, MAX_DIM],
  worldHeight: [MIN_DIM, MAX_DIM],
  tileSize: [1, MAX_TILE_SIZE],
  dayLength: [10, 1_000_000],
  daysPerSeason: [1, 100_000],
};
const INT_CONFIG_KEYS = new Set<string>(['worldWidth', 'worldHeight', 'maxAgents', 'dayLength', 'daysPerSeason']);

/** Validate one config value against DEFAULT_CONFIG's type and PARAM_SPECS / sane bounds. undefined = unusable. */
function configValue(r: Repairs, key: keyof SimConfig, v: unknown): number | boolean | undefined {
  const field = `config.${key}`;
  const def = DEFAULT_CONFIG[key];
  if (typeof def === 'boolean') {
    if (typeof v === 'boolean') return v;
    r.fix(field);
    return undefined;
  }
  if (!isFiniteNum(v)) {
    r.fix(field);
    return undefined;
  }
  if (key === 'seed') {
    const s = v >>> 0;
    if (s !== v) r.fix(field);
    return s;
  }
  const spec = SPEC_BY_KEY.get(key);
  const [lo, hi] = spec ? [spec.min, spec.max] : (EXTRA_BOUNDS[key] ?? [-BIG, BIG]);
  const x = clamp(INT_CONFIG_KEYS.has(key) ? Math.round(v) : v, lo, hi);
  if (x !== v) r.fix(field);
  return x;
}

function sanitizeConfig(raw: unknown, r: Repairs): SimConfig {
  const cfg: SimConfig = { ...DEFAULT_CONFIG };
  if (!isObj(raw)) {
    r.note('Configuration was missing — default settings used.');
    return cfg;
  }
  const out = cfg as unknown as Obj;
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof SimConfig)[]) {
    if (!has(raw, key)) {
      r.fix(`config.${key} (missing)`);
      continue;
    }
    const v = configValue(r, key, raw[key]);
    if (v !== undefined) out[key] = v;
  }
  for (const key of Object.keys(raw)) if (!has(DEFAULT_CONFIG as unknown as Obj, key)) r.note(`Ignored unknown setting "config.${key}".`);
  return cfg;
}

/** setConfig patches: only known keys with valid values survive. */
function sanitizeConfigPatch(raw: Obj, r: Repairs): Partial<SimConfig> {
  const patch: Obj = {};
  for (const key of Object.keys(raw)) {
    if (!has(DEFAULT_CONFIG as unknown as Obj, key)) {
      r.fix('intervention.setConfig (unknown key)');
      continue;
    }
    const v = configValue(r, key as keyof SimConfig, raw[key]);
    if (v !== undefined) patch[key] = v;
  }
  return patch as Partial<SimConfig>;
}

// ---------------------------------------------------------------- world

function worldLayer(raw: Obj, key: string, kind: string, n: number, w: number, h: number): TypedArray {
  const v = raw[key];
  const Ctor = TYPED_CTORS[kind];
  if (Array.isArray(v)) {
    // tolerate plain number arrays (hand-edited saves / external tools); values are range-checked later
    if (v.length !== n) throw new Error(`Cannot load: the world "${key}" layer has ${v.length} tiles but the ${w}×${h} map needs ${n} — the save is corrupted.`);
    const arr = new Ctor(n);
    for (let i = 0; i < n; i++) arr[i] = typeof v[i] === 'number' ? (v[i] as number) : NaN;
    return arr;
  }
  if (v === undefined || v === null) throw new Error(`Cannot load: the world map is missing its "${key}" layer.`);
  if (!ArrayBuffer.isView(v)) throw new Error(`Cannot load: the world "${key}" layer is unreadable.`);
  const tag = typedTag(v);
  if (tag !== kind) throw new Error(`Cannot load: the world "${key}" layer has the wrong data type (${tag}; expected ${kind}).`);
  const len = (v as TypedArray).length;
  if (len !== n) throw new Error(`Cannot load: the world "${key}" layer has ${len} tiles but the ${w}×${h} map needs ${n} — the save is corrupted.`);
  return v as TypedArray;
}

/** Clamp a float layer to [min,max] in place (NaN → nanTo). -0 and in-range values are untouched. */
function clampLayer(r: Repairs, field: string, a: Float32Array, min: number, max: number, nanTo: number): void {
  let bad = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v >= min && v <= max) continue;
    a[i] = v !== v ? nanTo : v < min ? min : max;
    bad++;
  }
  if (bad) r.fix(field, bad);
}

function sanitizeWorld(raw: unknown, r: Repairs): WorldState {
  if (!isObj(raw)) throw new Error('Cannot load: the save contains no world map.');
  const { width, height, tileSize } = raw;
  if (!isInt(width) || !isInt(height) || width < MIN_DIM || height < MIN_DIM || width > MAX_DIM || height > MAX_DIM || width * height > MAX_TILES) {
    throw new Error(`Cannot load: invalid world size ${String(width)}×${String(height)} tiles.`);
  }
  if (!isFiniteNum(tileSize) || tileSize < 1 || tileSize > MAX_TILE_SIZE) throw new Error(`Cannot load: invalid world tile size ${String(tileSize)}.`);
  const n = width * height;
  const terrain = worldLayer(raw, 'terrain', 'Uint8Array', n, width, height) as Uint8Array;
  const food = worldLayer(raw, 'food', 'Float32Array', n, width, height) as Float32Array;
  const fertility = worldLayer(raw, 'fertility', 'Float32Array', n, width, height) as Float32Array;
  const baseFertility = worldLayer(raw, 'baseFertility', 'Float32Array', n, width, height) as Float32Array;
  const elevation = worldLayer(raw, 'elevation', 'Float32Array', n, width, height) as Float32Array;
  const climateMod = worldLayer(raw, 'climateMod', 'Float32Array', n, width, height) as Float32Array;
  const territory = worldLayer(raw, 'territory', 'Int16Array', n, width, height) as Int16Array;

  let bad = 0;
  for (let i = 0; i < n; i++) {
    if (terrain[i] >= TERRAIN_COUNT) {
      terrain[i] = TERRAIN.Grass as TerrainType;
      bad++;
    }
  }
  if (bad) r.fix('world.terrain', bad);
  clampLayer(r, 'world.food', food, 0, MAX_TILE_FOOD, 0);
  // Fertility is documented as 0..1; allow up to 2 so a fertility-multiplied world (WorldGenOptions.fertility ≤ 2) is never altered.
  clampLayer(r, 'world.fertility', fertility, 0, 2, 1);
  clampLayer(r, 'world.baseFertility', baseFertility, 0, 2, 1);
  clampLayer(r, 'world.elevation', elevation, 0, 1, 0.5);
  clampLayer(r, 'world.climateMod', climateMod, 0, 100, 1);

  raw.terrain = terrain;
  raw.food = food;
  raw.fertility = fertility;
  raw.baseFertility = baseFertility;
  raw.elevation = elevation;
  raw.climateMod = climateMod;
  raw.territory = territory; // values checked once tribe ids are known
  raw.terrainVersion = int(r, 'world.terrainVersion', raw.terrainVersion ?? 0, 0, 0, Number.MAX_SAFE_INTEGER);
  return raw as unknown as WorldState;
}

// ---------------------------------------------------------------- environment

function sanitizeEnv(raw: unknown, config: SimConfig, r: Repairs): EnvState {
  const def = initEnvironment(config);
  if (!isObj(raw)) {
    r.note('Environment (clock/season) was missing — reset to the start of spring.');
    return def;
  }
  raw.timeOfDay = num(r, 'env.timeOfDay', raw.timeOfDay, def.timeOfDay, 0, 1);
  raw.daylight = num(r, 'env.daylight', raw.daylight, def.daylight, 0, 1);
  raw.day = num(r, 'env.day', raw.day, def.day, 0, BIG);
  raw.season = isInt(raw.season) && raw.season >= 0 && raw.season <= 3 ? raw.season : (r.fix('env.season'), def.season);
  raw.seasonProgress = num(r, 'env.seasonProgress', raw.seasonProgress, def.seasonProgress, 0, 1);
  raw.year = num(r, 'env.year', raw.year, def.year, 0, BIG);
  raw.temperature = num(r, 'env.temperature', raw.temperature, def.temperature, -500, 500);
  raw.tempOffset = num(r, 'env.tempOffset', raw.tempOffset, def.tempOffset, -500, 500);
  raw.seasonGrowth = num(r, 'env.seasonGrowth', raw.seasonGrowth, def.seasonGrowth, 0, 1000);
  return raw as unknown as EnvState;
}

// ---------------------------------------------------------------- agents

/** Pass 1: keep agents with a usable identity (unique id, alive, genes, finite position). */
function collectAgents(raw: unknown, r: Repairs): Obj[] {
  if (!Array.isArray(raw)) {
    r.note(raw === undefined ? 'The save has no agent list — loaded with no agents.' : 'The agent list was unreadable — loaded with no agents.');
    return [];
  }
  let src: unknown[] = raw;
  if (src.length > MAX_AGENTS_HARD) {
    r.note(`The save lists ${src.length} agents; only the first ${MAX_AGENTS_HARD} were loaded.`);
    src = src.slice(0, MAX_AGENTS_HARD);
  }
  const seen = new Set<number>();
  const out: Obj[] = [];
  let invalid = 0;
  let dupes = 0;
  let dead = 0;
  for (const a of src) {
    if (!isObj(a) || !isInt(a.id) || a.id < 1 || a.id > MAX_ID) invalid++;
    else if (seen.has(a.id)) dupes++;
    else if (a.alive === false) dead++;
    else if (!(Array.isArray(a.genes) || ArrayBuffer.isView(a.genes)) || !isFiniteNum(a.x) || !isFiniteNum(a.y)) invalid++;
    else {
      seen.add(a.id);
      out.push(a);
    }
  }
  if (invalid) r.note(`Removed ${invalid} corrupt agent record${invalid === 1 ? '' : 's'} (bad id, genes or position).`);
  if (dupes) r.note(`Removed ${dupes} agent${dupes === 1 ? '' : 's'} with duplicate ids.`);
  if (dead) r.note(`Removed ${dead} dead agent${dead === 1 ? '' : 's'} from the living population.`);
  return out;
}

function sanitizeGenes(r: Repairs, v: unknown): number[] {
  return fixedNumArray(r, 'agent.genes', v, GENE_COUNT, 0.5, 0, 1);
}

function memorySpot(r: Repairs, field: string, e: unknown): Obj | null {
  if (!isObj(e) || !isFiniteNum(e.x) || !isFiniteNum(e.y)) return null;
  e.value = num(r, field, e.value, 0);
  e.tick = num(r, field, e.tick, 0);
  return e;
}

/** Pass 2: sanitise every field of a living agent in place (unknown extension fields are kept). */
function sanitizeAgent(a: Obj, refs: Refs, r: Repairs): void {
  a.name = str(r, 'agent.name', a.name, 'Nameless', 40);
  if (a.alive !== true) {
    r.fix('agent.alive');
    a.alive = true;
  }
  a.generation = int(r, 'agent.generation', a.generation, 0, 0, 1e9);
  a.parents = parentPair(r, 'agent.parents', refs, a.parents);
  a.age = num(r, 'agent.age', a.age, 0, 0, BIG);
  a.birthTick = num(r, 'agent.birthTick', a.birthTick, refs.tick - (a.age as number));
  a.x = coordInside(r, 'agent.x', a.x, refs.W);
  a.y = coordInside(r, 'agent.y', a.y, refs.H);
  a.vx = num(r, 'agent.vx', a.vx, 0, -1e4, 1e4);
  a.vy = num(r, 'agent.vy', a.vy, 0, -1e4, 1e4);
  a.heading = num(r, 'agent.heading', a.heading, 0);

  const genes = sanitizeGenes(r, a.genes);
  a.genes = genes;
  const traits = expressTraits(genes); // phenotype is a pure function of genes — never trust stored traits
  a.traits = traits;

  a.health = num(r, 'agent.health', a.health, traits.maxHealth, 0, traits.maxHealth);
  a.food = num(r, 'agent.food', a.food, traits.maxFood * 0.5, 0, traits.maxFood);
  a.energy = num(r, 'agent.energy', a.energy, 1, 0, 1);
  a.carried = num(r, 'agent.carried', a.carried, 0, 0, 1e6);

  if (typeof a.action !== 'string' || !ACTION_SET.has(a.action)) {
    r.fix('agent.action');
    a.action = 'idle';
  }
  a.actionTicks = num(r, 'agent.actionTicks', a.actionTicks, 0, 0, BIG);
  // NaN = "no positional target" (old saves may hold null)
  for (const k of ['targetX', 'targetY'] as const) {
    const t = a[k];
    if (!isFiniteNum(t)) {
      if (!(t === null || (typeof t === 'number' && t !== t))) r.fix(`agent.${k}`);
      a[k] = NaN;
    } else if (Math.abs(t) > MAX_COORD) {
      r.fix(`agent.${k}`);
      a[k] = NaN;
    }
  }
  a.targetId = agentRef(r, 'agent.targetId', refs, a.targetId);
  a.decisionCooldown = num(r, 'agent.decisionCooldown', a.decisionCooldown, 0);
  a.utilities = actionRecord(r, 'agent.utilities', a.utilities);
  a.thought = str(r, 'agent.thought', a.thought ?? '', '', 300);

  a.reproCooldown = num(r, 'agent.reproCooldown', a.reproCooldown, 0);
  a.offspring = num(r, 'agent.offspring', a.offspring, 0, 0, BIG);
  a.children = list(r, 'agent.children', a.children, AGENT_CAPS.children, true, (e) => (allocatedAgent(refs, e) ? e : null));

  if (a.tribeId !== NONE && !(isInt(a.tribeId) && refs.tribeIds.has(a.tribeId))) {
    r.fix('agent.tribeId (unknown tribe)');
    a.tribeId = NONE;
  }
  const selfId = a.id as number;
  const relSeen = new Set<number>();
  a.relationships = list(r, 'agent.relationships', a.relationships, AGENT_CAPS.relationships, false, (e) => {
    if (!isObj(e) || !allocatedAgent(refs, e.id) || e.id === selfId || relSeen.has(e.id)) return null;
    relSeen.add(e.id);
    e.affinity = num(r, 'relationship.affinity', e.affinity, 0, -1, 1);
    if (e.kin !== 0 && e.kin !== 1 && e.kin !== 2) {
      r.fix('relationship.kin');
      e.kin = 0;
    }
    e.lastTick = num(r, 'relationship.lastTick', e.lastTick, refs.tick);
    e.interactions = num(r, 'relationship.interactions', e.interactions, 0, 0, BIG);
    return e;
  });
  if (typeof a.role !== 'string' || !ROLE_SET.has(a.role)) {
    r.fix('agent.role');
    a.role = 'none';
  }
  const skills = isObj(a.skills) ? a.skills : (r.fix('agent.skills'), {} as Obj);
  for (const k of ['forage', 'combat', 'social']) skills[k] = num(r, 'agent.skills', skills[k], 0, 0, 1);
  a.skills = skills;

  a.infection = num(r, 'agent.infection', a.infection, 0, 0, BIG);
  a.virulence = num(r, 'agent.virulence', a.virulence, 0, 0, 1);
  a.immuneTicks = num(r, 'agent.immuneTicks', a.immuneTicks, 0, 0, BIG);

  const mem = isObj(a.memory) ? a.memory : (r.fix('agent.memory'), {} as Obj);
  mem.food = list(r, 'agent.memory', mem.food ?? [], AGENT_CAPS.foodMemory, false, (e) => memorySpot(r, 'agent.memory', e));
  mem.danger = list(r, 'agent.memory', mem.danger ?? [], AGENT_CAPS.dangerMemory, false, (e) => memorySpot(r, 'agent.memory', e));
  a.memory = mem;
  a.history = list(r, 'agent.history', a.history ?? [], AGENT_CAPS.history, true, (e) => {
    if (!isObj(e) || typeof e.text !== 'string') return null;
    e.tick = num(r, 'agent.history', e.tick, 0);
    if (e.text.length > 300) e.text = e.text.slice(0, 300);
    return e;
  });
  const st = isObj(a.stats) ? a.stats : (r.fix('agent.stats'), {} as Obj);
  for (const k of ['foodEaten', 'distance', 'kills', 'shared', 'received', 'fights']) st[k] = num(r, 'agent.stats', st[k] ?? 0, 0, 0, BIG);
  a.stats = st;

  if (a.deathTick !== -1 || a.deathCause !== null) {
    r.fix('agent.deathTick');
    a.deathTick = -1;
    a.deathCause = null;
  }
  a.lastAttackerId = agentRef(r, 'agent.lastAttackerId', refs, a.lastAttackerId ?? NONE);
  // documented optional extension fields
  if (a.fear !== undefined) a.fear = num(r, 'agent.fear', a.fear, 0, 0, 1);
  if (a.sinceMeal !== undefined) a.sinceMeal = num(r, 'agent.sinceMeal', a.sinceMeal, 0, 0, BIG);
}

// ---------------------------------------------------------------- tribes & lineage

function collectById(raw: unknown, what: string, cap: number, r: Repairs): Obj[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) r.note(`The ${what} list was unreadable and has been reset.`);
    return [];
  }
  const seen = new Set<number>();
  const out: Obj[] = [];
  let bad = 0;
  for (const e of raw) {
    if (!isObj(e) || !isInt(e.id) || e.id < 1 || e.id > MAX_ID || seen.has(e.id)) bad++;
    else {
      seen.add(e.id);
      out.push(e);
    }
  }
  if (bad) r.note(`Removed ${bad} invalid or duplicate ${what} record${bad === 1 ? '' : 's'}.`);
  if (out.length > cap) {
    r.note(`Too many ${what} records (${out.length}); kept ${cap}.`);
    out.splice(0, out.length - cap);
  }
  return out;
}

function sanitizeTribe(t: Obj, refs: Refs, r: Repairs): void {
  t.name = str(r, 'tribe.name', t.name, `Tribe ${t.id as number}`, 60);
  t.hue = num(r, 'tribe.hue', t.hue, 0, 0, 360);
  t.foundedTick = num(r, 'tribe.foundedTick', t.foundedTick, 0);
  t.founderId = agentRef(r, 'tribe.founderId', refs, t.founderId);
  t.homeX = coordInside(r, 'tribe.home', t.homeX, refs.W);
  t.homeY = coordInside(r, 'tribe.home', t.homeY, refs.H);
  t.stockpile = num(r, 'tribe.stockpile', t.stockpile, 0, 0, 1e9);
  for (const k of ['members', 'peakMembers', 'totalJoined', 'territory']) t[k] = num(r, `tribe.${k}`, t[k], 0, 0, BIG);
  t.extinctTick = num(r, 'tribe.extinctTick', t.extinctTick, -1, -1, BIG);
  const rel = isObj(t.relations) ? t.relations : (r.fix('tribe.relations'), {} as Obj);
  for (const k of Object.keys(rel)) {
    const id = Number(k);
    if (!allocatedTribe(refs, id) || id === t.id || String(id) !== k) {
      delete rel[k];
      r.fix('tribe.relations');
    } else rel[k] = num(r, 'tribe.relations', rel[k], 0, -1, 1);
  }
  t.relations = rel;
  t.roles = roleRecord(r, 'tribe.roles', t.roles);
  t.meanGenes = Array.isArray(t.meanGenes) && t.meanGenes.length === 0 ? [] : fixedNumArray(r, 'tribe.meanGenes', t.meanGenes, GENE_COUNT, 0.5, 0, 1);
  t.parentTribeId = tribeRef(r, 'tribe.parentTribeId', refs, t.parentTribeId ?? NONE);
}

/** Cap lineage like Simulation.pruneLineage: drop the oldest *dead* records first. */
function capLineage(lineage: Obj[], r: Repairs): Obj[] {
  if (lineage.length <= LIMITS.lineage) return lineage;
  let excess = lineage.length - LIMITS.lineage;
  r.note(`Lineage registry trimmed to ${LIMITS.lineage} records.`);
  const keep: Obj[] = [];
  for (const rec of lineage) {
    if (excess > 0 && rec.deathTick !== -1) excess--;
    else keep.push(rec);
  }
  return excess > 0 ? keep.slice(excess) : keep;
}

function sanitizeLineage(l: Obj, refs: Refs, r: Repairs): void {
  l.name = str(r, 'lineage.name', l.name, 'Nameless', 40);
  l.parents = parentPair(r, 'lineage.parents', refs, l.parents);
  l.generation = int(r, 'lineage.generation', l.generation, 0, 0, 1e9);
  l.birthTick = num(r, 'lineage.birthTick', l.birthTick, 0);
  l.deathTick = num(r, 'lineage.deathTick', l.deathTick, -1, -1, BIG);
  if (l.deathCause !== null && !(typeof l.deathCause === 'string' && CAUSE_SET.has(l.deathCause))) {
    r.fix('lineage.deathCause');
    l.deathCause = null;
  }
  l.hue = num(r, 'lineage.hue', l.hue, 0, 0, 360);
  l.tribeId = tribeRef(r, 'lineage.tribeId', refs, l.tribeId ?? NONE);
  l.offspring = num(r, 'lineage.offspring', l.offspring, 0, 0, BIG);
}

// ---------------------------------------------------------------- interventions

const coord = (v: unknown): number | null => (isFiniteNum(v) ? clamp(v, -MAX_COORD, MAX_COORD) : null);
const radius = (v: unknown): number | null => (isFiniteNum(v) ? clamp(v, 0, MAX_COORD) : null);

function sanitizeTemplate(v: unknown, r: Repairs): GenomeTemplate | undefined {
  if (!isObj(v)) {
    r.fix('intervention.template');
    return undefined;
  }
  const t: GenomeTemplate = {};
  for (const g of GENES) {
    if (v[g] === undefined) continue;
    if (isFiniteNum(v[g])) t[g] = clamp(v[g], 0, 1);
    else r.fix('intervention.template');
  }
  if (v.spread !== undefined) {
    if (isFiniteNum(v.spread)) t.spread = clamp(v.spread, 0, 1);
    else r.fix('intervention.template');
  }
  return t;
}

/** Validate one intervention (scheduled events, intervention log). Returns null when unusable. Valid values pass unchanged. */
function sanitizeIntervention(v: unknown, r: Repairs): Intervention | null {
  if (!isObj(v)) return null;
  const kind = v.kind;
  if (kind === 'setConfig') return isObj(v.patch) ? { kind, patch: sanitizeConfigPatch(v.patch, r) } : null;
  if (kind === 'killAgent') return isInt(v.id) ? { kind, id: v.id } : null;
  if (kind === 'boostAgent') return isInt(v.id) ? { kind, id: v.id } : null;
  const x = coord(v.x);
  const y = coord(v.y);
  const rad = radius(v.radius);
  if (x === null || y === null || rad === null) return null;
  switch (kind) {
    case 'spawn': {
      if (!isFiniteNum(v.count)) return null;
      const out: Extract<Intervention, { kind: 'spawn' }> = { kind, x, y, count: clamp(v.count, 0, 100_000), radius: rad };
      if (v.template !== undefined) {
        const t = sanitizeTemplate(v.template, r);
        if (t) out.template = t;
      }
      if (v.tribe !== undefined) {
        if (v.tribe === 'new' || v.tribe === 'none' || isInt(v.tribe)) out.tribe = v.tribe;
        else r.fix('intervention.tribe');
      }
      if (typeof v.tribeName === 'string') out.tribeName = v.tribeName.slice(0, 60);
      return out;
    }
    case 'remove':
      return { kind, x, y, radius: rad };
    case 'removeFood':
      return { kind, x, y, radius: rad };
    case 'addFood':
      return isFiniteNum(v.amount) ? { kind, x, y, radius: rad, amount: clamp(v.amount, -1e7, 1e7) } : null;
    case 'fertilize':
      return isFiniteNum(v.amount) ? { kind, x, y, radius: rad, amount: clamp(v.amount, -1e7, 1e7) } : null;
    case 'paintTerrain':
      return isInt(v.terrain) && v.terrain >= 0 && v.terrain < TERRAIN_COUNT ? { kind, x, y, radius: rad, terrain: v.terrain as TerrainType } : null;
    case 'disaster':
      if (typeof v.disaster !== 'string' || !DISASTER_SET.has(v.disaster) || !isFiniteNum(v.intensity) || !isFiniteNum(v.duration)) return null;
      return {
        kind,
        disaster: v.disaster as DisasterKind,
        x,
        y,
        radius: rad,
        intensity: clamp(v.intensity, 0, 10),
        duration: clamp(v.duration, 0, BIG),
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- stats

const SAMPLE_NUM_KEYS = [
  'tick', 'population', 'births', 'deaths', 'avgHealth', 'avgEnergy', 'avgHunger', 'avgAge', 'totalFood',
  'avgFertility', 'infected', 'tribeCount', 'meanGeneration', 'maxGeneration', 'fights', 'shares',
] as const;

function sanitizeSample(e: unknown, r: Repairs): Obj | null {
  if (!isObj(e)) return null;
  for (const k of SAMPLE_NUM_KEYS) e[k] = num(r, 'stats.samples', e[k] ?? 0, 0, -1e15, 1e15);
  e.deathsByCause = causeRecord(r, 'stats.samples', e.deathsByCause);
  e.geneMeans = fixedNumArray(r, 'stats.samples', e.geneMeans, GENE_COUNT, 0, -1e15, 1e15);
  e.geneStd = fixedNumArray(r, 'stats.samples', e.geneStd, GENE_COUNT, 0, -1e15, 1e15);
  e.geneHist = fixedNumArray(r, 'stats.samples', e.geneHist, GENE_COUNT * HIST_BINS, 0, -1e15, 1e15);
  e.tribePops = list(r, 'stats.samples', e.tribePops ?? [], 10_000, false, (p) =>
    Array.isArray(p) && p.length === 2 && isInt(p[0]) && isFiniteNum(p[1]) ? p : null,
  );
  e.roles = roleRecord(r, 'stats.samples', e.roles ?? {});
  e.actions = actionRecord(r, 'stats.samples', e.actions ?? {});
  return e;
}

function sanitizeStats(raw: unknown, r: Repairs): StatsState {
  const def = createStatsState();
  if (!isObj(raw)) {
    r.note('Statistics history was missing — charts restart from now.');
    return def;
  }
  // fill any missing top-level field (including module extensions) from the defaults
  for (const [k, v] of Object.entries(def)) if (!has(raw, k)) raw[k] = v;
  raw.sampleInterval = int(r, 'stats.sampleInterval', raw.sampleInterval, def.sampleInterval, 1, 1_000_000);
  raw.samples = list(r, 'stats.samples', raw.samples, LIMITS.statSamples, true, (e) => sanitizeSample(e, r));
  const c = isObj(raw.counters) ? raw.counters : (r.fix('stats.counters'), { ...def.counters } as unknown as Obj);
  for (const k of ['births', 'deaths', 'fights', 'shares']) c[k] = num(r, 'stats.counters', c[k] ?? 0, 0, 0, BIG);
  c.deathsByCause = causeRecord(r, 'stats.counters', c.deathsByCause);
  raw.counters = c;
  const t = isObj(raw.totals) ? raw.totals : (r.fix('stats.totals'), { ...def.totals } as unknown as Obj);
  for (const k of ['births', 'deaths', 'peakPopulation', 'peakTick']) t[k] = num(r, 'stats.totals', t[k] ?? 0, 0, 0, BIG);
  raw.totals = t;
  return raw as unknown as StatsState;
}

// ---------------------------------------------------------------- root

const STATE_KEYS = new Set([
  'version', 'scenarioId', 'config', 'tick', 'rngState', 'nextAgentId', 'nextTribeId', 'nextEventId', 'nextDisasterId',
  'world', 'env', 'agents', 'tribes', 'lineage', 'events', 'disasters', 'scheduled', 'interventionLog', 'stats',
]);

/** Next free id: the saved counter when it is sane, but always above every id in use. */
function nextId(r: Repairs, field: string, v: unknown, maxUsed: number): number {
  const min = maxUsed + 1;
  if (isInt(v) && v >= min && v <= MAX_ID + 1) return v;
  r.fix(field);
  return Math.max(min, 1);
}

function sanitizeState(raw: Obj, r: Repairs): SimState {
  // --- tick
  const tickRaw = raw.tick;
  if (!isFiniteNum(tickRaw) || tickRaw < 0 || tickRaw > MAX_TICK) throw new Error('Cannot load: the save is corrupted (missing or invalid simulation tick).');
  const tick = Math.floor(tickRaw);
  if (tick !== tickRaw) r.fix('tick');

  // --- world, config, environment
  const world = sanitizeWorld(raw.world, r);
  const config = sanitizeConfig(raw.config, r);
  if (config.worldWidth !== world.width || config.worldHeight !== world.height || config.tileSize !== world.tileSize) {
    if (isObj(raw.config)) r.note('World-size settings did not match the stored map and were corrected.');
    config.worldWidth = world.width;
    config.worldHeight = world.height;
    config.tileSize = world.tileSize;
  }
  const env = sanitizeEnv(raw.env, config, r);

  // --- RNG
  let rngState: number[];
  const rs = raw.rngState;
  if (Array.isArray(rs) && rs.length === 4 && rs.every((v) => isInt(v) && v >= -(2 ** 31) && v < 2 ** 32)) {
    rngState = rs.map((v: number) => v >>> 0);
  } else {
    rngState = new Rng((config.seed ^ tick) >>> 0, 7).getState();
    r.note('Random-number generator state was missing or corrupt — re-seeded (the run continues, but no longer matches the original).');
  }

  // --- pass 1: identities, then id counters (references are validated against them)
  const agents = collectAgents(raw.agents, r);
  const lineage = capLineage(collectById(raw.lineage, 'lineage', Number.MAX_SAFE_INTEGER, r), r);
  const tribes = collectById(raw.tribes, 'tribe', MAX_TRIBES_HARD, r);
  let maxAgentId = 0;
  for (const a of agents) maxAgentId = Math.max(maxAgentId, a.id as number);
  for (const l of lineage) maxAgentId = Math.max(maxAgentId, l.id as number);
  let maxTribeId = 0;
  for (const t of tribes) maxTribeId = Math.max(maxTribeId, t.id as number);
  const refs: Refs = {
    tick,
    W: world.width * world.tileSize,
    H: world.height * world.tileSize,
    nextAgentId: nextId(r, 'nextAgentId', raw.nextAgentId, maxAgentId),
    nextTribeId: nextId(r, 'nextTribeId', raw.nextTribeId, maxTribeId),
    tribeIds: new Set(tribes.map((t) => t.id as number)),
  };

  // --- pass 2: fields & references
  for (const a of agents) sanitizeAgent(a, refs, r);
  for (const t of tribes) sanitizeTribe(t, refs, r);
  for (const l of lineage) sanitizeLineage(l, refs, r);
  let badTerr = 0;
  const terr = world.territory;
  for (let i = 0; i < terr.length; i++) {
    const t = terr[i];
    if (t !== NONE && !(t >= 1 && t < refs.nextTribeId)) {
      terr[i] = NONE;
      badTerr++;
    }
  }
  if (badTerr) r.fix('world.territory', badTerr);

  // --- logs & schedules
  let maxEventId = 0;
  const events = list(r, 'events', raw.events, LIMITS.events, true, (e) => {
    if (!isObj(e) || !isInt(e.id) || e.id < 0 || typeof e.message !== 'string') return null;
    maxEventId = Math.max(maxEventId, e.id);
    e.tick = num(r, 'events', e.tick, 0, 0, MAX_TICK);
    if (typeof e.category !== 'string' || !CATEGORY_SET.has(e.category)) (r.fix('events'), (e.category = 'environment'));
    if (typeof e.severity !== 'string' || !SEVERITY_SET.has(e.severity)) (r.fix('events'), (e.severity = 'info'));
    if (e.message.length > 500) e.message = e.message.slice(0, 500);
    for (const k of ['x', 'y']) if (e[k] !== undefined && !isFiniteNum(e[k])) (r.fix('events'), delete e[k]);
    for (const k of ['agentId', 'tribeId']) if (e[k] !== undefined && !isInt(e[k])) (r.fix('events'), delete e[k]);
    return e;
  });
  let maxDisasterId = 0;
  const disasters = list(r, 'disasters', raw.disasters, MAX_DISASTERS, true, (d) => {
    if (!isObj(d) || !isInt(d.id) || d.id < 1 || typeof d.kind !== 'string' || !DISASTER_SET.has(d.kind) || !isFiniteNum(d.x) || !isFiniteNum(d.y)) return null;
    maxDisasterId = Math.max(maxDisasterId, d.id);
    d.radius = num(r, 'disasters', d.radius, 0, 0, MAX_COORD);
    d.startTick = num(r, 'disasters', d.startTick, tick, -BIG, BIG);
    d.duration = num(r, 'disasters', d.duration, 0, 0, BIG);
    d.intensity = num(r, 'disasters', d.intensity, 0.5, 0, 1);
    d.active = bool(r, 'disasters', d.active, true);
    return d;
  });
  const scheduled = list(r, 'scheduled', raw.scheduled, MAX_SCHEDULED, false, (e) => {
    if (!isObj(e) || !isInt(e.tick) || e.tick < 0) return null;
    const iv = sanitizeIntervention(e.intervention, r);
    if (!iv) return null;
    const out: Obj = { tick: e.tick, intervention: iv };
    if (typeof e.note === 'string') out.note = e.note.slice(0, 300);
    if (e.repeat !== undefined) {
      if (isInt(e.repeat) && e.repeat > 0) out.repeat = e.repeat;
      else r.fix('scheduled.repeat');
    }
    return out;
  });
  const interventionLog = list(r, 'interventionLog', raw.interventionLog, LIMITS.interventionLog, true, (e) => {
    if (!isObj(e) || !isInt(e.tick) || e.tick < 0) return null;
    const iv = sanitizeIntervention(e.intervention, r);
    return iv ? { tick: e.tick, intervention: iv } : null;
  });

  for (const k of Object.keys(raw)) if (!STATE_KEYS.has(k)) r.note(`Ignored unknown save field "state.${k}".`);

  const state: SimState = {
    version: SAVE_VERSION,
    scenarioId: str(r, 'scenarioId', raw.scenarioId, 'custom', 64),
    config,
    tick,
    rngState,
    nextAgentId: refs.nextAgentId,
    nextTribeId: refs.nextTribeId,
    nextEventId: nextId(r, 'nextEventId', raw.nextEventId, maxEventId),
    nextDisasterId: nextId(r, 'nextDisasterId', raw.nextDisasterId, maxDisasterId),
    world,
    env,
    agents: agents as unknown as SimState['agents'],
    tribes: tribes as unknown as SimState['tribes'],
    lineage: lineage as unknown as SimState['lineage'],
    events: events as unknown as SimState['events'],
    disasters: disasters as unknown as SimState['disasters'],
    scheduled: scheduled as unknown as SimState['scheduled'],
    interventionLog: interventionLog as unknown as SimState['interventionLog'],
    stats: sanitizeStats(raw.stats, r),
  };
  return state;
}
