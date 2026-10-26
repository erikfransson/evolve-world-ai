// Matches the canvas backing store to its CSS size at the device pixel ratio. Returns the ratio.
export function fitCanvas(canvas: HTMLCanvasElement): number {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

// Axis label font for the graph cards, 25% larger on desktop than on phones. Read at draw time so a resize picks it up.
export function graphFont(): string {
  const desktop = typeof window.matchMedia === "function" && window.matchMedia("(min-width: 701px)").matches;
  return `${desktop ? 12.5 : 10}px system-ui, -apple-system, "Segoe UI", sans-serif`;
}

// The 2D context of a canvas from makeCanvas, null when there is no canvas or no context.
export const context2d = (c: OffscreenCanvas | HTMLCanvasElement | null): CanvasRenderingContext2D | null => (c ? (c.getContext("2d") as CanvasRenderingContext2D | null) : null);

// A canvas of w x h pixels for drawing off screen: an OffscreenCanvas where there is one, else a detached element, null in a worker without either.
export function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// Pixels of images one draw call may build, so a new zoom level costs a few frames and not one long one. The first build of a call always goes ahead.
export interface BuildBudget {
  readonly limit: number;
  left: number;
  refused: boolean; // an image was put off: draw again (or prepare) to finish
}
export const buildBudget = (limit: number): BuildBudget => ({ limit, left: limit, refused: false });

// Spends `cells` pixels and says yes, or marks the call unfinished and says no.
export function spend(b: BuildBudget, cells: number): boolean {
  if (b.left < b.limit && cells > b.left) {
    b.refused = true;
    return false;
  }
  b.left -= cells;
  return true;
}
