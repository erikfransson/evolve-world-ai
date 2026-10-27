import { Arena, BRAIN_BYTES, Kernel } from "./loader.ts";
import type { Genome } from "../types.ts";

// Batched Brain.forward on f32x4 SIMD, for creatures with brains of any layer sizes (up to 11 layers).
// Each slot holds one creature's weights in linear memory, so set() once when a brain is born or changes and forwardSlots() every tick.
// The creature's input vector is written into f32 at inputAt(slot), the output is read from f32 at outputAt(slot).
// Results differ from the JS Brain only by f32 rounding of the sums (see docs/perf-notes.md).

const SCRATCH_FLOATS = 1024; // per ping-pong buffer, so every layer has at most 1024 neurons
const SCRATCH_B = SCRATCH_FLOATS * 4;
const IOTA_AT = 2 * SCRATCH_B; // 0, 1, 2, ... for the dense layers
const NZ_AT = IOTA_AT + SCRATCH_B; // index list of the non-zero inputs of the first layer, room for a 4-wide store past the end
const TAB_AT = NZ_AT + SCRATCH_B + 64; // shuffle and count tables of the index packing
const ARENA_START = TAB_AT + 512;
const DESC_WORDS = 16;
const MAX_SIZES = DESC_WORDS - 4;
const NO_SLOT = -1;

interface BrainExports extends WebAssembly.Exports {
  forward(desc: number, slots: number, n: number, scratchA: number, scratchB: number, nz: number, iota: number, tab: number): void;
}

const pad4 = (n: number): number => (n + 3) & ~3;

export class WasmBrainBank {
  private readonly kernel: Kernel<BrainExports>;
  private arena: Arena;
  private blockPtr: number[] = [];
  private blockBytes: number[] = [];
  private inFloat: number[] = [];
  private outFloat: number[] = [];
  private descPtr = NO_SLOT;
  private descCap = 0;
  private runPtr = NO_SLOT; // slot numbers of one forwardSlots call
  private runCap = 0;
  private order = new Int32Array(64); // the slots holding a brain, by block address, so forwardRun streams the weights in memory order
  private held = 0;
  private mark = new Int32Array(64); // per slot, the stamp of the forwardRun it is in
  private stamp = 0;

  private constructor(kernel: Kernel<BrainExports>) {
    this.kernel = kernel;
    this.arena = new Arena(kernel, ARENA_START);
    kernel.ensure(ARENA_START);
    const i32 = kernel.i32;
    for (let i = 0; i < SCRATCH_FLOATS; i++) i32[IOTA_AT / 4 + i] = i;
    // For each lane mask m, the byte shuffle that moves the index of its k-th set lane to lane k, and the number of set lanes.
    const bytes = new Uint8Array(kernel.memory.buffer, TAB_AT, 272);
    for (let m = 0; m < 16; m++) {
      let k = 0;
      for (let lane = 0; lane < 4; lane++) {
        if (!(m & (1 << lane))) continue;
        for (let b = 0; b < 4; b++) bytes[m * 16 + k * 4 + b] = lane * 4 + b;
        k++;
      }
      bytes[256 + m] = k;
    }
  }

  // Null when WebAssembly SIMD is unavailable (or disabled); keep using the JS Brain then.
  static createSync(): WasmBrainBank | null {
    const kernel = Kernel.createSync<BrainExports>(BRAIN_BYTES);
    return kernel ? new WasmBrainBank(kernel) : null;
  }

  // Back to the state of a new bank, so a successive owner can reuse the instance: no slots, a fresh arena, zeroed scratch and arena memory.
  reset(): void {
    this.blockPtr = [];
    this.blockBytes = [];
    this.inFloat = [];
    this.outFloat = [];
    this.descPtr = NO_SLOT;
    this.descCap = 0;
    this.runPtr = NO_SLOT;
    this.runCap = 0;
    this.held = 0;
    this.mark.fill(0);
    this.stamp = 0;
    this.arena = new Arena(this.kernel, ARENA_START);
    const f32 = this.kernel.f32;
    f32.fill(0, 0, IOTA_AT / 4);
    f32.fill(0, NZ_AT / 4, TAB_AT / 4);
    f32.fill(0, ARENA_START / 4);
  }

  // The whole linear memory as floats; indices from inputAt and outputAt. Read it fresh after set(), as growth replaces it.
  get f32(): Float32Array {
    return this.kernel.f32;
  }

  get memory(): WebAssembly.Memory {
    return this.kernel.memory;
  }

  // Sets the function called whenever the memory grows, after which views of it must be taken again (one listener: the resident store).
  onGrow(listener: (() => void) | null): void {
    this.kernel.onGrow = listener;
  }

  // Raw bytes in the bank's memory for a caller that shares it (the senser); 16-byte aligned, kept until freed.
  alloc(bytes: number): number {
    return this.arena.alloc(bytes);
  }

  free(ptr: number, bytes: number): void {
    this.arena.release(ptr, bytes);
  }

  inputAt(slot: number): number {
    return this.inFloat[slot]!;
  }

  outputAt(slot: number): number {
    return this.outFloat[slot]!;
  }

  // Stores a brain in a slot (any non-negative index; forwardSlots runs the slots it is given), replacing what it held.
  // genome is in the Brain layout: per layer weights [out][in] then biases.
  set(slot: number, sizes: readonly number[], genome: Genome): void {
    if (sizes[0]! > SCRATCH_FLOATS) throw new Error(`input of ${sizes[0]} values exceeds ${SCRATCH_FLOATS}`);
    if (sizes.length < 2 || sizes.length > MAX_SIZES) throw new Error(`brain needs 2 to ${MAX_SIZES} layer sizes, got ${sizes.length}`);
    let weightFloats = 0;
    let genes = 0;
    for (let l = 0; l + 1 < sizes.length; l++) {
      if (pad4(sizes[l + 1]!) > SCRATCH_FLOATS) throw new Error(`layer of ${sizes[l + 1]} neurons exceeds ${SCRATCH_FLOATS}`);
      weightFloats += (sizes[l]! + 1) * pad4(sizes[l + 1]!);
      genes += sizes[l]! * sizes[l + 1]! + sizes[l + 1]!;
    }
    if (genome.length !== genes) throw new Error(`genome length ${genome.length} does not match expected ${genes}`);
    const nIn = sizes[0]!;
    const nOut = sizes[sizes.length - 1]!;
    const bytes = (weightFloats + pad4(nIn) + pad4(nOut)) * 4;
    this.ensureSlots(slot + 1);
    let ptr = this.blockPtr[slot]!;
    if (ptr === undefined || Arena.round(this.blockBytes[slot]!) !== Arena.round(bytes)) {
      if (ptr !== undefined) {
        this.arena.release(ptr, this.blockBytes[slot]!);
        this.unorder(ptr);
      }
      ptr = this.arena.alloc(bytes);
      this.blockPtr[slot] = ptr;
      this.reorder(slot, ptr);
    }
    this.blockBytes[slot] = bytes;
    const f32 = this.kernel.f32;
    const base = ptr >> 2;
    f32.fill(0, base, base + bytes / 4);
    let w = base;
    let g = 0;
    for (let l = 0; l + 1 < sizes.length; l++) {
      const inN = sizes[l]!;
      const outN = sizes[l + 1]!;
      const nPad = pad4(outN);
      for (let j = 0; j < outN; j++) {
        for (let i = 0; i < inN; i++) f32[w + i * nPad + j] = genome[g + j * inN + i]!;
      }
      g += inN * outN;
      w += inN * nPad;
      for (let j = 0; j < outN; j++) f32[w + j] = genome[g + j]!;
      g += outN;
      w += nPad;
    }
    this.inFloat[slot] = w;
    this.outFloat[slot] = w + pad4(nIn);
    const d = this.kernel.i32;
    const at = (this.descPtr >> 2) + slot * DESC_WORDS;
    d[at] = ptr;
    d[at + 1] = w * 4;
    d[at + 2] = (w + pad4(nIn)) * 4;
    d[at + 3] = sizes.length;
    for (let i = 0; i < sizes.length; i++) d[at + 4 + i] = sizes[i]!;
  }

  // Runs the slots slots[0 .. count-1] in that order, each of which must hold a brain; e.g. one thread's share of the creatures.
  forwardSlots(slots: Int32Array, count: number): void {
    if (count <= 0) return;
    if (count > this.runCap) {
      if (this.runPtr !== NO_SLOT) this.arena.release(this.runPtr, this.runCap * 4);
      this.runCap = Math.max(64, 2 * this.runCap, count);
      this.runPtr = this.arena.alloc(this.runCap * 4);
    }
    for (let k = 0; k < count; k++) if (this.blockPtr[slots[k]!] === undefined) throw new Error(`slot ${slots[k]} holds no brain`);
    this.kernel.i32.set(slots.subarray(0, count), this.runPtr >> 2);
    this.kernel.exports.forward(this.descPtr, this.runPtr, count, 0, SCRATCH_B, NZ_AT, IOTA_AT, TAB_AT);
  }

  // The address of the slot list of the next forwardRun (room for count slots), for a kernel to fill in place.
  runRegion(count: number): number {
    if (count > this.runCap) {
      if (this.runPtr !== NO_SLOT) this.arena.release(this.runPtr, this.runCap * 4);
      this.runCap = Math.max(64, 2 * this.runCap, count);
      this.runPtr = this.arena.alloc(this.runCap * 4);
    }
    return this.runPtr;
  }

  // forwardSlots for the slots a kernel wrote at runRegion (every one holds a brain: they come from creatures attached to this bank).
  // The slots are run by block address instead of in the written order; each brain depends only on its own block, so the results are the same.
  forwardRun(count: number): void {
    if (count <= 0) return;
    const i32 = this.kernel.i32;
    const at = this.runPtr >> 2;
    const mark = this.mark;
    const stamp = ++this.stamp;
    for (let k = 0; k < count; k++) mark[i32[at + k]!] = stamp;
    for (let k = 0, j = at; j < at + count; k++) {
      const s = this.order[k]!;
      if (mark[s] === stamp) i32[j++] = s;
    }
    this.kernel.exports.forward(this.descPtr, this.runPtr, count, 0, SCRATCH_B, NZ_AT, IOTA_AT, TAB_AT);
  }

  private unorder(ptr: number): void {
    const k = this.find(ptr);
    this.order.copyWithin(k, k + 1, this.held--);
  }

  private reorder(slot: number, ptr: number): void {
    if (this.held === this.order.length) {
      const grown = new Int32Array(2 * this.held);
      grown.set(this.order);
      this.order = grown;
    }
    const k = this.find(ptr);
    this.order.copyWithin(k + 1, k, this.held++);
    this.order[k] = slot;
  }

  // The first place in order whose block is at ptr or above.
  private find(ptr: number): number {
    let lo = 0;
    let hi = this.held;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.blockPtr[this.order[mid]!]! < ptr) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private ensureSlots(n: number): void {
    if (n <= this.descCap) return;
    const cap = Math.max(64, 2 * this.descCap, n);
    const ptr = this.arena.alloc(cap * DESC_WORDS * 4);
    const i32 = this.kernel.i32;
    i32.fill(0, ptr >> 2, (ptr >> 2) + cap * DESC_WORDS);
    if (this.descPtr !== NO_SLOT) {
      const from = this.descPtr >> 2;
      i32.copyWithin(ptr >> 2, from, from + this.descCap * DESC_WORDS);
      this.arena.release(this.descPtr, this.descCap * DESC_WORDS * 4);
    }
    this.descPtr = ptr;
    this.descCap = cap;
    if (cap > this.mark.length) {
      const grown = new Int32Array(cap);
      grown.set(this.mark);
      this.mark = grown;
    }
  }
}
