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
  const h = cell / S;
  const FW = (cols - 1) * S + 1;
  const px: number[] = [];
  const py: number[] = [];
  const nb: number[] = []; // two neighbours per crossing, -1 for none yet
  const ids = new Map<number, number>(); // fine edge key to its crossing
  const vals = new Float64Array((S + 1) * (S + 1));
  const origin = GROUND_PAD * cell;
  // The crossing on the fine edge from fine node (gi, gj) along x (dir 0) or y (dir 1), between values v0 and v1.
  const cross = (gi: number, gj: number, dir: number, v0: number, v1: number): number => {
    const key = 2 * (gj * FW + gi) + dir;
    let id = ids.get(key);
    if (id === undefined) {
      const s = (v0 - GROUND_HALF) / (v0 - v1);
      id = px.length;
      px.push((gi + (dir === 0 ? s : 0)) * h - origin);
      py.push((gj + (dir === 1 ? s : 0)) * h - origin);
      nb.push(-1, -1);
      ids.set(key, id);
    }
    return id;
  };
  const link = (p: number, q: number): void => {
    nb[nb[2 * p]! < 0 ? 2 * p : 2 * p + 1] = q;
    nb[nb[2 * q]! < 0 ? 2 * q : 2 * q + 1] = p;
  };
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
        for (let sx = 0; sx < S; sx++) {
          const v00 = vals[sy * (S + 1) + sx]!;
          const v10 = vals[sy * (S + 1) + sx + 1]!;
          const v01 = vals[(sy + 1) * (S + 1) + sx]!;
          const v11 = vals[(sy + 1) * (S + 1) + sx + 1]!;
          const i00 = v00 >= GROUND_HALF;
          const i10 = v10 >= GROUND_HALF;
          const i01 = v01 >= GROUND_HALF;
          const i11 = v11 >= GROUND_HALF;
          if (i00 === i10 && i10 === i11 && i11 === i01) continue;
          const gi = ci * S + sx;
          const gj = cj * S + sy;
          const top = i00 !== i10 ? cross(gi, gj, 0, v00, v10) : -1;
          const right = i10 !== i11 ? cross(gi + 1, gj, 1, v10, v11) : -1;
          const bottom = i01 !== i11 ? cross(gi, gj + 1, 0, v01, v11) : -1;
          const left = i00 !== i01 ? cross(gi, gj, 1, v00, v01) : -1;
          const edges = [top, right, bottom, left].filter((e) => e >= 0);
          if (edges.length === 2) link(edges[0]!, edges[1]!);
          else if (edges.length === 4) {
            if ((v00 + v10 + v01 + v11) / 4 >= GROUND_HALF === i00) {
              link(top, right);
              link(bottom, left);
            } else {
              link(top, left);
              link(right, bottom);
            }
          }
        }
      }
    }
  }
  const loops: number[][] = [];
  const seen = new Uint8Array(px.length);
  for (let start = 0; start < px.length; start++) {
    if (seen[start]) continue;
    const pts: number[] = [];
    let prev = -1;
    let cur = start;
    while (cur >= 0 && !seen[cur]) {
      seen[cur] = 1;
      pts.push(px[cur]!, py[cur]!);
      const n0 = nb[2 * cur]!;
      const n1 = nb[2 * cur + 1]!;
      const step = n0 !== prev && n0 >= 0 && !seen[n0] ? n0 : n1;
      prev = cur;
      cur = step;
    }
    if (pts.length >= 6) loops.push(pts);
  }
  return loops;
}

function areaOf(loop: readonly number[]): number {
  let a = 0;
  for (let i = 0, n = loop.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += loop[2 * i]! * loop[2 * j + 1]! - loop[2 * j]! * loop[2 * i + 1]!;
  }
  return a / 2;
}

function contains(loop: readonly number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, n = loop.length / 2, j = n - 1; i < n; j = i++) {
    const xi = loop[2 * i]!;
    const yi = loop[2 * i + 1]!;
    const xj = loop[2 * j]!;
    const yj = loop[2 * j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
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
      if (me.x0 >= o.x0 && me.x1 <= o.x1 && me.y0 >= o.y0 && me.y1 <= o.y1 && contains(o.loop, me.loop[0]!, me.loop[1]!)) {
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
