import type { EcoConfig } from "../sim/ecoConfig.ts";
import { seasonFactor } from "../sim/ecoConfig.ts";
import { fitCanvas, graphFont } from "./canvas.ts";

const POP_COLOR = "#fbbf24";
const FOOD_COLOR = "#4ade80";
const AXIS_COLOR = "rgba(143, 174, 159, 0.5)";
const TEXT_COLOR = "#8fae9f";
const WINTER_BAND = "rgba(150, 190, 235, 0.12)";
const SEASON_CURVE = "rgba(150, 190, 235, 0.4)"; // food multiplier, 0 to 1 over the full graph height
const PAD = { left: 40, right: 40, top: 16, bottom: 19 }; // CSS px

export interface PopulationSample {
  time: number; // simulated seconds
  population: number;
  food: number;
}

const compact = (v: number): string => (v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));

// Population on the left scale and food count on the right scale, against simulated time. Redraws only when the data or the size changes.
export class PopulationGraph {
  private samples: readonly PopulationSample[] = [];
  private eco: EcoConfig["eco"] | null = null;
  private pending = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.invalidate()).observe(canvas); // also fires when the card is expanded
  }

  // With seasons on, winters (below the mid food multiplier) are shaded and the multiplier is drawn as a faint curve.
  setSeasons(eco: EcoConfig["eco"] | null): void {
    this.eco = eco?.seasons ? eco : null;
    this.invalidate();
  }

  setData(samples: readonly PopulationSample[]): void {
    this.samples = samples;
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

  private drawSeasons(eco: EcoConfig["eco"], end: number, w: number, h: number): void {
    const ctx = this.ctx;
    const mid = (1 + eco.winterFood) / 2;
    const steps = Math.max(2, Math.round(w / 2));
    const x = (i: number): number => PAD.left + (i / steps) * w;
    const f = (i: number): number => seasonFactor(eco, (i / steps) * end);
    ctx.fillStyle = WINTER_BAND;
    for (let i = 0; i < steps; i++) if (f(i + 0.5) < mid) ctx.fillRect(x(i), PAD.top, x(i + 1) - x(i), h);
    ctx.strokeStyle = SEASON_CURVE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) ctx.lineTo(x(i), PAD.top + h - f(i) * h);
    ctx.stroke();
  }

  private draw(): void {
    const dpr = fitCanvas(this.canvas);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    const w = this.canvas.clientWidth - PAD.left - PAD.right;
    const h = this.canvas.clientHeight - PAD.top - PAD.bottom;
    if (w <= 0 || h <= 0) return;
    const s = this.samples;
    const end = s.length > 0 ? Math.max(1, s[s.length - 1]!.time) : 1;
    let popTop = 1;
    let foodTop = 1;
    for (const p of s) {
      popTop = Math.max(popTop, p.population);
      foodTop = Math.max(foodTop, p.food);
    }
    const px = (t: number): number => PAD.left + (t / end) * w;
    const py = (v: number, top: number): number => PAD.top + h - (v / top) * h;

    ctx.font = graphFont();
    if (s.length === 0) {
      ctx.fillStyle = TEXT_COLOR;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Waiting for data", PAD.left + w / 2, PAD.top + h / 2);
      return;
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = AXIS_COLOR;
    ctx.beginPath();
    ctx.moveTo(PAD.left, PAD.top);
    ctx.lineTo(PAD.left, PAD.top + h);
    ctx.lineTo(PAD.left + w, PAD.top + h);
    ctx.lineTo(PAD.left + w, PAD.top);
    ctx.stroke();
    ctx.textBaseline = "top";
    ctx.textAlign = "right";
    ctx.fillStyle = POP_COLOR;
    ctx.fillText(compact(popTop), PAD.left - 4, PAD.top - 4);
    ctx.textAlign = "left";
    ctx.fillStyle = FOOD_COLOR;
    ctx.fillText(compact(foodTop), PAD.left + w + 4, PAD.top - 4);
    ctx.fillStyle = TEXT_COLOR;
    ctx.fillText("0 s", PAD.left, PAD.top + h + 3);
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(end)} s`, PAD.left + w, PAD.top + h + 3);

    if (this.eco) this.drawSeasons(this.eco, end, w, h);
    const line = (color: string, top: number, value: (p: PopulationSample) => number): void => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      s.forEach((p, i) => (i === 0 ? ctx.moveTo(px(p.time), py(value(p), top)) : ctx.lineTo(px(p.time), py(value(p), top))));
      if (s.length === 1) ctx.lineTo(px(s[0]!.time) + 1, py(value(s[0]!), top));
      ctx.stroke();
    };
    line(FOOD_COLOR, foodTop, (p) => p.food);
    line(POP_COLOR, popTop, (p) => p.population);
  }
}
