import type { GenerationStat } from "../sim/history.ts";
import { fitCanvas, graphFont } from "./canvas.ts";

const BEST_COLOR = "#3ddc97";
const MEAN_COLOR = "#7dd3fc";
const AXIS_COLOR = "rgba(143, 174, 159, 0.5)";
const TEXT_COLOR = "#8fae9f";
const WATCH_COLOR = "#e6f4ea";
const PAD = { left: 40, right: 8, top: 16, bottom: 19 }; // CSS px

// Best and mean fitness against generation. Clicking picks a generation; it redraws only when the data or the marker changes.
export class FitnessGraph {
  private stats: readonly GenerationStat[] = [];
  private kept: readonly number[] = [];
  private watched: number | null = null;
  private pending = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement, onPick: (generation: number) => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    canvas.addEventListener("click", (e) => {
      const plot = this.plot();
      const x = e.clientX - canvas.getBoundingClientRect().left;
      if (this.stats.length > 0 && plot.w > 0) onPick(this.generationAt(x, plot));
    });
    new ResizeObserver(() => this.invalidate()).observe(canvas); // also fires when the card is expanded
  }

  setData(stats: readonly GenerationStat[], kept: readonly number[]): void {
    this.stats = stats;
    this.kept = kept;
    this.invalidate();
  }

  setWatched(generation: number | null): void {
    if (generation === this.watched) return;
    this.watched = generation;
    this.invalidate();
  }

  private invalidate(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  private plot(): { x: number; y: number; w: number; h: number } {
    const w = this.canvas.clientWidth - PAD.left - PAD.right;
    const h = this.canvas.clientHeight - PAD.top - PAD.bottom;
    return { x: PAD.left, y: PAD.top, w, h };
  }

  private lastGeneration(): number {
    return Math.max(1, this.stats.length - 1);
  }

  private generationAt(x: number, plot: { x: number; w: number }): number {
    const g = Math.round(((x - plot.x) / plot.w) * this.lastGeneration());
    return Math.min(this.stats.length - 1, Math.max(0, g));
  }

  private draw(): void {
    const dpr = fitCanvas(this.canvas);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    const plot = this.plot();
    if (plot.w <= 0 || plot.h <= 0) return;
    const stats = this.stats;
    const last = this.lastGeneration();
    let top = 1;
    for (const s of stats) top = Math.max(top, s.best);
    const px = (g: number): number => plot.x + (g / last) * plot.w;
    const py = (v: number): number => plot.y + plot.h - (v / top) * plot.h;

    ctx.font = graphFont();
    ctx.fillStyle = TEXT_COLOR;
    ctx.strokeStyle = AXIS_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.x, plot.y);
    ctx.lineTo(plot.x, plot.y + plot.h);
    ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(`${top.toFixed(0)} s`, plot.x - 4, plot.y - 4);
    ctx.textBaseline = "bottom";
    ctx.fillText("0", plot.x - 4, plot.y + plot.h + 3);
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText("gen 0", plot.x, plot.y + plot.h + 3);
    ctx.textAlign = "right";
    ctx.fillText(`${last}`, plot.x + plot.w, plot.y + plot.h + 3);
    if (stats.length === 0) return;

    ctx.fillStyle = AXIS_COLOR; // ticks mark the generations that can be watched
    for (const g of this.kept) ctx.fillRect(px(g) - 0.5, plot.y + plot.h, 1, 3);

    const line = (color: string, value: (s: GenerationStat) => number): void => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      stats.forEach((s, g) => (g === 0 ? ctx.moveTo(px(g), py(value(s))) : ctx.lineTo(px(g), py(value(s)))));
      if (stats.length === 1) ctx.lineTo(px(0) + 1, py(value(stats[0]!)));
      ctx.stroke();
    };
    line(MEAN_COLOR, (s) => s.mean);
    line(BEST_COLOR, (s) => s.best);

    const w = this.watched;
    if (w !== null && w < stats.length) {
      ctx.strokeStyle = WATCH_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px(w), plot.y);
      ctx.lineTo(px(w), plot.y + plot.h);
      ctx.stroke();
      ctx.fillStyle = WATCH_COLOR;
      ctx.beginPath();
      ctx.arc(px(w), py(stats[w]!.best), 3, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
}
