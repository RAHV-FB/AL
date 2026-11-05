/**
 * Analytics panel (OWNER: Analytics): KPI tiles + collapsible chart sections,
 * all drawn from real samples in sim.state.stats. Cheap when nothing changed:
 * charts are rebuilt only when a new sample arrives (or the range/gene changes).
 */
import './analytics.css';
import type { Simulation } from '../sim/simulation';
import { DEATH_CAUSES, GENE_COUNT, GENES, HIST_BINS, type ActionKind, type DeathCause, type GeneName, type Role, type StatsSample } from '../sim/types';
import { ROLES, currentSummary } from '../sim/stats';
import { BarChart, Heatmap, LineChart, PALETTE, Sparkline, StackedAreaChart, esc, formatNum, formatPct } from './charts';

export interface AnalyticsPanel {
  /** Refresh charts from sim.state.stats (called ~4×/s by the app; cheap when nothing changed). */
  update(sim: Simulation, force?: boolean): void;
}

// ------------------------------------------------------------------ shared labels & colours (also used by the inspector)

const C = { blue: PALETTE[0], orange: PALETTE[1], aqua: PALETTE[2], yellow: PALETTE[3], magenta: PALETTE[4], green: PALETTE[5], violet: PALETTE[6], red: PALETTE[7] };
const NEUTRAL = '#5b6577';

export const CAUSE_LABELS: Record<DeathCause, string> = {
  starvation: 'Starvation',
  old_age: 'Old age',
  combat: 'Combat',
  disease: 'Disease',
  disaster: 'Disaster',
  removed: 'Smitten / removed',
};
export const CAUSE_COLORS: Record<DeathCause, string> = {
  starvation: C.yellow,
  old_age: C.blue,
  combat: C.red,
  disease: C.aqua,
  disaster: C.violet,
  removed: C.magenta,
};
export const ROLE_LABELS: Record<Role, string> = { none: 'Unassigned', forager: 'Forager', warrior: 'Warrior', caretaker: 'Caretaker', explorer: 'Explorer' };
export const ROLE_COLORS: Record<Role, string> = { none: NEUTRAL, forager: C.aqua, warrior: C.red, caretaker: C.magenta, explorer: C.blue };

export const GENE_LABELS: Record<GeneName, string> = {
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
  hue: 'Hue',
};
export const GENE_DESCRIPTIONS: Record<GeneName, string> = {
  speed: 'Movement speed — reaches food first, but burns energy.',
  size: 'Body size — strength and max health, but higher upkeep.',
  perception: 'Vision radius — spots food and danger from afar.',
  metabolism: 'Metabolic rate — faster healing, but hungrier.',
  aggression: 'Propensity to fight and steal.',
  sociability: 'Desire for company; holds tribes together.',
  altruism: 'Propensity to share food and help others.',
  fertility: 'Reproductive drive — many cheap offspring vs few well-fed ones.',
  longevity: 'Maximum lifespan (costly upkeep).',
  immunity: 'Disease resistance (costly upkeep).',
  efficiency: 'Food gained per bite.',
  hue: 'Neutral marker gene — colour only; drifts at random and traces lineages.',
};

export function tribeColor(hue: number): string {
  return `hsl(${Math.round(((hue % 360) + 360) % 360)}, 62%, 56%)`;
}

const RANGES: { label: string; days: number }[] = [
  { label: 'All', days: Infinity },
  { label: '20 d', days: 20 },
  { label: '5 d', days: 5 },
  { label: '1 d', days: 1 },
];

// ------------------------------------------------------------------ helpers

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

const legendCache = new WeakMap<HTMLElement, string>();
function renderLegend(el: HTMLElement, items: { name: string; color: string; value?: string }[], empty?: string): void {
  const html = items.length
    ? items.map((it) => `<span class="an-leg-item"><i style="background:${it.color}"></i>${esc(it.name)}${it.value !== undefined ? ` <b>${esc(it.value)}</b>` : ''}</span>`).join('')
    : `<span class="an-leg-empty">${esc(empty ?? '')}</span>`;
  if (legendCache.get(el) === html) return;
  legendCache.set(el, html);
  el.innerHTML = html;
}

/** Trailing-window rate per day of a flow counter (window in ticks). */
function rollingRate(samples: StatsSample[], get: (s: StatsSample) => number, windowTicks: number, dayLen: number, interval: number): Float64Array {
  const n = samples.length;
  const out = new Float64Array(n);
  let first = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += get(samples[i]);
    while (first < i && samples[i].tick - samples[first].tick >= windowTicks) {
      sum -= get(samples[first]);
      first++;
    }
    const startTick = first > 0 ? samples[first - 1].tick : samples[0].tick - interval;
    out[i] = (sum / Math.max(1, samples[i].tick - startTick)) * dayLen;
  }
  return out;
}

const dayFmt = (v: number) => `Day ${formatNum(v)}`;
const dayHover = (v: number) => `Day ${v < 10 ? v.toFixed(2) : v.toFixed(1)}`;
const pctFmt = (v: number) => `${Math.round(v * 100)}%`;
const rateFmt = (v: number) => (v < 10 ? v.toFixed(1) : formatNum(Math.round(v)));

interface Tile {
  root: HTMLElement;
  value: HTMLElement;
  sub: HTMLElement;
  spark: Sparkline;
}

// ------------------------------------------------------------------ panel

export function createAnalyticsPanel(container: HTMLElement): AnalyticsPanel {
  container.textContent = '';
  container.classList.add('an-root');

  // --- toolbar (time range)
  const bar = h('div', 'an-toolbar');
  bar.append(h('span', 'an-toolbar-label', 'Range'));
  const rangeBtns: HTMLButtonElement[] = [];
  let rangeIdx = 0;
  RANGES.forEach((r, i) => {
    const b = h('button', 'an-seg', r.label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(i === rangeIdx));
    b.addEventListener('click', () => {
      rangeIdx = i;
      rangeBtns.forEach((bb, j) => bb.setAttribute('aria-pressed', String(j === i)));
      refresh(true);
    });
    rangeBtns.push(b);
    bar.append(b);
  });
  const status = h('span', 'an-toolbar-status');
  bar.append(status);
  container.append(bar);

  // --- KPI tiles
  const kpis = h('div', 'an-kpis');
  container.append(kpis);
  const tile = (label: string, color: string, title: string): Tile => {
    const root = h('div', 'an-kpi');
    root.title = title;
    const top = h('div', 'an-kpi-label', label);
    const value = h('div', 'an-kpi-value', '–');
    const sub = h('div', 'an-kpi-sub', '');
    root.append(top, value, sub);
    kpis.append(root);
    const spark = new Sparkline(root, { color, height: 22 });
    return { root, value, sub, spark };
  };
  const tPop = tile('Population', C.blue, 'Living agents now');
  const tBirths = tile('Births / day', C.aqua, 'Births per day over the last day');
  const tDeaths = tile('Deaths / day', C.red, 'Deaths per day over the last day');
  const tHealth = tile('Avg health', C.green, 'Mean health as a fraction of each agent\'s maximum');
  const tFood = tile('Food', C.yellow, 'Total edible plant food in the world');
  const tTribes = tile('Tribes', C.violet, 'Tribes with at least one living member');
  const tGen = tile('Max generation', C.orange, 'Highest generation among living agents');
  const tInf = tile('Infected', C.magenta, 'Agents currently carrying a disease');

  // --- sections
  const sections: HTMLDetailsElement[] = [];
  const section = (title: string, explain: string, open = true): HTMLElement => {
    const d = h('details', 'an-sec');
    d.open = open;
    const s = h('summary', 'an-sec-title', title);
    d.append(s, h('p', 'an-explain', explain));
    const body = h('div', 'an-sec-body');
    d.append(body);
    container.append(d);
    sections.push(d);
    return body;
  };
  const sub = (parent: HTMLElement, title: string): HTMLElement => {
    const w = h('div', 'an-sub');
    w.append(h('div', 'an-sub-title', title));
    parent.append(w);
    return w;
  };

  // Population
  const secPop = section('Population', 'Living agents over time (dashed line: the population cap), then births vs deaths per day — births above deaths means growth.');
  const popChart = new LineChart(secPop, { height: 130, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Population over time' });
  const bdLegend = h('div', 'an-legend');
  secPop.append(bdLegend);
  const bdChart = new LineChart(secPop, { height: 110, xFormat: dayFmt, xHoverFormat: dayHover, yFormat: rateFmt, ariaLabel: 'Births and deaths per day' });
  renderLegend(bdLegend, [
    { name: 'Births / day', color: C.aqua },
    { name: 'Deaths / day', color: C.red },
  ]);

  // Vitals
  const secVit = section('Vitals', 'Average health, energy and hunger of the living population (0–100%). Rising hunger warns of famine before deaths do.');
  const vitLegend = h('div', 'an-legend');
  secVit.append(vitLegend);
  renderLegend(vitLegend, [
    { name: 'Health', color: C.green },
    { name: 'Energy', color: C.blue },
    { name: 'Hunger', color: C.yellow },
  ]);
  const vitChart = new LineChart(secVit, { height: 120, yMin: 0, yMax: 1, yFormat: pctFmt, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Average vitals' });

  // Resources
  const secRes = section('Resources', 'Total plant food in the world, and average soil fertility of land (overgrazing lowers it; it recovers slowly).');
  const resGrid = h('div', 'an-grid2');
  secRes.append(resGrid);
  const foodChart = new LineChart(sub(resGrid, 'Total food'), { height: 110, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Total food' });
  const fertChart = new LineChart(sub(resGrid, 'Avg fertility'), { height: 110, yMin: 0, yMax: 1, yFormat: pctFmt, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Average fertility' });

  // Tribes
  const secTribes = section('Tribes', 'Members per tribe, stacked; colours match the tribe colours on the map. Smaller tribes are grouped as “Other”.');
  const tribeChart = new StackedAreaChart(secTribes, { height: 140, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Tribe populations' });
  const tribeLegend = h('div', 'an-legend');
  secTribes.append(tribeLegend);

  // Deaths
  const secDeaths = section('Deaths by cause', 'What is killing agents: deaths per day by cause, stacked. Totals since the start are in the legend.');
  const deathChart = new StackedAreaChart(secDeaths, { height: 130, xFormat: dayFmt, xHoverFormat: dayHover, yFormat: rateFmt, ariaLabel: 'Deaths by cause' });
  const deathLegend = h('div', 'an-legend');
  secDeaths.append(deathLegend);

  // Genetics
  const secGen = section(
    'Genetics',
    'Pick a gene. Line: population mean ± 1 std. Heatmap: the distribution over time — a band that moves shows selection, a band that widens shows diversification.',
  );
  const geneChips = h('div', 'an-chips');
  secGen.append(geneChips);
  let gene = 0;
  const chipEls: HTMLButtonElement[] = [];
  GENES.forEach((g, i) => {
    const b = h('button', 'an-chip', GENE_LABELS[g]);
    b.type = 'button';
    b.title = GENE_DESCRIPTIONS[g];
    b.setAttribute('aria-pressed', String(i === gene));
    b.addEventListener('click', () => selectGene(i));
    chipEls.push(b);
    geneChips.append(b);
  });
  const geneDesc = h('p', 'an-gene-desc');
  secGen.append(geneDesc);
  const geneLine = new LineChart(sub(secGen, 'Mean ± std'), { height: 110, yMin: 0, yMax: 1, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Gene mean over time' });
  const geneHeat = new Heatmap(sub(secGen, 'Distribution over time'), {
    height: 120,
    xFormat: dayFmt,
    xHoverFormat: dayHover,
    yTicks: 2,
    ariaLabel: 'Gene distribution heatmap',
  });
  const geneHist = new BarChart(sub(secGen, 'Current distribution'), {
    height: 100,
    orientation: 'vertical',
    labelEvery: 2,
    showShare: true,
    tipHeader: (_d, i) => `Gene value ${(i / HIST_BINS).toFixed(1)}–${((i + 1) / HIST_BINS).toFixed(1)}`,
    ariaLabel: 'Current gene histogram',
  });
  const multiTitle = h('div', 'an-sub-title', 'All gene means (click to select)');
  secGen.append(multiTitle);
  const multiGrid = h('div', 'an-multi');
  secGen.append(multiGrid);
  const multis = GENES.map((g, i) => {
    const cell = h('button', 'an-multi-cell');
    cell.type = 'button';
    cell.title = GENE_DESCRIPTIONS[g];
    const head = h('div', 'an-multi-head');
    const name = h('span', 'an-multi-name', GENE_LABELS[g]);
    const val = h('span', 'an-multi-val', '–');
    head.append(name, val);
    cell.append(head);
    const spark = new Sparkline(cell, { color: C.blue, height: 24, minRange: 0.1 });
    cell.addEventListener('click', () => selectGene(i));
    multiGrid.append(cell);
    return { cell, val, spark };
  });

  // Behaviour
  const secBeh = section('Behaviour', 'What everyone is doing right now, and how the division of labour (roles) shifts over time.');
  const behGrid = h('div', 'an-grid2');
  secBeh.append(behGrid);
  const actChart = new BarChart(sub(behGrid, 'Actions now'), { height: 190, orientation: 'horizontal', color: C.blue, showShare: true, ariaLabel: 'Current actions' });
  const roleWrap = sub(behGrid, 'Roles over time');
  const roleChart = new StackedAreaChart(roleWrap, { height: 150, xFormat: dayFmt, xHoverFormat: dayHover, ariaLabel: 'Roles over time' });
  const roleLegend = h('div', 'an-legend');
  roleWrap.append(roleLegend);

  // ------------------------------------------------------------------ state
  let sim: Simulation | null = null;
  let lastTick = -1;
  let lastKey = '';
  let view: { samples: StatsSample[]; x: Float64Array; key: string } | null = null;

  function selectGene(i: number): void {
    gene = i;
    chipEls.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
    multis.forEach((m, j) => m.cell.classList.toggle('an-on', j === i));
    if (sim && view) renderGenetics(sim, view.samples, view.x, view.key);
  }
  multis[0].cell.classList.add('an-on');

  function refresh(force: boolean): void {
    if (sim) update(sim, force);
  }

  function updateKpis(s: Simulation, samples: StatsSample[]): void {
    const sum = currentSummary(s);
    const last = samples[samples.length - 1];
    const dayLen = Math.max(1, s.config.dayLength || 600);
    setText(tPop.value, formatNum(sum.population));
    setText(tPop.sub, `peak ${formatNum(sum.peakPopulation)} · day ${Math.floor(sum.peakTick / dayLen)}`);
    setText(tBirths.value, rateFmt(sum.birthsPerDay));
    setText(tBirths.sub, `${formatNum(sum.totalBirths)} total`);
    setText(tDeaths.value, rateFmt(sum.deathsPerDay));
    setText(tDeaths.sub, `${formatNum(sum.totalDeaths)} total`);
    setText(tHealth.value, sum.population ? formatPct(sum.avgHealth) : '–');
    setText(tHealth.sub, last ? `hunger ${formatPct(last.avgHunger)}` : '');
    setText(tFood.value, formatNum(Math.round(sum.totalFood)));
    setText(tFood.sub, last ? `fertility ${formatPct(last.avgFertility)}` : '');
    setText(tTribes.value, String(sum.tribes));
    let big = '';
    if (last && last.tribePops.length) {
      let best = last.tribePops[0];
      for (const tp of last.tribePops) if (tp[1] > best[1]) best = tp;
      const t = s.getTribe(best[0]);
      big = `largest ${t ? t.name : `#${best[0]}`} (${best[1]})`;
    }
    setText(tTribes.sub, big || 'none yet');
    setText(tGen.value, String(sum.maxGeneration));
    setText(tGen.sub, `mean ${sum.meanGeneration.toFixed(1)}`);
    setText(tInf.value, String(sum.infected));
    setText(tInf.sub, sum.population ? `${formatPct(sum.infected / sum.population)} of pop.` : '');
    tInf.root.classList.toggle('an-alert', sum.infected > 0 && sum.infected >= sum.population * 0.1);
  }

  function renderGenetics(s: Simulation, samples: StatsSample[], x: Float64Array, key: string): void {
    const n = samples.length;
    const g = gene;
    const gname = GENES[g];
    setText(geneDesc, `${GENE_LABELS[gname]}: ${GENE_DESCRIPTIONS[gname]}`);
    const gkey = `${key}|${g}`;
    const mean = new Float64Array(n);
    const lo = new Float64Array(n);
    const hi = new Float64Array(n);
    const heat = new Float32Array(n * HIST_BINS);
    for (let i = 0; i < n; i++) {
      const sm = samples[i];
      const m = sm.geneMeans[g] ?? 0;
      const sd = sm.geneStd[g] ?? 0;
      mean[i] = m;
      lo[i] = Math.max(0, m - sd);
      hi[i] = Math.min(1, m + sd);
      let tot = 0;
      for (let b = 0; b < HIST_BINS; b++) tot += sm.geneHist[g * HIST_BINS + b] ?? 0;
      for (let b = 0; b < HIST_BINS; b++) heat[i * HIST_BINS + b] = tot > 0 ? (sm.geneHist[g * HIST_BINS + b] ?? 0) / tot : 0;
    }
    geneLine.setData({ x, series: [{ name: `Mean ${GENE_LABELS[gname].toLowerCase()}`, color: C.blue, values: mean, band: { lo, hi } }] }, gkey);
    geneHeat.setData(
      {
        x,
        rows: HIST_BINS,
        values: heat,
        overlay: mean,
        overlayLabel: 'Mean',
        rowLabel: (r) => `Value ${(r / HIST_BINS).toFixed(1)}–${((r + 1) / HIST_BINS).toFixed(1)}`,
        valueLabel: (v) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}% of pop.`,
      },
      gkey,
    );
    const last = samples[n - 1];
    const bars = [];
    for (let b = 0; b < HIST_BINS; b++) {
      bars.push({ label: (b / HIST_BINS).toFixed(1), value: last ? Math.round(last.geneHist[g * HIST_BINS + b] ?? 0) : 0 });
    }
    geneHist.setData({ bars }, gkey);
    void s;
  }

  function update(s: Simulation, force = false): void {
    if (s !== sim) {
      sim = s;
      force = true;
    }
    const tick = s.state.tick;
    if (!force && tick === lastTick) return;
    lastTick = tick;
    const st = s.state.stats;
    const all = st.samples;
    updateKpis(s, all);
    const n0 = all.length;
    const lastSample = all[n0 - 1];
    const key = `${n0}|${lastSample ? lastSample.tick : -1}|${rangeIdx}|${s.config.maxAgents}`;
    if (!force && key === lastKey) return;
    lastKey = key;

    const dayLen = Math.max(1, s.config.dayLength || 600);
    const interval = Math.max(1, st.sampleInterval);
    // rates over the full history, then slice to the selected range
    const halfDay = dayLen / 2;
    const birthsAll = rollingRate(all, (x) => x.births, halfDay, dayLen, interval);
    const deathsAll = rollingRate(all, (x) => x.deaths, halfDay, dayLen, interval);
    const causeAll = DEATH_CAUSES.map((c) => rollingRate(all, (x) => x.deathsByCause[c] ?? 0, dayLen, dayLen, interval));
    const range = RANGES[rangeIdx];
    let start = 0;
    if (Number.isFinite(range.days) && lastSample) {
      const from = lastSample.tick - range.days * dayLen;
      while (start < n0 - 1 && all[start].tick < from) start++;
    }
    const samples = start > 0 ? all.slice(start) : all;
    const n = samples.length;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = samples[i].tick / dayLen;
    view = { samples, x, key };
    setText(status, n0 ? `${n0} samples · every ${interval} ticks` : 'no samples yet');

    // sparklines (last ~300 samples)
    const sp0 = Math.max(0, n0 - 300);
    const col = (get: (x: StatsSample) => number) => {
      const out = new Float64Array(n0 - sp0);
      for (let i = sp0; i < n0; i++) out[i - sp0] = get(all[i]);
      return out;
    };
    tPop.spark.set(col((v) => v.population), key);
    tBirths.spark.set(birthsAll.subarray(sp0), key);
    tDeaths.spark.set(deathsAll.subarray(sp0), key);
    tHealth.spark.set(col((v) => v.avgHealth), key);
    tFood.spark.set(col((v) => v.totalFood), key);
    tTribes.spark.set(col((v) => v.tribeCount), key);
    tGen.spark.set(col((v) => v.maxGeneration), key);
    tInf.spark.set(col((v) => v.infected), key);

    const series = (get: (x: StatsSample) => number) => {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = get(samples[i]);
      return out;
    };

    // population (cap shown as a reference line once the population approaches it)
    const popVals = series((v) => v.population);
    let popMax = 0;
    for (let i = 0; i < n; i++) if (popVals[i] > popMax) popMax = popVals[i];
    popChart.setOptions({ refLines: popMax >= s.config.maxAgents * 0.6 ? [{ y: s.config.maxAgents, label: `cap ${s.config.maxAgents}` }] : [] });
    popChart.setData({ x, series: [{ name: 'Population', color: C.blue, values: popVals, fill: true }] }, key);
    bdChart.setData(
      {
        x,
        series: [
          { name: 'Births / day', color: C.aqua, values: birthsAll.subarray(start), format: rateFmt },
          { name: 'Deaths / day', color: C.red, values: deathsAll.subarray(start), format: rateFmt },
        ],
      },
      key,
    );

    // vitals
    vitChart.setData(
      {
        x,
        series: [
          { name: 'Health', color: C.green, values: series((v) => v.avgHealth) },
          { name: 'Energy', color: C.blue, values: series((v) => v.avgEnergy) },
          { name: 'Hunger', color: C.yellow, values: series((v) => v.avgHunger) },
        ],
      },
      key,
    );

    // resources
    foodChart.setData({ x, series: [{ name: 'Total food', color: C.yellow, values: series((v) => v.totalFood), fill: true }] }, key);
    fertChart.setData({ x, series: [{ name: 'Avg fertility', color: C.orange, values: series((v) => v.avgFertility) }] }, key);

    // tribes: top 8 by peak in range, the rest folded into "Other"
    const peak = new Map<number, number>();
    for (const sm of samples) for (const [id, m] of sm.tribePops) if (m > (peak.get(id) ?? 0)) peak.set(id, m);
    const top = [...peak.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, 8)
      .map((e) => e[0])
      .sort((a, b) => a - b);
    const slot = new Map<number, number>(top.map((id, k) => [id, k]));
    const tVals = top.map(() => new Float64Array(n));
    const other = new Float64Array(n);
    const none = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const sm = samples[i];
      let inTribes = 0;
      for (const [id, m] of sm.tribePops) {
        inTribes += m;
        const k = slot.get(id);
        if (k === undefined) other[i] += m;
        else tVals[k][i] = m;
      }
      none[i] = Math.max(0, sm.population - inTribes);
    }
    const lastTP = new Map<number, number>(samples.length ? samples[n - 1].tribePops : []);
    const tSeries = [{ name: 'No tribe', color: NEUTRAL, values: none }];
    const tLegend: { name: string; color: string; value?: string }[] = [];
    top.forEach((id, k) => {
      const t = s.getTribe(id);
      const alive = lastTP.has(id);
      const name = (t ? t.name : `Tribe ${id}`) + (alive ? '' : ' †');
      const color = tribeColor(t ? t.hue : (id * 137.508) % 360);
      tSeries.push({ name, color, values: tVals[k] });
      tLegend.push({ name, color, value: String(lastTP.get(id) ?? 0) });
    });
    let anyOther = false;
    for (let i = 0; i < n; i++) if (other[i] > 0) anyOther = true;
    if (anyOther) {
      tSeries.push({ name: 'Other tribes', color: '#8a94a6', values: other });
      tLegend.push({ name: 'Other tribes', color: '#8a94a6', value: formatNum(other[n - 1] ?? 0) });
    }
    tLegend.push({ name: 'No tribe', color: NEUTRAL, value: formatNum(none[n - 1] ?? 0) });
    tribeChart.setData({ x, series: tSeries, totalLabel: 'Population' }, key);
    renderLegend(tribeLegend, top.length || anyOther ? tLegend : [], 'No tribes have formed yet.');

    // deaths by cause (per day, 1-day window)
    const totals: Record<DeathCause, number> = { starvation: 0, old_age: 0, combat: 0, disease: 0, disaster: 0, removed: 0 };
    for (const sm of all) for (const c of DEATH_CAUSES) totals[c] += sm.deathsByCause[c] ?? 0;
    for (const c of DEATH_CAUSES) totals[c] += st.counters.deathsByCause[c] ?? 0;
    deathChart.setData(
      {
        x,
        series: DEATH_CAUSES.map((c, k) => ({ name: CAUSE_LABELS[c], color: CAUSE_COLORS[c], values: causeAll[k].subarray(start) })),
        totalLabel: 'All deaths / day',
      },
      key,
    );
    renderLegend(
      deathLegend,
      DEATH_CAUSES.map((c) => ({ name: CAUSE_LABELS[c], color: CAUSE_COLORS[c], value: formatNum(totals[c]) })),
    );

    // genetics
    renderGenetics(s, samples, x, key);
    for (let g = 0; g < GENE_COUNT; g++) {
      const m = multis[g];
      const vals = col((v) => v.geneMeans[g] ?? 0);
      m.spark.set(vals, key);
      const cur = vals.length ? vals[vals.length - 1] : NaN;
      const first = all.length ? all[0].geneMeans[g] ?? NaN : NaN;
      const d = cur - first;
      const arrow = Math.abs(d) < 0.02 || !Number.isFinite(d) ? '' : d > 0 ? ' ▲' : ' ▼';
      setText(m.val, Number.isFinite(cur) ? cur.toFixed(2) + arrow : '–');
      m.cell.setAttribute('aria-label', `${GENE_LABELS[GENES[g]]} mean ${Number.isFinite(cur) ? cur.toFixed(2) : 'unknown'}`);
    }

    // behaviour
    const lastS = samples[n - 1];
    if (lastS) {
      const acts = (Object.entries(lastS.actions) as [ActionKind, number][]).filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      actChart.setData({ bars: acts.map(([k, v]) => ({ label: k, value: Math.round(v) })) }, key);
    }
    roleChart.setData(
      { x, series: ROLES.map((r) => ({ name: ROLE_LABELS[r], color: ROLE_COLORS[r], values: series((v) => v.roles[r] ?? 0) })), totalLabel: 'Population' },
      key,
    );
    renderLegend(
      roleLegend,
      ROLES.map((r) => ({ name: ROLE_LABELS[r], color: ROLE_COLORS[r], value: lastS ? formatNum(Math.round(lastS.roles[r] ?? 0)) : '0' })),
    );
  }

  return { update };
}
