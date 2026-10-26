import { TERRAIN_FAST, TERRAIN_SLOW } from "../sim/terrain.ts";
import type { Terrain } from "../sim/terrain.ts";
import { fineOf, groundBodies, traceSmooth } from "./groundOutline.ts";
import type { GroundBody } from "./groundOutline.ts";
import type { View } from "./terrainScene.ts";
import { distance } from "./edt.ts";
import { FLOOR, SILT_SHADOW } from "./palette.ts";
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
export const FEATHER_BANDS = [1, 0.7, 0.45, 0.22].map((k, i) => ({ width: FEATHER_UNITS * k, alpha: 0.2 + 0.07 * i })); // floor-coloured bands from the edge inwards
const FEATHER_COARSE = [{ width: FEATHER_UNITS, alpha: 0.5 }];
const COARSE_BELOW = 0.1; // scale (device px per world unit)
const FINE_FROM = 0.05; // scale from which the outline is the fine one; coarser views use the cheap coarse one
const EDGE_PX = 1.3; // device px of the faint line inside the contour
const TIERS = [0.02, 0.04, 0.08, 0.16, 0.32]; // bitmap scales; a view at a scale up to the largest draws bitmaps of the next tier up
const MAX_BITMAP_PX = 640; // longest side of a bitmap; larger patches are cut into tiles of this size
const MAX_BAKED_PX = 12_000_000; // pixels of bitmaps kept per map over all tiers (48 MB of RGBA: a full 1600 x 900 view of the 50000 wide Inland Sea at two tiers and the whole map at the coarse ones), beyond that patches are painted live
const BAKES_PER_FRAME = 1; // bitmaps one drawGround call makes at most, so a new tier costs a few frames and not one long one (a bitmap costs 20 to 60 ms to raster, whatever its size); a patch still waiting is painted live
const PREPARE_BAKES = 2; // bitmaps prepareGround makes per call
const BAKE_PAD = 4; // px around a bitmap
interface Style {
  flat: string; // the colour from afar and in previews
  look: GroundLook; // the smooth colour tile
  ripples: RippleLook | null; // the ripple marks over it, none on mud
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
    flat: "#36432f",
    look: { base: [46, 60, 46], mottle: 0.16, seed: 21 },
    ripples: null,
    grain: { light: [150, 168, 140], dark: [10, 18, 14], fine: 0.006, coarse: 0, shell: 0, seed: 25 },
    rimColor: [92, 110, 84],
    rimAlpha: 0.3,
    rimReach: 80,
    deepColor: [12, 20, 18],
    deepAlpha: 0.55,
    deepFrom: 120,
    deepSpan: 600,
    edge: "rgba(4, 10, 8, 0.4)",
  },
  [TERRAIN_FAST]: {
    flat: "#85806a",
    look: { base: [128, 121, 100], mottle: 0.07, seed: 22 },
    ripples: { light: [222, 214, 180], dark: [30, 26, 16], lightAlpha: 0.04, darkAlpha: 0.1, stripes: [26, 15], bend: 2.6, seed: 26 },
    grain: { light: [236, 228, 196], dark: [40, 34, 20], fine: 0.03, coarse: 0.004, shell: 0.0003, seed: 27 },
    rimColor: [216, 208, 174],
    rimAlpha: 0.25,
    rimReach: 60,
    deepColor: [40, 40, 34],
    deepAlpha: 0.2,
    deepFrom: 120,
    deepSpan: 500,
    edge: "rgba(6, 10, 10, 0.08)",
  },
};
const SHADOW = [{ units: 2.5, alpha: 0.3 }, { units: 7, alpha: 0.16 }] as const; // silt shadow outside the edge, at most SHADOW_MAX_PX screen px wide (the bitmap pad holds it)
const SHADOW_MAX_PX = 3;
const SHADOW_RGB = SILT_SHADOW.join(", ");
const SHELF_CELL = 25; // world units a pixel of the shelf image covers
const SHELF_MAX_CELLS = 600_000;
const SHELF_BUDGET_CELLS = 8_000_000; // pixels of shelf images kept over all patches (32 MB), the least recently used go first
const SHELF_BUILD_CELLS = 150_000; // pixels of shelf images one draw or prepare builds at most (always one); a patch still waiting is drawn without its shelf
const GRAIN_FROM = 0.45; // scale from which the grain tile is drawn, full at GRAIN_FROM + 0.35
const RIPPLES_FROM = 0.6; // the same for the ripple marks, full at RIPPLES_FROM + 0.5
const TEXTURE_FROM = 0.03; // scale (device px per world unit) from which textures and rims are drawn, below it a patch is one flat fill
const VIEW_PAD = 80; // world units past a patch that still draw

import { buildBudget, context2d, makeCanvas, spend } from "./canvas.ts";
import type { BuildBudget } from "./canvas.ts";
export { context2d, makeCanvas };

const tiles = new Map<string, OffscreenCanvas | HTMLCanvasElement | null>(); // tiles are shared by every canvas
interface Pats {
  base: CanvasPattern | null;
  readonly ripples: CanvasPattern | null; // made when first asked for, as from afar they are not drawn
  readonly grain: CanvasPattern | null;
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
      pattern?.setTransform(new DOMMatrix().scale(units / c!.width));
      return pattern;
    };
    let ripples: CanvasPattern | null | undefined;
    let grain: CanvasPattern | null | undefined;
    p = {
      base: make("base", () => groundBaseTile(style.look), GROUND_BASE_UNITS),
      get ripples() {
        return ripples === undefined ? (ripples = style.ripples ? make("ripples", () => groundRippleTile(style.ripples!), GROUND_BASE_UNITS) : null) : ripples;
      },
      get grain() {
        return grain === undefined ? (grain = make("grain", () => groundGrainTile(style.grain), GROUND_GRAIN_UNITS)) : grain;
      },
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
// Module-wide, not per map: the shelves of a map left behind stay until newer ones push them out of SHELF_BUDGET_CELLS.
const shelves = new Map<Patch, Shelf | null>(); // least recently used first
let shelfCells = 0;

// The shelf of a patch, built now if budget allows; undefined when it was put off.
function shelfOf(patch: Patch, budget: BuildBudget): Shelf | null | undefined {
  let shelf = shelves.get(patch);
  if (shelf !== undefined) {
    shelves.delete(patch);
    shelves.set(patch, shelf);
    return shelf;
  }
  shelf = null;
  const { body, path } = patch;
  const style = STYLE[body.kind]!;
  let cell = SHELF_CELL;
  while (((body.x1 - body.x0) / cell + 6) * ((body.y1 - body.y0) / cell + 6) > SHELF_MAX_CELLS) cell *= 2;
  const ox = Math.floor(body.x0 / cell) * cell - 2 * cell;
  const oy = Math.floor(body.y0 / cell) * cell - 2 * cell;
  const w = Math.ceil((body.x1 - ox) / cell) + 3;
  const h = Math.ceil((body.y1 - oy) / cell) + 3;
  if (!spend(budget, w * h)) return undefined;
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
  if (shelf) {
    shelfCells += shelf.w * shelf.h;
    for (const [p, old] of shelves) {
      if (shelfCells <= SHELF_BUDGET_CELLS || p === patch) break;
      shelves.delete(p);
      if (old) shelfCells -= old.w * old.h;
    }
  }
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
// and the feather into the floor. scale is device px per world unit. A shelf the budget puts off is left out (budget.refused tells).
function paintPatch(ctx: CanvasRenderingContext2D, patch: Patch, scale: number, budget: BuildBudget): void {
  const { body, path } = patch;
  const style = STYLE[body.kind]!;
  const textured = scale >= TEXTURE_FROM;
  const coarse = scale < COARSE_BELOW; // a few px per band at best, so fewer bands do
  const px = 1 / scale;
  SHADOW.forEach(({ units, alpha }, i) => {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = `rgba(${SHADOW_RGB}, ${alpha})`;
    ctx.lineWidth = 2 * Math.min(units, Math.max(SHADOW_MAX_PX * px * (i + 1) / SHADOW.length, 0.8 * px));
    ctx.stroke(path);
  });
  ctx.save();
  ctx.clip(path, "evenodd");
  const pats = textured ? patternsFor(ctx, body.kind) : null;
  ctx.fillStyle = pats?.base ?? style.flat;
  ctx.fill(path, "evenodd");
  if (pats) {
    const ripples = smooth(RIPPLES_FROM, RIPPLES_FROM + 0.5, scale);
    const ripplePattern = ripples > 0 ? pats.ripples : null;
    if (ripplePattern) {
      ctx.globalAlpha = ripples;
      ctx.fillStyle = ripplePattern;
      ctx.fill(path, "evenodd");
    }
    const grain = smooth(GRAIN_FROM, GRAIN_FROM + 0.35, scale);
    const grainPattern = grain > 0 ? pats.grain : null;
    if (grainPattern) {
      ctx.globalAlpha = grain;
      ctx.fillStyle = grainPattern;
      ctx.fill(path, "evenodd");
    }
    ctx.globalAlpha = 1;
  }
  const shelf = textured ? shelfOf(patch, budget) : null;
  if (shelf) {
    const smoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
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
function bake(store: Baked, ts: TierStore, g: Grid, patch: Patch, i: number, j: number, left: { n: number }, budget: BuildBudget): Tile | null {
  const tier = ts.tier;
  if (left.n <= 0 || (tier >= TEXTURE_FROM && shelfOf(patch, budget) === undefined)) return null; // a bitmap is never baked without its shelf
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
  paintPatch(c, patch, tier, budget);
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
function tilesIn(store: Baked, ts: TierStore, patch: Patch, view: View, left: { n: number } | null, budget: BuildBudget): Tile[] | null {
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
      const tile = g.tiles[k] ?? (left ? (g.tiles[k] = bake(store, ts, g, patch, i, j, left, budget) ?? undefined) : undefined);
      if (!tile) return null;
      wanted.push(tile);
    }
  }
  return wanted;
}

// Draws a patch from its bitmaps at this tier, baking what is missing while left allows. While a tile in view is still missing it is drawn, scaled, from the most recently used other tier
// that has all of its tiles in view (on a zoom in, the tier just left), and only when none has does the caller paint the patch live.
// Returns "live" when the caller must paint the patch, "tier" when it drew it from its own tier, "stand-in" when from another one.
function drawBaked(ctx: CanvasRenderingContext2D, store: Baked, ts: TierStore, patch: Patch, view: View, left: { n: number }, budget: BuildBudget): "live" | "tier" | "stand-in" {
  let wanted = tilesIn(store, ts, patch, view, left, budget);
  const own = wanted !== null;
  if (!wanted) for (const other of [...store.tiers.values()].reverse()) if (other !== ts && (wanted = tilesIn(store, other, patch, view, null, budget))) break;
  if (!wanted) return "live";
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
  return own ? "tier" : "stand-in";
}

const patchesIn = (t: Terrain, tier: number | undefined, scale: number, view: View): Patch[] =>
  patchesOf(t, (tier ?? scale) >= FINE_FROM ? fineOf(t) : 1).filter(({ body: b }) => b.x1 + VIEW_PAD >= view.x0 && b.x0 - VIEW_PAD <= view.x1 && b.y1 + VIEW_PAD >= view.y0 && b.y0 - VIEW_PAD <= view.y1);

// With the frame's bake unused, makes the bitmaps of the next coarser tier for a view twice as wide, so a zoom out finds them ready. Never when a bitmap might push a tier out.
function bakeCoarser(t: Terrain, store: Baked, tier: number, view: View, left: { n: number }, budget: BuildBudget): void {
  const coarser = TIERS[TIERS.indexOf(tier) - 1];
  if (coarser === undefined || left.n <= 0 || store.pixels + MAX_BITMAP_PX * MAX_BITMAP_PX > MAX_BAKED_PX) return;
  const ts = store.tiers.get(coarser) ?? { tier: coarser, grids: new Map(), pixels: 0 };
  store.tiers.set(coarser, ts);
  const w = (view.x1 - view.x0) / 2;
  const h = (view.y1 - view.y0) / 2;
  const wide = { x0: view.x0 - w, x1: view.x1 + w, y0: view.y0 - h, y1: view.y1 + h };
  for (const patch of patchesIn(t, coarser, coarser, wide)) if (left.n > 0 && !budget.refused) tilesIn(store, ts, patch, wide, left, budget);
}

// Makes the bitmaps of the tier a view at this scale draws from that are still missing, without drawing, a couple per call. True when none is waiting for a later call.
export function prepareGround(t: Terrain, scale: number, view: View): boolean {
  if (t.ground === null || typeof Path2D === "undefined") return true;
  const tier = TIERS.find((s) => s >= scale);
  const budget = buildBudget(SHELF_BUILD_CELLS);
  if (tier === undefined) {
    for (const patch of patchesIn(t, tier, scale, view)) shelfOf(patch, budget); // close up only the shelves are made ahead
    return !budget.refused;
  }
  const store = baked.get(t);
  if (!store) return true;
  const ts = touch(store, tier);
  const left = { n: PREPARE_BAKES };
  for (const patch of patchesIn(t, tier, scale, view)) if (left.n > 0) tilesIn(store, ts, patch, view, left, budget);
  return left.n > 0 && !budget.refused; // a call that used up its bakes or shelves may have left more; one that did not has done them all, or the pixel budget refused the rest
}

// quick: the coarse outline with flat fills, for the settings preview that redraws while sliders move. False while a patch is drawn from another tier for want of its own bitmaps
// (draw again, or prepareGround), so a cache does not keep the stand-in.
export function drawGround(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View, quick: boolean): boolean {
  if (t.ground === null || typeof Path2D === "undefined") return true;
  const tier = quick ? undefined : TIERS.find((s) => s >= scale);
  const shown = patchesIn(t, tier, quick ? 0 : scale, view);
  let complete = true;
  const budget = buildBudget(SHELF_BUILD_CELLS);
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
    for (const patch of shown) paintPatch(ctx, patch, scale, budget); // close up: live, only what is in view
  } else {
    let store = baked.get(t);
    if (!store) baked.set(t, (store = { tiers: new Map(), pixels: 0 }));
    const ts = touch(store, tier);
    const left = { n: BAKES_PER_FRAME };
    let standIn = false;
    for (const patch of shown) {
      const how = drawBaked(ctx, store, ts, patch, view, left, budget);
      if (how === "live") paintPatch(ctx, patch, scale, budget);
      else if (how === "stand-in") standIn = true;
    }
    complete = !standIn || left.n > 0; // a stand-in with bakes to spare means the budget refused the tier: nothing more will come
    bakeCoarser(t, store, tier, view, left, budget);
    touch(store, tier); // the coarser tier is the older one
  }
  ctx.restore();
  return complete && !budget.refused;
}
