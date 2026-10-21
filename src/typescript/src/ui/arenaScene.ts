import { HIT_NONE } from "../sim/types.ts";
import { CREATURE_FIELDS } from "../sim/rl/recording.ts";
import type { Recording } from "../sim/rl/recording.ts";
import { BACKGROUND, FLOOR, FOOD, POISON, RAY_COLORS, WALL } from "./scene.ts";
import { SPECIES_COLORS, hunterPath } from "./speciesStyle.ts";

const MIN_CREATURE_PX = 4; // never smaller than this on screen, so big worlds stay readable
const MIN_ITEM_PX = 2;
const LEARNER = "#fbbf24";
const OUTLINE = "rgba(5, 15, 10, 0.85)";
const PREDATOR = 1;

// Frame to show `seconds` into the loop.
export const frameAt = (rec: Recording, seconds: number): number => (rec.frames <= 0 || rec.dt <= 0 ? 0 : Math.floor(seconds / rec.dt) % rec.frames);

// Length of one loop in seconds.
export const loopSeconds = (rec: Recording): number => rec.frames * rec.dt;

// Draws frame `f` of a recording, fitted and centred in a cssW x cssH canvas (ctx already scaled to CSS pixels).
export function drawArena(ctx: CanvasRenderingContext2D, rec: Recording, f: number, cssW: number, cssH: number, showRays = true): void {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, cssW, cssH);
  const pad = 10;
  const scale = Math.min((cssW - 2 * pad) / rec.width, (cssH - 2 * pad) / rec.height);
  if (!(scale > 0) || rec.frames <= 0) return;
  ctx.save();
  ctx.translate((cssW - rec.width * scale) / 2, (cssH - rec.height * scale) / 2);
  ctx.scale(scale, scale);
  ctx.fillStyle = FLOOR;
  ctx.fillRect(0, 0, rec.width, rec.height);
  ctx.strokeStyle = WALL;
  ctx.lineWidth = 2 / scale;
  ctx.strokeRect(0, 0, rec.width, rec.height);

  const frame = Math.min(Math.max(0, f), rec.frames - 1);
  drawItems(ctx, rec, frame, scale);
  const c0 = rec.creatureStart[frame]!;
  const c1 = rec.creatureStart[frame + 1]!;
  const r = Math.max(rec.creatureRadius, MIN_CREATURE_PX / scale);
  let learner = -1;
  for (let c = c0; c < c1; c++) {
    const o = c * CREATURE_FIELDS;
    if (rec.creatureData[o + 4]! > 0) {
      learner = o;
      continue;
    }
    drawCreature(ctx, rec.creatureData, o, r, scale, false);
  }
  if (learner >= 0) {
    if (showRays) drawRays(ctx, rec, frame, learner, scale);
    drawCreature(ctx, rec.creatureData, learner, r * 1.3, scale, true);
  }
  ctx.restore();
}

function drawItems(ctx: CanvasRenderingContext2D, rec: Recording, frame: number, scale: number): void {
  const r = Math.max(rec.itemRadius, MIN_ITEM_PX / scale);
  const i0 = rec.itemStart[frame]!;
  const i1 = rec.itemStart[frame + 1]!;
  for (const [kind, color] of [[1, FOOD], [2, POISON]] as const) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = i0; i < i1; i++) {
      if (rec.itemData[3 * i + 2] !== kind) continue;
      const x = rec.itemData[3 * i]!;
      const y = rec.itemData[3 * i + 1]!;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, 2 * Math.PI);
    }
    ctx.fill();
  }
}

function drawCreature(ctx: CanvasRenderingContext2D, d: Float32Array, o: number, r: number, scale: number, learner: boolean): void {
  const x = d[o]!;
  const y = d[o + 1]!;
  const heading = d[o + 2]!;
  const species = d[o + 3]!;
  const color = learner ? LEARNER : (SPECIES_COLORS[species] ?? SPECIES_COLORS[0]!);
  ctx.beginPath();
  if (species === PREDATOR) hunterPath(ctx, x, y, r, heading);
  else ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.globalAlpha = learner ? 1 : 0.9;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = learner ? "#fff7d6" : OUTLINE;
  ctx.lineWidth = (learner ? 1.6 : 1.2) / scale;
  ctx.stroke();
  if (species !== PREDATOR) {
    ctx.strokeStyle = OUTLINE; // heading line
    ctx.lineWidth = 1.6 / scale;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(heading) * r * 1.5, y + Math.sin(heading) * r * 1.5);
    ctx.stroke();
  }
}

function drawRays(ctx: CanvasRenderingContext2D, rec: Recording, frame: number, o: number, scale: number): void {
  const d = rec.creatureData;
  const x = d[o]!;
  const y = d[o + 1]!;
  const heading = d[o + 2]!;
  ctx.lineWidth = 1 / scale;
  ctx.globalAlpha = 0.45;
  for (let k = 0; k < rec.rayCount; k++) {
    const at = 2 * (rec.rayCount * frame + k);
    const kind = rec.rays[at + 1]!;
    const length = kind === HIT_NONE ? rec.rayLength : rec.rayLength * (1 - rec.rays[at]!);
    const a = heading + rec.rayOffsets[k]!;
    ctx.strokeStyle = RAY_COLORS[kind] ?? RAY_COLORS[0]!;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * length, y + Math.sin(a) * length);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Whether the learner is still alive in frame f (it has no creature row after it dies).
export function learnerAlive(rec: Recording, f: number): boolean {
  if (rec.frames <= 0) return false;
  const frame = Math.min(Math.max(0, f), rec.frames - 1);
  for (let c = rec.creatureStart[frame]!; c < rec.creatureStart[frame + 1]!; c++) if (rec.creatureData[c * CREATURE_FIELDS + 4]! > 0) return true;
  return false;
}
