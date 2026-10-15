import type { Creature } from "../creature.ts";
import type { World } from "../world.ts";
import { FILL_BYTES, compiled } from "./loader.ts";
import { LAYOUT as L } from "./layout.ts";
import { Region } from "./resident.ts";
import type { ResidentStore } from "./resident.ts";

// The sense batch of resident creatures (fill.wat): sense records, brain input extras and the brain slot list, built from the rows in one call.

interface FillExports extends WebAssembly.Exports {
  fill(f: number): void;
}

export class WasmFiller {
  private readonly store: ResidentStore;
  private readonly exports: FillExports;
  private readonly rRows = new Region(); // the row addresses of the batch, in batch order
  private readonly rSelves = new Region();
  private readonly rPlace = new Region();
  private readonly rCount = new Region();
  private pF = 0;

  private constructor(store: ResidentStore, exports: FillExports) {
    this.store = store;
    this.exports = exports;
    this.reset();
  }

  static create(store: ResidentStore): WasmFiller | null {
    try {
      const instance = new WebAssembly.Instance(compiled(FILL_BYTES), { brain: { mem: store.bank.memory } });
      return new WasmFiller(store, instance.exports as FillExports);
    } catch {
      return null;
    }
  }

  // Back to a new filler's state, after the brain bank was reset (its arena, and with it every address held here, is gone).
  reset(): void {
    for (const r of [this.rRows, this.rSelves, this.rPlace, this.rCount]) r.cap = 0;
    this.pF = this.store.bank.alloc(L.F_BYTES);
  }

  // The sense records (into pRec, sorted by item grid row) and brain input extras of the batch of row addresses rows[0 .. n-1], and the brain slot
  // list at slotsAt. selves[k] is the crowd index of batch member k; detail, when in the batch, gets its rays written at pDetail.
  fill(rows: Int32Array, selves: Int32Array, n: number, world: World, pRec: number, slotsAt: number, pDetail: number, detail: Creature | null, stride: number): void {
    const store = this.store;
    const rowsAt = store.grow(this.rRows, n * 4);
    const selvesAt = store.grow(this.rSelves, n * 4);
    const placeAt = store.grow(this.rPlace, n * 4);
    const countAt = store.grow(this.rCount, (world.rows + 1) * 4);
    const { f64, i32 } = store; // after the last allocation
    i32.set(rows.subarray(0, n), rowsAt >> 2);
    i32.set(selves.subarray(0, n), selvesAt >> 2);
    const F = this.pF;
    i32[(F + L.F_N) >> 2] = n;
    i32[(F + L.F_ROWS) >> 2] = rowsAt;
    i32[(F + L.F_SELVES) >> 2] = selvesAt;
    i32[(F + L.F_REC) >> 2] = pRec;
    i32[(F + L.F_PLACE) >> 2] = placeAt;
    i32[(F + L.F_COUNT) >> 2] = countAt;
    i32[(F + L.F_SLOTS) >> 2] = slotsAt;
    i32[(F + L.F_DETAIL_PTR) >> 2] = pDetail;
    i32[(F + L.F_DETAIL_ROW) >> 2] = detail ? detail.resident!.ptr : 0;
    i32[(F + L.F_STRIDE) >> 2] = stride;
    i32[(F + L.F_ITEM_ROWS) >> 2] = world.rows;
    f64[(F + L.F_INV_CELL) >> 3] = 1 / world.cell;
    this.exports.fill(F);
  }
}
