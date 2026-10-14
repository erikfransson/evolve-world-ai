import type { Crowd } from "../crowd.ts";
import { CROWD_BYTES, compiled } from "./loader.ts";
import { LAYOUT as L } from "./layout.ts";
import { Region } from "./resident.ts";
import type { ResidentStore } from "./resident.ts";

// The crowd grid of resident creatures built in WebAssembly (crowd.wat), straight from the rows into the kernel memory, where the Crowd's arrays
// are views. Twin of Crowd.rebuildRows, which stays the reference and the fallback; tests/typescript/wasmCrowd.test.ts compares them.

let jsOnly = false;
// Builds the crowd in JS even where the WebAssembly kernel exists (tests and comparisons).
export function forceJsCrowd(flag: boolean): void {
  jsOnly = flag;
}
export const jsCrowdForced = (): boolean => jsOnly;

interface CrowdExports extends WebAssembly.Exports {
  rebuild(c: number): void;
  pack(c: number): void;
  touch(c: number): void;
  sweep(c: number): number;
}

const REGIONS = ["touched", "rowAt", "cellOf", "perm", "permB", "count", "start", "occupied", "speciesIn", "xs", "ys", "energies", "species", "owners"] as const;
// The first n elements, for lists that may be longer than the batch.
const head = (a: ArrayLike<number>, n: number): ArrayLike<number> => (a.length === n ? a : Array.prototype.slice.call(a, 0, n) as number[]);
type Name = (typeof REGIONS)[number];

export class WasmCrowd {
  private readonly store: ResidentStore;
  private readonly crowd: Crowd;
  private readonly exports: CrowdExports;
  private readonly region = Object.fromEntries(REGIONS.map((r) => [r, new Region()])) as Record<Name, Region>;
  private readonly pC: number;
  private n = 0;

  private constructor(store: ResidentStore, crowd: Crowd, exports: CrowdExports) {
    this.store = store;
    this.crowd = crowd;
    this.exports = exports;
    this.pC = store.bank.alloc(L.C_BYTES);
    store.rebinders.add(() => this.bind()); // the views go stale when the memory grows
  }

  static create(store: ResidentStore, crowd: Crowd): WasmCrowd | null {
    try {
      const instance = new WebAssembly.Instance(compiled(CROWD_BYTES), { brain: { mem: store.bank.memory }, math: { exp: Math.exp } });
      return new WasmCrowd(store, crowd, instance.exports as CrowdExports);
    } catch {
      return null;
    }
  }

  // The crowd's arrays as views of the grid in memory.
  private bind(): void {
    if (this.n === 0) return;
    const { buffer } = this.store.bank.memory;
    const r = this.region;
    const n = this.n;
    const cells = this.crowd.cols * this.crowd.rows + 1;
    this.crowd.adopt(
      {
        xs: new Float64Array(buffer, r.xs.ptr, n), ys: new Float64Array(buffer, r.ys.ptr, n), energies: new Float64Array(buffer, r.energies.ptr, n),
        species: new Int32Array(buffer, r.species.ptr, n), owners: new Int32Array(buffer, r.owners.ptr, n),
        cellStart: new Int32Array(buffer, r.start.ptr, cells), occupied: new Int32Array(buffer, r.occupied.ptr, n),
      },
      n,
      this.store.i32[(this.pC + L.C_OCCUPIED_COUNT) >> 2]!,
      this,
    );
  }

  // Addresses of the grid in memory, for the sense kernel to read in place.
  get at(): { start: number; owners: number; species: number } {
    const r = this.region;
    return { start: r.start.ptr, owners: r.owners.ptr, species: r.species.ptr };
  }

  // For the sense kernel: the sorted positions as f32 at sx and sy and each creature's energy signal as f32 at sig (twin of the loop in WasmSenser.run).
  pack(startEnergy: number, sx: number, sy: number, sig: number): void {
    const C = this.pC;
    const i32 = this.store.i32;
    i32[(C + L.C_SX) >> 2] = sx;
    i32[(C + L.C_SY) >> 2] = sy;
    i32[(C + L.C_SIG) >> 2] = sig;
    this.store.f64[(C + L.C_START_ENERGY) >> 3] = startEnergy;
    this.exports.pack(C);
  }

  // The item each creature touches into out[owner] for owners 0 .. count-1 (twin of World.touchedBatch on the crowd's arrays), in cell order, over the packed item
  // rows of the sense kernel (WasmSenser.itemTables). reach is the creature radius plus the item radius.
  touch(tables: { start: number; xy: number; ids: number; cols: number }, rows: number, invCell: number, reach: number, out: Int32Array): void {
    const C = this.pC;
    const { i32, f64 } = this.store;
    const outAt = this.region.touched.ptr;
    const ints: [number, number][] = [
      [L.C_ITEM_START, tables.start], [L.C_ITEM_XY, tables.xy], [L.C_ITEM_IDS, tables.ids], [L.C_ITEM_COLS, tables.cols], [L.C_ITEM_ROWS, rows], [L.C_TOUCH_OUT, outAt],
    ];
    for (const [off, v] of ints) i32[(C + off) >> 2] = v;
    f64[(C + L.C_INV_ITEM_CELL) >> 3] = invCell;
    f64[(C + L.C_ITEM_REACH) >> 3] = reach;
    this.exports.touch(C);
    out.set(i32.subarray(outAt >> 2, (outAt >> 2) + this.n));
  }

  // The collision sweep (twin of the loops in Ecosystem.collideAll) over the crowd arrays, pair by pair: start, then next until it returns false. After a pair the
  // caller must have written the pair's new positions into the crowd arrays. The pair is in hitS and hitT, as sorted slots.
  hitS = 0;
  hitT = 0;
  sweepStart(reach2: number): void {
    const C = this.pC;
    this.store.f64[(C + L.C_REACH2) >> 3] = reach2;
    const i32 = this.store.i32;
    for (const off of [L.C_SW_O, L.C_SW_S, L.C_SW_PHASE, L.C_SW_T, L.C_SW_RESUME]) i32[(C + off) >> 2] = 0;
  }

  sweepNext(): boolean {
    const C = this.pC;
    if (this.exports.sweep(C) === 0) return false;
    const i32 = this.store.i32;
    this.hitS = i32[(C + L.C_HIT_S) >> 2]!;
    this.hitT = i32[(C + L.C_HIT_T) >> 2]!;
    return true;
  }

  // The next rebuild is in JS: the views no longer stand for the crowd.
  drop(): void {
    this.n = 0;
  }

  // Grids the n creatures whose rows are at f64 indices rowAt[0 .. n-1], with species[i] for creature i (all 0 without).
  rebuild(rowAt: ArrayLike<number>, n: number, species?: ArrayLike<number>): void {
    const { store, crowd, region } = this;
    const bytes = n * 4;
    const sizes: Record<Name, number> = {
      touched: bytes, rowAt: bytes, cellOf: bytes, perm: bytes, permB: bytes, count: 4 << crowd.radixBits, start: (crowd.cols * crowd.rows + 1) * 4, occupied: bytes,
      speciesIn: bytes, xs: n * 8, ys: n * 8, energies: n * 8, species: bytes, owners: bytes,
    };
    const at = {} as Record<Name, number>;
    for (const name of REGIONS) at[name] = store.grow(region[name], sizes[name]);
    const { i32, f64 } = store; // after the last allocation
    i32.set(head(rowAt, n), at.rowAt >> 2);
    if (species) i32.set(head(species, n), at.speciesIn >> 2);
    const C = this.pC;
    const fields: [number, number][] = [
      [L.C_N, n], [L.C_ROW_AT, at.rowAt], [L.C_CELL_OF, at.cellOf], [L.C_COLS, crowd.cols], [L.C_ROWS, crowd.rows], [L.C_RADIX_BITS, crowd.radixBits],
      [L.C_RADIX_PASSES, crowd.radixPasses], [L.C_COUNT, at.count], [L.C_PERM, at.perm], [L.C_PERM_B, at.permB], [L.C_CELL_START, at.start],
      [L.C_OCCUPIED, at.occupied], [L.C_SPECIES_IN, species ? at.speciesIn : 0], [L.C_XS, at.xs], [L.C_YS, at.ys], [L.C_ENERGIES, at.energies],
      [L.C_SPECIES, at.species], [L.C_OWNERS, at.owners],
    ];
    for (const [off, v] of fields) i32[(C + off) >> 2] = v;
    f64[(C + L.C_CELL) >> 3] = crowd.cell;
    this.exports.rebuild(C);
    this.n = n;
    this.bind();
  }
}
