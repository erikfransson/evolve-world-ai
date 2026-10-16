import { GROUND_PAD } from "../sim/groundField.ts";
import { WEIGHT_UNIT } from "../sim/maps/weights.ts";
import type { Terrain } from "../sim/terrain.ts";
import { context2d, makeCanvas } from "./groundScene.ts";
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

// A separable box blur of radius r nodes, three times over (close to a gaussian), edges clamped.
function blur(a: Float32Array, cols: number, rows: number, r: number): void {
  const line = new Float32Array(Math.max(cols, rows) + 2 * r + 1);
  const pass = (n: number, stride: number, count: number, step: number): void => {
    for (let c = 0; c < count; c++) {
      const base = c * step;
      for (let i = 0; i < n; i++) line[i + r] = a[base + i * stride]!;
      for (let i = 0; i < r; i++) {
        line[i] = a[base]!;
        line[n + r + i] = a[base + (n - 1) * stride]!;
      }
      let sum = 0;
      for (let i = 0; i <= 2 * r; i++) sum += line[i]!;
      for (let i = 0; i < n; i++) {
        a[base + i * stride] = sum / (2 * r + 1);
        sum += line[i + 2 * r + 1]! - line[i]!;
      }
    }
  };
  for (let k = 0; k < 3; k++) {
    pass(cols, 1, rows, cols);
    pass(rows, cols, cols, 1);
  }
}

const BLUR_UNITS = 140; // world units the wash is softened over: a haze, not a stamp
const WISP_UNITS = 700; // size of the soft plumes that thin and thicken the haze

function build(t: Terrain): OffscreenCanvas | HTMLCanvasElement | null {
  const w = t.weights!;
  const canvas = makeCanvas(w.cols, w.rows);
  const g = context2d(canvas);
  if (!canvas || !g) return null;
  const image = g.createImageData(w.cols, w.rows);
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
  const r = Math.max(1, Math.round(BLUR_UNITS / w.cell / 2));
  for (const layer of layers) blur(layer, w.cols, w.rows, r);
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
    if (sum <= 0) continue;
    image.data[4 * k] = rgb[0]! / sum;
    image.data[4 * k + 1] = rgb[1]! / sum;
    image.data[4 * k + 2] = rgb[2]! / sum;
    image.data[4 * k + 3] = Math.round(255 * Math.min(1, top * wisp));
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
