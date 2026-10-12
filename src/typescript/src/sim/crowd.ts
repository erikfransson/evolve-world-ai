import type { EngineConfig } from "./config.ts";
import { HIT_CREATURE, HIT_NONE } from "./types.ts";
import type { CreatureState, RayHit } from "./types.ts";

const SMALL_SORT = 12; // up to this many creatures rebuildFrom sorts by insertion: RL episodes have 1-11 creatures, the radix sort pays off for crowds

// Creatures in a uniform grid of cell size config.creature.rayLength, rebuilt each tick by a stable radix sort of the cell keys,
// so the work follows the creature count, not the world area. Each cell's creatures are contiguous in the sorted arrays, in
// creature order: slots cellStart[c] .. cellStart[c + 1] - 1. Queries were measured 20-25% faster than per-cell linked lists.
export class Crowd {
  count = 0;
  readonly cols: number;
  readonly rows: number;
  readonly cellStart: Int32Array;
  // Sorted by cell; owner is the index into the states array the grid was built from.
  xs: Float64Array;
  ys: Float64Array;
  energies: Float64Array;
  species: Int32Array;
  owners: Int32Array;

  readonly cell: number;
  readonly radius: number;
  private cellOf: Int32Array;
  private px = new Float64Array(0); // rebuild's copy of the states, in list order
  private py = new Float64Array(0);
  private pe = new Float64Array(0);
  private ps = new Int32Array(0);
  // Occupied cells in ascending order, occupiedCount of them, so sweeps skip the empty cells.
  occupied: Int32Array;
  occupiedCount = 0;
  private perm: Int32Array; // creature indices in cell order, and the radix sort's second buffer
  private permB: Int32Array;
  private readonly radixPasses: number;
  private readonly radixBits: number;
  private readonly radixCount: Int32Array;
  // Candidates of one sensing: offset to the creature, squared distance minus squared radius, energy.
  private candFx = new Float64Array(64);
  private candFy = new Float64Array(64);
  private candC = new Float64Array(64);
  private candE = new Float64Array(64);
  private candS = new Int32Array(64);

  constructor(config: EngineConfig, capacity = 64) {
    this.radius = config.creature.radius;
    this.cell = Math.max(config.creature.rayLength, 2 * this.radius, 1);
    this.cols = Math.max(1, Math.ceil(config.world.width / this.cell));
    this.rows = Math.max(1, Math.ceil(config.world.height / this.cell));
    this.cellStart = new Int32Array(this.cols * this.rows + 1);
    const keyBits = Math.max(1, Math.ceil(Math.log2(this.cols * this.rows)));
    this.radixPasses = Math.ceil(keyBits / 11);
    this.radixBits = Math.ceil(keyBits / this.radixPasses);
    this.radixCount = new Int32Array(1 << this.radixBits);
    this.perm = new Int32Array(capacity);
    this.permB = new Int32Array(capacity);
    this.occupied = new Int32Array(capacity);
    this.xs = new Float64Array(capacity);
    this.ys = new Float64Array(capacity);
    this.energies = new Float64Array(capacity);
    this.species = new Int32Array(capacity);
    this.owners = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);
  }

  cellIndex(x: number, y: number): number {
    let cx = Math.floor(x / this.cell);
    let cy = Math.floor(y / this.cell);
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0;
    else if (cy >= this.rows) cy = this.rows - 1;
    return cy * this.cols + cx;
  }

  // Snapshots positions and energies of states[0 .. n-1], and species[i] of each (all 0 without).
  rebuild(states: readonly CreatureState[], n: number, species?: ArrayLike<number>): void {
    if (n > this.px.length) {
      const size = Math.max(n, 2 * this.px.length);
      this.px = new Float64Array(size);
      this.py = new Float64Array(size);
      this.pe = new Float64Array(size);
      this.ps = new Int32Array(size);
    }
    for (let i = 0; i < n; i++) {
      const s = states[i];
      this.px[i] = s.x;
      this.py[i] = s.y;
      this.pe[i] = s.energy;
      this.ps[i] = species ? species[i]! : 0;
    }
    this.rebuildFrom(this.px, this.py, this.pe, n, this.ps);
  }

  // True when a snapshotted creature is closer than reach to (x, y).
  anyWithin(x: number, y: number, reach: number): boolean {
    const inv = 1 / this.cell;
    const cx0 = Math.max(0, Math.floor((x - reach) * inv));
    const cx1 = Math.min(this.cols - 1, Math.floor((x + reach) * inv));
    const cy0 = Math.max(0, Math.floor((y - reach) * inv));
    const cy1 = Math.min(this.rows - 1, Math.floor((y + reach) * inv));
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * this.cols;
      const end = this.cellStart[row + cx1 + 1]!;
      for (let t = this.cellStart[row + cx0]!; t < end; t++) {
        if ((this.xs[t]! - x) ** 2 + (this.ys[t]! - y) ** 2 < reach * reach) return true;
      }
    }
    return false;
  }

  // The same from arrays: creature i at (x[i], y[i]) with energy e[i] and species sp[i] (all 0 without).
  rebuildFrom(x: Float64Array, y: Float64Array, e: Float64Array, n: number, sp?: ArrayLike<number>): void {
    if (n > this.xs.length) this.grow(n);
    const cellOf = this.cellOf;
    for (let i = 0; i < n; i++) cellOf[i] = this.cellIndex(x[i], y[i]);
    const bits = this.radixBits;
    const mask = (1 << bits) - 1;
    const count = this.radixCount;
    let from = this.permB;
    let to = this.perm;
    if (n <= SMALL_SORT) {
      // Few creatures: stable insertion sort gives the same order as the radix passes without clearing their counters.
      for (let i = 0; i < n; i++) {
        const v = cellOf[i];
        let j = i;
        while (j > 0 && cellOf[to[j - 1]] > v) {
          to[j] = to[j - 1];
          j--;
        }
        to[j] = i;
      }
    } else {
      // Stable LSD radix sort of the creature indices by cell, so equal cells keep creature order.
      for (let i = 0; i < n; i++) to[i] = i;
      for (let pass = 0; pass < this.radixPasses; pass++) {
        const shift = pass * bits;
        const swap = from;
        from = to;
        to = swap;
        count.fill(0);
        for (let i = 0; i < n; i++) count[(cellOf[from[i]] >> shift) & mask]++;
        let sum = 0;
        for (let b = 0; b <= mask; b++) {
          const c = count[b];
          count[b] = sum;
          sum += c;
        }
        for (let i = 0; i < n; i++) {
          const j = from[i];
          to[count[(cellOf[j] >> shift) & mask]++] = j;
        }
      }
    }
    this.perm = to;
    this.permB = from;
    // Sorted arrays, and cellStart[c] = creatures in cells below c, written by the gaps between occupied cells.
    const start = this.cellStart;
    const occupied = this.occupied;
    const { xs, ys, energies, species, owners } = this;
    let prev = -1;
    let m = 0;
    for (let k = 0; k < n; k++) {
      const i = to[k];
      xs[k] = x[i];
      ys[k] = y[i];
      energies[k] = e[i];
      species[k] = sp ? sp[i]! : 0;
      owners[k] = i;
      const c = cellOf[i];
      if (c !== prev) {
        if (c - prev > 32) start.fill(k, prev + 1, c + 1);
        else for (let g = prev + 1; g <= c; g++) start[g] = k;
        occupied[m++] = c;
        prev = c;
      }
    }
    start.fill(n, prev + 1);
    this.occupiedCount = m;
    this.count = n;
  }

  private grow(n: number): void {
    const size = Math.max(n, 2 * this.xs.length);
    this.xs = new Float64Array(size);
    this.ys = new Float64Array(size);
    this.energies = new Float64Array(size);
    this.species = new Int32Array(size);
    this.owners = new Int32Array(size);
    this.cellOf = new Int32Array(size);
    this.perm = new Int32Array(size);
    this.permB = new Int32Array(size);
    this.occupied = new Int32Array(size);
  }

  // Overwrites each ray of length L in out whose nearest creature, other than owner self, is nearer than what it already holds.
  castRays(x: number, y: number, dirX: Float64Array, dirY: Float64Array, out: readonly RayHit[], self: number, L: number): void {
    const r = this.radius;
    const r2 = r * r;
    const far = L + r + 1e-9 * L;
    const margin = r + 1e-9 * L;
    const last = out.length - 1;
    // Same wedge cull as World.castRays.
    const wedge = last > 0 && dirX[0] * dirY[last] - dirY[0] * dirX[last] > 1e-9;
    const d0x = dirX[0];
    const d0y = dirY[0];
    const d1x = dirX[last];
    const d1y = dirY[last];
    const inv = 1 / this.cell;
    const cx0 = Math.max(0, Math.floor((x - far) * inv));
    const cx1 = Math.min(this.cols - 1, Math.floor((x + far) * inv));
    const cy0 = Math.max(0, Math.floor((y - far) * inv));
    const cy1 = Math.min(this.rows - 1, Math.floor((y + far) * inv));
    let n = 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * this.cols;
      const k1 = this.cellStart[row + cx1 + 1];
      // Cells of one row are contiguous in the sorted arrays.
      for (let k = this.cellStart[row + cx0]; k < k1; k++) {
        if (this.owners[k] === self) continue;
        const fx = this.xs[k] - x;
        const fy = this.ys[k] - y;
        const d2 = fx * fx + fy * fy;
        if (d2 > far * far) continue;
        if (wedge && (d0x * fy - d0y * fx < -margin || d1x * fy - d1y * fx > margin)) continue;
        if (n === this.candFx.length) this.growCandidates();
        this.candFx[n] = fx;
        this.candFy[n] = fy;
        this.candC[n] = d2 - r2;
        this.candS[n] = this.species[k];
        this.candE[n++] = this.energies[k];
      }
    }
    if (n === 0) return;
    for (let i = 0; i < out.length; i++) {
      const ray = out[i];
      const dx = dirX[i];
      const dy = dirY[i];
      let best = ray.kind === HIT_NONE ? L : (1 - ray.closeness) * L;
      let hit = -1;
      for (let k = 0; k < n; k++) {
        const c = this.candC[k];
        const b = this.candFx[k] * dx + this.candFy[k] * dy;
        let t: number;
        if (c < 0) {
          t = 0;
        } else {
          if (b <= 0) continue;
          const disc = b * b - c;
          if (disc < 0) continue;
          t = b - Math.sqrt(disc);
        }
        if (t < best) {
          best = t;
          hit = k;
        }
      }
      if (hit >= 0) {
        ray.closeness = 1 - best / L;
        ray.kind = HIT_CREATURE;
        ray.energy = this.candE[hit];
        ray.species = this.candS[hit];
      }
    }
  }

  private growCandidates(): void {
    const size = 2 * this.candFx.length;
    for (const key of ["candFx", "candFy", "candC", "candE"] as const) {
      const grown = new Float64Array(size);
      grown.set(this[key]);
      this[key] = grown;
    }
    const species = new Int32Array(size);
    species.set(this.candS);
    this.candS = species;
  }
}
