import { GROUND_PAD, GroundField } from "../groundField.ts";

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

  constructor(ground: GroundField, food: Uint8Array, poison: Uint8Array) {
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

  // Items allowed in each cap cell for a density of the kind (as the world setting): the cell's area share of the items at that density,
  // times its mean weight, rounded so that the cells sum to the rounded total (a cell of weight 0 holds none).
  limits(kind: number, density: number, perDensity: number): Int32Array {
    const area = this.capArea.reduce((s, a) => s + a, 0);
    const mean = kind === 0 ? this.meanFood : this.meanPoison;
    const out = new Int32Array(this.capArea.length);
    let run = 0;
    let before = 0;
    for (let c = 0; c < out.length; c++) {
      run += density * perDensity * (this.capArea[c]! / area) * mean[c]!;
      const now = Math.round(run);
      out[c] = now - before;
      before = now;
    }
    return out;
  }
}

export interface BuiltMap {
  ground: GroundField;
  weights: MapWeights;
  rock: Disc[];
  stats: { rockDiscs: number; massifDiscs: number; stones: number; mud: number; firm: number; rockShare: number };
}

const LIMITS = { layers: 64, points: 64, discs: 8000, area: 2e9 }; // of a spec, and the world area it may cover

const mulberry = (a: number) => (): number => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hash = (i: number, j: number, s: number): number => {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const sm = (x: number): number => x * x * (3 - 2 * x);
const vnoise = (x: number, y: number, s: number): number => {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = sm(x - i);
  const fy = sm(y - j);
  const a = hash(i, j, s);
  const b = hash(i + 1, j, s);
  const c = hash(i, j + 1, s);
  const d = hash(i + 1, j + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
};
const fbm = (x: number, y: number, s: number): number => vnoise(x, y, s) * 0.55 + vnoise(x * 2.1, y * 2.1, s + 7) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 13) * 0.15;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const sstep = (a: number, b: number, v: number): number => {
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
function makeShape(L: Outline, seed: number, k: number): Sdf {
  const sh = L.shape;
  const amp = L.warp ?? 900;
  const rough = L.rough ?? 300;
  const w1 = 5200 * k;
  const w2 = 1800 * k;
  const warp = (x: number, y: number): Pt => [
    x + amp * (fbm(x / w1, y / w1, seed + 1) - 0.5) * 2 + amp * 0.35 * (vnoise(x / w2, y / w2, seed + 3) - 0.5) * 2,
    y + amp * (fbm(x / w1, y / w1, seed + 2) - 0.5) * 2 + amp * 0.35 * (vnoise(x / w2, y / w2, seed + 4) - 0.5) * 2,
  ];
  let raw: (x: number, y: number) => number;
  let pad: { x0: number; x1: number; y0: number; y1: number };
  if (sh.type === "poly") {
    const poly = catmull(sh.pts, true, 14);
    const flat = Float64Array.from(poly.flat());
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    pad = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    raw = (x, y) => {
      let m = 1e18;
      for (let i = 0, j = flat.length / 2 - 1; i < flat.length / 2; j = i++) m = Math.min(m, toSegment(x, y, flat[2 * j]!, flat[2 * j + 1]!, flat[2 * i]!, flat[2 * i + 1]!));
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
      if (L.wobble) v *= 1 + L.wobble * (vnoise((t * total) / (1700 * k), 0.5, seed + 8) - 0.5) * 2 + 0.5 * L.wobble * (vnoise((t * total) / (600 * k), 1.5, seed + 9) - 0.5) * 2;
      if (L.taper) v *= 0.35 + 0.65 * sstep(0, 0.07, Math.min(t, 1 - t));
      return v;
    };
    const xs = path.map((p) => p[0]);
    const ys = path.map((p) => p[1]);
    const wm = Math.max(...w) * 1.6;
    pad = { x0: Math.min(...xs) - wm, x1: Math.max(...xs) + wm, y0: Math.min(...ys) - wm, y1: Math.max(...ys) + wm };
    raw = (x, y) => {
      let m = 1e18;
      let bt = 0;
      for (let i = 0; i < path.length - 1; i++) {
        const d = toSegment(x, y, path[i]![0], path[i]![1], path[i + 1]![0], path[i + 1]![1]);
        if (d < m) {
          m = d;
          bt = (cum[i]! + segU * Math.hypot(path[i + 1]![0] - path[i]![0], path[i + 1]![1] - path[i]![1])) / total;
        }
      }
      return Math.sqrt(m) - wAt(bt) / 2;
    };
  }
  const margin = amp * 1.4 + rough * 1.5 + (L.feather ?? 800) / 2 + 50 + (L.band ?? 0); // beyond the box by this much the layer has no effect (the warp moves a point by at most 1.35 amp, the roughness by 1.4 rough)
  const n1 = 800 * k;
  const n2 = 260 * k;
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
  const sd = ((x: number, y: number): number => {
    if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) return 1e9;
    const fx = (x - box.x0) / LATTICE;
    const fy = (y - box.y0) / LATTICE;
    const i = fx | 0;
    const j = fy | 0;
    const tx = fx - i;
    const ty = fy - j;
    const o = j * lc + i;
    let d = lat[o]! + (lat[o + 1]! - lat[o]!) * tx + (lat[o + lc]! - lat[o]!) * ty + (lat[o]! - lat[o + 1]! - lat[o + lc]! + lat[o + lc + 1]!) * tx * ty;
    if (L.band) d = Math.abs(d) - L.band;
    return d + rough * (fbm(x / n1, y / n1, seed + 5) - 0.5) * 2 + rough * 0.4 * (vnoise(x / n2, y / n2, seed + 6) - 0.5) * 2;
  }) as Sdf;
  sd.pad = box;
  return sd;
}

const LATTICE = 128; // world units between samples of an outline's warped distance
const MASS_CELL = 50; // world units of the massif mask grid
const MASS_MAX_R = 300; // largest disc of a massif
const MASS_MIN_R = 30;
const TALUS = { g: 170, r: [60, 150], ex: [0, 2], gap: 70 } as const;
const OUTCROP = { g: 420, r: [170, 380], ex: [2, 5], gap: 140 } as const;

function check(spec: MapSpec): void {
  const bad = (what: string): never => {
    throw new Error(`map "${spec.name}": ${what}`);
  };
  if (!(spec.width >= 500 && spec.height >= 500 && spec.width * spec.height <= LIMITS.area)) bad("size is out of bounds");
  if (spec.layers.length > LIMITS.layers || spec.rock.length > LIMITS.layers) bad("too many layers");
  for (const L of [...spec.layers, ...spec.rock]) {
    const n = L.shape.type === "poly" ? L.shape.pts.length : L.shape.path.length;
    if (n > LIMITS.points || n < 2) bad(`layer "${L.id}" has ${n} points`);
  }
}

export function buildMap(spec: MapSpec): BuiltMap {
  check(spec);
  const { width: W, height: H, seed } = spec;
  const k = spec.scale;
  const layers = spec.layers.map((L, i) => ({ ...L, sd: makeShape(L, seed + 41 * i, k), i, thr: -1 }));
  for (const L of layers) {
    const tx = L.mud ?? L.firm;
    if (!tx || tx.coverage >= 1) continue;
    const arr: number[] = [];
    for (let n = 0; n < 4000; n++) arr.push(fbm((hash(n, 1, 9) * 60000) / tx.scale, (hash(n, 2, 9) * 60000) / tx.scale, seed + 100 + L.i));
    arr.sort((a, b) => a - b);
    L.thr = arr[Math.floor((1 - tx.coverage) * 3999)]!;
  }
  // The field at a point: food and poison weights and the mud and firm shares, from the layers in order.
  const out = { food: 1, poison: 1, mud: 0, firm: 0 };
  const field = (x: number, y: number): void => {
    let food = spec.baseFood ?? 1;
    let poison = spec.basePoison ?? 1;
    let mud = 0;
    let firm = 0;
    for (const L of layers) {
      const d = L.sd(x, y);
      const fe = L.feather ?? 800;
      if (d > fe / 2) continue;
      const m = clamp(0.5 - d / fe, 0, 1);
      const edge = L.edge ?? 380;
      const ins = clamp(0.5 - d / edge, 0, 1);
      if (L.food !== undefined) food += (L.food - food) * m;
      if (L.poison !== undefined) poison += (L.poison - poison) * m;
      if (L.clearMud) mud *= 1 - ins;
      if (L.mud) {
        const tx = L.mud;
        const n = tx.coverage >= 1 ? 1 : clamp(0.5 + (fbm(x / tx.scale, y / tx.scale, seed + 100 + L.i) - L.thr) * 10, 0, 1);
        mud = Math.max(mud, Math.min(ins, n));
      }
      if (L.firm) {
        const tx = L.firm;
        const n = tx.coverage >= 1 ? 1 : clamp(0.5 + (fbm(x / tx.scale, y / tx.scale, seed + 100 + L.i) - L.thr) * 10, 0, 1);
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
  const massifs = spec.rock.map((R, i) => ({ R, i })).filter(({ R }) => R.kind === "massif");
  for (const { R, i } of massifs) {
    const sd = makeShape(R, seed + 977 + 31 * i, k);
    const fe = R.feather ?? 800;
    const passes = R.passes ?? [];
    const nw = 500 * k;
    for (let cy = Math.max(0, Math.floor(sd.pad.y0 / MASS_CELL)); cy < Math.min(mrows, Math.ceil(sd.pad.y1 / MASS_CELL)); cy++) {
      for (let cx = Math.max(0, Math.floor(sd.pad.x0 / MASS_CELL)); cx < Math.min(mcols, Math.ceil(sd.pad.x1 / MASS_CELL)); cx++) {
        const x = (cx + 0.5) * MASS_CELL;
        const y = (cy + 0.5) * MASS_CELL;
        let q = clamp(0.5 - sd(x, y) / fe, 0, 1);
        if (q <= 0) continue;
        for (const [px, py, pr] of passes) q = Math.min(q, clamp((Math.hypot(x - px, y - py) / (pr * (0.85 + 0.3 * vnoise(x / nw, y / nw, seed + 9 + i))) - 0.78) * 4, 0, 1));
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
  const rng = mulberry(seed * 7919 + 17);
  const taken = new Map<number, Disc[]>(); // bounding discs of the placed stones by 400 unit cell
  const keyOf = (cx: number, cy: number): number => cx * 100003 + cy;
  const hit = (x: number, y: number, r: number, gap: number): boolean => {
    const cx = Math.floor(x / 400);
    const cy = Math.floor(y / 400);
    for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) for (const p of taken.get(keyOf(cx + a, cy + b)) ?? []) if (Math.hypot(p.x - x, p.y - y) < r + p.r + gap) return true;
    return false;
  };
  let stones = 0;
  spec.rock.forEach((R, ri) => {
    if (R.kind === "massif") return;
    const sd = makeShape(R, seed + 1977 + 31 * ri, k);
    const feather = R.feather ?? 1200;
    const Kd = R.kind === "talus" ? TALUS : OUTCROP;
    const r0 = R.r ?? Kd.r;
    const g = R.g ?? Kd.g;
    const avgR = (r0[0] + r0[1]) / 2;
    const avgA = 0.3 * Math.PI * avgR * avgR * (1 + ((Kd.ex[0] + Kd.ex[1]) / 2) * 0.45);
    const pw = R.pow ?? 1.5;
    const lo = R.clumpLo ?? 0.42;
    const hi = R.clumpHi ?? 0.62;
    for (let y = Math.max(0, sd.pad.y0); y < Math.min(H, sd.pad.y1); y += g) {
      for (let x = Math.max(0, sd.pad.x0); x < Math.min(W, sd.pad.x1); x += g) {
        const px = x + rng() * g;
        const py = y + rng() * g;
        const d = sd(px, py);
        if (d > feather / 2) continue;
        const m = clamp(0.5 - d / feather, 0, 1) ** pw;
        if (R.passes?.some(([qx, qy, qr]) => Math.hypot(px - qx, py - qy) < qr)) continue;
        const fade = R.fadeX ? 1 - sstep(R.fadeX[0], R.fadeX[1], px) : 1;
        const clump = R.clump ? sstep(lo, hi, fbm(px / R.clump, py / R.clump, seed + 500 + ri)) * 2.6 : 1;
        const p = Math.min(1, ((R.cover * g * g) / avgA) * m * clump * fade);
        if (rng() > p) continue;
        const r = r0[0] + (r0[1] - r0[0]) * rng() ** 1.3;
        const nEx = Kd.ex[0] + Math.floor(rng() * (Kd.ex[1] - Kd.ex[0] + 1));
        if (px < r + 60 || py < r + 60 || px > W - r - 60 || py > H - r - 60) continue;
        if (!R.onMud && ground.valueAt(px, py) < 0) continue;
        if (massAt(px, py) > 0.2) continue;
        const discs: Disc[] = [{ x: px, y: py, r }];
        const ang = rng() * 6.28;
        for (let e = 0; e < nEx; e++) {
          const t = ((e + 1) / (nEx + 1)) * 2 - 1;
          const off = r * (1.0 * t + 0.4 * (rng() - 0.5));
          const side = r * 0.35 * (rng() - 0.5) * 2;
          discs.push({ x: px + off * Math.cos(ang) - side * Math.sin(ang), y: py + off * Math.sin(ang) + side * Math.cos(ang), r: r * (0.5 + 0.35 * rng()) });
        }
        const bound = r * 1.5 + (nEx ? r * 0.8 : 0);
        if (hit(px, py, bound, Kd.gap)) continue;
        if (!R.onMud && discs.some((q) => ground.valueAt(q.x, q.y) < 0)) continue;
        const key = keyOf(Math.floor(px / 400), Math.floor(py / 400));
        if (!taken.has(key)) taken.set(key, []);
        taken.get(key)!.push({ x: px, y: py, r: bound });
        for (const q of discs) rock.push({ x: Math.round(q.x), y: Math.round(q.y), r: Math.round(q.r) });
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
    weights: new MapWeights(ground, food, poison),
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
  for (const n of order) {
    if (covered[n]) continue;
    const cx = n % cols;
    const cy = (n - cx) / cols;
    const r = clamp((dist[n]! - 0.5) * MASS_CELL, MASS_MIN_R, MASS_MAX_R);
    const x = (cx + 0.5) * MASS_CELL;
    const y = (cy + 0.5) * MASS_CELL;
    discs.push({ x: Math.round(x), y: Math.round(y), r: Math.round(r) });
    const reach = Math.ceil(r / MASS_CELL);
    for (let j = Math.max(0, cy - reach); j <= Math.min(rows - 1, cy + reach); j++) {
      for (let i = Math.max(0, cx - reach); i <= Math.min(cols - 1, cx + reach); i++) if (((i - cx) * MASS_CELL) ** 2 + ((j - cy) * MASS_CELL) ** 2 <= r * r) covered[j * cols + i] = 1;
    }
  }
  return discs;
}
