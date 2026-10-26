import type { Terrain } from "../sim/terrain.ts";
import { drawGround, prepareGround } from "./groundScene.ts";
import { drawRock, prepareRock } from "./abyssRock.ts";
import { drawTint } from "./mapTint.ts";
import { floorImage } from "./noiseTex.ts";

// Draws a Terrain (rock and slow and fast ground) for the Trials scene and the Ecosystem renderer, in world coordinates under the
// current transform. Floor, ground and rock are in noiseTex.ts, groundScene.ts and abyssRock.ts: a deep silt floor, pale sand shelves, basalt lit from above.

export interface View {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

// Over the plain floor colour: the world-sized image of silt drifts.
function drawFloor(ctx: CanvasRenderingContext2D, t: Terrain, view: View): void {
  const { image, cell } = floorImage(t.width, t.height);
  if (image) {
    // only the part in view: pixel i of the image is centred on world i * cell
    const i0 = Math.max(0, Math.floor(view.x0 / cell) - 1);
    const j0 = Math.max(0, Math.floor(view.y0 / cell) - 1);
    const i1 = Math.min(image.width, Math.ceil(view.x1 / cell) + 2);
    const j1 = Math.min(image.height, Math.ceil(view.y1 / cell) + 2);
    if (i1 > i0 && j1 > j0) {
      const smoothing = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "low";
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, t.width, t.height);
      ctx.clip();
      ctx.drawImage(image as CanvasImageSource, i0, j0, i1 - i0, j1 - j0, (i0 - 0.5) * cell, (j0 - 0.5) * cell, (i1 - i0) * cell, (j1 - j0) * cell);
      ctx.restore();
      ctx.imageSmoothingEnabled = smoothing;
    }
  }
}

// Draws the floor texture, the tint, the ground, then the rock, in world coordinates. scale: device pixels per world unit. view: the visible world rectangle.
// quick: flat fills without textures or images, for previews that redraw while settings change. Returns false while ground bitmaps, shelves or rock images
// are still being made and a stand-in drew in their place (draw again, or prepareTerrain first).
export function drawTerrain(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View = { x0: 0, x1: t.width, y0: 0, y1: t.height }, quick = false): boolean {
  if (t.empty) return true;
  if (!quick) {
    drawFloor(ctx, t, view);
    drawTint(ctx, t);
  }
  const ground = drawGround(ctx, t, scale, view, quick);
  const rock = drawRock(ctx, t, scale, view, quick);
  return ground && rock;
}

// Makes a frame's share of the bitmaps and images drawTerrain at this scale and view still waits for, without drawing. True when none is waiting.
export function prepareTerrain(t: Terrain, scale: number, view: View): boolean {
  const ground = prepareGround(t, scale, view);
  const rock = prepareRock(t, scale, view);
  return ground && rock;
}
