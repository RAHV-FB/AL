// OWNER: Rendering agent. STUB — refine as needed (keep the public API).
export class Camera {
  /** World coordinate at the centre of the screen. */
  x = 0;
  y = 0;
  /** Screen pixels per world unit. */
  zoom = 1;
  minZoom = 0.2;
  maxZoom = 12;
  /** Viewport size in CSS pixels. */
  viewW = 1;
  viewH = 1;

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.zoom + this.viewW / 2, y: (wy - this.y) * this.zoom + this.viewH / 2 };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.viewW / 2) / this.zoom + this.x, y: (sy - this.viewH / 2) / this.zoom + this.y };
  }

  /** Zoom by `factor` keeping the world point under (sx,sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /** Pan by a screen-space delta (pixels). */
  panBy(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
  }

  /** Fit a world rectangle into the viewport. */
  fit(worldW: number, worldH: number): void {
    this.x = worldW / 2;
    this.y = worldH / 2;
    this.zoom = Math.min(this.viewW / worldW, this.viewH / worldH) * 0.98;
  }
}
