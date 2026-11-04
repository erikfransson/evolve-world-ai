import type { Terrain } from "../sim/terrain.ts";
import { buildBudget, spend } from "./canvas.ts";
import type { BuildBudget } from "./canvas.ts";
import { boxBlur, distance, fillLoops } from "./edt.ts";
import { canvasOfPixels, fbm, ROCK_TILE_UNITS, rockPitTile, smooth, valueNoise } from "./noiseTex.ts";
import { SILT_SHADOW } from "./palette.ts";
import { rockBodies, traceLoop } from "./rockOutline.ts";
import type { RockBody } from "./rockOutline.ts";
import type { View } from "./terrainScene.ts";

// Rock of the abyssal look: basalt lumps and ridges sitting in the silt. Each body (a connected lump of rock discs) gets a small shaded image,
// a pixel per CELL world units: a height profile made from the distance to its edge (rounded at the foot, a gentle crest along the
// middle), lit softly from above left, darkened where it meets the silt, mottled, with a cool rim light on lit edges and sparse soft pale encrustations in its lee.
// The image is drawn clipped to the exact outline, so the edge is where creatures bounce (the outline strays from the disc union by about a unit and its corners are rounded
// over CORNER units: under 3 in all). Over it goes a tiled texture of pits with lit lips, from about a third zoom up,
// and under it a soft dark halo of silt. Images are made when first in view, per resolution level, at most BUILD_CELLS pixels of them a draw (a body still waiting
// draws from its image at another resolution, or flat), and kept within a budget.

const CORNER = 5; // world units a corner is rounded over, on each side
const CELLS = [3, 6, 12, 24, 48]; // image resolutions, world units per pixel; the coarsest one with at most PX_PER_CELL screen px per pixel is used
const PX_PER_CELL = 4;
const MIN_PX_ACROSS = 14; // pixels across the narrower side of a body's box, at least
const MAX_CELLS = 700_000; // pixels of one body's image, beyond that the next coarser resolution is used
const BUDGET_CELLS = 8_000_000; // pixels of images kept over all bodies (32 MB), the least recently used go first
const BUILD_CELLS = 120_000; // pixels of images one draw or prepare builds at most (always one image)
const BASE: readonly number[] = [80, 90, 91]; // basalt albedo
const RIM: readonly number[] = [52, 70, 74]; // cool rim light added on lit edges
const CRUST: readonly number[] = [176, 182, 166];
const LIGHT = { x: -0.55, y: -0.7, z: 0.5 }; // towards the light: above, and a little from the upper left
const HALO = { near: 0.8, near_s: 5, far_a: 0.55, far: 24, shift: 9 }; // alpha and decay length (world units) of the tight and the wide falloff; a stone's own, a massif's up to 3 times; lower by shift
const HALO_REACH = 3.2 * HALO.far; // world units the halo reaches past the edge, times the body size
const MAX_SIZE = 3; // largest body size (Item.size)
const VIEW_PAD = MAX_SIZE * (HALO_REACH + HALO.shift); // world units past the view that a body's halo can reach in from
const EDGE_LINE = "rgba(3, 11, 14, 0.6)";
const EDGE_PX = 1.1; // screen px of the dark edge line (world units: scaled by 1 / scale)
const PITS_FROM = 0.35; // scale (device px per world unit) from which the pit tile is drawn, full from PITS_FROM + 0.45
const FLAT_BODY = "#2f3f43"; // quick drawing

type Canvas = OffscreenCanvas | HTMLCanvasElement;

interface Raster {
  image: Canvas;
  ox: number;
  oy: number;
  w: number;
  h: number;
  cell: number;
}

interface Item {
  id: number;
  body: RockBody;
  readonly outline: Path2D;
  readonly size: number; // 1 for a stone, up to 3 for a massif: scales the halo
}

let nextId = 0;
const items = new WeakMap<Terrain, Item[]>();

function itemsOf(t: Terrain): Item[] {
  let list = items.get(t);
  if (!list) {
    list = rockBodies(t).map((body) => {
      let outline: Path2D | null = null;
      const span = Math.min(body.x1 - body.x0, body.y1 - body.y0);
      return {
        id: nextId++,
        body,
        get outline() {
          if (!outline) {
            outline = new Path2D();
            for (const loop of body.loops) traceLoop(outline, loop, CORNER);
          }
          return outline;
        },
        size: Math.min(MAX_SIZE, Math.max(1, span / 300)),
      };
    });
    items.set(t, list);
  }
  return list;
}

const hash2 = (x: number, y: number, seed: number): number => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed + 1, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// ---- The shaded image of one body ----

// What the image builders read of a body: plain data, so a worker can build them too (rockFarm.ts).
export interface RockJob {
  id: number;
  size: number;
  body: { x0: number; y0: number; x1: number; y1: number; loops: number[][] };
}
export interface RockPixels {
  px: Uint8ClampedArray<ArrayBuffer>;
  ox: number;
  oy: number;
  w: number;
  h: number;
  cell: number;
}
const toRaster = (p: RockPixels): Raster | null => {
  const image = canvasOfPixels(p.w, p.h, p.px);
  return image ? { image, ox: p.ox, oy: p.oy, w: p.w, h: p.h, cell: p.cell } : null;
};

export function rasterPixels(item: RockJob, cell: number): RockPixels {
  const b = item.body;
  const ox = Math.floor(b.x0 / cell) * cell - 2 * cell;
  const oy = Math.floor(b.y0 / cell) * cell - 2 * cell;
  const w = Math.ceil((b.x1 - ox) / cell) + 3;
  const h = Math.ceil((b.y1 - oy) / cell) + 3;
  const n = w * h;
  const inside = fillLoops(b.loops, ox, oy, cell, w, h);
  const dist = distance(inside, w, h);
  // distance to the edge in world units, smoothed a little so the height has no staircase
  const d = new Float32Array(n);
  let dmax = 0;
  for (let k = 0; k < n; k++) {
    if (inside[k]) d[k] = Math.max(0, dist[k]! - 0.5) * cell;
    if (d[k]! > dmax) dmax = d[k]!;
  }
  const at = (a: Float32Array, x: number, y: number): number => a[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
  // the broader the body, the softer its profile, so no creases show along its middle; at least 2 px, or the pixel steps of a small stone show as ribs
  boxBlur(d, w, h, Math.max(2, Math.round(Math.min(40, Math.max(6, 0.1 * dmax)) / (2.2 * cell))));
  dmax = 0;
  for (let k = 0; k < n; k++) if (d[k]! > dmax) dmax = d[k]!;
  const wd = Math.min(70, Math.max(8, 0.45 * dmax)); // how wide the rounded foot is
  const crest = 0.12 * smooth(40, 180, dmax); // slope of the gentle rise towards the middle of a big body
  const height = new Float32Array(n);
  for (let k = 0; k < n; k++) height[k] = 0.7 * wd * (1 - Math.exp(-d[k]! / wd)) + crest * d[k]!;
  // crisp relief in the height: sharp-crested ridges (strata and cracks) at two scales, the finer only where the pixels are small enough to hold it
  const ridged = (x: number, y: number, lam: number, seed: number): number => {
    const v = 1 - Math.abs(fbm(x / lam, y / lam, seed, 2));
    return v * v;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!inside[k]) continue;
      const wx = ox + (x + 0.5) * cell;
      const wy = oy + (y + 0.5) * cell;
      let v = cell <= 6 ? 3 * ridged(wx, wy, 64, 59) + 1.1 * ridged(wx, wy, 21, 61) : 4 * fbm(wx / 80, wy / 80, 59, 3);
      height[k] += v * smooth(0, 10, d[k]!);
    }
  }
  const ao = 14 + 6 * item.size; // units over which the silt shadow at the foot fades out
  const norm = Math.hypot(LIGHT.x, LIGHT.y, LIGHT.z);
  const lx = LIGHT.x / norm;
  const ly = LIGHT.y / norm;
  const lz = LIGHT.z / norm;
  const px = new Uint8ClampedArray(4 * n);
  const reach = 0.7 * dmax + 10;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const hx = (at(height, x + 1, y) - at(height, x - 1, y)) / (2 * cell);
      const hy = (at(height, x, y + 1) - at(height, x, y - 1)) / (2 * cell);
      const nl = (-hx * lx - hy * ly + lz) / Math.sqrt(hx * hx + hy * hy + 1);
      const dd = d[k]!;
      const rise = 1 - Math.exp(-dd / reach);
      const lum = (0.34 + 1.15 * nl) * (0.74 + 0.5 * rise) * (0.5 + 0.5 * smooth(0, ao, dd));
      const wx = ox + (x + 0.5) * cell;
      const wy = oy + (y + 0.5) * cell;
      const m1 = fbm(wx / 170, wy / 170, 41, 3);
      const m2 = valueNoise(wx / 38, wy / 38, 43) - 0.5;
      const m3 = fbm(wx / 520, wy / 520, 47, 2);
      let r = (BASE[0]! + 7 * m3) * (1 + 0.05 * m1 + 0.08 * m2);
      let g = (BASE[1]! - 1 * m3) * (1 + 0.05 * m1 + 0.08 * m2);
      let bl = (BASE[2]! - 7 * m3) * (1 + 0.05 * m1 + 0.08 * m2);
      const grain = 1 + 0.09 * (hash2(x, y, item.id) - 0.5) * 2 * smooth(0, 5, dd); // stone grain a cell across, which stays visible when the image is enlarged
      r *= lum * grain;
      g *= lum * grain;
      bl *= lum * grain;
      // a cool rim light along the edges that face the light
      const rim = (1 - smooth(1, 6, dd)) * smooth(0.6, 1.0, nl) * (inside[k] ? 1 : 0);
      r += rim * RIM[0]!;
      g += rim * RIM[1]!;
      bl += rim * RIM[2]!;
      // pale encrustation: sparse soft clusters in the lee of the body (the side away from the light), granular within
      const lee = 1 - smooth(0.3, 0.8, nl);
      const e = dd < 40 && dd > 1 && inside[k] ? smooth(0.64, 0.8, valueNoise(wx / 44, wy / 44, 51)) * lee * (1 - smooth(5, 40, dd)) * (0.55 + 0.45 * valueNoise(wx / 5, wy / 5, 55)) : 0;
      if (e > 0) {
        const f = 0.55 * e;
        const shade = 0.5 + 0.5 * Math.min(1.1, lum);
        r += (CRUST[0]! * shade - r) * f;
        g += (CRUST[1]! * shade - g) * f;
        bl += (CRUST[2]! * shade - bl) * f;
      }
      px[4 * k] = r;
      px[4 * k + 1] = g;
      px[4 * k + 2] = bl;
      px[4 * k + 3] = 255;
    }
  }
  return { px, ox, oy, w, h, cell };
}

// The silt shadow around a body as an alpha-only image (a pixel per cell, margin around the box), from the distance outside the edge: a tight dark falloff and a wide faint one,
// lying a little lower than the body.
export function haloPixels(item: RockJob, cell: number): RockPixels {
  const b = item.body;
  const reach = HALO_REACH * item.size;
  const m = haloMargin(item, cell);
  const ox = Math.floor(b.x0 / cell) * cell - m * cell;
  const oy = Math.floor(b.y0 / cell) * cell - m * cell;
  const w = Math.ceil((b.x1 - ox) / cell) + m + 1;
  const h = Math.ceil((b.y1 - oy) / cell) + m + 1;
  const n = w * h;
  const outside = fillLoops(b.loops, ox, oy, cell, w, h); // the distance transform runs from the pixels that are not "inside" it, so the body is the outside
  for (let k = 0; k < n; k++) outside[k] = outside[k] ? 0 : 1;
  const dist = distance(outside, w, h);
  const px = new Uint8ClampedArray(4 * n);
  const down = Math.round((HALO.shift * item.size) / cell);
  const [r, g, bl] = SILT_SHADOW;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.max(0, dist[Math.max(0, y - down) * w + x]! - 0.5) * cell;
      const f = item.size;
      const a = Math.min(0.85, HALO.near * Math.exp(-d / (HALO.near_s * f)) + HALO.far_a * Math.exp(-d / (HALO.far * f))) * (1 - smooth(0.7 * reach, reach, d));
      const k = 4 * (y * w + x);
      px[k] = r;
      px[k + 1] = g;
      px[k + 2] = bl;
      px[k + 3] = 255 * a;
    }
  }
  return { px, ox, oy, w, h, cell };
}

const haloMargin = (item: RockJob, cell: number): number => Math.ceil((HALO_REACH * item.size) / cell) + 2;
const keyOf = (item: { id: number }, cell: number, halo: boolean): string => `${item.id}:${cell}${halo ? "h" : ""}`;

// Module-wide, not per map: the images of a map left behind stay until newer ones push them out of BUDGET_CELLS.
const rasters = new Map<string, Raster | null>(); // least recently used first
let rasterCells = 0;

// The image of a body (or its halo) at a resolution, built now if budget allows; undefined when it was put off.
function rasterOf(item: Item, cell: number, halo: boolean, budget: BuildBudget): Raster | null | undefined {
  const key = keyOf(item, cell, halo);
  let r = rasters.get(key);
  if (r !== undefined) {
    rasters.delete(key);
    rasters.set(key, r);
    return r;
  }
  if (farm) {
    // Built on a worker: asked for once, a stand-in meanwhile (the draw is unfinished until it is here).
    if (!waiting.has(key)) {
      waiting.add(key);
      const f = farm;
      const job: RockJob = { id: item.id, size: item.size, body: { x0: item.body.x0, y0: item.body.y0, x1: item.body.x1, y1: item.body.y1, loops: item.body.loops } };
      f.build(job, cell, halo).then(
        (p) => {
          waiting.delete(key);
          if (!rasters.has(key)) keep(key, p ? toRaster(p) : null);
        },
        () => {
          waiting.delete(key);
          if (farm === f) farm = null; // a broken worker: build on this thread from now on
        },
      );
    }
    budget.refused = true;
    return undefined;
  }
  const b = item.body;
  const m = halo ? 2 * haloMargin(item, cell) + 2 : 6; // px past the box, as the build makes them
  if (!spend(budget, ((b.x1 - b.x0) / cell + m) * ((b.y1 - b.y0) / cell + m))) return undefined;
  r = halo ? toRaster(haloPixels(item, cell)) : toRaster(rasterPixels(item, cell));
  keep(key, r);
  return r;
}

function keep(key: string, r: Raster | null): void {
  rasters.set(key, r);
  if (r) {
    rasterCells += r.w * r.h;
    for (const [k, old] of rasters) {
      if (rasterCells <= BUDGET_CELLS || k === key) break;
      rasters.delete(k);
      if (old) rasterCells -= old.w * old.h;
    }
  }
}

// Builds body images elsewhere (rockFarm.ts): resolves to the pixels rasterPixels or haloPixels would make here.
export interface RockFarm {
  build(job: RockJob, cell: number, halo: boolean): Promise<RockPixels | null>;
}
let farm: RockFarm | null = null;
const waiting = new Set<string>(); // keys asked of the farm and not back yet

// Makes this thread hand its rock images to a farm of workers (null: build them here, the default), so a first view or a zoom does not stall the page.
export function useRockFarm(f: RockFarm | null): void {
  farm = f;
}

// With a farm, asks it now for the images of every body at a scale (a view of the whole map), so they are on their way before the first draw needs them.
export function warmRock(t: Terrain, scale: number): void {
  if (farm) prepareRock(t, scale, { x0: 0, x1: t.width, y0: 0, y1: t.height });
}

// Runs draw with rock images built on this thread, for pictures drawn once that cannot wait for a worker (the legend swatches).
export function withRockHere<T>(draw: () => T): T {
  const f = farm;
  farm = null;
  try {
    return draw();
  } finally {
    if (farm === null) farm = f;
  }
}

// While its own is put off: the body's image at the nearest other resolution that is built, else null.
function standIn(item: Item, cell: number, halo: boolean): Raster | null {
  let best: Raster | null = null;
  for (let c = CELLS[0]!; c <= 64 * CELLS[CELLS.length - 1]!; c *= 2) {
    const r = c === cell ? undefined : rasters.get(keyOf(item, c, halo));
    if (r && (!best || Math.abs(Math.log(c / cell)) < Math.abs(Math.log(best.cell / cell)))) best = r;
  }
  return best;
}

// The resolution for a scale: the coarsest with at most PX_PER_CELL screen px per pixel, coarser still while the body would be too many pixels.
function cellFor(scale: number, body: RockBody): number {
  const fine = Math.min(body.x1 - body.x0, body.y1 - body.y0) / MIN_PX_ACROSS; // a small stone keeps a fine image whatever the scale, or its profile turns to wedges
  let cell = CELLS[0]!;
  for (const c of CELLS) if (c * scale <= PX_PER_CELL && c <= fine) cell = c;
  while (((body.x1 - body.x0) / cell + 6) * ((body.y1 - body.y0) / cell + 6) > MAX_CELLS) cell *= 2;
  return cell;
}

// ---- Patterns ----

const pitPatterns = new WeakMap<CanvasRenderingContext2D, CanvasPattern | null>();
let pitTile: Canvas | null | undefined;

function pitPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  let p = pitPatterns.get(ctx);
  if (p === undefined) {
    if (pitTile === undefined) pitTile = rockPitTile();
    p = pitTile ? ctx.createPattern(pitTile as CanvasImageSource, "repeat") : null;
    p?.setTransform(new DOMMatrix().scale(ROCK_TILE_UNITS / pitTile!.width));
    pitPatterns.set(ctx, p);
  }
  return p;
}

const shownIn = (t: Terrain, view: View): Item[] =>
  itemsOf(t).filter(({ body: b }) => b.x1 + VIEW_PAD >= view.x0 && b.x0 - VIEW_PAD <= view.x1 && b.y1 + VIEW_PAD >= view.y0 && b.y0 - VIEW_PAD <= view.y1);

// The images of the bodies in view at this scale, bodies before halos, built while budget allows.
function imagesFor(shown: Item[], scale: number, budget: BuildBudget): { body: (Raster | null | undefined)[]; halo: (Raster | null | undefined)[] } {
  const body = shown.map((item) => rasterOf(item, cellFor(scale, item.body), false, budget));
  const halo = shown.map((item) => rasterOf(item, Math.max(6, cellFor(scale, item.body)), true, budget));
  return { body, halo };
}

// Builds the images drawRock at this scale and view still waits for, without drawing, a frame's budget per call. True when none is waiting.
export function prepareRock(t: Terrain, scale: number, view: View): boolean {
  if (t.rockCount === 0 || typeof Path2D === "undefined") return true;
  const budget = buildBudget(BUILD_CELLS);
  imagesFor(shownIn(t, view), scale, budget);
  return !budget.refused;
}

// quick: from-afar drawing without images, for the settings preview that redraws while sliders move. False while some image was put off
// and a stand-in drew in its place (draw again, or prepareRock).
export function drawRock(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View, quick: boolean): boolean {
  if (t.rockCount === 0) return true;
  if (typeof Path2D === "undefined") {
    // no outlines without Path2D (workers in old browsers, tests): plain discs
    ctx.fillStyle = FLAT_BODY;
    ctx.beginPath();
    for (let i = 0; i < t.rockCount; i++) {
      ctx.moveTo(t.rockX[i]! + t.rockR[i]!, t.rockY[i]!);
      ctx.arc(t.rockX[i]!, t.rockY[i]!, t.rockR[i]!, 0, 2 * Math.PI);
    }
    ctx.fill();
    return true;
  }
  const px = 1 / scale;
  const shown = shownIn(t, view);
  if (quick) {
    ctx.fillStyle = FLAT_BODY;
    for (const { outline } of shown) ctx.fill(outline, "evenodd");
    return true;
  }
  const budget = buildBudget(BUILD_CELLS);
  const images = imagesFor(shown, scale, budget);
  ctx.lineJoin = "round";
  const smoothing = ctx.imageSmoothingEnabled;
  const quality = ctx.imageSmoothingQuality;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "low"; // images are smooth and drawn enlarged; "high" only where an image is shrunk (below)
  // Halos first, so a body never lies under the shadow of a neighbour.
  shown.forEach((item, i) => {
    const hr = images.halo[i] === undefined ? standIn(item, Math.max(6, cellFor(scale, item.body)), true) : images.halo[i];
    if (hr) ctx.drawImage(hr.image as CanvasImageSource, 0, 0, hr.w, hr.h, hr.ox, hr.oy, hr.w * hr.cell, hr.h * hr.cell);
  });
  const pitAlpha = smooth(PITS_FROM, PITS_FROM + 0.45, scale);
  const pits = pitAlpha > 0 ? pitPattern(ctx) : null;
  shown.forEach((item, i) => {
    const { outline, body } = item;
    const r = images.body[i] === undefined ? standIn(item, cellFor(scale, body), false) : images.body[i];
    ctx.save();
    ctx.clip(outline, "evenodd");
    ctx.imageSmoothingQuality = r && r.cell * scale < 1 ? "high" : "low";
    if (r) ctx.drawImage(r.image as CanvasImageSource, 0, 0, r.w, r.h, r.ox, r.oy, r.w * r.cell, r.h * r.cell);
    else {
      ctx.fillStyle = FLAT_BODY;
      ctx.fill(outline, "evenodd");
    }
    if (pits) {
      ctx.globalAlpha = pitAlpha;
      ctx.fillStyle = pits;
      ctx.fill(outline, "evenodd");
    }
    ctx.globalAlpha = 1; // a thin dark line just inside the edge, so the outline stays defined whatever the zoom
    ctx.strokeStyle = EDGE_LINE;
    ctx.lineWidth = 2 * Math.max(EDGE_PX * px, 0.8);
    ctx.stroke(outline);
    ctx.restore();
  });
  ctx.imageSmoothingEnabled = smoothing;
  ctx.imageSmoothingQuality = quality;
  ctx.globalAlpha = 1;
  ctx.lineJoin = "miter";
  return !budget.refused;
}
