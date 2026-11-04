import { WEIGHT_UNIT } from "../sim/maps/weights.ts";
import { TERRAIN_FAST, TERRAIN_SLOW } from "../sim/terrain.ts";
import type { Terrain } from "../sim/terrain.ts";
import { DRY_TINT, POISON_TINT, RICH_TINT } from "./mapTint.ts";
import { FLOOR } from "./scene.ts";
import { drawTerrain } from "./terrainScene.ts";
import { withRockHere } from "./abyssRock.ts";

// Legend swatches cut from the world itself: a small window of the map, drawn by the same code as the map, centred on a spot that
// shows one kind of ground or region well. So mud in the legend is the mud on the map, at a zoom where its texture reads.

export type SwatchKind = "rock" | "mud" | "firm" | "rich" | "poison" | "dry";
export interface Spot {
  x: number;
  y: number;
  span: number; // world units across the swatch
}

const GRID = 90; // sample points along the longer side when looking for a patch of mud or firm ground
const PATCH_SPAN = 520; // world units a ground swatch spans: a patch edge with its rim and some texture
const SWATCH_DRAWS = 4; // draws of a swatch at most
const EDGE_SHARE = 0.6; // of the ring around a ground spot of the same kind, so the swatch shows the patch and its edge

// The spot that shows kind best, or null when the world has none of it.
export function swatchSpot(t: Terrain, kind: SwatchKind): Spot | null {
  if (kind === "rock") return rockSpot(t);
  if (kind === "mud" || kind === "firm") return groundSpot(t, kind === "mud" ? TERRAIN_SLOW : TERRAIN_FAST);
  return null; // regions are drawn from their wash colour (mapSwatch)
}

function rockSpot(t: Terrain): Spot | null {
  if (t.rockCount === 0) return null;
  const order = Array.from({ length: t.rockCount }, (_, i) => i).sort((a, b) => t.rockR[a]! - t.rockR[b]!);
  const i = order[Math.floor(order.length * 0.8)]!; // a large stone, not the very largest
  return { x: t.rockX[i]!, y: t.rockY[i]!, span: 3.2 * t.rockR[i]! };
}

function groundSpot(t: Terrain, value: number): Spot | null {
  const step = Math.max(t.width, t.height) / GRID;
  const d = PATCH_SPAN * 0.3;
  let best: Spot | null = null;
  let bestScore = Infinity;
  for (let y = PATCH_SPAN; y < t.height - PATCH_SPAN; y += step) {
    for (let x = PATCH_SPAN; x < t.width - PATCH_SPAN; x += step) {
      if (t.valueAt(x, y) !== value || t.touchesRock(x, y, PATCH_SPAN / 2)) continue;
      let same = 0;
      for (let k = 0; k < 8; k++) if (t.valueAt(x + d * Math.cos((k * Math.PI) / 4), y + d * Math.sin((k * Math.PI) / 4)) === value) same++;
      const score = Math.abs(same / 8 - EDGE_SHARE);
      if (score < bestScore) {
        bestScore = score;
        best = { x, y, span: PATCH_SPAN };
      }
    }
  }
  return best;
}

// Draws the window around spot into canvas, sized cssW x cssH CSS pixels at the device pixel ratio.
export function drawSwatch(canvas: HTMLCanvasElement, t: Terrain, spot: Spot, cssW: number, cssH: number, dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1): void {
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const spanW = spot.span;
  const spanH = (spot.span * cssH) / cssW;
  const scale = canvas.width / spanW;
  const view = { x0: spot.x - spanW / 2, x1: spot.x + spanW / 2, y0: spot.y - spanH / 2, y1: spot.y + spanH / 2 };
  ctx.setTransform(scale, 0, 0, scale, -view.x0 * scale, -view.y0 * scale);
  // drawn once, so again until no image is put off for a later frame
  withRockHere(() => {
    for (let i = 0, done = false; i < SWATCH_DRAWS && !done; i++) {
      ctx.fillStyle = FLOOR;
      ctx.fillRect(view.x0, view.y0, spanW, spanH);
      done = drawTerrain(ctx, t, scale, view);
    }
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

const TINTS = { rich: RICH_TINT, poison: POISON_TINT, dry: DRY_TINT } as const;

// Whether the world has a visible wash of a region kind (as mapTint draws it).
function hasRegion(t: Terrain, kind: "rich" | "poison" | "dry"): boolean {
  const w = t.weights;
  if (!w) return false;
  if (kind === "poison") return w.maxPoison / WEIGHT_UNIT > POISON_TINT.from + POISON_TINT.span * 0.3;
  if (kind === "rich") return w.maxFood / WEIGHT_UNIT > RICH_TINT.from + RICH_TINT.span * 0.3;
  for (let n = 0; n < w.food.length; n++) if (w.food[n]! > 0 && w.food[n]! / WEIGHT_UNIT < DRY_TINT.from - DRY_TINT.span * 0.3) return true;
  return false;
}

// A region's wash on plain ground, faint at the left and as strong as the map draws it at the right: the wash spreads over
// thousands of units on the map, so a cut-out window would show almost no change.
function drawRegion(canvas: HTMLCanvasElement, kind: "rich" | "poison" | "dry", cssW: number, cssH: number, dpr: number): void {
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { rgb, alpha } = TINTS[kind];
  ctx.fillStyle = FLOOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const g = ctx.createLinearGradient(0, 0, canvas.width, 0);
  g.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
  g.addColorStop(0.55, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`);
  g.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// A canvas swatch of kind from t, or null when the world has none of it.
export function mapSwatch(t: Terrain, kind: SwatchKind, cssW = 48, cssH = 32): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const region = kind === "rich" || kind === "poison" || kind === "dry";
  const spot = region ? null : swatchSpot(t, kind);
  if (region ? !hasRegion(t, kind) : !spot) return null;
  const c = document.createElement("canvas");
  c.className = "map-swatch";
  c.setAttribute("aria-hidden", "true");
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  if (region) drawRegion(c, kind, cssW, cssH, dpr);
  else drawSwatch(c, t, spot!, cssW, cssH, dpr);
  return c;
}
