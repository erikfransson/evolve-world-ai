import type { RlIteration } from "../worker/rlProtocol.ts";
import { fitCanvas, graphFont } from "./canvas.ts";
import { LABEL, OTHER } from "./palette.ts";

export const TRAIN_COLOR = OTHER;
export const BEST_COLOR = "#fbbf24";
export const HELD_COLOR = "#3ddc97";
const DOWN_COLOR = "#f87171";
const GRID_COLOR = "rgba(143, 174, 159, 0.15)";
const START_COLOR = "rgba(230, 244, 234, 0.55)";
const PANEL_BG = "rgba(3, 12, 9, 0.35)";
const TRAIN_MUTED = "rgba(125, 211, 252, 0.6)";

interface Point {
  iter: number;
  v: number;
}

// Round tick positions: a step of 1, 2 or 5 times a power of ten, at most `maxCount` ticks inside [lo, hi]. `lo` and `hi` are the range snapped out to tick bounds.
export function niceTicks(lo: number, hi: number, maxCount: number): { ticks: number[]; lo: number; hi: number; step: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { ticks: [0, 1], lo: 0, hi: 1, step: 1 };
  if (lo > hi) [lo, hi] = [hi, lo];
  if (hi - lo < 1e-9) {
    const pad = Math.max(0.5, Math.abs(lo) * 0.05);
    lo -= pad;
    hi += pad;
  }
  const count = Math.max(2, Math.floor(maxCount));
  const raw = (hi - lo) / (count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = mag;
  for (const m of [1, 2, 5, 10]) {
    step = m * mag;
    if (step >= raw * (1 - 1e-9)) break;
  }
  const first = Math.floor(lo / step + 1e-9);
  const lastK = Math.ceil(hi / step - 1e-9);
  const ticks: number[] = [];
  for (let k = first; k <= lastK; k++) ticks.push(Number((k * step).toPrecision(12)));
  return { ticks, lo: ticks[0]!, hi: ticks[ticks.length - 1]!, step };
}

// A tick or value as text with just the decimals the step needs: "5", "2.5", never "-0" or "5.0".
export function tickLabel(v: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
  const s = v.toFixed(decimals);
  return Number(s) === 0 ? "0" : s.replace("-", "−");
}

// A signed change in one decimal: "+6.4", "−0.1".
const signed = (d: number): string => `${d < 0 ? "−" : "+"}${Math.abs(d).toFixed(1)}`;

// At most about `max` points: each bucket of neighbours becomes one point at their mean, so a 5000 iteration run draws in a few hundred segments.
export function thin(pts: readonly Point[], max: number): Point[] {
  if (pts.length <= max) return pts.slice();
  const out: Point[] = [];
  const size = pts.length / max;
  for (let b = 0; b < max; b++) {
    const from = Math.floor(b * size);
    const to = Math.max(from + 1, Math.floor((b + 1) * size));
    let it = 0;
    let v = 0;
    for (let k = from; k < to; k++) {
      it += pts[k]!.iter;
      v += pts[k]!.v;
    }
    out.push({ iter: it / (to - from), v: v / (to - from) });
  }
  return out;
}

// Like thin but keeps each bucket's lowest and highest point in order, so a spike in a noisy trace survives (about `max` points out, 2 per bucket).
export function thinMinMax(pts: readonly Point[], max: number): Point[] {
  if (pts.length <= max) return pts.slice();
  const buckets = Math.max(1, Math.floor(max / 2));
  const out: Point[] = [];
  const size = pts.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * size);
    const to = Math.max(from + 1, Math.floor((b + 1) * size));
    let lo = pts[from]!;
    let hi = lo;
    for (let k = from + 1; k < to; k++) {
      const p = pts[k]!;
      if (p.v < lo.v) lo = p;
      if (p.v > hi.v) hi = p;
    }
    if (lo === hi) out.push(lo);
    else out.push(...(lo.iter < hi.iter ? [lo, hi] : [hi, lo]));
  }
  return out;
}

// The trend of a noisy curve: a centred moving average over 2h+1 points, h about a thirtieth of the points but at least 2 and at most `maxHalf`, narrower at the ends. O(n).
export function smooth(pts: readonly Point[], maxHalf = 60): Point[] {
  const n = pts.length;
  const h = Math.min(maxHalf, Math.max(2, Math.round(n / 30)));
  const sum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i]! + pts[i]!.v;
  return pts.map((p, i) => {
    const lo = Math.max(0, i - h);
    const hi = Math.min(n, i + h + 1);
    return { iter: p.iter, v: (sum[hi]! - sum[lo]!) / (hi - lo) };
  });
}

const HELD_HALF = 20; // held-out checks come every 5th iteration, so the trend spans at most 41 checks (205 iterations)
const TRAIN_HALF = 60;

// The sizes of the plot in CSS px, for a canvas of cssW x cssH.
function layout(cssW: number, cssH: number): { left: number; right: number; top: number; bottom: number } {
  const wide = cssW >= 520;
  return { left: wide ? 50 : 42, right: wide ? 96 : 72, top: 12, bottom: wide ? 40 : 36 };
}

// Draws the learning curve as the gain since the start: the start value as a labelled baseline, the held-out trend ("on new worlds") filled against it (green above, red below)
// over its faint raw checks, the average try (training) as one thin trend line, and the latest gain bracketed at the right end.
export function drawRewardGraph(ctx: CanvasRenderingContext2D, its: readonly RlIteration[], start: number | null, cssW: number, cssH: number): void {
  ctx.clearRect(0, 0, cssW, cssH);
  const pad = layout(cssW, cssH);
  const x0 = pad.left;
  const w = cssW - pad.left - pad.right;
  const h = cssH - pad.top - pad.bottom;
  if (w <= 40 || h <= 40) return;
  const held: Point[] = [];
  if (start !== null) held.push({ iter: 0, v: start });
  for (const it of its) if (it.held !== null) held.push({ iter: it.iter, v: it.held });
  const train = its.map((it) => ({ iter: it.iter, v: it.train }));
  const heldTrend = smooth(held, HELD_HALF);
  const trainTrend = smooth(train, TRAIN_HALF);
  const last = Math.max(1, its.length ? its[its.length - 1]!.iter : 1);
  const font = graphFont();
  const fontPx = parseFloat(font);
  ctx.font = font;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // The y range follows the two trends and the start, not the raw spikes, which are clipped to the plot.
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of [...heldTrend, ...trainTrend]) {
    if (!Number.isFinite(p.v)) continue;
    lo = Math.min(lo, p.v);
    hi = Math.max(hi, p.v);
  }
  if (start !== null && Number.isFinite(start)) {
    lo = Math.min(lo, start);
    hi = Math.max(hi, start);
  }
  if (lo > hi) [lo, hi] = [0, 1];
  const yt = niceTicks(lo, hi, Math.max(3, Math.min(7, Math.floor(h / 40))));
  const xt = niceTicks(0, last, Math.max(3, Math.min(8, Math.floor(w / 80))));
  const px = (i: number): number => x0 + (i / last) * w;
  const py = (v: number): number => pad.top + h - ((v - yt.lo) / (yt.hi - yt.lo)) * h;
  const maxPts = Math.max(2, Math.floor(w));

  ctx.fillStyle = PANEL_BG;
  ctx.fillRect(x0, pad.top, w, h);
  ctx.lineWidth = 1;
  ctx.strokeStyle = GRID_COLOR;
  ctx.beginPath();
  for (const v of yt.ticks) {
    ctx.moveTo(x0, py(v));
    ctx.lineTo(x0 + w, py(v));
  }
  for (const t of xt.ticks) {
    if (t === 0 || t > last) continue;
    ctx.moveTo(px(t), pad.top);
    ctx.lineTo(px(t), pad.top + h);
  }
  ctx.stroke();
  ctx.fillStyle = LABEL;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const v of yt.ticks) ctx.fillText(tickLabel(v, yt.step), x0 - 6, py(v));
  ctx.textBaseline = "top";
  for (const t of xt.ticks) {
    if (t > last) continue;
    ctx.textAlign = t === 0 ? "left" : "center";
    ctx.fillText(tickLabel(t, xt.step), px(t), pad.top + h + 5);
  }
  ctx.textAlign = "center";
  ctx.fillText("training step", x0 + w / 2, cssH - fontPx - 1);
  ctx.save();
  ctx.translate(fontPx - 1, pad.top + h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = "top";
  ctx.fillText("reward per episode", 0, 0);
  ctx.restore();

  const path = (pts: readonly Point[]): void => {
    ctx.beginPath();
    pts.forEach((p, k) => (k === 0 ? ctx.moveTo(px(p.iter), py(p.v)) : ctx.lineTo(px(p.iter), py(p.v))));
    if (pts.length === 1) ctx.lineTo(px(pts[0]!.iter) + 1, py(pts[0]!.v));
  };

  // Everything below is clipped to the plot so an off-scale spike cannot spill over the labels.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, pad.top, w, h);
  ctx.clip();

  const heldSmooth = thin(heldTrend, maxPts);
  const base = start !== null ? py(start) : null;
  if (base !== null && heldSmooth.length > 1) {
    for (const [above, color] of [[true, HELD_COLOR], [false, DOWN_COLOR]] as const) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, above ? pad.top : base, w, above ? base - pad.top : pad.top + h - base);
      ctx.clip();
      path(heldSmooth);
      ctx.lineTo(px(heldSmooth[heldSmooth.length - 1]!.iter), base);
      ctx.lineTo(px(heldSmooth[0]!.iter), base);
      ctx.closePath();
      ctx.globalAlpha = above ? 0.22 : 0.26;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    }
  }
  if (base !== null) {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = START_COLOR;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(x0, base);
    ctx.lineTo(x0 + w, base);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (train.length > 0) {
    path(thin(trainTrend, maxPts));
    ctx.strokeStyle = TRAIN_MUTED;
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }
  if (held.length > 1) {
    path(thinMinMax(held, maxPts));
    ctx.strokeStyle = "rgba(61, 220, 151, 0.22)";
    ctx.lineWidth = 1;
    ctx.stroke();
    path(heldSmooth);
    ctx.strokeStyle = HELD_COLOR;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  ctx.restore();

  // Direct labels at the line ends: the upper line's name above its end, the lower one's below, so they never meet.
  const heldEnd = heldTrend[heldTrend.length - 1];
  const trainEnd = trainTrend[trainTrend.length - 1];
  ctx.font = font;
  ctx.textAlign = "right";
  const endLabel = (p: Point | undefined, text: string, color: string, above: boolean, bold: boolean): void => {
    if (!p || !Number.isFinite(p.v)) return;
    const y = py(p.v);
    ctx.font = bold ? `600 ${font}` : font;
    ctx.fillStyle = color;
    ctx.textBaseline = above ? "bottom" : "top";
    const room = above ? y - pad.top : pad.top + h - y;
    const gap = Math.max(4, Math.min(room, 9));
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(8, 24, 18, 0.9)"; // keeps the name readable over the lines it sits near
    ctx.strokeText(text, x0 + w - 4, above ? y - gap : y + gap);
    ctx.fillText(text, x0 + w - 4, above ? y - gap : y + gap);
  };
  const heldAbove = !heldEnd || !trainEnd || heldEnd.v >= trainEnd.v;
  endLabel(heldEnd, "on new worlds", HELD_COLOR, heldAbove, true);
  endLabel(trainEnd, "average try", TRAIN_MUTED, !heldAbove, false);

  // The start, named at the left end on the side away from the gain.
  if (base !== null && start !== null) {
    const now = held[held.length - 1]!.v;
    ctx.fillStyle = START_COLOR;
    ctx.font = font;
    ctx.textAlign = "left";
    const below = now >= start;
    ctx.textBaseline = below ? "top" : "bottom";
    ctx.fillText(`start ${tickLabel(start, 0.1)}`, x0 + 5, base + (below ? 5 : -5));
  }

  // The gain since the start, bracketed at the right edge of the plot.
  const now = held[held.length - 1];
  if (now && start !== null && held.length > 1) {
    const d = now.v - start;
    const up = d >= 0;
    const color = up ? HELD_COLOR : DOWN_COLOR;
    const x = x0 + w + 6;
    const yS = py(start);
    const yN = py(now.v);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 3, yS);
    ctx.lineTo(x, yS);
    ctx.lineTo(x, yN);
    ctx.lineTo(x - 3, yN);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const ym = Math.min(pad.top + h - fontPx * 2.2, Math.max(pad.top + fontPx * 1.2, (yS + yN) / 2 - fontPx * 0.3));
    ctx.font = `700 ${Math.round(fontPx * 1.3)}px ${font.split("px ")[1]}`;
    ctx.fillText(signed(d), x + 6, ym);
    ctx.font = font;
    ctx.fillStyle = LABEL;
    ctx.fillText("since start", x + 6, ym + fontPx * 1.2);
  }
}

// A tiny trend line of the best tries for a KPI tile: no axes, its own scale, the latest value dotted.
export function drawSpark(ctx: CanvasRenderingContext2D, its: readonly RlIteration[], cssW: number, cssH: number): void {
  ctx.clearRect(0, 0, cssW, cssH);
  if (its.length < 2 || cssW < 8 || cssH < 6) return;
  const best = its.map((it) => ({ iter: it.iter, v: it.best }));
  const trend = thin(smooth(best, TRAIN_HALF), Math.max(2, Math.floor(cssW)));
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of trend) {
    if (!Number.isFinite(p.v)) continue;
    lo = Math.min(lo, p.v);
    hi = Math.max(hi, p.v);
  }
  if (lo > hi) return;
  if (hi - lo < 1e-9) hi = lo + 1;
  const first = trend[0]!.iter;
  const span = Math.max(1, trend[trend.length - 1]!.iter - first);
  const x = (i: number): number => 3 + ((i - first) / span) * (cssW - 6);
  const y = (v: number): number => cssH - 3 - ((v - lo) / (hi - lo)) * (cssH - 6);
  ctx.lineJoin = "round";
  ctx.strokeStyle = BEST_COLOR;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  trend.forEach((p, k) => (k === 0 ? ctx.moveTo(x(p.iter), y(p.v)) : ctx.lineTo(x(p.iter), y(p.v))));
  ctx.stroke();
  const end = trend[trend.length - 1]!;
  ctx.fillStyle = BEST_COLOR;
  ctx.beginPath();
  ctx.moveTo(x(end.iter) + 2, y(end.v));
  ctx.arc(x(end.iter), y(end.v), 2, 0, 2 * Math.PI);
  ctx.fill();
}

// The reward graph on a canvas, plus the best-try sparkline in its KPI tile when the card has one; redraws on resize and when the data changes.
export class RewardGraph {
  private its: readonly RlIteration[] = [];
  private start: number | null = null;
  private pending = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly spark: HTMLCanvasElement | null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.spark = canvas.closest(".graph-card")?.querySelector<HTMLCanvasElement>("canvas.spark") ?? null;
    const ro = new ResizeObserver(() => this.invalidate());
    ro.observe(canvas);
    if (this.spark) ro.observe(this.spark);
  }

  setData(its: readonly RlIteration[], start: number | null): void {
    this.its = its;
    this.start = start;
    this.invalidate();
  }

  private invalidate(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      const dpr = fitCanvas(this.canvas);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRewardGraph(this.ctx, this.its, this.start, this.canvas.clientWidth, this.canvas.clientHeight);
      const s = this.spark;
      const sctx = s?.getContext("2d");
      if (s && sctx) {
        const sd = fitCanvas(s);
        sctx.setTransform(sd, 0, 0, sd, 0, 0);
        drawSpark(sctx, this.its, s.clientWidth, s.clientHeight);
      }
    });
  }
}
