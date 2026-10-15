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
import { LAYOUT as L, f64At, i32At } from "./layout.ts";
import { Region, growRegion } from "./resident.ts";

// The whole Ecosystem sense in one WebAssembly call per batch (sense.wat): ray directions, item and wall rays in f64 with the
// JS candidate order, crowd rays in f32 as rays.wat, and the ray features written into the brain's input vector in place.
// Rock (the world's Terrain, static) is copied once per world into three tables the kernel walks like the item grid. Shares the brain bank's linear memory. Per tick the item grid and the crowd are copied in whole, which costs far less
// than the per-creature object traffic it replaces. The creature's RayHit objects are not updated, except for the one
// creature given as detail (the selected one), whose rays are read back for the UI.

export const MAX_RAYS = 64;
const P_BYTES = 192;
const SCRATCH_BYTES = 2816;

interface SenseExports extends WebAssembly.Exports {
  sense(p: number): void;
}

export class WasmSenser {
  private readonly bank: WasmBrainBank;
  private readonly exports: SenseExports;
  private readonly offPtr: number[] = [];
  private readonly offBytes: number[] = [];
  // Named regions of the shared memory, grown on demand (see grow); held in fields so a tick does no lookups.
  private rItems = new Region();
  private rItemXY = new Region();
  private rItemKinds = new Region();
  private rItemIds = new Region();
  private rCStart = new Region();
  private rSx = new Region();
  private rSy = new Region();
  private rOwn = new Region();
  private rSig = new Region();
  private rSpecies = new Region();
  private rRec = new Region();
  private rCand = new Region();
  private rScratch = new Region();
  private rDetail = new Region();
  private rP = new Region();
  private rRockStart = new Region();
  private rRockOrder = new Region();
  private rRockXYR = new Region();
  // Views of the whole linear memory, valid while buffer is the memory's current buffer (growth replaces it).
  private buffer: ArrayBuffer | null = null;
  private f32 = new Float32Array(0);
  private i32 = new Int32Array(0);
  private f64 = new Float64Array(0);
  private u8 = new Uint8Array(0);
  private synced: World | null = null; // the world whose items the packed rows in wasm memory match
  private rockSynced: Terrain | null = null; // the map whose rock tables are in wasm memory
  private rowCap = 0; // item slots per row run
  private pStart = 0;
  private pXY = 0;
  private pKinds = 0;
  private pIds = 0;
  private place = new Int32Array(64);
  private rowCount = new Int32Array(0);

  private constructor(bank: WasmBrainBank, exports: SenseExports) {
    this.bank = bank;
    this.exports = exports;
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
    this.offPtr.length = 0;
    this.offBytes.length = 0;
    this.rItems = new Region();
    this.rItemXY = new Region();
    this.rItemKinds = new Region();
    this.rItemIds = new Region();
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
    this.rockSynced = null;
    this.buffer = null;
    this.synced = null;
    this.rowCap = 0;
    this.pStart = 0;
    this.pXY = 0;
    this.pKinds = 0;
    this.pIds = 0;
  }

  // Stores the creature's ray offset cos and sin tables for its slot; call when the slot's brain is set.
  setOffsets(slot: number, c: Creature): void {
    const n = c.plan.rayCount;
    if (n > MAX_RAYS) throw new Error(`${n} rays exceed ${MAX_RAYS}`);
    const bytes = 16 * n;
    let ptr = this.offPtr[slot];
    if (ptr === undefined || this.offBytes[slot] !== bytes) {
      if (ptr !== undefined) this.bank.free(ptr, this.offBytes[slot]!);
      ptr = this.bank.alloc(bytes);
      this.offPtr[slot] = ptr;
      this.offBytes[slot] = bytes;
    }
    const f64 = new Float64Array(this.bank.memory.buffer, ptr, 2 * n);
    const offsets = c.rayOffsets;
    for (let i = 0; i < n; i++) {
      f64[i] = Math.cos(offsets[i]!);
      f64[n + i] = Math.sin(offsets[i]!);
    }
  }

  // The address of the ray offset tables stored for the slot.
  offsetsAt(slot: number): number {
    return this.offPtr[slot]!;
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
    let full = this.synced !== world || !dirty;
    if (!full && dirty!.length > 0) {
      this.views();
      for (const c of dirty!) full = !this.patchCell(world, c) || full;
    }
    if (full) {
      let widest = 0;
      for (let row = 0; row < rows; row++) {
        let n = 0;
        for (let c = row * cols; c < (row + 1) * cols; c++) for (let i = cellHead[c]!; i >= 0; i = nextItem[i]!) n++;
        widest = Math.max(widest, n);
      }
      this.rowCap = Math.max(64, Math.ceil(widest * 1.5) + 16);
      this.pStart = this.grow(this.rItems, rows * (cols + 1) * 4);
      this.pXY = this.grow(this.rItemXY, rows * this.rowCap * 8);
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

  // Makes cell c's packed run match its list: the rest of the row shifts by the change in length. False when the row outgrows its run.
  private patchCell(world: World, c: number): boolean {
    const { cols, cellHead, nextItem } = world;
    const start = this.i32;
    const xy = this.f32;
    const kd = this.u8;
    const xB = this.pXY >> 2; // element offsets of the packed arrays in the whole-memory views
    const row = Math.floor(c / cols);
    const s = (this.pStart >> 2) + row * (cols + 1) + (c - row * cols);
    const last = (this.pStart >> 2) + row * (cols + 1) + cols;
    let n = 0;
    for (let i = cellHead[c]!; i >= 0; i = nextItem[i]!) n++;
    const at = start[s]!;
    const delta = n - (start[s + 1]! - at);
    if (delta !== 0) {
      const end = start[last]!;
      if (end + delta > (row + 1) * this.rowCap) return false;
      xy.copyWithin(xB + 2 * (at + n), xB + 2 * start[s + 1]!, xB + 2 * end);
      kd.copyWithin(this.pKinds + at + n, this.pKinds + start[s + 1]!, this.pKinds + end);
      start.copyWithin((this.pIds >> 2) + at + n, (this.pIds >> 2) + start[s + 1]!, (this.pIds >> 2) + end);
      for (let j = s + 1; j <= last; j++) start[j] += delta;
    }
    this.writeCell(world, c, at);
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

  // Where each creature's record goes: creatures sorted by item grid row (counting sort, stable), so the kernel walks the rows of the
  // item grid in order and the few rows around the current one stay in cache. Results do not depend on the order.
  private placeByRow(world: World, creatures: readonly Creature[], n: number): Int32Array {
    if (this.place.length < n) this.place = new Int32Array(Math.max(n, 2 * this.place.length));
    const { rows } = world;
    const place = this.place;
    const count = this.rowCount.length >= rows + 1 ? this.rowCount.fill(0) : (this.rowCount = new Int32Array(rows + 1));
    const inv = 1 / world.cell;
    for (let k = 0; k < n; k++) {
      const v = Math.floor(creatures[k]!.state.y * inv);
      const row = v >= 0 ? Math.min(rows - 1, v) : 0; // NaN and negative go to row 0
      place[k] = row;
      count[row + 1]!++;
    }
    for (let r = 0; r < rows; r++) count[r + 1] += count[r]!;
    for (let k = 0; k < n; k++) place[k] = count[place[k]!]!++;
    return place;
  }

  // Senses the batch and writes each creature's complete brain input (rays, extras, memory) at its slot.
  // The batch is creatures with their brain slots, or resident rows (the fill kernel builds the records and the body inputs from them,
  // and writes the brain slot list at slotsAt). selves[k] is the crowd index of batch member k.
  run(world: World, crowd: Crowd, n: number, selves: Int32Array, stride: number, startEnergy: number, detail: Creature | null, batch: { creatures: readonly Creature[]; slots: Int32Array } | { filler: WasmFiller; rows: Int32Array; slotsAt: number }): void {
    this.syncItems(world);
    const count = crowd.count;
    const ccells = crowd.cols * crowd.rows;
    const rock = world.terrain;
    const kernel = crowd.kernel; // the grid is already in this memory: the kernel packs the f32 columns and the rest is read in place
    const grid = kernel?.at;
    const pCStart = grid ? grid.start : this.grow(this.rCStart, (ccells + 1) * 4);
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
    const pScr = this.grow(this.rScratch, SCRATCH_BYTES);
    const pDetail = this.grow(this.rDetail, 16 * MAX_RAYS);
    const pP = this.grow(this.rP, P_BYTES);
    this.views(); // after the last allocation
    let { f32, i32, f64 } = this;
    if (!kernel) i32.set(crowd.cellStart, pCStart >> 2);
    if (this.rockSynced !== rock) {
      i32.set(rock.rockStart, pRockStart >> 2);
      i32.set(rock.rockOrder, pRockOrder >> 2);
      const xyr = pRockXYR >> 3;
      for (let d = 0; d < rock.rockCount; d++) {
        f64[xyr + 3 * d] = rock.rockX[d]!;
        f64[xyr + 3 * d + 1] = rock.rockY[d]!;
        f64[xyr + 3 * d + 2] = rock.rockR[d]!;
      }
      this.rockSynced = rock;
    }
    const sx = pSx >> 2;
    const sy = pSy >> 2;
    const own = pOwn >> 2;
    const sig = pSig >> 2;
    const species = pSpecies >> 2;
    const { xs, ys, owners, energies } = crowd;
    const crowdSpecies = crowd.species;
    if (kernel) kernel.pack(startEnergy, pSx, pSy, pSig);
    else for (let k = 0; k < count; k++) {
      f32[sx + k] = xs[k]!;
      f32[sy + k] = ys[k]!;
      i32[own + k] = owners[k]!;
      i32[species + k] = crowdSpecies[k]!;
      f32[sig + k] = energySignal(energies[k]!, startEnergy);
    }
    if ("filler" in batch) {
      batch.filler.fill(batch.rows, selves, n, world, pRec, batch.slotsAt, pDetail, detail, stride);
      this.views(); // fill may have grown the memory
      ({ f32, i32, f64 } = this);
    } else {
      const { creatures, slots } = batch;
      const rec = pRec >> 3; // record fields as f64 and as i32 indices
      const recI = pRec >> 2;
      const place = this.placeByRow(world, creatures, n);
      for (let k = 0; k < n; k++) {
        const c = creatures[k]!;
        const s = c.state;
        const q = place[k]!;
        const o = rec + q * f64At(L.REC_BYTES);
        const slot = slots[k]!;
        const rays = c.plan.rayCount;
        f64[o + f64At(L.REC_X)] = s.x;
        f64[o + f64At(L.REC_Y)] = s.y;
        f64[o + f64At(L.REC_COS)] = c.heading.cos;
        f64[o + f64At(L.REC_SIN)] = c.heading.sin;
        f64[o + f64At(L.REC_RAY_LENGTH)] = c.plan.rayLength;
        const w = recI + q * i32At(L.REC_BYTES);
        i32[w + i32At(L.REC_SELF)] = selves[k]!;
        i32[w + i32At(L.REC_RAYS)] = rays;
        i32[w + i32At(L.REC_OFFSETS)] = this.offPtr[slot]!;
        const inFloat = this.bank.inputAt(slot);
        i32[w + i32At(L.REC_INPUT)] = inFloat * 4;
        i32[w + i32At(L.REC_DETAIL)] = c === detail ? pDetail : 0;
        c.writeBodyInputs(f32, inFloat + rays * stride);
      }
    }
    const P = pP >> 3;
    const PF = pP >> 2;
    f64[P] = world.width;
    f64[P + 1] = world.height;
    f64[P + 2] = world.itemRadius;
    f64[P + 3] = 1 / world.cell;
    f32[PF + 8] = 1 / crowd.cell;
    f32[PF + 9] = crowd.radius;
    i32[PF + 10] = world.cols;
    i32[PF + 11] = world.rows;
    i32[PF + 12] = this.pStart;
    i32[PF + 14] = this.pXY;
    i32[PF + 16] = this.pKinds;
    i32[PF + 17] = crowd.cols;
    i32[PF + 18] = crowd.rows;
    i32[PF + 19] = pCStart;
    i32[PF + 20] = pSx;
    i32[PF + 21] = pSy;
    i32[PF + 22] = pOwn;
    i32[PF + 23] = pSig;
    i32[PF + 24] = pRec;
    i32[PF + 25] = n;
    i32[PF + 26] = stride;
    i32[PF + 27] = pCand;
    i32[PF + 28] = pScr;
    i32[PF + 29] = pSpecies;
    f64[P + 16] = rock.maxRockR;
    f64[P + 17] = 1 / ROCK_CELL;
    i32[PF + 36] = rock.rockCount > 0 ? rock.cols : 0;
    i32[PF + 37] = rock.rows;
    i32[PF + 38] = pRockStart;
    i32[PF + 39] = pRockOrder;
    i32[PF + 40] = pRockXYR;
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
