import { createRng } from "../sim/rng.ts";
import type { Terrain } from "../sim/terrain.ts";

// Turns the rock discs of a map into drawable bodies: one per connected lump of rock, each with a smooth outline that follows the
// exact union of its discs (so what creatures bounce off is what is drawn), facets for shading and a few cracks. Built once per map.

export interface RockBody {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  loops: number[][]; // closed outlines as flat x, y lists, simplified to straight edges; draw them with traceLoop
  shading(): { facets: number[][][]; cracks: number[][] }; // facets per tone class (see TONES) as polygons, cracks as polylines, all flat x, y lists
}

export const TONES = 4; // facet tone classes, darkest first: dark 2, dark 1, light 1, light 2
const CELL = 6; // world units of the contour grid
const SIMPLIFY = 0.9; // world units a simplified outline may stray from the contour, so round lumps become angular stones
const CORNER = 2; // world units a corner is rounded over, on each side
const FACET = 110; // world units between facet seeds
export const LIGHT = { x: -0.6, y: -0.8 }; // direction towards the light, upper left

export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  closePath(): void;
}

// Draws a closed outline as straight edges with each corner rounded over CORNER units (less on short edges), so stones stay angular
// and the curve never strays more than about SIMPLIFY from the disc union.
export function traceLoop(path: PathSink, pts: readonly number[]): void {
  const n = pts.length / 2;
  const at = (i: number): [number, number] => [pts[2 * ((i + n) % n)]!, pts[2 * ((i + n) % n) + 1]!];
  for (let i = 0; i < n; i++) {
    const [px, py] = at(i - 1);
    const [vx, vy] = at(i);
    const [nx, ny] = at(i + 1);
    const l1 = Math.hypot(vx - px, vy - py) || 1;
    const l2 = Math.hypot(nx - vx, ny - vy) || 1;
    const t1 = Math.min(CORNER, 0.4 * l1);
    const t2 = Math.min(CORNER, 0.4 * l2);
    const ax = vx + ((px - vx) / l1) * t1;
    const ay = vy + ((py - vy) / l1) * t1;
    if (i === 0) path.moveTo(ax, ay);
    else path.lineTo(ax, ay);
    path.quadraticCurveTo(vx, vy, vx + ((nx - vx) / l2) * t2, vy + ((ny - vy) / l2) * t2);
  }
  path.closePath();
}

// Groups of discs that overlap each other, as lists of disc indices.
function lumps(t: Terrain): number[][] {
  const parent = Int32Array.from({ length: t.rockCount }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const range = new Int32Array(4);
  for (let i = 0; i < t.rockCount; i++) {
    const x = t.rockX[i]!;
    const y = t.rockY[i]!;
    const r = t.rockR[i]!;
    t.cellRange(x, y, r, range);
    for (let cy = range[2]!; cy <= range[3]!; cy++) {
      for (let k = t.rockStart[cy * t.cols + range[0]!]!, end = t.rockStart[cy * t.cols + range[1]! + 1]!; k < end; k++) {
        const j = t.rockOrder[k]!;
        if (j > i && (x - t.rockX[j]!) ** 2 + (y - t.rockY[j]!) ** 2 < (r + t.rockR[j]!) ** 2) parent[find(j)] = find(i);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < t.rockCount; i++) {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(i);
    else groups.set(root, [i]);
  }
  return [...groups.values()];
}

// Douglas-Peucker on the open polyline pts[a..b] (inclusive, flat x, y), appending the kept indices after a.
function simplifyRun(pts: number[], a: number, b: number, tol: number, keep: number[]): void {
  const stack: number[][] = [[a, b]];
  const kept = new Set<number>();
  while (stack.length > 0) {
    const [i, j] = stack.pop() as [number, number];
    const ax = pts[2 * i]!;
    const ay = pts[2 * i + 1]!;
    const dx = pts[2 * j]! - ax;
    const dy = pts[2 * j + 1]! - ay;
    const len = Math.hypot(dx, dy) || 1;
    let far = -1;
    let worst = tol;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((pts[2 * k]! - ax) * dy - (pts[2 * k + 1]! - ay) * dx) / len;
      if (d > worst) {
        worst = d;
        far = k;
      }
    }
    if (far >= 0) {
      kept.add(far);
      stack.push([i, far], [far, j]);
    }
  }
  for (const k of [...kept].sort((p, q) => p - q)) keep.push(k);
}

function simplifyLoop(pts: number[]): number[] {
  const n = pts.length / 2;
  if (n < 8) return pts;
  let far = 0;
  let best = 0;
  for (let k = 1; k < n; k++) {
    const d = Math.hypot(pts[2 * k]! - pts[0]!, pts[2 * k + 1]! - pts[1]!);
    if (d > best) {
      best = d;
      far = k;
    }
  }
  const idx = [0];
  simplifyRun(pts, 0, far, SIMPLIFY, idx);
  idx.push(far);
  // second half runs far .. n (n is point 0 again)
  const wrapped = pts.concat(pts[0]!, pts[1]!);
  simplifyRun(wrapped, far, n, SIMPLIFY, idx);
  const out: number[] = [];
  for (const k of idx) out.push(wrapped[2 * k]!, wrapped[2 * k + 1]!);
  return out;
}

// Marching squares of the field f (positive inside) on a w x h grid of nodes at (ox + i * CELL, oy + j * CELL): closed outlines.
function contours(f: Float32Array, w: number, h: number, ox: number, oy: number): number[][] {
  const at = new Map<number, [number, number]>(); // edge key to the point where the contour crosses it
  const next = new Map<number, number[]>(); // edge key to the two edges it joins
  const hEdge = (i: number, j: number): number => 2 * (j * w + i); // between node (i, j) and (i + 1, j)
  const vEdge = (i: number, j: number): number => 2 * (j * w + i) + 1; // between node (i, j) and (i, j + 1)
  const cross = (key: number, i: number, j: number, vertical: boolean): void => {
    if (at.has(key)) return;
    const a = f[j * w + i]!;
    const b = vertical ? f[(j + 1) * w + i]! : f[j * w + i + 1]!;
    const s = a / (a - b);
    at.set(key, vertical ? [ox + i * CELL, oy + (j + s) * CELL] : [ox + (i + s) * CELL, oy + j * CELL]);
  };
  const link = (p: number, q: number): void => {
    (next.get(p) ?? next.set(p, []).get(p)!).push(q);
    (next.get(q) ?? next.set(q, []).get(q)!).push(p);
  };
  for (let j = 0; j + 1 < h; j++) {
    for (let i = 0; i + 1 < w; i++) {
      const a = f[j * w + i]! > 0;
      const b = f[j * w + i + 1]! > 0;
      const c = f[(j + 1) * w + i + 1]! > 0;
      const d = f[(j + 1) * w + i]! > 0;
      if (a === b && b === c && c === d) continue;
      const top = a !== b;
      const right = b !== c;
      const bottom = d !== c;
      const left = a !== d;
      const edges: number[] = [];
      if (top) {
        cross(hEdge(i, j), i, j, false);
        edges.push(hEdge(i, j));
      }
      if (right) {
        cross(vEdge(i + 1, j), i + 1, j, true);
        edges.push(vEdge(i + 1, j));
      }
      if (bottom) {
        cross(hEdge(i, j + 1), i, j + 1, false);
        edges.push(hEdge(i, j + 1));
      }
      if (left) {
        cross(vEdge(i, j), i, j, true);
        edges.push(vEdge(i, j));
      }
      if (edges.length === 2) link(edges[0]!, edges[1]!);
      else if (edges.length === 4) {
        const centre = (f[j * w + i]! + f[j * w + i + 1]! + f[(j + 1) * w + i + 1]! + f[(j + 1) * w + i]!) / 4 > 0;
        if (centre === a) {
          link(hEdge(i, j), vEdge(i + 1, j));
          link(hEdge(i, j + 1), vEdge(i, j));
        } else {
          link(hEdge(i, j), vEdge(i, j));
          link(vEdge(i + 1, j), hEdge(i, j + 1));
        }
      }
    }
  }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const pts: number[] = [];
    let prev = -1;
    let cur = start;
    while (!seen.has(cur)) {
      seen.add(cur);
      const p = at.get(cur)!;
      pts.push(p[0], p[1]);
      const [n0, n1] = next.get(cur)!;
      const step = n0 !== prev && !seen.has(n0!) ? n0! : n1!;
      prev = cur;
      if (step === undefined) break;
      cur = step;
    }
    loops.push(pts);
  }
  return loops;
}

// The facet polygons of a lump: the Voronoi cells of jittered seeds, each cut out of the box by the bisectors to the other seeds.
function facets(seeds: number[][], box: number[], light: (sx: number, sy: number) => number, rand: () => number): number[][][] {
  const tones: number[][][] = Array.from({ length: TONES }, () => []);
  for (let a = 0; a < seeds.length; a++) {
    const [sx, sy] = seeds[a] as [number, number];
    let poly: number[][] = [[box[0]!, box[1]!], [box[2]!, box[1]!], [box[2]!, box[3]!], [box[0]!, box[3]!]];
    for (let b = 0; b < seeds.length && poly.length > 0; b++) {
      if (b === a) continue;
      const [qx, qy] = seeds[b] as [number, number];
      const nx = qx - sx;
      const ny = qy - sy;
      const m = (nx * (sx + qx) + ny * (sy + qy)) / 2; // keep points with n . p <= m
      const out: number[][] = [];
      for (let k = 0; k < poly.length; k++) {
        const p = poly[k]!;
        const q = poly[(k + 1) % poly.length]!;
        const dp = nx * p[0]! + ny * p[1]! - m;
        const dq = nx * q[0]! + ny * q[1]! - m;
        if (dp <= 0) out.push(p);
        if (dp <= 0 !== dq <= 0) {
          const s = dp / (dp - dq);
          out.push([p[0]! + s * (q[0]! - p[0]!), p[1]! + s * (q[1]! - p[1]!)]);
        }
      }
      poly = out;
    }
    if (poly.length < 3) continue;
    const v = 0.6 * (2 * rand() - 1) + 0.8 * light(sx, sy);
    const tone = v > 0.45 ? 3 : v > 0.12 ? 2 : v < -0.45 ? 0 : v < -0.12 ? 1 : -1;
    if (tone >= 0) tones[tone]!.push(poly.flat());
  }
  return tones;
}

// Moves one point onto the exact edge of the union of the discs, a few steps along the radius of the disc it is nearest to.
function snapPoint(t: Terrain, members: readonly number[], x: number, y: number): [number, number] {
  for (let step = 0; step < 4; step++) {
    let best = -Infinity;
    let ux = 0;
    let uy = 0;
    for (const i of members) {
      const dx = x - t.rockX[i]!;
      const dy = y - t.rockY[i]!;
      const d = Math.hypot(dx, dy) || 1e-9;
      const v = t.rockR[i]! - d;
      if (v > best) {
        best = v;
        ux = dx / d;
        uy = dy / d;
      }
    }
    if (Math.abs(best) < 0.05) break;
    x += ux * best; // outwards when inside, inwards when outside
    y += uy * best;
  }
  return [x, y];
}

// Puts a contour (the grid is only a few units fine) onto the exact union edge, and adds a point where an edge midpoint lies off it,
// which is where the tip of a notch between two discs was cut.
function snap(t: Terrain, members: readonly number[], pts: number[]): number[] {
  const out: number[] = [];
  const n = pts.length / 2;
  const on: [number, number][] = [];
  for (let k = 0; k < n; k++) on.push(snapPoint(t, members, pts[2 * k]!, pts[2 * k + 1]!));
  for (let k = 0; k < n; k++) {
    const [x, y] = on[k]!;
    const [nx, ny] = on[(k + 1) % n]!;
    out.push(x, y);
    const [mx, my] = snapPoint(t, members, (x + nx) / 2, (y + ny) / 2);
    if (Math.hypot(mx - (x + nx) / 2, my - (y + ny) / 2) > 0.3) out.push(mx, my);
  }
  return out;
}

function body(t: Terrain, members: number[], seed: number): RockBody | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let cx = 0;
  let cy = 0;
  for (const i of members) {
    x0 = Math.min(x0, t.rockX[i]! - t.rockR[i]!);
    y0 = Math.min(y0, t.rockY[i]! - t.rockR[i]!);
    x1 = Math.max(x1, t.rockX[i]! + t.rockR[i]!);
    y1 = Math.max(y1, t.rockY[i]! + t.rockR[i]!);
    cx += t.rockX[i]!;
    cy += t.rockY[i]!;
  }
  cx /= members.length;
  cy /= members.length;
  const ox = x0 - 3 * CELL;
  const oy = y0 - 3 * CELL;
  const w = Math.ceil((x1 - ox) / CELL) + 4;
  const h = Math.ceil((y1 - oy) / CELL) + 4;
  const f = new Float32Array(w * h).fill(-3 * CELL);
  for (const i of members) {
    const r = t.rockR[i]!;
    const x = t.rockX[i]!;
    const y = t.rockY[i]!;
    const reach = r + 2 * CELL;
    const i0 = Math.max(0, Math.floor((x - reach - ox) / CELL));
    const i1 = Math.min(w - 1, Math.ceil((x + reach - ox) / CELL));
    const j0 = Math.max(0, Math.floor((y - reach - oy) / CELL));
    const j1 = Math.min(h - 1, Math.ceil((y + reach - oy) / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let k = i0; k <= i1; k++) {
        const v = r - Math.hypot(ox + k * CELL - x, oy + j * CELL - y);
        if (v > f[j * w + k]!) f[j * w + k] = v;
      }
    }
  }
  const loops = contours(f, w, h, ox, oy).map((l) => simplifyLoop(snap(t, members, l))).filter((l) => l.length >= 6);
  if (loops.length === 0) return null;
  const box = [x0 - 2 * CELL, y0 - 2 * CELL, x1 + 2 * CELL, y1 + 2 * CELL];
  let shaded: { facets: number[][][]; cracks: number[][] } | null = null;
  // Facets and cracks, made on first use: a body seen from afar, or in a settings preview, never needs them.
  const shading = (): { facets: number[][][]; cracks: number[][] } => {
    if (shaded) return shaded;
    const rng = createRng(seed);
    const inside = (x: number, y: number): boolean => {
      const k = Math.round((x - ox) / CELL);
      const j = Math.round((y - oy) / CELL);
      return k >= 0 && k < w && j >= 0 && j < h && f[j * w + k]! > 0;
    };
    const radius = Math.max(x1 - x0, y1 - y0) / 2;
    const seeds: number[][] = [];
    for (let gy = y0; gy < y1; gy += FACET) {
      for (let gx = x0; gx < x1; gx += FACET) {
        const sx = gx + rng.range(0.1, 0.9) * FACET;
        const sy = gy + rng.range(0.1, 0.9) * FACET;
        if (inside(sx, sy)) seeds.push([sx, sy]);
      }
    }
    const lit = (sx: number, sy: number): number => Math.max(-1, Math.min(1, ((sx - cx) * LIGHT.x + (sy - cy) * LIGHT.y) / radius));
    const cracks: number[][] = [];
    for (let c = 0, count = 1 + rng.int(2); c < count && seeds.length > 0; c++) {
      const [sx, sy] = seeds[rng.int(seeds.length)] as [number, number];
      let a = rng.range(0, 2 * Math.PI);
      const line = [sx, sy];
      for (let k = 0; k < 5; k++) {
        a += rng.range(-0.5, 0.5);
        const len = rng.range(24, 55);
        const nx = line[line.length - 2]! + len * Math.cos(a);
        const ny = line[line.length - 1]! + len * Math.sin(a);
        if (!inside(nx, ny)) break;
        line.push(nx, ny);
      }
      if (line.length >= 4) cracks.push(line);
    }
    return (shaded = { facets: facets(seeds, box, lit, rng.next), cracks });
  };
  return { x0: box[0]!, y0: box[1]!, x1: box[2]!, y1: box[3]!, loops, shading };
}

const built = new WeakMap<Terrain, RockBody[]>();

// The bodies of a map's rock, built on first use and kept for as long as the map lives.
export function rockBodies(t: Terrain): RockBody[] {
  let bodies = built.get(t);
  if (!bodies) {
    bodies = [];
    for (const members of lumps(t)) {
      const b = body(t, members, 0x51ac + members[0]!);
      if (b) bodies.push(b);
    }
    built.set(t, bodies);
  }
  return bodies;
}
