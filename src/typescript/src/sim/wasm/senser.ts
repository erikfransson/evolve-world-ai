import type { Creature } from "../creature.ts";
import type { Crowd } from "../crowd.ts";
import { energySignal } from "../sensors.ts";
import type { Terrain } from "../terrain.ts";
import type { World } from "../world.ts";
import type { WasmBrainBank } from "./brainKernel.ts";
import { HIT_CREATURE } from "../types.ts";
import { SENSE_BYTES, compiled } from "./loader.ts";
import { ROCK_CELL } from "../terrain.ts";
import type { WasmFiller } from "./fillKernel.ts";
import { LAYOUT as L } from "./layout.ts";
import { Region, growRegion } from "./resident.ts";

// The whole Ecosystem sense in one WebAssembly call per batch (sense.wat): ray directions, item and wall rays in f64 with the
// JS candidate order, crowd rays in f32, and the ray features written into the brain's input vector in place.
// Rock (the world's Terrain, static) is copied once per world into three tables the kernel walks like the item grid. Shares the brain bank's linear memory. The item grid is patched per tick (patchItems) and the crowd is read in place. The creature's RayHit objects are not updated, except for the one
// creature given as detail (the selected one), whose rays are read back for the UI.

export const MAX_RAYS = 64;
const ROCK_BOUND_CAP = 2048; // distances past this are not told apart; a ray longer than this walks the rock anyway
const SCRATCH_BYTES = 2816;
const PATCH_MAX = 1024; // dirty cells patched in place per tick; more are cheaper to pack again whole

interface SenseExports extends WebAssembly.Exports {
  sense(p: number): void;
  patchItems(rec: number, n: number, xy: number, kinds: number, ids: number): number;
}

// Per cell of the rock grid, a lower bound of the distance from any point of the cell to the nearest disc edge (ROCK_BOUND_CAP when none is nearer),
// shrunk by 1e-6 relative so f32 rounding cannot raise it. A ray of that length or less from a point in the cell cannot reach a disc.
export function rockLowerBound(cols: number, rows: number, cell: number, x: ArrayLike<number>, y: ArrayLike<number>, r: ArrayLike<number>, count: number): Float32Array {
  const out = new Float32Array(cols * rows).fill(ROCK_BOUND_CAP);
  for (let d = 0; d < count; d++) {
    const reach = ROCK_BOUND_CAP + r[d]!;
    const cx1 = Math.min(cols - 1, Math.floor((x[d]! + reach) / cell));
    const cy1 = Math.min(rows - 1, Math.floor((y[d]! + reach) / cell));
    for (let cy = Math.max(0, Math.floor((y[d]! - reach) / cell)); cy <= cy1; cy++) {
      const dy = Math.max(cy * cell - y[d]!, 0, y[d]! - (cy + 1) * cell);
      for (let cx = Math.max(0, Math.floor((x[d]! - reach) / cell)); cx <= cx1; cx++) {
        const dx = Math.max(cx * cell - x[d]!, 0, x[d]! - (cx + 1) * cell);
        const edge = Math.max(0, Math.hypot(dx, dy) - r[d]!);
        if (edge < out[cy * cols + cx]!) out[cy * cols + cx] = edge;
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] *= 1 - 1e-6;
  return out;
}

interface OffsetTable {
  bits: Uint32Array; // the offsets (f32 bits) the cos and sin at ptr were made from
  hash: number; // of bits; tables with one hash form a chain
  next: OffsetTable | undefined;
  ptr: number;
  bytes: number;
  refs: number;
}

const hashBits = (bits: Uint32Array): number => {
  let h = bits.length;
  for (let i = 0; i < bits.length; i++) h = Math.imul(h ^ bits[i]!, 0x9e3779b1) ^ (h >>> 15);
  return h;
};

const sameBits = (a: Uint32Array, b: Uint32Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

export class WasmSenser {
  private readonly bank: WasmBrainBank;
  private readonly exports: SenseExports;
  // Ray offset tables are shared by content: a slot holds one table, a table is freed when its last slot lets go. So the tables in memory never outnumber the slots.
  private readonly tables = new Map<number, OffsetTable>(); // by hash of the offsets, chained
  private readonly slotTable: (OffsetTable | undefined)[] = [];
  // Named regions of the shared memory, grown on demand (see grow); held in fields so a tick does no lookups.
  private rItems!: Region;
  private rItemXY!: Region;
  private rItemKinds!: Region;
  private rItemIds!: Region;
  private rPatch!: Region;
  private rCStart!: Region;
  private rSx!: Region;
  private rSy!: Region;
  private rOwn!: Region;
  private rSig!: Region;
  private rSpecies!: Region;
  private rRec!: Region;
  private rCand!: Region;
  private rScratch!: Region;
  private rDetail!: Region;
  private rP!: Region;
  private rRockStart!: Region;
  private rRockOrder!: Region;
  private rRockXYR!: Region;
  private rRockLB!: Region;
  // Views of the whole linear memory, valid while buffer is the memory's current buffer (growth replaces it).
  private buffer!: ArrayBuffer | null;
  private f32!: Float32Array;
  private i32!: Int32Array;
  private f64!: Float64Array;
  private u8!: Uint8Array;
  private synced!: World | null; // the world whose items the packed rows in wasm memory match
  private rockSynced!: Terrain | null; // the map whose rock tables are in wasm memory
  private rowCap!: number; // item slots per row run
  private pStart!: number;
  private pXY!: number;
  private pKinds!: number;
  private pIds!: number;

  private constructor(bank: WasmBrainBank, exports: SenseExports) {
    this.bank = bank;
    this.exports = exports;
    this.init();
  }

  // The state of a new senser, for the constructor and reset(); every field that reset() must clear is set here.
  private init(): void {
    this.rItems = new Region();
    this.rItemXY = new Region();
    this.rItemKinds = new Region();
    this.rItemIds = new Region();
    this.rPatch = new Region();
    this.rCStart = new Region();
    this.rSx = new Region();
    this.rSy = new Region();
    this.rOwn = new Region();
    this.rSig = new Region();
    this.rSpecies = new Region();
    this.rRec = new Region();
    this.rCand = new Region();
    this.rScratch = new Region();
    this.rDetail = new Region();
    this.rP = new Region();
    this.rRockStart = new Region();
    this.rRockOrder = new Region();
    this.rRockXYR = new Region();
    this.rRockLB = new Region();
    this.buffer = null;
    this.f32 = new Float32Array(0);
    this.i32 = new Int32Array(0);
    this.f64 = new Float64Array(0);
    this.u8 = new Uint8Array(0);
    this.synced = null;
    this.rockSynced = null;
    this.rowCap = 0;
    this.pStart = 0;
    this.pXY = 0;
    this.pKinds = 0;
    this.pIds = 0;
  }

  static create(bank: WasmBrainBank): WasmSenser | null {
    try {
      const imports = { brain: { mem: bank.memory } };
      const instance = new WebAssembly.Instance(compiled(SENSE_BYTES), imports);
      return new WasmSenser(bank, instance.exports as SenseExports);
    } catch {
      return null;
    }
  }

  // Back to the state of a new senser (the bank must be reset too, its regions are gone).
  reset(): void {
    this.tables.clear();
    this.slotTable.length = 0;
    this.init();
  }

  // Points the slot at the creature's ray offset cos and sin tables, made once per distinct set of offsets (compared by bits); call when the slot's brain is set.
  setOffsets(slot: number, c: Creature): void {
    const n = c.plan.rayCount;
    if (n > MAX_RAYS) throw new Error(`${n} rays exceed ${MAX_RAYS}`);
    const offsets = c.rayOffsets;
    const bits = new Uint32Array(offsets.buffer, offsets.byteOffset, n);
    const held = this.slotTable[slot];
    if (held && sameBits(held.bits, bits)) return;
    const hash = hashBits(bits);
    let table = this.tables.get(hash);
    while (table && !sameBits(table.bits, bits)) table = table.next;
    if (!table) {
      const bytes = 16 * n;
      table = { bits: bits.slice(), hash, next: this.tables.get(hash), ptr: this.bank.alloc(bytes), bytes, refs: 0 };
      this.tables.set(hash, table);
      const f64 = new Float64Array(this.bank.memory.buffer, table.ptr, 2 * n);
      for (let i = 0; i < n; i++) {
        f64[i] = Math.cos(offsets[i]!);
        f64[n + i] = Math.sin(offsets[i]!);
      }
    }
    table.refs++;
    this.slotTable[slot] = table;
    if (held) this.unref(held);
  }

  // Lets go of the slot's table (a creature that left for good).
  release(slot: number): void {
    const held = this.slotTable[slot];
    this.slotTable[slot] = undefined;
    if (held) this.unref(held);
  }

  private unref(table: OffsetTable): void {
    if (--table.refs > 0) return;
    this.unlink(table);
    this.bank.free(table.ptr, table.bytes);
  }

  private unlink(t: OffsetTable): void {
    const head = this.tables.get(t.hash);
    if (head === t) {
      if (t.next) this.tables.set(t.hash, t.next);
      else this.tables.delete(t.hash);
      return;
    }
    let prev = head!;
    while (prev.next !== t) prev = prev.next!;
    prev.next = t.next;
  }

  // The address of the ray offset tables stored for the slot.
  offsetsAt(slot: number): number {
    return this.slotTable[slot]!.ptr;
  }

  // The pointer of region r holding at least bytes, allocated or moved to a larger block when needed (contents are not kept).
  private grow(r: Region, bytes: number): number {
    return growRegion(this.bank, r, bytes);
  }

  // The views of the memory as it is now; take them after the last allocation of a call, as allocating may grow the memory.
  private views(): void {
    const buffer = this.bank.memory.buffer;
    if (buffer === this.buffer) return;
    this.buffer = buffer;
    this.f32 = new Float32Array(buffer);
    this.i32 = new Int32Array(buffer);
    this.f64 = new Float64Array(buffer);
    this.u8 = new Uint8Array(buffer);
  }

  // The packed item rows for kernels that look items up (step.wat), or null when they do not match the world's items right now (changed since the last sync).
  itemTables(world: World): { start: number; xy: number; ids: number; cols: number } | null {
    if (this.synced !== world || world.dirtyCells === null || world.dirtyCells.length > 0) return null;
    return { start: this.pStart, xy: this.pXY, ids: this.pIds, cols: world.cols };
  }

  // Brings the packed item rows up to date: every row the first time, then each changed cell patched in place.
  // A row holds its cells' items in cell order, each cell in list order, in its own run of rowCap slots (start offsets are absolute).
  private syncItems(world: World): void {
    const { cols, rows, cellHead, nextItem } = world;
    const dirty = world.dirtyCells;
    let full = this.synced !== world || !dirty || dirty.length > PATCH_MAX;
    if (!full && dirty!.length > 0) full = !this.patchCells(world, dirty!);
    if (full) {
      let widest = 0;
      for (let row = 0; row < rows; row++) {
        let n = 0;
        for (let c = row * cols; c < (row + 1) * cols; c++) for (let i = cellHead[c]!; i >= 0; i = nextItem[i]!) n++;
        widest = Math.max(widest, n);
      }
      this.rowCap = Math.max(64, Math.ceil(widest * 1.5) + 16);
      this.pStart = this.grow(this.rItems, rows * (cols + 1) * 4);
      this.pXY = this.grow(this.rItemXY, rows * this.rowCap * 8 + 8); // + 8: the sense kernel reads item pairs
      this.pKinds = this.grow(this.rItemKinds, rows * this.rowCap);
      this.pIds = this.grow(this.rItemIds, rows * this.rowCap * 4);
      this.views();
      const start = this.i32;
      const sB = this.pStart >> 2;
      for (let row = 0; row < rows; row++) {
        const s = sB + row * (cols + 1);
        let p = row * this.rowCap;
        for (let cx = 0; cx < cols; cx++) {
          start[s + cx] = p;
          p = this.writeCell(world, row * cols + cx, p);
        }
        start[s + cols] = p;
      }
      this.synced = world;
    }
    if (dirty) dirty.length = 0;
    else world.dirtyCells = [];
  }

  // Makes the packed runs of the dirty cells match their lists: the kernel resizes them in order (the rest of each row shifts by the change in length), then the lists are written.
  // False when a row outgrows its run.
  private patchCells(world: World, dirty: number[]): boolean {
    const { cols, cellHead, nextItem } = world;
    const n = dirty.length;
    const pRec = this.grow(this.rPatch, PATCH_MAX * 16);
    this.views();
    const i32 = this.i32;
    const r = pRec >> 2;
    const sBase = this.pStart; // byte address of itemStart
    for (let k = 0; k < n; k++) {
      const c = dirty[k]!;
      const row = Math.floor(c / cols);
      let m = 0;
      for (let i = cellHead[c]!; i >= 0; i = nextItem[i]!) m++;
      const rowA = sBase + row * (cols + 1) * 4;
      i32[r + 4 * k] = rowA + (c - row * cols) * 4;
      i32[r + 4 * k + 1] = rowA + cols * 4;
      i32[r + 4 * k + 2] = m;
      i32[r + 4 * k + 3] = (row + 1) * this.rowCap;
    }
    if (this.exports.patchItems(pRec, n, this.pXY, this.pKinds, this.pIds) !== n) return false;
    for (let k = 0; k < n; k++) this.writeCell(world, dirty[k]!, i32[i32[r + 4 * k]! >> 2]!);
    return true;
  }

  // Writes cell c's items in list order from packed slot p; returns the slot after them.
  private writeCell(world: World, c: number, p: number): number {
    const { cellHead, nextItem, xs, ys, kinds } = world;
    const xy = this.f32;
    const kd = this.u8;
    const xB = this.pXY >> 2;
    const kB = this.pKinds;
    const ids = this.i32;
    const idB = this.pIds >> 2;
    for (let i = cellHead[c]!; i >= 0; i = nextItem[i]!) {
      ids[idB + p] = i;
      xy[xB + 2 * p] = xs[i]!;
      xy[xB + 2 * p + 1] = ys[i]!;
      kd[kB + p++] = kinds[i]!;
    }
    return p;
  }

  // Senses the batch of resident rows and writes each creature's complete brain input at its slot: the fill kernel builds the records and the body inputs
  // from the rows, and writes the brain slot list at slotsAt. selves[k] is the crowd index of batch member k.
  run(world: World, crowd: Crowd, n: number, selves: Int32Array, stride: number, startEnergy: number, detail: Creature | null, filler: WasmFiller, rows: Int32Array, slotsAt: number, signalToRows = false): void {
    this.syncItems(world);
    const count = crowd.count;
    const ccells = crowd.cols * crowd.rows;
    const rock = world.terrain;
    const kernel = crowd.kernel; // the grid is already in this memory: the kernel packs the f32 columns and the rest is read in place
    const grid = kernel?.at;
    const pCStart = grid ? grid.start : this.grow(this.rCStart, (ccells + 1) * 2);
    const pSx = this.grow(this.rSx, count * 4 + 16);
    const pSy = this.grow(this.rSy, count * 4 + 16);
    const pOwn = grid ? grid.owners : this.grow(this.rOwn, count * 4 + 16);
    const pSig = this.grow(this.rSig, count * 4 + 16);
    const pSpecies = grid ? grid.species : this.grow(this.rSpecies, count * 4 + 16);
    const pRec = this.grow(this.rRec, n * L.REC_BYTES);
    const pCand = this.grow(this.rCand, Math.max((world.count + rock.rockCount) * 32, count * 16) + 64);
    const pRockStart = this.grow(this.rRockStart, rock.rockStart.length * 4);
    const pRockOrder = this.grow(this.rRockOrder, rock.rockCount * 4 + 4);
    const pRockXYR = this.grow(this.rRockXYR, rock.rockCount * 24 + 8);
    const pRockLB = this.grow(this.rRockLB, rock.cols * rock.rows * 4 + 4);
    const pScr = this.grow(this.rScratch, SCRATCH_BYTES);
    const pDetail = this.grow(this.rDetail, 16 * MAX_RAYS);
    const pP = this.grow(this.rP, L.S_BYTES);
    this.views(); // after the last allocation
    let { f32, i32, f64 } = this;
    if (!kernel) new Uint16Array(i32.buffer, pCStart, ccells + 1).set(crowd.cellStart);
    if (this.rockSynced !== rock) {
      i32.set(rock.rockStart, pRockStart >> 2);
      i32.set(rock.rockOrder, pRockOrder >> 2);
      const xyr = pRockXYR >> 3;
      for (let d = 0; d < rock.rockCount; d++) {
        f64[xyr + 3 * d] = rock.rockX[d]!;
        f64[xyr + 3 * d + 1] = rock.rockY[d]!;
        f64[xyr + 3 * d + 2] = rock.rockR[d]!;
      }
      f32.set(rockLowerBound(rock.cols, rock.rows, ROCK_CELL, rock.rockX, rock.rockY, rock.rockR, rock.rockCount), pRockLB >> 2);
      this.rockSynced = rock;
    }
    const sx = pSx >> 2;
    const sy = pSy >> 2;
    const own = pOwn >> 2;
    const sig = pSig >> 2;
    const species = pSpecies >> 2;
    const { xs, ys, owners, energies } = crowd;
    const crowdSpecies = crowd.species;
    if (kernel) kernel.pack(startEnergy, pSx, pSy, pSig, signalToRows);
    else for (let k = 0; k < count; k++) {
      f32[sx + k] = xs[k]!;
      f32[sy + k] = ys[k]!;
      i32[own + k] = owners[k]!;
      i32[species + k] = crowdSpecies[k]!;
      f32[sig + k] = energySignal(energies[k]!, startEnergy);
    }
    filler.fill(rows, selves, n, pOwn, count, pRec, slotsAt, pDetail, detail, stride);
    this.views(); // fill may have grown the memory
    ({ f32, i32, f64 } = this);
    f64[(pP + L.S_WORLD_W) >> 3] = world.width;
    f64[(pP + L.S_WORLD_H) >> 3] = world.height;
    f64[(pP + L.S_ITEM_R) >> 3] = world.itemRadius;
    f64[(pP + L.S_INV_ITEM_CELL) >> 3] = 1 / world.cell;
    f32[(pP + L.S_INV_CROWD_CELL) >> 2] = 1 / crowd.cell;
    f32[(pP + L.S_CROWD_R) >> 2] = crowd.radius;
    i32[(pP + L.S_ITEM_COLS) >> 2] = world.cols;
    i32[(pP + L.S_ITEM_ROWS) >> 2] = world.rows;
    i32[(pP + L.S_ITEM_START) >> 2] = this.pStart;
    i32[(pP + L.S_ITEM_XY) >> 2] = this.pXY;
    i32[(pP + L.S_ITEM_KIND) >> 2] = this.pKinds;
    i32[(pP + L.S_CROWD_COLS) >> 2] = crowd.cols;
    i32[(pP + L.S_CROWD_ROWS) >> 2] = crowd.rows;
    i32[(pP + L.S_CROWD_START) >> 2] = pCStart;
    i32[(pP + L.S_SX) >> 2] = pSx;
    i32[(pP + L.S_SY) >> 2] = pSy;
    i32[(pP + L.S_OWN) >> 2] = pOwn;
    i32[(pP + L.S_SIG) >> 2] = pSig;
    i32[(pP + L.S_REC) >> 2] = pRec;
    i32[(pP + L.S_N) >> 2] = n;
    i32[(pP + L.S_STRIDE) >> 2] = stride;
    i32[(pP + L.S_CAND) >> 2] = pCand;
    i32[(pP + L.S_SCRATCH) >> 2] = pScr;
    i32[(pP + L.S_SPECIES) >> 2] = pSpecies;
    f64[(pP + L.S_ROCK_MAX_R) >> 3] = rock.maxRockR;
    f64[(pP + L.S_INV_ROCK_CELL) >> 3] = 1 / ROCK_CELL;
    i32[(pP + L.S_ROCK_COLS) >> 2] = rock.rockCount > 0 ? rock.cols : 0;
    i32[(pP + L.S_ROCK_ROWS) >> 2] = rock.rows;
    i32[(pP + L.S_ROCK_START) >> 2] = pRockStart;
    i32[(pP + L.S_ROCK_ORDER) >> 2] = pRockOrder;
    i32[(pP + L.S_ROCK_XYR) >> 2] = pRockXYR;
    i32[(pP + L.S_ROCK_LB) >> 2] = pRockLB;
    this.exports.sense(pP);
  }

  // After run with this creature as detail: writes its rays (closeness, kind, seen energy) into c.rays.
  readRays(c: Creature, crowd: Crowd): void {
    const ptr = this.rDetail.ptr;
    this.views();
    const f64 = this.f64.subarray(ptr >> 3, (ptr >> 3) + 2 * c.rays.length);
    const i32 = this.i32.subarray(ptr >> 2, (ptr >> 2) + 4 * c.rays.length);
    for (let i = 0; i < c.rays.length; i++) {
      const ray = c.rays[i]!;
      ray.closeness = f64[2 * i]!;
      ray.kind = i32[4 * i + 2] as typeof ray.kind;
      if (ray.kind === HIT_CREATURE) {
        ray.energy = crowd.energies[i32[4 * i + 3]!]!;
        ray.species = crowd.species[i32[4 * i + 3]!]!;
      }
    }
  }
}
