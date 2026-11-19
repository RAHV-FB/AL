// OWNER: UI shell. Sandbox tool definitions, tool to intervention mapping and
// throttled drag-painting. Every world change goes through sim.enqueue().
import { TERRAIN_INFO } from '../sim/constants';
import { DISASTER_INFO } from '../sim/disasters';
import * as ivModule from '../sim/interventions';
import { TERRAIN, type DisasterKind, type Intervention, type TerrainType } from '../sim/types';

export type ToolId = 'inspect' | 'spawn' | 'remove' | 'addFood' | 'removeFood' | 'fertilize' | 'terrain' | 'disaster' | 'bless';

export interface ToolDef {
  id: ToolId;
  key: string;
  name: string;
  icon: string;
  /** select = click agents + drag to pan; click = one action per click (drag pans); paint = drag-painting brush. */
  mode: 'select' | 'click' | 'paint';
  /** Shows a brush circle and uses the brush radius. */
  brush: boolean;
  /** Repeats while the mouse is held still (accumulating effects). */
  airbrush: boolean;
  color: string;
  /** How to use the tool. */
  how: string;
  /** What it does (fallback when the simulation provides no INTERVENTION_HELP entry). */
  what: string;
}

export const TOOLS: ToolDef[] = [
  { id: 'inspect', key: '1', name: 'Inspect', icon: 'inspect', mode: 'select', brush: false, airbrush: false, color: '', how: 'Click an agent to see what it is doing and why. Drag to move the map; double-click an agent to follow it.', what: 'The Agent tab shows its needs, the options it weighed, its genes, family, friends and life story.' },
  { id: 'spawn', key: '2', name: 'Add agents', icon: 'spawn', mode: 'click', brush: true, airbrush: false, color: 'rgba(143,181,115,0.95)', how: 'Click the map to place a group inside the circle.', what: 'Adds adult agents with the genes and tribe you choose here.' },
  { id: 'remove', key: '3', name: 'Remove agents', icon: 'remove', mode: 'paint', brush: true, airbrush: true, color: 'rgba(207,91,69,0.95)', how: 'Click or drag over agents to remove them.', what: 'Removes every agent inside the circle. They count as removed in the death statistics.' },
  { id: 'addFood', key: '4', name: 'Add food', icon: 'food', mode: 'paint', brush: true, airbrush: true, color: 'rgba(170,200,120,0.95)', how: 'Click or drag. Hold the button still to keep adding.', what: 'Adds food to every tile under the circle.' },
  { id: 'removeFood', key: '5', name: 'Remove food', icon: 'nofood', mode: 'paint', brush: true, airbrush: true, color: 'rgba(214,166,72,0.95)', how: 'Click or drag to strip the land bare. Plants grow back over time.', what: 'Removes all standing food from the tiles under the circle.' },
  { id: 'fertilize', key: '6', name: 'Fertilize', icon: 'sprout', mode: 'paint', brush: true, airbrush: true, color: 'rgba(190,196,110,0.95)', how: 'Click or drag. Hold the button still to keep enriching the soil.', what: 'Makes the soil richer, so tiles hold more food and regrow faster. Repairs overgrazed land.' },
  { id: 'terrain', key: '7', name: 'Paint terrain', icon: 'terrain', mode: 'paint', brush: true, airbrush: false, color: 'rgba(232,227,216,0.95)', how: 'Click or drag to paint. A wall or deep water splits a population in two.', what: 'Changes the land under the circle to the chosen terrain.' },
  { id: 'disaster', key: '8', name: 'Disaster', icon: 'bolt', mode: 'click', brush: true, airbrush: false, color: 'rgba(207,91,69,0.95)', how: 'Click the map to start it inside the circle, or start it on the whole map.', what: 'Starts a disaster with the chosen strength and length.' },
  { id: 'bless', key: '9', name: 'Bless or smite', icon: 'hand', mode: 'click', brush: false, airbrush: false, color: '', how: 'Click an agent to heal and feed it. Shift-click an agent to kill it.', what: 'Blessing fully heals, feeds and rests one agent. Smiting kills it at once.' },
];

export const toolById = (id: ToolId): ToolDef => TOOLS.find((t) => t.id === id) ?? TOOLS[0];

/** Per-intervention explanations from the simulation module when available (optional export). */
const SIM_HELP: Partial<Record<string, string>> =
  ((ivModule as unknown as { INTERVENTION_HELP?: Partial<Record<string, string>> }).INTERVENTION_HELP) ?? {};

/** Which intervention kind a tool produces (for INTERVENTION_HELP lookups). */
const TOOL_KIND: Record<ToolId, string[]> = {
  inspect: [],
  spawn: ['spawn'],
  remove: ['remove'],
  addFood: ['addFood'],
  removeFood: ['removeFood'],
  fertilize: ['fertilize'],
  terrain: ['paintTerrain'],
  disaster: ['disaster'],
  bless: ['boostAgent', 'killAgent'],
};

export function simHelpFor(tool: ToolId): string[] {
  const out: string[] = [];
  for (const k of TOOL_KIND[tool]) {
    const s = SIM_HELP[k];
    if (typeof s === 'string' && s.trim()) out.push(s.trim());
  }
  return out;
}

export interface ToolSettings {
  radius: number;
  foodAmount: number;
  fertilizeAmount: number;
  terrain: TerrainType;
  disaster: DisasterKind;
  intensity: number;
  /** Disaster duration in in-game days (times config.dayLength ticks). */
  durationDays: number;
}

export const DEFAULT_SETTINGS: ToolSettings = {
  radius: 40,
  foodAmount: 6,
  fertilizeAmount: 0.3,
  terrain: TERRAIN.Wall,
  disaster: 'drought',
  intensity: 0.7,
  durationDays: 2,
};

export const TERRAIN_ORDER: TerrainType[] = [TERRAIN.Grass, TERRAIN.Forest, TERRAIN.Sand, TERRAIN.Desert, TERRAIN.Rock, TERRAIN.Water, TERRAIN.DeepWater, TERRAIN.Wall];

export function terrainColor(t: TerrainType, a = 1): string {
  const c = TERRAIN_INFO[t].color;
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** Brush preview colour for the tool. */
export function brushColor(tool: ToolDef, s: ToolSettings): string {
  if (tool.id === 'terrain') {
    const c = TERRAIN_INFO[s.terrain].color;
    // lighten dark terrains so the ring stays visible
    const l = (v: number) => Math.min(255, Math.round(v * 0.55 + 120));
    return `rgba(${l(c[0])},${l(c[1])},${l(c[2])},0.95)`;
  }
  return tool.color || 'rgba(255,255,255,0.8)';
}

/** Help text for the active tool: how to use it, what it does, and the current choice. */
export function toolHelp(tool: ToolDef, s: ToolSettings): { title: string; lines: string[] } {
  const lines: string[] = [tool.how];
  const sim = simHelpFor(tool.id);
  lines.push(sim.length ? sim.join(' ') : tool.what);
  const extra = choiceHelp(tool, s);
  if (extra) lines.push(extra);
  return { title: tool.name, lines };
}

/** One line about the current terrain or disaster choice (empty for other tools). */
export function choiceHelp(tool: ToolDef, s: ToolSettings): string {
  if (tool.id === 'terrain') {
    const info = TERRAIN_INFO[s.terrain];
    const speed = info.passable ? ` Walking speed ${Math.round(info.moveCost * 100)}%.` : '';
    return `${info.name}: ${info.description}${speed}`;
  }
  if (tool.id === 'disaster') {
    const d = DISASTER_INFO[s.disaster];
    return `${d.label}: ${d.help}`;
  }
  if (tool.id === 'remove') return 'Removed agents count as removed in the death statistics.';
  return '';
}

/** Largest impact radius the Disaster tool requests for a meteor (world units). */
export const METEOR_MAX_RADIUS = 120;

/** Radius the tool really affects: the brush preview must show this, not the raw slider value. */
export function effectiveRadius(tool: ToolId, s: ToolSettings): number {
  return tool === 'disaster' && s.disaster === 'meteor' ? Math.min(s.radius, METEOR_MAX_RADIUS) : s.radius;
}

/** Build the intervention a brush/click tool applies at world point (x,y). */
export function brushIntervention(tool: ToolId, s: ToolSettings, x: number, y: number, dayLength: number): Intervention | null {
  const radius = effectiveRadius(tool, s);
  switch (tool) {
    case 'remove':
      return { kind: 'remove', x, y, radius };
    case 'addFood':
      return { kind: 'addFood', x, y, radius, amount: s.foodAmount };
    case 'removeFood':
      return { kind: 'removeFood', x, y, radius };
    case 'fertilize':
      return { kind: 'fertilize', x, y, radius, amount: s.fertilizeAmount };
    case 'terrain':
      return { kind: 'paintTerrain', x, y, radius, terrain: s.terrain };
    case 'disaster':
      return {
        kind: 'disaster',
        disaster: s.disaster,
        x,
        y,
        radius,
        intensity: s.intensity,
        duration: Math.max(1, Math.round(s.durationDays * dayLength)),
      };
    default:
      return null;
  }
}

/**
 * Throttled drag painter: stamps along the pointer path at most every ~40 ms,
 * spaced radius/2 apart (interpolated so fast strokes leave no gaps), and
 * repeats while held still for accumulating ("airbrush") tools.
 */
export class Painter {
  private active = false;
  private lx = 0;
  private ly = 0;
  private lt = 0;

  constructor(private emit: (x: number, y: number) => void) {}

  get painting(): boolean {
    return this.active;
  }

  begin(x: number, y: number, now: number): void {
    this.active = true;
    this.lx = x;
    this.ly = y;
    this.lt = now;
    this.emit(x, y);
  }

  move(x: number, y: number, radius: number, now: number, airbrush: boolean, force = false): void {
    if (!this.active) return;
    if (!force && now - this.lt < 40) return;
    const dx = x - this.lx;
    const dy = y - this.ly;
    const d = Math.hypot(dx, dy);
    const spacing = Math.max(1.5, radius / 2);
    if (d < spacing) {
      if (airbrush && now - this.lt > 280) {
        this.emit(x, y);
        this.lt = now;
      }
      return;
    }
    const n = Math.min(24, Math.max(1, Math.floor(d / spacing)));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      this.emit(this.lx + dx * t, this.ly + dy * t);
    }
    this.lx = x;
    this.ly = y;
    this.lt = now;
  }

  /** Airbrush tick from the frame loop (pointer held still). */
  hold(radius: number, now: number, airbrush: boolean): void {
    if (this.active && airbrush) this.move(this.lx, this.ly, radius, now, true);
  }

  end(x?: number, y?: number, radius = 0, now = 0): void {
    if (this.active && x !== undefined && y !== undefined) this.move(x, y, radius, now, false, true);
    this.active = false;
  }
}
