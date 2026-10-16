import type { Terrain } from "../sim/terrain.ts";
import { context2d, makeCanvas } from "./groundScene.ts";
import { drawTerrain } from "./terrainScene.ts";
import type { View } from "./terrainScene.ts";

const CACHE_MAX_PIXELS = 8_000_000; // the cached map's bitmap, about 32 MB; a larger one draws directly instead
const MARGIN = 0.25; // of the view's width and height, cached past each side so a pan redraws only once it leaves the margin
const STALE_ZOOM = 2; // while the zoom changes, a cached map up to this factor off the zoom is stretched instead of redrawn

// The map around the view drawn once at the current zoom and copied each frame. Zoomed out, a frame would otherwise stroke every rock
// outline again, which costs a mid laptop's GPU about 130 ms at whole-world view.
export class TerrainCache {
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private terrain: Terrain | null = null;
  private zoom = 0;
  private area: View = { x0: 0, x1: 0, y0: 0, y1: 0 }; // world units the bitmap covers
  private lastZoom = 0; // the previous frame's zoom: a wheel or pinch changes it without an animation

  // Draws t into ctx (in world units) for the view, from the cache, rebuilding it after a zoom or when the view leaves the cached area;
  // false when the bitmap would be too large, and then the caller draws the map directly.
  draw(ctx: CanvasRenderingContext2D, t: Terrain, zoom: number, view: View, animating: boolean): boolean {
    if (t.empty) return true;
    const moving = animating || zoom !== this.lastZoom;
    this.lastZoom = zoom;
    const off = zoom / this.zoom;
    const a = this.area;
    const stale = off !== 1 && !(moving && off < STALE_ZOOM && off > 1 / STALE_ZOOM);
    const covered = Math.max(0, view.x0) >= a.x0 && Math.min(t.width, view.x1) <= a.x1 && Math.max(0, view.y0) >= a.y0 && Math.min(t.height, view.y1) <= a.y1;
    if (t !== this.terrain || !this.canvas || stale || !covered) {
      if (moving && this.canvas) return false; // a zoom in progress would redraw the larger bitmap every frame: draw directly until it settles
      if (!this.build(t, zoom, view)) return false;
    }
    const b = this.area;
    ctx.drawImage(this.canvas!, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    return true;
  }

  private build(t: Terrain, zoom: number, view: View): boolean {
    const mx = MARGIN * (view.x1 - view.x0);
    const my = MARGIN * (view.y1 - view.y0);
    const area = { x0: Math.max(0, view.x0 - mx), x1: Math.min(t.width, view.x1 + mx), y0: Math.max(0, view.y0 - my), y1: Math.min(t.height, view.y1 + my) };
    const w = Math.ceil((area.x1 - area.x0) * zoom);
    const h = Math.ceil((area.y1 - area.y0) * zoom);
    if (w < 1 || h < 1 || w * h > CACHE_MAX_PIXELS) return false;
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) this.canvas = makeCanvas(w, h);
    const g = context2d(this.canvas);
    if (!g) {
      this.canvas = null;
      return false;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    const sx = w / (area.x1 - area.x0);
    const sy = h / (area.y1 - area.y0);
    g.setTransform(sx, 0, 0, sy, -area.x0 * sx, -area.y0 * sy);
    drawTerrain(g, t, zoom, area);
    this.terrain = t;
    this.zoom = zoom;
    this.area = area;
    return true;
  }
}
