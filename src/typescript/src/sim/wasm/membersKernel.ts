import { MEMBERS_BYTES, compiled } from "./loader.ts";
import { LAYOUT as L } from "./layout.ts";
import { Region } from "./resident.ts";
import type { ResidentStore } from "./resident.ts";

// The end-of-tick scans over the members' rows in WebAssembly (members.wat): settle (a tick alive for the living, a list of the others) and the birth candidates.
// Twins of the loops in Ecosystem.sharedPhase, which stay the reference and the fallback; tests/typescript/wasmMembers.test.ts compares them.

interface MembersExports extends WebAssembly.Exports {
  settle(m: number): void;
  birthCandidates(m: number): void;
}

let jsOnly = false;
// Runs the scans in JS even where the WebAssembly ones exist (tests and comparisons).
export function forceJsMembers(flag: boolean): void {
  jsOnly = flag;
}
export const jsMembersForced = (): boolean => jsOnly;

export class WasmMembers {
  private readonly store: ResidentStore;
  private readonly exports: MembersExports;
  private readonly rRowAt = new Region();
  private readonly rOut = new Region();
  private readonly rThresholds = new Region();
  private readonly pM: number;
  private list = new Int32Array(64); // the last result, in JS memory: acting on it may grow the kernel memory

  private constructor(store: ResidentStore, exports: MembersExports) {
    this.store = store;
    this.exports = exports;
    this.pM = store.bank.alloc(L.M_BYTES);
  }

  static create(store: ResidentStore): WasmMembers | null {
    try {
      const instance = new WebAssembly.Instance(compiled(MEMBERS_BYTES), { brain: { mem: store.bank.memory } });
      return new WasmMembers(store, instance.exports as MembersExports);
    } catch {
      return null;
    }
  }

  private run(call: "settle" | "birthCandidates", rowAt: ArrayLike<number>, n: number, thresholds: ArrayLike<number> | null, first: number): Int32Array {
    const { store } = this;
    const rowAtAt = store.grow(this.rRowAt, n * 4);
    const outAt = store.grow(this.rOut, n * 4);
    const thresholdsAt = thresholds ? store.grow(this.rThresholds, n * 8) : 0;
    const { i32, f64 } = store; // after the last allocation
    i32.set(rowAt as ArrayLike<number>, rowAtAt >> 2);
    if (thresholds) f64.set(thresholds as ArrayLike<number>, thresholdsAt >> 3);
    const M = this.pM;
    i32[(M + L.M_N) >> 2] = n;
    i32[(M + L.M_ROW_AT) >> 2] = rowAtAt;
    i32[(M + L.M_OUT) >> 2] = outAt;
    i32[(M + L.M_THRESHOLDS) >> 2] = thresholdsAt;
    i32[(M + L.M_FIRST) >> 2] = first;
    this.exports[call](M);
    const count = i32[(M + L.M_OUT_COUNT) >> 2]!;
    if (count > this.list.length) this.list = new Int32Array(Math.max(count, 2 * this.list.length));
    this.list.set(i32.subarray(outAt >> 2, (outAt >> 2) + count));
    return this.list.subarray(0, count);
  }

  // Counts a tick alive for each of the n members (rowAt[i]: f64 index of member i's row) with energy left; returns the others' indices, highest first.
  // Valid until the next call.
  settle(rowAt: ArrayLike<number>, n: number): Int32Array {
    return this.run("settle", rowAt, n, null, 0);
  }

  // The members, from index first round the list once, whose energy is not below thresholds[i]. Valid until the next call.
  birthCandidates(rowAt: ArrayLike<number>, n: number, thresholds: ArrayLike<number>, first: number): Int32Array {
    return this.run("birthCandidates", rowAt, n, thresholds, first);
  }
}
