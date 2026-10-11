import type { EngineConfig } from "./config.ts";
import { HIT_CREATURE, HIT_NONE } from "./types.ts";
import type { CreatureState, RayHit } from "./types.ts";

// Creatures in a uniform grid of cell size config.creature.rayLength, rebuilt by counting sort each tick.
// Each cell's creatures are contiguous in the sorted arrays: slots cellStart[c] .. cellStart[c + 1] - 1.
// A perf study measured the rebuild under 1% of a tick and queries 20-25% faster than per-cell linked lists.
export class Crowd {
  count = 0;
  readonly cols: number;
  readonly rows: number;
  readonly cellStart: Int32Array;
  // Sorted by cell; owner is the index into the states array the grid was built from.
  xs: Float64Array;
  ys: Float64Array;
  energies: Float64Array;
  owners: Int32Array;

  private readonly cell: number;
  private readonly radius: number;
  private cellOf: Int32Array;
  private px = new Float64Array(0); // rebuild's copy of the states, in list order
  private py = new Float64Array(0);
  private pe = new Float64Array(0);
  private readonly cursor: Int32Array;
  // Candidates of one sensing: offset to the creature, squared distance minus squared radius, energy.
  private candFx = new Float64Array(64);
  private candFy = new Float64Array(64);
  private candC = new Float64Array(64);
  private candE = new Float64Array(64);

  constructor(config: EngineConfig, capacity = 64) {
    this.radius = config.creature.radius;
    this.cell = Math.max(config.creature.rayLength, 2 * this.radius, 1);
    this.cols = Math.max(1, Math.ceil(config.world.width / this.cell));
    this.rows = Math.max(1, Math.ceil(config.world.height / this.cell));
    this.cellStart = new Int32Array(this.cols * this.rows + 1);
    this.cursor = new Int32Array(this.cols * this.rows);
    this.xs = new Float64Array(capacity);
    this.ys = new Float64Array(capacity);
    this.energies = new Float64Array(capacity);
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

  // Snapshots positions and energies of states[0 .. n-1].
  rebuild(states: readonly CreatureState[], n: number): void {
    if (n > this.px.length) {
      const size = Math.max(n, 2 * this.px.length);
      this.px = new Float64Array(size);
      this.py = new Float64Array(size);
      this.pe = new Float64Array(size);
    }
    for (let i = 0; i < n; i++) {
      const s = states[i];
      this.px[i] = s.x;
      this.py[i] = s.y;
      this.pe[i] = s.energy;
    }
    this.rebuildFrom(this.px, this.py, this.pe, n);
  }

  // The same from arrays: creature i at (x[i], y[i]) with energy e[i].
  rebuildFrom(x: Float64Array, y: Float64Array, e: Float64Array, n: number): void {
    if (n > this.xs.length) this.grow(n);
    const start = this.cellStart;
    start.fill(0);
    const cellOf = this.cellOf;
    for (let i = 0; i < n; i++) {
      const c = this.cellIndex(x[i], y[i]);
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < this.cursor.length; c++) {
      start[c + 1] += start[c];
      this.cursor[c] = start[c];
    }
    for (let i = 0; i < n; i++) {
      const k = this.cursor[cellOf[i]]++;
      this.xs[k] = x[i];
      this.ys[k] = y[i];
      this.energies[k] = e[i];
      this.owners[k] = i;
    }
    this.count = n;
  }

  private grow(n: number): void {
    const size = Math.max(n, 2 * this.xs.length);
    this.xs = new Float64Array(size);
    this.ys = new Float64Array(size);
    this.energies = new Float64Array(size);
    this.owners = new Int32Array(size);
    this.cellOf = new Int32Array(size);
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
  }
}
