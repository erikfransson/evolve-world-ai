import type { EngineConfig } from "./config.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON, HIT_WALL } from "./types.ts";
import type { HitKind, RayHit, Rng, WorldView } from "./types.ts";

interface CellRange {
  rangeX0: number;
  rangeX1: number;
  rangeY0: number;
  rangeY1: number;
}

// One sensing creature's items within reach of its anchor, reused while it stays within slack of the anchor. Serves one world.
export class RayCache implements CellRange {
  version = -1; // world version the list is known valid at, -1 before the first build
  anchorX = 0;
  anchorY = 0;
  count = 0;
  listX = new Float64Array(32);
  listY = new Float64Array(32);
  listKind = new Uint8Array(32);
  listId = new Int32Array(32);
  // Cells the list was gathered from.
  rangeX0 = 0;
  rangeX1 = -1;
  rangeY0 = 0;
  rangeY1 = -1;
  // Items near the ray origin, gathered once per sensing; ray-independent terms are precomputed.
  candFx = new Float64Array(32);
  candFy = new Float64Array(32);
  candC = new Float64Array(32); // squared distance minus squared item radius
  candKind = new Uint8Array(32);
  candCount = 0;

  // Doubles every list and candidate array so a candidate never overflows.
  grow(): void {
    const size = this.listX.length * 2;
    for (const key of ["listX", "listY", "candFx", "candFy", "candC"] as const) {
      const grown = new Float64Array(size);
      grown.set(this[key]);
      this[key] = grown;
    }
    for (const key of ["listKind", "candKind"] as const) {
      const grown = new Uint8Array(size);
      grown.set(this[key]);
      this[key] = grown;
    }
    const ids = new Int32Array(size);
    ids.set(this.listId);
    this.listId = ids;
  }
}

// Food and poison items in fixed slots; a slot of kind HIT_NONE is free.
export class World implements WorldView {
  readonly count: number; // slot capacity
  // Writes must go through setItem or removeItem to keep the grid valid.
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly kinds: Uint8Array;

  private readonly width: number;
  private readonly height: number;
  private readonly itemRadius: number;
  private readonly rayLength: number;
  // Uniform grid as per-cell linked lists: cellHead[c] -> item -> nextItem[item] -> -1.
  private readonly cell: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cellHead: Int32Array;
  private readonly nextItem: Int32Array;
  private readonly itemCell: Int32Array;
  // Free slots as a stack; freePos[i] is slot i's place in it, -1 while taken.
  private readonly freeSlots: Int32Array;
  private readonly freePos: Int32Array;
  private freeCount: number;
  // Bumped by every item change; cellStamp[c] is the version of the last change in cell c.
  private version = 0;
  private readonly cellStamp: Int32Array;
  private readonly eatRange: CellRange = { rangeX0: 0, rangeX1: 0, rangeY0: 0, rangeY1: 0 };
  // Redundant guard: the cross-product test already excludes spreads of pi or more.
  private readonly fanNarrow: boolean;
  private readonly slack: number;
  private readonly listReach: number;

  constructor(config: EngineConfig, capacity: number) {
    const w = config.world;
    this.width = w.width;
    this.height = w.height;
    this.itemRadius = w.itemRadius;
    this.rayLength = config.creature.rayLength;
    this.slack = 0.3 * this.rayLength;
    this.fanNarrow = config.creature.raySpread < Math.PI - 1e-3;
    this.listReach = this.rayLength + this.itemRadius + 2e-9 * this.rayLength + this.slack;
    this.count = capacity;
    this.xs = new Float32Array(capacity);
    this.ys = new Float32Array(capacity);
    this.kinds = new Uint8Array(capacity);
    this.cell = Math.max(this.rayLength, 4 * this.itemRadius, 1);
    this.cols = Math.max(1, Math.ceil(this.width / this.cell));
    this.rows = Math.max(1, Math.ceil(this.height / this.cell));
    this.cellHead = new Int32Array(this.cols * this.rows).fill(-1);
    this.cellStamp = new Int32Array(this.cols * this.rows);
    this.nextItem = new Int32Array(capacity).fill(-1);
    this.itemCell = new Int32Array(capacity).fill(-1);
    // Lowest slot on top, so scatter takes its slots from the top.
    this.freeSlots = new Int32Array(capacity);
    this.freePos = new Int32Array(capacity);
    for (let k = 0; k < capacity; k++) {
      this.freeSlots[k] = capacity - 1 - k;
      this.freePos[capacity - 1 - k] = k;
    }
    this.freeCount = capacity;
  }

  // Slots holding an item.
  get used(): number {
    return this.count - this.freeCount;
  }

  // Fills slots 0..food+poison-1 at uniform random positions, food first.
  scatter(food: number, poison: number, rng: Rng): void {
    for (let i = 0; i < food + poison; i++) this.placeRandomly(i, i < food ? HIT_FOOD : HIT_POISON, rng);
  }

  // Puts item i at a uniform random position inside the walls.
  placeRandomly(i: number, kind: HitKind, rng: Rng): void {
    const r = this.itemRadius;
    this.setItem(i, rng.range(r, this.width - r), rng.range(r, this.height - r), kind);
  }

  // Places item i and keeps the grid valid.
  setItem(i: number, x: number, y: number, kind: HitKind): void {
    this.version++;
    this.unlink(i);
    this.takeSlot(i);
    this.xs[i] = x;
    this.ys[i] = y;
    this.kinds[i] = kind;
    const c = this.cellIndex(this.xs[i], this.ys[i]);
    this.itemCell[i] = c;
    this.nextItem[i] = this.cellHead[c];
    this.cellHead[c] = i;
    this.cellStamp[c] = this.version;
  }

  // Frees slot i; its item leaves the grid.
  removeItem(i: number): void {
    this.version++;
    this.unlink(i);
    this.kinds[i] = HIT_NONE;
    if (this.freePos[i] < 0) {
      this.freePos[i] = this.freeCount;
      this.freeSlots[this.freeCount++] = i;
    }
  }

  // Places an item in the most recently freed slot and returns the slot, or -1 when all are taken.
  addItem(x: number, y: number, kind: HitKind): number {
    if (this.freeCount === 0) return -1;
    const i = this.freeSlots[this.freeCount - 1];
    this.setItem(i, x, y, kind);
    return i;
  }

  // Removes slot i from the free stack by swapping the top into its place.
  private takeSlot(i: number): void {
    const p = this.freePos[i];
    if (p < 0) return;
    const top = this.freeSlots[--this.freeCount];
    this.freeSlots[p] = top;
    this.freePos[top] = p;
    this.freePos[i] = -1;
  }

  private cellIndex(x: number, y: number): number {
    let cx = Math.floor(x / this.cell);
    let cy = Math.floor(y / this.cell);
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0;
    else if (cy >= this.rows) cy = this.rows - 1;
    return cy * this.cols + cx;
  }

  private unlink(i: number): void {
    const c = this.itemCell[i];
    if (c < 0) return;
    let j = this.cellHead[c];
    if (j === i) {
      this.cellHead[c] = this.nextItem[i];
    } else {
      while (j >= 0 && this.nextItem[j] !== i) j = this.nextItem[j];
      if (j >= 0) this.nextItem[j] = this.nextItem[i];
    }
    this.itemCell[i] = -1;
    this.cellStamp[c] = this.version;
  }

  // Casts one ray per direction (dirX[i], dirY[i]) from (x, y), sharing the item lookup between them.
  castRays(x: number, y: number, dirX: Float64Array, dirY: Float64Array, out: readonly RayHit[], cache: RayCache): void {
    const last = out.length - 1;
    // Rays are ordered across a fan narrower than a half turn, so an item further than its radius outside the first and last ray cannot be hit.
    const wedge = last > 0 && dirX[0] * dirY[last] - dirY[0] * dirX[last] > 1e-9 && this.fanNarrow;
    this.gatherCandidates(x, y, wedge, dirX[0], dirY[0], dirX[last], dirY[last], cache);
    for (let i = 0; i < out.length; i++) this.traceRay(x, y, dirX[i], dirY[i], out[i], cache);
  }

  // True while no item changed in the cells the cached list was gathered from.
  private listValid(cache: RayCache): boolean {
    if (cache.version === this.version) return true;
    if (cache.version < 0) return false;
    const { rangeX0: cx0, rangeX1: cx1, rangeY0: cy0, rangeY1: cy1 } = cache;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (this.cellStamp[cy * this.cols + cx] > cache.version) return false;
      }
    }
    cache.version = this.version;
    return true;
  }

  // Collects items that can be hit by a ray from (x, y), with their ray-independent terms.
  private gatherCandidates(x: number, y: number, wedge: boolean, d0x: number, d0y: number, d1x: number, d1y: number, cache: RayCache): void {
    const ax = x - cache.anchorX;
    const ay = y - cache.anchorY;
    if (ax * ax + ay * ay > this.slack * this.slack || !this.listValid(cache)) this.rebuildList(x, y, cache);
    const r = this.itemRadius;
    const r2 = r * r;
    // An item farther than rayLength + r from the origin is never hit within rayLength, plus a rounding margin.
    const far = this.rayLength + r + 1e-9 * this.rayLength;
    const far2 = far * far;
    const margin = r + 1e-9 * this.rayLength;
    const lx = cache.listX;
    const ly = cache.listY;
    const lk = cache.listKind;
    const cfx = cache.candFx;
    const cfy = cache.candFy;
    const cc = cache.candC;
    const ck = cache.candKind;
    let n = 0;
    for (let k = 0; k < cache.count; k++) {
      const fx = lx[k] - x;
      const fy = ly[k] - y;
      const d2 = fx * fx + fy * fy;
      if (d2 > far2) continue;
      if (wedge && (d0x * fy - d0y * fx < -margin || d1x * fy - d1y * fx > margin)) continue;
      cfx[n] = fx;
      cfy[n] = fy;
      cc[n] = d2 - r2;
      ck[n++] = lk[k];
    }
    cache.candCount = n;
  }

  // Writes the grid cells overlapping the square of half-width reach around (x, y) into target, clamped to the grid.
  private clampCellRange(x: number, y: number, reach: number, target: CellRange): void {
    const inv = 1 / this.cell;
    target.rangeX0 = Math.max(0, Math.floor((x - reach) * inv));
    target.rangeX1 = Math.min(this.cols - 1, Math.floor((x + reach) * inv));
    target.rangeY0 = Math.max(0, Math.floor((y - reach) * inv));
    target.rangeY1 = Math.min(this.rows - 1, Math.floor((y + reach) * inv));
  }

  // Lists the items within rayLength + radius + slack of (x, y) in grid order; valid while the origin stays within slack.
  private rebuildList(x: number, y: number, cache: RayCache): void {
    const reach = this.listReach;
    const reach2 = reach * reach;
    this.clampCellRange(x, y, reach, cache);
    const { rangeX0: cx0, rangeX1: cx1, rangeY0: cy0, rangeY1: cy1 } = cache;
    const xs = this.xs;
    const ys = this.ys;
    let n = 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let i = this.cellHead[cy * this.cols + cx]; i >= 0; i = this.nextItem[i]) {
          const fx = xs[i] - x;
          const fy = ys[i] - y;
          if (fx * fx + fy * fy > reach2) continue;
          if (n === cache.listX.length) cache.grow();
          cache.listX[n] = xs[i];
          cache.listY[n] = ys[i];
          cache.listId[n] = i;
          cache.listKind[n++] = this.itemKind(i);
        }
      }
    }
    cache.count = n;
    cache.anchorX = x;
    cache.anchorY = y;
    cache.version = this.version;
  }

  // Nearest of the wall and the gathered candidates along the unit direction (dx, dy).
  private traceRay(x: number, y: number, dx: number, dy: number, out: RayHit, cache: RayCache): void {
    const L = this.rayLength;
    let best = L;
    let kind: HitKind = HIT_NONE;

    // Walls: ray exits the box at the smallest positive t.
    let tw = Infinity;
    if (dx > 0) tw = (this.width - x) / dx;
    else if (dx < 0) tw = -x / dx;
    if (dy > 0) {
      const t = (this.height - y) / dy;
      if (t < tw) tw = t;
    } else if (dy < 0) {
      const t = -y / dy;
      if (t < tw) tw = t;
    }
    if (tw < 0) tw = 0;
    if (tw < best) {
      best = tw;
      kind = HIT_WALL;
    }

    const fxs = cache.candFx;
    const fys = cache.candFy;
    const cs = cache.candC;
    for (let k = 0; k < cache.candCount; k++) {
      const fx = fxs[k];
      const fy = fys[k];
      const c = cs[k];
      const b = fx * dx + fy * dy;
      let t: number;
      if (c < 0) {
        t = 0;
      } else {
        if (b <= 0) continue;
        const disc = b * b - c;
        if (disc < 0) continue;
        t = b - Math.sqrt(disc);
      }
      if (t < best || (t === best && kind === HIT_WALL)) {
        best = t;
        kind = cache.candKind[k] as HitKind;
      }
    }

    if (kind === HIT_NONE) {
      out.closeness = 0;
      out.kind = HIT_NONE;
    } else {
      out.closeness = 1 - best / L;
      out.kind = kind;
    }
  }

  // Items in the grid are always food or poison; free slots are unlinked.
  private itemKind(i: number): HitKind {
    return this.kinds[i] === HIT_FOOD ? HIT_FOOD : HIT_POISON;
  }

  // Index of the first item a body of radius at (x, y) touches, or -1; the item stays until the caller moves or removes it.
  eatAt(x: number, y: number, radius: number, cache: RayCache): number {
    const reach = radius + this.itemRadius;
    const reach2 = reach * reach;
    // The anchored list holds every item within listReach of its anchor, in the same order as the grid walk below.
    const ax = x - cache.anchorX;
    const ay = y - cache.anchorY;
    const lim = this.listReach - reach - 1e-6;
    if (lim > 0 && ax * ax + ay * ay <= lim * lim && this.listValid(cache)) {
      const lx = cache.listX;
      const ly = cache.listY;
      for (let k = 0; k < cache.count; k++) {
        const fx = lx[k] - x;
        const fy = ly[k] - y;
        if (fx * fx + fy * fy < reach2) return cache.listId[k];
      }
      return -1;
    }
    this.clampCellRange(x, y, reach, this.eatRange);
    const { rangeX0: cx0, rangeX1: cx1, rangeY0: cy0, rangeY1: cy1 } = this.eatRange;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let i = this.cellHead[cy * this.cols + cx]; i >= 0; i = this.nextItem[i]) {
          const fx = this.xs[i] - x;
          const fy = this.ys[i] - y;
          if (fx * fx + fy * fy < reach2) return i;
        }
      }
    }
    return -1;
  }
}
