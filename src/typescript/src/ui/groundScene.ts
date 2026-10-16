import { TERRAIN_FAST, TERRAIN_SLOW } from "../sim/terrain.ts";
import type { Terrain } from "../sim/terrain.ts";
import { fineOf, groundBodies, traceSmooth } from "./groundOutline.ts";
import type { GroundBody } from "./groundOutline.ts";
import type { View } from "./terrainScene.ts";
import { distance } from "./edt.ts";
import { canvasOfPixels, fbm, GROUND_BASE_UNITS, GROUND_GRAIN_UNITS, groundBaseTile, groundGrainTile, groundRippleTile, smooth } from "./noiseTex.ts";
import type { GrainLook, GroundLook, RippleLook } from "./noiseTex.ts";

// Draws the slow ground (mud) and fast ground (firm) of a Terrain, in world coordinates under the current transform.
// The edge of a patch is the 0.5 contour of the ground field, which is where creatures start to sense and feel the ground (Terrain.valueAt).
// Everything softer than that is cosmetic and stays inside the edge: a feather of at most FEATHER_UNITS fades the colour into the floor,
// and a lighter shallow rim of mud (or firm ground) fades into the deeper colour further in. The rim is the field itself, drawn as a small image scaled up
// smoothly (alpha falls as the field value rises from the edge value to its full value), so it is a true gradient that follows the contour and costs no strokes.
// Cost: a patch is a clip, a fill and a few dozen strokes of a long path, too much per frame for a whole world. From afar each patch is painted once
// into a bitmap (at the next scale tier up, so it is only ever shrunk) and drawn as an image, a patch larger than MAX_BITMAP_PX as tiles of that size made when first in view;
// close up only the patches in view are painted live. A map keeps the bitmaps of every tier it was viewed at, within MAX_BAKED_PX pixels in all. A frame makes at most BAKES_PER_FRAME of them, patches still waiting are painted live meanwhile.

export const FEATHER_UNITS = 4; // widest the fade into the floor reaches inside the edge, world units: a slight softening, the edge stays crisp
const FLOOR = "#0a1c21";
export const FEATHER_BANDS = [1, 0.7, 0.45, 0.22].map((k, i) => ({ width: FEATHER_UNITS * k, alpha: 0.2 + 0.07 * i })); // floor-coloured bands from the edge inwards
const FEATHER_COARSE = [{ width: FEATHER_UNITS, alpha: 0.5 }];
const COARSE_BELOW = 0.1; // scale (device px per world unit)
const FINE_FROM = 0.05; // scale from which the outline is the fine one; coarser views use the cheap coarse one
const EDGE_PX = 0.8; // device px of the faint line inside the contour
const TIERS = [0.02, 0.04, 0.08, 0.16, 0.32]; // bitmap scales; a view at a scale up to the largest draws bitmaps of the next tier up
const MAX_BITMAP_PX = 640; // longest side of a bitmap; larger patches are cut into tiles of this size
const MAX_BAKED_PX = 8_000_000; // pixels of bitmaps kept per map over all tiers (32 MB of RGBA, enough for the Inland Sea whole at tiers 0.02 to 0.16), beyond that patches are painted live
const BAKES_PER_FRAME = 1; // bitmaps one drawGround call makes at most, so a new tier costs a few frames and not one long one (a bitmap costs 20 to 60 ms to raster, whatever its size); a patch still waiting is painted live
const BAKE_PAD = 4; // px around a bitmap
interface Style {
  flat: string; // the colour from afar and in previews
  look: GroundLook; // the smooth colour tile
  ripples: RippleLook; // the ripple marks over it
  grain: GrainLook; // the grain tile over that
  rimColor: number[]; // the pale shallows along the edge, fading into the ground further in
  rimAlpha: number; // their opacity at the edge
  rimReach: number; // world units over which they fade, about
  deepColor: number[]; // the darker deep middle
  deepAlpha: number;
  deepFrom: number; // distance from the edge at which it starts and the span over which it reaches full
  deepSpan: number;
  edge: string; // a faint line on the contour
}
// Mud: a pale silty shelf, lighter in the shallows and darker towards the deep middle. Firm ground: pale coarse sand with shell grit.
const STYLE: Record<number, Style> = {
  [TERRAIN_SLOW]: {
    flat: "#4d4a40",
    look: { base: [72, 69, 60], mottle: 0.09, seed: 21 },
    ripples: { light: [190, 176, 140], dark: [10, 10, 8], lightAlpha: 0.045, darkAlpha: 0.14, stripes: [34, 11], bend: 1.5, seed: 24 },
    grain: { light: [196, 184, 150], dark: [18, 16, 12], fine: 0.012, coarse: 0.0006, shell: 0.00005, seed: 25 },
    rimColor: [182, 172, 142],
    rimAlpha: 0.5,
    rimReach: 70,
    deepColor: [22, 26, 26],
    deepAlpha: 0.5,
    deepFrom: 120,
    deepSpan: 600,
    edge: "rgba(6, 10, 10, 0.1)",
  },
  [TERRAIN_FAST]: {
    flat: "#85806a",
    look: { base: [124, 118, 98], mottle: 0.07, seed: 22 },
    ripples: { light: [222, 214, 180], dark: [30, 26, 16], lightAlpha: 0.07, darkAlpha: 0.15, stripes: [26, 15], bend: 1.2, seed: 26 },
    grain: { light: [236, 228, 196], dark: [40, 34, 20], fine: 0.03, coarse: 0.004, shell: 0.0004, seed: 27 },
    rimColor: [214, 206, 172],
    rimAlpha: 0.25,
    rimReach: 60,
    deepColor: [40, 40, 34],
    deepAlpha: 0.22,
    deepFrom: 120,
    deepSpan: 500,
    edge: "rgba(6, 10, 10, 0.08)",
  },
};
const SHADOW = [{ units: 2.5, alpha: 0.3 }, { units: 7, alpha: 0.16 }] as const; // silt shadow outside the edge, at most SHADOW_MAX_PX screen px wide (the bitmap pad holds it)
const SHADOW_MAX_PX = 3;
const SHELF_CELL = 25; // world units a pixel of the shelf image covers
const SHELF_MAX_CELLS = 600_000;
const GRAIN_FROM = 0.25; // scale from which the grain tile is drawn, full at GRAIN_FROM + 0.35
const RIPPLES_FROM = 0.12; // the same for the ripple marks, full at RIPPLES_FROM + 0.2
const TILE_PX = 512;
const TEXTURE_FROM = 0.03; // scale (device px per world unit) from which textures and rims are drawn, below it a patch is one flat fill
const VIEW_PAD = 80; // world units past a patch that still draw

import { makeCanvas } from "./canvas.ts";
export { makeCanvas };

export const context2d = (c: OffscreenCanvas | HTMLCanvasElement | null): CanvasRenderingContext2D | null => (c ? (c.getContext("2d") as CanvasRenderingContext2D | null) : null);

const tiles = new Map<string, OffscreenCanvas | HTMLCanvasElement | null>(); // tiles are shared by every canvas
interface Pats {
  base: CanvasPattern | null;
  ripples: CanvasPattern | null;
  grain: CanvasPattern | null;
}
const patterns = new WeakMap<CanvasRenderingContext2D, Map<number, Pats>>();

function patternsFor(ctx: CanvasRenderingContext2D, kind: number): Pats {
  let m = patterns.get(ctx);
  if (!m) patterns.set(ctx, (m = new Map()));
  let p = m.get(kind);
  if (!p) {
    const style = STYLE[kind]!;
    const make = (name: string, build: () => OffscreenCanvas | HTMLCanvasElement | null, units: number): CanvasPattern | null => {
      const key = `${kind}:${name}`;
      if (!tiles.has(key)) tiles.set(key, build());
      const c = tiles.get(key);
      const pattern = c ? ctx.createPattern(c as CanvasImageSource, "repeat") : null;
      pattern?.setTransform(new DOMMatrix().scale(units / TILE_PX));
      return pattern;
    };
    p = {
      base: make("base", () => groundBaseTile(style.look), GROUND_BASE_UNITS),
      ripples: make("ripples", () => groundRippleTile(style.ripples), GROUND_BASE_UNITS),
      grain: make("grain", () => groundGrainTile(style.grain), GROUND_GRAIN_UNITS),
    };
    m.set(kind, p);
  }
  return p;
}

interface Patch {
  body: GroundBody;
  path: Path2D;
}
type Canvas = OffscreenCanvas | HTMLCanvasElement;

// The shelf of a patch as an image of SHELF_CELL world units a pixel, from the distance to the edge: a pale, bright band along the shallows that fades
// inwards (its reach wanders with noise, so it is no contour-parallel stripe), and a darker deep middle in the big patches. Drawn scaled up smoothly, clipped to the patch.
interface Shelf {
  image: Canvas;
  ox: number;
  oy: number;
  w: number;
  h: number;
  cell: number;
}
const shelves = new WeakMap<Patch, Shelf | null>();

function shelfOf(patch: Patch): Shelf | null {
  let shelf = shelves.get(patch);
  if (shelf !== undefined) return shelf;
  shelf = null;
  const { body, path } = patch;
  const style = STYLE[body.kind]!;
  let cell = SHELF_CELL;
  while (((body.x1 - body.x0) / cell + 6) * ((body.y1 - body.y0) / cell + 6) > SHELF_MAX_CELLS) cell *= 2;
  const ox = Math.floor(body.x0 / cell) * cell - 2 * cell;
  const oy = Math.floor(body.y0 / cell) * cell - 2 * cell;
  const w = Math.ceil((body.x1 - ox) / cell) + 3;
  const h = Math.ceil((body.y1 - oy) / cell) + 3;
  const mask = makeCanvas(w, h);
  const mg = mask?.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  if (mask && mg && typeof ImageData !== "undefined") {
    mg.setTransform(1 / cell, 0, 0, 1 / cell, -ox / cell, -oy / cell);
    mg.fillStyle = "#fff";
    mg.fill(path, "evenodd");
    const alpha = mg.getImageData(0, 0, w, h).data;
    const inside = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) inside[k] = alpha[4 * k + 3]! >= 128 ? 1 : 0;
    const dist = distance(inside, w, h);
    const px = new Uint8ClampedArray(4 * w * h);
    const pale = style.rimColor;
    const deep = style.deepColor;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (!inside[k]) continue;
        const d = Math.max(0, dist[k]! - 0.5) * cell;
        const wx = ox + (x + 0.5) * cell;
        const wy = oy + (y + 0.5) * cell;
        const reach = style.rimReach * (1 + 0.5 * fbm(wx / 420, wy / 420, style.look.seed + 40, 3));
        const a = style.rimAlpha * Math.exp(-d / reach);
        const b = style.deepAlpha * smooth(style.deepFrom, style.deepFrom + style.deepSpan, d);
        const total = a + b * (1 - a);
        if (total <= 0) continue;
        px[4 * k] = (pale[0]! * a + deep[0]! * b * (1 - a)) / total;
        px[4 * k + 1] = (pale[1]! * a + deep[1]! * b * (1 - a)) / total;
        px[4 * k + 2] = (pale[2]! * a + deep[2]! * b * (1 - a)) / total;
        px[4 * k + 3] = 255 * total;
      }
    }
    const image = canvasOfPixels(w, h, px);
    if (image) shelf = { image, ox, oy, w, h, cell };
  }
  shelves.set(patch, shelf);
  return shelf;
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

// Paints one patch under the current transform: silt shadow outside the edge, then clipped to the patch the colour tile, ripples, grain, the lighter shallow rim,
// and the feather into the floor. scale is device px per world unit.
function paintPatch(ctx: CanvasRenderingContext2D, patch: Patch, scale: number): void {
  const { body, path } = patch;
  const style = STYLE[body.kind]!;
  const textured = scale >= TEXTURE_FROM;
  const coarse = scale < COARSE_BELOW; // a few px per band at best, so fewer bands do
  const px = 1 / scale;
  SHADOW.forEach(({ units, alpha }, i) => {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = `rgba(2, 9, 12, ${alpha})`;
    ctx.lineWidth = 2 * Math.min(units, Math.max(SHADOW_MAX_PX * px * (i + 1) / SHADOW.length, 0.8 * px));
    ctx.stroke(path);
  });
  ctx.save();
  ctx.clip(path, "evenodd");
  const pats = textured ? patternsFor(ctx, body.kind) : null;
  ctx.fillStyle = pats?.base ?? style.flat;
  ctx.fill(path, "evenodd");
  if (pats) {
    const ripples = smooth(RIPPLES_FROM, RIPPLES_FROM + 0.2, scale);
    if (pats.ripples && ripples > 0) {
      ctx.globalAlpha = ripples;
      ctx.fillStyle = pats.ripples;
      ctx.fill(path, "evenodd");
    }
    const grain = smooth(GRAIN_FROM, GRAIN_FROM + 0.35, scale);
    if (pats.grain && grain > 0) {
      ctx.globalAlpha = grain;
      ctx.fillStyle = pats.grain;
      ctx.fill(path, "evenodd");
    }
    ctx.globalAlpha = 1;
  }
  const shelf = textured ? shelfOf(patch) : null;
  if (shelf) {
    const smoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(shelf.image as CanvasImageSource, shelf.ox, shelf.oy, shelf.w * shelf.cell, shelf.h * shelf.cell);
    ctx.imageSmoothingEnabled = smoothing;
  }
  ctx.strokeStyle = FLOOR;
  for (const { width, alpha } of coarse ? FEATHER_COARSE : FEATHER_BANDS) {
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2 * width;
    ctx.stroke(path);
  }
  if (textured) {
    ctx.globalAlpha = 1;
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
