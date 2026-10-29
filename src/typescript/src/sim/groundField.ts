import { deriveSeed } from "./rng.ts";
import type { StatefulRng } from "./rng.ts";

// The mud and firm ground of a map as a smooth field on a coarse raster, built once per map from the seed and the world settings.
// A layer (mud, firm) holds one byte per node, stored interleaved (0 .. 255, the share of "this kind" at the node). Between nodes the value is the bilinear blend of the four
// corners, and the ground there is of that kind where the blend is at least 127.5 (one half). The drawn outline is the same threshold of the
// same blend (ui/groundOutline.ts), so what is drawn and what creatures sense agree by construction.
// The two kinds never reach one half at the same point (the builder keeps mud + firm <= 255 at every node), so a point has one kind.
// Food and poison weights can be added later as more layers on the same nodes (the "biome raster" of docs/world-maps/2026-10-12-draft3-notes.md).
//
// Memory: nodes = (ceil(w / cell) + 3) * (ceil(h / cell) + 3) with cell = max(50, ceil(sqrt(w * h / 250000))), at most about 253 000 nodes, so
// at most about 506 kB for the two layers (50000 x 50000: cell 100, 503 x 503 nodes, 506 kB) plus a transient 2 MB of float scratch (one depth field per kind) while building.

export const GROUND_MIN_CELL = 50; // world units per raster cell, smallest
export const GROUND_MAX_CELLS = 250_000; // cells (about nodes) of any map, which raises the cell size of worlds above 50000 x 50000
export const GROUND_HALF = 127.5; // a layer value at or above this is of the layer's kind
export const GROUND_BLOCK_SHIFT = 3; // log2 of the cells per side of a block of blockFlags
export const GROUND_PAD = 1; // nodes beyond the world on each side, held at 0 so every outline closes inside the raster

// Keeps mud + firm <= 255 at every node of interleaved ground data by capping the other layer at what the winner (0 mud, 1 firm) leaves. Both builders use it.
export function oneKindPerNode(data: Uint8Array, winner: 0 | 1): void {
  for (let k = 0; k < data.length; k += 2) if (data[k]! + data[k + 1]! > 255) data[k + 1 - winner] = 255 - data[k + winner]!;
}

export interface BlobSpec {
  density: number; // share of the world area to cover
  size: number; // multiple of the standard patch
  rng: StatefulRng;
}

export class GroundField {
  readonly width: number;
  readonly height: number;
  readonly cell: number;
  readonly cols: number; // nodes per row; node (i, j) sits at world ((i - GROUND_PAD) * cell, (j - GROUND_PAD) * cell)
  readonly rows: number;
  readonly data: Uint8Array; // two bytes per node, mud then firm, so one cache line serves both kinds
  readonly inv: number; // 1 / cell

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cell = Math.max(GROUND_MIN_CELL, Math.ceil(Math.sqrt((width * height) / GROUND_MAX_CELLS)));
    this.cols = Math.ceil(width / this.cell) + 1 + 2 * GROUND_PAD;
    this.rows = Math.ceil(height / this.cell) + 1 + 2 * GROUND_PAD;
    this.data = new Uint8Array(2 * this.cols * this.rows);
    this.inv = 1 / this.cell;
  }

  get bytes(): number {
    return this.data.length;
  }

  // Sets a node of a layer (0 mud, 1 firm) by its world position (a multiple of cell), for hand-made fields.
  set(layer: number, x: number, y: number, value: number): void {
    this.data[2 * ((Math.round(y * this.inv) + GROUND_PAD) * this.cols + Math.round(x * this.inv) + GROUND_PAD) + layer] = value;
  }

  // The bilinear blend of a layer at (x, y), inside the world.
  blend(layer: number, x: number, y: number): number {
    const fx = Math.min(this.cols - 1.0001, Math.max(0, x * this.inv + GROUND_PAD));
    const fy = Math.min(this.rows - 1.0001, Math.max(0, y * this.inv + GROUND_PAD));
    const i = fx | 0;
    const j = fy | 0;
    const k = 2 * (j * this.cols + i) + layer;
    const row = 2 * this.cols;
    const g = this.data;
    const a = g[k]!;
    const b = g[k + 2]!;
    const c = g[k + row]!;
    return a + (b - a) * (fx - i) + (c - a) * (fy - j) + (a - b - c + g[k + row + 2]!) * (fx - i) * (fy - j);
  }

  // One byte per block of 2^GROUND_BLOCK_SHIFT squared cells (row-major, `cols` per row): 1 when a corner node of one of its cells reaches 128 in either layer, so valueAt can be nonzero there.
  blockFlags(): { flags: Uint8Array; cols: number } {
    const s = GROUND_BLOCK_SHIFT;
    const cols = ((this.cols - 2) >> s) + 1;
    const flags = new Uint8Array(cols * (((this.rows - 2) >> s) + 1));
    const g = this.data;
    for (let j = 0; j < this.rows; j++) {
      const b0 = Math.max(0, j - 1) >> s; // the cells at or left of the node, rows j - 1 and j, as far as they exist
      const b1 = Math.min(this.rows - 2, j) >> s;
      for (let i = 0; i < this.cols; i++) {
        if (((g[2 * (j * this.cols + i)]! | g[2 * (j * this.cols + i) + 1]!) & 128) === 0) continue;
        const a1 = Math.min(this.cols - 2, i) >> s;
        for (let b = b0; b <= b1; b++) for (let a = Math.max(0, i - 1) >> s; a <= a1; a++) flags[b * cols + a] = 1;
      }
    }
    return { flags, cols };
  }

  // -1 on mud, 1 on firm ground, 0 elsewhere. The hot path of every creature every tick: two cache lines, and the blend only where a corner is high enough.
  valueAt(x: number, y: number): number {
    const cols = this.cols;
    const fx = Math.min(cols - 1.0001, Math.max(0, x * this.inv + GROUND_PAD));
    const fy = Math.min(this.rows - 1.0001, Math.max(0, y * this.inv + GROUND_PAD));
    const i = fx | 0;
    const j = fy | 0;
    const k = 2 * (j * cols + i);
    const row = k + 2 * cols;
    const g = this.data;
    const tx = fx - i;
    const ty = fy - j;
    let a = g[k]!;
    let b = g[k + 2]!;
    let c = g[row]!;
    let d = g[row + 2]!;
    if ((a >= 128 || b >= 128 || c >= 128 || d >= 128) && a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty >= GROUND_HALF) return -1;
    a = g[k + 1]!;
    b = g[k + 3]!;
    c = g[row + 1]!;
    d = g[row + 3]!;
    if ((a >= 128 || b >= 128 || c >= 128 || d >= 128) && a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty >= GROUND_HALF) return 1;
    return 0; // below one half whatever the blend, where no corner reaches 128
  }
}

// Value noise on an integer lattice: smooth, in 0 .. 1, deterministic from the salt with integer arithmetic and no trigonometry.
export function hash(i: number, j: number, s: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export const CUBIC_FADE = (t: number): number => t * t * (3 - 2 * t);
export const QUINTIC_FADE = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
export function valueNoise(x: number, y: number, s: number, fade: (t: number) => number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = fade(x - i);
  const fy = fade(y - j);
  const a = hash(i, j, s);
  const b = hash(i + 1, j, s);
  const c = hash(i, j + 1, s);
  const d = hash(i + 1, j + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
const noise = (x: number, y: number, s: number): number => valueNoise(x, y, s, QUINTIC_FADE);

// Polynomial smooth maximum: the larger of two, rounded off where they are within k of each other, so merged lobes have no crease.
const SMOOTH = 0.5;
function smax(a: number, b: number): number {
  const h = Math.max(SMOOTH - Math.abs(a - b), 0) / SMOOTH;
  return Math.max(a, b) + (h * h * SMOOTH) / 4;
}

interface Ellipse {
  x: number;
  y: number;
  a: number; // semi-axes along and across the angle
  b: number;
  cos: number;
  sin: number;
}
interface Blob {
  kind: number;
  x: number;
  y: number;
  r: number; // the standard radius
  reach: number; // largest distance from the centre to the edge of any lobe
  parts: Ellipse[];
  salt: number;
}

const PATCH_RADIUS = 1.15; // the standard radius against the old disc patches, so a blob covers about the area one did (300 of them cover 16% of 50000 x 50000, as before)
const WARP = 0.55; // domain warp amplitude, in blob radii
const WARP_WAVE = 1.15; // its wavelength in blob radii, never less than 5.5 cells so the raster resolves it
const DETAIL = 0.07; // edge wobble amplitude in normalised units (1 is the blob radius)
const DETAIL_WAVE = 0.45; // its wavelength in blob radii, never less than 4 cells
const SLOPE = 2.2; // layer value per normalised unit of depth: 0.5 at the edge, saturating a fifth of a radius inside
const BLUR = 1; // passes of a light 3 x 3 smoothing of the finished depth field, which rounds off sharp notches
const MIN_RADIUS = 1.5; // in cells: a blob smaller than this would fall between the nodes and vanish

// A blob: one broad ellipse and two to four lobes around it, each at its own angle and aspect, no circles.
function blob(rng: StatefulRng, w: number, h: number, cell: number, kind: number, size: number, salt: number, first: boolean): Blob {
  const r = Math.max(MIN_RADIUS * cell, PATCH_RADIUS * Math.min(550, Math.max(150, 0.08 * Math.min(w, h))) * rng.range(0.8, 1.2) * size);
  const edge = first ? 0.8 * r : 0; // the first patch of a kind lies inside the world, so a tiny one is not cut away at a wall
  const x = rng.range(Math.min(edge, w / 2), Math.max(w - edge, w / 2));
  const y = rng.range(Math.min(edge, h / 2), Math.max(h - edge, h / 2));
  const part = (px: number, py: number, a: number, b: number): Ellipse => {
    const t = rng.range(0, Math.PI);
    return { x: px, y: py, a, b, cos: Math.cos(t), sin: Math.sin(t) };
  };
  const parts = [part(x, y, r * rng.range(0.95, 1.25), r * rng.range(0.55, 0.85))];
  for (let k = 0, n = 2 + rng.int(3); k < n; k++) {
    const t = rng.range(0, 2 * Math.PI);
    const d = r * rng.range(0.5, 0.95);
    const s = r * rng.range(0.4, 0.7);
    parts.push(part(x + d * Math.cos(t), y + d * Math.sin(t), s * rng.range(0.9, 1.3), s * rng.range(0.55, 0.9)));
  }
  const reach = parts.reduce((m, p) => Math.max(m, Math.hypot(p.x - x, p.y - y) + p.a), 0);
  return { kind, x, y, r, reach, parts, salt };
}

// Whether two blobs may both be placed, lobe against lobe: the same kind may overlap a little (and then merge), different kinds keep clear of
// each other with room for the warp.
function apart(p: Blob, q: Blob): boolean {
  const gap = p.kind === q.kind ? 0 : 0.15 * (p.r + q.r);
  if (Math.hypot(p.x - q.x, p.y - q.y) >= p.reach + q.reach + gap) return true; // their bounding circles are clear: no lobe pair can touch
  const share = p.kind === q.kind ? 0.75 : 0.9;
  return p.parts.every((u) => q.parts.every((v) => Math.hypot(u.x - v.x, u.y - v.y) >= share * (u.a + v.a) + gap));
}

// Adds a blob to the scratch depth field m (positive inside, 0 at the edge, in normalised units) of its kind; returns the nodes newly inside.
// Only nodes inside the world and its far side are painted, so the ring of padding nodes stays outside and every outline closes.
function paint(f: GroundField, m: Float32Array, b: Blob): number {
  const { cell, cols, rows } = f;
  const span = b.reach + b.r * (WARP + 0.5);
  const i0 = Math.max(GROUND_PAD, Math.floor((b.x - span) / cell) + GROUND_PAD);
  const i1 = Math.min(cols - 1 - GROUND_PAD, Math.ceil((b.x + span) / cell) + GROUND_PAD);
  const j0 = Math.max(GROUND_PAD, Math.floor((b.y - span) / cell) + GROUND_PAD);
  const j1 = Math.min(rows - 1 - GROUND_PAD, Math.ceil((b.y + span) / cell) + GROUND_PAD);
  const warp = 2 * WARP * b.r;
  const lam = 1 / Math.max(WARP_WAVE * b.r, 5.5 * cell);
  const lamD = 1 / Math.max(DETAIL_WAVE * b.r, 4 * cell);
  let added = 0;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const px = (i - GROUND_PAD) * cell;
      const py = (j - GROUND_PAD) * cell;
      if ((px - b.x) ** 2 + (py - b.y) ** 2 > span * span) continue; // out of reach: the field stays outside here
      const qx = px + warp * (noise(px * lam, py * lam, b.salt) - 0.5);
      const qy = py + warp * (noise(px * lam + 31.7, py * lam + 11.3, b.salt + 7) - 0.5);
      let depth = -Infinity;
      for (const p of b.parts) {
        const dx = qx - p.x;
        const dy = qy - p.y;
        const u = (dx * p.cos + dy * p.sin) / p.a;
        const v = (dy * p.cos - dx * p.sin) / p.b;
        const t = 1 - Math.sqrt(u * u + v * v);
        depth = depth === -Infinity ? t : smax(depth, t);
      }
      depth += DETAIL * 2 * (noise(px * lamD, py * lamD, b.salt + 13) - 0.5);
      const k = j * cols + i;
      const was = m[k]!;
      if (depth > was) {
        m[k] = depth;
        if (was < 0 && depth >= 0) added++;
      }
    }
  }
  return added;
}

// A [1 2 1] x [1 2 1] smoothing of the interior of a depth field; the padding ring keeps its outside value.
function blur(f: GroundField, m: Float32Array): Float32Array {
  const { cols, rows } = f;
  const out = m.slice();
  for (let j = GROUND_PAD; j < rows - GROUND_PAD; j++) {
    for (let i = GROUND_PAD; i < cols - GROUND_PAD; i++) {
      const k = j * cols + i;
      out[k] = (4 * m[k]! + 2 * (m[k - 1]! + m[k + 1]! + m[k - cols]! + m[k + cols]!) + m[k - cols - 1]! + m[k - cols + 1]! + m[k + cols - 1]! + m[k + cols + 1]!) / 16;
    }
  }
  return out;
}

export interface BuildLimits {
  maxBlobs: number; // blobs of one kind, however high the setting, so a map stays cheap to build
  tries: number; // placements tried per blob before giving up on the rest of its kind
}

// Builds the ground of a map: blobs of each kind are placed until they cover their density (at least one, at most limits.maxBlobs), painted as a
// smooth depth field with a domain warp and an edge wobble, then turned into the two byte layers. Same inputs, same raster, on every thread.
export function buildGroundField(width: number, height: number, specs: readonly BlobSpec[], seed: number, limits: BuildLimits): GroundField | null {
  if (!specs.some((s) => s.density > 0)) return null;
  const f = new GroundField(width, height);
  const placed: Blob[] = [];
  const nodeArea = f.cell * f.cell;
  // The kinds take turns placing one blob each, so neither crowds the other out; the one with the bigger patches goes first, as it finds room hardest.
  const order = specs.map((_, layer) => layer).sort((p, q) => specs[q]!.size - specs[p]!.size);
  const state = specs.map((spec) => ({ m: new Float32Array(spec.density > 0 ? f.cols * f.rows : 0).fill(-1), covered: 0, count: 0, done: !(spec.density > 0) }));
  while (state.some((s) => !s.done)) {
    for (const layer of order) {
      const s = state[layer]!;
      const spec = specs[layer]!;
      if (s.done) continue;
      if ((s.covered >= spec.density * width * height && s.count > 0) || s.count >= limits.maxBlobs) {
        s.done = true;
        continue;
      }
      let found: Blob | null = null;
      let last: Blob | null = null;
      for (let t = 0; t < limits.tries && !found; t++) {
        last = blob(spec.rng, width, height, f.cell, layer, spec.size, deriveSeed(seed, 0x91d, layer, s.count) | 0, s.count === 0);
        if (placed.every((p) => apart(last!, p))) found = last;
      }
      if (!found && s.count === 0) found = last; // a kind with a density always gets its first patch, crowded or not
      if (!found) {
        s.done = true;
        continue;
      }
      placed.push(found);
      s.count++;
      s.covered += paint(f, s.m, found) * nodeArea;
    }
  }
  specs.forEach((spec, layer) => {
    let m: Float32Array = state[layer]!.m;
    for (let pass = 0; pass < BLUR && m.length > 0; pass++) m = blur(f, m);
    for (let k = 0; k < m.length; k++) f.data[2 * k + layer] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + SLOPE * m[k]!)));
  });
  oneKindPerNode(f.data, 0);
  return f;
}
