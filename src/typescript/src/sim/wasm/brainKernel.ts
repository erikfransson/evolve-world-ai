import { Arena, BRAIN_BYTES, Kernel } from "./loader.ts";
import type { Genome } from "../types.ts";

// Batched Brain.forward on f32x4 SIMD, for creatures with brains of any layer sizes (up to 11 layers).
// Each slot holds one creature's weights in linear memory, so set() once when a brain is born or changes and forwardSlots() every tick.
// The creature's input vector is written into f32 at inputAt(slot), the output is read from f32 at outputAt(slot).
// Results differ from the JS Brain only by f32 rounding of the sums (see docs/perf-notes.md).

const SCRATCH_FLOATS = 1024; // per ping-pong buffer, so every layer has at most 1024 neurons
const SCRATCH_B = SCRATCH_FLOATS * 4;
const ARENA_START = 2 * SCRATCH_B;
const DESC_WORDS = 16;
const MAX_SIZES = DESC_WORDS - 4;
const NO_SLOT = -1;

interface BrainExports extends WebAssembly.Exports {
  forward(desc: number, n: number, scratchA: number, scratchB: number): void;
}

const pad8 = (n: number): number => (n + 7) & ~7;
const pad4 = (n: number): number => (n + 3) & ~3;

export class WasmBrainBank {
  private readonly kernel: Kernel<BrainExports>;
  private readonly arena: Arena;
  private blockPtr: number[] = [];
  private blockBytes: number[] = [];
  private inFloat: number[] = [];
  private outFloat: number[] = [];
  private descPtr = NO_SLOT;
  private descCap = 0;
  private runPtr = NO_SLOT; // descriptors of one forwardSlots call
  private runCap = 0;

  private constructor(kernel: Kernel<BrainExports>) {
    this.kernel = kernel;
    this.arena = new Arena(kernel, ARENA_START);
    kernel.ensure(ARENA_START);
  }

  // Null when WebAssembly SIMD is unavailable (or disabled); keep using the JS Brain then.
  static createSync(): WasmBrainBank | null {
    const kernel = Kernel.createSync<BrainExports>(BRAIN_BYTES);
    return kernel ? new WasmBrainBank(kernel) : null;
  }

  // The whole linear memory as floats; indices from inputAt and outputAt. Read it fresh after set(), as growth replaces it.
  get f32(): Float32Array {
    return this.kernel.f32;
  }

  get memory(): WebAssembly.Memory {
    return this.kernel.memory;
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
    if (sizes.length < 2 || sizes.length > MAX_SIZES) throw new Error(`brain needs 2 to ${MAX_SIZES} layer sizes, got ${sizes.length}`);
    let weightFloats = 0;
    let genes = 0;
    for (let l = 0; l + 1 < sizes.length; l++) {
      if (pad8(sizes[l + 1]!) > SCRATCH_FLOATS) throw new Error(`layer of ${sizes[l + 1]} neurons exceeds ${SCRATCH_FLOATS}`);
      weightFloats += (sizes[l]! + 1) * pad8(sizes[l + 1]!);
      genes += sizes[l]! * sizes[l + 1]! + sizes[l + 1]!;
    }
    if (genome.length !== genes) throw new Error(`genome length ${genome.length} does not match expected ${genes}`);
    const nIn = sizes[0]!;
    const nOut = sizes[sizes.length - 1]!;
    const bytes = (weightFloats + pad4(nIn) + pad4(nOut)) * 4;
    this.ensureSlots(slot + 1);
    let ptr = this.blockPtr[slot]!;
    if (ptr === undefined || Arena.round(this.blockBytes[slot]!) !== Arena.round(bytes)) {
      if (ptr !== undefined) this.arena.release(ptr, this.blockBytes[slot]!);
      ptr = this.arena.alloc(bytes);
    }
    this.blockPtr[slot] = ptr;
    this.blockBytes[slot] = bytes;
    const f32 = this.kernel.f32;
    const base = ptr >> 2;
    f32.fill(0, base, base + bytes / 4);
    let w = base;
    let g = 0;
    for (let l = 0; l + 1 < sizes.length; l++) {
      const inN = sizes[l]!;
      const outN = sizes[l + 1]!;
      const nPad = pad8(outN);
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
      if (this.runPtr !== NO_SLOT) this.arena.release(this.runPtr, this.runCap * DESC_WORDS * 4);
      this.runCap = Math.max(64, 2 * this.runCap, count);
      this.runPtr = this.arena.alloc(this.runCap * DESC_WORDS * 4);
    }
    const i32 = this.kernel.i32;
    const desc = this.descPtr >> 2;
    let to = this.runPtr >> 2;
    for (let k = 0; k < count; k++, to += DESC_WORDS) {
      const slot = slots[k]!;
      if (this.blockPtr[slot] === undefined) throw new Error(`slot ${slot} holds no brain`);
      i32.copyWithin(to, desc + slot * DESC_WORDS, desc + (slot + 1) * DESC_WORDS);
    }
    this.kernel.exports.forward(this.runPtr, count, 0, SCRATCH_B);
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
  }
}
