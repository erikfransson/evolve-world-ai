import type { Terrain } from "../sim/terrain.ts";
import { drawGround } from "./groundScene.ts";
import { drawRock } from "./abyssRock.ts";
import { drawTint } from "./mapTint.ts";
import { floorImage, floorRippleTile, RIPPLE_UNITS, smooth } from "./noiseTex.ts";

// Draws a Terrain (rock and slow and fast ground) for the Trials scene and the Ecosystem renderer, in world coordinates under the
// current transform. Floor, ground and rock are in noiseTex.ts, groundScene.ts and abyssRock.ts: a deep silt floor, pale sand shelves, basalt lit from above.

export interface View {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const RIPPLES_FROM = 0.5; // scale (device px per world unit) from which the floor shows ripples, full at RIPPLES_FROM + 0.7
const floorPatterns = new WeakMap<CanvasRenderingContext2D, CanvasPattern | null>();

// Over the plain floor colour: the world-sized image of silt drifts, and close up faint ripples.
function drawFloor(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View): void {
  const { image, cell } = floorImage(t.width, t.height);
  if (image) {
    const smoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, t.width, t.height);
    ctx.clip();
    ctx.drawImage(image as CanvasImageSource, -0.5 * cell, -0.5 * cell, image.width * cell, image.height * cell);
    ctx.restore();
    ctx.imageSmoothingEnabled = smoothing;
  }
  const a = smooth(RIPPLES_FROM, RIPPLES_FROM + 0.7, scale);
  if (a <= 0 || typeof DOMMatrix === "undefined") return;
  let pattern = floorPatterns.get(ctx);
  if (pattern === undefined) {
    const tile = floorRippleTile();
    pattern = tile ? ctx.createPattern(tile as CanvasImageSource, "repeat") : null;
    pattern?.setTransform(new DOMMatrix().scale(RIPPLE_UNITS / 512));
    floorPatterns.set(ctx, pattern);
  }
  if (!pattern) return;
  const x0 = Math.max(0, view.x0);
  const y0 = Math.max(0, view.y0);
  const x1 = Math.min(t.width, view.x1);
  const y1 = Math.min(t.height, view.y1);
  if (x1 <= x0 || y1 <= y0) return;
  ctx.globalAlpha = a;
  ctx.fillStyle = pattern;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.globalAlpha = 1;
}

// Draws the floor texture, the tint, the ground, then the rock, in world coordinates. scale: device pixels per world unit. view: the visible world rectangle.
// quick: flat fills without textures or images, for previews that redraw while settings change.
export function drawTerrain(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View = { x0: 0, x1: t.width, y0: 0, y1: t.height }, quick = false): void {
  if (t.empty) return;
  if (!quick) {
    drawFloor(ctx, t, scale, view);
    drawTint(ctx, t);
  }
  drawGround(ctx, t, scale, view, quick);
  drawRock(ctx, t, scale, view, quick);
}
