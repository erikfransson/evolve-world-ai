import type { Terrain } from "../sim/terrain.ts";
import { makeCanvas } from "./canvas.ts";
import { distance } from "./edt.ts";
import { canvasOfPixels, fbm, ROCK_TILE_UNITS, rockCrustTile, rockPitTile, smooth, valueNoise } from "./noiseTex.ts";
import { rockBodies, traceLoop } from "./rockOutline.ts";
import type { RockBody } from "./rockOutline.ts";
import type { View } from "./terrainScene.ts";

// Rock of the abyssal look: basalt lumps and ridges sitting in the silt. Each body (a connected lump of rock discs) gets a small shaded image,
// a pixel per CELL world units: a height profile made from the distance to its edge (rounded at the foot, a gentle crest along the
// middle), lit softly from above left, darkened where it meets the silt, mottled and with pale encrusting patches along its edge.
// The image is drawn clipped to the exact outline, so the edge is where creatures bounce (the outline strays from the disc union by about a unit and its corners are rounded
// over CORNER units: under 3 in all). Over it go a tiled pit texture and a speckle of pale crust close to the edge, from about half zoom up,
// and under it a soft dark halo of silt. No outline stroke. Images are made when first in view, per resolution level, and kept within a budget.

const CORNER = 5; // world units a corner is rounded over, on each side
const CELLS = [3, 6, 12, 24, 48]; // image resolutions, world units per pixel; the coarsest one with at most PX_PER_CELL screen px per pixel is used
const PX_PER_CELL = 4;
const MIN_PX_ACROSS = 24; // pixels across the narrower side of a body's box, at least
const MAX_CELLS = 700_000; // pixels of one body's image, beyond that the next coarser resolution is used
const BUDGET_CELLS = 8_000_000; // pixels of images kept over all bodies (32 MB), the least recently used go first
const BASE: readonly number[] = [52, 68, 73]; // basalt albedo
const CRUST: readonly number[] = [184, 194, 178];
const LIGHT = { x: -0.55, y: -0.7, z: 0.5 }; // towards the light: above, and a little from the upper left
const HALO_RGB = [2, 9, 12] as const;
const HALO = { near: 0.55, near_s: 4, far_a: 0.4, far: 22, shift: 6 }; // alpha and decay length (world units) of the tight and the wide falloff; a stone's own, a massif's up to 3 times; lower by shift
const PITS_FROM = 0.35; // scale (device px per world unit) from which the pit tile is drawn, full from PITS_FROM + 0.45
const CRUST_FROM = 0.45;
const CRUST_BANDS = [{ width: 5, alpha: 0.55 }, { width: 11, alpha: 0.3 }] as const; // world units inwards from the edge
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
        size: Math.min(3, Math.max(1, span / 300)),
      };
    });
    items.set(t, list);
  }
  return list;
}

// Three passes of a box blur of radius r pixels along each axis, edges clamped: close to a gaussian of sigma about 1.1 r.
function boxBlur(a: Float32Array, w: number, h: number, r: number): void {
  if (r < 1) return;
  const line = new Float32Array(Math.max(w, h) + 2 * r + 1);
  const pass = (n: number, stride: number, count: number, step: number): void => {
    for (let c = 0; c < count; c++) {
      const base = c * step;
      for (let i = 0; i < n; i++) line[i + r] = a[base + i * stride]!;
      for (let i = 0; i < r; i++) {
        line[i] = a[base]!;
        line[n + r + i] = a[base + (n - 1) * stride]!;
      }
      let sum = 0;
      for (let i = 0; i <= 2 * r; i++) sum += line[i]!;
      for (let i = 0; i < n; i++) {
        a[base + i * stride] = sum / (2 * r + 1);
        sum += line[i + 2 * r + 1]! - line[i]!;
      }
    }
  };
  for (let k = 0; k < 3; k++) {
    pass(w, 1, h, w);
    pass(h, w, w, 1);
  }
}

// ---- The shaded image of one body ----

function buildRaster(item: Item, cell: number): Raster | null {
  const b = item.body;
  const ox = Math.floor(b.x0 / cell) * cell - 2 * cell;
  const oy = Math.floor(b.y0 / cell) * cell - 2 * cell;
  const w = Math.ceil((b.x1 - ox) / cell) + 3;
  const h = Math.ceil((b.y1 - oy) / cell) + 3;
  const mask = makeCanvas(w, h);
  const mg = mask?.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  if (!mask || !mg || typeof Path2D === "undefined") return null;
  mg.setTransform(1 / cell, 0, 0, 1 / cell, -ox / cell, -oy / cell);
  mg.fillStyle = "#fff";
  mg.fill(item.outline, "evenodd");
  const alpha = mg.getImageData(0, 0, w, h).data;
  const n = w * h;
  const inside = new Uint8Array(n);
  for (let k = 0; k < n; k++) inside[k] = alpha[4 * k + 3]! >= 128 ? 1 : 0;
  const dist = distance(inside, w, h);
  // distance to the edge in world units, smoothed a little so the height has no staircase
  const d0 = new Float32Array(n);
  let dmax = 0;
  for (let k = 0; k < n; k++) if (inside[k]) d0[k] = Math.max(0, dist[k]! - 0.5) * cell;
  const d = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    d[k] = d0[k]!;
    if (d0[k]! > dmax) dmax = d0[k]!;
  }
  const at = (a: Float32Array, x: number, y: number): number => a[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
  boxBlur(d, w, h, Math.max(2, Math.round(Math.min(40, Math.max(6, 0.1 * dmax)) / (2.2 * cell)))); // at least 2 px, or the pixel steps of a small stone show as ribs // the broader the body, the softer its profile, so no creases show along its middle
  dmax = 0;
  for (let k = 0; k < n; k++) if (d[k]! > dmax) dmax = d[k]!;
  const wd = Math.min(70, Math.max(8, 0.45 * dmax)); // how wide the rounded foot is
  const crest = 0.26 * smooth(40, 180, dmax); // slope of the gentle rise towards the middle of a big body
  const height = new Float32Array(n);
  for (let k = 0; k < n; k++) height[k] = 0.7 * wd * (1 - Math.exp(-d[k]! / wd)) + crest * d[k]!;
  // a rough grain in the height, so big smooth bodies still catch the light in small patches (a wavelength of at least four pixels)
  const lam = Math.max(26, 4 * cell);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!inside[k]) continue;
      const wx = ox + (x + 0.5) * cell;
      const wy = oy + (y + 0.5) * cell;
      height[k] += (0.9 * lam / 26) * fbm(wx / lam, wy / lam, 59, 3) * smooth(0, 12, d[k]!);
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
      const lum = (0.3 + 1.0 * nl) * (0.7 + 0.62 * rise) * (0.66 + 0.34 * smooth(0, ao, dd));
      const wx = ox + (x + 0.5) * cell;
      const wy = oy + (y + 0.5) * cell;
      const m1 = fbm(wx / 170, wy / 170, 41, 3);
      const m2 = valueNoise(wx / 38, wy / 38, 43) - 0.5;
      const m3 = fbm(wx / 520, wy / 520, 47, 2);
      let r = (BASE[0]! + 7 * m3) * (1 + 0.05 * m1 + 0.08 * m2);
      let g = (BASE[1]! - 1 * m3) * (1 + 0.05 * m1 + 0.08 * m2);
      let bl = (BASE[2]! - 7 * m3) * (1 + 0.05 * m1 + 0.08 * m2);
      r *= lum;
      g *= lum;
      bl *= lum;
      // pale encrusting patches, only close to the edge and only where a second noise lets them
      const e = smooth(0.52, 0.72, valueNoise(wx / 24, wy / 24, 51)) * smooth(0.35, 0.62, 0.5 + 0.5 * fbm(wx / 260, wy / 260, 53, 2)) * (1 - smooth(2, 26, dd)) * (inside[k] ? 1 : 0);
      if (e > 0) {
        const f = 0.62 * e;
        const shade = 0.55 + 0.45 * Math.min(1.15, lum);
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
  const image = canvasOfPixels(w, h, px);
  return image ? { image, ox, oy, w, h, cell } : null;
}

// The silt shadow around a body as an alpha-only image (a pixel per cell, margin around the box), from the distance outside the edge: a tight dark falloff and a wide faint one,
// lying a little lower than the body.
function buildHalo(item: Item, cell: number): Raster | null {
  const b = item.body;
  const reach = HALO.far * 3.2 * item.size;
  const m = Math.ceil(reach / cell) + 2;
  const ox = Math.floor(b.x0 / cell) * cell - m * cell;
  const oy = Math.floor(b.y0 / cell) * cell - m * cell;
  const w = Math.ceil((b.x1 - ox) / cell) + m + 1;
  const h = Math.ceil((b.y1 - oy) / cell) + m + 1;
  const mask = makeCanvas(w, h);
  const mg = mask?.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  if (!mask || !mg || typeof Path2D === "undefined") return null;
  mg.setTransform(1 / cell, 0, 0, 1 / cell, -ox / cell, -oy / cell);
  mg.fillStyle = "#fff";
  mg.fill(item.outline, "evenodd");
  const alpha = mg.getImageData(0, 0, w, h).data;
  const n = w * h;
  const outside = new Uint8Array(n); // the distance transform runs from the pixels that are not "inside" it, so hand it the body as the outside
  for (let k = 0; k < n; k++) outside[k] = alpha[4 * k + 3]! >= 128 ? 0 : 1;
  const dist = distance(outside, w, h);
  const px = new Uint8ClampedArray(4 * n);
  const down = Math.round((HALO.shift * item.size) / cell);
  const [r, g, bl] = HALO_RGB;
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
  const image = canvasOfPixels(w, h, px);
  return image ? { image, ox, oy, w, h, cell } : null;
}

const rasters = new Map<string, Raster | null>(); // least recently used first
let rasterCells = 0;

function rasterOf(item: Item, cell: number, halo = false): Raster | null {
  const key = `${item.id}:${cell}${halo ? "h" : ""}`;
  let r = rasters.get(key);
  if (r !== undefined) {
    rasters.delete(key);
    rasters.set(key, r);
    return r;
  }
  r = halo ? buildHalo(item, cell) : buildRaster(item, cell);
  rasters.set(key, r);
  if (r) {
    rasterCells += r.w * r.h;
    for (const [k, old] of rasters) {
      if (rasterCells <= BUDGET_CELLS || k === key) break;
      rasters.delete(k);
      if (old) rasterCells -= old.w * old.h;
    }
  }
  return r;
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

const patterns = new WeakMap<CanvasRenderingContext2D, { pits: CanvasPattern | null; crust: CanvasPattern | null }>();
let pitTile: Canvas | null | undefined;
let crustTile: Canvas | null | undefined;

function patternsOf(ctx: CanvasRenderingContext2D) {
  let p = patterns.get(ctx);
  if (!p) {
    if (pitTile === undefined) pitTile = rockPitTile();
    if (crustTile === undefined) crustTile = rockCrustTile();
    const make = (tile: Canvas | null): CanvasPattern | null => {
      const pattern = tile ? ctx.createPattern(tile as CanvasImageSource, "repeat") : null;
      pattern?.setTransform(new DOMMatrix().scale(ROCK_TILE_UNITS / 512));
      return pattern;
    };
    patterns.set(ctx, (p = { pits: make(pitTile), crust: make(crustTile) }));
  }
  return p;
}

// quick: from-afar drawing without images, for the settings preview that redraws while sliders move.
export function drawRock(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View, quick: boolean): void {
  if (t.rockCount === 0) return;
  const px = 1 / scale;
  const pad = 220 + 4 * px; // the widest halo
  const shown = itemsOf(t).filter(({ body: b }) => b.x1 + pad >= view.x0 && b.x0 - pad <= view.x1 && b.y1 + pad >= view.y0 && b.y0 - pad <= view.y1);
  if (quick || typeof Path2D === "undefined") {
    ctx.fillStyle = FLAT_BODY;
    for (const { outline } of shown) ctx.fill(outline, "evenodd");
    return;
  }
  ctx.lineJoin = "round";
  const smoothing = ctx.imageSmoothingEnabled;
  const quality = ctx.imageSmoothingQuality;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // Halos first, so a body never lies under the shadow of a neighbour.
  for (const item of shown) {
    const hr = rasterOf(item, Math.max(6, cellFor(scale, item.body)), true);
    if (hr) ctx.drawImage(hr.image as CanvasImageSource, 0, 0, hr.w, hr.h, hr.ox, hr.oy, hr.w * hr.cell, hr.h * hr.cell);
  }
  const pitAlpha = smooth(PITS_FROM, PITS_FROM + 0.45, scale);
  const crustAlpha = smooth(CRUST_FROM, CRUST_FROM + 0.5, scale);
  const pats = pitAlpha > 0 ? patternsOf(ctx) : null;
  for (const item of shown) {
    const { outline, body } = item;
    const r = rasterOf(item, cellFor(scale, body));
    ctx.save();
    ctx.clip(outline, "evenodd");
    if (r) ctx.drawImage(r.image as CanvasImageSource, 0, 0, r.w, r.h, r.ox, r.oy, r.w * r.cell, r.h * r.cell);
    else {
      ctx.fillStyle = FLAT_BODY;
      ctx.fill(outline, "evenodd");
    }
    if (pats?.pits) {
      ctx.globalAlpha = pitAlpha;
      ctx.fillStyle = pats.pits;
      ctx.fill(outline, "evenodd");
    }
    if (pats?.crust && crustAlpha > 0) {
      ctx.strokeStyle = pats.crust;
      for (const { width, alpha } of CRUST_BANDS) {
        ctx.globalAlpha = crustAlpha * alpha;
        ctx.lineWidth = 2 * width;
        ctx.stroke(outline);
      }
    }
    ctx.restore();
  }
  ctx.imageSmoothingEnabled = smoothing;
  ctx.imageSmoothingQuality = quality;
  ctx.globalAlpha = 1;
  ctx.lineJoin = "miter";
}
