import type { Brain } from "../sim/brain.ts";
import { EXTRA_INPUTS, FEAT_CREATURE, FEAT_FOOD, FEAT_POISON, INPUT_EXTRA_LABELS, OUTPUT_LABELS, RAY_FEATURE_LABELS } from "../sim/sensors.ts";
import type { InputLayout } from "../sim/sensors.ts";
import { fitCanvas } from "./canvas.ts";

const POS_RGB = [255, 107, 107]; // red, positive
const NEG_RGB = [78, 168, 255]; // blue, negative
const NODE_BASE = "#153427";
const NODE_EMPTY = "#0f241b"; // inputs at exactly 0 read as hollow
const RING = "#2c5744";
const TRACK = "rgba(44, 87, 68, 0.5)";
const LABEL_COLOR = "#8fae9f";
const TEXT_COLOR = "#d6e4dc";
const FOOD_COLOR = "#4ade80";
const POISON_COLOR = "#e040fb";
const CREATURE_COLOR = "#7dd3fc";
const FEATURE_LETTERS: Record<string, string> = { closeness: "c", food: "f", poison: "p", wall: "w", creature: "o", "seen energy": "e" };
const FEATURE_COLORS = [TEXT_COLOR, FOOD_COLOR, POISON_COLOR, LABEL_COLOR, CREATURE_COLOR, CREATURE_COLOR];
const HIT_LEVEL = 0.5;

const NB = 6; // edge strength buckets per sign, drawn weakest first so strong edges end on top
const MIN_REL = 0.07; // edges below this share of the peak contribution are not drawn
const PEAK_FLOOR = 0.05;
const PEAK_DECAY = 0.985; // slow decay keeps the colour scale from flickering
const PALETTE_STEPS = 16;

const GRID_X = 38; // x of the first feature column
const FEAT_DX = 12;
const IN_RADIUS = 2.6;
const ROW_MAX = 12;
const HEADER_H = 15; // feature header band above the first ray row
const EXTRA_BELOW = 14; // E S L T labels and padding under the extras row
const MARGIN_Y = 6;
const OUT_RADIUS = 8;
const OUT_PITCH = 36;
const GAUGE_GAP = 3;
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const ROW_FONT = `500 10px ${FONT_FAMILY}`;
const SMALL_FONT = `9px ${FONT_FAMILY}`;
const OUT_FONT = `600 15px ${FONT_FAMILY}`;
const DEAD_FONT = `600 16px ${FONT_FAMILY}`;
const EXTRA_SHORT = INPUT_EXTRA_LABELS.map((l) => l[0]!.toUpperCase()); // E, S, L, T

const rgba = (c: number[], a: number): string => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a.toFixed(3)})`;

// Activation overlay by |a|, per sign (0 negative, 1 positive), index = round(|a| * steps).
const HUE_FILL: string[][] = [[], []];
for (let sign = 0; sign < 2; sign++) {
  for (let k = 0; k <= PALETTE_STEPS; k++) HUE_FILL[sign]!.push(rgba(sign === 0 ? NEG_RGB : POS_RGB, (k / PALETTE_STEPS) ** 0.7));
}
const HUE_RING = [rgba(NEG_RGB, 0.9), rgba(POS_RGB, 0.9)];
const HUE_SOLID = [rgba(NEG_RGB, 1), rgba(POS_RGB, 1)];

// Edge style per (sign, bucket), index sign * NB + b.
const EDGE_STYLE: string[] = [];
const EDGE_WIDTH: number[] = [];
const EDGE_GLOW = [rgba(NEG_RGB, 0.55), rgba(POS_RGB, 0.55)];
for (let sign = 0; sign < 2; sign++) {
  const rgb = sign === 0 ? NEG_RGB : POS_RGB;
  for (let b = 0; b < NB; b++) {
    const u = (b + 0.5) / NB;
    EDGE_STYLE.push(rgba(rgb, 0.12 + 0.78 * u ** 1.3));
    if (sign === 0) EDGE_WIDTH.push(0.6 + 1.6 * u);
  }
}

export interface Layout {
  sizes: readonly number[];
  features: number; // input columns per ray
  w: number;
  h: number;
  xs: Float32Array[]; // per node, since the input grid spans several x
  ys: Float32Array[];
  radius: Float32Array;
  pitch: number; // ray row pitch in CSS px
  rays: number;
  headerY: number;
  extraLabelY: number;
  outLabelX: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// The input layer is drawn as one row per ray with one column per ray feature, then a row of the extra inputs.
export function buildLayout(ctx: CanvasRenderingContext2D, sizes: readonly number[], features: number, w: number, h: number): Layout {
  const nIn = sizes[0]!;
  const rays = (nIn - EXTRA_INPUTS) / features;
  const cols = sizes.length;
  const pitch = clamp((h - 2 * MARGIN_Y - HEADER_H - EXTRA_BELOW - 4) / (rays + 1), 1, ROW_MAX);
  const extraGap = pitch + 4;
  const blockH = HEADER_H + (rays - 1) * pitch + extraGap + EXTRA_BELOW;
  const top = (h - blockH) / 2;
  const row0 = top + HEADER_H;

  const xs: Float32Array[] = [];
  const ys: Float32Array[] = [];
  const radius = new Float32Array(cols);

  const xIn = new Float32Array(nIn);
  const yIn = new Float32Array(nIn);
  for (let r = 0; r < rays; r++) {
    for (let f = 0; f < features; f++) {
      xIn[r * features + f] = GRID_X + f * FEAT_DX;
      yIn[r * features + f] = row0 + r * pitch;
    }
  }
  const yExtra = row0 + (rays - 1) * pitch + extraGap;
  for (let k = 0; k < EXTRA_INPUTS; k++) {
    xIn[rays * features + k] = GRID_X + (features - EXTRA_INPUTS + k) * FEAT_DX;
    yIn[rays * features + k] = yExtra;
  }
  xs.push(xIn);
  ys.push(yIn);
  radius[0] = IN_RADIUS;

  ctx.font = OUT_FONT;
  let labelW = 0;
  for (const l of OUTPUT_LABELS) labelW = Math.max(labelW, ctx.measureText(l).width);
  const outLabelX = w - 8 - labelW;
  const outX = outLabelX - 6 - GAUGE_GAP - 1 - OUT_RADIUS;
  const gridRight = GRID_X + (features - 1) * FEAT_DX;

  for (let c = 1; c < cols; c++) {
    const n = sizes[c]!;
    const last = c === cols - 1;
    const x = gridRight + ((outX - gridRight) * c) / (cols - 1);
    const pitchC = last ? OUT_PITCH : Math.min(13, (h - 16) / Math.max(1, n - 1));
    const y = new Float32Array(n);
    const t = h / 2 - ((n - 1) * pitchC) / 2;
    for (let i = 0; i < n; i++) y[i] = t + i * pitchC;
    xs.push(new Float32Array(n).fill(x));
    ys.push(y);
    radius[c] = last ? OUT_RADIUS : clamp(0.36 * pitchC, 2, 4.8);
  }
  return { sizes: sizes.slice(), features, w, h, xs, ys, radius, pitch, rays, headerY: top + 3, extraLabelY: yExtra + IN_RADIUS + 7, outLabelX };
}

function fits(layout: Layout | null, sizes: readonly number[], features: number, w: number, h: number): layout is Layout {
  if (layout === null || layout.features !== features || layout.w !== w || layout.h !== h || layout.sizes.length !== sizes.length) return false;
  for (let i = 0; i < sizes.length; i++) if (layout.sizes[i] !== sizes[i]) return false;
  return true;
}

const TRIALS_LAYOUT = { rayFeatureLabels: RAY_FEATURE_LABELS };

// Redraws the network of one creature on its own canvas, in CSS pixel units.
export class BrainView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private layout: Layout | null = null;
  private contrib = new Float32Array(0);
  private codes = new Uint8Array(0);
  private readonly codeCounts = new Uint32Array(2 * NB + 1);
  private peak = PEAK_FLOOR;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  // layout says what the input columns mean; the default is the four ray features of Trials.
  draw(brain: Brain, alive = true, layout: Pick<InputLayout, "rayFeatureLabels"> = TRIALS_LAYOUT): void {
    const { canvas, ctx } = this;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    const dpr = fitCanvas(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const sizes = brain.sizes;
    const labels = layout.rayFeatureLabels;
    if (!fits(this.layout, sizes, labels.length, cssW, cssH)) this.layout = buildLayout(ctx, sizes, labels.length, cssW, cssH);
    const placed = this.layout!;
    const acts = brain.layerActivations();

    this.bucketEdges(brain, acts);
    ctx.globalAlpha = alive ? 1 : 0.3;
    this.drawEdges(sizes, placed);
    this.drawNodes(placed, acts);
    this.drawGauges(placed, acts);
    this.drawLabels(placed, labels, acts);
    if (!alive) this.drawDead(cssW, cssH);
    ctx.globalAlpha = 1;
  }

  // Classifies each edge by sign and strength of its contribution, weight times source activation.
  private bucketEdges(brain: Brain, acts: readonly Float32Array[]): void {
    const sizes = brain.sizes;
    const layers = sizes.length - 1;
    let total = 0;
    for (let l = 0; l < layers; l++) total += sizes[l]! * sizes[l + 1]!;
    if (this.contrib.length !== total) {
      this.contrib = new Float32Array(total);
      this.codes = new Uint8Array(total);
    }
    const { contrib, codes, codeCounts } = this;

    let maxAbs = 0;
    let e = 0;
    for (let l = 0; l < layers; l++) {
      const nIn = sizes[l]!;
      const nOut = sizes[l + 1]!;
      const w = brain.weights[l]!;
      const src = acts[l]!;
      for (let j = 0; j < nOut; j++) {
        const row = j * nIn;
        for (let i = 0; i < nIn; i++) {
          const c = w[row + i]! * src[i]!;
          contrib[e++] = c;
          const a = c < 0 ? -c : c;
          if (a > maxAbs) maxAbs = a;
        }
      }
    }
    this.peak = Math.max(PEAK_FLOOR, maxAbs, this.peak * PEAK_DECAY);

    codeCounts.fill(0);
    for (let k = 0; k < total; k++) {
      const c = contrib[k]!;
      const rel = Math.abs(c) / this.peak;
      if (rel < MIN_REL) {
        codes[k] = 0;
        continue;
      }
      const b = Math.min(NB - 1, Math.floor(Math.sqrt(rel) * NB));
      const code = 1 + (c < 0 ? 0 : NB) + b;
      codes[k] = code;
      codeCounts[code]!++;
    }
  }

  private drawEdges(sizes: readonly number[], { xs, ys }: Layout): void {
    const { ctx, codes, codeCounts } = this;
    const layers = sizes.length - 1;
    ctx.lineCap = "round";
    ctx.globalCompositeOperation = "lighter";
    for (let b = 0; b < NB; b++) {
      for (let sign = 0; sign < 2; sign++) {
        const code = 1 + sign * NB + b;
        if (codeCounts[code] === 0) continue;
        ctx.strokeStyle = EDGE_STYLE[sign * NB + b]!;
        ctx.lineWidth = EDGE_WIDTH[b]!;
        if (b === NB - 1) {
          ctx.shadowBlur = 5;
          ctx.shadowColor = EDGE_GLOW[sign]!;
        }
        ctx.beginPath();
        let k = 0;
        for (let l = 0; l < layers; l++) {
          const nIn = sizes[l]!;
          const nOut = sizes[l + 1]!;
          const xa = xs[l]!;
          const xb = xs[l + 1]!;
          const ya = ys[l]!;
          const yb = ys[l + 1]!;
          for (let j = 0; j < nOut; j++) {
            for (let i = 0; i < nIn; i++, k++) {
              if (codes[k] !== code) continue;
              ctx.moveTo(xa[i]!, ya[i]!);
              ctx.lineTo(xb[j]!, yb[j]!);
            }
          }
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.shadowColor = "transparent";
  }

  private drawNodes({ xs, ys, radius }: Layout, acts: readonly Float32Array[]): void {
    const ctx = this.ctx;
    ctx.lineWidth = 1;
    for (let c = 0; c < ys.length; c++) {
      const r = radius[c]!;
      const act = acts[c]!;
      const y = ys[c]!;
      const x = xs[c]!;
      for (let i = 0; i < y.length; i++) {
        const v = act[i]!;
        const a = v < -1 ? -1 : v > 1 ? 1 : v;
        const mag = a < 0 ? -a : a;
        const sign = a < 0 ? 0 : 1;
        ctx.beginPath();
        ctx.arc(x[i]!, y[i]!, r, 0, Math.PI * 2);
        ctx.fillStyle = c === 0 && a === 0 ? NODE_EMPTY : NODE_BASE;
        ctx.fill();
        const step = Math.round(mag * PALETTE_STEPS);
        if (step > 0) {
          ctx.fillStyle = HUE_FILL[sign]![step]!;
          ctx.fill();
        }
        ctx.strokeStyle = mag > 0.5 ? HUE_RING[sign]! : RING;
        ctx.stroke();
      }
    }
  }

  // Output gauges: arc from 12 o'clock sweeping |a| * pi, clockwise when positive.
  private drawGauges({ xs, ys, radius }: Layout, acts: readonly Float32Array[]): void {
    const ctx = this.ctx;
    const c = ys.length - 1;
    const r = radius[c]! + GAUGE_GAP;
    const act = acts[c]!;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for (let i = 0; i < act.length; i++) {
      const x = xs[c]![i]!;
      const y = ys[c]![i]!;
      ctx.strokeStyle = TRACK;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      const v = act[i]!;
      const a = v < -1 ? -1 : v > 1 ? 1 : v;
      if (Math.abs(a) < 0.02) continue;
      ctx.strokeStyle = HUE_SOLID[a < 0 ? 0 : 1]!;
      ctx.beginPath();
      ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + a * Math.PI, a < 0);
      ctx.stroke();
    }
  }

  private drawLabels({ xs, ys, pitch, rays, features, headerY, extraLabelY, outLabelX }: Layout, labels: readonly string[], acts: readonly Float32Array[]): void {
    const ctx = this.ctx;
    const last = ys.length - 1;
    const yIn = ys[0]!;
    const xIn = xs[0]!;
    const inAct = acts[0]!;
    ctx.textBaseline = "middle";

    ctx.font = SMALL_FONT;
    ctx.textAlign = "center";
    for (let f = 0; f < features; f++) {
      ctx.fillStyle = FEATURE_COLORS[f]!;
      ctx.fillText(FEATURE_LETTERS[labels[f]!] ?? labels[f]![0]!, GRID_X + f * FEAT_DX, headerY);
    }
    ctx.fillStyle = LABEL_COLOR;
    for (let k = 0; k < EXTRA_INPUTS; k++) ctx.fillText(EXTRA_SHORT[k]!, xIn[rays * features + k]!, extraLabelY);

    // Ray rows light up green for food and magenta for poison, read from the input features.
    ctx.font = ROW_FONT;
    ctx.textAlign = "right";
    const lx = GRID_X - IN_RADIUS - 5;
    const every = pitch >= 9;
    for (let r = 0; r < rays; r++) {
      const k = r * features;
      const food = inAct[k + FEAT_FOOD]!;
      const poison = inAct[k + FEAT_POISON]!;
      const creature = features > FEAT_CREATURE ? inAct[k + FEAT_CREATURE]! : 0;
      const hit = food > HIT_LEVEL || poison > HIT_LEVEL || creature > HIT_LEVEL;
      const color = !hit ? LABEL_COLOR : creature > HIT_LEVEL ? CREATURE_COLOR : food >= poison ? FOOD_COLOR : POISON_COLOR;
      if (every || r % 2 === 0) {
        ctx.fillStyle = color;
        ctx.fillText(`R${r + 1}`, lx, yIn[k]!);
      } else if (hit) {
        ctx.fillStyle = color;
        ctx.fillRect(lx - 3, yIn[k]! - 1, 3, 2);
      }
    }

    ctx.textAlign = "left";
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = OUT_FONT;
    const yOut = ys[last]!;
    for (let k = 0; k < yOut.length && k < OUTPUT_LABELS.length; k++) ctx.fillText(OUTPUT_LABELS[k]!, outLabelX, yOut[k]!);

    this.drawKey();
  }

  // Tiny sign key at the bottom-right corner.
  private drawKey(): void {
    const ctx = this.ctx;
    const y = this.canvas.clientHeight - 8;
    const items = [["\u2212", NEG_RGB], ["+", POS_RGB]] as const;
    ctx.font = SMALL_FONT;
    ctx.textAlign = "right";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    let x = this.canvas.clientWidth - 8;
    for (const [text, rgb] of items) {
      ctx.fillStyle = LABEL_COLOR;
      ctx.fillText(text, x, y);
      const sx = x - ctx.measureText(text).width - 3;
      ctx.strokeStyle = rgba(rgb, 1);
      ctx.beginPath();
      ctx.moveTo(sx - 9, y);
      ctx.lineTo(sx, y);
      ctx.stroke();
      x = sx - 9 - 8;
    }
  }

  private drawDead(cssW: number, cssH: number): void {
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.font = DEAD_FONT;
    ctx.textAlign = "center";
    const tw = ctx.measureText("dead").width;
    ctx.fillStyle = "rgba(8, 20, 15, 0.8)";
    ctx.beginPath();
    ctx.roundRect(cssW / 2 - tw / 2 - 10, cssH / 2 - 14, tw + 20, 28, 8);
    ctx.fill();
    ctx.fillStyle = "#d6e4dc";
    ctx.fillText("dead", cssW / 2, cssH / 2 + 1);
  }
}
