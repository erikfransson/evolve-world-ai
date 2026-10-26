import type { RlIteration } from "../worker/rlProtocol.ts";
import { fitCanvas, graphFont } from "./canvas.ts";
import { AXIS, LABEL, OTHER } from "./palette.ts";

export const TRAIN_COLOR = OTHER;
export const BEST_COLOR = "#fbbf24";
export const HELD_COLOR = "#3ddc97";
const GRID_COLOR = "rgba(143, 174, 159, 0.15)";
const PAD = { left: 52, right: 12, top: 12, bottom: 36 }; // CSS px

const nice = (v: number): string => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

interface Point {
  iter: number;
  v: number;
}

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

// The latest value of each curve for the legend: held-out falls back to the start value before the first check.
export function latestValues(its: readonly RlIteration[], start: number | null): { train: number | null; best: number | null; held: number | null } {
  const last = its[its.length - 1];
  let held = start;
  for (let i = its.length - 1; i >= 0; i--) if (its[i]!.held !== null) { held = its[i]!.held; break; }
  return { train: last?.train ?? null, best: last?.best ?? null, held };
}

const DOT_LIMIT = 150; // more held-out checks than this and the dots would blur into a band, so only the line is drawn
const GAP = 18; // CSS px between the two panels, enough to keep their facing y labels apart
const LUCK_SHARE = 0.3; // the luckiest panel's share of the plot height

// The y range of a panel: its finite values plus a margin, so each panel fills its height however far apart the panels' curves are.
export function fitRange(vals: Iterable<number>): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vals) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo > hi) return { lo: 0, hi: 1 };
  const pad = hi - lo > 1e-9 ? (hi - lo) * 0.08 : Math.max(0.5, Math.abs(lo) * 0.05);
  return { lo: lo - pad, hi: hi + pad };
}

interface Curve {
  pts: readonly Point[];
  color: string;
  width: number;
  dots: boolean;
}

// Draws the reward curves into a cssW x cssH area as two panels on one iteration axis: train mean (thin) and held-out checks (bold, with dots) on top,
// and below, on its own scale, the luckiest candidate, which runs several times higher and would flatten the others on a shared axis.
export function drawRewardGraph(ctx: CanvasRenderingContext2D, its: readonly RlIteration[], start: number | null, cssW: number, cssH: number): void {
  ctx.clearRect(0, 0, cssW, cssH);
  const x0 = PAD.left;
  const w = cssW - PAD.left - PAD.right;
  const luckH = Math.round((cssH - PAD.top - PAD.bottom - GAP) * LUCK_SHARE);
  const mainH = cssH - PAD.top - PAD.bottom - GAP - luckH;
  if (w <= 0 || luckH <= 0 || mainH <= 0) return;
  const held: Point[] = [];
  if (start !== null) held.push({ iter: 0, v: start });
  for (const it of its) if (it.held !== null) held.push({ iter: it.iter, v: it.held });
  const last = Math.max(1, its.length ? its[its.length - 1]!.iter : 1);
  const px = (i: number): number => x0 + (i / last) * w;
  ctx.font = graphFont();
  ctx.lineJoin = "round";

  // One panel: grid, left axis and y labels, then its curves on a y scale fitted to them alone.
  const panel = (top: number, h: number, curves: readonly Curve[], labels: number): void => {
    const { lo, hi } = fitRange(curves.flatMap((c) => c.pts.map((p) => p.v)));
    const py = (v: number): number => top + h - ((v - lo) / (hi - lo)) * h;
    const marks = labels === 3 ? [lo, (lo + hi) / 2, hi] : [lo, hi];
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID_COLOR;
    ctx.beginPath();
    for (const v of marks) {
      ctx.moveTo(x0, py(v));
      ctx.lineTo(x0 + w, py(v));
    }
    ctx.stroke();
    ctx.strokeStyle = AXIS;
    ctx.beginPath();
    ctx.moveTo(x0, top);
    ctx.lineTo(x0, top + h);
    ctx.lineTo(x0 + w, top + h);
    ctx.stroke();
    ctx.fillStyle = LABEL;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const v of marks) ctx.fillText(nice(v), x0 - 5, py(v));
    for (const c of curves) {
      if (c.pts.length === 0) continue;
      const pts = thin(c.pts, Math.max(2, Math.floor(w)));
      ctx.strokeStyle = c.color;
      ctx.fillStyle = c.color;
      ctx.lineWidth = c.width;
      ctx.beginPath();
      pts.forEach((p, k) => (k === 0 ? ctx.moveTo(px(p.iter), py(p.v)) : ctx.lineTo(px(p.iter), py(p.v))));
      if (pts.length === 1) ctx.lineTo(px(pts[0]!.iter) + 1, py(pts[0]!.v));
      ctx.stroke();
      if (c.dots && pts.length <= DOT_LIMIT) {
        ctx.beginPath();
        for (const p of pts) {
          ctx.moveTo(px(p.iter) + 3, py(p.v));
          ctx.arc(px(p.iter), py(p.v), 3, 0, 2 * Math.PI);
        }
        ctx.fill();
      }
    }
  };
  const train = its.map((it) => ({ iter: it.iter, v: it.train }));
  const best = its.map((it) => ({ iter: it.iter, v: it.best }));
  panel(PAD.top, mainH, [{ pts: train, color: TRAIN_COLOR, width: 1, dots: false }, { pts: held, color: HELD_COLOR, width: 2.5, dots: true }], 3);
  const luckTop = PAD.top + mainH + GAP;
  panel(luckTop, luckH, [{ pts: best, color: BEST_COLOR, width: 1, dots: false }], 2);

  ctx.fillStyle = LABEL;
  ctx.textBaseline = "top";
  const ticks = w >= 240 ? 4 : 2;
  for (let k = 0; k <= ticks; k++) {
    ctx.textAlign = k === 0 ? "left" : k === ticks ? "right" : "center";
    ctx.fillText(`${Math.round((last * k) / ticks)}`, x0 + (w * k) / ticks, luckTop + luckH + 4);
  }
  ctx.textAlign = "center";
  ctx.fillText("iteration", x0 + w / 2, cssH - 14);
  ctx.save();
  ctx.translate(11, PAD.top + mainH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = "middle";
  ctx.fillText("reward", 0, 0);
  ctx.restore();
}

// The reward curves on a canvas; redraws on resize and when the data changes.
export class RewardGraph {
  private its: readonly RlIteration[] = [];
  private start: number | null = null;
  private pending = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.invalidate()).observe(canvas);
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
    });
  }
}
