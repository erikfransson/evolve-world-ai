import { BlockChunks } from "../../src/typescript/src/sim/wasm/blockChunks.ts";
import type { BlockHost } from "../../src/typescript/src/sim/wasm/blockChunks.ts";
import type { Arena } from "../../src/typescript/src/sim/wasm/loader.ts";

// The brain bank's block placement alone: alignment, run order by address, holes and compaction, on a bump arena that hands out chunks back to back.

const CHUNK = 1 << 20;
function make() {
  let top = 1 << 24; // chunks start well above 0 and 64-byte aligned
  const allocs: number[] = [];
  const arena = { alloc: (bytes: number): number => { const p = top; top += bytes; allocs.push(bytes); return p; } } as unknown as Arena;
  const moves: [number, number, number, number][] = [];
  const host: BlockHost = { relocate: (slot, from, to, bytes) => moves.push([slot, from, to, bytes]) };
  return { chunks: new BlockChunks(arena, host), allocs, moves };
}
const order = (c: BlockChunks): number[] => Array.from(c.order.subarray(0, c.held));

describe("BlockChunks", () => {
  it("places blocks back to back on 64-byte lines, in one chunk, listed by address", () => {
    const { chunks, allocs } = make();
    const a = chunks.set(7, 100);
    const b = chunks.set(3, 64);
    const c = chunks.set(9, 65);
    expect([b - a, c - b]).toEqual([128, 64]); // 100 pads to 128, 64 stays, 65 pads to 128
    expect(a % 64).toBe(0);
    expect(order(chunks)).toEqual([7, 3, 9]);
    expect(allocs).toEqual([CHUNK]);
    expect(chunks.ptr(3)).toBe(b);
    expect(chunks.ptr(4)).toBeUndefined();
  });

  it("keeps a block in place when the padded size is unchanged and moves it to the end when it changes", () => {
    const { chunks } = make();
    const a = chunks.set(0, 100);
    chunks.set(1, 100);
    expect(chunks.set(0, 120)).toBe(a); // 100 and 120 both pad to 128
    const moved = chunks.set(0, 200);
    expect(moved).not.toBe(a);
    expect(order(chunks)).toEqual([1, 0]);
  });

  it("takeOrder gives the order once per change", () => {
    const { chunks } = make();
    expect(chunks.takeOrder()).not.toBeNull(); // dirty from the start
    expect(chunks.takeOrder()).toBeNull();
    chunks.set(0, 64);
    expect(chunks.takeOrder()).not.toBeNull();
    chunks.release(0);
    expect(chunks.takeOrder()).not.toBeNull();
    chunks.release(0); // a slot without a block: nothing changes
    expect(chunks.takeOrder()).toBeNull();
  });

  it("leaves a hole for a released middle block, then compact slides the later blocks down and tells the host", () => {
    const { chunks, moves } = make();
    const p = [0, 1, 2, 3].map((s) => chunks.set(s, 1000)); // 1024 each
    chunks.release(1);
    expect(order(chunks)).toEqual([0, 2, 3]);
    expect(chunks.ptr(2)).toBe(p[2]); // the hole stays until compact
    chunks.compact();
    expect(moves).toEqual([[2, p[2]!, p[1]!, 1000], [3, p[3]!, p[2]!, 1000]]);
    expect([chunks.ptr(0), chunks.ptr(2), chunks.ptr(3)]).toEqual([p[0], p[1], p[2]]);
    moves.length = 0;
    chunks.compact();
    expect(moves).toEqual([]); // nothing left to slide
    expect(chunks.set(5, 1000)).toBe(p[3]); // the chunk's end moved back with the slide
  });

  it("moves the chunk's end back when the last block is released, so the space is reused", () => {
    const { chunks } = make();
    chunks.set(0, 64);
    const last = chunks.set(1, 64);
    chunks.release(1);
    expect(chunks.set(2, 64)).toBe(last);
  });

  it("starts a second chunk when the first is full and gives a block larger than a chunk its own", () => {
    const { chunks, allocs } = make();
    chunks.set(0, CHUNK - 64);
    const second = chunks.set(1, 128);
    expect(allocs).toEqual([CHUNK, CHUNK]);
    expect(second).not.toBe(chunks.ptr(0)! + CHUNK - 64);
    chunks.set(2, CHUNK + 1);
    expect(allocs[2]).toBe(CHUNK + 64); // padded to the line
  });

  it("grows its order list past 64 slots and keeps it sorted by address", () => {
    const { chunks } = make();
    for (let s = 0; s < 200; s++) chunks.set(s, 64);
    expect(chunks.held).toBe(200);
    const ptrs = order(chunks).map((s) => chunks.ptr(s)!);
    expect(ptrs).toEqual([...ptrs].sort((x, y) => x - y));
  });
});
