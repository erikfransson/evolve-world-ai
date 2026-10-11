import { BIG_IMPACT, EVENT_DEATH, EVENT_STRIDE } from "../sim/ecosystem.ts";
import { ringVisibility } from "./ecoBirths.ts";

const MAX_EFFECTS = 64; // like the birth rings
const SPARK_MS = 350; // real time, so it looks the same at any sim speed
const DEATH_MS = 750;
const RAYS = 6;
const MOTES = 8;

interface Effect {
  x: number;
  y: number;
  death: boolean;
  value: number; // impact: energy lost; death: hue
  at: number; // ms
}

// Short sparks where creatures hit hard and a fading burst where one dies from a bump or a hunt, from the worker's collision events.
export class ImpactEffects {
  private readonly list: Effect[] = [];

  reset(): void {
    this.list.length = 0;
  }

  // events: EVENT_STRIDE numbers each (kind, x, y, value).
  add(events: Float32Array, now: number): void {
    for (let i = 0; i + EVENT_STRIDE <= events.length; i += EVENT_STRIDE) {
      if (this.list.length >= MAX_EFFECTS) this.list.shift();
      this.list.push({ x: events[i + 1]!, y: events[i + 2]!, death: events[i] === EVENT_DEATH, value: events[i + 3]!, at: now });
    }
  }

  get size(): number {
    return this.list.length;
  }

  // Drawn in world coordinates, like BirthRings.draw.
  draw(ctx: CanvasRenderingContext2D, now: number, radius: number, css: number, cssZoom: number): void {
    while (this.list.length && now - this.list[0]!.at >= (this.list[0]!.death ? DEATH_MS : SPARK_MS)) this.list.shift();
    const visible = ringVisibility(radius * cssZoom);
    if (visible <= 0) return;
    ctx.lineCap = "round";
    for (const e of this.list) {
      const t = (now - e.at) / (e.death ? DEATH_MS : SPARK_MS);
      if (t >= 1) continue; // an old spark queued behind a longer-lived death
      ctx.globalAlpha = (1 - t) ** 1.5 * visible;
      if (e.death) this.dissolve(ctx, e, t, radius);
      else this.spark(ctx, e, t, radius, css);
    }
    ctx.globalAlpha = 1;
  }

  // A short burst of rays from the contact point; harder hits are a bit bigger.
  private spark(ctx: CanvasRenderingContext2D, e: Effect, t: number, radius: number, css: number): void {
    const size = radius * Math.min(2.2, 1.1 + 0.5 * (e.value / BIG_IMPACT));
    ctx.strokeStyle = "hsl(45, 100%, 85%)";
    ctx.lineWidth = (3 - 1.5 * t) * css;
    ctx.beginPath();
    for (let k = 0; k < RAYS; k++) {
      const a = (k + 0.5 * (e.x % 1)) * ((2 * Math.PI) / RAYS);
      const r0 = size * (0.3 + 0.9 * t);
      const r1 = r0 + size * 0.7 * (1 - t);
      ctx.moveTo(e.x + Math.cos(a) * r0, e.y + Math.sin(a) * r0);
      ctx.lineTo(e.x + Math.cos(a) * r1, e.y + Math.sin(a) * r1);
    }
    ctx.stroke();
  }

  // Small dots in the creature's colour drifting apart and shrinking.
  private dissolve(ctx: CanvasRenderingContext2D, e: Effect, t: number, radius: number): void {
    ctx.fillStyle = `hsl(${e.value}, 90%, 68%)`;
    const spread = radius * (0.5 + 2.4 * (1 - (1 - t) ** 2));
    const dot = radius * 0.4 * (1 - 0.6 * t);
    ctx.beginPath();
    for (let k = 0; k < MOTES; k++) {
      const a = (k + 0.37 * (k % 3)) * ((2 * Math.PI) / MOTES) + e.y;
      const d = spread * (0.6 + 0.4 * ((k * 5) % 3) / 2);
      ctx.moveTo(e.x + Math.cos(a) * d + dot, e.y + Math.sin(a) * d);
      ctx.arc(e.x + Math.cos(a) * d, e.y + Math.sin(a) * d, dot, 0, 2 * Math.PI);
    }
    ctx.fill();
  }
}
