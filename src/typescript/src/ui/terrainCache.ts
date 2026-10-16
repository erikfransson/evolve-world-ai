import type { Terrain } from "../sim/terrain.ts";
import { context2d, makeCanvas } from "./groundScene.ts";
import { drawTerrain } from "./terrainScene.ts";
import type { View } from "./terrainScene.ts";

const CACHE_MAX_PIXELS = 8_000_000; // the cached map's bitmap, about 32 MB; a larger one draws directly instead
const MARGIN = 0.25; // of the view's width and height, cached past each side so a pan redraws only once it leaves the margin
const STALE_ZOOM = 2; // while the zoom changes, a cached map up to this factor off the zoom is stretched instead of redrawn
const REBUILD_GAP_MS = 250; // a view that leaves the cached area sooner after a rebuild (a fast pan) draws directly instead

// What the cache remembers between frames, for cacheStep.
export interface CacheMemo {
  ready: boolean; // a bitmap of this terrain exists
  zoom: number; // the bitmap's zoom
  area: View; // world units the bitmap covers, on whole device pixels at its zoom
  builtAt: number; // ms
  lastZoom: number; // the previous frame's zoom: a wheel or pinch changes it without an animation
  lastX: number; // the previous frame's view corner, and whether the bitmap covered it
  lastY: number;
  lastCovered: boolean;
}

// One frame's choice: copy the cached map, rebuild it first, or draw the map directly; and whether the bitmap covers this view.
// Mid-move, redrawing the larger bitmap every frame would cost more than a direct draw: while the zoom changes a bitmap within
// STALE_ZOOM is stretched, else the map draws directly; a settled zoom rebuilds, a pan rebuilds once the view holds still or on the
// first frame it leaves the cached area (a slow pan or a followed creature); either at most every REBUILD_GAP_MS.
export function cacheStep(m: CacheMemo, world: { width: number; height: number }, zoom: number, view: View, animating: boolean, now: number): { step: "cached" | "rebuild" | "direct"; covered: boolean } {
  const zooming = animating || zoom !== m.lastZoom;
  const still = view.x0 === m.lastX && view.y0 === m.lastY;
  const off = zoom / m.zoom;
  const stale = off !== 1 && !(zooming && off < STALE_ZOOM && off > 1 / STALE_ZOOM);
  const a = m.area;
  const e = 0.5 / zoom; // half a pixel: the area's ends are pixel edges divided back by the zoom
  const covered = Math.max(0, view.x0) >= a.x0 - e && Math.min(world.width, view.x1) <= a.x1 + e && Math.max(0, view.y0) >= a.y0 - e && Math.min(world.height, view.y1) <= a.y1 + e;
  if (!m.ready) return { step: "rebuild", covered };
  if (!stale && covered) return { step: "cached", covered };
  const gap = now - m.builtAt >= REBUILD_GAP_MS;
  const due = stale ? gap : still || (m.lastCovered && gap);
  return { step: zooming || !due ? "direct" : "rebuild", covered };
}

// The map around the view drawn once at the current zoom and copied each frame. Zoomed out, a frame would otherwise stroke every rock
// outline again, which costs a mid laptop's GPU about 130 ms at whole-world view.
export class TerrainCache {
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null; // grows only; the map sits in its top-left w x h pixels
  private terrain: Terrain | null = null;
  private w = 0;
  private h = 0;
  private readonly memo: CacheMemo = { ready: false, zoom: 0, area: { x0: 0, x1: 0, y0: 0, y1: 0 }, builtAt: -Infinity, lastZoom: 0, lastX: NaN, lastY: NaN, lastCovered: false };

  // Draws t into ctx (in world units) for the view, from the cache, rebuilding it after a zoom or when the view leaves the cached area;
  // false when it would be too large or the view moves too fast, and then the caller draws the map directly.
  draw(ctx: CanvasRenderingContext2D, t: Terrain, zoom: number, view: View, animating: boolean, now = performance.now()): boolean {
    if (t.empty) return true;
    const m = this.memo;
    m.ready = this.terrain === t && this.canvas !== null;
    const { step, covered } = cacheStep(m, t, zoom, view, animating, now);
    m.lastZoom = zoom;
    m.lastX = view.x0;
    m.lastY = view.y0;
    m.lastCovered = covered;
    if (step === "direct") return false;
    if (step === "rebuild") {
      if (!this.build(t, zoom, view)) return false;
      m.builtAt = now;
    }
    const c = this.canvas;
    if (!c) return false;
    const b = m.area;
    const tf = ctx.getTransform();
    ctx.save();
    if (m.zoom === zoom && tf.b === 0 && tf.c === 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0); // at its own zoom the bitmap goes on whole device pixels, unscaled, so rims stay crisp
      ctx.drawImage(c, 0, 0, this.w, this.h, Math.round(tf.a * b.x0 + tf.e), Math.round(tf.d * b.y0 + tf.f), this.w, this.h);
    } else ctx.drawImage(c, 0, 0, this.w, this.h, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.restore();
    return true;
  }

  private build(t: Terrain, zoom: number, view: View): boolean {
    const mx = MARGIN * (view.x1 - view.x0);
    const my = MARGIN * (view.y1 - view.y0);
    const px0 = Math.floor(Math.max(0, view.x0 - mx) * zoom);
    const py0 = Math.floor(Math.max(0, view.y0 - my) * zoom);
    const w = Math.ceil(Math.min(t.width, view.x1 + mx) * zoom) - px0;
    const h = Math.ceil(Math.min(t.height, view.y1 + my) * zoom) - py0;
    if (w < 1 || h < 1 || w * h > CACHE_MAX_PIXELS) return false;
    const c = this.canvas;
    if (!c || c.width < w || c.height < h) {
      const cw = Math.max(w, c?.width ?? 0);
      const ch = Math.max(h, c?.height ?? 0);
      this.canvas = cw * ch <= CACHE_MAX_PIXELS ? makeCanvas(cw, ch) : makeCanvas(w, h);
      for (const lost of ["contextlost", "contextrestored"]) this.canvas?.addEventListener(lost, () => (this.terrain = null)); // the pixels are gone: redraw on the next frame
    }
    const g = context2d(this.canvas);
    if (!g) {
      this.canvas = null;
      return false;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    g.save();
    g.beginPath();
    g.rect(0, 0, w, h);
    g.clip();
    g.setTransform(zoom, 0, 0, zoom, -px0, -py0);
    const area = { x0: px0 / zoom, x1: (px0 + w) / zoom, y0: py0 / zoom, y1: (py0 + h) / zoom };
    drawTerrain(g, t, zoom, area);
    g.restore();
    this.terrain = t;
    this.w = w;
    this.h = h;
    this.memo.zoom = zoom;
    this.memo.area = area;
    return true;
  }
}
