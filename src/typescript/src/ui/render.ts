import type { EpisodeView } from "../sim/types.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON, HIT_WALL } from "../sim/types.ts";
import type { SimConfig } from "../sim/config.ts";
import { rayAngleOffsets } from "../sim/config.ts";

export interface ViewOptions {
  mode: "all" | "best";
  showRays: boolean;
  pov: boolean;
}

const MARGIN = 12; // canvas pixels around the world
const BACKGROUND = "#0b1d16";
const FLOOR = "#10291f";
const WALL = "#9fb8ad";
const FOOD = "#4ade80";
const POISON = "#e040fb";
const RAY_COLORS: Record<number, string> = {
  [HIT_NONE]: "#6b7f76",
  [HIT_FOOD]: FOOD,
  [HIT_POISON]: POISON,
  [HIT_WALL]: "#facc15",
};

export function worldToCanvas(
  worldW: number,
  worldH: number,
  canvasW: number,
  canvasH: number,
): { scale: number; offsetX: number; offsetY: number } {
  const availW = Math.max(1, canvasW - 2 * MARGIN);
  const availH = Math.max(1, canvasH - 2 * MARGIN);
  const scale = Math.min(availW / worldW, availH / worldH);
  return { scale, offsetX: (canvasW - worldW * scale) / 2, offsetY: (canvasH - worldH * scale) / 2 };
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  config: SimConfig,
  episodes: readonly EpisodeView[],
  bestIndex: number,
  view: ViewOptions,
): void {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const { width: ww, height: wh } = config.world;
  const { scale, offsetX, offsetY } = worldToCanvas(ww, wh, cw, ch);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, cw, ch);

  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
  ctx.fillStyle = FLOOR;
  ctx.fillRect(0, 0, ww, wh);
  ctx.strokeStyle = WALL;
  ctx.lineWidth = Math.max(2, 3 / scale);
  ctx.strokeRect(0, 0, ww, wh);

  if (episodes.length === 0 || !Number.isInteger(bestIndex) || bestIndex < 0 || bestIndex >= episodes.length) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }
  const best = episodes[bestIndex]!;
  const px = 1 / scale;

  // Items of the best creature's world copy.
  const itemR = Math.max(config.world.itemRadius, 1.5 * px);
  const w = best.world;
  for (const kind of [HIT_FOOD, HIT_POISON]) {
    ctx.fillStyle = kind === HIT_FOOD ? FOOD : POISON;
    ctx.beginPath();
    for (let i = 0; i < w.count; i++) {
      if (w.kinds[i] !== kind) continue;
      ctx.moveTo(w.xs[i]! + itemR, w.ys[i]!);
      ctx.arc(w.xs[i]!, w.ys[i]!, itemR, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  const r = config.creature.radius;
  const start = config.creature.startEnergy;
  // Body is full at FULL_AT times the starting energy, so a newborn is one third full.
  const FULL_AT = 3;
  const energyRatio = (e: number) => (start > 0 ? Math.min(1, Math.max(0, e / (FULL_AT * start))) : 0);
  // Hue by fill fraction, linear between stops so colour never jumps: red in the last emergency,
  // yellow around the starting third, green when full.
  const HUE_STOPS: [number, number][] = [[0.05, 0], [0.33, 50], [0.6, 62], [1, 125]];
  const energyHue = (e: number) => {
    const f = energyRatio(e);
    if (f <= HUE_STOPS[0]![0]) return HUE_STOPS[0]![1];
    for (let i = 1; i < HUE_STOPS.length; i++) {
      const [f1, h1] = HUE_STOPS[i]!;
      if (f <= f1) {
        const [f0, h0] = HUE_STOPS[i - 1]!;
        return h0 + ((h1 - h0) * (f - f0)) / (f1 - f0);
      }
    }
    return HUE_STOPS[HUE_STOPS.length - 1]![1];
  };
  const heading = (s: { x: number; y: number; heading: number }, from: number, to: number) => {
    ctx.moveTo(s.x + Math.cos(s.heading) * from, s.y + Math.sin(s.heading) * from);
    ctx.lineTo(s.x + Math.cos(s.heading) * to, s.y + Math.sin(s.heading) * to);
  };

  // Cheap faint creature: body opacity scales with energy.
  const drawOther = (ep: EpisodeView) => {
    const s = ep.state;
    const e = energyRatio(s.energy);
    ctx.fillStyle = "#7dd3fc";
    ctx.strokeStyle = "#7dd3fc";
    ctx.lineWidth = px;
    ctx.globalAlpha = 0.08 + 0.3 * e;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    heading(s, r, r * 1.6);
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  const drawBest = (ep: EpisodeView) => {
    const s = ep.state;
    const R = Math.max(r, 6 * px); // true size so contact on screen matches eating
    const e = energyRatio(s.energy);
    const alive = s.alive;
    if (alive) {
      // Level fill clipped to the body, level in screen space.
      ctx.save();
      ctx.beginPath();
      ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(15, 23, 20, 0.85)";
      ctx.fill();
      ctx.clip();
      const top = s.y + R - 2 * R * e;
      const hue = energyHue(s.energy);
      const grad = ctx.createLinearGradient(0, s.y - R, 0, s.y + R);
      grad.addColorStop(0, `hsl(${hue + 6}, 90%, 62%)`);
      grad.addColorStop(1, `hsl(${hue}, 85%, 48%)`);
      ctx.fillStyle = grad;
      if (e > 0) ctx.fillRect(s.x - R, top, 2 * R, s.y + R - top);
      if (e > 0.02 && e < 0.98) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
        ctx.lineWidth = px;
        ctx.beginPath();
        ctx.moveTo(s.x - R, top);
        ctx.lineTo(s.x + R, top);
        ctx.stroke();
      }
      ctx.restore();
    }
    // Thin dark line separates the fill from the light outline ring, which glows softly.
    ctx.save();
    ctx.strokeStyle = "rgba(5, 15, 10, 0.9)";
    ctx.lineWidth = 1.2 * px;
    ctx.beginPath();
    ctx.arc(s.x, s.y, R - 1.2 * px, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = alive ? "#eef5f1" : "#9ca3af";
    ctx.lineWidth = 1.6 * px;
    if (alive) {
      ctx.shadowColor = "rgba(255, 255, 255, 0.55)";
      ctx.shadowBlur = 8;
    }
    ctx.beginPath();
    ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    // Nose triangle outside the ring.
    const cs = Math.cos(s.heading);
    const sn = Math.sin(s.heading);
    const base = R + 1.5 * px;
    const tip = R + 6 * px;
    const hw = 3.5 * px;
    ctx.fillStyle = alive ? "#eef5f1" : "#9ca3af";
    ctx.beginPath();
    ctx.moveTo(s.x + cs * tip, s.y + sn * tip);
    ctx.lineTo(s.x + cs * base - sn * hw, s.y + sn * base + cs * hw);
    ctx.lineTo(s.x + cs * base + sn * hw, s.y + sn * base - cs * hw);
    ctx.closePath();
    ctx.fill();
  };

  if (view.mode === "all") {
    for (let i = 0; i < episodes.length; i++) {
      if (i === bestIndex || !episodes[i]!.state.alive) continue;
      drawOther(episodes[i]!);
    }
  }
  const bs = best.state;
  drawBest(best);

  if (view.showRays) {
    const offsets = rayAngleOffsets(config);
    const len = config.creature.rayLength;
    ctx.lineWidth = px;
    for (let i = 0; i < best.rays.length && i < offsets.length; i++) {
      const hit = best.rays[i]!;
      const hasHit = hit.kind !== HIT_NONE;
      const d = hasHit ? len * (1 - hit.closeness) : len;
      const a = bs.heading + offsets[i]!;
      const ex = bs.x + Math.cos(a) * d;
      const ey = bs.y + Math.sin(a) * d;
      const color = RAY_COLORS[hit.kind] ?? RAY_COLORS[HIT_NONE]!;
      ctx.strokeStyle = color;
      ctx.globalAlpha = hasHit ? 0.9 : 0.4;
      ctx.beginPath();
      ctx.moveTo(bs.x, bs.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      if (hasHit) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(ex, ey, 2.5 * px, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  if (view.pov) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "rgba(0, 0, 0, 0.96)";
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.arc(
      offsetX + bs.x * scale,
      offsetY + bs.y * scale,
      (config.creature.rayLength + r) * scale,
      0,
      Math.PI * 2,
    );
    ctx.fill("evenodd");
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
