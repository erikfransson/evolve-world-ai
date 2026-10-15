import { GROUND_PAD } from "../sim/groundField.ts";
import { WEIGHT_UNIT } from "../sim/maps/weights.ts";
import type { Terrain } from "../sim/terrain.ts";
import { context2d, makeCanvas } from "./groundScene.ts";

// A soft wash over the floor of a map with food and poison weights, so its regions read at a glance: purple where poison is rich, a dry tone where
// food is poor, a richer green where food is plentiful. One small image (a pixel per raster node) drawn scaled up smoothly under the ground and rock.

export const POISON_TINT = { rgb: [128, 84, 150], from: 1, span: 2.5, alpha: 0.17 } as const;
export const DRY_TINT = { rgb: [176, 152, 84], from: 0.8, span: 0.3, alpha: 0.24 } as const; // applies below `from`
export const RICH_TINT = { rgb: [56, 196, 116], from: 1.3, span: 0.5, alpha: 0.22 } as const;

// The weight above which a tint (not the dry one) is strong enough to see: its wash reaches this alpha. The legend shows a tint row from here.
const VISIBLE_ALPHA = 0.05;
export const visibleFrom = (t: { from: number; span: number; alpha: number }): number => t.from + (t.span * VISIBLE_ALPHA) / t.alpha;

const images = new WeakMap<Terrain, OffscreenCanvas | HTMLCanvasElement | null>();

function build(t: Terrain): OffscreenCanvas | HTMLCanvasElement | null {
  const w = t.weights!;
  const canvas = makeCanvas(w.cols, w.rows);
  const g = context2d(canvas);
  if (!canvas || !g) return null;
  const image = g.createImageData(w.cols, w.rows);
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  for (let n = 0; n < w.cols * w.rows; n++) {
    const food = w.food[n]! / WEIGHT_UNIT;
    const poison = w.poison[n]! / WEIGHT_UNIT;
    const candidates = [
      { tint: POISON_TINT, a: clamp01((poison - POISON_TINT.from) / POISON_TINT.span) * POISON_TINT.alpha },
      { tint: DRY_TINT, a: clamp01((DRY_TINT.from - food) / DRY_TINT.span) * DRY_TINT.alpha },
      { tint: RICH_TINT, a: clamp01((food - RICH_TINT.from) / RICH_TINT.span) * RICH_TINT.alpha },
    ];
    const best = candidates.reduce((m, c) => (c.a > m.a ? c : m));
    image.data[4 * n] = best.tint.rgb[0];
    image.data[4 * n + 1] = best.tint.rgb[1];
    image.data[4 * n + 2] = best.tint.rgb[2];
    image.data[4 * n + 3] = Math.round(255 * best.a);
  }
  g.putImageData(image, 0, 0);
  return canvas;
}

// Draws the wash over the whole world, in world coordinates; nothing for a map without weights.
export function drawTint(ctx: CanvasRenderingContext2D, t: Terrain): void {
  const w = t.weights;
  if (!w) return;
  let image = images.get(t);
  if (image === undefined) images.set(t, (image = build(t)));
  if (!image) return;
  const origin = -(GROUND_PAD + 0.5) * w.cell; // pixel i is centred on node i, which sits at (i - GROUND_PAD) cells
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image as CanvasImageSource, origin, origin, w.cols * w.cell, w.rows * w.cell);
}
