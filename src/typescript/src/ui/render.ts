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
  const drawCreature = (ep: EpisodeView, fill: string, stroke: string, alpha: number, lineW: number) => {
    const s = ep.state;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineW;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + Math.cos(s.heading) * r * 1.8, s.y + Math.sin(s.heading) * r * 1.8);
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  if (view.mode === "all") {
    for (let i = 0; i < episodes.length; i++) {
      if (i === bestIndex || !episodes[i]!.state.alive) continue;
      drawCreature(episodes[i]!, "#7dd3fc", "#7dd3fc", 0.25, px);
    }
  }
  const bs = best.state;
  if (bs.alive) drawCreature(best, "#fde047", "#ffffff", 1, 1.5 * px);
  else drawCreature(best, "#6b7280", "#9ca3af", 1, 1.5 * px);

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

