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
// into a bitmap (at the next scale tier up, so it is only ever shrunk) and drawn as an image, a patch larger than MAX_BITMAP_PX as tiles of that size made when first in view;
// close up only the patches in view are painted live. A map keeps the bitmaps of every tier it was viewed at, within MAX_BAKED_PX pixels in all. A frame makes at most BAKES_PER_FRAME of them, patches still waiting are painted live meanwhile.

export const FEATHER_UNITS = 4; // widest the fade into the floor reaches inside the edge, world units: a slight softening, the edge stays crisp
const FLOOR = "#10291f";
export const FEATHER_BANDS = [1, 0.7, 0.45, 0.22].map((k, i) => ({ width: FEATHER_UNITS * k, alpha: 0.2 + 0.07 * i })); // floor-coloured bands from the edge inwards
const FEATHER_COARSE = [{ width: FEATHER_UNITS, alpha: 0.5 }];
const COARSE_BELOW = 0.1; // scale (device px per world unit)
const FINE_FROM = 0.05; // scale from which the outline is the fine one; coarser views use the cheap coarse one
const EDGE_PX = 1.1; // device px of the dark line inside the contour
const SHOULDER_PX = 1.6; // device px of the pale line just inside that
const TIERS = [0.02, 0.04, 0.08, 0.16, 0.32]; // bitmap scales; a view at a scale up to the largest draws bitmaps of the next tier up
const MAX_BITMAP_PX = 640; // longest side of a bitmap; larger patches are cut into tiles of this size
const MAX_BAKED_PX = 8_000_000; // pixels of bitmaps kept per map over all tiers (32 MB of RGBA, enough for the Inland Sea whole at tiers 0.02 to 0.16), beyond that patches are painted live
const BAKES_PER_FRAME = 1; // bitmaps one drawGround call makes at most, so a new tier costs a few frames and not one long one (a bitmap costs 20 to 60 ms to raster, whatever its size); a patch still waiting is painted live
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

import { makeCanvas } from "./canvas.ts";
export { makeCanvas };

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

// A patch at a tier scale is one bitmap, or a grid of bitmaps of at most MAX_BITMAP_PX when it is larger. A tile's bitmap carries BAKE_PAD px of its neighbours' content
// around the part it shows, and tiles are made when first in view (a few frames).
interface Tile {
  image: OffscreenCanvas | HTMLCanvasElement;
  sx: number; // the shown part of the image, px
  sy: number;
  sw: number;
  sh: number;
  x: number; // where it lands, world units
  y: number;
  w: number;
  h: number;
  whole: boolean; // the patch is this one bitmap, drawn as it is
}
interface Grid {
  ox: number; // world position of the patch bitmap's corner
  oy: number;
  px: number; // patch bitmap size, px
  py: number;
  cols: number;
  rows: number;
  tiles: (Tile | undefined)[];
}
interface TierStore {
  tier: number;
  grids: Map<Patch, Grid>;
  pixels: number;
}
interface Baked {
  tiers: Map<number, TierStore>; // least recently used first
  pixels: number; // over all tiers, at most MAX_BAKED_PX
}
const baked = new WeakMap<Terrain, Baked>();
const TILE_BODY = MAX_BITMAP_PX - 2 * BAKE_PAD; // px of a tile's own part

// Pixels of bitmaps a map holds now (4 bytes each), never more than MAX_BAKED_PX.
export const bakedPixels = (t: Terrain): number => baked.get(t)?.pixels ?? 0;

function gridOf(tier: number, patch: Patch): Grid {
  const b = patch.body;
  const px = Math.ceil((b.x1 - b.x0) * tier) + 2 * BAKE_PAD;
  const py = Math.ceil((b.y1 - b.y0) * tier) + 2 * BAKE_PAD;
  const whole = px <= MAX_BITMAP_PX && py <= MAX_BITMAP_PX;
  const cols = whole ? 1 : Math.ceil(px / TILE_BODY);
  const rows = whole ? 1 : Math.ceil(py / TILE_BODY);
  return { ox: b.x0 - BAKE_PAD / tier, oy: b.y0 - BAKE_PAD / tier, px, py, cols, rows, tiles: new Array<Tile | undefined>(cols * rows) };
}

let probe: CanvasRenderingContext2D | null | undefined;
// A canvas rasters its paint when it is first drawn from. Drawing a new bitmap into a 1 px canvas makes that happen in the frame that made it, not for all the waiting tiles at once when the last one completes the patch.
function rasterNow(image: Canvas): void {
  if (probe === undefined) probe = context2d(makeCanvas(1, 1));
  probe?.drawImage(image as CanvasImageSource, 0, 0, 1, 1);
}

// Paints tile (i, j) of a patch once. Null when this call has baked its share, or when the budget cannot hold the tile even after dropping every other tier (which are then kept).
function bake(store: Baked, ts: TierStore, g: Grid, patch: Patch, i: number, j: number, left: { n: number }): Tile | null {
  const tier = ts.tier;
  const whole = g.cols === 1 && g.rows === 1;
  const x0 = whole ? 0 : i * TILE_BODY; // the tile's own part, in patch bitmap px
  const y0 = whole ? 0 : j * TILE_BODY;
  const sw = whole ? g.px : Math.min(TILE_BODY, g.px - x0);
  const sh = whole ? g.py : Math.min(TILE_BODY, g.py - y0);
  const pad = whole ? 0 : BAKE_PAD;
  const w = sw + 2 * pad;
  const h = sh + 2 * pad;
  if (left.n <= 0 || ts.pixels + w * h > MAX_BAKED_PX) return null;
  for (const [t, other] of store.tiers) {
    if (store.pixels + w * h <= MAX_BAKED_PX) break;
    if (other === ts) continue;
    store.tiers.delete(t);
    store.pixels -= other.pixels;
  }
  const image = makeCanvas(w, h);
  const c = context2d(image);
  if (!image || !c) return null;
  left.n--;
  store.pixels += w * h;
  ts.pixels += w * h;
  const b = patch.body;
  c.setTransform(tier, 0, 0, tier, pad - x0 + BAKE_PAD - b.x0 * tier, pad - y0 + BAKE_PAD - b.y0 * tier);
  c.lineJoin = "round";
  paintPatch(c, patch, tier);
  rasterNow(image);
  return { image, sx: pad, sy: pad, sw, sh, x: g.ox + x0 / tier, y: g.oy + y0 / tier, w: sw / tier, h: sh / tier, whole };
}

// The store of a tier, made the most recently used.
function touch(store: Baked, tier: number): TierStore {
  const ts = store.tiers.get(tier) ?? { tier, grids: new Map(), pixels: 0 };
  store.tiers.delete(tier);
  store.tiers.set(tier, ts);
  return ts;
}

// The tiles of a patch in view at a tier, baking those not yet made while left allows (never with left null, then a missing grid counts as a missing tile). Null when one is missing.
function tilesIn(store: Baked, ts: TierStore, patch: Patch, view: View, left: { n: number } | null): Tile[] | null {
  const tier = ts.tier;
  let g = ts.grids.get(patch);
  if (!g && left) ts.grids.set(patch, (g = gridOf(tier, patch)));
  if (!g) return null;
  const tiled = g.cols * g.rows > 1;
  const wanted: Tile[] = [];
  for (let j = 0; j < g.rows; j++) {
    for (let i = 0; i < g.cols; i++) {
      if (tiled) {
        const x = g.ox + (i * TILE_BODY) / tier;
        const y = g.oy + (j * TILE_BODY) / tier;
        if (x > view.x1 || y > view.y1 || x + TILE_BODY / tier < view.x0 || y + TILE_BODY / tier < view.y0) continue;
      }
      const k = j * g.cols + i;
      const tile = g.tiles[k] ?? (left ? (g.tiles[k] = bake(store, ts, g, patch, i, j, left) ?? undefined) : undefined);
      if (!tile) return null;
      wanted.push(tile);
    }
  }
  return wanted;
}

// Draws a patch from its bitmaps at this tier, baking what is missing while left allows. While a tile in view is still missing it is drawn, scaled, from the most recently used other tier
// that has all of its tiles in view (on a zoom in, the tier just left), and only when none has does this return false and the caller paints the patch live.
function drawBaked(ctx: CanvasRenderingContext2D, store: Baked, ts: TierStore, patch: Patch, view: View, left: { n: number }): boolean {
  let wanted = tilesIn(store, ts, patch, view, left);
  if (!wanted) for (const other of [...store.tiers.values()].reverse()) if (other !== ts && (wanted = tilesIn(store, other, patch, view, null))) break;
  if (!wanted) return false;
  const m = wanted.some((t) => !t.whole) ? ctx.getTransform() : null;
  for (const t of wanted) {
    if (t.whole || !m || m.b !== 0 || m.c !== 0) ctx.drawImage(t.image as CanvasImageSource, t.sx, t.sy, t.sw, t.sh, t.x, t.y, t.w, t.h);
    else {
      // Neighbouring tiles share whole device pixel edges, so no hairline shows between them.
      const dx = Math.round(m.a * t.x + m.e);
      const dy = Math.round(m.d * t.y + m.f);
      const dw = Math.round(m.a * (t.x + t.w) + m.e) - dx;
      const dh = Math.round(m.d * (t.y + t.h) + m.f) - dy;
      if (dw === 0 || dh === 0) continue;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(t.image as CanvasImageSource, t.sx, t.sy, t.sw, t.sh, dx, dy, dw, dh);
      ctx.restore();
    }
  }
  return true;
}

const patchesIn = (t: Terrain, tier: number | undefined, scale: number, view: View): Patch[] =>
  patchesOf(t, (tier ?? scale) >= FINE_FROM ? fineOf(t) : 1).filter(({ body: b }) => b.x1 + VIEW_PAD >= view.x0 && b.x0 - VIEW_PAD <= view.x1 && b.y1 + VIEW_PAD >= view.y0 && b.y0 - VIEW_PAD <= view.y1);

// With the frame's bake unused, makes the bitmaps of the next coarser tier for a view twice as wide, so a zoom out finds them ready. Never when a bitmap might push a tier out.
function bakeCoarser(t: Terrain, store: Baked, tier: number, view: View, left: { n: number }): void {
  const coarser = TIERS[TIERS.indexOf(tier) - 1];
  if (coarser === undefined || left.n <= 0 || store.pixels + MAX_BITMAP_PX * MAX_BITMAP_PX > MAX_BAKED_PX) return;
  const ts = store.tiers.get(coarser) ?? { tier: coarser, grids: new Map(), pixels: 0 };
  store.tiers.set(coarser, ts);
  const w = (view.x1 - view.x0) / 2;
  const h = (view.y1 - view.y0) / 2;
  const wide = { x0: view.x0 - w, x1: view.x1 + w, y0: view.y0 - h, y1: view.y1 + h };
  for (const patch of patchesIn(t, coarser, coarser, wide)) if (left.n > 0) tilesIn(store, ts, patch, wide, left);
}

// quick: the coarse outline with flat fills, for the settings preview that redraws while sliders move.
export function drawGround(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View, quick: boolean): void {
  if (t.ground === null || typeof Path2D === "undefined") return;
  const tier = quick ? undefined : TIERS.find((s) => s >= scale);
  const shown = patchesIn(t, tier, quick ? 0 : scale, view);
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
    if (!store) baked.set(t, (store = { tiers: new Map(), pixels: 0 }));
    const ts = touch(store, tier);
    const left = { n: BAKES_PER_FRAME };
    for (const patch of shown) if (!drawBaked(ctx, store, ts, patch, view, left)) paintPatch(ctx, patch, scale);
    bakeCoarser(t, store, tier, view, left);
    touch(store, tier); // the coarser tier is the older one
  }
  ctx.restore();
}
