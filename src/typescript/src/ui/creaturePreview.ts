import { rayAngleOffsets } from "../sim/sensors.ts";
import type { PlanView } from "../sim/sensors.ts";
import { BACKGROUND, FLOOR, FOOD, POISON, WALL } from "./scene.ts";

// Live design preview of the Arena: the creature and its ray fan to scale inside a reference room, and a dot sketch of its brain.
export const PREVIEW_ROOM = 200; // the Nibble environment, world units
export const PREVIEW_RADIUS = 12; // creature radius, as in the ecosystem config
const ITEM_R = 4;
const LEARNER = "#fbbf24";
const OUTLINE = "rgba(5, 15, 10, 0.85)";
const RAY = "#7dd3fc";
const TEXT = "#9fb8ad";
// Example food and poison as fractions of the room.
const EXAMPLES: readonly (readonly [number, number, string])[] = [[0.8, 0.2, FOOD], [0.18, 0.78, FOOD], [0.82, 0.8, POISON], [0.2, 0.2, POISON]];

// Draws the room, the example items, the ray fan and the creature (centre, heading right) in a cssW x cssH canvas.
// The view covers the whole fan even where it leaves the room; the part inside the room is drawn stronger.
export function drawCreaturePreview(ctx: CanvasRenderingContext2D, plan: PlanView, cssW: number, cssH: number): void {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, cssW, cssH);
  const reach = Math.max(PREVIEW_ROOM / 2, plan.rayLength + PREVIEW_RADIUS);
  const pad = 14;
  const scale = Math.min(cssW, cssH) / 2 - pad > 0 ? (Math.min(cssW, cssH) / 2 - pad) / reach : 0;
  if (!(scale > 0)) return;
  const half = PREVIEW_ROOM / 2;
  ctx.save();
  ctx.translate(cssW / 2, cssH / 2);
  ctx.scale(scale, scale);
  ctx.fillStyle = FLOOR;
  ctx.fillRect(-half, -half, PREVIEW_ROOM, PREVIEW_ROOM);
  ctx.strokeStyle = WALL;
  ctx.lineWidth = 2 / scale;
  ctx.strokeRect(-half, -half, PREVIEW_ROOM, PREVIEW_ROOM);
  for (const [fx, fy, color] of EXAMPLES) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc((fx - 0.5) * PREVIEW_ROOM, (fy - 0.5) * PREVIEW_ROOM, ITEM_R, 0, 2 * Math.PI);
    ctx.fill();
  }
  const offsets = rayAngleOffsets(plan);
  ctx.strokeStyle = RAY;
  ctx.lineWidth = 1.2 / scale;
  ctx.globalAlpha = 0.25; // the whole fan
  rays(ctx, offsets, plan.rayLength);
  ctx.save();
  ctx.beginPath();
  ctx.rect(-half, -half, PREVIEW_ROOM, PREVIEW_ROOM);
  ctx.clip();
  ctx.globalAlpha = 0.8; // the part inside the room
  rays(ctx, offsets, plan.rayLength);
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(0, 0, PREVIEW_RADIUS, 0, 2 * Math.PI);
  ctx.fillStyle = LEARNER;
  ctx.fill();
  ctx.strokeStyle = "#fff7d6";
  ctx.lineWidth = 1.6 / scale;
  ctx.stroke();
  ctx.strokeStyle = OUTLINE; // heading line
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(PREVIEW_RADIUS * 1.5, 0);
  ctx.stroke();
  ctx.restore();
  // Scale bar for the sight length, along the bottom edge.
  const y = cssH - 24;
  const x0 = 8;
  const x1 = x0 + plan.rayLength * scale;
  ctx.strokeStyle = TEXT;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y - 3);
  ctx.lineTo(x0, y + 3);
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.moveTo(x1, y - 3);
  ctx.lineTo(x1, y + 3);
  ctx.stroke();
  ctx.fillStyle = TEXT;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(`sight ${Math.round(plan.rayLength)}`, (x0 + x1) / 2, y + 5);
  ctx.textAlign = "left";
  ctx.fillText(`room ${PREVIEW_ROOM} x ${PREVIEW_ROOM}`, 6, 5);
}

function rays(ctx: CanvasRenderingContext2D, offsets: Float32Array, length: number): void {
  ctx.beginPath();
  for (const a of offsets) {
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * length, Math.sin(a) * length);
  }
  ctx.stroke();
}

export const MAX_DOTS = 24; // dots drawn per layer, a bigger layer shows its size as a label

// Rows of dots for each layer size (inputs, hidden layers, outputs), joined by faint lines between neighbours.
export function drawBrainSketch(ctx: CanvasRenderingContext2D, sizes: readonly number[], cssW: number, cssH: number): void {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, cssW, cssH);
  const n = sizes.length;
  if (n === 0 || !(cssW > 0) || !(cssH > 0)) return;
  const top = 8;
  const bottom = 22; // room for the size labels
  const colX = (l: number): number => (n === 1 ? cssW / 2 : 18 + (l * (cssW - 36)) / (n - 1));
  const shown = sizes.map((s) => Math.max(0, Math.min(s, MAX_DOTS)));
  const dotY = (l: number, i: number): number => top + ((i + 0.5) * (cssH - top - bottom)) / shown[l]!;
  const r = Math.max(1.5, Math.min(4, (cssH - top - bottom) / (2 * MAX_DOTS) + 0.5));
  ctx.strokeStyle = "rgba(159, 184, 173, 0.07)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let l = 0; l + 1 < n; l++) {
    for (let i = 0; i < shown[l]!; i++) {
      for (let j = 0; j < shown[l + 1]!; j++) {
        ctx.moveTo(colX(l), dotY(l, i));
        ctx.lineTo(colX(l + 1), dotY(l + 1, j));
      }
    }
  }
  ctx.stroke();
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (let l = 0; l < n; l++) {
    ctx.fillStyle = l === 0 ? RAY : l === n - 1 ? LEARNER : FOOD;
    ctx.beginPath();
    for (let i = 0; i < shown[l]!; i++) {
      ctx.moveTo(colX(l) + r, dotY(l, i));
      ctx.arc(colX(l), dotY(l, i), r, 0, 2 * Math.PI);
    }
    ctx.fill();
    ctx.fillStyle = TEXT;
    ctx.fillText(String(sizes[l]), colX(l), cssH - 6);
  }
}
