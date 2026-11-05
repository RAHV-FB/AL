// OWNER: UI/UX agent. Sandbox tool definitions, tool → intervention mapping and
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
  blurb: string;
}

export const TOOLS: ToolDef[] = [
  { id: 'inspect', key: '1', name: 'Inspect', icon: 'inspect', mode: 'select', brush: false, airbrush: false, color: '', blurb: 'Click an agent to select it and open the Inspector (mind, genes, family, relationships). Drag to pan. Double-click an agent to follow it with the camera.' },
  { id: 'spawn', key: '2', name: 'Spawn agents', icon: 'spawn', mode: 'click', brush: true, airbrush: false, color: 'rgba(46,230,208,0.95)', blurb: 'Click to drop a group of new adult agents inside the brush circle, using the genome from the Population Designer below. Choose whether they found a new tribe, join one, or stay unaffiliated.' },
  { id: 'remove', key: '3', name: 'Remove agents', icon: 'remove', mode: 'paint', brush: true, airbrush: true, color: 'rgba(255,93,108,0.95)', blurb: 'Click or drag to remove every agent inside the brush. They are recorded as "removed" deaths in the statistics.' },
  { id: 'addFood', key: '4', name: 'Add food', icon: 'food', mode: 'paint', brush: true, airbrush: true, color: 'rgba(124,230,110,0.95)', blurb: 'Click or drag to scatter food on the ground inside the brush (each tile is capped at its capacity). Hold still to keep adding.' },
  { id: 'removeFood', key: '5', name: 'Remove food', icon: 'nofood', mode: 'paint', brush: true, airbrush: true, color: 'rgba(245,177,76,0.95)', blurb: 'Click or drag to strip all standing food inside the brush. Plants regrow over time at the tile\'s normal rate.' },
  { id: 'fertilize', key: '6', name: 'Fertilize', icon: 'sprout', mode: 'paint', brush: true, airbrush: true, color: 'rgba(190,240,90,0.95)', blurb: 'Click or drag to enrich the soil. Fertility raises how much food each tile can hold and how fast it regrows — and repairs overgrazed land.' },
  { id: 'terrain', key: '7', name: 'Paint terrain', icon: 'terrain', mode: 'paint', brush: true, airbrush: false, color: 'rgba(210,220,236,0.95)', blurb: 'Click or drag to repaint terrain. Walls and deep water split populations (try it to watch speciation); forest and grassland create new gardens.' },
  { id: 'disaster', key: '8', name: 'Disaster', icon: 'bolt', mode: 'click', brush: true, airbrush: false, color: 'rgba(228,91,214,0.95)', blurb: 'Click to unleash the chosen disaster centred on the cursor, covering the brush circle, with the intensity and duration below.' },
  { id: 'bless', key: '9', name: 'Bless / Smite', icon: 'heart', mode: 'click', brush: false, airbrush: false, color: '', blurb: 'Click an agent to bless it: fully healed and fed. Shift-click an agent to smite it (instant death). Drag to pan.' },
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
  /** Disaster duration in in-game days (× config.dayLength ticks). */
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

/** Long help text for the active tool (shown in the help box). */
export function toolHelp(tool: ToolDef, s: ToolSettings): { title: string; lines: string[] } {
  const lines: string[] = [tool.blurb];
  if (tool.id === 'terrain') {
    const info = TERRAIN_INFO[s.terrain];
    lines.push(`${info.name}: ${info.description}${info.passable ? ` Movement ×${info.moveCost}.` : ''}`);
  } else if (tool.id === 'disaster') {
    const d = DISASTER_INFO[s.disaster];
    lines.push(`${d.icon} ${d.label}: ${d.help}`);
  }
  for (const extra of simHelpFor(tool.id)) if (!lines.includes(extra)) lines.push(extra);
  return { title: tool.name, lines };
}

/** Build the intervention a brush/click tool applies at world point (x,y). */
export function brushIntervention(tool: ToolId, s: ToolSettings, x: number, y: number, dayLength: number): Intervention | null {
  const radius = s.radius;
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
        radius: s.disaster === 'meteor' ? Math.min(radius, 120) : radius,
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
