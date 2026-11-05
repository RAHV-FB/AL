import type { Agent } from './types';

/**
 * Uniform-grid spatial hash over living agents. Rebuilt once per tick by the
 * Simulation (O(n)). Queries reuse caller-supplied arrays to avoid GC churn.
 * Iteration order is deterministic (cell order, then insertion order).
 */
export class SpatialHash {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  private cells: Agent[][];

  constructor(worldW: number, worldH: number, cellSize = 32) {
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(worldW / cellSize));
    this.rows = Math.max(1, Math.ceil(worldH / cellSize));
    this.cells = new Array(this.cols * this.rows);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
  }

  private cellIndex(x: number, y: number): number {
    let cx = Math.floor(x / this.cellSize);
    let cy = Math.floor(y / this.cellSize);
    if (cx < 0) cx = 0; else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0; else if (cy >= this.rows) cy = this.rows - 1;
    return cy * this.cols + cx;
  }

  rebuild(agents: readonly Agent[]): void {
    for (let i = 0; i < this.cells.length; i++) this.cells[i].length = 0;
    for (const a of agents) if (a.alive) this.cells[this.cellIndex(a.x, a.y)].push(a);
  }

  /**
   * Living agents within `radius` of (x,y), excluding `exclude` if given.
   * Results are written into `out` (cleared first) and returned.
   */
  query(x: number, y: number, radius: number, out: Agent[] = [], exclude?: Agent): Agent[] {
    out.length = 0;
    const r2 = radius * radius;
    const cs = this.cellSize;
    const x0 = Math.max(0, Math.floor((x - radius) / cs));
    const x1 = Math.min(this.cols - 1, Math.floor((x + radius) / cs));
    const y0 = Math.max(0, Math.floor((y - radius) / cs));
    const y1 = Math.min(this.rows - 1, Math.floor((y + radius) / cs));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = this.cells[cy * this.cols + cx];
        for (let i = 0; i < cell.length; i++) {
          const a = cell[i];
          if (a === exclude || !a.alive) continue;
          const dx = a.x - x;
          const dy = a.y - y;
          if (dx * dx + dy * dy <= r2) out.push(a);
        }
      }
    }
    return out;
  }

  /** Nearest living agent satisfying `pred` within radius (or null). */
  nearest(x: number, y: number, radius: number, pred: (a: Agent) => boolean, exclude?: Agent): Agent | null {
    let best: Agent | null = null;
    let bestD = radius * radius;
    const cs = this.cellSize;
    const x0 = Math.max(0, Math.floor((x - radius) / cs));
    const x1 = Math.min(this.cols - 1, Math.floor((x + radius) / cs));
    const y0 = Math.max(0, Math.floor((y - radius) / cs));
    const y1 = Math.min(this.rows - 1, Math.floor((y + radius) / cs));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = this.cells[cy * this.cols + cx];
        for (let i = 0; i < cell.length; i++) {
          const a = cell[i];
          if (a === exclude || !a.alive) continue;
          const dx = a.x - x;
          const dy = a.y - y;
          const d = dx * dx + dy * dy;
          if (d <= bestD && pred(a)) {
            bestD = d;
            best = a;
          }
        }
      }
    }
    return best;
  }

  /** Count of living agents within radius (cheap density probe). */
  count(x: number, y: number, radius: number): number {
    let n = 0;
    const r2 = radius * radius;
    const cs = this.cellSize;
    const x0 = Math.max(0, Math.floor((x - radius) / cs));
    const x1 = Math.min(this.cols - 1, Math.floor((x + radius) / cs));
    const y0 = Math.max(0, Math.floor((y - radius) / cs));
    const y1 = Math.min(this.rows - 1, Math.floor((y + radius) / cs));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = this.cells[cy * this.cols + cx];
        for (let i = 0; i < cell.length; i++) {
          const a = cell[i];
          if (!a.alive) continue;
          const dx = a.x - x;
          const dy = a.y - y;
          if (dx * dx + dy * dy <= r2) n++;
        }
      }
    }
    return n;
  }
}
