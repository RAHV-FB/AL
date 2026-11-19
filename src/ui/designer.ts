// OWNER: UI shell. Settings of the Add agents tool: group size, tribe, a preset genome
// (always visible) and the gene sliders (folded under "Customize genes").
import type { Simulation } from '../sim/simulation';
import { expressTraits } from '../sim/genetics';
import { GENES, type GeneName, type GenomeTemplate, type SpawnSpec } from '../sim/types';
import { chips, fmtInt, fold, h, slider, type SliderCtl } from './dom';

export const GENE_LABEL: Record<GeneName, string> = {
  speed: 'Speed',
  size: 'Size',
  perception: 'Perception',
  metabolism: 'Metabolism',
  aggression: 'Aggression',
  sociability: 'Sociability',
  altruism: 'Altruism',
  fertility: 'Fertility',
  longevity: 'Longevity',
  immunity: 'Immunity',
  efficiency: 'Efficiency',
  hue: 'Colour',
};

export const GENE_HELP: Record<GeneName, string> = {
  speed: 'How fast it moves. Fast agents reach food and escape danger first, but every stride costs energy.',
  size: 'Body size: more strength and health, and a hungrier body.',
  perception: 'How far away it notices food, mates and threats. Slightly costly.',
  metabolism: 'Heals and recovers faster, and burns food faster.',
  aggression: 'How readily it fights rivals and takes their food.',
  sociability: 'How much it wants company. Holds tribes together.',
  altruism: 'How readily it shares food with hungry friends and family.',
  fertility: 'High: many children that each get little. Low: few children that each get more.',
  longevity: 'How long it can live. Costs upkeep.',
  immunity: 'Resistance to disease. Costs upkeep.',
  efficiency: 'How much food it gets from each bite.',
  hue: 'Body colour only, with no effect on survival. Use it to follow this group and its descendants on the map. It drifts over the generations.',
};

interface Preset {
  id: string;
  name: string;
  tip: string;
  genes: Partial<Record<GeneName, number>>;
  spread: number;
}

const PRESETS: Preset[] = [
  { id: 'balanced', name: 'Balanced', tip: 'Average in every gene, with some variation.', genes: { speed: 0.5, size: 0.5, perception: 0.5, metabolism: 0.5, aggression: 0.4, sociability: 0.55, altruism: 0.5, fertility: 0.5, longevity: 0.5, immunity: 0.5, efficiency: 0.5, hue: 0.18 }, spread: 0.1 },
  { id: 'gentle', name: 'Gentle foragers', tip: 'Peaceful, social and generous gatherers who get a lot from each bite.', genes: { speed: 0.45, size: 0.42, perception: 0.6, metabolism: 0.4, aggression: 0.04, sociability: 0.85, altruism: 0.88, fertility: 0.55, longevity: 0.55, immunity: 0.5, efficiency: 0.85, hue: 0.33 }, spread: 0.06 },
  { id: 'raiders', name: 'Warlike raiders', tip: 'Big, aggressive and selfish. They take food by force.', genes: { speed: 0.62, size: 0.75, perception: 0.6, metabolism: 0.65, aggression: 0.96, sociability: 0.5, altruism: 0.08, fertility: 0.5, longevity: 0.4, immunity: 0.5, efficiency: 0.45, hue: 0.0 }, spread: 0.06 },
  { id: 'scouts', name: 'Swift scouts', tip: 'Small, very fast explorers who see far. Good at finding food, weak in a fight.', genes: { speed: 0.95, size: 0.28, perception: 0.92, metabolism: 0.6, aggression: 0.25, sociability: 0.35, altruism: 0.4, fertility: 0.55, longevity: 0.4, immunity: 0.4, efficiency: 0.55, hue: 0.56 }, spread: 0.06 },
  { id: 'giants', name: 'Hardy giants', tip: 'Huge, slow, long-lived and resistant to disease, with few children.', genes: { speed: 0.3, size: 0.95, perception: 0.45, metabolism: 0.35, aggression: 0.5, sociability: 0.5, altruism: 0.5, fertility: 0.28, longevity: 0.88, immunity: 0.88, efficiency: 0.6, hue: 0.1 }, spread: 0.06 },
  { id: 'random', name: 'Random', tip: 'Random gene values and colour.', genes: {}, spread: 0.08 },
];

/** Body colour used for the designer swatch (same formula as tribe colours on the map). */
const hueCss = (g: number): string => `hsl(${Math.round(g * 360)}, 45%, 58%)`;

export class PopulationDesigner {
  readonly el: HTMLElement;
  genes = {} as Record<GeneName, number>;
  spread = 0.08;
  count = 20;
  tribe: 'new' | 'none' | number = 'new';
  tribeName = '';
  private geneSliders = new Map<GeneName, SliderCtl>();
  private spreadSlider: SliderCtl;
  private tribeSelect: HTMLSelectElement;
  private nameInput: HTMLInputElement;
  private preview: HTMLElement;
  private swatch: HTMLElement;
  private presetChips: { el: HTMLElement; set(v: string): void };

  constructor(private getSim: () => Simulation) {
    for (const g of GENES) this.genes[g] = 0.5;
    const countSlider = slider({ label: 'Group size', min: 1, max: 100, step: 1, value: this.count, help: 'Agents placed per click, spread over the circle. Nothing is added once the population cap is reached.', onInput: (v) => (this.count = v) });
    this.presetChips = chips(
      PRESETS.map((p) => ({ value: p.id, label: p.name, tip: p.tip })),
      'balanced',
      (id) => this.applyPreset(id),
      'chips presets',
    );
    const grid = h('div', { class: 'gene-grid' });
    for (const g of GENES) {
      const s = slider({
        label: GENE_LABEL[g],
        min: 0,
        max: 1,
        step: 0.01,
        value: 0.5,
        help: GENE_HELP[g],
        cls: g === 'hue' ? 'wide' : '',
        fmt: g === 'hue' ? (v) => `${Math.round(v * 360)}` : undefined,
        onInput: (v) => {
          this.genes[g] = v;
          this.presetChips.set('');
          this.refreshPreview();
        },
      });
      this.geneSliders.set(g, s);
      grid.append(s.el);
    }
    this.spreadSlider = slider({ label: 'Variation', min: 0, max: 0.3, step: 0.01, value: this.spread, help: 'How much the agents differ from each other around these values. 0 makes identical clones; more variation gives natural selection more to work with.', onInput: (v) => (this.spread = v) });
    this.tribeSelect = h('select', { class: 'select', 'aria-label': 'Tribe', onchange: () => this.readTribe() });
    this.nameInput = h('input', { type: 'text', class: 'text', placeholder: 'Tribe name (optional)', maxlength: 24, 'aria-label': 'New tribe name', oninput: () => (this.tribeName = this.nameInput.value.trim()) });
    this.swatch = h('span', { class: 'designer-swatch', 'aria-hidden': 'true' });
    this.preview = h('div', { class: 'designer-preview', tip: 'Traits of an average agent from this group: speed in world units per tick, vision radius in world units, maximum health and maximum lifespan in ticks.' });
    const genes = fold('Customize genes', 'genes');
    genes.body.append(grid, this.spreadSlider.el);
    this.el = h(
      'div',
      { class: 'designer' },
      countSlider.el,
      h('div', { class: 'ctl', tip: 'New agents can found a tribe with a camp where you click, join a living tribe, or stay on their own and maybe join one later.' }, h('div', { class: 'ctl-row' }, h('span', { class: 'ctl-label' }, 'Tribe')), h('div', { class: 'stack' }, this.tribeSelect, this.nameInput)),
      h('div', { class: 'sub-title' }, h('span', null, 'Genes'), this.swatch),
      this.presetChips.el,
      this.preview,
      genes.el,
    );
    this.refreshTribes();
    this.applyPreset('balanced');
  }

  private readTribe(): void {
    const v = this.tribeSelect.value;
    this.tribe = v === 'new' || v === 'none' ? v : Number(v);
    this.nameInput.style.display = this.tribe === 'new' ? '' : 'none';
  }

  /** Rebuild the tribe list (living tribes) keeping the current choice when possible. */
  refreshTribes(): void {
    if (document.activeElement === this.tribeSelect) return; // never disturb an open dropdown
    let sim: Simulation | null = null;
    try {
      sim = this.getSim();
    } catch {
      sim = null;
    }
    const cur = this.tribeSelect.value || String(this.tribe);
    const opts: HTMLOptionElement[] = [h('option', { value: 'new' }, 'Found a new tribe'), h('option', { value: 'none' }, 'No tribe')];
    if (sim) {
      const alive = sim.state.tribes.filter((t) => t.extinctTick === -1).sort((a, b) => b.members - a.members);
      for (const t of alive.slice(0, 40)) opts.push(h('option', { value: String(t.id) }, `Join ${t.name} (${t.members})`));
    }
    this.tribeSelect.replaceChildren(...opts);
    this.tribeSelect.value = opts.some((o) => o.value === cur) ? cur : 'new';
    this.readTribe();
  }

  applyPreset(id: string): void {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    for (const g of GENES) {
      let v = p.genes[g];
      if (p.id === 'random') v = g === 'hue' ? Math.random() : Math.round((0.1 + Math.random() * 0.8) * 100) / 100;
      this.genes[g] = v ?? 0.5;
      this.geneSliders.get(g)?.set(this.genes[g]);
    }
    this.spread = p.spread;
    this.spreadSlider.set(p.spread);
    this.presetChips.set(id);
    this.refreshPreview();
  }

  template(): GenomeTemplate {
    const t: GenomeTemplate = { spread: this.spread };
    for (const g of GENES) t[g] = this.genes[g];
    return t;
  }

  /** Spawn spec for a click at (x,y). */
  spec(x: number, y: number, radius: number): SpawnSpec {
    const s: SpawnSpec = { x, y, count: this.count, radius: Math.max(4, radius), template: this.template(), tribe: this.tribe };
    if (this.tribe === 'new' && this.tribeName) s.tribeName = this.tribeName;
    return s;
  }

  private refreshPreview(): void {
    this.swatch.style.background = hueCss(this.genes.hue);
    try {
      const t = expressTraits(GENES.map((g) => this.genes[g]));
      const items: [string, string][] = [
        ['Speed', t.speed.toFixed(2)],
        ['Vision', t.perception.toFixed(0)],
        ['Health', t.maxHealth.toFixed(0)],
        ['Lifespan', fmtInt(t.longevity)],
      ];
      this.preview.replaceChildren(...items.map(([k, v]) => h('span', { class: 'pv' }, h('span', { class: 'pv-k' }, k), h('span', { class: 'pv-v' }, v))));
    } catch {
      this.preview.textContent = '';
    }
  }
}
