import { HIT_FOOD, HIT_POISON, HIT_WALL } from "../sim/types.ts";
import { BACKGROUND, FLOOR, FOOD, POISON, WALL } from "./scene.ts";
import { RAY_NONE, RAY_WALL } from "./palette.ts";
import { ROOM_H, ROOM_W } from "./previewScene.ts";
import type { PreviewScene } from "./previewScene.ts";

// Live design preview of the Arena: the creature moving through a small room with its ray fan to scale. The brain beside it is drawn by the page.
const LEARNER = "#fbbf24";
const OUTLINE = "rgba(5, 15, 10, 0.85)";
const TEXT = "#9fb8ad";
const STRIP = 24; // bottom band for the scale cue

// Draws the room with its items, the creature and its rays, each ray coloured by what it hits and drawn to the real hit distance.
export function drawCreaturePreview(ctx: CanvasRenderingContext2D, scene: PreviewScene, cssW: number, cssH: number): void {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, cssW, cssH);
  const scale = Math.min((cssW - 8) / ROOM_W, (cssH - STRIP - 8) / ROOM_H);
  if (!(scale > 0)) return;
  const { creature, world } = scene;
  const plan = creature.plan;
  const r = scene.config.creature.radius;
  const x0 = (cssW - ROOM_W * scale) / 2;
  const y0 = 4;
  ctx.save();
  ctx.translate(x0, y0);
  ctx.scale(scale, scale);
  ctx.fillStyle = FLOOR;
  ctx.fillRect(0, 0, ROOM_W, ROOM_H);
  ctx.strokeStyle = WALL;
  ctx.lineWidth = Math.max(2, 3 / scale);
  ctx.strokeRect(0, 0, ROOM_W, ROOM_H);
  for (let i = 0; i < world.count; i++) {
    const kind = world.kinds[i];
    if (kind !== HIT_FOOD && kind !== HIT_POISON) continue;
    ctx.fillStyle = kind === HIT_FOOD ? FOOD : POISON;
    ctx.beginPath();
    ctx.arc(world.xs[i]!, world.ys[i]!, Math.max(world.itemRadius, 2 / scale), 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.rect(0, 0, ROOM_W, ROOM_H);
  ctx.clip(); // the sight ring stops at the walls
  const { x, y, heading } = creature.state;
  ctx.setLineDash([4 / scale, 4 / scale]);
  ctx.strokeStyle = WALL;
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 1 / scale;
  ctx.beginPath();
  ctx.arc(x, y, plan.rayLength, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.setLineDash([]);
  const offsets = creature.rayOffsets;
  creature.rays.forEach((ray, k) => {
    const a = heading + offsets[k]!;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const hit = ray.kind === HIT_FOOD || ray.kind === HIT_POISON || ray.kind === HIT_WALL;
    const len = hit ? (1 - ray.closeness) * plan.rayLength : plan.rayLength;
    ctx.strokeStyle = ray.kind === HIT_FOOD ? FOOD : ray.kind === HIT_POISON ? POISON : ray.kind === HIT_WALL ? RAY_WALL : RAY_NONE;
    ctx.globalAlpha = ray.kind === HIT_FOOD || ray.kind === HIT_POISON ? 0.95 : hit ? 0.7 : 0.3;
    ctx.lineWidth = 1.3 / scale;
    ctx.beginPath();
    ctx.moveTo(x + cos * r, y + sin * r);
    ctx.lineTo(x + cos * Math.max(r, len), y + sin * Math.max(r, len));
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fillStyle = LEARNER;
  ctx.fill();
  ctx.strokeStyle = "#fff7d6";
  ctx.lineWidth = 1.6 / scale;
  ctx.stroke();
  ctx.strokeStyle = OUTLINE; // heading line
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(heading) * r * 1.5, y + Math.sin(heading) * r * 1.5);
  ctx.stroke();
  ctx.restore();
  // Scale cue under the room: the body's width and the sight length as a bar.
  const by = cssH - STRIP / 2;
  const bx0 = x0;
  const bx1 = bx0 + plan.rayLength * scale;
  ctx.strokeStyle = TEXT;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bx0, by - 3);
  ctx.lineTo(bx0, by + 3);
  ctx.moveTo(bx0, by);
  ctx.lineTo(bx1, by);
  ctx.moveTo(bx1, by - 3);
  ctx.lineTo(bx1, by + 3);
  ctx.stroke();
  ctx.fillStyle = TEXT;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(`sight ${Math.round(plan.rayLength)}`, bx1 + 6, by);
  ctx.textAlign = "right";
  ctx.fillText(`body ${2 * r} wide`, x0 + ROOM_W * scale, by);
}
