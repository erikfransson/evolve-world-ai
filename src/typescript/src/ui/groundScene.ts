import { createRng } from "../sim/rng.ts";
import { TERRAIN_FAST, TERRAIN_SLOW } from "../sim/terrain.ts";
import type { Terrain } from "../sim/terrain.ts";
import { fineOf, groundBodies } from "./groundOutline.ts";
import type { GroundBody } from "./groundOutline.ts";
import { traceSmooth } from "./rockOutline.ts";
import type { View } from "./terrainScene.ts";

// Draws the slow ground (mud) and fast ground (firm) of a Terrain, in world coordinates under the current transform.
// The edge of a patch is the 0.5 contour of the ground field, which is where creatures start to sense and feel the ground (Terrain.valueAt).
// Everything softer than that is cosmetic and stays inside the edge: a feather of at most FEATHER_UNITS fades the colour into the floor,
// and a lighter shallow rim of mud (or firm ground) fades into the deeper colour further in.

export const FEATHER_UNITS = 4; // widest the fade into the floor reaches inside the edge, world units: a slight softening, the edge stays crisp
const FLOOR = "#10291f";
const bands = (widths: number[], alpha: number): { width: number; alpha: number }[] => widths.map((width) => ({ width, alpha })); // stacked, from the edge inwards: a smooth gradient
export const FEATHER_BANDS = [1, 0.7, 0.45, 0.22].map((k, i) => ({ width: FEATHER_UNITS * k, alpha: 0.2 + 0.07 * i })); // floor-coloured bands from the edge inwards
const FEATHER_COARSE = [{ width: FEATHER_UNITS, alpha: 0.5 }];
const COARSE_BELOW = 0.1; // scale (device px per world unit)
const FINE_FROM = 0.05; // scale from which the outline is the fine one; coarser views use the cheap coarse one
const EDGE_PX = 1.1; // device px of the dark line inside the contour
const SHOULDER_PX = 1.6; // device px of the pale line just inside that
interface Style {
  flat: string;
  seed: number;
  rimColor: string; // the lighter shallow rim, fading into the deeper ground further in
  rim: { width: number; alpha: number }[];
  rimCoarse: { width: number; alpha: number }[];
  edge: string;
  shoulder: string;
}
const STYLE: Record<number, Style> = {
  [TERRAIN_SLOW]: { flat: "#453c2a", seed: 21, rimColor: "rgb(166, 150, 104)", rim: bands([84, 60, 40, 24, 12], 0.05), rimCoarse: bands([56, 20], 0.07), edge: "rgba(10, 8, 4, 0.5)", shoulder: "rgba(0, 0, 0, 0)" },
  [TERRAIN_FAST]: { flat: "#38574a", seed: 22, rimColor: "rgb(150, 186, 168)", rim: bands([26, 12], 0.035), rimCoarse: bands([20], 0.05), edge: "rgba(6, 18, 12, 0.5)", shoulder: "rgba(176, 208, 182, 0.2)" },
};
const TILE_UNITS = 720; // world units one texture tile covers
const TILE_PX = 256;
const TEXTURE_FROM = 0.03; // scale (device px per world unit) from which textures and rims are drawn, below it a patch is one flat fill
const VIEW_PAD = 80; // world units past a patch that still draw

export function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export const context2d = (c: OffscreenCanvas | HTMLCanvasElement | null): CanvasRenderingContext2D | null => (c ? (c.getContext("2d") as CanvasRenderingContext2D | null) : null);

type Painter = (g: CanvasRenderingContext2D, wrapped: (draw: (dx: number, dy: number) => void) => void, rng: ReturnType<typeof createRng>) => void;

// A seamless tile: a flat base colour, then what the painter adds, repeated over the edges so it tiles.
function tile(base: string, seed: number, paint: Painter): OffscreenCanvas | HTMLCanvasElement | null {
  const c = makeCanvas(TILE_PX, TILE_PX);
  const g = context2d(c);
  if (!c || !g) return null;
  g.fillStyle = base;
  g.fillRect(0, 0, TILE_PX, TILE_PX);
  const wrapped = (draw: (dx: number, dy: number) => void): void => {
    for (const dx of [-TILE_PX, 0, TILE_PX]) for (const dy of [-TILE_PX, 0, TILE_PX]) draw(dx, dy);
  };
  paint(g, wrapped, createRng(seed));
  return c;
}

function blotches(g: CanvasRenderingContext2D, wrapped: (draw: (dx: number, dy: number) => void) => void, rng: ReturnType<typeof createRng>, count: number, light: string, dark: string): void {
  for (let i = 0; i < count; i++) {
    const x = rng.range(0, TILE_PX);
    const y = rng.range(0, TILE_PX);
    const r = rng.range(14, 46);
    const tone = rng.next() < 0.5 ? light : dark;
    wrapped((dx, dy) => {
      const grad = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      grad.addColorStop(0, tone);
      grad.addColorStop(1, "rgba(0, 0, 0, 0)");
      g.fillStyle = grad;
      g.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
    });
  }
}

function dashes(g: CanvasRenderingContext2D, wrapped: (draw: (dx: number, dy: number) => void) => void, rng: ReturnType<typeof createRng>, count: number, len: readonly [number, number], width: number, color: string, tilt: number): void {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = "round";
  for (let i = 0; i < count; i++) {
    const x = rng.range(0, TILE_PX);
    const y = rng.range(0, TILE_PX);
    const l = rng.range(len[0], len[1]);
    const t = rng.range(-tilt, tilt);
    wrapped((dx, dy) => {
      g.beginPath();
      g.moveTo(x + dx, y + dy);
      g.lineTo(x + dx + l, y + dy + t * l);
      g.stroke();
    });
  }
}

// Wet earth: broad dark and light stains, short flat ripples with a faint sheen under them, a few damp glints.
const mudTile: Painter = (g, wrapped, rng) => {
  blotches(g, wrapped, rng, 46, "rgba(150, 132, 90, 0.07)", "rgba(10, 8, 4, 0.11)");
  dashes(g, wrapped, rng, 70, [10, 34], 1.5, "rgba(14, 10, 4, 0.2)", 0.04);
  dashes(g, wrapped, rng, 40, [8, 24], 1, "rgba(196, 176, 120, 0.07)", 0.04);
  g.fillStyle = "rgba(210, 200, 150, 0.1)";
  for (let i = 0; i < 90; i++) {
    const x = rng.range(0, TILE_PX);
    const y = rng.range(0, TILE_PX);
    wrapped((dx, dy) => g.fillRect(x + dx, y + dy, 1, 1));
  }
};

// Firm ground: fine flat streaks at low contrast on desaturated sage.
const firmTile: Painter = (g, wrapped, rng) => {
  blotches(g, wrapped, rng, 16, "rgba(190, 220, 190, 0.025)", "rgba(4, 14, 10, 0.07)");
  dashes(g, wrapped, rng, 170, [14, 70], 1, "rgba(206, 232, 206, 0.075)", 0.02);
  dashes(g, wrapped, rng, 130, [10, 50], 1, "rgba(6, 18, 12, 0.1)", 0.02);
};

const patterns = new WeakMap<CanvasRenderingContext2D, Map<number, CanvasPattern | null>>();

function patternFor(ctx: CanvasRenderingContext2D, kind: number): CanvasPattern | null {
  let m = patterns.get(ctx);
  if (!m) patterns.set(ctx, (m = new Map()));
  if (!m.has(kind)) {
    const style = STYLE[kind]!;
    const c = tile(style.flat, style.seed, kind === TERRAIN_SLOW ? mudTile : firmTile);
    const pattern = c ? ctx.createPattern(c as CanvasImageSource, "repeat") : null;
    pattern?.setTransform(new DOMMatrix().scale(TILE_UNITS / TILE_PX));
    m.set(kind, pattern);
  }
  return m.get(kind)!;
}

interface Patch {
  body: GroundBody;
  path: Path2D;
}
const cached = new WeakMap<Terrain, Map<number, Patch[]>>();

// The drawable patches of a map at one outline refinement (see groundBodies), built once per map and refinement.
function patchesOf(t: Terrain, level: number): Patch[] {
  let byLevel = cached.get(t);
  if (!byLevel) cached.set(t, (byLevel = new Map()));
  let p = byLevel.get(level);
  if (!p) {
    p = groundBodies(t, level).map((body) => {
      const path = new Path2D();
      for (const loop of body.loops) traceSmooth(path, loop);
      return { body, path };
    });
    byLevel.set(level, p);
  }
  return p;
}

// quick: the coarse outline with flat fills, for the settings preview that redraws while sliders move.
export function drawGround(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View, quick: boolean): void {
  if (t.ground === null || typeof Path2D === "undefined") return;
  const fine = !quick && scale >= FINE_FROM;
  const shown = patchesOf(t, fine ? fineOf(t) : 1).filter(({ body: b }) => b.x1 + VIEW_PAD >= view.x0 && b.x0 - VIEW_PAD <= view.x1 && b.y1 + VIEW_PAD >= view.y0 && b.y0 - VIEW_PAD <= view.y1);
  const textured = !quick && scale >= TEXTURE_FROM;
  const coarse = scale < COARSE_BELOW; // a few px per band at best, so fewer bands do
  const px = 1 / scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, t.width, t.height);
  ctx.clip();
  ctx.lineJoin = "round";
  for (const kind of [TERRAIN_SLOW, TERRAIN_FAST]) {
    const style = STYLE[kind]!;
    const rim = coarse ? style.rimCoarse : style.rim;
    const feather = coarse ? FEATHER_COARSE : FEATHER_BANDS;
    ctx.fillStyle = (textured ? patternFor(ctx, kind) : null) ?? style.flat;
    for (const { body, path } of shown) {
      if (body.kind !== kind) continue;
      ctx.save();
      ctx.clip(path, "evenodd");
      ctx.fill(path, "evenodd");
      if (textured) {
        ctx.strokeStyle = style.rimColor;
        for (const { width, alpha } of rim) {
          ctx.globalAlpha = alpha;
          ctx.lineWidth = 2 * width;
          ctx.stroke(path);
        }
      }
      ctx.strokeStyle = FLOOR;
      for (const { width, alpha } of feather) {
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 2 * width;
        ctx.stroke(path);
      }
      if (textured) {
        ctx.globalAlpha = 1; // a crisp edge: a thin dark line on the contour and a pale one just inside it
        ctx.strokeStyle = style.shoulder;
        ctx.lineWidth = 2 * (EDGE_PX + SHOULDER_PX) * px;
        ctx.stroke(path);
        ctx.strokeStyle = style.edge;
        ctx.lineWidth = 2 * EDGE_PX * px;
        ctx.stroke(path);
      }
      ctx.restore();
    }
  }
  ctx.restore();
}
