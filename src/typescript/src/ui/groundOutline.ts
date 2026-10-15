import { ContourTracer, insidePolygon } from "../geom/contour.ts";
import { GROUND_HALF, GROUND_PAD } from "../sim/groundField.ts";
import type { GroundField } from "../sim/groundField.ts";
import { TERRAIN_FAST, TERRAIN_SLOW } from "../sim/terrain.ts";
import type { Terrain } from "../sim/terrain.ts";
import type { PathSink } from "./rockOutline.ts";

// The mud and firm ground of a map as closed outlines: the 0.5 contour (value 127.5) of the bilinear blend of the raster layers, which is the
// same function Terrain.valueAt thresholds, so the outline is where creatures start to sense the ground.
// Marching squares runs on a grid refined into several fine steps per raster cell. The blend is linear along every grid line, so each crossing
// is exact, and only the short chord between two crossings in one fine cell strays from the true curve, by about step^2 / (8 * radius of curvature):
// under 1 unit for a step of 12.5 units on the field the builder makes, even at saddles where the contour is least certain (groundScene.test.ts measures it against the exact blend).

const SNAP = 1e6;
export const FINE_STEP = 12.5; // world units of a fine grid step, at most
export interface GroundBody {
  kind: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  loops: number[][]; // closed outlines as flat x, y lists, outer ones and holes together: fill them even-odd
}

// Closed outlines of one layer. subdivide is the number of fine steps per raster cell.
function traceLayer(f: GroundField, layer: number, subdivide: number): number[][] {
  const g = f.data;
  const { cols, rows, cell } = f;
  const S = subdivide;
  const FW = (cols - 1) * S + 1;
  const tracer = new ContourTracer(GROUND_HALF, { stride: FW, scale: cell / S, ox: -GROUND_PAD * cell, oy: -GROUND_PAD * cell });
  const vals = new Float64Array((S + 1) * (S + 1));
  for (let cj = 0; cj + 1 < rows; cj++) {
    for (let ci = 0; ci + 1 < cols; ci++) {
      const k = 2 * (cj * cols + ci) + layer;
      const a = g[k]!;
      const b = g[k + 2]!;
      const c = g[k + 2 * cols]!;
      const d = g[k + 2 * cols + 2]!;
      const hi = (a >= 128 ? 1 : 0) + (b >= 128 ? 1 : 0) + (c >= 128 ? 1 : 0) + (d >= 128 ? 1 : 0);
      if (hi === 0 || hi === 4) continue; // the blend of four corners all on one side of one half stays on that side
      for (let fy = 0; fy <= S; fy++) {
        for (let fx = 0; fx <= S; fx++) {
          const tx = fx / S;
          const ty = fy / S;
          vals[fy * (S + 1) + fx] = Math.round((a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty) * SNAP) / SNAP; // snapped, so a node shared by two raster cells classifies alike in both even where the blend is exactly one half (127 next to 128)
        }
      }
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) tracer.cell(ci * S + sx, cj * S + sy, vals[sy * (S + 1) + sx]!, vals[sy * (S + 1) + sx + 1]!, vals[(sy + 1) * (S + 1) + sx + 1]!, vals[(sy + 1) * (S + 1) + sx]!);
      }
    }
  }
  return tracer.loops(3);
}

function areaOf(loop: readonly number[]): number {
  let a = 0;
  for (let i = 0, n = loop.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += loop[2 * i]! * loop[2 * j + 1]! - loop[2 * j]! * loop[2 * i + 1]!;
  }
  return a / 2;
}

// Groups loops into bodies: an outer loop with the holes directly inside it, so a body can be culled by its box and filled even-odd.
function bodiesOf(kind: number, loops: number[][]): GroundBody[] {
  const info = loops.map((loop) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < loop.length; i += 2) {
      x0 = Math.min(x0, loop[i]!);
      x1 = Math.max(x1, loop[i]!);
      y0 = Math.min(y0, loop[i + 1]!);
      y1 = Math.max(y1, loop[i + 1]!);
    }
    return { loop, x0, y0, x1, y1, area: Math.abs(areaOf(loop)), depth: 0, owner: -1 };
  });
  const order = info.map((_, i) => i).sort((p, q) => info[q]!.area - info[p]!.area); // large first: a loop's container is always before it
  const placed: number[] = [];
  for (const i of order) {
    const me = info[i]!;
    let parent = -1;
    for (let k = placed.length - 1; k >= 0; k--) {
      const o = info[placed[k]!]!;
      if (me.x0 >= o.x0 && me.x1 <= o.x1 && me.y0 >= o.y0 && me.y1 <= o.y1 && insidePolygon(o.loop, me.loop[0]!, me.loop[1]!)) {
        parent = placed[k]!; // the smallest container, as placed is in decreasing area
        break;
      }
    }
    me.depth = parent < 0 ? 0 : info[parent]!.depth + 1;
    me.owner = me.depth % 2 === 0 ? i : info[parent]!.owner; // a hole belongs to the outer loop around it, an island in a hole starts its own body
    placed.push(i);
  }
  const bodies = new Map<number, GroundBody>();
  for (const i of order) {
    const me = info[i]!;
    const own = bodies.get(me.owner);
    if (!own) bodies.set(me.owner, { kind, x0: me.x0, y0: me.y0, x1: me.x1, y1: me.y1, loops: [me.loop] });
    else own.loops.push(me.loop);
  }
  return [...bodies.values()];
}

const built = new WeakMap<Terrain, Map<number, GroundBody[]>>();

// The mud and firm outlines of a map, one body per patch, built once per map and refinement. subdivide 1 is the cheap coarse outline
// for pictures of the whole world, fineOf(t) the one for close views.
export function groundBodies(t: Terrain, subdivide: number): GroundBody[] {
  const f = t.ground;
  if (f === null) return [];
  let byLevel = built.get(t);
  if (!byLevel) built.set(t, (byLevel = new Map()));
  let bodies = byLevel.get(subdivide);
  if (!bodies) {
    bodies = [];
    for (const [layer, kind] of [[0, TERRAIN_SLOW], [1, TERRAIN_FAST]] as const) bodies.push(...bodiesOf(kind, traceLayer(f, layer, subdivide)));
    byLevel.set(subdivide, bodies);
  }
  return bodies;
}

// The refinement for close views: fine steps of at most FINE_STEP units.
export const fineOf = (t: Terrain): number => (t.ground === null ? 1 : Math.max(1, Math.ceil(t.ground.cell / FINE_STEP)));

// A closed curve through the midpoints of a dense outline, so ground edges are smooth where rock edges are angular.
export function traceSmooth(path: PathSink, pts: readonly number[]): void {
  const n = pts.length / 2;
  const at = (i: number, c: number): number => pts[2 * ((i + n) % n) + c]!;
  path.moveTo((at(0, 0) + at(1, 0)) / 2, (at(0, 1) + at(1, 1)) / 2);
  for (let i = 1; i <= n; i++) path.quadraticCurveTo(at(i, 0), at(i, 1), (at(i, 0) + at(i + 1, 0)) / 2, (at(i, 1) + at(i + 1, 1)) / 2);
  path.closePath();
}
