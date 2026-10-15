// Closed outlines of a scalar field (marching squares), Douglas-Peucker simplification and a point-in-polygon test, shared by the map builder
// (mask edges), the rock outlines and the ground outlines. Outlines are flat x, y lists.

export interface TracerOptions {
  stride: number; // nodes per row of the grid the crossing keys are made from
  scale: number; // world units per grid step: a crossing at grid position g is at (g + shift) * scale + origin
  ox?: number;
  oy?: number;
  shift?: number; // added to a grid index before scaling (-0.5 for a padded grid whose node 1 sits half a cell in)
  strict?: boolean; // a node is inside when its value is above the threshold, not at or above it
}

// Collects the crossings of the contour at a threshold cell by cell and joins them into loops. Node values are given by the caller, a cell at a time,
// as a (gi, gj), b (gi + 1, gj), c (gi + 1, gj + 1), d (gi, gj + 1). Crossings sit on the cell edges, linearly interpolated.
export class ContourTracer {
  private readonly px: number[] = [];
  private readonly py: number[] = [];
  private readonly n0: number[] = []; // the two crossings each one joins, -1 for none yet
  private readonly n1: number[] = [];
  private readonly order: number[] = []; // crossings in the order they were first joined, where loops start
  private readonly ids = new Map<number, number>();
  private readonly ox: number;
  private readonly oy: number;
  private readonly shift: number;
  private readonly strict: boolean;

  private readonly threshold: number;
  private readonly o: TracerOptions;

  constructor(threshold: number, o: TracerOptions) {
    this.threshold = threshold;
    this.o = o;
    this.ox = o.ox ?? 0;
    this.oy = o.oy ?? 0;
    this.shift = o.shift ?? 0;
    this.strict = o.strict === true;
  }

  inside(v: number): boolean {
    return this.strict ? v > this.threshold : v >= this.threshold;
  }

  // The crossing on the edge from node (gi, gj) along x (vertical false) or y, between values v0 and v1.
  private cross(gi: number, gj: number, vertical: boolean, v0: number, v1: number): number {
    const key = 2 * (gj * this.o.stride + gi) + (vertical ? 1 : 0);
    let id = this.ids.get(key);
    if (id === undefined) {
      const s = (v0 - this.threshold) / (v0 - v1);
      id = this.px.length;
      this.px.push(vertical ? (gi + this.shift) * this.o.scale + this.ox : (gi + this.shift + s) * this.o.scale + this.ox);
      this.py.push(vertical ? (gj + this.shift + s) * this.o.scale + this.oy : (gj + this.shift) * this.o.scale + this.oy);
      this.n0.push(-1);
      this.n1.push(-1);
      this.ids.set(key, id);
    }
    return id;
  }

  private join(a: number, b: number): void {
    if (this.n0[a] === -1) {
      this.n0[a] = b;
      this.order.push(a);
    } else this.n1[a] = b;
  }

  private link(p: number, q: number): void {
    this.join(p, q);
    this.join(q, p);
  }

  cell(gi: number, gj: number, a: number, b: number, c: number, d: number): void {
    const ia = this.inside(a);
    const ib = this.inside(b);
    const ic = this.inside(c);
    const id = this.inside(d);
    if (ia === ib && ib === ic && ic === id) return;
    const top = ia !== ib ? this.cross(gi, gj, false, a, b) : -1;
    const right = ib !== ic ? this.cross(gi + 1, gj, true, b, c) : -1;
    const bottom = id !== ic ? this.cross(gi, gj + 1, false, d, c) : -1;
    const left = ia !== id ? this.cross(gi, gj, true, a, d) : -1;
    if (top >= 0 && right >= 0 && bottom >= 0 && left >= 0) {
      // a saddle: the centre value decides which pairs of crossings are joined
      if (this.inside((a + b + c + d) / 4) === ia) {
        this.link(top, right);
        this.link(bottom, left);
      } else {
        this.link(top, left);
        this.link(right, bottom);
      }
    } else {
      const first = top >= 0 ? top : right >= 0 ? right : bottom;
      const second = first === top ? (right >= 0 ? right : bottom >= 0 ? bottom : left) : first === right ? (bottom >= 0 ? bottom : left) : left;
      this.link(first, second);
    }
  }

  // The closed loops with at least minPoints points.
  loops(minPoints = 0): number[][] {
    const out: number[][] = [];
    const seen = new Uint8Array(this.px.length);
    for (const start of this.order) {
      if (seen[start]) continue;
      const pts: number[] = [];
      let prev = -1;
      let cur = start;
      while (cur >= 0 && !seen[cur]) {
        seen[cur] = 1;
        pts.push(this.px[cur]!, this.py[cur]!);
        const a = this.n0[cur]!;
        const step = a !== prev && a >= 0 && !seen[a] ? a : this.n1[cur]!;
        prev = cur;
        cur = step;
      }
      if (pts.length >= 2 * minPoints) out.push(pts);
    }
    return out;
  }
}

export interface GridOptions extends Omit<TracerOptions, "stride"> {
  minPoints?: number;
  active?: Uint8Array; // per block of 1 << block nodes, row by row: cells in a block with 0 here are skipped, as sure to cross nothing
  block?: number;
}

// Closed outlines of the contour of a w x h grid of node values (row by row) at the threshold, in world units.
export function marchingSquares(f: ArrayLike<number>, w: number, h: number, threshold: number, o: GridOptions): number[][] {
  const t = new ContourTracer(threshold, { ...o, stride: w });
  const { active, block = 0 } = o;
  const bw = (w >> block) + 1;
  for (let j = 0; j + 1 < h; j++) {
    for (let i = 0; i + 1 < w; i++) {
      if (active && !active[(j >> block) * bw + (i >> block)]) {
        i |= (1 << block) - 1; // the rest of this block's cells in the row cross nothing
        continue;
      }
      const a = f[j * w + i]!;
      const b = f[j * w + i + 1]!;
      const c = f[(j + 1) * w + i + 1]!;
      const d = f[(j + 1) * w + i]!;
      t.cell(i, j, a, b, c, d);
    }
  }
  return t.loops(o.minPoints);
}

// Douglas-Peucker on a closed outline: the corners that matter, so the faces between them are straight. Splits at the point farthest from the first.
export function simplifyClosed(flat: ArrayLike<number>, tol: number): number[] {
  const n = flat.length / 2;
  if (n < 3) return Array.from(flat);
  let far = 0;
  let best = 0;
  for (let k = 1; k < n; k++) {
    const d = Math.hypot(flat[2 * k]! - flat[0]!, flat[2 * k + 1]! - flat[1]!);
    if (d > best) {
      best = d;
      far = k;
    }
  }
  const keep = new Set<number>([0, far]);
  const run = (from: number, to: number): void => {
    const stack: [number, number][] = [[from, to]];
    while (stack.length > 0) {
      const [i, j] = stack.pop()!;
      const ax = flat[2 * (i % n)]!;
      const ay = flat[2 * (i % n) + 1]!;
      const dx = flat[2 * (j % n)]! - ax;
      const dy = flat[2 * (j % n) + 1]! - ay;
      const len = Math.hypot(dx, dy) || 1;
      let worst = tol;
      let at = -1;
      for (let k = i + 1; k < j; k++) {
        const d = Math.abs((flat[2 * (k % n)]! - ax) * dy - (flat[2 * (k % n) + 1]! - ay) * dx) / len;
        if (d > worst) {
          worst = d;
          at = k;
        }
      }
      if (at >= 0) {
        keep.add(at % n);
        stack.push([i, at], [at, j]);
      }
    }
  };
  run(0, far);
  run(far, n);
  const out: number[] = [];
  for (const k of [...keep].sort((p, q) => p - q)) out.push(flat[2 * k]!, flat[2 * k + 1]!);
  return out;
}

// Whether (x, y) is inside the polygon (even-odd).
export function insidePolygon(flat: ArrayLike<number>, x: number, y: number): boolean {
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
}
