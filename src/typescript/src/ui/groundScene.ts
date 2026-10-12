import { createRng } from "../sim/rng.ts";
import { TERRAIN_FAST, TERRAIN_SLOW } from "../sim/terrain.ts";
import { GROUND_PAD } from "../sim/groundField.ts";
import type { Terrain } from "../sim/terrain.ts";
import { fineOf, groundBodies, traceSmooth } from "./groundOutline.ts";
import type { GroundBody } from "./groundOutline.ts";
import type { View } from "./terrainScene.ts";

// Draws the slow ground (mud) and fast ground (firm) of a Terrain, in world coordinates under the current transform.
// The edge of a patch is the 0.5 contour of the ground field, which is where creatures start to sense and feel the ground (Terrain.valueAt).
// Everything softer than that is cosmetic and stays inside the edge: a feather of at most FEATHER_UNITS fades the colour into the floor,
// and a lighter shallow rim of mud (or firm ground) fades into the deeper colour further in. The rim is the field itself, drawn as a small image scaled up
// smoothly (alpha falls as the field value rises from the edge value to its full value), so it is a true gradient that follows the contour and costs no strokes.
// Cost: a patch is a clip, a fill and a few dozen strokes of a long path, too much per frame for a whole world. From afar each patch is painted once
// into a small bitmap (at the next scale tier up, so it is only ever shrunk) and drawn as an image; close up only the patches in view are painted live.

export const FEATHER_UNITS = 4; // widest the fade into the floor reaches inside the edge, world units: a slight softening, the edge stays crisp
const FLOOR = "#10291f";
export const FEATHER_BANDS = [1, 0.7, 0.45, 0.22].map((k, i) => ({ width: FEATHER_UNITS * k, alpha: 0.2 + 0.07 * i })); // floor-coloured bands from the edge inwards
const FEATHER_COARSE = [{ width: FEATHER_UNITS, alpha: 0.5 }];
const COARSE_BELOW = 0.1; // scale (device px per world unit)
const FINE_FROM = 0.05; // scale from which the outline is the fine one; coarser views use the cheap coarse one
const EDGE_PX = 1.1; // device px of the dark line inside the contour
const SHOULDER_PX = 1.6; // device px of the pale line just inside that
const TIERS = [0.02, 0.04, 0.08, 0.16, 0.32]; // bitmap scales; a view at a scale up to the largest draws bitmaps of the next tier up
const MAX_BITMAP_PX = 640; // longest side of a patch bitmap; larger patches are painted live
const MAX_BAKED_PX = 16_000_000; // pixels of bitmaps kept per map (64 MB), beyond that patches are painted live
const BAKE_PAD = 4; // px around a bitmap
interface Style {
  flat: string;
  seed: number;
  rimColor: number[]; // the lighter shallow rim, fading into the deeper ground further in
  rimAlpha: number; // its opacity at the edge
  edge: string;
  shoulder: string;
}
const STYLE: Record<number, Style> = {
  [TERRAIN_SLOW]: { flat: "#453c2a", seed: 21, rimColor: [170, 152, 104], rimAlpha: 0.3, edge: "rgba(10, 8, 4, 0.5)", shoulder: "rgba(0, 0, 0, 0)" },
  [TERRAIN_FAST]: { flat: "#555a3c", seed: 22, rimColor: [186, 178, 124], rimAlpha: 0.14, edge: "rgba(20, 18, 6, 0.55)", shoulder: "rgba(208, 200, 146, 0.12)" },
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

type Wrapped = (draw: (dx: number, dy: number) => void) => void;
type Painter = (g: CanvasRenderingContext2D, wrapped: Wrapped, rng: ReturnType<typeof createRng>) => void;

// A seamless tile: a flat base colour, then what the painter adds, repeated over the edges so it tiles.
function tile(base: string, seed: number, paint: Painter): OffscreenCanvas | HTMLCanvasElement | null {
  const c = makeCanvas(TILE_PX, TILE_PX);
  const g = context2d(c);
  if (!c || !g) return null;
  g.fillStyle = base;
  g.fillRect(0, 0, TILE_PX, TILE_PX);
  const wrapped: Wrapped = (draw) => {
    for (const dx of [-TILE_PX, 0, TILE_PX]) for (const dy of [-TILE_PX, 0, TILE_PX]) draw(dx, dy);
  };
  paint(g, wrapped, createRng(seed));
  return c;
}

function blotches(g: CanvasRenderingContext2D, wrapped: Wrapped, rng: ReturnType<typeof createRng>, count: number, light: string, dark: string): void {
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

// Short strokes in any direction up to the spread (a full half turn is no grain at all).
function dashes(g: CanvasRenderingContext2D, wrapped: Wrapped, rng: ReturnType<typeof createRng>, count: number, len: readonly [number, number], width: number, color: string, spread: number): void {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = "round";
  for (let i = 0; i < count; i++) {
    const x = rng.range(0, TILE_PX);
    const y = rng.range(0, TILE_PX);
    const l = rng.range(len[0], len[1]);
    const a = rng.range(0, spread);
    wrapped((dx, dy) => {
      g.beginPath();
      g.moveTo(x + dx, y + dy);
      g.lineTo(x + dx + l * Math.cos(a), y + dy + l * Math.sin(a));
      g.stroke();
    });
  }
}

function specks(g: CanvasRenderingContext2D, wrapped: Wrapped, rng: ReturnType<typeof createRng>, count: number, color: string, size: number): void {
  g.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const x = rng.range(0, TILE_PX);
    const y = rng.range(0, TILE_PX);
    const r = rng.range(0.5, 1) * size;
    wrapped((dx, dy) => g.fillRect(x + dx, y + dy, r, r));
  }
}

// Wet earth: broad dark and light stains, short ripples and damp glints in every direction.
const mudTile: Painter = (g, wrapped, rng) => {
  blotches(g, wrapped, rng, 46, "rgba(150, 132, 90, 0.07)", "rgba(10, 8, 4, 0.11)");
  dashes(g, wrapped, rng, 50, [6, 18], 1.5, "rgba(14, 10, 4, 0.1)", Math.PI);
  dashes(g, wrapped, rng, 36, [6, 20], 1, "rgba(196, 176, 120, 0.07)", Math.PI);
  specks(g, wrapped, rng, 90, "rgba(210, 200, 150, 0.1)", 1.5);
};

// Firm ground: dry packed earth, opaque and warm, with fine pebbles, grit and hairline cracks in every direction.
const firmTile: Painter = (g, wrapped, rng) => {
  blotches(g, wrapped, rng, 22, "rgba(214, 206, 150, 0.035)", "rgba(20, 16, 6, 0.08)");
  specks(g, wrapped, rng, 380, "rgba(226, 218, 164, 0.14)", 1.6);
  specks(g, wrapped, rng, 380, "rgba(14, 12, 4, 0.2)", 1.6);
  specks(g, wrapped, rng, 36, "rgba(232, 224, 176, 0.2)", 3.2);
  dashes(g, wrapped, rng, 70, [4, 12], 1, "rgba(16, 14, 4, 0.12)", Math.PI);
  dashes(g, wrapped, rng, 50, [4, 12], 1, "rgba(220, 212, 156, 0.07)", Math.PI);
};

const tiles = new Map<number, OffscreenCanvas | HTMLCanvasElement | null>(); // one tile per kind, shared by every canvas
const patterns = new WeakMap<CanvasRenderingContext2D, Map<number, CanvasPattern | null>>();

function patternFor(ctx: CanvasRenderingContext2D, kind: number): CanvasPattern | null {
  let m = patterns.get(ctx);
  if (!m) patterns.set(ctx, (m = new Map()));
  if (!m.has(kind)) {
    const style = STYLE[kind]!;
    if (!tiles.has(kind)) tiles.set(kind, tile(style.flat, style.seed, kind === TERRAIN_SLOW ? mudTile : firmTile));
    const c = tiles.get(kind);
    const pattern = c ? ctx.createPattern(c as CanvasImageSource, "repeat") : null;
    pattern?.setTransform(new DOMMatrix().scale(TILE_UNITS / TILE_PX));
    m.set(kind, pattern);
  }
  return m.get(kind)!;
}

interface Patch {
  body: GroundBody;
  path: Path2D;
  rim: Canvas | null;
  field: Terrain["ground"];
}
type Canvas = OffscreenCanvas | HTMLCanvasElement;

// The rim of one kind as an image with a pixel per raster node: the colour of the rim, alpha highest where the field is at its edge value.
const rimImages = new WeakMap<Terrain, Map<number, Canvas | null>>();
function rimImage(t: Terrain, kind: number): Canvas | null {
  const f = t.ground;
  if (f === null) return null;
  let m = rimImages.get(t);
  if (!m) rimImages.set(t, (m = new Map()));
  if (!m.has(kind)) {
    const style = STYLE[kind]!;
    const c = makeCanvas(f.cols, f.rows);
    const g = context2d(c);
    let image: Canvas | null = null;
    if (c && g && typeof ImageData !== "undefined") {
      const layer = kind === TERRAIN_SLOW ? 0 : 1;
      const px = new Uint8ClampedArray(4 * f.cols * f.rows);
      for (let k = 0; k < f.cols * f.rows; k++) {
        const v = f.data[2 * k + layer]!;
        if (v < 128) continue;
        px[4 * k] = style.rimColor[0]!;
        px[4 * k + 1] = style.rimColor[1]!;
        px[4 * k + 2] = style.rimColor[2]!;
        px[4 * k + 3] = Math.round(255 * style.rimAlpha * (1 - (v - 128) / 127) ** 1.5);
      }
      g.putImageData(new ImageData(px, f.cols, f.rows), 0, 0);
      image = c;
    }
    m.set(kind, image);
  }
  return m.get(kind)!;
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
      return { body, path, rim: rimImage(t, body.kind), field: t.ground };
    });
    byLevel.set(level, p);
  }
  return p;
}

// Paints one patch under the current transform: texture, lighter rim, feather, then a crisp edge. scale is device px per world unit.
function paintPatch(ctx: CanvasRenderingContext2D, { body, path, rim, field }: Patch, scale: number): void {
  const style = STYLE[body.kind]!;
  const textured = scale >= TEXTURE_FROM;
  const coarse = scale < COARSE_BELOW; // a few px per band at best, so fewer bands do
  const px = 1 / scale;
  ctx.save();
  ctx.clip(path, "evenodd");
  ctx.fillStyle = (textured ? patternFor(ctx, body.kind) : null) ?? style.flat;
  ctx.fill(path, "evenodd");
  if (textured && rim && field) {
    const { cell, cols, rows } = field;
    const i0 = Math.max(0, Math.floor(body.x0 / cell) + GROUND_PAD - 1);
    const i1 = Math.min(cols - 1, Math.ceil(body.x1 / cell) + GROUND_PAD + 1);
    const j0 = Math.max(0, Math.floor(body.y0 / cell) + GROUND_PAD - 1);
    const j1 = Math.min(rows - 1, Math.ceil(body.y1 / cell) + GROUND_PAD + 1);
    ctx.drawImage(rim as CanvasImageSource, i0, j0, i1 - i0 + 1, j1 - j0 + 1, (i0 - GROUND_PAD - 0.5) * cell, (j0 - GROUND_PAD - 0.5) * cell, (i1 - i0 + 1) * cell, (j1 - j0 + 1) * cell); // nodes are pixel centres
  }
  ctx.strokeStyle = FLOOR;
  for (const { width, alpha } of coarse ? FEATHER_COARSE : FEATHER_BANDS) {
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

interface Bitmap {
  image: OffscreenCanvas | HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Baked {
  tier: number;
  bitmaps: Map<Patch, Bitmap | null>; // null: too big to bake, painted live
  pixels: number;
}
const baked = new WeakMap<Terrain, Baked>();

// A patch painted once at a tier scale into its own bitmap, or null when it is too big or the map's bitmap budget is spent.
function bake(store: Baked, patch: Patch): Bitmap | null {
  const b = patch.body;
  const w = Math.ceil((b.x1 - b.x0) * store.tier) + 2 * BAKE_PAD;
  const h = Math.ceil((b.y1 - b.y0) * store.tier) + 2 * BAKE_PAD;
  if (w > MAX_BITMAP_PX || h > MAX_BITMAP_PX || store.pixels + w * h > MAX_BAKED_PX) return null;
  const image = makeCanvas(w, h);
  const g = context2d(image);
  if (!image || !g) return null;
  store.pixels += w * h;
  g.setTransform(store.tier, 0, 0, store.tier, BAKE_PAD - b.x0 * store.tier, BAKE_PAD - b.y0 * store.tier);
  g.lineJoin = "round";
  paintPatch(g, patch, store.tier);
  return { image, x: b.x0 - BAKE_PAD / store.tier, y: b.y0 - BAKE_PAD / store.tier, w: w / store.tier, h: h / store.tier };
}

// quick: the coarse outline with flat fills, for the settings preview that redraws while sliders move.
export function drawGround(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View, quick: boolean): void {
  if (t.ground === null || typeof Path2D === "undefined") return;
  const tier = quick ? undefined : TIERS.find((s) => s >= scale);
  const level = !quick && (tier ?? scale) >= FINE_FROM ? fineOf(t) : 1;
  const shown = patchesOf(t, level).filter(({ body: b }) => b.x1 + VIEW_PAD >= view.x0 && b.x0 - VIEW_PAD <= view.x1 && b.y1 + VIEW_PAD >= view.y0 && b.y0 - VIEW_PAD <= view.y1);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, t.width, t.height);
  ctx.clip();
  ctx.lineJoin = "round";
  if (quick) {
    for (const kind of [TERRAIN_SLOW, TERRAIN_FAST]) {
      ctx.fillStyle = STYLE[kind]!.flat;
      for (const { body, path } of shown) if (body.kind === kind) ctx.fill(path, "evenodd");
    }
  } else if (tier === undefined) {
    for (const patch of shown) paintPatch(ctx, patch, scale); // close up: live, only what is in view
  } else {
    let store = baked.get(t);
    if (!store || store.tier !== tier) baked.set(t, (store = { tier, bitmaps: new Map(), pixels: 0 }));
    for (const patch of shown) {
      let bitmap = store.bitmaps.get(patch);
      if (bitmap === undefined) store.bitmaps.set(patch, (bitmap = bake(store, patch)));
      if (bitmap) ctx.drawImage(bitmap.image as CanvasImageSource, bitmap.x, bitmap.y, bitmap.w, bitmap.h);
      else paintPatch(ctx, patch, scale);
    }
  }
  ctx.restore();
}
