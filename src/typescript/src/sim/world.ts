import type { SimConfig } from "./config.ts";
import { itemCounts } from "./config.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON, HIT_WALL } from "./types.ts";
import type { HitKind, RayHit, Rng, WorldView } from "./types.ts";

export class World implements WorldView {
  readonly count: number;
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly kinds: Uint8Array;

  private readonly width: number;
  private readonly height: number;
  private readonly itemRadius: number;
  private readonly rayLength: number;
  private readonly respawnRng: Rng;
  private readonly respawn: boolean;
  // Uniform grid as per-cell linked lists: cellHead[c] -> item -> nextItem[item] -> -1.
  private readonly cell: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cellHead: Int32Array;
  private readonly nextItem: Int32Array;
  private readonly itemCell: Int32Array;
  // Items near the ray origin, gathered once per sensing; ray-independent terms are precomputed.
  private candFx = new Float64Array(32);
  private candFy = new Float64Array(32);
  private candC = new Float64Array(32); // squared distance minus squared item radius
  private candKind = new Uint8Array(32);
  private candCount = 0;

  constructor(config: SimConfig, layoutRng: Rng, respawnRng: Rng) {
    const w = config.world;
    this.width = w.width;
    this.height = w.height;
    this.itemRadius = w.itemRadius;
    this.rayLength = config.creature.rayLength;
    this.respawnRng = respawnRng;
    this.respawn = w.respawn;
    const counts = itemCounts(config);
    this.count = counts.food + counts.poison;
    this.xs = new Float32Array(this.count);
    this.ys = new Float32Array(this.count);
    this.kinds = new Uint8Array(this.count);
    this.cell = Math.max(this.rayLength, 4 * this.itemRadius, 1);
    this.cols = Math.max(1, Math.ceil(this.width / this.cell));
    this.rows = Math.max(1, Math.ceil(this.height / this.cell));
    this.cellHead = new Int32Array(this.cols * this.rows).fill(-1);
    this.nextItem = new Int32Array(this.count).fill(-1);
    this.itemCell = new Int32Array(this.count).fill(-1);

    const r = this.itemRadius;
    for (let i = 0; i < this.count; i++) {
      const x = layoutRng.range(r, this.width - r);
      const y = layoutRng.range(r, this.height - r);
      this.setItem(i, x, y, i < counts.food ? HIT_FOOD : HIT_POISON);
    }
  }

  // Places item i and keeps the grid valid.
  setItem(i: number, x: number, y: number, kind: HitKind): void {
    this.unlink(i);
    this.xs[i] = x;
    this.ys[i] = y;
    this.kinds[i] = kind;
    const c = this.cellIndex(this.xs[i], this.ys[i]);
    this.itemCell[i] = c;
    this.nextItem[i] = this.cellHead[c];
    this.cellHead[c] = i;
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
  }

  // Casts one ray per direction (dirX[i], dirY[i]) from (x, y), sharing the item lookup between them.
  castRays(x: number, y: number, dirX: Float64Array, dirY: Float64Array, out: readonly RayHit[]): void {
    const L = this.rayLength;
    let minX = x;
    let minY = y;
    let maxX = x;
    let maxY = y;
    for (let i = 0; i < out.length; i++) {
      const ex = x + dirX[i] * L;
      const ey = y + dirY[i] * L;
      if (ex < minX) minX = ex;
      else if (ex > maxX) maxX = ex;
      if (ey < minY) minY = ey;
      else if (ey > maxY) maxY = ey;
    }
    this.gatherCandidates(x, y, minX, minY, maxX, maxY);
    for (let i = 0; i < out.length; i++) this.traceRay(x, y, dirX[i], dirY[i], out[i]);
  }

  // Collects items that can be hit by a ray from (x, y) inside the box, with their ray-independent terms.
  private gatherCandidates(x: number, y: number, minX: number, minY: number, maxX: number, maxY: number): void {
    const r = this.itemRadius;
    const inv = 1 / this.cell;
    let cx0 = Math.floor((minX - r) * inv);
    let cx1 = Math.floor((maxX + r) * inv);
    let cy0 = Math.floor((minY - r) * inv);
    let cy1 = Math.floor((maxY + r) * inv);
    if (cx0 < 0) cx0 = 0;
    if (cy0 < 0) cy0 = 0;
    if (cx1 >= this.cols) cx1 = this.cols - 1;
    if (cy1 >= this.rows) cy1 = this.rows - 1;
    const r2 = r * r;
    // An item farther than rayLength + r from the origin is never hit within rayLength.
    const far = this.rayLength + r;
    const far2 = far * far;
    const xs = this.xs;
    const ys = this.ys;
    let n = 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let i = this.cellHead[cy * this.cols + cx]; i >= 0; i = this.nextItem[i]) {
          const fx = xs[i] - x;
          const fy = ys[i] - y;
          const d2 = fx * fx + fy * fy;
          if (d2 > far2) continue;
          if (n === this.candFx.length) this.growCandidates();
          this.candFx[n] = fx;
          this.candFy[n] = fy;
          this.candC[n] = d2 - r2;
          this.candKind[n++] = this.itemKind(i);
        }
      }
    }
    this.candCount = n;
  }

  private growCandidates(): void {
    const size = this.candFx.length * 2;
    for (const key of ["candFx", "candFy", "candC"] as const) {
      const grown = new Float64Array(size);
      grown.set(this[key]);
      this[key] = grown;
    }
    const kinds = new Uint8Array(size);
    kinds.set(this.candKind);
    this.candKind = kinds;
  }

  // Nearest of the wall and the gathered candidates along the unit direction (dx, dy).
  private traceRay(x: number, y: number, dx: number, dy: number, out: RayHit): void {
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

    const fxs = this.candFx;
    const fys = this.candFy;
    const cs = this.candC;
    for (let k = 0; k < this.candCount; k++) {
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
        kind = this.candKind[k] as HitKind;
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

  // Items in the grid are always food or poison; eaten ones are unlinked.
  private itemKind(i: number): HitKind {
    return this.kinds[i] === HIT_FOOD ? HIT_FOOD : HIT_POISON;
  }

  eatAt(x: number, y: number, radius: number): HitKind {
    const reach = radius + this.itemRadius;
    const reach2 = reach * reach;
    const inv = 1 / this.cell;
    let cx0 = Math.floor((x - reach) * inv);
    let cx1 = Math.floor((x + reach) * inv);
    let cy0 = Math.floor((y - reach) * inv);
    let cy1 = Math.floor((y + reach) * inv);
    if (cx0 < 0) cx0 = 0;
    if (cy0 < 0) cy0 = 0;
    if (cx1 >= this.cols) cx1 = this.cols - 1;
    if (cy1 >= this.rows) cy1 = this.rows - 1;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let i = this.cellHead[cy * this.cols + cx]; i >= 0; i = this.nextItem[i]) {
          const fx = this.xs[i] - x;
          const fy = this.ys[i] - y;
          if (fx * fx + fy * fy < reach2) {
            const kind = this.itemKind(i);
            const r = this.itemRadius;
            if (this.respawn) {
              this.setItem(i, this.respawnRng.range(r, this.width - r), this.respawnRng.range(r, this.height - r), kind);
            } else {
              this.unlink(i);
              this.kinds[i] = HIT_NONE;
            }
            return kind;
          }
        }
      }
    }
    return HIT_NONE;
  }
}
