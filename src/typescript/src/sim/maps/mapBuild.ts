import { GROUND_PAD, GroundField, hash } from "../groundField.ts";
import { createRng } from "../rng.ts";

// Builds the ground, the food and poison weights and the rock of a hand-designed map (docs/world-maps/) from its spec. Port of the draft generator
// docs/world-maps/tools/gen.mjs, evaluated on the nodes of the ground raster. The result depends on the spec alone, so every thread builds the same map.
// A spec is code we ship, not visitor input, but its size is still bounded (LIMITS) and the build throws on a spec that breaks them.

type Pt = readonly [number, number];
type Shape = { type: "poly"; pts: readonly Pt[] } | { type: "path"; path: readonly Pt[]; w: readonly number[] };
interface Texture {
  coverage: number; // share of the layer that is mud or firm, 1 for all of it
  scale: number; // wavelength of the patchiness
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
  clearMud?: boolean; // removes mud under the layer (islands in a sea)
  edge?: number; // distance over which mud or firm fades in from the outline
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
export interface MapSpec {
  name: string;
  title: string;
  seed: number;
  width: number;
  height: number;
  scale: number; // noise wavelengths of the draft are multiplied by this
  baseFood?: number;
  basePoison?: number;
  layers: readonly MapLayer[];
  rock: readonly MapRock[];
}

export interface Disc {
  x: number;
  y: number;
  r: number;
}

export const WEIGHT_UNIT = 64; // weight byte per 1.0, so weights run from 0 to just under 4
export const CAP_CELL = 1000; // world units per cell of the local caps

// Food and poison weights on the nodes of the ground raster (same geometry as GroundField), and their mean per cap cell.
export class MapWeights {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly food: Uint8Array;
  readonly poison: Uint8Array;
  readonly maxFood: number;
  readonly maxPoison: number;
  readonly capCols: number;
  readonly capRows: number;
  readonly capArea: Float64Array; // world area of each cap cell (the last row and column are partial)
  readonly meanFood: Float64Array; // mean weight, 1 is plain
  readonly meanPoison: Float64Array;
  private readonly inv: number;

  readonly open: Float64Array; // share of each cap cell that is not under rock

  constructor(ground: GroundField, food: Uint8Array, poison: Uint8Array, rock: readonly Disc[]) {
    this.cell = ground.cell;
    this.cols = ground.cols;
    this.rows = ground.rows;
    this.inv = 1 / ground.cell;
    this.food = food;
    this.poison = poison;
    this.maxFood = food.reduce((m, v) => Math.max(m, v), 0);
    this.maxPoison = poison.reduce((m, v) => Math.max(m, v), 0);
    const { width, height } = ground;
    this.capCols = Math.ceil(width / CAP_CELL);
    this.capRows = Math.ceil(height / CAP_CELL);
    const n = this.capCols * this.capRows;
    this.capArea = new Float64Array(n);
    this.meanFood = new Float64Array(n);
    this.meanPoison = new Float64Array(n);
    const count = new Float64Array(n);
    this.open = openShares(rock, width, height, this.capCols, this.capRows);
    for (let j = GROUND_PAD; j < ground.rows - GROUND_PAD; j++) {
      for (let i = GROUND_PAD; i < ground.cols - GROUND_PAD; i++) {
        const x = (i - GROUND_PAD) * this.cell;
        const y = (j - GROUND_PAD) * this.cell;
        if (x >= width || y >= height) continue;
        const c = this.capIndex(x, y);
        count[c]!++;
        this.meanFood[c]! += food[j * ground.cols + i]! / WEIGHT_UNIT;
        this.meanPoison[c]! += poison[j * ground.cols + i]! / WEIGHT_UNIT;
      }
    }
    for (let cy = 0; cy < this.capRows; cy++) {
      for (let cx = 0; cx < this.capCols; cx++) {
        const c = cy * this.capCols + cx;
        this.capArea[c] = (Math.min(width, (cx + 1) * CAP_CELL) - cx * CAP_CELL) * (Math.min(height, (cy + 1) * CAP_CELL) - cy * CAP_CELL);
        if (count[c]! > 0) {
          this.meanFood[c]! /= count[c]!;
          this.meanPoison[c]! /= count[c]!;
        } else {
          this.meanFood[c] = this.meanPoison[c] = 1;
        }
      }
    }
  }

  // Whether the kind (0 food, 1 poison) has weight anywhere.
  usable(kind: number): boolean {
    return (kind === 0 ? this.maxFood : this.maxPoison) > 0;
  }

  get bytes(): number {
    return this.food.length + this.poison.length;
  }

  capIndex(x: number, y: number): number {
    const cx = Math.min(this.capCols - 1, Math.max(0, Math.floor(x / CAP_CELL)));
    const cy = Math.min(this.capRows - 1, Math.max(0, Math.floor(y / CAP_CELL)));
    return cy * this.capCols + cx;
  }

  // The weight byte of a kind (0 food, 1 poison) at (x, y): the nearest node's.
  byteAt(kind: number, x: number, y: number): number {
    const i = Math.min(this.cols - 2, Math.max(1, Math.round(x * this.inv) + GROUND_PAD));
    const j = Math.min(this.rows - 2, Math.max(1, Math.round(y * this.inv) + GROUND_PAD));
    return (kind === 0 ? this.food : this.poison)[j * this.cols + i]!;
  }

  // Whether a draw u in [0, 1) lands inside the weight of a kind at (x, y): accepted with probability weight / maximum weight.
  accepts(kind: number, x: number, y: number, u: number): boolean {
    return u * (kind === 0 ? this.maxFood : this.maxPoison) < this.byteAt(kind, x, y);
  }

  // Items allowed in each cap cell for a density of the kind (as the world setting): exactly round(density * perDensity) in all, shared out in
  // proportion to each cell's open (not under rock) area times its mean weight, rounded so the cells sum to the total (a cell of weight 0 holds none).
  limits(kind: number, density: number, perDensity: number): Int32Array {
    const mean = kind === 0 ? this.meanFood : this.meanPoison;
    const out = new Int32Array(this.capArea.length);
    const share = Float64Array.from(out, (_, c) => this.capArea[c]! * this.open[c]! * mean[c]!);
    const sum = share.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return out;
    const total = Math.round(density * perDensity);
    let run = 0;
    let before = 0;
    for (let c = 0; c < out.length; c++) {
      run += (total * share[c]!) / sum;
      const now = Math.round(run);
      out[c] = now - before;
      before = now;
    }
    return out;
  }
}

const OPEN_SAMPLES = 8; // sample points per side of a cap cell when finding its open share

// The share of each cap cell not covered by rock discs, from a grid of sample points.
function openShares(rock: readonly Disc[], width: number, height: number, cols: number, rows: number): Float64Array {
  const cell = 300; // grid of the discs by centre, wider than the largest disc reach below
  const gc = Math.ceil(width / cell);
  const grid = new Map<number, Disc[]>();
  for (const d of rock) {
    const key = Math.min(gc - 1, Math.floor(d.x / cell)) + gc * Math.floor(d.y / cell);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(d);
  }
  const blocked = (x: number, y: number): boolean => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let j = cy - 2; j <= cy + 2; j++) {
      for (let i = cx - 2; i <= cx + 2; i++) {
        if (i < 0 || j < 0 || i >= gc) continue;
        for (const d of grid.get(i + gc * j) ?? []) if ((d.x - x) ** 2 + (d.y - y) ** 2 < d.r * d.r) return true;
      }
    }
    return false;
  };
  const out = new Float64Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let free = 0;
      for (let j = 0; j < OPEN_SAMPLES; j++) {
        for (let i = 0; i < OPEN_SAMPLES; i++) {
          const x = Math.min(width - 1, (cx + (i + 0.5) / OPEN_SAMPLES) * CAP_CELL);
          const y = Math.min(height - 1, (cy + (j + 0.5) / OPEN_SAMPLES) * CAP_CELL);
          if (!blocked(x, y)) free++;
        }
      }
      out[cy * cols + cx] = free / OPEN_SAMPLES ** 2;
    }
  }
  return out;
}

export interface BuiltMap {
  ground: GroundField;
  weights: MapWeights;
  rock: Disc[];
  stats: { rockDiscs: number; massifDiscs: number; stones: number; mud: number; firm: number; rockShare: number };
}

const LIMITS = { layers: 64, points: 64, discs: 8000, area: 2e9 }; // of a spec, and the world area it may cover

const cubic = (x: number): number => x * x * (3 - 2 * x);
const valueNoise = (x: number, y: number, s: number): number => {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = cubic(x - i);
  const fy = cubic(y - j);
  const a = hash(i, j, s);
  const b = hash(i + 1, j, s);
  const c = hash(i, j + 1, s);
  const d = hash(i + 1, j + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
};
const fbm = (x: number, y: number, s: number): number => valueNoise(x, y, s) * 0.55 + valueNoise(x * 2.1, y * 2.1, s + 7) * 0.3 + valueNoise(x * 4.3, y * 4.3, s + 13) * 0.15;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const smoothRange = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

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

// Whether (x, y) is inside the polygon given as a flat x, y list.
const inside = (flat: Float64Array, x: number, y: number): boolean => {
  let c = false;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = flat[2 * i]!;
    const yi = flat[2 * i + 1]!;
    const xj = flat[2 * j]!;
    const yj = flat[2 * j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

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
}

// An outline's signed distance after domain warp, edge roughness and, for paths, width wobble.
function makeShape(layer: Outline, seed: number, k: number): Sdf {
  const sh = layer.shape;
  const amp = layer.warp ?? 900;
  const rough = layer.rough ?? 300;
  const w1 = WARP_WAVE * k;
  const w2 = WARP_WAVE_FINE * k;
  const warp = (x: number, y: number): Pt => [
    x + amp * (fbm(x / w1, y / w1, seed + 1) - 0.5) * 2 + amp * 0.35 * (valueNoise(x / w2, y / w2, seed + 3) - 0.5) * 2,
    y + amp * (fbm(x / w1, y / w1, seed + 2) - 0.5) * 2 + amp * 0.35 * (valueNoise(x / w2, y / w2, seed + 4) - 0.5) * 2,
  ];
  let raw: (x: number, y: number) => number;
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
      return inside(flat, x, y) ? -m : m;
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
      return Math.sqrt(m) - wAt(t) / 2;
    };
  }
  const margin = amp * 1.4 + rough * 1.5 + (layer.feather ?? 800) / 2 + 50 + (layer.band ?? 0); // beyond the box by this much the layer has no effect (the warp moves a point by at most 1.35 amp, the roughness by 1.4 rough)
  const n1 = ROUGH_WAVE * k;
  const n2 = ROUGH_WAVE_FINE * k;
  const box = { x0: pad.x0 - margin, x1: pad.x1 + margin, y0: pad.y0 - margin, y1: pad.y1 + margin };
  // The warped distance (the costly part, smooth at this scale) sampled on a lattice and interpolated; the roughness is added per point.
  const lc = Math.ceil((box.x1 - box.x0) / LATTICE) + 2;
  const lr = Math.ceil((box.y1 - box.y0) / LATTICE) + 2;
  const lat = new Float32Array(lc * lr);
  for (let j = 0; j < lr; j++) {
    for (let i = 0; i < lc; i++) {
      const [qx, qy] = warp(box.x0 + i * LATTICE, box.y0 + j * LATTICE);
      lat[j * lc + i] = raw(qx, qy);
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
    return d + rough * (fbm(x / n1, y / n1, seed + 5) - 0.5) * 2 + rough * 0.4 * (valueNoise(x / n2, y / n2, seed + 6) - 0.5) * 2;
  }) as Sdf;
  outline.pad = box;
  return outline;
}

const LATTICE = 192; // world units between samples of an outline's warped distance
const TAU = 2 * Math.PI;
const stoneSeed = (seed: number): number => seed * 7919 + 17; // the stone sampling stream of a map
// Wavelengths of the draft's noise in world units at scale 1, multiplied by the spec's scale.
const WARP_WAVE = 5200;
const WARP_WAVE_FINE = 1800;
const ROUGH_WAVE = 800;
const ROUGH_WAVE_FINE = 260;
const WIDTH_WAVE = 1700;
const WIDTH_WAVE_FINE = 600;
const PASS_WAVE = 500;
const ANGULAR_EDGE = 0.6; // radius of the discs along an angular stone's edge, in stone radii: the union edge scallops by about a tenth of it
const ANGULAR_CORNERS = [5, 6] as const;
const PEBBLE_EDGE = 0.5; // a pebble is two discs either side of a centre one
const PEBBLE_REACH = 0.55;
const MASS_EDGE_R_MIN = 42; // radius range and position jitter of the discs placed on every edge cell of a massif, so its edge follows the raster's steps instead of a few big circles
const MASS_EDGE_R_MAX = 62;
const MASS_EDGE_JITTER = 24;
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
    for (let k = 0; k < 2; k++) {
      const a = a0 + Math.PI * k + (rng() - 0.5) * 0.8;
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
}

export function buildMap(spec: MapSpec): BuiltMap {
  check(spec);
  const { width: W, height: H, seed } = spec;
  const k = spec.scale;
  const layers = spec.layers.map((layer, i) => ({ ...layer, outline: makeShape(layer, seed + 41 * i, k), i, thr: -1 }));
  for (const layer of layers) {
    const tx = layer.mud ?? layer.firm;
    if (!tx || tx.coverage >= 1) continue;
    const arr: number[] = [];
    for (let n = 0; n < 4000; n++) arr.push(fbm((hash(n, 1, 9) * 60000) / tx.scale, (hash(n, 2, 9) * 60000) / tx.scale, seed + 100 + layer.i));
    arr.sort((a, b) => a - b);
    layer.thr = arr[Math.floor((1 - tx.coverage) * 3999)]!;
  }
  // The field at a point: food and poison weights and the mud and firm shares, from the layers in order.
  const out = { food: 1, poison: 1, mud: 0, firm: 0 };
  const field = (x: number, y: number): void => {
    let food = spec.baseFood ?? 1;
    let poison = spec.basePoison ?? 1;
    let mud = 0;
    let firm = 0;
    for (const layer of layers) {
      const d = layer.outline(x, y);
      const fe = layer.feather ?? 800;
      if (d > fe / 2) continue;
      const m = clamp(0.5 - d / fe, 0, 1);
      const edge = layer.edge ?? 380;
      const ins = clamp(0.5 - d / edge, 0, 1);
      if (layer.food !== undefined) food += (layer.food - food) * m;
      if (layer.poison !== undefined) poison += (layer.poison - poison) * m;
      if (layer.clearMud) mud *= 1 - ins;
      if (layer.mud) {
        const tx = layer.mud;
        const n = tx.coverage >= 1 ? 1 : clamp(0.5 + (fbm(x / tx.scale, y / tx.scale, seed + 100 + layer.i) - layer.thr) * 10, 0, 1);
        mud = Math.max(mud, Math.min(ins, n));
      }
      if (layer.firm) {
        const tx = layer.firm;
        const n = tx.coverage >= 1 ? 1 : clamp(0.5 + (fbm(x / tx.scale, y / tx.scale, seed + 100 + layer.i) - layer.thr) * 10, 0, 1);
        firm = Math.max(firm, Math.min(clamp(0.5 - (d + (tx.inset ?? 0)) / edge, 0, 1), n));
      }
    }
    out.food = food;
    out.poison = poison;
    out.mud = mud;
    out.firm = firm;
  };

  // Ground and weights on the nodes of the ground raster; the padding ring stays 0 (weights too, never read there).
  const ground = new GroundField(W, H);
  const { cols, rows, cell } = ground;
  const food = new Uint8Array(cols * rows);
  const poison = new Uint8Array(cols * rows);
  let mudNodes = 0;
  let firmNodes = 0;
  for (let j = GROUND_PAD; j < rows - GROUND_PAD; j++) {
    for (let i = GROUND_PAD; i < cols - GROUND_PAD; i++) {
      field((i - GROUND_PAD) * cell, (j - GROUND_PAD) * cell);
      const n = j * cols + i;
      const mud = Math.round(out.mud * 255);
      const firm = Math.round(out.firm * 255);
      ground.data[2 * n] = firm > 127 ? Math.min(mud, 255 - firm) : mud; // one kind per point: firm ground wins over mud
      ground.data[2 * n + 1] = firm;
      food[n] = Math.round(clamp(out.food * WEIGHT_UNIT, 0, 255));
      poison[n] = Math.round(clamp(out.poison * WEIGHT_UNIT, 0, 255));
      if (ground.data[2 * n]! > 127) mudNodes++;
      if (firm > 127) firmNodes++;
    }
  }

  // Massifs: each a mask on a 50 unit grid (with its passes cut out), filled with discs from the widest inside outwards.
  const mcols = Math.ceil(W / MASS_CELL);
  const mrows = Math.ceil(H / MASS_CELL);
  const mask = new Uint8Array(mcols * mrows);
  const massifs = spec.rock.map((rockLayer, i) => ({ rockLayer, i })).filter(({ rockLayer }) => rockLayer.kind === "massif");
  for (const { rockLayer, i } of massifs) {
    const outline = makeShape(rockLayer, seed + 977 + 31 * i, k);
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
  spec.rock.forEach((rockLayer, ri) => {
    if (rockLayer.kind === "massif") return;
    const outline = makeShape(rockLayer, seed + 1977 + 31 * ri, k);
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
        if (rockLayer.passes?.some(([qx, qy, qr]) => Math.hypot(px - qx, py - qy) < qr)) continue;
        const fade = rockLayer.fadeX ? 1 - smoothRange(rockLayer.fadeX[0], rockLayer.fadeX[1], px) : 1;
        const clump = rockLayer.clump ? smoothRange(lo, hi, fbm(px / rockLayer.clump, py / rockLayer.clump, seed + 500 + ri)) * 2.6 : 1;
        const p = Math.min(1, ((rockLayer.cover * g * g) / avgA) * m * clump * fade);
        if (rng() > p) continue;
        const r = r0[0] + (r0[1] - r0[0]) * rng() ** 1.3;
        const nEx = Kd.ex[0] + Math.floor(rng() * (Kd.ex[1] - Kd.ex[0] + 1));
        if (px < r + 60 || py < r + 60 || px > W - r - 60 || py > H - r - 60) continue;
        if (!rockLayer.onMud && ground.valueAt(px, py) < 0) continue;
        if (massAt(px, py) > 0.2) continue;
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
  if (rock.length > LIMITS.discs) throw new Error(`map "${spec.name}": ${rock.length} rock discs, the limit is ${LIMITS.discs}`);

  let rockArea = 0;
  for (const d of rock) rockArea += Math.PI * d.r * d.r;
  const nodes = (cols - 2 * GROUND_PAD) * (rows - 2 * GROUND_PAD);
  return {
    ground,
    weights: new MapWeights(ground, food, poison, rock),
    rock,
    stats: { rockDiscs: rock.length, massifDiscs: massifDiscs, stones, mud: mudNodes / nodes, firm: firmNodes / nodes, rockShare: rockArea / (W * H) },
  };
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
  // Every cell next to the outside gets a small disc, which makes the edge a jagged line of short arcs that follows the mask.
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const n = cy * cols + cx;
      if (dist[n]! !== 1 || covered[n]) continue; // an edge cell already inside an earlier edge disc needs none
      const r = MASS_EDGE_R_MIN + (MASS_EDGE_R_MAX - MASS_EDGE_R_MIN) * hash(cx, cy, 7); // seeded radius and offset, so the edge is broken rock
      const jitter = (salt: number): number => (hash(cx, cy, salt) - 0.5) * MASS_EDGE_JITTER;
      discs.push({ x: Math.round((cx + 0.5) * MASS_CELL + jitter(8)), y: Math.round((cy + 0.5) * MASS_CELL + jitter(9)), r: Math.round(r) });
      cover(cx, cy, r);
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
