import { Arena, BRAIN_BYTES, Kernel } from "./loader.ts";
import type { Genome } from "../types.ts";

// Batched Brain.forward on f32x4 SIMD, for creatures with brains of any layer sizes (up to 9 layers).
// Each slot holds one creature's weights in linear memory, so set() once when a brain is born or changes and runRegion() with forwardRun() every tick.
// The creature's input vector is written into f32 at inputAt(slot), the output is read from f32 at outputAt(slot).
// Results differ from the JS Brain only by f32 rounding of the sums (see docs/perf-notes.md).

const SCRATCH_FLOATS = 1024; // per ping-pong buffer, so every layer has at most 1024 neurons
const SCRATCH_B = SCRATCH_FLOATS * 4;
const IOTA_AT = 2 * SCRATCH_B; // 0, 1, 2, ... for the dense layers
const NZ_AT = IOTA_AT + SCRATCH_B; // index list of the non-zero inputs of the first layer, room for a 4-wide store past the end
const TAB_AT = NZ_AT + SCRATCH_B + 64; // shuffle and count tables of the index packing
const ARENA_START = TAB_AT + 512;
const DESC_WORDS = 16;
const DESC_SIZES = 6; // descriptor words before the layer sizes: block, input, output, size count, ray inputs, ray rows
const MAX_SIZES = DESC_WORDS - DESC_SIZES;
const NO_SLOT = -1;
const BLOCK_ALIGN = 64; // brain blocks are laid back to back in chunks, each starting on a cache line
const CHUNK_BYTES = 1 << 20;
const HOLE_SHARE = 16; // a chunk is compacted when 1/HOLE_SHARE of its used bytes is hole

interface BrainExports extends WebAssembly.Exports {
  forward(desc: number, slots: number, n: number, scratchA: number, scratchB: number, nz: number, iota: number, tab: number): void;
}

const pad4 = (n: number): number => (n + 3) & ~3;
const alignUp = (n: number): number => (n + BLOCK_ALIGN - 1) & ~(BLOCK_ALIGN - 1);

// A run of arena memory the brain blocks are bump-allocated in: top bytes used, live of them held by blocks, the rest holes.
interface Chunk { ptr: number; cap: number; top: number; live: number }

export class WasmBrainBank {
  private readonly kernel: Kernel<BrainExports>;
  private arena: Arena;
  private blockPtr: (number | undefined)[] = [];
  private blockBytes: number[] = [];
  private blockChunk: number[] = [];
  private rayPtr: (number | undefined)[] = []; // per slot, the first-layer rows of the ray inputs, outside the block (they are mostly dead, so the block stays small and dense)
  private rayBytes: number[] = [];
  private chunks: Chunk[] = [];
  onMove: ((slot: number) => void) | null = null; // called for each slot whose block moved (compact(), or a chunk slid by place() inside another slot's set()), after its input and output addresses changed
  private inFloat: number[] = [];
  private outFloat: number[] = [];
  private descPtr = NO_SLOT;
  private descCap = 0;
  private runPtr = NO_SLOT; // slot numbers of one forwardRun
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
    this.blockChunk = [];
    this.rayPtr = [];
    this.rayBytes = [];
    this.chunks = [];
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
    let ptr = this.blockPtr[slot]!;
    if (ptr === undefined || alignUp(this.blockBytes[slot]!) !== alignUp(bytes)) {
      if (ptr !== undefined) this.freeBlock(slot);
      ptr = this.place(slot, alignUp(bytes));
      this.blockPtr[slot] = ptr;
      this.reorder(slot, ptr);
    }
    this.blockBytes[slot] = bytes;
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
    d[at] = ptr;
    d[at + 1] = w * 4;
    d[at + 2] = (w + pad4(nIn)) * 4;
    d[at + 3] = sizes.length;
    d[at + 4] = rayInputs;
    d[at + 5] = rayAt ?? 0;
    for (let i = 0; i < sizes.length; i++) d[at + DESC_SIZES + i] = sizes[i]!;
  }

  // Frees the slot's brain block (a creature that left for good), so the slot holds no brain until set again.
  release(slot: number): void {
    const ptr = this.blockPtr[slot];
    if (ptr === undefined) return;
    this.freeBlock(slot);
    this.blockPtr[slot] = undefined;
    this.blockBytes[slot] = 0;
    if (this.rayPtr[slot] !== undefined) this.arena.release(this.rayPtr[slot]!, this.rayBytes[slot]!);
    this.rayPtr[slot] = undefined;
  }

  // Slides the live blocks of the chunk with the most hole down over its holes (when the hole is over 1/HOLE_SHARE of its used bytes), so the
  // run-order stream of weights has no gaps. Block contents are copied whole, so results are unchanged; onMove tells the owner of each moved slot.
  compact(): void {
    let worst = -1;
    let most = 0;
    for (let c = 0; c < this.chunks.length; c++) {
      const hole = this.chunks[c]!.top - this.chunks[c]!.live;
      if (hole > most && hole * HOLE_SHARE > this.chunks[c]!.top) { most = hole; worst = c; }
    }
    if (worst >= 0) this.slideChunk(worst);
  }

  private slideChunk(c: number): void {
    const ch = this.chunks[c]!;
    const f32 = this.kernel.f32;
    const d = this.kernel.i32;
    const moved: number[] = [];
    let at = ch.ptr;
    for (let k = this.find(ch.ptr); k < this.held && this.blockChunk[this.order[k]!] === c; k++) {
      const slot = this.order[k]!;
      const ptr = this.blockPtr[slot]!;
      const bytes = this.blockBytes[slot]!;
      if (ptr !== at) {
        f32.copyWithin(at >> 2, ptr >> 2, (ptr + bytes) >> 2);
        const shift = at - ptr;
        const w = (this.descPtr >> 2) + slot * DESC_WORDS;
        d[w] = at;
        d[w + 1] += shift;
        d[w + 2] += shift;
        this.blockPtr[slot] = at;
        this.inFloat[slot] += shift >> 2;
        this.outFloat[slot] += shift >> 2;
        moved.push(slot);
      }
      at += alignUp(bytes);
    }
    ch.top = at - ch.ptr;
    if (this.onMove) for (const slot of moved) this.onMove(slot);
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
    if (this.stamp === 0x7fffffff) { // mark is i32: start the stamps over before they wrap
      mark.fill(0);
      this.stamp = 0;
    }
    const stamp = ++this.stamp;
    for (let k = 0; k < count; k++) mark[i32[at + k]!] = stamp;
    const end = at + count;
    let j = at;
    for (let k = 0, held = this.held; k < held && j < end; k++) {
      const s = this.order[k]!;
      if (mark[s] === stamp) i32[j++] = s;
    }
    if (j !== end) throw new Error("brain run list holds a slot without a brain, or one twice");
    this.kernel.exports.forward(this.descPtr, this.runPtr, count, 0, SCRATCH_B, NZ_AT, IOTA_AT, TAB_AT);
  }

  // A block of size bytes (a multiple of BLOCK_ALIGN) at the end of the first chunk with room, else of a new chunk.
  private place(slot: number, size: number): number {
    let c = 0;
    while (c < this.chunks.length && this.chunks[c]!.top + size > this.chunks[c]!.cap) c++;
    if (c === this.chunks.length) { // no room at any end: slide the chunk with the most hole if that makes room, else a new chunk
      let roomy = -1;
      for (let i = 0; i < c; i++) if (this.chunks[i]!.cap - this.chunks[i]!.live >= size && (roomy < 0 || this.chunks[i]!.live < this.chunks[roomy]!.live)) roomy = i;
      if (roomy >= 0) { this.slideChunk(roomy); c = roomy; }
    }
    if (c === this.chunks.length) {
      const cap = Math.max(CHUNK_BYTES, size);
      this.chunks.push({ ptr: this.arena.alloc(cap), cap, top: 0, live: 0 });
    }
    const ch = this.chunks[c]!;
    const ptr = ch.ptr + ch.top;
    ch.top += size;
    ch.live += size;
    this.blockChunk[slot] = c;
    return ptr;
  }

  // Gives the slot's block back to its chunk: the hole stays until compact() unless the block is the last one, then the chunk's end moves back.
  private freeBlock(slot: number): void {
    const ptr = this.blockPtr[slot]!;
    const size = alignUp(this.blockBytes[slot]!);
    const ch = this.chunks[this.blockChunk[slot]!]!;
    ch.live -= size;
    const k = this.find(ptr);
    if (ptr + size === ch.ptr + ch.top) {
      const prev = k > 0 ? this.order[k - 1]! : -1;
      ch.top = prev >= 0 && this.blockChunk[prev] === this.blockChunk[slot] ? this.blockPtr[prev]! + alignUp(this.blockBytes[prev]!) - ch.ptr : 0;
    }
    this.unorder(ptr);
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
