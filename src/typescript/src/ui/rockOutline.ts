import { marchingSquares, simplifyClosed } from "../geom/contour.ts";
import type { Terrain } from "../sim/terrain.ts";

// What the geometry needs of a map: its rock discs and the grid over them.
export type RockInput = Pick<Terrain, "rockX" | "rockY" | "rockR" | "rockCount" | "rockStart" | "rockOrder" | "cols" | "rows" | "maxRockR" | "cellRange">;

// Turns the rock discs of a map into drawable bodies: one per connected lump of rock, each with a smooth outline that follows the
// exact union of its discs (so what creatures bounce off is what is drawn). Built once per map.

export interface RockBody {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  readonly loops: number[][]; // made when first read; closed outlines as flat x, y lists, simplified to straight edges; draw them with traceLoop
}

const CELL = 6; // world units of the contour grid
const SIMPLIFY = 0.9; // world units a simplified outline may stray from the contour, so round lumps become angular stones
const CORNER = 2; // world units a corner is rounded over, on each side
const BLOCK = 3; // log2 of the nodes along a block of the contour grid
const FLAT = 10; // the field deeper inside than this is stored as this (see lumpField)

export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  closePath(): void;
}

// Draws a closed outline as straight edges with each corner rounded over CORNER units (less on short edges), so stones stay angular
// and the curve never strays more than about SIMPLIFY from the disc union.
export function traceLoop(path: PathSink, pts: readonly number[], corner = CORNER): void {
  const n = pts.length / 2;
  const at = (i: number): [number, number] => [pts[2 * ((i + n) % n)]!, pts[2 * ((i + n) % n) + 1]!];
  for (let i = 0; i < n; i++) {
    const [px, py] = at(i - 1);
    const [vx, vy] = at(i);
    const [nx, ny] = at(i + 1);
    const l1 = Math.hypot(vx - px, vy - py) || 1;
    const l2 = Math.hypot(nx - vx, ny - vy) || 1;
    const t1 = Math.min(corner, 0.4 * l1);
    const t2 = Math.min(corner, 0.4 * l2);
    const ax = vx + ((px - vx) / l1) * t1;
    const ay = vy + ((py - vy) / l1) * t1;
    if (i === 0) path.moveTo(ax, ay);
    else path.lineTo(ax, ay);
    path.quadraticCurveTo(vx, vy, vx + ((nx - vx) / l2) * t2, vy + ((ny - vy) / l2) * t2);
  }
  path.closePath();
}

// Groups of discs that overlap each other, as lists of disc indices.
function lumps(t: RockInput): number[][] {
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

const SNAP_REUSE = 12; // a candidate list is reused for points this close to where it was made
const SNAP_REACH = 40; // world units past a disc edge that a snap candidate list covers; a point strays less, else the whole lump is scanned

// Moves points onto the exact edge of the union of a lump's discs, a few steps along the radius of the disc it is nearest to. The nearest
// disc is looked for among the lump's discs near a query point (from the rock grid), and among all of them when that cannot be proven right.
function snapper(t: RockInput, members: readonly number[], lumpOf: Int32Array, id: number) {
  const cand: number[] = [];
  const range = new Int32Array(4);
  let qx = Infinity;
  let qy = Infinity;
  const near = (x: number, y: number): void => {
    if ((x - qx) ** 2 + (y - qy) ** 2 < SNAP_REUSE ** 2) return; // the list made for a point this close still covers
    qx = x;
    qy = y;
    cand.length = 0;
    t.cellRange(x, y, SNAP_REACH, range);
    for (let cy = range[2]!; cy <= range[3]!; cy++) {
      for (let k = t.rockStart[cy * t.cols + range[0]!]!, end = t.rockStart[cy * t.cols + range[1]! + 1]!; k < end; k++) {
        const j = t.rockOrder[k]!;
        if (lumpOf[j] === id && (x - t.rockX[j]!) ** 2 + (y - t.rockY[j]!) ** 2 < (t.rockR[j]! + SNAP_REACH) ** 2) cand.push(j);
      }
    }
  };
  let ux = 0;
  let uy = 0;
  const nearest = (list: readonly number[], x: number, y: number): number => {
    let best = -Infinity;
    for (const i of list) {
      const dx = x - t.rockX[i]!;
      const dy = y - t.rockY[i]!;
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-9;
      const v = t.rockR[i]! - d;
      if (v > best) {
        best = v;
        ux = dx / d;
        uy = dy / d;
      }
    }
    return best;
  };
  const snapPoint = (x: number, y: number): [number, number] => {
    for (let step = 0; step < 4; step++) {
      let best = nearest(cand, x, y);
      if (!(best >= Math.sqrt((x - qx) ** 2 + (y - qy) ** 2) - SNAP_REACH)) best = nearest(members, x, y); // a disc left out could be nearer
      if (Math.abs(best) < 0.05) break;
      x += ux * best; // outwards when inside, inwards when outside
      y += uy * best;
    }
    return [x, y];
  };
  return { near, snapPoint };
}

// Puts a contour (the grid is only a few units fine) onto the exact union edge, and adds a point where an edge midpoint lies off it,
// which is where the tip of a notch between two discs was cut.
function snap(t: RockInput, members: readonly number[], lumpOf: Int32Array, id: number, pts: number[]): number[] {
  const { near, snapPoint } = snapper(t, members, lumpOf, id);
  const out: number[] = [];
  const n = pts.length / 2;
  const on: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    near(pts[2 * k]!, pts[2 * k + 1]!);
    on.push(snapPoint(pts[2 * k]!, pts[2 * k + 1]!));
  }
  for (let k = 0; k < n; k++) {
    const [x, y] = on[k]!;
    const [nx, ny] = on[(k + 1) % n]!;
    out.push(x, y);
    near(x, y);
    const [mx, my] = snapPoint((x + nx) / 2, (y + ny) / 2);
    if (Math.hypot(mx - (x + nx) / 2, my - (y + ny) / 2) > 0.3) out.push(mx, my);
  }
  return out;
}

interface Lump {
  id: number;
  members: number[];
  x0: number; // box of the discs
  y0: number;
  x1: number;
  y1: number;
}

// The lumps of a map's rock with their boxes, and for each disc the lump it belongs to. Cheap (grid lookups), kept for the life of the map.
const layouts = new WeakMap<object, { lumps: Lump[]; lumpOf: Int32Array }>();
function layoutOf(t: RockInput): { lumps: Lump[]; lumpOf: Int32Array } {
  let l = layouts.get(t);
  if (!l) {
    const lumpOf = new Int32Array(t.rockCount);
    const list = lumps(t).map((members, id): Lump => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const i of members) {
        lumpOf[i] = id;
        x0 = Math.min(x0, t.rockX[i]! - t.rockR[i]!);
        y0 = Math.min(y0, t.rockY[i]! - t.rockR[i]!);
        x1 = Math.max(x1, t.rockX[i]! + t.rockR[i]!);
        y1 = Math.max(y1, t.rockY[i]! + t.rockR[i]!);
      }
      return { id, members, x0, y0, x1, y1 };
    });
    layouts.set(t, (l = { lumps: list, lumpOf }));
  }
  return l;
}

// The field of a lump on its contour grid: positive inside the union of its discs, the distance to the nearest edge up to 2 cells out.
function lumpField(t: RockInput, lump: Lump): { f: Float32Array; w: number; h: number; ox: number; oy: number; active: Uint8Array } {
  const ox = lump.x0 - 3 * CELL;
  const oy = lump.y0 - 3 * CELL;
  const w = Math.ceil((lump.x1 - ox) / CELL) + 4;
  const h = Math.ceil((lump.y1 - oy) / CELL) + 4;
  const f = new Float32Array(w * h).fill(-3 * CELL);
  const bw = (w >> BLOCK) + 1;
  const bh = (h >> BLOCK) + 1;
  const maybe = new Uint8Array(bw * bh); // blocks where some disc put an inside value, which a deeper disc may have overwritten
  const marked = new Uint8Array(bw * bh); // blocks of nodes that hold an inside node near the edge
  // Only nodes near an edge need their true value (a contour crosses between nodes of opposite sign, and the field changes at most one
  // unit per unit, so those lie within 1.5 cells of the edge): deeper in, the field is just kept above FLAT with one fill per row.
  for (const i of lump.members) {
    const r = t.rockR[i]!;
    const x = t.rockX[i]!;
    const y = t.rockY[i]!;
    const reach = r + 2 * CELL;
    const i0 = Math.max(0, Math.floor((x - reach - ox) / CELL));
    const i1 = Math.min(w - 1, Math.ceil((x + reach - ox) / CELL));
    const j0 = Math.max(0, Math.floor((y - reach - oy) / CELL));
    const j1 = Math.min(h - 1, Math.ceil((y + reach - oy) / CELL));
    const deep = r - FLAT;
    for (let j = j0; j <= j1; j++) {
      const dy = oy + j * CELL - y;
      let a = 1; // nodes a .. b of this row are deep inside the disc
      let b = 0;
      if (deep > 0 && deep * deep > dy * dy) {
        const half = Math.sqrt(deep * deep - dy * dy);
        a = Math.max(i0, Math.floor((x - half - ox) / CELL) + 1);
        b = Math.min(i1, Math.ceil((x + half - ox) / CELL) - 1);
      }
      const edgeEnd = a <= b ? a - 1 : i1;
      for (let k = i0; k <= edgeEnd; k++) {
        const v = r - Math.sqrt((ox + k * CELL - x) ** 2 + dy * dy);
        if (v > f[j * w + k]!) {
          f[j * w + k] = v;
          if (v > 0) maybe[(j >> BLOCK) * bw + (k >> BLOCK)] = 1;
        }
      }
      if (a <= b) {
        f.fill(FLAT, j * w + a, j * w + b + 1);
        for (let k = b + 1; k <= i1; k++) {
          const v = r - Math.sqrt((ox + k * CELL - x) ** 2 + dy * dy);
          if (v > f[j * w + k]!) {
            f[j * w + k] = v;
            if (v > 0) maybe[(j >> BLOCK) * bw + (k >> BLOCK)] = 1;
          }
        }
      }
    }
  }
  for (let bj = 0; bj < bh; bj++) {
    for (let bi = 0; bi < bw; bi++) {
      if (!maybe[bj * bw + bi]) continue;
      const jEnd = Math.min(h, (bj + 1) << BLOCK);
      const kEnd = Math.min(w, (bi + 1) << BLOCK);
      scan: for (let j = bj << BLOCK; j < jEnd; j++) {
        for (let k = bi << BLOCK; k < kEnd; k++) {
          const v = f[j * w + k]!;
          if (v > 0 && v < FLAT) {
            marked[bj * bw + bi] = 1;
            break scan;
          }
        }
      }
    }
  }
  // A cell can cross the edge only if a block it touches (its own or the next one over or down) is marked.
  const active = new Uint8Array(bw * bh);
  for (let bj = 0; bj < bh; bj++) {
    for (let bi = 0; bi < bw; bi++) {
      active[bj * bw + bi] = marked[bj * bw + bi]! | (bi + 1 < bw ? marked[bj * bw + bi + 1]! : 0) | (bj + 1 < bh ? marked[(bj + 1) * bw + bi]! : 0) | (bj + 1 < bh && bi + 1 < bw ? marked[(bj + 1) * bw + bi + 1]! : 0);
    }
  }
  return { f, w, h, ox, oy, active };
}

// Straight edges between the corners that matter; a short outline is kept whole.
const simplifyOutline = (pts: number[]): number[] => (pts.length < 16 ? pts : simplifyClosed(pts, SIMPLIFY));

function lumpLoops(t: RockInput, lump: Lump, lumpOf: Int32Array): number[][] {
  const { f, w, h, ox, oy, active } = lumpField(t, lump);
  return marchingSquares(f, w, h, 0, { scale: CELL, ox, oy, strict: true, active, block: BLOCK }) // the field is positive inside, on nodes CELL apart
    .map((l) => simplifyOutline(snap(t, lump.members, lumpOf, lump.id, l))).filter((l) => l.length >= 6);
}

const geometries = new WeakMap<object, RockGeometry>();

// The loops of body b out of packed geometry.
function loopsFrom(g: RockGeometry, b: number): number[][] {
  const out: number[][] = [];
  for (let l = b === 0 ? 0 : g.bodyLoops[b - 1]!; l < g.bodyLoops[b]!; l++) {
    out.push(Array.from(g.points.subarray(2 * (l === 0 ? 0 : g.loopPoints[l - 1]!), 2 * g.loopPoints[l]!)));
  }
  return out;
}

function bodyOf(t: RockInput, lump: Lump, lumpOf: Int32Array): RockBody {
  let made: number[][] | null = null;
  return {
    x0: lump.x0 - 2 * CELL,
    y0: lump.y0 - 2 * CELL,
    x1: lump.x1 + 2 * CELL,
    y1: lump.y1 + 2 * CELL,
    get loops() {
      if (made) return made;
      const g = geometries.get(t);
      return (made = g ? loopsFrom(g, lump.id) : lumpLoops(t, lump, lumpOf));
    },
  };
}

const built = new WeakMap<object, RockBody[]>();

// The bodies of a map's rock, kept for as long as the map lives. Cheap to get: the outline of each body is traced when first read, so a
// view that shows a few bodies pays for those only.
export function rockBodies(t: RockInput): RockBody[] {
  let bodies = built.get(t);
  if (!bodies) {
    const { lumps: list, lumpOf } = layoutOf(t);
    bodies = list.map((lump) => bodyOf(t, lump, lumpOf));
    built.set(t, bodies);
  }
  return bodies;
}

// All the outlines of a map's rock as plain typed arrays, for building them on a Web Worker: needs no DOM and no canvas, and the arrays
// can be transferred. Body b (in the order of rockBodies) has the loops bodyLoops[b - 1] .. bodyLoops[b] - 1
// (bodyLoops is cumulative, the count before body 0 is 0). Loop l has the points loopPoints[l - 1] .. loopPoints[l] - 1 (cumulative the same way)
// in points, each at points[2p], points[2p + 1], a closed outline to draw with traceLoop.
export interface RockGeometry {
  bodyLoops: Uint32Array;
  loopPoints: Uint32Array;
  points: Float64Array;
}

export function rockGeometry(t: RockInput): RockGeometry {
  const { lumps: list, lumpOf } = layoutOf(t);
  const bodyLoops = new Uint32Array(list.length);
  const loops: number[][] = [];
  list.forEach((lump, b) => {
    loops.push(...lumpLoops(t, lump, lumpOf));
    bodyLoops[b] = loops.length;
  });
  const loopPoints = new Uint32Array(loops.length);
  let total = 0;
  loops.forEach((l, i) => (loopPoints[i] = total += l.length / 2));
  const points = new Float64Array(2 * total);
  let at = 0;
  for (const l of loops) {
    points.set(l, at);
    at += l.length;
  }
  return { bodyLoops, loopPoints, points };
}

// The geometry a map was handed by useRockGeometry, if any.
export const rockGeometryOf = (t: RockInput): RockGeometry | null => geometries.get(t) ?? null;

// Hands a map the geometry built elsewhere (a worker): bodies not drawn yet take their outlines from it instead of tracing them.
export function useRockGeometry(t: RockInput, g: RockGeometry): void {
  if (layoutOf(t).lumps.length !== g.bodyLoops.length) throw new Error("rock geometry does not belong to this map");
  geometries.set(t, g);
}
