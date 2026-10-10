import { attachCameraInput } from "./cameraInput.ts";

export interface Point {
  x: number;
  y: number;
}

export interface View {
  cx: number;
  cy: number;
  zoom: number;
}

const FIT_MARGIN = 0.96; // fit-world fills this fraction of the tighter canvas axis
const SLACK = 0.1; // fraction of the view the world edge may be dragged inside
const ANIMATE_MS = 400;
const FOLLOW_TAU_MS = 150; // follow smoothing time constant
const FOCUS_TAU_MS = 150; // focus offset smoothing time constant
const MAX_DT_MS = 100; // longest frame step used for smoothing (tab was hidden)

// Zoom (canvas pixels per world unit) at which the whole world fits the canvas with a margin.
export function fitWorld(worldW: number, worldH: number, canvasW: number, canvasH: number): number {
  return Math.min(canvasW / worldW, canvasH / worldH) * FIT_MARGIN;
}

// Zoomed out the world stays centred, zoomed in its edge may sit at most SLACK of the view inside the screen.
function clampAxis(c: number, world: number, view: number): number {
  if (view >= world) return world / 2;
  const h = (world - view) / 2 + SLACK * view;
  return Math.min(world / 2 + h, Math.max(world / 2 - h, c));
}

// Latches "dragging" once the pointer has moved more than threshold from where it went down.
export class DragDetector {
  dragging = false;
  private x0 = 0;
  private y0 = 0;
  private readonly threshold: number;
  constructor(threshold: number) {
    this.threshold = threshold;
  }

  start(x: number, y: number): void {
    this.x0 = x;
    this.y0 = y;
    this.dragging = false;
  }

  // Returns whether the gesture is a drag so far.
  move(x: number, y: number): boolean {
    if (!this.dragging && Math.hypot(x - this.x0, y - this.y0) > this.threshold) this.dragging = true;
    return this.dragging;
  }
}

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// View onto a worldW x worldH world drawn on a canvasW x canvasH canvas (device pixels).
// maxZoom is canvas pixels per world unit, e.g. creature radius on screen / creature radius in the world.
export class Camera {
  cx: number;
  cy: number;
  zoom: number;
  minZoom: number;
  animationsCompleted = 0; // animations that ran to their end, as opposed to being cancelled
  focusX = 0; // where the view centre sits on screen, as a canvas-pixel offset from the canvas centre (eased towards the goal)
  focusY = 0;
  onClick: ((worldX: number, worldY: number) => void) | null = null;
  private target: (() => Point | null) | null = null;
  private anim: { t0: number | null; from: View; to: View } | null = null;
  private focusGoalX = 0;
  private focusGoalY = 0;
  private lastMs: number | null = null;
  private detachInput: (() => void) | null = null;

  private worldW: number;
  private worldH: number;
  private canvasW: number;
  private canvasH: number;
  maxZoom: number;

  constructor(worldW: number, worldH: number, canvasW: number, canvasH: number, maxZoom = 8) {
    this.worldW = worldW;
    this.worldH = worldH;
    this.canvasW = canvasW;
    this.canvasH = canvasH;
    this.maxZoom = maxZoom;
    this.minZoom = fitWorld(worldW, worldH, canvasW, canvasH);
    this.zoom = this.minZoom;
    this.cx = worldW / 2;
    this.cy = worldH / 2;
  }

  get following(): boolean {
    return this.target !== null;
  }

  get animating(): boolean {
    return this.anim !== null;
  }

  // Where the view is heading: the end of the running animation, else the current view.
  get goal(): View {
    return this.anim ? { ...this.anim.to } : { cx: this.cx, cy: this.cy, zoom: this.zoom };
  }

  // Jumps to the view without animating, clamped like animateTo.
  setView(cx: number, cy: number, zoom: number): void {
    this.cancel();
    this.zoom = this.clampZoom(zoom);
    this.cx = cx;
    this.cy = cy;
    this.clampCentre();
  }

  // Visible world extent.
  get viewW(): number {
    return this.canvasW / this.zoom;
  }

  get viewH(): number {
    return this.canvasH / this.zoom;
  }

  // Moves the on-screen position of the view centre, e.g. to the middle of the area not covered by overlays. Eased in update().
  setFocusOffset(x: number, y: number, immediate = false): void {
    this.focusGoalX = x;
    this.focusGoalY = y;
    if (immediate) {
      this.focusX = x;
      this.focusY = y;
    }
  }

  // Keeps a fitted view fitted, otherwise keeps the zoom.
  resize(canvasW: number, canvasH: number): void {
    const fitted = this.zoom <= this.minZoom * 1.0001;
    this.canvasW = canvasW;
    this.canvasH = canvasH;
    this.minZoom = fitWorld(this.worldW, this.worldH, canvasW, canvasH);
    this.zoom = fitted ? this.minZoom : this.clampZoom(this.zoom);
    this.clampCentre();
  }

  setWorld(worldW: number, worldH: number): void {
    this.worldW = worldW;
    this.worldH = worldH;
    this.minZoom = fitWorld(worldW, worldH, this.canvasW, this.canvasH);
    this.reset();
  }

  // Whole world in view, no animation.
  reset(): void {
    this.cancel();
    this.zoom = this.minZoom;
    this.cx = this.worldW / 2;
    this.cy = this.worldH / 2;
    this.setFocusOffset(0, 0, true);
  }

  worldToScreen(wx: number, wy: number, out: Point = { x: 0, y: 0 }): Point {
    out.x = (wx - this.cx) * this.zoom + this.canvasW / 2 + this.focusX;
    out.y = (wy - this.cy) * this.zoom + this.canvasH / 2 + this.focusY;
    return out;
  }

  screenToWorld(sx: number, sy: number, out: Point = { x: 0, y: 0 }): Point {
    out.x = (sx - this.canvasW / 2 - this.focusX) / this.zoom + this.cx;
    out.y = (sy - this.canvasH / 2 - this.focusY) / this.zoom + this.cy;
    return out;
  }

  apply(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(this.zoom, 0, 0, this.zoom, this.canvasW / 2 + this.focusX - this.cx * this.zoom, this.canvasH / 2 + this.focusY - this.cy * this.zoom);
  }

  clampZoom(z: number): number {
    return Math.min(this.maxZoom, Math.max(this.minZoom, z));
  }

  clampCentre(): void {
    if (this.zoom <= this.minZoom * 1.0001) this.focusGoalX = this.focusGoalY = 0; // a fitted world sits centred
    this.cx = clampAxis(this.cx, this.worldW, this.viewW);
    this.cy = clampAxis(this.cy, this.worldH, this.viewH);
  }

  // Multiplies zoom by factor keeping the world point under screen (sx, sy) fixed.
  zoomAt(sx: number, sy: number, factor: number): void {
    const v = this.viewZoomingAt(sx, sy, this.zoom * factor);
    this.zoom = v.zoom;
    this.cx = v.cx;
    this.cy = v.cy;
    this.clampCentre();
  }

  // Moves the view by a screen-space drag of (dx, dy) pixels.
  panBy(dx: number, dy: number): void {
    this.cx -= dx / this.zoom;
    this.cy -= dy / this.zoom;
    this.clampCentre();
  }

  // View that zooms to newZoom keeping screen (sx, sy) fixed.
  viewZoomingAt(sx: number, sy: number, newZoom: number): View {
    const zoom = this.clampZoom(newZoom);
    const dx = sx - this.canvasW / 2 - this.focusX;
    const dy = sy - this.canvasH / 2 - this.focusY;
    return { cx: dx / this.zoom + this.cx - dx / zoom, cy: dy / this.zoom + this.cy - dy / zoom, zoom };
  }

  // Eases to the view over ANIMATE_MS. Any cancel() (user input) stops it.
  animateTo(cx: number, cy: number, zoom: number): void {
    const z = this.clampZoom(zoom);
    this.anim = {
      t0: null,
      from: { cx: this.cx, cy: this.cy, zoom: this.zoom },
      to: { cx: clampAxis(cx, this.worldW, this.canvasW / z), cy: clampAxis(cy, this.worldH, this.canvasH / z), zoom: z },
    };
  }

  animateToFit(): void {
    this.setFocusOffset(0, 0);
    this.animateTo(this.worldW / 2, this.worldH / 2, this.minZoom);
  }

  // Keeps getTarget() centred with smoothing. null stops following.
  follow(getTarget: (() => Point | null) | null): void {
    this.target = getTarget;
    if (getTarget) this.anim = null;
  }

  // Stops following and animating, for when the user takes over.
  cancel(): void {
    this.target = null;
    this.anim = null;
  }

  // Once per frame. Returns whether the view changed.
  update(nowMs: number): boolean {
    const dt = this.lastMs === null ? 0 : Math.min(MAX_DT_MS, nowMs - this.lastMs);
    this.lastMs = nowMs;
    const kf = 1 - Math.exp(-dt / FOCUS_TAU_MS);
    this.focusX += (this.focusGoalX - this.focusX) * kf;
    this.focusY += (this.focusGoalY - this.focusY) * kf;
    const a = this.anim;
    if (a) {
      a.t0 ??= nowMs;
      const t = Math.min(1, (nowMs - a.t0) / ANIMATE_MS);
      const k = ease(t);
      this.cx = a.from.cx + (a.to.cx - a.from.cx) * k;
      this.cy = a.from.cy + (a.to.cy - a.from.cy) * k;
      this.zoom = a.from.zoom * (a.to.zoom / a.from.zoom) ** k; // geometric, so zoom feels uniform
      if (t >= 1) {
        this.anim = null;
        this.animationsCompleted++;
      }
      return true;
    }
    if (this.target) {
      const p = this.target();
      if (!p) {
        this.target = null;
        return false;
      }
      const k = 1 - Math.exp(-dt / FOLLOW_TAU_MS);
      this.cx += (p.x - this.cx) * k;
      this.cy += (p.y - this.cy) * k;
      this.clampCentre();
      return dt > 0;
    }
    return false;
  }

  // Installs wheel, pointer (mouse and touch) and keyboard handlers. Returns the matching detach.
  attach(canvas: HTMLCanvasElement): () => void {
    this.detach();
    this.detachInput = attachCameraInput(this, canvas);
    return () => this.detach();
  }

  detach(): void {
    this.detachInput?.();
    this.detachInput = null;
  }
}
