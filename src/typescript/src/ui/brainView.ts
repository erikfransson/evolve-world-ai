import type { Brain } from "../sim/brain.ts";
import type { SimConfig } from "../sim/config.ts";
import { EXTRA_INPUTS, RAY_FEATURES } from "../sim/types.ts";

const NEG_RGB = [96, 165, 250]; // cool blue
const POS_RGB = [251, 176, 38]; // warm amber
const NEUTRAL_RGB = [52, 70, 62];
const LABEL_COLOR = "#8fae9f";
const RING_COLOR = "rgba(214, 228, 220, 0.3)";

const NB = 6; // edge strength buckets per sign, drawn weakest first so strong edges end on top
const MIN_REL = 0.03; // edges below this share of the peak contribution are not drawn
const PEAK_FLOOR = 0.05;
const PEAK_DECAY = 0.985; // slow decay keeps the colour scale from flickering
const PALETTE_STEPS = 16;

const MARGIN_LEFT = 24;
const MARGIN_RIGHT = 40;
const MARGIN_Y = 10;
const GROUP_GAP = 0.8; // extra slots between ray clusters, in input pitches
const EXTRA_STEP = 2; // slots between the labelled extra inputs, so E, S and T fit
const FONT_PX = 9;

const mix = (a: number[], b: number[], t: number): string =>
  `rgb(${Math.round(a[0]! + (b[0]! - a[0]!) * t)}, ${Math.round(a[1]! + (b[1]! - a[1]!) * t)}, ${Math.round(a[2]! + (b[2]! - a[2]!) * t)})`;

// Node fill by activation, index = round(a * steps) + steps.
const NODE_FILL: string[] = [];
for (let k = -PALETTE_STEPS; k <= PALETTE_STEPS; k++) {
  NODE_FILL.push(mix(NEUTRAL_RGB, k < 0 ? NEG_RGB : POS_RGB, Math.abs(k) / PALETTE_STEPS));
}

// Edge style per (sign, bucket); sign 0 negative, 1 positive.
const EDGE_STYLE: string[] = [];
const EDGE_WIDTH: number[] = [];
for (let sign = 0; sign < 2; sign++) {
  const rgb = sign === 0 ? NEG_RGB : POS_RGB;
  for (let b = 0; b < NB; b++) {
    const u = (b + 0.5) / NB;
    EDGE_STYLE.push(`rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(0.06 + 0.8 * u ** 1.4).toFixed(3)})`);
    if (sign === 0) EDGE_WIDTH.push(0.5 + 1.7 * u);
  }
}

interface Layout {
  key: string;
  xs: Float32Array;
  ys: Float32Array[];
  radius: Float32Array;
  slot: number; // input pitch in CSS px
}

let layout: Layout | null = null;
let contrib = new Float32Array(0);
let codes = new Uint8Array(0);
const codeCounts = new Uint32Array(2 * NB + 1);
let peak = PEAK_FLOOR;

function buildLayout(key: string, sizes: readonly number[], rays: number, w: number, h: number): Layout {
  const nIn = sizes[0]!;
  const grouped = nIn === rays * RAY_FEATURES + EXTRA_INPUTS;
  const slots = nIn - 1 + (grouped ? GROUP_GAP * rays + (EXTRA_STEP - 1) * (EXTRA_INPUTS - 1) : 0);
  const availH = h - 2 * MARGIN_Y;
  const inPitch = slots > 0 ? Math.min(availH / slots, 14) : 0;
  const cols = sizes.length;
  const x0 = MARGIN_LEFT;
  const x1 = w - MARGIN_RIGHT;
  const xs = new Float32Array(cols);
  const ys: Float32Array[] = [];
  const radius = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const n = sizes[c]!;
    xs[c] = cols === 1 ? x0 : x0 + ((x1 - x0) * c) / (cols - 1);
    const y = new Float32Array(n);
    if (c === 0) {
      const mid = h / 2;
      const top = mid - (slots * inPitch) / 2;
      for (let i = 0; i < n; i++) {
        const gaps = grouped ? Math.min(Math.floor(i / RAY_FEATURES), rays) : 0;
        const extra = grouped ? Math.max(0, i - rays * RAY_FEATURES) * (EXTRA_STEP - 1) : 0;
        y[i] = top + (i + gaps * GROUP_GAP + extra) * inPitch;
      }
      radius[c] = Math.min(4, Math.max(1.1, inPitch * 0.42));
    } else {
      const pitch = Math.min(availH / Math.max(1, n - 1), 16);
      const top = h / 2 - ((n - 1) * pitch) / 2;
      for (let i = 0; i < n; i++) y[i] = top + i * pitch;
      radius[c] = c === cols - 1 ? 6 : Math.min(6, Math.max(2, pitch * 0.32));
    }
    ys.push(y);
  }
  return { key, xs, ys, radius, slot: inPitch };
}

// Redraws the network of one creature on its own canvas, in CSS pixel units.
export function drawBrain(ctx: CanvasRenderingContext2D, config: SimConfig, brain: Brain, alive = true): void {
  const canvas = ctx.canvas;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW <= 0 || cssH <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(cssW * dpr);
  const ph = Math.round(cssH * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const sizes = brain.sizes;
  const rays = config.creature.rayCount;
  const key = `${sizes.join(",")}|${rays}|${cssW}x${cssH}`;
  if (layout === null || layout.key !== key) layout = buildLayout(key, sizes, rays, cssW, cssH);
  const { xs, ys, radius } = layout;
  const acts = brain.layerActivations();
  const layers = sizes.length - 1;

  let total = 0;
  for (let l = 0; l < layers; l++) total += sizes[l]! * sizes[l + 1]!;
  if (contrib.length !== total) {
    contrib = new Float32Array(total);
    codes = new Uint8Array(total);
  }

  // Contribution of each edge, weight times source activation.
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
  peak = Math.max(PEAK_FLOOR, maxAbs, peak * PEAK_DECAY);

  codeCounts.fill(0);
  for (let k = 0; k < total; k++) {
    const c = contrib[k]!;
    const rel = Math.abs(c) / peak;
    if (rel < MIN_REL) {
      codes[k] = 0;
      continue;
    }
    const b = Math.min(NB - 1, Math.floor(Math.sqrt(rel) * NB));
    const code = 1 + (c < 0 ? 0 : NB) + b;
    codes[k] = code;
    codeCounts[code]!++;
  }

  const dim = alive ? 1 : 0.3;
  ctx.globalAlpha = dim;
  ctx.lineCap = "round";
  for (let b = 0; b < NB; b++) {
    for (let sign = 0; sign < 2; sign++) {
      const code = 1 + sign * NB + b;
      if (codeCounts[code] === 0) continue;
      ctx.strokeStyle = EDGE_STYLE[sign * NB + b]!;
      ctx.lineWidth = EDGE_WIDTH[b]!;
      ctx.beginPath();
      let k = 0;
      for (let l = 0; l < layers; l++) {
        const nIn = sizes[l]!;
        const nOut = sizes[l + 1]!;
        const ya = ys[l]!;
        const yb = ys[l + 1]!;
        const xa = xs[l]!;
        const xb = xs[l + 1]!;
        const xm = (xa + xb) / 2;
        for (let j = 0; j < nOut; j++) {
          for (let i = 0; i < nIn; i++, k++) {
            if (codes[k] !== code) continue;
            ctx.moveTo(xa, ya[i]!);
            ctx.bezierCurveTo(xm, ya[i]!, xm, yb[j]!, xb, yb[j]!);
          }
        }
      }
      ctx.stroke();
    }
  }

  // Nodes.
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = RING_COLOR;
  for (let c = 0; c <= layers; c++) {
    const r = radius[c]!;
    const act = acts[c]!;
    const y = ys[c]!;
    const x = xs[c]!;
    for (let i = 0; i < y.length; i++) {
      const a = Math.max(-1, Math.min(1, act[i]!));
      ctx.fillStyle = NODE_FILL[Math.round(a * PALETTE_STEPS) + PALETTE_STEPS]!;
      ctx.beginPath();
      ctx.arc(x, y[i]!, r, 0, Math.PI * 2);
      ctx.fill();
      if (r >= 1.8) ctx.stroke();
    }
  }

  // Labels.
  ctx.fillStyle = LABEL_COLOR;
  ctx.font = `${FONT_PX}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  const yIn = ys[0]!;
  const lx = xs[0]! - radius[0]! - 5;
  if (yIn.length === rays * RAY_FEATURES + EXTRA_INPUTS) {
    const every = (RAY_FEATURES + GROUP_GAP) * layout.slot >= FONT_PX + 1;
    for (let g = 0; g < rays; g++) {
      if (!every && g !== 0 && g !== rays - 1) continue;
      const k = g * RAY_FEATURES;
      ctx.fillText(`R${g + 1}`, lx, (yIn[k]! + yIn[k + RAY_FEATURES - 1]!) / 2);
    }
    const base = rays * RAY_FEATURES;
    const extras = ["E", "S", "T"];
    for (let k = 0; k < EXTRA_INPUTS; k++) ctx.fillText(extras[k]!, lx, yIn[base + k]!);
  }
  ctx.textAlign = "left";
  const yOut = ys[layers]!;
  const ox = xs[layers]! + radius[layers]! + 5;
  const outLabels = ["turn", "thrust"];
  for (let k = 0; k < yOut.length && k < outLabels.length; k++) ctx.fillText(outLabels[k]!, ox, yOut[k]!);

  if (!alive) {
    ctx.globalAlpha = 1;
    ctx.font = `600 16px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    const tw = ctx.measureText("dead").width;
    ctx.fillStyle = "rgba(8, 20, 15, 0.8)";
    ctx.beginPath();
    ctx.roundRect(cssW / 2 - tw / 2 - 10, cssH / 2 - 14, tw + 20, 28, 8);
    ctx.fill();
    ctx.fillStyle = "#d6e4dc";
    ctx.fillText("dead", cssW / 2, cssH / 2 + 1);
  }
  ctx.globalAlpha = 1;
}
