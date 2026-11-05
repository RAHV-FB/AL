// OWNER: Rendering agent.
/**
 * 2D camera: world units → CSS pixels. `x,y` is the world point at the screen centre,
 * `zoom` is CSS pixels per world unit.
 *
 * Zooming is smooth by default: `zoomAt` sets a target which `update(dtMs)` (called by
 * the Renderer every frame) eases towards while keeping the anchor point fixed. Writing
 * `camera.zoom` directly still works (it cancels any running zoom animation).
 */
export interface Vec2 {
  x: number;
  y: number;
}

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
  /** World size in world units (set by the renderer each frame; 0 = unknown → no clamping). */
  worldW = 0;
  worldH = 0;
  /** When false, `zoomAt` applies immediately. */
  smoothZoom = true;
  /** Zoom the camera is easing towards. */
  targetZoom = 1;

  private anchorX = 0;
  private anchorY = 0;
  /** Zoom value last written by the camera itself (detects external writes). */
  private appliedZoom = 1;

  worldToScreen(wx: number, wy: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
    out.x = (wx - this.x) * this.zoom + this.viewW / 2;
    out.y = (wy - this.y) * this.zoom + this.viewH / 2;
    return out;
  }

  screenToWorld(sx: number, sy: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
    out.x = (sx - this.viewW / 2) / this.zoom + this.x;
    out.y = (sy - this.viewH / 2) / this.zoom + this.y;
    return out;
  }

  /** Register the world size: enables clamping and a viewport-relative minimum zoom. */
  setWorld(worldW: number, worldH: number): void {
    this.worldW = worldW;
    this.worldH = worldH;
    if (worldW > 0 && worldH > 0) {
      const fitZoom = Math.min(this.viewW / worldW, this.viewH / worldH);
      this.minZoom = Math.max(0.05, Math.min(1, fitZoom * 0.45));
    }
  }

  private clampZoom(z: number): number {
    return z < this.minZoom ? this.minZoom : z > this.maxZoom ? this.maxZoom : z;
  }

  /** Zoom by `factor` keeping the world point under (sx,sy) fixed. Smooth unless `smooth` is false. */
  zoomAt(sx: number, sy: number, factor: number, smooth: boolean = this.smoothZoom): void {
    this.syncExternal();
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.anchorX = sx;
    this.anchorY = sy;
    this.targetZoom = this.clampZoom(this.targetZoom * factor);
    if (!smooth) this.applyZoom(this.targetZoom);
  }

  /** Set an absolute zoom around the screen centre (or a given anchor). */
  setZoom(zoom: number, smooth: boolean = this.smoothZoom, sx = this.viewW / 2, sy = this.viewH / 2): void {
    this.syncExternal();
    this.anchorX = sx;
    this.anchorY = sy;
    this.targetZoom = this.clampZoom(zoom);
    if (!smooth) this.applyZoom(this.targetZoom);
  }

  /** True while a smooth zoom is in progress. */
  get animating(): boolean {
    return Math.abs(this.targetZoom - this.zoom) > this.zoom * 1e-3;
  }

  /** Advance smooth zoom (called once per frame by the renderer). */
  update(dtMs: number): void {
    this.syncExternal();
    if (this.animating) {
      const k = 1 - Math.exp(-Math.max(0, Math.min(100, dtMs)) / 65);
      const z = this.zoom * Math.pow(this.targetZoom / this.zoom, k);
      this.applyZoom(Math.abs(z - this.targetZoom) < this.targetZoom * 1e-3 ? this.targetZoom : z);
    } else if (this.zoom !== this.targetZoom) {
      this.applyZoom(this.targetZoom);
    }
    this.clamp();
  }

  /** Pan by a screen-space delta (pixels). */
  panBy(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clamp();
  }

  /** Jump so (x,y) is at the screen centre. */
  centerOn(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.clamp();
  }

  /** Ease the camera centre towards (x,y); lerp 1 = snap. Call every frame for follow mode. */
  follow(x: number, y: number, lerp = 0.15): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const k = lerp < 0 ? 0 : lerp > 1 ? 1 : lerp;
    this.x += (x - this.x) * k;
    this.y += (y - this.y) * k;
    this.clamp();
  }

  /** Fit a world rectangle into the viewport. */
  fit(worldW: number, worldH: number): void {
    this.x = worldW / 2;
    this.y = worldH / 2;
    this.zoom = Math.min(this.viewW / worldW, this.viewH / worldH) * 0.98;
    if (!(this.zoom > 0)) this.zoom = 1;
    this.targetZoom = this.zoom;
    this.appliedZoom = this.zoom;
  }

  /** Keep the camera centre inside the world so it can never be lost. */
  clamp(): void {
    if (this.worldW > 0) this.x = this.x < 0 ? 0 : this.x > this.worldW ? this.worldW : this.x;
    if (this.worldH > 0) this.y = this.y < 0 ? 0 : this.y > this.worldH ? this.worldH : this.y;
    if (!Number.isFinite(this.x)) this.x = this.worldW / 2;
    if (!Number.isFinite(this.y)) this.y = this.worldH / 2;
  }

  /** Visible world rectangle (with optional margin in world units). */
  visibleBounds(margin = 0, out = { x0: 0, y0: 0, x1: 0, y1: 0 }): { x0: number; y0: number; x1: number; y1: number } {
    const hw = this.viewW / 2 / this.zoom + margin;
    const hh = this.viewH / 2 / this.zoom + margin;
    out.x0 = this.x - hw;
    out.x1 = this.x + hw;
    out.y0 = this.y - hh;
    out.y1 = this.y + hh;
    return out;
  }

  private applyZoom(z: number): void {
    // keep the world point under the anchor fixed
    const ax = this.anchorX - this.viewW / 2;
    const ay = this.anchorY - this.viewH / 2;
    const bx = ax / this.zoom + this.x;
    const by = ay / this.zoom + this.y;
    this.zoom = z;
    this.x = bx - ax / z;
    this.y = by - ay / z;
    this.appliedZoom = z;
  }

  /** If someone wrote `zoom` directly, adopt it and cancel the animation. */
  private syncExternal(): void {
    if (this.zoom !== this.appliedZoom) {
      if (!(this.zoom > 0) || !Number.isFinite(this.zoom)) this.zoom = this.appliedZoom > 0 ? this.appliedZoom : 1;
      this.targetZoom = this.zoom;
      this.appliedZoom = this.zoom;
    }
  }
}
