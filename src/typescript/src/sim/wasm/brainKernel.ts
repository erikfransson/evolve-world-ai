import { Arena, BRAIN_BYTES, Kernel } from "./loader.ts";
import type { Genome } from "../types.ts";
import { LAYOUT as L, i32At } from "./layout.ts";
import { BlockChunks } from "./blockChunks.ts";

// Batched Brain.forward on f32x4 SIMD, for creatures with brains of any layer sizes (up to 9 layers).
// Each slot holds one creature's weights in linear memory, so set() once when a brain is born or changes and runRegion() with forwardRun() every tick.
// The creature's input vector is written into f32 at inputAt(slot), the output is read from f32 at outputAt(slot).
// Results differ from the JS Brain only by f32 rounding of the sums (see docs/perf-notes.md).

const SCRATCH_FLOATS = 1024; // per ping-pong buffer, so every layer has at most 1024 neurons
const SCRATCH_B = SCRATCH_FLOATS * 4;
const IOTA_AT = 2 * SCRATCH_B; // 0, 1, 2, ... for the dense layers
const NZ_AT = IOTA_AT + SCRATCH_B; // index list of the non-zero inputs of the first layer, room for a 4-wide store past the end
const TAB_AT = NZ_AT + SCRATCH_B + 64; // shuffle and count tables of the index packing, then the tanh constants
const TANH_AT = TAB_AT + L.B_TANH_AT;
const TANH_CONSTS = [135135, 17325, 378, 62370, 3150, 28, -0, 1, 4.97]; // -0 is the sign mask; 9 splat vectors
const ARENA_START = TAB_AT + 512;
if (TANH_AT + 16 * TANH_CONSTS.length > ARENA_START) throw new Error("the tanh constants overlap the arena");
// Descriptor word indices (layout.ts has the byte offsets brain.wat reads).
const DESC_WORDS = i32At(L.B_DESC_BYTES);
const D_BLOCK = i32At(L.B_BLOCK);
const D_INPUT = i32At(L.B_INPUT);
const D_OUTPUT = i32At(L.B_OUTPUT);
const D_COUNT = i32At(L.B_COUNT);
const D_RAY_INPUTS = i32At(L.B_RAY_INPUTS);
const D_RAY_ROWS = i32At(L.B_RAY_ROWS);
const DESC_SIZES = i32At(L.B_SIZES); // descriptor words before the layer sizes
const MAX_SIZES = DESC_WORDS - DESC_SIZES;
const NO_SLOT = -1;

interface BrainExports extends WebAssembly.Exports {
  forward(desc: number, slots: number, n: number, scratchA: number, scratchB: number, nz: number, iota: number, tab: number): void;
  runOrder(run: number, n: number, order: number, held: number, mark: number, cap: number, stamp: number): number;
}

const pad4 = (n: number): number => (n + 3) & ~3;

export class WasmBrainBank {
  private readonly kernel: Kernel<BrainExports>;
  private arena!: Arena;
  private blocks!: BlockChunks; // where each slot's block sits, and the slots by block address
  private rayPtr!: (number | undefined)[]; // per slot, the first-layer rows of the ray inputs, outside the block (they are mostly dead, so the block stays small and dense)
  private rayBytes!: number[];
  onMove: ((slot: number) => void) | null = null; // called for each slot whose block moved (compact(), or a chunk slid by place() inside another slot's set()), after its input and output addresses changed
  private inFloat!: number[];
  private outFloat!: number[];
  private descPtr!: number;
  private descCap!: number;
  private runPtr!: number; // slot numbers of one forwardRun
  private runCap!: number;
  private orderPtr!: number; // a copy of blocks.order in kernel memory for runOrder, rewritten by forwardRun after the order changed
  private orderCap!: number;
  private markPtr!: number; // per slot (descCap bytes), the stamp (1 to 255) of the forwardRun it is in
  private stamp!: number;

  private constructor(kernel: Kernel<BrainExports>) {
    this.kernel = kernel;
    this.init();
    kernel.ensure(ARENA_START);
    const i32 = kernel.i32;
    for (let i = 0; i < SCRATCH_FLOATS; i++) i32[IOTA_AT / 4 + i] = i;
    // For each lane mask m, the byte shuffle that moves the index of its k-th set lane to lane k, and the number of set lanes.
    const bytes = new Uint8Array(kernel.memory.buffer, TAB_AT, L.B_TANH_AT);
    for (let m = 0; m < 16; m++) {
      let k = 0;
      for (let lane = 0; lane < 4; lane++) {
        if (!(m & (1 << lane))) continue;
        for (let b = 0; b < 4; b++) bytes[m * 16 + k * 4 + b] = lane * 4 + b;
        k++;
      }
      bytes[256 + m] = k;
    }
    const tanh = new Float32Array(kernel.memory.buffer, TANH_AT, 4 * TANH_CONSTS.length);
    TANH_CONSTS.forEach((v, i) => tanh.fill(v, 4 * i, 4 * i + 4));
  }

  // The state of a new bank, for the constructor and reset(); every field that reset() must clear is set here.
  private init(): void {
    this.rayPtr = [];
    this.rayBytes = [];
    this.inFloat = [];
    this.outFloat = [];
    this.descPtr = NO_SLOT;
    this.descCap = 0;
    this.runPtr = NO_SLOT;
    this.runCap = 0;
    this.orderPtr = NO_SLOT;
    this.orderCap = 0;
    this.markPtr = NO_SLOT;
    this.stamp = 0;
    this.arena = new Arena(this.kernel, ARENA_START);
    this.blocks = new BlockChunks(this.arena, {
      relocate: (slot, from, to, bytes) => this.relocate(slot, from, to, bytes),
      moved: (slots) => { if (this.onMove) for (const slot of slots) this.onMove(slot); },
    });
  }

  // Null when WebAssembly SIMD is unavailable (or disabled); keep using the JS Brain then.
  static createSync(): WasmBrainBank | null {
    const kernel = Kernel.createSync<BrainExports>(BRAIN_BYTES);
    return kernel ? new WasmBrainBank(kernel) : null;
  }

  // Back to the state of a new bank, so a successive owner can reuse the instance: no slots, a fresh arena, zeroed scratch and arena memory.
  reset(): void {
    this.init();
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
  // The first rayInputs inputs (the rays) have their first-layer rows in a region of their own; the kernel adds their entries first, so the results do not depend on it.
  set(slot: number, sizes: readonly number[], genome: Genome, rayInputs = 0): void {
    if (sizes[0]! > SCRATCH_FLOATS) throw new Error(`input of ${sizes[0]} values exceeds ${SCRATCH_FLOATS}`);
    if (sizes.length < 2 || sizes.length > MAX_SIZES) throw new Error(`brain needs 2 to ${MAX_SIZES} layer sizes, got ${sizes.length}`);
    if (rayInputs < 0 || rayInputs > sizes[0]!) throw new Error(`${rayInputs} ray inputs of ${sizes[0]}`);
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
    const nPad0 = pad4(sizes[1]!);
    const rayBytes = rayInputs * nPad0 * 4;
    const bytes = (weightFloats - rayInputs * nPad0 + pad4(nIn) + pad4(nOut)) * 4;
    this.ensureSlots(slot + 1);
    const ptr = this.blocks.set(slot, bytes);
    let rayAt = this.rayPtr[slot];
    if (rayAt !== undefined && Arena.round(this.rayBytes[slot]!) !== Arena.round(rayBytes)) {
      this.arena.release(rayAt, this.rayBytes[slot]!);
      rayAt = undefined;
    }
    if (rayAt === undefined && rayBytes > 0) rayAt = this.arena.alloc(rayBytes);
    this.rayPtr[slot] = rayAt;
    this.rayBytes[slot] = rayBytes;
    const f32 = this.kernel.f32;
    const base = ptr >> 2;
    f32.fill(0, base, base + bytes / 4);
    let w = base;
    let g = 0;
    for (let l = 0; l + 1 < sizes.length; l++) {
      const inN = sizes[l]!;
      const outN = sizes[l + 1]!;
      const nPad = pad4(outN);
      const split = l === 0 ? rayInputs : 0;
      if (split > 0) {
        const rb = rayAt! >> 2;
        f32.fill(0, rb, rb + split * nPad);
        for (let j = 0; j < outN; j++) {
          const from = g + j * inN;
          for (let i = 0, to = rb + j; i < split; i++, to += nPad) f32[to] = genome[from + i]!;
        }
      }
      for (let j = 0; j < outN; j++) {
        const from = g + j * inN;
        for (let i = split, to = w + j; i < inN; i++, to += nPad) f32[to] = genome[from + i]!;
      }
      g += inN * outN;
      w += (inN - split) * nPad;
      for (let j = 0; j < outN; j++) f32[w + j] = genome[g + j]!;
      g += outN;
      w += nPad;
    }
    this.inFloat[slot] = w;
    this.outFloat[slot] = w + pad4(nIn);
    const d = this.kernel.i32;
    const at = (this.descPtr >> 2) + slot * DESC_WORDS;
    d[at + D_BLOCK] = ptr;
    d[at + D_INPUT] = w * 4;
    d[at + D_OUTPUT] = (w + pad4(nIn)) * 4;
    d[at + D_COUNT] = sizes.length;
    d[at + D_RAY_INPUTS] = rayInputs;
    d[at + D_RAY_ROWS] = rayAt ?? 0;
    for (let i = 0; i < sizes.length; i++) d[at + DESC_SIZES + i] = sizes[i]!;
  }

  // Writes the slot's genome (the Brain layout) into out, undoing set(): bit-exact, as the block holds the same f32 values transposed and padded.
  readGenome(slot: number, out: Genome): void {
    const f32 = this.kernel.f32;
    const d = this.kernel.i32;
    const at = (this.descPtr >> 2) + slot * DESC_WORDS;
    const count = d[at + D_COUNT]!;
    const rayInputs = d[at + D_RAY_INPUTS]!;
    const rb = d[at + D_RAY_ROWS]! >> 2;
    let w = d[at + D_BLOCK]! >> 2;
    let g = 0;
    for (let l = 0; l + 1 < count; l++) {
      const inN = d[at + DESC_SIZES + l]!;
      const outN = d[at + DESC_SIZES + l + 1]!;
      const nPad = pad4(outN);
      const split = l === 0 ? rayInputs : 0;
      for (let j = 0; j < outN; j++) {
        const from = g + j * inN;
        for (let i = 0, p = rb + j; i < split; i++, p += nPad) out[from + i] = f32[p]!;
        for (let i = split, p = w + j; i < inN; i++, p += nPad) out[from + i] = f32[p]!;
      }
      g += inN * outN;
      w += (inN - split) * nPad;
      for (let j = 0; j < outN; j++) out[g + j] = f32[w + j]!;
      g += outN;
      w += nPad;
    }
  }

  // Frees the slot's brain block (a creature that left for good), so the slot holds no brain until set again.
  release(slot: number): void {
    if (this.blocks.ptr(slot) === undefined) return;
    this.blocks.release(slot);
    if (this.rayPtr[slot] !== undefined) this.arena.release(this.rayPtr[slot]!, this.rayBytes[slot]!);
    this.rayPtr[slot] = undefined;
  }

  // Slides the live blocks of the chunk with the most hole down over its holes, so the run-order stream of weights has no gaps; onMove tells the owner of each moved slot.
  compact(): void {
    this.blocks.compact();
  }

  // A block slid from `from` to `to`: copies it whole and moves the slot's descriptor and input and output addresses along.
  private relocate(slot: number, from: number, to: number, bytes: number): void {
    this.kernel.f32.copyWithin(to >> 2, from >> 2, (from + bytes) >> 2);
    const shift = to - from;
    const d = this.kernel.i32;
    const w = (this.descPtr >> 2) + slot * DESC_WORDS;
    d[w + D_BLOCK] = to;
    d[w + D_INPUT] += shift;
    d[w + D_OUTPUT] += shift;
    this.inFloat[slot] += shift >> 2;
    this.outFloat[slot] += shift >> 2;
  }

  // Runs the slots slots[0 .. count-1] in that order, each of which must hold a brain; e.g. one thread's share of the creatures.
  forwardSlots(slots: Int32Array, count: number): void {
    if (count <= 0) return;
    const run = this.runRegion(count);
    for (let k = 0; k < count; k++) if (this.blocks.ptr(slots[k]!) === undefined) throw new Error(`slot ${slots[k]} holds no brain`);
    this.kernel.i32.set(slots.subarray(0, count), run >> 2);
    this.kernel.exports.forward(this.descPtr, run, count, 0, SCRATCH_B, NZ_AT, IOTA_AT, TAB_AT);
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
    if (this.blocks.orderDirty) this.copyOrder();
    if (this.stamp >= 255) { // the marks are bytes: clear them and start the stamps over
      new Uint8Array(this.kernel.memory.buffer, this.markPtr, this.descCap).fill(0);
      this.stamp = 0;
    }
    const placed = this.kernel.exports.runOrder(this.runPtr, count, this.orderPtr, this.blocks.held, this.markPtr, this.descCap, ++this.stamp);
    if (placed !== count) throw new Error("brain run list holds a slot without a brain, or one twice");
    this.kernel.exports.forward(this.descPtr, this.runPtr, count, 0, SCRATCH_B, NZ_AT, IOTA_AT, TAB_AT);
  }

  // Writes the order of the blocks into kernel memory.
  private copyOrder(): void {
    const { order, held } = this.blocks;
    if (held > 0) { // with nothing to mirror the kernel places no slot, and forwardRun throws its usual error
      if (held > this.orderCap) {
        if (this.orderPtr !== NO_SLOT) this.arena.release(this.orderPtr, this.orderCap * 4);
        this.orderCap = order.length;
        this.orderPtr = this.arena.alloc(this.orderCap * 4);
      }
      this.kernel.i32.set(order.subarray(0, held), this.orderPtr >> 2);
    }
    this.blocks.orderDirty = false;
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
    if (this.markPtr !== NO_SLOT) this.arena.release(this.markPtr, this.descCap);
    this.descPtr = ptr;
    this.descCap = cap;
    this.markPtr = this.arena.alloc(cap);
    new Uint8Array(this.kernel.memory.buffer, this.markPtr, cap).fill(0);
  }
}
