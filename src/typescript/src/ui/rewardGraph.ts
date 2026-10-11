import type { RlIteration } from "../worker/rlProtocol.ts";
import { fitCanvas, graphFont } from "./canvas.ts";

export const TRAIN_COLOR = "#7dd3fc";
export const BEST_COLOR = "#fbbf24";
export const HELD_COLOR = "#3ddc97";
const AXIS_COLOR = "rgba(143, 174, 159, 0.5)";
const GRID_COLOR = "rgba(143, 174, 159, 0.15)";
const TEXT_COLOR = "#8fae9f";
const PAD = { left: 44, right: 10, top: 14, bottom: 20 }; // CSS px

const nice = (v: number): string => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

// Draws the reward curves into a cssW x cssH area: train mean per iteration (thin) and held-out checks (bold, with dots).
export function drawRewardGraph(ctx: CanvasRenderingContext2D, its: readonly RlIteration[], start: number | null, cssW: number, cssH: number): void {
  ctx.clearRect(0, 0, cssW, cssH);
  const x0 = PAD.left;
  const w = cssW - PAD.left - PAD.right;
  const h = cssH - PAD.top - PAD.bottom;
  if (w <= 0 || h <= 0) return;
  const held: { iter: number; v: number }[] = [];
  if (start !== null) held.push({ iter: 0, v: start });
  for (const it of its) if (it.held !== null) held.push({ iter: it.iter, v: it.held });
  const values = [...its.map((it) => it.train), ...its.map((it) => it.best), ...held.map((p) => p.v)].filter(Number.isFinite);
  const lo = Math.min(0, ...values);
  let hi = Math.max(1, ...values);
  if (hi - lo < 1e-9) hi = lo + 1;
  const last = Math.max(1, its.length ? its[its.length - 1]!.iter : 1);
  const px = (i: number): number => x0 + (i / last) * w;
  const py = (v: number): number => PAD.top + h - ((v - lo) / (hi - lo)) * h;

  ctx.font = graphFont();
  ctx.lineWidth = 1;
  ctx.strokeStyle = GRID_COLOR;
  ctx.beginPath();
  for (const v of [lo, (lo + hi) / 2, hi]) {
    ctx.moveTo(x0, py(v));
    ctx.lineTo(x0 + w, py(v));
  }
  ctx.stroke();
  ctx.strokeStyle = AXIS_COLOR;
  ctx.beginPath();
  ctx.moveTo(x0, PAD.top);
  ctx.lineTo(x0, PAD.top + h);
  ctx.lineTo(x0 + w, PAD.top + h);
  ctx.stroke();
  ctx.fillStyle = TEXT_COLOR;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(nice(hi), x0 - 5, py(hi));
  ctx.fillText(nice(lo), x0 - 5, py(lo));
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText("iteration 0", x0, PAD.top + h + 4);
  ctx.textAlign = "right";
  ctx.fillText(`${last}`, x0 + w, PAD.top + h + 4);

  const line = (pts: readonly { iter: number; v: number }[], color: string, width: number, dots: boolean): void => {
    if (pts.length === 0) return;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.beginPath();
    pts.forEach((p, k) => (k === 0 ? ctx.moveTo(px(p.iter), py(p.v)) : ctx.lineTo(px(p.iter), py(p.v))));
    if (pts.length === 1) ctx.lineTo(px(pts[0]!.iter) + 1, py(pts[0]!.v));
    ctx.stroke();
    if (dots) {
      ctx.beginPath();
      for (const p of pts) {
        ctx.moveTo(px(p.iter) + 3, py(p.v));
        ctx.arc(px(p.iter), py(p.v), 3, 0, 2 * Math.PI);
      }
      ctx.fill();
    }
  };
  line(its.map((it) => ({ iter: it.iter, v: it.train })), TRAIN_COLOR, 1, false);
  line(its.map((it) => ({ iter: it.iter, v: it.best })), BEST_COLOR, 1, false);
  line(held, HELD_COLOR, 2.5, true);
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
