import { rayAngleOffsets } from "../sim/sensors.ts";
import type { PlanView } from "../sim/sensors.ts";
import { BACKGROUND, FLOOR, FOOD, POISON, WALL } from "./scene.ts";

// Live design preview of the Arena: the creature and its ray fan to scale with an example of what it sees, and a dot sketch of its brain.
export const PREVIEW_ROOM = 200; // the Nibble environment, world units
export const PREVIEW_RADIUS = 12; // creature radius, as in the ecosystem config
const ITEM_R = 4;
const LEARNER = "#fbbf24";
const OUTLINE = "rgba(5, 15, 10, 0.85)";
const RAY = "#7dd3fc";
const TEXT = "#9fb8ad";

// What the preview's example scene shows each ray: food on the ray nearest straight ahead, poison on one to the side.
export interface PreviewHit {
  kind: "food" | "poison" | null;
  distance: number; // world units from the body centre to the item, the ray's length when it sees nothing
}

const ITEM_SPOTS = [
  { kind: "food" as const, angle: 0, at: 0.55 },
  { kind: "poison" as const, angle: 0.6, at: 0.8 },
];

// The example items placed on the rays nearest to their angles (each ray sees at most one), and what every ray sees.
export function previewSight(plan: PlanView): PreviewHit[] {
  const offsets = rayAngleOffsets(plan);
  const hits: PreviewHit[] = Array.from(offsets, () => ({ kind: null, distance: plan.rayLength }));
  const taken = new Set<number>();
  for (const spot of ITEM_SPOTS) {
    let best = -1;
    for (let k = 0; k < offsets.length; k++) if (!taken.has(k) && (best < 0 || Math.abs(offsets[k]! - spot.angle) < Math.abs(offsets[best]! - spot.angle))) best = k;
    if (best < 0 || Math.abs(offsets[best]! - spot.angle) > 0.9) continue; // no ray points anywhere near: the item stays unseen
    taken.add(best);
    hits[best] = { kind: spot.kind, distance: spot.at * plan.rayLength };
  }
  return hits;
}

const HIT_COLOR = { food: FOOD, poison: POISON };

// Draws the creature (centre, facing right) with its whole ray fan to scale, the sight range as a dashed ring, and the
// example food and poison from previewSight, each ray coloured by what it sees, as in the game.
export function drawCreaturePreview(ctx: CanvasRenderingContext2D, plan: PlanView, cssW: number, cssH: number): void {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, cssW, cssH);
  const reach = plan.rayLength + PREVIEW_RADIUS;
  const pad = 26; // room for the labels
  const scale = (Math.min(cssW, cssH) / 2 - pad) / reach;
  if (!(scale > 0)) return;
  const offsets = rayAngleOffsets(plan);
  const hits = previewSight(plan);
  ctx.save();
  ctx.translate(cssW / 2, cssH / 2);
  ctx.scale(scale, scale);
  ctx.fillStyle = FLOOR;
  ctx.beginPath();
  ctx.arc(0, 0, plan.rayLength, 0, 2 * Math.PI);
  ctx.fill();
  ctx.setLineDash([4 / scale, 4 / scale]);
  ctx.strokeStyle = WALL;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1 / scale;
  ctx.stroke();
  ctx.setLineDash([]);
  offsets.forEach((a, k) => {
    const hit = hits[k]!;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    ctx.lineWidth = 1.4 / scale;
    ctx.strokeStyle = hit.kind ? HIT_COLOR[hit.kind] : RAY;
    ctx.globalAlpha = hit.kind ? 0.95 : 0.55;
    ctx.beginPath();
    ctx.moveTo(cos * PREVIEW_RADIUS, sin * PREVIEW_RADIUS);
    ctx.lineTo(cos * hit.distance, sin * hit.distance);
    ctx.stroke();
    if (hit.kind) {
      ctx.globalAlpha = 0.15; // the ray goes on unseen past what it hit
      ctx.strokeStyle = RAY;
      ctx.beginPath();
      ctx.moveTo(cos * hit.distance, sin * hit.distance);
      ctx.lineTo(cos * plan.rayLength, sin * plan.rayLength);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = HIT_COLOR[hit.kind];
      ctx.beginPath();
      ctx.arc(cos * hit.distance, sin * hit.distance, Math.max(ITEM_R, 3 / scale), 0, 2 * Math.PI);
      ctx.fill();
    }
  });
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
  // Scale bar for the sight length, along the bottom edge, and the body size for reference.
  const y = cssH - 20;
  const x0 = (cssW - plan.rayLength * scale) / 2;
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
  ctx.fillText(`sight ${Math.round(plan.rayLength)}`, (x0 + x1) / 2, y + 4);
  ctx.textAlign = "left";
  ctx.fillText(`body ${2 * PREVIEW_RADIUS} wide`, 10, 10);
}
