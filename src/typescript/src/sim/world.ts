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
  reach = 0; // radius the list was gathered with, set by the creature's ray length
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

// Records of World.log.
export const ITEM_SET = 1;
export const ITEM_REMOVE = 2;

// Food and poison items in fixed slots; a slot of kind HIT_NONE is free.
const BLOCK = 4; // cells per block side in blockStamp; the shifts by 2 below divide by it
const MAX_REJECTS = 256; // placement tries that honour reject before giving up on it

export class World implements WorldView {
  readonly count: number; // slot capacity
  // Writes must go through setItem or removeItem to keep the grid valid.
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly kinds: Uint8Array;

  private readonly width: number;
  private readonly height: number;
  private readonly itemRadius: number;
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
  // The same per block of BLOCK x BLOCK cells, so a cache check can skip whole blocks that did not change.
  private readonly blockCols: number;
  private readonly blockStamp: Int32Array;
  private readonly eatRange: CellRange = { rangeX0: 0, rangeX1: 0, rangeY0: 0, rangeY1: 0 };
  // When set, every item change is appended (ITEM_SET, slot, x, y, kind or ITEM_REMOVE, slot), so a copy of this world replaying them stays identical.
  log: number[] | null = null;

  constructor(config: EngineConfig, capacity: number) {
    const w = config.world;
    this.width = w.width;
    this.height = w.height;
    this.itemRadius = w.itemRadius;
    this.count = capacity;
    this.xs = new Float32Array(capacity);
    this.ys = new Float32Array(capacity);
    this.kinds = new Uint8Array(capacity);
    this.cell = Math.max(config.creature.rayLength, 4 * this.itemRadius, 1); // any ray length works, this one sets the grid granularity
    this.cols = Math.max(1, Math.ceil(this.width / this.cell));
    this.rows = Math.max(1, Math.ceil(this.height / this.cell));
    this.cellHead = new Int32Array(this.cols * this.rows).fill(-1);
    this.cellStamp = new Int32Array(this.cols * this.rows);
    this.blockCols = Math.ceil(this.cols / BLOCK);
    this.blockStamp = new Int32Array(this.blockCols * Math.ceil(this.rows / BLOCK));
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
  // With clear, poison positions inside that disc are drawn again.
  scatter(food: number, poison: number, rng: Rng, clear?: { x: number; y: number; radius: number }): void {
    if (clear && poison > 0 && this.discCoversBox(clear)) throw new Error("clear disc leaves no room for poison");
    for (let i = 0; i < food + poison; i++) this.placeRandomly(i, i < food ? HIT_FOOD : HIT_POISON, rng, i < food ? undefined : clear);
  }

  // True when the disc contains all four corners of the item box, so no position is left outside it.
  private discCoversBox(d: { x: number; y: number; radius: number }): boolean {
    const r = this.itemRadius;
    return [r, this.width - r].every((x) => [r, this.height - r].every((y) => (x - d.x) ** 2 + (y - d.y) ** 2 < d.radius ** 2));
  }

  // Puts item i at a uniform random position inside the walls, outside the clear disc if given and where reject says no.
  // reject is dropped after MAX_REJECTS tries, so a crowded world cannot loop forever; the clear disc always holds.
  placeRandomly(i: number, kind: HitKind, rng: Rng, clear?: { x: number; y: number; radius: number }, reject?: (x: number, y: number) => boolean): void {
    const r = this.itemRadius;
    let x: number;
    let y: number;
    let tries = 0;
    do {
      x = rng.range(r, this.width - r);
      y = rng.range(r, this.height - r);
    } while ((clear && (x - clear.x) ** 2 + (y - clear.y) ** 2 < clear.radius ** 2) || (tries++ < MAX_REJECTS && reject?.(x, y)));
    this.setItem(i, x, y, kind);
  }

  // Moves every poison item touching a body of this radius at (x, y) to a random spot, repeating until none touches.
  // avoid: spots it must not move poison to, such as other bodies already placed (a body of the same radius at each).
  clearPoison(x: number, y: number, radius: number, rng: Rng, avoid?: (x: number, y: number) => boolean): void {
    for (let p = this.poisonAt(x, y, radius); p >= 0; p = this.poisonAt(x, y, radius)) {
      this.placeRandomly(p, HIT_POISON, rng, { x, y, radius: radius + this.itemRadius }, avoid);
    }
  }

  private poisonAt(x: number, y: number, radius: number): number {
    const reach = radius + this.itemRadius;
    this.clampCellRange(x, y, reach, this.eatRange);
    const { rangeX0: cx0, rangeX1: cx1, rangeY0: cy0, rangeY1: cy1 } = this.eatRange;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let i = this.cellHead[cy * this.cols + cx]; i >= 0; i = this.nextItem[i]) {
          const fx = this.xs[i] - x;
          const fy = this.ys[i] - y;
          if (this.kinds[i] === HIT_POISON && fx * fx + fy * fy < reach * reach) return i;
        }
      }
    }
    return -1;
  }

  // Places item i and keeps the grid valid.
  setItem(i: number, x: number, y: number, kind: HitKind): void {
    this.log?.push(ITEM_SET, i, x, y, kind);
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
    this.stampCell(c);
  }

  // Frees slot i; its item leaves the grid.
  removeItem(i: number): void {
    this.log?.push(ITEM_REMOVE, i);
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
    this.stampCell(c);
  }

  private stampCell(c: number): void {
    this.cellStamp[c] = this.version;
    const cy = Math.floor(c / this.cols);
    this.blockStamp[(cy >> 2) * this.blockCols + ((c - cy * this.cols) >> 2)] = this.version;
  }

  // Casts one ray per direction (dirX[i], dirY[i]) from (x, y), sharing the item lookup between them.
  // Rays reach length; one cache serves one creature.
  castRays(x: number, y: number, dirX: Float64Array, dirY: Float64Array, out: readonly RayHit[], cache: RayCache, length: number): void {
    const last = out.length - 1;
    // Rays are ordered across a fan narrower than a half turn, so an item further than its radius outside the first and last ray cannot be hit.
    const wedge = last > 0 && dirX[0] * dirY[last] - dirY[0] * dirX[last] > 1e-9;
    this.gatherCandidates(x, y, length, wedge, dirX[0], dirY[0], dirX[last], dirY[last], cache);
    // Directions are unit length to within rounding, so a wall at least length (plus a margin) away on every side cannot be reached.
    const m = length * (1 + 1e-6);
    const walls = x < m || this.width - x < m || y < m || this.height - y < m;
    for (let i = 0; i < out.length; i++) this.traceRay(x, y, dirX[i], dirY[i], out[i], cache, length, walls);
  }

  // True while no item changed in the cells the cached list was gathered from.
  private listValid(cache: RayCache): boolean {
    if (cache.version === this.version) return true;
    if (cache.version < 0) return false;
    const { rangeX0: cx0, rangeX1: cx1, rangeY0: cy0, rangeY1: cy1 } = cache;
    const v = cache.version;
    for (let by = cy0 >> 2; by <= cy1 >> 2; by++) {
      for (let bx = cx0 >> 2; bx <= cx1 >> 2; bx++) {
        if (this.blockStamp[by * this.blockCols + bx] <= v) continue;
        const y0 = Math.max(cy0, by << 2);
        const y1 = Math.min(cy1, (by << 2) + 3);
        const x0 = Math.max(cx0, bx << 2);
        const x1 = Math.min(cx1, (bx << 2) + 3);
        for (let cy = y0; cy <= y1; cy++) {
          for (let cx = x0; cx <= x1; cx++) {
            if (this.cellStamp[cy * this.cols + cx] > v) return false;
          }
        }
      }
    }
    cache.version = this.version;
    return true;
  }

  // Collects items that can be hit by a ray from (x, y), with their ray-independent terms.
  private gatherCandidates(x: number, y: number, length: number, wedge: boolean, d0x: number, d0y: number, d1x: number, d1y: number, cache: RayCache): void {
    const r = this.itemRadius;
    const slack = 0.3 * length;
    const listReach = length + r + 2e-9 * length + slack;
    const ax = x - cache.anchorX;
    const ay = y - cache.anchorY;
    if (ax * ax + ay * ay > slack * slack || cache.reach !== listReach || !this.listValid(cache)) this.rebuildList(x, y, listReach, cache);
    const r2 = r * r;
    // An item farther than length + r from the origin is never hit within length, plus a rounding margin.
    const far = length + r + 1e-9 * length;
    const far2 = far * far;
    const margin = r + 1e-9 * length;
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

  // Lists the items within reach (ray length + radius + slack) of (x, y) in grid order; valid while the origin stays within slack.
  private rebuildList(x: number, y: number, reach: number, cache: RayCache): void {
    cache.reach = reach;
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
  private traceRay(x: number, y: number, dx: number, dy: number, out: RayHit, cache: RayCache, L: number, walls: boolean): void {
    let best = L;
    let kind: HitKind = HIT_NONE;

    // Walls: ray exits the box at the smallest positive t.
    if (walls) {
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
    // The anchored list holds every item within cache.reach of its anchor, in the same order as the grid walk below.
    const ax = x - cache.anchorX;
    const ay = y - cache.anchorY;
    const lim = cache.reach - reach - 1e-6;
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
