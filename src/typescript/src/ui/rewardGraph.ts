import type { RlIteration } from "../worker/rlProtocol.ts";
import { fitCanvas, graphFont } from "./canvas.ts";
import { AXIS, LABEL, OTHER } from "./palette.ts";

export const TRAIN_COLOR = OTHER;
export const BEST_COLOR = "#fbbf24";
export const HELD_COLOR = "#3ddc97";
const GRID_COLOR = "rgba(143, 174, 159, 0.15)";
const PAD = { left: 52, right: 12, top: 12, bottom: 36 }; // CSS px

const nice = (v: number): string => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) < 0.05 ? "0.0" : v.toFixed(1)); // never "-0.0"

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
const LUCK_SHARE = 0.26; // the luckiest panel's share of the plot height
const UP_FILL = "61, 220, 151"; // rgb of HELD_COLOR, for the area above the start
const DOWN_FILL = "248, 113, 113"; // rgb of the area below the start
const PANEL_BG = "rgba(3, 12, 9, 0.35)";

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

// The trend of a noisy curve: a centred moving average over about a twentieth of the points (at least 2 each side), narrower at the ends.
export function smooth(pts: readonly Point[]): Point[] {
  const n = pts.length;
  const h = Math.max(2, Math.round(n / 40));
  const sum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i]! + pts[i]!.v;
  return pts.map((p, i) => {
    const lo = Math.max(0, i - h);
    const hi = Math.min(n, i + h + 1);
    return { iter: p.iter, v: (sum[hi]! - sum[lo]!) / (hi - lo) };
  });
}

interface Curve {
  pts: readonly Point[];
  color: string;
  width: number;
  dots?: boolean;
  glow?: boolean;
}

// Draws the reward curves into a cssW x cssH area as two panels on one iteration axis. On top: held-out checks (bold and glowing, with the area
// against the start value filled green above and red below, the latest value marked), and the train mean as faint noise with its trend.
// Below, on its own scale, the luckiest candidate, which runs several times higher and would flatten the others on a shared axis.
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
  const font = graphFont();
  ctx.font = font;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const maxPts = Math.max(2, Math.floor(w));

  const line = (pts: readonly Point[], py: (v: number) => number): void => {
    ctx.beginPath();
    pts.forEach((p, k) => (k === 0 ? ctx.moveTo(px(p.iter), py(p.v)) : ctx.lineTo(px(p.iter), py(p.v))));
    if (pts.length === 1) ctx.lineTo(px(pts[0]!.iter) + 1, py(pts[0]!.v));
  };

  // One panel: backdrop, grid and y labels, whatever `under` draws, then its curves on a y scale fitted to them alone; returns the scale.
  const panel = (top: number, h: number, curves: readonly Curve[], labels: number, under: (py: (v: number) => number) => void = () => {}): ((v: number) => number) => {
    const { lo, hi } = fitRange(curves.flatMap((c) => c.pts.map((p) => p.v)));
    const py = (v: number): number => top + h - ((v - lo) / (hi - lo)) * h;
    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(x0, top, w, h);
    const marks = labels === 3 ? [lo, (lo + hi) / 2, hi] : [lo, hi];
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID_COLOR;
    ctx.beginPath();
    for (const v of marks) {
      ctx.moveTo(x0, py(v));
      ctx.lineTo(x0 + w, py(v));
    }
    ctx.stroke();
    ctx.fillStyle = LABEL;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const v of marks) ctx.fillText(nice(v), x0 - 6, py(v));
    under(py);
    for (const c of curves) {
      if (c.pts.length === 0) continue;
      const pts = thin(c.pts, maxPts);
      ctx.strokeStyle = c.color;
      ctx.fillStyle = c.color;
      ctx.lineWidth = c.width;
      if (c.glow) {
        ctx.shadowColor = c.color;
        ctx.shadowBlur = 12;
      }
      line(pts, py);
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (c.dots && pts.length <= DOT_LIMIT) {
        ctx.beginPath();
        for (const p of pts) {
          ctx.moveTo(px(p.iter) + 2.5, py(p.v));
          ctx.arc(px(p.iter), py(p.v), 2.5, 0, 2 * Math.PI);
        }
        ctx.fill();
      }
    }
    return py;
  };

  const train = its.map((it) => ({ iter: it.iter, v: it.train }));
  const best = its.map((it) => ({ iter: it.iter, v: it.best }));
  const faint = (hex: string): string => `${hex}55`; // the raw, noisy values behind their trend
  const top = PAD.top;
  // Under the curves: the held-out area against the start, green above and red below, and the start as a dashed line.
  const under = (py: (v: number) => number): void => {
    if (start === null) return;
    const base = py(start);
    if (held.length > 1) {
      const pts = thin(held, maxPts);
      for (const [above, rgb] of [[true, UP_FILL], [false, DOWN_FILL]] as const) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, above ? top : base, w, above ? base - top : top + mainH - base);
        ctx.clip();
        const g = ctx.createLinearGradient(0, above ? top : top + mainH, 0, base);
        g.addColorStop(0, `rgba(${rgb}, 0.38)`);
        g.addColorStop(1, `rgba(${rgb}, 0.02)`);
        ctx.fillStyle = g;
        line(pts, py);
        ctx.lineTo(px(pts[pts.length - 1]!.iter), base);
        ctx.lineTo(px(pts[0]!.iter), base);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(230, 244, 234, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, base);
    ctx.lineTo(x0 + w, base);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const py = panel(
    top,
    mainH,
    [
      { pts: train, color: faint(TRAIN_COLOR), width: 1 },
      { pts: smooth(train), color: TRAIN_COLOR, width: 1.75 },
      { pts: held, color: HELD_COLOR, width: 3, dots: true, glow: true },
    ],
    3,
    under,
  );
  // The latest held-out value: a haloed marker, a bracket down to the start and the change next to it.
  const now = held[held.length - 1];
  if (now) {
    const x = px(now.iter);
    const y = py(now.v);
    if (start !== null && held.length > 1 && nice(Math.abs(now.v - start)) !== nice(0)) { // no "−0.0" for a change that rounds away
      const up = now.v > start;
      ctx.strokeStyle = up ? HELD_COLOR : `rgb(${DOWN_FILL})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, py(start));
      ctx.lineTo(x, y);
      ctx.stroke();
      const d = now.v - start;
      const text = `${d > 0 ? "+" : "−"}${nice(Math.abs(d))}`;
      ctx.font = `600 ${font}`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = up ? HELD_COLOR : `rgb(${DOWN_FILL})`;
      ctx.fillText(text, x - 8, (py(start) + y) / 2);
      ctx.font = font;
    }
    ctx.fillStyle = `rgba(${UP_FILL}, 0.22)`;
    ctx.beginPath();
    ctx.moveTo(x + 9, y);
    ctx.arc(x, y, 9, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = "#e6f4ea";
    ctx.strokeStyle = HELD_COLOR;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x + 4.5, y);
    ctx.arc(x, y, 4.5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
  }
  const luckTop = top + mainH + GAP;
  panel(luckTop, luckH, [{ pts: best, color: faint(BEST_COLOR), width: 1 }, { pts: smooth(best), color: BEST_COLOR, width: 1.5 }], 2);

  ctx.fillStyle = LABEL;
  ctx.textBaseline = "top";
  const ticks = Math.min(w >= 240 ? 4 : 2, last); // no repeated labels early in a run
  for (let k = 0; k <= ticks; k++) {
    ctx.textAlign = k === 0 ? "left" : k === ticks ? "right" : "center";
    ctx.fillText(`${Math.round((last * k) / ticks)}`, x0 + (w * k) / ticks, luckTop + luckH + 5);
  }
  ctx.textAlign = "center";
  ctx.fillText("iteration", x0 + w / 2, cssH - 14);
  ctx.save();
  ctx.translate(11, top + mainH / 2);
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
