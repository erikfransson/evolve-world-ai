import { GROUND_PAD } from "../sim/groundField.ts";
import { WEIGHT_UNIT } from "../sim/maps/weights.ts";
import type { Terrain } from "../sim/terrain.ts";
import { context2d, makeCanvas } from "./groundScene.ts";
import { boxBlur } from "./edt.ts";
import { fbm } from "./noiseTex.ts";

// A soft wash over the floor of a map with food and poison weights, so its regions read at a glance: a murky violet haze where poison is rich, a faint silt-pale tone where
// food is poor, a bioluminescent green haze where food is plentiful. One small image (a pixel per raster node) drawn scaled up smoothly under the ground and rock.

export const POISON_TINT = { rgb: [165, 66, 160], from: 1, span: 2.5, alpha: 0.27 } as const;
export const DRY_TINT = { rgb: [150, 138, 100], from: 0.8, span: 0.3, alpha: 0.09 } as const; // applies below `from`
export const RICH_TINT = { rgb: [40, 200, 140], from: 1.3, span: 0.5, alpha: 0.125 } as const;

// The weight above which a tint (not the dry one) is strong enough to see: its wash reaches this alpha. The legend shows a tint row from here.
const VISIBLE_ALPHA = 0.05;
export const visibleFrom = (t: { from: number; span: number; alpha: number }): number => t.from + (t.span * VISIBLE_ALPHA) / t.alpha;

const images = new WeakMap<Terrain, OffscreenCanvas | HTMLCanvasElement | null>();

const HAZE_SIGMA = 280; // world units: the food and poison hazes are blurred about this Gaussian width, a haze and not a stamp (the paint is not blurred)
const WISP_UNITS = 700; // size of the soft plumes that thin and thicken the haze
const PAINT_STEP = 4; // a painted map's wash is shipped in steps of 4 levels, ordered-dithered, so it gzips small without terraces
// 4 x 4 Bayer thresholds, centred: an ordered dither that breaks rounding steps into a fine even pattern (and repeats, so it gzips well)
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);
const dithered = (v: number, i: number, j: number, step: number): number => step * Math.round(v / step + BAYER[(i & 3) + 4 * (j & 3)]!);

// The wash's RGBA pixels, a pixel per raster node, which need no canvas (the build ships the Live map's, see live/mapAsset.ts).
export function tintPixels(t: Terrain): Uint8ClampedArray<ArrayBuffer> {
  const w = t.weights!;
  const image = { data: new Uint8ClampedArray(4 * w.cols * w.rows) };
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  const n = w.cols * w.rows;
  const tints = [POISON_TINT, DRY_TINT, RICH_TINT];
  const layers = tints.map(() => new Float32Array(n));
  for (let k = 0; k < n; k++) {
    const food = w.food[k]! / WEIGHT_UNIT;
    const poison = w.poison[k]! / WEIGHT_UNIT;
    layers[0]![k] = clamp01((poison - POISON_TINT.from) / POISON_TINT.span) * POISON_TINT.alpha;
    layers[1]![k] = clamp01((DRY_TINT.from - food) / DRY_TINT.span) * DRY_TINT.alpha;
    layers[2]![k] = clamp01((food - RICH_TINT.from) / RICH_TINT.span) * RICH_TINT.alpha;
  }
  const sc = HAZE_SIGMA / w.cell;
  const r = Math.max(1, Math.round((Math.sqrt(1 + 4 * sc * sc) - 1) / 2)); // three box passes of radius r have a variance of r (r + 1) cells^2
  for (const layer of layers) boxBlur(layer, w.cols, w.rows, r);
  const step = w.paint ? PAINT_STEP : 1;
  for (let k = 0; k < n; k++) {
    const x = ((k % w.cols) - GROUND_PAD) * w.cell;
    const y = (Math.floor(k / w.cols) - GROUND_PAD) * w.cell;
    const wisp = 0.6 + 0.8 * (0.5 + 0.5 * fbm(x / WISP_UNITS, y / WISP_UNITS, 71, 3)); // 0.6 .. 1.4
    let sum = 0;
    let top = 0;
    let rgb = [0, 0, 0];
    for (let i = 0; i < tints.length; i++) {
      const a = layers[i]![k]!;
      sum += a;
      top = Math.max(top, a);
      rgb = [rgb[0]! + a * tints[i]!.rgb[0], rgb[1]! + a * tints[i]!.rgb[1], rgb[2]! + a * tints[i]!.rgb[2]];
    }
    // A map's paint lies under the hazes, thinned a little where the wisps are thin so it is not a flat stamp.
    const pa = w.paint ? (w.paint[4 * k + 3]! / 255) * (0.8 + 0.25 * (wisp - 0.6)) : 0;
    const ta = sum > 0 ? Math.min(1, top * wisp) : 0;
    const a = ta + pa * (1 - ta);
    if (a <= 0) continue;
    const i = k % w.cols;
    const j = (k - i) / w.cols;
    for (let c = 0; c < 3; c++) {
      const tc = sum > 0 ? rgb[c]! / sum : 0;
      const pc = pa > 0 ? w.paint![4 * k + c]! : 0;
      image.data[4 * k + c] = dithered((tc * ta + pc * pa * (1 - ta)) / a, i + c, j, step);
    }
    image.data[4 * k + 3] = dithered(255 * a, i + 3, j + 1, step);
  }
  return image.data;
}

function build(t: Terrain, px: Uint8ClampedArray<ArrayBuffer>): OffscreenCanvas | HTMLCanvasElement | null {
  const w = t.weights!;
  const canvas = makeCanvas(w.cols, w.rows);
  const g = context2d(canvas);
  if (!canvas || !g || typeof ImageData === "undefined") return null;
  g.putImageData(new ImageData(px, w.cols, w.rows), 0, 0);
  return canvas;
}

// Makes drawTint use these pixels (tintPixels made elsewhere) for t instead of computing them. False when they do not fit its raster.
export function seedTint(t: Terrain, px: Uint8ClampedArray<ArrayBuffer>): boolean {
  const w = t.weights;
  if (!w || px.length !== 4 * w.cols * w.rows) return false;
  if (!images.get(t)) images.set(t, build(t, px));
  return true;
}

// Draws the wash over the whole world, in world coordinates; nothing for a map without weights.
export function drawTint(ctx: CanvasRenderingContext2D, t: Terrain): void {
  const w = t.weights;
  if (!w) return;
  let image = images.get(t);
  if (image === undefined) images.set(t, (image = build(t, tintPixels(t))));
  if (!image) return;
  const origin = -(GROUND_PAD + 0.5) * w.cell; // pixel i is centred on node i, which sits at (i - GROUND_PAD) cells
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image as CanvasImageSource, origin, origin, w.cols * w.cell, w.rows * w.cell);
}
