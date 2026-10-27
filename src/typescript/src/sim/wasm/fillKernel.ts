import type { Creature } from "../creature.ts";
import type { GroundField } from "../groundField.ts";
import { FAST_FACTOR, SLOW_FACTOR } from "../terrain.ts";
import type { Terrain } from "../terrain.ts";
import type { World } from "../world.ts";
import { FILL_BYTES, compiled } from "./loader.ts";
import { LAYOUT as L, f64At } from "./layout.ts";
import { Region } from "./resident.ts";
import type { ResidentStore } from "./resident.ts";

// The sense batch of resident creatures (fill.wat): sense records, brain input extras and the brain slot list, built from the rows in one call.

interface FillExports extends WebAssembly.Exports {
  fill(f: number): void;
  prepare(g: number): void;
}

export class WasmFiller {
  private readonly store: ResidentStore;
  private readonly exports: FillExports;
  private readonly rRows = new Region(); // the row addresses of the batch, in batch order
  private readonly rSelves = new Region();
  private readonly rPlace = new Region();
  private readonly rCount = new Region();
  private readonly rPrepRows = new Region(); // prepare's batch
  private readonly rSpecies = new Region(); // prepare's species blocks
  private readonly rGround = new Region(); // the ground field's nodes
  private ground: GroundField | null = null; // the field in rGround
  private pF = 0;
  private pG = 0;

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
    for (const r of [this.rRows, this.rSelves, this.rPlace, this.rCount, this.rPrepRows, this.rSpecies, this.rGround]) r.cap = 0;
    this.ground = null;
    this.pF = this.store.bank.alloc(L.F_BYTES);
    this.pG = this.store.bank.alloc(L.G_BYTES);
  }

  // Twin of prepareRows (residentStep.ts) without the energy signal, for the rows at rows[0 .. n-1] (byte addresses): the brain input extras after the signal and the ground factor.
  prepare(rows: Int32Array, n: number, terrain: Terrain): void {
    const store = this.store;
    const species = store.species;
    const rowsAt = store.grow(this.rPrepRows, n * 4);
    const speciesAt = store.grow(this.rSpecies, species.length * L.H_BYTES);
    const field = terrain.empty ? null : terrain.ground;
    if (field !== null && field !== this.ground) {
      const at = store.grow(this.rGround, field.data.length);
      new Uint8Array(store.i32.buffer, at, field.data.length).set(field.data);
      this.ground = field;
    }
    const { f64, i32 } = store; // after the last allocation
    i32.set(rows.subarray(0, n), rowsAt >> 2);
    for (let s = 0; s < species.length; s++) {
      const c = species[s]!.creature;
      const h = (speciesAt + s * L.H_BYTES) >> 3;
      f64[h + f64At(L.H_DRAG)] = c.drag;
      f64[h + f64At(L.H_MAX_THRUST)] = c.maxThrust;
      f64[h + f64At(L.H_MAX_TURN)] = c.maxTurnRate;
    }
    const G = this.pG;
    i32[(G + L.G_N) >> 2] = n;
    i32[(G + L.G_ROWS) >> 2] = rowsAt;
    i32[(G + L.G_SPECIES) >> 2] = speciesAt;
    i32[(G + L.G_RASTER) >> 2] = field ? this.rGround.ptr : 0;
    i32[(G + L.G_EMPTY) >> 2] = terrain.empty ? 1 : 0;
    if (field) {
      i32[(G + L.G_STRIDE) >> 2] = 2 * field.cols;
      f64[(G + L.G_INV) >> 3] = field.inv;
      f64[(G + L.G_COL_MAX) >> 3] = field.cols - 1.0001;
      f64[(G + L.G_ROW_MAX) >> 3] = field.rows - 1.0001;
    }
    f64[(G + L.G_SLOW) >> 3] = SLOW_FACTOR;
    f64[(G + L.G_FAST) >> 3] = FAST_FACTOR;
    this.exports.prepare(G);
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
