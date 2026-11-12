import { insidePolygon, marchingSquares, simplifyClosed } from "../../geom/contour.ts";
import { CUBIC_FADE, GROUND_PAD, GroundField, hash, oneKindPerNode, valueNoise as noise } from "../groundField.ts";
import { createRng } from "../rng.ts";
import { discsBlocked, MapWeights, WEIGHT_UNIT } from "./weights.ts";
import type { Disc } from "./weights.ts";
import { MAX_MAP_DISC_R, MAX_MAP_DISCS } from "./mapParts.ts";
import { ITEM_RADIUS_RANGE } from "../config.ts";

// Builds the ground, the food and poison weights and the rock of a hand-designed map (docs/world-maps/) from its spec. Port of the draft generator
// docs/world-maps/tools/gen.mjs, evaluated on the nodes of the ground raster. The result depends on the spec alone, so every thread builds the same map.
// A spec is code we ship, not visitor input, but its size is still bounded (LIMITS) and the build throws on a spec that breaks them.

type Pt = readonly [number, number];
type Shape = { type: "poly"; pts: readonly Pt[] } | { type: "path"; path: readonly Pt[]; w: readonly number[] };
// The shape of a patchy texture: soft blobs (fbm, the default), veins (a network of channels or cracks along warped cell borders) or plates (the cells between them).
type Pattern = "blobs" | "veins" | "plates";
interface Texture {
  coverage: number; // share of the layer that is mud or firm, 1 for all of it
  scale: number; // wavelength of the patchiness
  pattern?: Pattern; // default blobs
  keep?: number; // veins and plates: share of the cell borders that are veins or cracks, the rest heal over (default all)
  deep?: number; // mud only: distance over which the sea deepens (not used by the engine)
  inset?: number; // firm only: how far inside the layer's edge the firm ground starts
}
interface Outline {
  shape: Shape;
  warp?: number; // domain warp amplitude, edge roughness, and the width over which the layer's effect fades out
  rough?: number;
  feather?: number;
  band?: number; // keeps only a band of this half width around the outline
  wobble?: number; // path width variation, 0 to 1
  taper?: boolean; // path ends narrow
}
export interface MapLayer extends Outline {
  id: string;
  food?: number; // weights the layer blends towards, 1 is plain
  poison?: number;
  mud?: Texture;
  firm?: Texture;
  winter?: number; // winter ground: share of the food weight left at mid-winter, 0 to 1 (absent is 1, no extra winter); blends like food
  clearMud?: boolean; // removes mud under the layer (islands in a sea)
  edge?: number; // distance over which mud or firm fades in from the outline
  paint?: Paint; // a colour wash over the floor, for looks only (mapTint.ts draws it)
}
interface Paint {
  rgb: readonly [number, number, number];
  alpha: number;
  tex?: PaintTex;
  crack?: { scale: number; width: number; keep?: number }; // only a network of cracks: plate size, crack width (world units), share of plate edges cracked
  patch?: { scale: number; lo: number; hi: number }; // only where noise of this wavelength rises from lo to hi: broken, patchy paint
  fade?: number; // paths: the paint fades in over this share of the length at each end
}
// A second colour laid into a paint where a pattern is on: cover is the share of the layer it takes, stretch widens the pattern along x (streaks).
interface PaintTex {
  pattern?: Pattern;
  scale: number;
  cover: number;
  rgb: readonly [number, number, number];
  alpha: number;
  stretch?: number;
  soft?: number; // width of the pattern's edge, 0.1 is crisp, 0.5 a soft mottle
  keep?: number; // as Texture.keep
}
export interface MapRock extends Outline {
  id: string;
  kind: "outcrop" | "talus" | "massif";
  cover: number; // share of the area covered by stones (outcrop, talus); massifs cover their whole mask
  clump?: number; // wavelength of the clumping noise
  clumpLo?: number;
  clumpHi?: number;
  pow?: number;
  r?: readonly [number, number]; // stone radius range
  g?: number; // sampling grid
  passes?: readonly (readonly [number, number, number])[]; // x, y, radius of gaps cut into the massif
  onMud?: boolean;
  fadeX?: readonly [number, number];
}
export interface MapRegion {
  id: string;
  title: string;
  x: number;
  y: number;
  r: number;
  hue?: number; // degrees, the colour its seeded founder gets
}
export interface MapSpec {
  name: string;
  title: string;
  seed: number;
  width: number;
  height: number;
  scale: number; // the draft's coarse noise wavelengths (warp, path width, passes) are multiplied by this
  fineScale?: number; // the same for the edge roughness wavelengths, which are detail and stay when the map shrinks; default scale
  baseFood?: number;
  basePoison?: number;
  layers: readonly MapLayer[];
  rock: readonly MapRock[];
  regions?: readonly MapRegion[]; // named areas of the map (seeding homes, region table); not used by the builder
  look?: MapLook; // how the map is drawn, looks only; not used by the builder
  solidRock?: boolean; // stones keep SOLID_GAP clear of massifs, and ground an item could lie on but no creature reach is filled (fillUnreachable)
}
// A map's own drawing style; a map without it draws in the default abyssal style.
export interface MapLook {
  rock?: RockLook; // rock lit from one side with a cast shadow (ui/abyssRock.ts), instead of basalt with a dark halo and an edge line
}
export interface RockLook {
  stone?: "basalt" | "sandstone" | "granite"; // colour preset, default basalt
  rgb?: readonly [number, number, number]; // albedo, overrides the preset
  light?: number; // compass bearing the light comes from, degrees (0 north, 90 east, on screen), default 315: the north-west
  shadow?: number; // opacity of the cast shadow, default 0.5
  edge?: number; // opacity of a thin darker edge line, default 0.2, 0 for none
}

export interface BuiltMap {
  ground: GroundField;
  weights: MapWeights;
  rock: Disc[];
  stats: { rockDiscs: number; massifDiscs: number; stones: number; mud: number; firm: number; rockShare: number };
}

// Bump when a change here alters any built map: saves record it with the spec (mapVersion), and maps.test.ts pins the built data to catch a missed bump.
export const MAP_BUILD = 2; // 2: stones keep out of every rock layer's passes

const LIMITS = { layers: 128, points: 64, discs: MAX_MAP_DISCS, area: 2.5e9 }; // of a spec, and the world area it may cover

const valueNoise = (x: number, y: number, s: number): number => noise(x, y, s, CUBIC_FADE);
const fbm = (x: number, y: number, s: number): number => valueNoise(x, y, s) * 0.55 + valueNoise(x * 2.1, y * 2.1, s + 7) * 0.3 + valueNoise(x * 4.3, y * 4.3, s + 13) * 0.15;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
// Distance between the nearest and second nearest jittered cell point (cell units, 0 on a border), on a domain-warped plane so borders wander.
function cellBorder(x: number, y: number, s: number): number {
  const wx = x + 0.45 * (fbm(x * 0.7, y * 0.7, s + 31) - 0.5) * 2;
  const wy = y + 0.45 * (fbm(x * 0.7, y * 0.7, s + 37) - 0.5) * 2;
  const ci = Math.floor(wx);
  const cj = Math.floor(wy);
  let f1 = 9;
  let f2 = 9;
  for (let a = -1; a <= 1; a++) {
    for (let b = -1; b <= 1; b++) {
      const dx = ci + a + 0.1 + 0.8 * hash(ci + a, cj + b, s + 51) - wx;
      const dy = cj + b + 0.1 + 0.8 * hash(ci + a, cj + b, s + 53) - wy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  }
  return f2 - f1;
}
// A pattern's value at a point, higher where it is on; about 0 .. 1. keep < 1 heals that share of the borders (slow noise lifts them off the threshold).
function patternAt(kind: Pattern, x: number, y: number, s: number, keep = 1): number {
  if (kind === "blobs") return fbm(x, y, s);
  let b = cellBorder(x, y, s) + 0.18 * (valueNoise(x * 2.3, y * 2.3, s + 61) - 0.5); // borders thicken and thin along their length
  if (keep < 1) b += 0.6 * smoothRange(keep - 0.1, keep + 0.1, valueNoise(x * 0.8, y * 0.8, s + 67));
  return kind === "veins" ? 1 - b : b;
}
// The value above which a pattern covers the given share, sampled like the mud texture's.
function patternThreshold(kind: Pattern, s: number, cover: number, keep = 1): number {
  const arr: number[] = [];
  for (let n = 0; n < 4000; n++) arr.push(patternAt(kind, hash(n, 1, 9) * 40, hash(n, 2, 9) * 40, s, keep));
  arr.sort((a, b) => a - b);
  return arr[clamp(Math.floor((1 - cover) * 3999), 0, 3999)]!;
}
const smoothRange = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// A crack network: 1 on the edges of warped jittered-grid cells (plates of about c.scale), fading over c.width; a share 1 - keep of the edges is left out.
function crackAt(x: number, y: number, c: NonNullable<Paint["crack"]>, s: number): number {
  const wx = x + c.scale * 0.45 * (fbm(x / (c.scale * 1.7), y / (c.scale * 1.7), s + 1) - 0.5);
  const wy = y + c.scale * 0.45 * (fbm(x / (c.scale * 1.7), y / (c.scale * 1.7), s + 2) - 0.5);
  const fx = wx / c.scale;
  const fy = wy / c.scale;
  const ci = Math.floor(fx);
  const cj = Math.floor(fy);
  let d1 = 1e9;
  let d2 = 1e9;
  for (let a = -1; a <= 1; a++) {
    for (let b = -1; b <= 1; b++) {
      const px = ci + a + 0.1 + 0.8 * hash(ci + a, cj + b, s);
      const py = cj + b + 0.1 + 0.8 * hash(ci + a, cj + b, s + 7);
      const d = Math.hypot(fx - px, fy - py);
      if (d < d1) [d2, d1] = [d1, d];
      else if (d < d2) d2 = d;
    }
  }
  const edge = ((d2 - d1) / 2) * c.scale; // about the distance to the nearest plate edge
  const on = 1 - smoothRange(c.width * 0.3, c.width, edge);
  return c.keep === undefined ? on : on * smoothRange(1 - c.keep - 0.08, 1 - c.keep + 0.08, valueNoise(x / (c.scale * 1.3), y / (c.scale * 1.3), s + 5));
}

// Closed (or open) Catmull-Rom curve through the points, per samples per segment.
function catmull(pts: readonly Pt[], closed: boolean, per: number): Pt[] {
  const n = pts.length;
  const out: Pt[] = [];
  const get = (i: number): Pt => (closed ? pts[((i % n) + n) % n]! : pts[Math.max(0, Math.min(n - 1, i))]!);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    for (let k = 0; k < per; k++) {
      const u = k / per;
      const p0 = get(i - 1);
      const p1 = get(i);
      const p2 = get(i + 1);
      const p3 = get(i + 2);
      const at = (d: 0 | 1): number => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * u + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * u * u + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * u ** 3);
      out.push([at(0), at(1)]);
    }
  }
  if (!closed) out.push(pts[n - 1]!);
  return out;
}

// Squared distance from (x, y) to the segment a-b; the position along it in 0 .. 1 is left in segU (a hot loop, so no allocation).
let segU = 0;
function toSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const u = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  segU = u;
  const ex = x - ax - u * dx;
  const ey = y - ay - u * dy;
  return ex * ex + ey * ey;
}

interface Sdf {
  (x: number, y: number): number; // negative inside
  pad: { x0: number; x1: number; y0: number; y1: number };
  along?: (x: number, y: number) => number; // paths asked for it: position along the path, 0 .. 1, of the nearest point
}

// An outline's signed distance after domain warp, edge roughness and, for paths, width wobble.
function makeShape(layer: Outline, seed: number, k: number, kFine: number, wantAlong = false): Sdf {
  const sh = layer.shape;
  const amp = layer.warp ?? 900;
  const rough = layer.rough ?? 300;
  const w1 = WARP_WAVE * k;
  const w2 = WARP_WAVE_FINE * k;
  const warp = (x: number, y: number): Pt => amp === 0 ? [x, y] : [
    x + amp * (fbm(x / w1, y / w1, seed + 1) - 0.5) * 2 + amp * 0.35 * (valueNoise(x / w2, y / w2, seed + 3) - 0.5) * 2,
    y + amp * (fbm(x / w1, y / w1, seed + 2) - 0.5) * 2 + amp * 0.35 * (valueNoise(x / w2, y / w2, seed + 4) - 0.5) * 2,
  ];
  let raw: (x: number, y: number) => number;
  let lastT = 0; // a path's raw leaves the position along it here
  let pad: { x0: number; x1: number; y0: number; y1: number };
  if (sh.type === "poly") {
    const poly = catmull(sh.pts, true, 14);
    const flat = Float64Array.from(poly.flat());
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    pad = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    const n = flat.length / 2;
    let near = 0; // the segment nearest the last query, tried first: lattice queries run in order, so it is usually still close and prunes the rest
    const toIndex = (i: number): number => (i === 0 ? n - 1 : i - 1); // segment i runs from point toIndex(i) to point i
    raw = (x, y) => {
      const first = toIndex(near);
      let m = toSegment(x, y, flat[2 * first]!, flat[2 * first + 1]!, flat[2 * near]!, flat[2 * near + 1]!);
      for (let i = 0; i < n; i++) {
        const j = toIndex(i);
        const ax = flat[2 * j]!;
        const ay = flat[2 * j + 1]!;
        const bx = flat[2 * i]!;
        const by = flat[2 * i + 1]!;
        const ox = Math.max(Math.min(ax, bx) - x, 0, x - Math.max(ax, bx)); // distance from the point to the segment's box
        const oy = Math.max(Math.min(ay, by) - y, 0, y - Math.max(ay, by));
        if (ox * ox + oy * oy >= m) continue;
        const d = toSegment(x, y, ax, ay, bx, by);
        if (d < m) {
          m = d;
          near = i;
        }
      }
      m = Math.sqrt(m);
      return insidePolygon(flat, x, y) ? -m : m;
    };
  } else {
    const path = catmull(sh.path, false, 12);
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1]! + Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]));
    const total = cum[cum.length - 1]!;
    const w = sh.w;
    const wAt = (t: number): number => {
      const f = t * (w.length - 1);
      const i = Math.min(w.length - 2, Math.floor(f));
      let v = w[i]! + (w[i + 1]! - w[i]!) * (f - i);
      if (layer.wobble) v *= 1 + layer.wobble * (valueNoise((t * total) / (WIDTH_WAVE * k), 0.5, seed + 8) - 0.5) * 2 + 0.5 * layer.wobble * (valueNoise((t * total) / (WIDTH_WAVE_FINE * k), 1.5, seed + 9) - 0.5) * 2;
      if (layer.taper) v *= 0.35 + 0.65 * smoothRange(0, 0.07, Math.min(t, 1 - t));
      return v;
    };
    const xs = path.map((p) => p[0]);
    const ys = path.map((p) => p[1]);
    const wm = Math.max(...w) * 1.6;
    pad = { x0: Math.min(...xs) - wm, x1: Math.max(...xs) + wm, y0: Math.min(...ys) - wm, y1: Math.max(...ys) + wm };
    const flat = Float64Array.from(path.flat());
    const segs = path.length - 1;
    let near = 0; // as for polygons: the segment nearest the last query goes first
    raw = (x, y) => {
      const at = (i: number): number => toSegment(x, y, flat[2 * i]!, flat[2 * i + 1]!, flat[2 * i + 2]!, flat[2 * i + 3]!);
      let m = at(near);
      let bt = near;
      let u = segU;
      for (let i = 0; i < segs; i++) {
        const ax = flat[2 * i]!;
        const ay = flat[2 * i + 1]!;
        const bx = flat[2 * i + 2]!;
        const by = flat[2 * i + 3]!;
        const ox = Math.max(Math.min(ax, bx) - x, 0, x - Math.max(ax, bx));
        const oy = Math.max(Math.min(ay, by) - y, 0, y - Math.max(ay, by));
        if (ox * ox + oy * oy >= m) continue;
        const d = toSegment(x, y, ax, ay, bx, by);
        if (d < m) {
          m = d;
          bt = i;
          u = segU;
        }
      }
      near = bt;
      const t = (cum[bt]! + u * (cum[bt + 1]! - cum[bt]!)) / total;
      lastT = t;
      return Math.sqrt(m) - wAt(t) / 2;
    };
  }
  const margin = amp * 1.4 + rough * 1.5 + (layer.feather ?? 800) / 2 + 50 + (layer.band ?? 0); // beyond the box by this much the layer has no effect (the warp moves a point by at most 1.35 amp, the roughness by 1.4 rough)
  const n1 = ROUGH_WAVE * kFine;
  const n2 = ROUGH_WAVE_FINE * kFine;
  const box = { x0: pad.x0 - margin, x1: pad.x1 + margin, y0: pad.y0 - margin, y1: pad.y1 + margin };
  // The warped distance (the costly part, smooth at this scale) sampled on a lattice and interpolated; the roughness is added per point.
  const lc = Math.ceil((box.x1 - box.x0) / LATTICE) + 2;
  const lr = Math.ceil((box.y1 - box.y0) / LATTICE) + 2;
  const lat = new Float32Array(lc * lr);
  const latT = wantAlong && sh.type === "path" ? new Float32Array(lc * lr) : null;
  for (let j = 0; j < lr; j++) {
    for (let i = 0; i < lc; i++) {
      const [qx, qy] = warp(box.x0 + i * LATTICE, box.y0 + j * LATTICE);
      lat[j * lc + i] = raw(qx, qy);
      if (latT) latT[j * lc + i] = lastT;
    }
  }
  const outline = ((x: number, y: number): number => {
    if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) return 1e9;
    const fx = (x - box.x0) / LATTICE;
    const fy = (y - box.y0) / LATTICE;
    const i = fx | 0;
    const j = fy | 0;
    const tx = fx - i;
    const ty = fy - j;
    const o = j * lc + i;
    let d = lat[o]! + (lat[o + 1]! - lat[o]!) * tx + (lat[o + lc]! - lat[o]!) * ty + (lat[o]! - lat[o + 1]! - lat[o + lc]! + lat[o + lc + 1]!) * tx * ty;
    if (layer.band) d = Math.abs(d) - layer.band;
    return rough === 0 ? d : d + rough * (fbm(x / n1, y / n1, seed + 5) - 0.5) * 2 + rough * 0.4 * (valueNoise(x / n2, y / n2, seed + 6) - 0.5) * 2;
  }) as Sdf;
  outline.pad = box;
  if (latT) {
    outline.along = (x, y) => {
      const fx = clamp((x - box.x0) / LATTICE, 0, lc - 1.001);
      const fy = clamp((y - box.y0) / LATTICE, 0, lr - 1.001);
      const i = fx | 0;
      const j = fy | 0;
      const tx = fx - i;
      const ty = fy - j;
      const o = j * lc + i;
      return latT[o]! + (latT[o + 1]! - latT[o]!) * tx + (latT[o + lc]! - latT[o]!) * ty + (latT[o]! - latT[o + 1]! - latT[o + lc]! + latT[o + lc + 1]!) * tx * ty;
    };
  }
  return outline;
}

const LATTICE = 192; // world units between samples of an outline's warped distance
const TAU = 2 * Math.PI;
const stoneSeed = (seed: number): number => seed * 7919 + 17; // the stone sampling stream of a map
// Wavelengths of the draft's noise in world units at scale 1, multiplied by the spec's scale (the roughness ones by fineScale).
const WARP_WAVE = 5200;
const WARP_WAVE_FINE = 1800;
const ROUGH_WAVE = 800;
const ROUGH_WAVE_FINE = 260;
const WIDTH_WAVE = 1700;
const WIDTH_WAVE_FINE = 600;
const PASS_WAVE = 500;
const ANGULAR_EDGE = 0.6; // radius of the discs along an angular stone's edge, in stone radii: the union edge scallops by about a tenth of it
const ANGULAR_CORNERS = [5, 6] as const;
const PEBBLE_EDGE = 0.5; // a pebble is a centre disc and one offset to a side: a lump, not a circle
const PEBBLE_REACH = 0.55;
const MASS_EDGE_R = 110; // radius of the discs along a massif edge, smaller only where the rock is narrow
const MASS_EDGE_R_MIN = 20;
const DRAWN_TOLERANCE = 2; // world units the union edge may scallop by: the drawn outline is the exact union, and this is how rough it may look
const EDGE_SIMPLIFY = 26; // world units the polyline may stray from the mask contour: straight rock faces with kinks
const MASK_EDGE = 128; // mask value of the massif's edge
const EDGE_FACE = 120; // faces longer than this get a notch or knob
const EDGE_NOTCH = 14; // how far a seeded notch or knob moves a midpoint of a long face
const MASS_CELL = 50; // world units of the massif mask grid
const MASS_MAX_R = 300; // largest disc of a massif
const MASS_MIN_R = 30;
const TALUS = { g: 170, r: [60, 150], ex: [0, 2], gap: 70 } as const;
const OUTCROP = { g: 420, r: [170, 380], ex: [2, 5], gap: 140 } as const;

// An irregular polygon of seven to nine corners in place of a round stone of radius d.r: its edges are rows of discs and a ring and a centre
// disc fill the inside, so the union has straight edges and corners like the boulders of the random map, from a few dozen discs.
function angularStone(rng: () => number, d: Disc, small: boolean): Disc[] {
  if (small) {
    const out: Disc[] = [];
    const a0 = rng() * TAU;
    for (let k = 0; k < 1; k++) {
      const a = a0 + (rng() - 0.5) * 0.8;
      const reach = d.r * PEBBLE_REACH * (0.8 + 0.4 * rng());
      out.push({ x: d.x + reach * Math.cos(a), y: d.y + reach * Math.sin(a), r: PEBBLE_EDGE * d.r });
    }
    out.push({ x: d.x, y: d.y, r: 0.55 * d.r });
    return out;
  }
  const n = ANGULAR_CORNERS[0] + Math.floor(rng() * (ANGULAR_CORNERS[1] - ANGULAR_CORNERS[0] + 1));
  const rho = ANGULAR_EDGE * d.r;
  const corners: { x: number; y: number }[] = [];
  let nearest = Infinity;
  for (let k = 0; k < n; k++) {
    const a = (TAU * (k + (rng() - 0.5) * 0.6)) / n;
    const reach = d.r * (0.72 + 0.38 * rng()) - rho;
    corners.push({ x: d.x + reach * Math.cos(a), y: d.y + reach * Math.sin(a) });
  }
  const out: Disc[] = [];
  for (let k = 0; k < n; k++) {
    const p = corners[k]!;
    const q = corners[(k + 1) % n]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / rho));
    for (let j = 0; j < steps; j++) out.push({ x: p.x + ((q.x - p.x) * j) / steps, y: p.y + ((q.y - p.y) * j) / steps, r: rho });
    nearest = Math.min(nearest, Math.hypot((p.x + q.x) / 2 - d.x, (p.y + q.y) / 2 - d.y));
  }
  for (let k = 0; k < n; k += 2) out.push({ x: d.x + 0.45 * (corners[k]!.x - d.x), y: d.y + 0.45 * (corners[k]!.y - d.y), r: 1.5 * rho });
  out.push({ x: d.x, y: d.y, r: Math.max(rho, 0.55 * nearest) });
  return out;
}

function check(spec: MapSpec): void {
  const bad = (what: string): never => {
    throw new Error(`map "${spec.name}": ${what}`);
  };
  if (!(spec.width >= 500 && spec.height >= 500 && spec.width * spec.height <= LIMITS.area)) bad("size is out of bounds");
  if (spec.layers.length > LIMITS.layers || spec.rock.length > LIMITS.layers) bad("too many layers");
  for (const layer of [...spec.layers, ...spec.rock]) {
    const n = layer.shape.type === "poly" ? layer.shape.pts.length : layer.shape.path.length;
    if (n > LIMITS.points || n < 2) bad(`layer "${layer.id}" has ${n} points`);
  }
  // The texture and paint options: each value finite and in its range, so a typo fails here and not as a blank or NaN-filled map.
  const inRange = (id: string, what: string, v: number | undefined, lo: number, hi: number, open = false): void => {
    if (v === undefined) return;
    if (!(Number.isFinite(v) && (open ? v > lo : v >= lo) && v <= hi)) bad(`layer "${id}": ${what} ${v} is outside ${open ? "(" : "["}${lo}, ${hi}]`);
  };
  for (const layer of spec.layers) {
    inRange(layer.id, "winter", layer.winter, 0, 1);
    for (const [name, tx] of [["mud", layer.mud], ["firm", layer.firm]] as const) {
      if (!tx) continue;
      inRange(layer.id, `${name}.scale`, tx.scale, 0, 1e6, true);
      inRange(layer.id, `${name}.coverage`, tx.coverage, 0, 1);
      inRange(layer.id, `${name}.keep`, tx.keep, 0, 1);
    }
    const p = layer.paint;
    if (!p) continue;
    inRange(layer.id, "paint.alpha", p.alpha, 0, 1);
    for (const c of [...p.rgb, ...(p.tex?.rgb ?? [])]) inRange(layer.id, "paint colour", c, 0, 255);
    if (p.tex) {
      inRange(layer.id, "paint.tex.scale", p.tex.scale, 0, 1e6, true);
      inRange(layer.id, "paint.tex.cover", p.tex.cover, 0, 1);
      inRange(layer.id, "paint.tex.alpha", p.tex.alpha, 0, 1);
      inRange(layer.id, "paint.tex.keep", p.tex.keep, 0, 1);
      inRange(layer.id, "paint.tex.stretch", p.tex.stretch, 0, 100, true);
      inRange(layer.id, "paint.tex.soft", p.tex.soft, 0, 10, true);
    }
    if (p.crack) {
      inRange(layer.id, "paint.crack.scale", p.crack.scale, 0, 1e6, true);
      inRange(layer.id, "paint.crack.width", p.crack.width, 0, 1e6, true);
      inRange(layer.id, "paint.crack.keep", p.crack.keep, 0, 1);
    }
    if (p.patch) {
      inRange(layer.id, "paint.patch.scale", p.patch.scale, 0, 1e6, true);
      inRange(layer.id, "paint.patch.lo", p.patch.lo, 0, 1);
      inRange(layer.id, "paint.patch.hi", p.patch.hi, p.patch.lo, 1, true);
    }
    inRange(layer.id, "paint.fade", p.fade, 0, 0.5, true);
  }
}

export function buildMap(spec: MapSpec): BuiltMap {
  check(spec);
  const { width: W, height: H, seed } = spec;
  const k = spec.scale;
  const kFine = spec.fineScale ?? k;
  const layers = spec.layers.map((layer, i) => ({ ...layer, outline: makeShape(layer, seed + 41 * i, k, kFine, layer.paint?.fade !== undefined), i, thr: -1 }));
  for (const layer of layers) {
    const tx = layer.mud ?? layer.firm;
    if (!tx || tx.coverage >= 1) continue;
    if (tx.pattern && tx.pattern !== "blobs") {
      layer.thr = patternThreshold(tx.pattern, seed + 100 + layer.i, tx.coverage, tx.keep);
      continue;
    }
    const arr: number[] = [];
    for (let n = 0; n < 4000; n++) arr.push(fbm((hash(n, 1, 9) * 60000) / tx.scale, (hash(n, 2, 9) * 60000) / tx.scale, seed + 100 + layer.i));
    arr.sort((a, b) => a - b);
    layer.thr = arr[Math.floor((1 - tx.coverage) * 3999)]!;
  }
  const texThr = layers.map((layer) => (layer.paint?.tex ? patternThreshold(layer.paint.tex.pattern ?? "blobs", seed + 300 + layer.i, layer.paint.tex.cover, layer.paint.tex.keep) : 0));
  const texAt = (tx: Texture, x: number, y: number, s: number): number => (tx.pattern ? patternAt(tx.pattern, x / tx.scale, y / tx.scale, s, tx.keep) : fbm(x / tx.scale, y / tx.scale, s));
  // The field at a point: food and poison weights, winter share and the mud and firm shares, from the layers in order.
  const out = { food: 1, poison: 1, winter: 1, mud: 0, firm: 0, r: 0, g: 0, b: 0, a: 0 };
  const field = (x: number, y: number): void => {
    let food = spec.baseFood ?? 1;
    let poison = spec.basePoison ?? 1;
    let winter = 1;
    let mud = 0;
    let firm = 0;
    let r = 0, g = 0, b = 0, a = 0; // the paint, straight alpha, each layer laid over the ones before
    for (const layer of layers) {
      const d = layer.outline(x, y);
      const fe = layer.feather ?? 800;
      if (d > fe / 2) continue;
      const m = clamp(0.5 - d / fe, 0, 1);
      const edge = layer.edge ?? 380;
      const ins = clamp(0.5 - d / edge, 0, 1);
      if (layer.food !== undefined) food += (layer.food - food) * m;
      if (layer.poison !== undefined) poison += (layer.poison - poison) * m;
      if (layer.winter !== undefined) winter += (layer.winter - winter) * m;
      if (layer.paint) {
        let [lr, lg, lb] = layer.paint.rgb;
        let pa = layer.paint.alpha;
        const tx = layer.paint.tex;
        if (tx) {
          const v = patternAt(tx.pattern ?? "blobs", x / (tx.scale * (tx.stretch ?? 1)), y / tx.scale, seed + 300 + layer.i, tx.keep);
          const p = clamp(0.5 + (v - texThr[layer.i]!) / (tx.soft ?? 0.1), 0, 1);
          lr += (tx.rgb[0] - lr) * p;
          lg += (tx.rgb[1] - lg) * p;
          lb += (tx.rgb[2] - lb) * p;
          pa += (tx.alpha - pa) * p;
        }
        let la = clamp(pa, 0, 1) * m;
        const pt = layer.paint;
        if (pt.crack) la *= crackAt(x, y, pt.crack, seed + 300 + layer.i);
        if (pt.patch) la *= smoothRange(pt.patch.lo, pt.patch.hi, fbm(x / pt.patch.scale, y / pt.patch.scale, seed + 400 + layer.i));
        if (pt.fade !== undefined && layer.outline.along) {
          const t = layer.outline.along(x, y);
          la *= smoothRange(0, pt.fade, t) * smoothRange(0, pt.fade, 1 - t);
        }
        const na = la + a * (1 - la);
        if (na > 0) {
          r = (lr * la + r * a * (1 - la)) / na;
          g = (lg * la + g * a * (1 - la)) / na;
          b = (lb * la + b * a * (1 - la)) / na;
          a = na;
        }
      }
      if (layer.clearMud) mud *= 1 - ins;
      if (layer.mud) {
        const tx = layer.mud;
        const n = tx.coverage >= 1 ? 1 : clamp(0.5 + (texAt(tx, x, y, seed + 100 + layer.i) - layer.thr) * 10, 0, 1);
        mud = Math.max(mud, Math.min(ins, n));
      }
      if (layer.firm) {
        const tx = layer.firm;
        const n = tx.coverage >= 1 ? 1 : clamp(0.5 + (texAt(tx, x, y, seed + 100 + layer.i) - layer.thr) * 10, 0, 1);
        firm = Math.max(firm, Math.min(clamp(0.5 - (d + (tx.inset ?? 0)) / edge, 0, 1), n));
      }
    }
    out.food = food;
    out.poison = poison;
    out.winter = winter;
    out.mud = mud;
    out.firm = firm;
    out.r = r;
    out.g = g;
    out.b = b;
    out.a = a;
  };

  // Ground and weights on the nodes of the ground raster; the padding ring stays 0 (weights too, never read there).
  const ground = new GroundField(W, H);
  const { cols, rows, cell } = ground;
  const food = new Uint8Array(cols * rows);
  const poison = new Uint8Array(cols * rows);
  const paint = spec.layers.some((l) => l.paint) ? new Uint8Array(4 * cols * rows) : null;
  const winter = spec.layers.some((l) => l.winter !== undefined) ? new Uint8Array(cols * rows) : null; // only for maps with winter ground
  for (let j = GROUND_PAD; j < rows - GROUND_PAD; j++) {
    for (let i = GROUND_PAD; i < cols - GROUND_PAD; i++) {
      field((i - GROUND_PAD) * cell, (j - GROUND_PAD) * cell);
      const n = j * cols + i;
      const mud = Math.round(out.mud * 255);
      const firm = Math.round(out.firm * 255);
      ground.data[2 * n] = mud;
      ground.data[2 * n + 1] = firm;
      food[n] = Math.round(clamp(out.food * WEIGHT_UNIT, 0, 255));
      poison[n] = Math.round(clamp(out.poison * WEIGHT_UNIT, 0, 255));
      if (winter) winter[n] = Math.round(clamp(out.winter * 255, 0, 255));
      if (paint) paint.set([out.r, out.g, out.b, out.a * 255].map((v) => Math.round(clamp(v, 0, 255))), 4 * n);
    }
  }
  oneKindPerNode(ground.data, 1); // firm ground wins over mud
  let mudNodes = 0;
  let firmNodes = 0;
  for (let k = 0; k < ground.data.length; k += 2) {
    if (ground.data[k]! > 127) mudNodes++;
    if (ground.data[k + 1]! > 127) firmNodes++;
  }

  // Massifs: each a mask on a 50 unit grid (with its passes cut out), filled with discs from the widest inside outwards.
  const mcols = Math.ceil(W / MASS_CELL);
  const mrows = Math.ceil(H / MASS_CELL);
  const mask = new Uint8Array(mcols * mrows);
  const massifs = spec.rock.map((rockLayer, i) => ({ rockLayer, i })).filter(({ rockLayer }) => rockLayer.kind === "massif");
  for (const { rockLayer, i } of massifs) {
    const outline = makeShape(rockLayer, seed + 977 + 31 * i, k, kFine);
    const fe = rockLayer.feather ?? 800;
    const passes = rockLayer.passes ?? [];
    const nw = PASS_WAVE * k;
    for (let cy = Math.max(0, Math.floor(outline.pad.y0 / MASS_CELL)); cy < Math.min(mrows, Math.ceil(outline.pad.y1 / MASS_CELL)); cy++) {
      for (let cx = Math.max(0, Math.floor(outline.pad.x0 / MASS_CELL)); cx < Math.min(mcols, Math.ceil(outline.pad.x1 / MASS_CELL)); cx++) {
        const x = (cx + 0.5) * MASS_CELL;
        const y = (cy + 0.5) * MASS_CELL;
        let q = clamp(0.5 - outline(x, y) / fe, 0, 1);
        if (q <= 0) continue;
        for (const [px, py, pr] of passes) q = Math.min(q, clamp((Math.hypot(x - px, y - py) / (pr * (0.85 + 0.3 * valueNoise(x / nw, y / nw, seed + 9 + i))) - 0.78) * 4, 0, 1));
        const v = Math.round(q * 255);
        if (v > mask[cy * mcols + cx]!) mask[cy * mcols + cx] = v;
      }
    }
  }
  const rock: Disc[] = [];
  const massAt = (x: number, y: number): number => mask[clamp(Math.floor(y / MASS_CELL), 0, mrows - 1) * mcols + clamp(Math.floor(x / MASS_CELL), 0, mcols - 1)]! / 255;
  if (massifs.length > 0) rock.push(...massDiscs(mask, mcols, mrows));
  const massifDiscs = rock.length;

  // Stones, outcrops and talus: sampled on a grid, kept where the layer's cover says, clear of mud, massifs and each other.
  const rng = createRng(stoneSeed(seed)).next;
  const taken = new Map<number, Disc[]>(); // bounding discs of the placed stones by 400 unit cell
  const keyOf = (cx: number, cy: number): number => cx * 100003 + cy;
  const hit = (x: number, y: number, r: number, gap: number): boolean => {
    const cx = Math.floor(x / 400);
    const cy = Math.floor(y / 400);
    for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) for (const p of taken.get(keyOf(cx + a, cy + b)) ?? []) if (Math.hypot(p.x - x, p.y - y) < r + p.r + gap) return true;
    return false;
  };
  let stones = 0;
  const passes = spec.rock.flatMap((r) => r.passes ?? []); // every layer's: a talus beside a massif must not fill its passes
  spec.rock.forEach((rockLayer, ri) => {
    if (rockLayer.kind === "massif") return;
    const outline = makeShape(rockLayer, seed + 1977 + 31 * ri, k, kFine);
    const feather = rockLayer.feather ?? 1200;
    const Kd = rockLayer.kind === "talus" ? TALUS : OUTCROP;
    const r0 = rockLayer.r ?? Kd.r;
    const g = rockLayer.g ?? Kd.g;
    const avgR = (r0[0] + r0[1]) / 2;
    const avgA = 0.3 * Math.PI * avgR * avgR * (1 + ((Kd.ex[0] + Kd.ex[1]) / 2) * 0.45);
    const pw = rockLayer.pow ?? 1.5;
    const lo = rockLayer.clumpLo ?? 0.42;
    const hi = rockLayer.clumpHi ?? 0.62;
    for (let y = Math.max(0, outline.pad.y0); y < Math.min(H, outline.pad.y1); y += g) {
      for (let x = Math.max(0, outline.pad.x0); x < Math.min(W, outline.pad.x1); x += g) {
        const px = x + rng() * g;
        const py = y + rng() * g;
        const d = outline(px, py);
        if (d > feather / 2) continue;
        const m = clamp(0.5 - d / feather, 0, 1) ** pw;
        if (passes.some(([qx, qy, qr]) => Math.hypot(px - qx, py - qy) < qr)) continue;
        const fade = rockLayer.fadeX ? 1 - smoothRange(rockLayer.fadeX[0], rockLayer.fadeX[1], px) : 1;
        const clump = rockLayer.clump ? smoothRange(lo, hi, fbm(px / rockLayer.clump, py / rockLayer.clump, seed + 500 + ri)) * 2.6 : 1;
        const p = Math.min(1, ((rockLayer.cover * g * g) / avgA) * m * clump * fade);
        if (rng() > p) continue;
        const r = r0[0] + (r0[1] - r0[0]) * rng() ** 1.3;
        const nEx = Kd.ex[0] + Math.floor(rng() * (Kd.ex[1] - Kd.ex[0] + 1));
        if (px < r + 60 || py < r + 60 || px > W - r - 60 || py > H - r - 60) continue;
        if (!rockLayer.onMud && ground.valueAt(px, py) < 0) continue;
        if (massAt(px, py) > 0.2) continue;
        if (spec.solidRock && clearOfMassif(massAt, px, py, r * 1.5 + SOLID_GAP)) continue;
        const discs: Disc[] = [{ x: px, y: py, r }];
        const ang = rng() * TAU;
        for (let e = 0; e < nEx; e++) {
          const t = ((e + 1) / (nEx + 1)) * 2 - 1;
          const off = r * (1.0 * t + 0.4 * (rng() - 0.5));
          const side = r * 0.35 * (rng() - 0.5) * 2;
          discs.push({ x: px + off * Math.cos(ang) - side * Math.sin(ang), y: py + off * Math.sin(ang) + side * Math.cos(ang), r: r * (0.5 + 0.35 * rng()) });
        }
        const bound = r * 1.5 + (nEx ? r * 0.8 : 0);
        const angular = discs.flatMap((d, i) => angularStone(rng, d, rockLayer.kind === "talus" || i > 0)); // talus too: no stone is a plain circle
        if (hit(px, py, bound, Kd.gap)) continue;
        if (!rockLayer.onMud && discs.some((q) => ground.valueAt(q.x, q.y) < 0)) continue;
        const key = keyOf(Math.floor(px / 400), Math.floor(py / 400));
        if (!taken.has(key)) taken.set(key, []);
        taken.get(key)!.push({ x: px, y: py, r: bound });
        for (const q of angular) rock.push({ x: Math.round(q.x), y: Math.round(q.y), r: Math.round(q.r) });
        stones++;
      }
    }
  });
  if (spec.solidRock) fillUnreachable(rock, W, H);
  if (rock.length > LIMITS.discs) throw new Error(`map "${spec.name}": ${rock.length} rock discs, the limit is ${LIMITS.discs}`);
  // The same bounds unpackMap holds the arrays to, so a map that builds can always be handed to another thread.
  for (const d of rock) if (!(d.r > 0 && d.r <= MAX_MAP_DISC_R) || d.x < -d.r || d.x > W + d.r || d.y < -d.r || d.y > H + d.r) throw new Error(`map "${spec.name}": a rock disc at ${d.x}, ${d.y} with radius ${d.r} is outside the world or wider than ${MAX_MAP_DISC_R}`);

  let rockArea = 0;
  for (const d of rock) rockArea += Math.PI * d.r * d.r;
  const nodes = (cols - 2 * GROUND_PAD) * (rows - 2 * GROUND_PAD);
  return {
    ground,
    weights: new MapWeights(ground, food, poison, discsBlocked(rock, W), paint, winter),
    rock,
    stats: { rockDiscs: rock.length, massifDiscs: massifDiscs, stones, mud: mudNodes / nodes, firm: firmNodes / nodes, rockShare: rockArea / (W * H) },
  };
}

const SOLID_GAP = 60; // world units a stone keeps from a massif on a solidRock map
const SOLID_BODY = 12; // world units: the default creature's radius (config creature.radius), whose unreachable ground a solidRock map fills
const FILL_CELL = 4; // world units of the raster the unreachable ground is found on
const FILL_BUCKET = 400; // world units of the square each raster is centred on
const FILL_SLACK = 5; // world units: a cell counts as a creature position when its centre is this much closer to rock than a creature may be, so no channel a creature fits through is missed between cell centres
const FILL_HALO = 100; // world units of margin round it; sealed pockets up to about this size are found
// True when a massif lies within d of (x, y), probed at 8 points round it.
function clearOfMassif(massAt: (x: number, y: number) => number, x: number, y: number, d: number): boolean {
  for (let k = 0; k < 8; k++) if (massAt(x + d * Math.cos((k * Math.PI) / 4), y + d * Math.sin((k * Math.PI) / 4)) > 0.2) return true;
  return false;
}

// Fills the ground where an item could lie but no creature could reach it: slits, notches, pinholes and sealed pockets in and between rock.
// Judged for the smallest item and the default creature, on a raster round each FILL_BUCKET square with a FILL_HALO margin: a creature
// position counts as reachable when it connects to the raster's border, so a pocket smaller than the halo is always found. Each filling
// disc stops a grid step short of the nearest reachable creature position (exact Euclidean distance) and of the raster's edge, beyond
// which ground is unseen, so it never takes ground a creature could stand on. Reachability is judged generously (FILL_SLACK), never the other way.
// The squares are walked in a fixed order, so the result is the same on every build.
function fillUnreachable(rock: Disc[], width: number, height: number): void {
  const S = FILL_CELL;
  const B = FILL_BUCKET;
  const halo = FILL_HALO;
  const n = Math.ceil((B + 2 * halo) / S);
  const item = ITEM_RADIUS_RANGE[0];
  const key = (bx: number, by: number): number => bx * 65536 + by;
  const byBucket = new Map<number, Disc[]>();
  const todo = new Set<number>();
  const index = (d: Disc): void => {
    const k = key(Math.floor(d.x / B), Math.floor(d.y / B));
    if (!byBucket.has(k)) byBucket.set(k, []);
    byBucket.get(k)!.push(d);
  };
  for (const d of rock) {
    index(d);
    for (let by = Math.max(0, Math.floor((d.y - d.r - item) / B)); by <= Math.floor((d.y + d.r + item) / B); by++) {
      for (let bx = Math.max(0, Math.floor((d.x - d.r - item) / B)); bx <= Math.floor((d.x + d.r + item) / B); bx++) todo.add(key(bx, by));
    }
  }
  const reach = Math.ceil((MAX_MAP_DISC_R + halo + SOLID_BODY) / B);
  const blocked = new Uint8Array(n * n); // bit 1: no item fits, bit 2: no creature fits
  const seen = new Uint8Array(n * n);
  const dist = new Float64Array(n * n);
  const line = new Float64Array(n);
  const src = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const stack = new Int32Array(n * n);
  for (const k of [...todo].sort((a, b) => a - b)) {
    const bx = Math.floor(k / 65536);
    const by = k - bx * 65536;
    const ox = bx * B - halo;
    const oy = by * B - halo;
    blocked.fill(0);
    if (ox < SOLID_BODY || oy < SOLID_BODY || ox + n * S > width - SOLID_BODY || oy + n * S > height - SOLID_BODY) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const x = ox + (i + 0.5) * S;
          const y = oy + (j + 0.5) * S;
          const edge = Math.min(x, y, width - x, height - y);
          blocked[j * n + i] = (edge < item ? 1 : 0) | (edge < SOLID_BODY ? 2 : 0);
        }
      }
    }
    const stamp = (d: Disc): void => {
      const outer = d.r + SOLID_BODY - FILL_SLACK;
      const r1 = (d.r + item) ** 2;
      const r2 = outer * outer;
      for (let j = Math.max(0, Math.floor((d.y - outer - oy) / S)); j <= Math.min(n - 1, Math.floor((d.y + outer - oy) / S)); j++) {
        const dy2 = (oy + (j + 0.5) * S - d.y) ** 2;
        for (let i = Math.max(0, Math.floor((d.x - outer - ox) / S)), row = j * n; i <= Math.min(n - 1, Math.floor((d.x + outer - ox) / S)); i++) {
          if (blocked[row + i] === 3) continue;
          const q = (ox + (i + 0.5) * S - d.x) ** 2 + dy2;
          if (q < r2) blocked[row + i] |= q < r1 ? 3 : 2;
        }
      }
    };
    for (let b = -reach; b <= reach; b++) for (let a = -reach; a <= reach; a++) for (const d of byBucket.get(key(bx + a, by + b)) ?? []) stamp(d);
    const lo = Math.floor(halo / S);
    const hi = Math.min(n, lo + Math.ceil(B / S));
    let free = false; // any item ground in the core at all (not so inside a massif)
    for (let j = lo; j < hi && !free; j++) for (let i = lo; i < hi && !free; i++) free = !(blocked[j * n + i]! & 1);
    if (!free) continue;
    // creature positions joined to the border, then the distance of every cell to the nearest of them
    seen.fill(0);
    let top = 0;
    const visit = (m: number): void => {
      if (seen[m] || blocked[m]! & 2) return;
      seen[m] = 1;
      stack[top++] = m;
    };
    for (let c = 0; c < n; c++) {
      visit(c);
      visit((n - 1) * n + c);
      visit(c * n);
      visit(c * n + n - 1);
    }
    while (top > 0) {
      const q = stack[--top]!;
      const i = q % n;
      if (i > 0) visit(q - 1);
      if (i < n - 1) visit(q + 1);
      if (q >= n) visit(q - n);
      if (q + n < n * n) visit(q + n);
    }
    let any = false; // any item ground in the core that no creature position reaches
    for (let j = lo; j < hi && !any; j++) for (let i = lo; i < hi && !any; i++) any = !seen[j * n + i] && !(blocked[j * n + i]! & 1);
    if (!any) continue;
    for (let q = 0; q < n * n; q++) dist[q] = seen[q] ? 0 : Infinity;
    sqDist2d(dist, n, line, src, v, z);
    // in the core: world units to the nearest creature position found, or to the raster's edge when that is nearer (ground beyond it is unseen)
    for (let j = lo; j < hi; j++) for (let i = lo; i < hi; i++) dist[j * n + i] = Math.min(Math.sqrt(dist[j * n + i]!) * S, (Math.min(i, j, n - 1 - i, n - 1 - j) + 0.5) * S);
    // the core's unreachable item ground, deepest first, each filled by a disc reaching to the nearest creature position
    const lost: number[] = [];
    for (let j = lo; j < hi; j++) for (let i = lo; i < hi; i++) if (!(blocked[j * n + i]! & 1) && dist[j * n + i]! > SOLID_BODY + item) lost.push(j * n + i);
    lost.sort((a, b) => dist[b]! - dist[a]! || a - b);
    for (const q of lost) {
      if (blocked[q]! & 1) continue;
      const r = Math.min(MAX_MAP_DISC_R, Math.floor(dist[q]! - SOLID_BODY - S)); // a grid step short: a creature position may lie that far from its cell's centre
      if (r < 1) continue; // a sliver within a grid step of reach: left, rather than a loose speck of rock
      const d = { x: Math.round(ox + ((q % n) + 0.5) * S), y: Math.round(oy + (Math.floor(q / n) + 0.5) * S), r };
      rock.push(d);
      index(d);
      stamp(d);
    }
  }
}

// Squared Euclidean distance transform in place (Felzenszwalb and Huttenlocher): f holds 0 at the sources and Infinity elsewhere, in cells.
function sqDist2d(f: Float64Array, n: number, line: Float64Array, src: Float64Array, v: Int32Array, z: Float64Array): void {
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < n; k++) line[k] = f[j * n + k]!;
    if (sqDist1d(line, src, n, v, z)) for (let k = 0; k < n; k++) f[j * n + k] = line[k]!;
  }
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) line[k] = f[k * n + i]!;
    if (sqDist1d(line, src, n, v, z)) for (let k = 0; k < n; k++) f[k * n + i] = line[k]!;
  }
}

// One line of sqDist2d, in place; false (and the line untouched) when it has no finite value.
function sqDist1d(line: Float64Array, src: Float64Array, n: number, v: Int32Array, z: Float64Array): boolean {
  let m = -1;
  for (let q = 0; q < n; q++) {
    const fq = line[q]!;
    if (fq === Infinity) continue;
    if (m < 0) {
      m = 0;
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
      continue;
    }
    let sp = (fq + q * q - (line[v[m]!]! + v[m]! * v[m]!)) / (2 * q - 2 * v[m]!);
    while (sp <= z[m]!) {
      m--;
      sp = (fq + q * q - (line[v[m]!]! + v[m]! * v[m]!)) / (2 * q - 2 * v[m]!);
    }
    m++;
    v[m] = q;
    z[m] = sp;
    z[m + 1] = Infinity;
  }
  if (m < 0) return false;
  src.set(line); // the parabolas read the original values
  m = 0;
  for (let q = 0; q < n; q++) {
    while (z[m + 1]! < q) m++;
    line[q] = (q - v[m]!) ** 2 + src[v[m]!]!;
  }
  return true;
}

// The outlines of a mask (cells at 128 or more) at its cell centres, as flat x, y lists in world units, the mask treated as 0 past its edge.
function maskContours(mask: Uint8Array, cols: number, rows: number): number[][] {
  const w = cols + 2;
  const padded = new Uint8Array(w * (rows + 2));
  for (let j = 0; j < rows; j++) padded.set(mask.subarray(j * cols, (j + 1) * cols), (j + 1) * w + 1);
  return marchingSquares(padded, w, rows + 2, MASK_EDGE, { scale: MASS_CELL, shift: -0.5, minPoints: 4 });
}

// Seeded notches and knobs: every long face gets a midpoint moved sideways, so the outline reads as broken rock.
function breakUp(line: readonly number[], salt: number): number[] {
  const out: number[] = [];
  const n = line.length / 2;
  for (let k = 0; k < n; k++) {
    const ax = line[2 * k]!;
    const ay = line[2 * k + 1]!;
    const bx = line[2 * ((k + 1) % n)]!;
    const by = line[2 * ((k + 1) % n) + 1]!;
    out.push(ax, ay);
    const len = Math.hypot(bx - ax, by - ay);
    if (len > EDGE_FACE) {
      const side = (hash(Math.round(ax), Math.round(ay), salt) - 0.5) * 2 * EDGE_NOTCH;
      const along = 0.35 + 0.3 * hash(Math.round(bx), Math.round(by), salt + 1);
      out.push(ax + (bx - ax) * along - ((by - ay) / len) * side, ay + (by - ay) * along + ((bx - ax) / len) * side);
    }
  }
  return out;
}

// Discs that fill a mask (cells at 128 or more): the cells are taken from the widest inside outwards, each uncovered one becoming the centre of a
// disc as wide as its distance to the outside (3-4 chamfer distance), at most MASS_MAX_R, so the union follows the mask edge.
function massDiscs(mask: Uint8Array, cols: number, rows: number): Disc[] {
  const dist = new Float32Array(cols * rows);
  for (let n = 0; n < dist.length; n++) dist[n] = mask[n]! >= 128 ? 1e9 : 0;
  const at = (i: number, j: number): number => (i < 0 || j < 0 || i >= cols || j >= rows ? 0 : dist[j * cols + i]!);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const n = j * cols + i;
      if (dist[n] === 0) continue;
      dist[n] = Math.min(dist[n]!, at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + Math.SQRT2, at(i + 1, j - 1) + Math.SQRT2);
    }
  }
  for (let j = rows - 1; j >= 0; j--) {
    for (let i = cols - 1; i >= 0; i--) {
      const n = j * cols + i;
      if (dist[n] === 0) continue;
      dist[n] = Math.min(dist[n]!, at(i + 1, j) + 1, at(i, j + 1) + 1, at(i + 1, j + 1) + Math.SQRT2, at(i - 1, j + 1) + Math.SQRT2);
    }
  }
  const order: number[] = [];
  for (let n = 0; n < dist.length; n++) if (dist[n]! > 0) order.push(n);
  order.sort((a, b) => dist[b]! - dist[a]! || a - b);
  const covered = new Uint8Array(cols * rows);
  const discs: Disc[] = [];
  const cover = (cx: number, cy: number, r: number): void => {
    const reach = Math.ceil(r / MASS_CELL);
    for (let j = Math.max(0, cy - reach); j <= Math.min(rows - 1, cy + reach); j++) {
      for (let i = Math.max(0, cx - reach); i <= Math.min(cols - 1, cx + reach); i++) if (((i - cx) * MASS_CELL) ** 2 + ((j - cy) * MASS_CELL) ** 2 <= r * r) covered[j * cols + i] = 1;
    }
  };
  // The edge: the mask contour as a seeded broken-rock polyline, lined with large discs at the spacing that keeps the scallops under the drawn tolerance,
  // each pushed inside so the union's outer envelope sits on the polyline.
  const depthAt = (x: number, y: number): number => {
    const i = clamp(Math.floor(x / MASS_CELL), 0, cols - 1);
    const j = clamp(Math.floor(y / MASS_CELL), 0, rows - 1);
    return Math.max(0, (dist[j * cols + i]! - 0.5) * MASS_CELL);
  };
  for (const loop of maskContours(mask, cols, rows)) {
    const line = breakUp(simplifyClosed(loop, EDGE_SIMPLIFY), loop.length / 2);
    let carry = 0; // distance left to the next disc along the polyline
    const points = line.length / 2;
    for (let k = 0; k < points; k++) {
      const ax = line[2 * k]!;
      const ay = line[2 * k + 1]!;
      const bx = line[2 * ((k + 1) % points)]!;
      const by = line[2 * ((k + 1) % points) + 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) continue;
      const tx = (bx - ax) / len;
      const ty = (by - ay) / len;
      let nx = -ty; // the normal pointing into the mask, found from the mask itself
      let ny = tx;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      if (depthAt(mx + nx * MASS_CELL, my + ny * MASS_CELL) < depthAt(mx - nx * MASS_CELL, my - ny * MASS_CELL)) {
        nx = -nx;
        ny = -ny;
      }
      let at = carry;
      while (at < len) {
        const px = ax + tx * at;
        const py = ay + ty * at;
        let r = MASS_EDGE_R;
        const room = depthAt(px + nx * r, py + ny * r) + MASS_CELL / 2; // the grid reads about half a cell short
        if (room < r) r = clamp(room, MASS_EDGE_R_MIN, MASS_EDGE_R); // a narrow spot gets smaller discs
        const cx = px + nx * r;
        const cy = py + ny * r;
        discs.push({ x: Math.round(cx), y: Math.round(cy), r: Math.round(r) });
        cover(clamp(Math.floor(cx / MASS_CELL), 0, cols - 1), clamp(Math.floor(cy / MASS_CELL), 0, rows - 1), r);
        at += 2 * Math.sqrt(2 * r * DRAWN_TOLERANCE - DRAWN_TOLERANCE ** 2);
      }
      carry = at - len;
    }
  }
  for (const n of order) {
    if (covered[n]) continue;
    const cx = n % cols;
    const cy = (n - cx) / cols;
    const r = clamp((dist[n]! - 0.5) * MASS_CELL, MASS_MIN_R, MASS_MAX_R);
    const x = (cx + 0.5) * MASS_CELL;
    const y = (cy + 0.5) * MASS_CELL;
    discs.push({ x: Math.round(x), y: Math.round(y), r: Math.round(r) });
    cover(cx, cy, r);
  }
  return discs;
}
