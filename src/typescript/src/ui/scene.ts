import type { CreatureState, EpisodeView, PlaybackState, WorldView } from "../sim/types.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON } from "../sim/types.ts";
import type { SimConfig } from "../sim/config.ts";
import { terrainOf } from "../sim/terrain.ts";
import { BACKGROUND, FLOOR, FOOD, OTHER, POISON, RAY_NONE, RAY_WALL, WALL } from "./palette.ts";
import type { Camera } from "./camera.ts";
import { drawTerrain } from "./terrainScene.ts";

export interface ViewOptions {
  showAll: boolean;
  showRays: boolean;
  pov: boolean;
}

export interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

// Values shared by all draw functions of one frame, computed once in drawScene.
export interface Frame extends Transform {
  px: number; // one canvas pixel in world units
  creatureR: number;
  itemR: number;
  rayLength: number;
  fullEnergy: number; // energy at which the body fill is full
}

const MARGIN = 12; // canvas pixels around the world
export { BACKGROUND, FLOOR, FOOD, OTHER, POISON, WALL };
export const RAY_COLORS = [RAY_NONE, FOOD, POISON, RAY_WALL, OTHER]; // indexed by HIT_NONE, HIT_FOOD, HIT_POISON, HIT_WALL, HIT_CREATURE
// Trials: the body is full at this many times the starting energy, so a newborn is one third full.
export const TRIALS_FULL_AT = 3;
// Hue by fill fraction, linear between stops so colour never jumps: red in the last emergency,
// yellow around the starting third, green when full.
const HUE_FILL = [0.05, 0.33, 0.6, 1];
const HUE_DEG = [0, 50, 62, 125];

const frame: Frame = { scale: 1, offsetX: 0, offsetY: 0, px: 1, creatureR: 0, itemR: 0, rayLength: 0, fullEnergy: 0 };

// Writes into out when given, so the per-frame call allocates nothing.
export function worldToCanvas(
  worldW: number,
  worldH: number,
  canvasW: number,
  canvasH: number,
  out: Transform = { scale: 1, offsetX: 0, offsetY: 0 },
): Transform {
  const availW = Math.max(1, canvasW - 2 * MARGIN);
  const availH = Math.max(1, canvasH - 2 * MARGIN);
  const scale = Math.min(availW / worldW, availH / worldH);
  out.scale = scale;
  out.offsetX = (canvasW - worldW * scale) / 2;
  out.offsetY = (canvasH - worldH * scale) / 2;
  return out;
}

const energyRatio = (f: Frame, e: number): number => (f.fullEnergy > 0 ? Math.min(1, Math.max(0, e / f.fullEnergy)) : 0);

function energyHue(fill: number): number {
  if (fill <= HUE_FILL[0]!) return HUE_DEG[0]!;
  for (let i = 1; i < HUE_FILL.length; i++) {
    const f1 = HUE_FILL[i]!;
    if (fill <= f1) {
      const f0 = HUE_FILL[i - 1]!;
      const h0 = HUE_DEG[i - 1]!;
      return h0 + ((HUE_DEG[i]! - h0) * (fill - f0)) / (f1 - f0);
    }
  }
  return HUE_DEG[HUE_DEG.length - 1]!;
}

// One ray from (x, y) at angle a, coloured by what it met (a HIT_* kind).
export function strokeRay(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, length: number, kind: number, alpha: number): void {
  ctx.strokeStyle = RAY_COLORS[kind] ?? RAY_COLORS[0]!;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(a) * length, y + Math.sin(a) * length);
  ctx.stroke();
}

// Discs of one kind from a world's item arrays, at x + xs * scale (the world's own coordinates by default).
export function fillItemDiscs(ctx: CanvasRenderingContext2D, w: WorldView, kind: number, color: string, r: number, x = 0, y = 0, scale = 1): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < w.count; i++) {
    if (w.kinds[i] !== kind) continue;
    const cx = x + w.xs[i]! * scale;
    const cy = y + w.ys[i]! * scale;
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
  ctx.fill();
}

// Items of the best creature's world copy.
export function drawItems(ctx: CanvasRenderingContext2D, f: Frame, w: WorldView): void {
  fillItemDiscs(ctx, w, HIT_FOOD, FOOD, f.itemR);
  fillItemDiscs(ctx, w, HIT_POISON, POISON, f.itemR);
}

// Cheap faint creature: body opacity scales with energy.
function drawOther(ctx: CanvasRenderingContext2D, f: Frame, s: PlaybackState): void {
  const r = f.creatureR;
  ctx.fillStyle = OTHER;
  ctx.strokeStyle = OTHER;
  ctx.lineWidth = f.px;
  ctx.globalAlpha = 0.08 + 0.3 * energyRatio(f, s.energy);
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.3;
  const cs = Math.cos(s.heading);
  const sn = Math.sin(s.heading);
  ctx.beginPath();
  ctx.moveTo(s.x + cs * r, s.y + sn * r);
  ctx.lineTo(s.x + cs * r * 1.6, s.y + sn * r * 1.6);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawBest(ctx: CanvasRenderingContext2D, f: Frame, s: CreatureState): void {
  const px = f.px;
  const R = Math.max(f.creatureR, 6 * px); // true size so contact on screen matches eating, but at least 6 screen pixels
  const e = energyRatio(f, s.energy);
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
    const hue = energyHue(e);
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
}

function drawRays(ctx: CanvasRenderingContext2D, f: Frame, ep: EpisodeView): void {
  const s = ep.state;
  const offsets = ep.rayOffsets;
  ctx.lineWidth = f.px;
  for (let i = 0; i < ep.rays.length && i < offsets.length; i++) {
    const hit = ep.rays[i]!;
    const hasHit = hit.kind !== HIT_NONE;
    const d = hasHit ? f.rayLength * (1 - hit.closeness) : f.rayLength;
    const a = s.heading + offsets[i]!;
    strokeRay(ctx, s.x, s.y, a, d, hit.kind, hasHit ? 0.9 : 0.6);
  }
  ctx.globalAlpha = 1;
}

// Darkens everything outside the best creature's vision circle, in screen space.
function drawPov(ctx: CanvasRenderingContext2D, f: Frame, s: CreatureState): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "rgba(0, 0, 0, 0.96)";
  ctx.beginPath();
  ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.arc(f.offsetX + s.x * f.scale, f.offsetY + s.y * f.scale, (f.rayLength + f.creatureR) * f.scale, 0, Math.PI * 2);
  ctx.fill("evenodd");
}

// Screen-space text in the top-right corner, sized in CSS pixels; the top-left holds the overlay cards.
// inset leaves room for controls over the canvas corner.
export function drawLabel(ctx: CanvasRenderingContext2D, text: string, dpr: number, inset = 12): void {
  ctx.font = `${13 * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(238, 245, 241, 0.7)";
  ctx.fillText(text, ctx.canvas.width - inset * dpr, 10 * dpr);
  ctx.textAlign = "left";
}

// Clears the canvas and draws floor and walls; leaves the context in world coordinates and returns the frame values.
// cam: a zoomed and panned view of the world instead of the whole of it.
export function beginFrame(ctx: CanvasRenderingContext2D, config: SimConfig, fullAt = TRIALS_FULL_AT, cam?: Camera): Frame {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const { width: ww, height: wh } = config.world;
  worldToCanvas(ww, wh, cw, ch, frame);
  const f = frame;
  if (cam) {
    f.scale = cam.zoom;
    f.offsetX = cw / 2 + cam.focusX - cam.cx * cam.zoom;
    f.offsetY = ch / 2 + cam.focusY - cam.cy * cam.zoom;
  }
  f.px = 1 / f.scale;
  f.creatureR = config.creature.radius;
  f.itemR = Math.max(config.world.itemRadius, 1.5 * f.px);
  f.rayLength = config.creature.rayLength;
  f.fullEnergy = fullAt * config.creature.startEnergy;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, cw, ch);

  ctx.setTransform(f.scale, 0, 0, f.scale, f.offsetX, f.offsetY);
  ctx.fillStyle = FLOOR;
  ctx.fillRect(0, 0, ww, wh);
  let seen;
  if (cam) {
    const a = cam.screenToWorld(0, 0);
    const b = cam.screenToWorld(cw, ch);
    seen = { x0: a.x, x1: b.x, y0: a.y, y1: b.y }; // only what is on screen is painted
  }
  drawTerrain(ctx, terrainOf(config), f.scale, seen);
  ctx.strokeStyle = WALL;
  ctx.lineWidth = 3 / f.scale; // 3 device px
  ctx.strokeRect(0, 0, ww, wh);
  return f;
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  config: SimConfig,
  best: EpisodeView | null,
  others: readonly PlaybackState[],
  view: ViewOptions,
  label: string | null = null,
  dpr = 1,
  cam?: Camera,
): void {
  const f = beginFrame(ctx, config, TRIALS_FULL_AT, cam);

  if (best) {
    drawItems(ctx, f, best.world);
    if (view.showAll) {
      for (let i = 0; i < others.length; i++) {
        if (others[i]!.alive) drawOther(ctx, f, others[i]!);
      }
    }
    drawBest(ctx, f, best.state);
    if (view.showRays) drawRays(ctx, f, best);
    if (view.pov) drawPov(ctx, f, best.state);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (label) drawLabel(ctx, label, dpr);
}
