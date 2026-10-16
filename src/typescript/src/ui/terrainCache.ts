import type { Terrain } from "../sim/terrain.ts";
import { context2d, makeCanvas } from "./groundScene.ts";
import { drawTerrain } from "./terrainScene.ts";
import type { View } from "./terrainScene.ts";

const CACHE_MAX_PIXELS = 8_000_000; // the cached map's bitmap, about 32 MB; a larger one draws directly instead
const MARGIN = 0.25; // of the view's width and height, cached past each side so a pan redraws only once it leaves the margin
const STALE_ZOOM = 2; // while the zoom changes, a cached map up to this factor off the zoom is stretched instead of redrawn
const REBUILD_GAP_MS = 250; // a view that leaves the cached area sooner after a rebuild (a fast pan) draws directly instead

// The map around the view drawn once at the current zoom and copied each frame. Zoomed out, a frame would otherwise stroke every rock
// outline again, which costs a mid laptop's GPU about 130 ms at whole-world view.
export class TerrainCache {
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null; // grows only; the map sits in its top-left w x h pixels
  private terrain: Terrain | null = null;
  private zoom = 0;
  private w = 0;
  private h = 0;
  private area: View = { x0: 0, x1: 0, y0: 0, y1: 0 }; // world units the bitmap covers, on whole device pixels at the zoom
  private lastZoom = 0; // the previous frame's zoom: a wheel or pinch changes it without an animation
  private builtAt = -Infinity;
  private lastX = NaN; // the previous frame's view corner, and whether the cache covered it
  private lastY = NaN;
  private lastCovered = false;

  // Draws t into ctx (in world units) for the view, from the cache, rebuilding it after a zoom or when the view leaves the cached area;
  // false when it would be too large or the view moves too fast, and then the caller draws the map directly.
  draw(ctx: CanvasRenderingContext2D, t: Terrain, zoom: number, view: View, animating: boolean, now = performance.now()): boolean {
    if (t.empty) return true;
    const zooming = animating || zoom !== this.lastZoom;
    const still = view.x0 === this.lastX && view.y0 === this.lastY;
    this.lastZoom = zoom;
    this.lastX = view.x0;
    this.lastY = view.y0;
    const off = zoom / this.zoom;
    const a = this.area;
    const stale = off !== 1 && !(zooming && off < STALE_ZOOM && off > 1 / STALE_ZOOM);
    const e = 0.5 / zoom; // half a pixel: the area's ends are pixel edges divided back by the zoom
    const covered = Math.max(0, view.x0) >= a.x0 - e && Math.min(t.width, view.x1) <= a.x1 + e && Math.max(0, view.y0) >= a.y0 - e && Math.min(t.height, view.y1) <= a.y1 + e;
    const wasCovered = this.lastCovered;
    this.lastCovered = covered;
    if (t !== this.terrain || !this.canvas || stale || !covered) {
      // Mid-move, redrawing the larger bitmap every frame would cost more: a zoom rebuilds once it settles, a pan once the view holds still
      // or on the first frame it leaves the cached area (a slow pan or a followed creature); either at most every REBUILD_GAP_MS.
      const gap = now - this.builtAt >= REBUILD_GAP_MS;
      const ready = stale ? gap : still || (wasCovered && gap);
      if (this.terrain === t && this.canvas && (zooming || !ready)) return false;
      if (!this.build(t, zoom, view)) return false;
      this.builtAt = now;
    }
    const m = ctx.getTransform();
    ctx.save();
    if (off === 1 && m.b === 0 && m.c === 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0); // at its own zoom the bitmap goes on whole device pixels, unscaled, so rims stay crisp
      ctx.drawImage(this.canvas!, 0, 0, this.w, this.h, Math.round(m.a * this.area.x0 + m.e), Math.round(m.d * this.area.y0 + m.f), this.w, this.h);
    } else {
      const b = this.area;
      ctx.drawImage(this.canvas!, 0, 0, this.w, this.h, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    }
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
      for (const lost of ["contextlost", "contextrestored"]) this.canvas?.addEventListener?.(lost, () => (this.terrain = null)); // the pixels are gone: redraw on the next frame
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
    this.zoom = zoom;
    this.w = w;
    this.h = h;
    this.area = area;
    return true;
  }
}
