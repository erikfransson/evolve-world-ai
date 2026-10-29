import type { Arena } from "./loader.ts";

// Where the brain bank's weight blocks sit: slot to (address, bytes). Blocks are bump-allocated back to back in 1 MB chunks of arena memory, each starting on a cache line,
// and listed by address so a run can stream the weights in memory order. Holes left by freed blocks are slid out by compact().

const BLOCK_ALIGN = 64;
const CHUNK_BYTES = 1 << 20;
const HOLE_SHARE = 16; // a chunk is compacted when 1/HOLE_SHARE of its used bytes is hole

const alignUp = (n: number): number => (n + BLOCK_ALIGN - 1) & ~(BLOCK_ALIGN - 1);

// A run of arena memory the brain blocks are bump-allocated in: top bytes used, live of them held by blocks, the rest holes.
interface Chunk { ptr: number; cap: number; top: number; live: number }

// What the owner does when a block slides: copies the bytes at from..from+bytes to `to`, fixes its own addresses for the slot and tells whoever holds them.
export interface BlockHost {
  relocate(slot: number, from: number, to: number, bytes: number): void;
}

export class BlockChunks {
  private readonly arena: Arena;
  private readonly host: BlockHost;
  private readonly blockPtr: (number | undefined)[] = [];
  private readonly blockBytes: number[] = [];
  private readonly blockChunk: number[] = [];
  private readonly chunks: Chunk[] = [];
  order = new Int32Array(64); // the slots holding a block, by block address
  held = 0; // how many of order are in use
  private orderDirty = true;

  constructor(arena: Arena, host: BlockHost) {
    this.arena = arena;
    this.host = host;
  }

  // The order (use its first `held` entries) when it changed since the last call, else null.
  takeOrder(): Int32Array | null {
    if (!this.orderDirty) return null;
    this.orderDirty = false;
    return this.order;
  }

  // The block's address, undefined when the slot holds none.
  ptr(slot: number): number | undefined {
    return this.blockPtr[slot];
  }

  // Gives the slot a block of bytes (unpadded size), replacing its old one; returns its address. The block stays where it is when the padded size is unchanged.
  // Another slot's block may slide (and be reported through the host) during this call.
  set(slot: number, bytes: number): number {
    let ptr = this.blockPtr[slot];
    if (ptr === undefined || alignUp(this.blockBytes[slot]!) !== alignUp(bytes)) {
      if (ptr !== undefined) this.freeBlock(slot);
      ptr = this.place(slot, alignUp(bytes));
      this.blockPtr[slot] = ptr;
      this.reorder(slot, ptr);
    }
    this.blockBytes[slot] = bytes;
    return ptr;
  }

  // Gives the slot's block back (a no-op without one): the hole stays until compact() unless the block is the last one, then the chunk's end moves back.
  release(slot: number): void {
    if (this.blockPtr[slot] === undefined) return;
    this.freeBlock(slot);
    this.blockPtr[slot] = undefined;
    this.blockBytes[slot] = 0;
  }

  // Slides the live blocks of the chunk with the most hole down over its holes (when the hole is over 1/HOLE_SHARE of its used bytes), so the
  // run-order stream of weights has no gaps. Block contents are copied whole, so results are unchanged; the host relocates each moved slot.
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
    let at = ch.ptr;
    for (let k = this.find(ch.ptr); k < this.held && this.blockChunk[this.order[k]!] === c; k++) {
      const slot = this.order[k]!;
      const ptr = this.blockPtr[slot]!;
      const bytes = this.blockBytes[slot]!;
      if (ptr !== at) {
        this.host.relocate(slot, ptr, at, bytes);
        this.blockPtr[slot] = at;
      }
      at += alignUp(bytes);
    }
    ch.top = at - ch.ptr;
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
    this.unorder(k);
  }

  private unorder(k: number): void {
    this.order.copyWithin(k, k + 1, this.held--);
    this.orderDirty = true;
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
    this.orderDirty = true;
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
}
