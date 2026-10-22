import { HIT_CREATURE, HIT_NONE, HIT_WALL } from "../sim/types.ts";
import type { Terrain } from "../sim/terrain.ts";

const MAX_CANDIDATES = 4096; // bodies a ray fan can meet within one ray length; more are ignored

// What the page knows of the world, as the renderer draws it now.
export interface RayWorld {
  width: number;
  height: number;
  itemRadius: number;
  radius: number; // creature
  terrain: Terrain | null; // null: no rock known
  items: { x: Float32Array; y: Float32Array; kind: Uint8Array; count: number };
  creatures: { x: Float32Array; y: Float32Array; count: number };
  self: number; // slot in creatures to skip
}

const cx = new Float64Array(MAX_CANDIDATES);
const cy = new Float64Array(MAX_CANDIDATES);
const cc = new Float64Array(MAX_CANDIDATES);
const ck = new Uint8Array(MAX_CANDIDATES);
const range = new Int32Array(4);

// Casts the selected creature's rays from (x, y) at heading + offsets[i] against the walls, rock, items and creatures as the page draws them,
// with the engine's geometry (World.traceRay): circles and the world box, closeness 1 - distance / length. Run every animation frame, so the
// rays turn with the body and still end where they hit; the server's detail carries them only for its last frame.
export function recastRays(w: RayWorld, x: number, y: number, heading: number, offsets: Float32Array, length: number, kinds: Uint8Array, closeness: Float32Array): void {
  const far0 = length * (1 + 1e-9);
  let n = 0;
  const add = (px: number, py: number, r: number, kind: number): void => {
    const fx = px - x;
    const fy = py - y;
    const far = far0 + r;
    const d2 = fx * fx + fy * fy;
    if (d2 > far * far || n === MAX_CANDIDATES) return;
    cx[n] = fx;
    cy[n] = fy;
    cc[n] = d2 - r * r;
    ck[n++] = kind;
  };
  // Rock first, then creatures, then items: if the cap is ever reached, what is dropped is what a ray can see through least.
  const t = w.terrain;
  if (t && t.rockCount > 0) {
    t.cellRange(x, y, far0, range);
    for (let row = range[2]!; row <= range[3]!; row++) {
      for (let k = t.rockStart[row * t.cols + range[0]!]!, end = t.rockStart[row * t.cols + range[1]! + 1]!; k < end; k++) {
        const i = t.rockOrder[k]!;
        add(t.rockX[i]!, t.rockY[i]!, t.rockR[i]!, HIT_WALL);
      }
    }
  }
  const cr = w.creatures;
  for (let i = 0; i < cr.count; i++) if (i !== w.self) add(cr.x[i]!, cr.y[i]!, w.radius, HIT_CREATURE);
  const it = w.items;
  for (let i = 0; i < it.count; i++) add(it.x[i]!, it.y[i]!, w.itemRadius, it.kind[i]!);
  const m = length * (1 + 1e-6);
  const walls = x < m || w.width - x < m || y < m || w.height - y < m;
  const count = Math.min(kinds.length, closeness.length, offsets.length);
  for (let r = 0; r < count; r++) {
    const a = heading + offsets[r]!;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let best = length;
    let kind: number = HIT_NONE;
    if (walls) {
      let tw = Infinity;
      if (dx > 0) tw = (w.width - x) / dx;
      else if (dx < 0) tw = -x / dx;
      if (dy > 0) tw = Math.min(tw, (w.height - y) / dy);
      else if (dy < 0) tw = Math.min(tw, -y / dy);
      if (tw < 0) tw = 0;
      if (tw < best) {
        best = tw;
        kind = HIT_WALL;
      }
    }
    for (let k = 0; k < n; k++) {
      const b = cx[k]! * dx + cy[k]! * dy;
      let s: number;
      if (cc[k]! < 0) s = 0;
      else {
        if (b <= 0) continue;
        const disc = b * b - cc[k]!;
        if (disc < 0) continue;
        s = b - Math.sqrt(disc);
      }
      if (s < best || (s === best && kind === HIT_WALL)) {
        best = s;
        kind = ck[k]!;
      }
    }
    kinds[r] = kind;
    closeness[r] = kind === HIT_NONE ? 0 : 1 - best / length;
  }
}
