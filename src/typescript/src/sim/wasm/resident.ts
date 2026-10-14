import type { WasmBrainBank } from "./brainKernel.ts";
import type { Heading } from "../physics.ts";
import type { EngineConfig } from "../config.ts";
import type { CreatureState } from "../types.ts";

// Creature bodies that live in the WebAssembly memory (rows of ROW_BYTES, layout in step.wat), so the step kernel works on them in
// place and JS reads them through ResidentState, an object with the same fields as a plain CreatureState. Rows are carved from
// chunks of the brain bank's arena and never move; a row belongs to its Creature for life (creatures are recycled, not dropped).
// The memory's views go stale when it grows, so the store keeps every state pointed at the current ones (Kernel.onGrow).

export const ROW_BYTES = 320;
export const UNITS_MAX = 16; // memory units a row holds (8 short and 8 long, the plan limit)
const CHUNK_ROWS = 256;
const BLOCK_BYTES = 256; // a species' parameter block (step.wat)
const UNITS_AT = 24; // f64 index of the units in a row
// i32 indices in a row (bytes / 4)
export const I_OUT = 28;
export const I_PARAMS = 29;
export const I_SHORT = 30;
export const I_UNITS = 31;
export const I_RAYS = 32;
export const I_OFFSETS = 33;
export const I_INPUT = 34;
export const I_BAD = 35;
export const I_SLOT = 36;

export class ResidentState implements CreatureState, Heading {
  alive = true;
  f: Float64Array;
  i: Int32Array;
  private count = 0; // memory units the plan has
  readonly o: number; // f64 index of the row
  readonly ptr: number; // byte address of the row

  constructor(f: Float64Array, i: Int32Array, ptr: number) {
    this.f = f;
    this.i = i;
    this.ptr = ptr;
    this.o = ptr >> 3;
  }

  bind(f: Float64Array, i: Int32Array): void {
    this.f = f;
    this.i = i;
  }

  get x(): number { return this.f[this.o]!; }
  set x(v: number) { this.f[this.o] = v; }
  get y(): number { return this.f[this.o + 1]!; }
  set y(v: number) { this.f[this.o + 1] = v; }
  get vx(): number { return this.f[this.o + 2]!; }
  set vx(v: number) { this.f[this.o + 2] = v; }
  get vy(): number { return this.f[this.o + 3]!; }
  set vy(v: number) { this.f[this.o + 3] = v; }
  get heading(): number { return this.f[this.o + 5]!; }
  set heading(v: number) { this.f[this.o + 5] = v; }
  get cos(): number { return this.f[this.o + 8]!; }
  set cos(v: number) { this.f[this.o + 8] = v; }
  get sin(): number { return this.f[this.o + 9]!; }
  set sin(v: number) { this.f[this.o + 9] = v; }
  get turnRate(): number { return this.f[this.o + 6]!; }
  set turnRate(v: number) { this.f[this.o + 6] = v; }
  get energy(): number { return this.f[this.o + 4]!; }
  set energy(v: number) { this.f[this.o + 4] = v; }
  get ticksAlive(): number { return this.f[this.o + 7]!; }
  set ticksAlive(v: number) { this.f[this.o + 7] = v; }
  set upkeep(v: number) { this.f[this.o + 10] = v; }
  set groundFactor(v: number) { this.f[this.o + 11] = v; }
  set rayLength(v: number) { this.f[this.o + 13] = v; }

  // Sizes the units for a plan (all zero) and tells the kernel how many there are.
  fitUnits(count: number, short: number): void {
    if (count > UNITS_MAX) throw new Error(`${count} memory units exceed the ${UNITS_MAX} of a resident row`);
    this.count = count;
    this.f.fill(0, this.o + UNITS_AT, this.o + UNITS_AT + UNITS_MAX);
    this.i[this.o * 2 + I_SHORT] = short;
    this.i[this.o * 2 + I_UNITS] = count;
  }

  // A view of the units, valid until the memory grows; made on each call, so keep it out of hot loops.
  get units(): Float64Array {
    return this.f.subarray(this.o + UNITS_AT, this.o + UNITS_AT + this.count);
  }

  // The byte address of this creature's brain outputs, for the step kernel.
  set outPtr(bytes: number) { this.i[this.o * 2 + I_OUT] = bytes; }
  set params(ptr: number) { this.i[this.o * 2 + I_PARAMS] = ptr; }

  // What the fill kernel reads to build this creature's sense record and brain input: its brain slot, the number of rays, the address of
  // its ray offset tables and the byte address of its brain input vector.
  setBrain(slot: number, rays: number, offsets: number, input: number): void {
    const i = this.i;
    const b = this.o * 2;
    i[b + I_SLOT] = slot;
    i[b + I_RAYS] = rays;
    i[b + I_OFFSETS] = offsets;
    i[b + I_INPUT] = input;
  }
  get bad(): boolean { return this.i[this.o * 2 + I_BAD] !== 0; }
  clearBad(): void { this.i[this.o * 2 + I_BAD] = 0; }
}

// A block of the memory that grows on demand (contents are not kept).
export class Region {
  ptr = 0;
  cap = 0;
}

export class ResidentStore {
  f64 = new Float64Array(0);
  i32 = new Int32Array(0);
  readonly bank: WasmBrainBank;
  private readonly states: ResidentState[] = [];
  private chunk = 0;
  private left = 0;
  readonly blocks = new Map<EngineConfig, number>(); // a parameter block per species config (rewritten each tick by the stepper)

  constructor(bank: WasmBrainBank) {
    this.bank = bank;
    bank.onGrow(() => this.refresh());
    this.refresh();
  }

  private refresh(): void {
    const buffer = this.bank.memory.buffer;
    this.f64 = new Float64Array(buffer);
    this.i32 = new Int32Array(buffer);
    for (const s of this.states) s.bind(this.f64, this.i32);
  }

  // A new row. Call bank-resetting owners' reset() first when the bank was reset.
  add(): ResidentState {
    if (this.left === 0) {
      this.chunk = (this.bank.alloc(CHUNK_ROWS * ROW_BYTES + 64) + 63) & ~63; // rows start on a cache line
      this.left = CHUNK_ROWS;
    }
    const ptr = this.chunk + (CHUNK_ROWS - this.left--) * ROW_BYTES;
    this.f64.fill(0, ptr >> 3, (ptr + ROW_BYTES) >> 3);
    const s = new ResidentState(this.f64, this.i32, ptr);
    this.states.push(s);
    return s;
  }

  // The address of region r with room for bytes, moved to a larger block when needed.
  grow(r: Region, bytes: number): number {
    if (bytes > r.cap) {
      if (r.cap) this.bank.free(r.ptr, r.cap);
      r.cap = Math.ceil(bytes * 1.25);
      r.ptr = this.bank.alloc(r.cap);
    }
    return r.ptr;
  }

  // The species parameter block of a config (rewritten each tick by the stepper), allocated on first use.
  block(key: EngineConfig): number {
    let ptr = this.blocks.get(key);
    if (ptr === undefined) {
      ptr = this.bank.alloc(BLOCK_BYTES);
      this.blocks.set(key, ptr);
    }
    return ptr;
  }

  // Forgets every row and block, after the bank was reset; creatures of the previous owner must be gone.
  reset(): void {
    this.states.length = 0;
    this.blocks.clear();
    this.chunk = 0;
    this.left = 0;
    this.refresh();
  }
}
