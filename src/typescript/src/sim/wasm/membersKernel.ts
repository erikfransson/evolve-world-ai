import { MEMBERS_BYTES, compiled } from "./loader.ts";
import { LAYOUT as L } from "./layout.ts";
import { Region } from "./resident.ts";
import type { ResidentStore } from "./resident.ts";

// The end-of-tick scans over the members' rows in WebAssembly (members.wat): settle (a tick alive for the living, a list of the others) and the birth candidates.
// Also the scan of ga.ts mutate (the genes that mutate, with their draws).
// Twins of the loops in Ecosystem.sharedPhase and ga.ts mutate, which stay the reference and the fallback; tests/typescript/wasmMembers.test.ts compares them.

interface MembersExports extends WebAssembly.Exports {
  settle(m: number): void;
  birthCandidates(m: number): void;
  mutateScan(m: number): void;
}

export class WasmMembers {
  private readonly store: ResidentStore;
  private readonly exports: MembersExports;
  private readonly rRowAt = new Region();
  private readonly rOut = new Region();
  private readonly rThresholds = new Region();
  private readonly rHits = new Region();
  endState = 0; // the generator state after the last mutateHits scan
  private readonly pM: number; // call block of settle and the birth walk
  private readonly pScan: number; // call block of mutateScan, so mutateHits calls leave the walk's fields alone
  private list = new Int32Array(64); // the last result, in JS memory: acting on it may grow the kernel memory

  private constructor(store: ResidentStore, exports: MembersExports) {
    this.store = store;
    this.exports = exports;
    this.pM = store.bank.alloc(L.M_BYTES);
    this.pScan = store.bank.alloc(L.M_BYTES);
  }

  static create(store: ResidentStore): WasmMembers | null {
    try {
      const instance = new WebAssembly.Instance(compiled(MEMBERS_BYTES), { brain: { mem: store.bank.memory } });
      return new WasmMembers(store, instance.exports as MembersExports);
    } catch {
      return null;
    }
  }

  private run(call: "settle" | "birthCandidates", rowAt: Int32Array, n: number, thresholds: Float64Array | null, first: number, max = 0): Int32Array {
    const { store } = this;
    const rowAtAt = store.grow(this.rRowAt, n * 4);
    const outAt = store.grow(this.rOut, n * 4);
    const thresholdsAt = thresholds ? store.grow(this.rThresholds, n * 8) : 0;
    const { i32, f64 } = store; // after the last allocation
    i32.set(rowAt.subarray(0, n), rowAtAt >> 2);
    if (thresholds) f64.set(thresholds.subarray(0, n), thresholdsAt >> 3);
    const M = this.pM;
    i32[(M + L.M_N) >> 2] = n;
    i32[(M + L.M_ROW_AT) >> 2] = rowAtAt;
    i32[(M + L.M_OUT) >> 2] = outAt;
    i32[(M + L.M_THRESHOLDS) >> 2] = thresholdsAt;
    i32[(M + L.M_FIRST) >> 2] = first;
    i32[(M + L.M_MAX) >> 2] = max;
    i32[(M + L.M_STEPS) >> 2] = 0;
    this.exports[call](M);
    return this.result();
  }

  private result(): Int32Array {
    const { i32 } = this.store;
    const M = this.pM;
    const outAt = this.rOut.ptr;
    const count = i32[(M + L.M_OUT_COUNT) >> 2]!;
    if (count > this.list.length) this.list = new Int32Array(Math.max(count, 2 * this.list.length));
    this.list.set(i32.subarray(outAt >> 2, (outAt >> 2) + count));
    return this.list.subarray(0, count);
  }

  // Counts a tick alive for each of the n members (rowAt[i]: f64 index of member i's row) with energy left; returns the others' indices, highest first.
  // Valid until the next call.
  settle(rowAt: Int32Array, n: number): Int32Array {
    return this.run("settle", rowAt, n, null, 0);
  }

  // The first max of the members, from index first round the list once, whose energy is not below thresholds[i]. Valid until the next call.
  // A result shorter than max is the end of the walk; a full one may be followed by nextBirthCandidates.
  birthCandidates(rowAt: Int32Array, n: number, thresholds: Float64Array, first: number, max = n): Int32Array {
    return this.run("birthCandidates", rowAt, n, thresholds, first, max);
  }

  // The next max of the walk of the last birthCandidates call (no settle in between), from its copies of rowAt and thresholds (energies are read as they are now). Valid until the next call.
  nextBirthCandidates(max: number): Int32Array {
    const { i32 } = this.store;
    const M = this.pM;
    i32[(M + L.M_MAX) >> 2] = max;
    this.exports.birthCandidates(M);
    return this.result();
  }

  // ga.ts mutate's scan of n genes from generator state `state`, where a gene mutates when its draw is below limit (0 < limit < 2^32):
  // the gene index and the two draws of its normal, three i32 per mutated gene; endState is the state after the scan. Valid until the next call that allocates.
  mutateHits(n: number, state: number, limit: number): Int32Array {
    const { store } = this;
    const outAt = store.grow(this.rHits, n * 12);
    const { i32 } = store; // after the allocation
    const M = this.pScan;
    i32[(M + L.M_N) >> 2] = n;
    i32[(M + L.M_OUT) >> 2] = outAt;
    i32[(M + L.M_SEED) >> 2] = state;
    i32[(M + L.M_LIMIT) >> 2] = limit;
    this.exports.mutateScan(M);
    this.endState = i32[(M + L.M_SEED) >> 2]!;
    const count = i32[(M + L.M_OUT_COUNT) >> 2]!;
    return i32.subarray(outAt >> 2, (outAt >> 2) + 3 * count);
  }
}
