import type { EngineConfig } from "../config.ts";
import type { Heading } from "../physics.ts";
import type { CreatureState } from "../types.ts";
import type { WasmBrainBank } from "./brainKernel.ts";
import { LAYOUT as L, f64At, i32At } from "./layout.ts";

// Creature bodies that live in the WebAssembly memory, one row each (offsets in layout.ts), so the fill kernel builds the sense batch from
// them without touching a JS object, and JS reads them through ResidentState, an object with the same fields as a plain CreatureState.
// Rows are carved from chunks of the brain bank's arena and never move. A row belongs to its Creature until the creature is dropped
// (release), then to the next one made. The memory's views go stale when it grows, so the store keeps every state pointed at the current ones (Kernel.onGrow).

const CHUNK_ROWS = 256;
const ROW_F = f64At(L.ROW_BYTES);
const [X, Y, VX, VY, ENERGY, HEADING, TURN, TICKS, COS, SIN, UPKEEP, GFACTOR, RAYLEN] = [L.R_X, L.R_Y, L.R_VX, L.R_VY, L.R_ENERGY, L.R_HEADING, L.R_TURN, L.R_TICKS, L.R_COS, L.R_SIN, L.R_UPKEEP, L.R_GROUND_FACTOR, L.R_RAY_LENGTH].map(f64At) as [number, number, number, number, number, number, number, number, number, number, number, number, number];

// Field indices (f64 elements from the row's) for the code that works on the row arrays directly.
export const F = { x: X, y: Y, vx: VX, vy: VY, energy: ENERGY, heading: HEADING, turn: TURN, ticks: TICKS, cos: COS, sin: SIN, upkeep: UPKEEP, groundFactor: GFACTOR, extras: f64At(L.R_EXTRAS) } as const;
// The same for the i32 fields (i32 elements from the row's).
export const I = { out: i32At(L.R_OUT), species: i32At(L.R_SPECIES), short: i32At(L.R_SHORT), unitCount: i32At(L.R_UNIT_COUNT), units: i32At(L.R_UNITS) } as const;

export class ResidentState implements CreatureState, Heading {
  alive = true;
  f: Float64Array;
  i: Int32Array;
  readonly o: number; // f64 index of the row
  readonly ptr: number; // byte address of the row
  private readonly store: ResidentStore;
  private unitBytes = 0; // size of the units block

  constructor(store: ResidentStore, ptr: number) {
    this.store = store;
    this.f = store.f64;
    this.i = store.i32;
    this.ptr = ptr;
    this.o = ptr >> 3;
  }

  bind(f: Float64Array, i: Int32Array): void {
    this.f = f;
    this.i = i;
  }

  get x(): number { return this.f[this.o + X]!; }
  set x(v: number) { this.f[this.o + X] = v; }
  get y(): number { return this.f[this.o + Y]!; }
  set y(v: number) { this.f[this.o + Y] = v; }
  get vx(): number { return this.f[this.o + VX]!; }
  set vx(v: number) { this.f[this.o + VX] = v; }
  get vy(): number { return this.f[this.o + VY]!; }
  set vy(v: number) { this.f[this.o + VY] = v; }
  get energy(): number { return this.f[this.o + ENERGY]!; }
  set energy(v: number) { this.f[this.o + ENERGY] = v; }
  get heading(): number { return this.f[this.o + HEADING]!; }
  set heading(v: number) { this.f[this.o + HEADING] = v; }
  get turnRate(): number { return this.f[this.o + TURN]!; }
  set turnRate(v: number) { this.f[this.o + TURN] = v; }
  get ticksAlive(): number { return this.f[this.o + TICKS]!; }
  set ticksAlive(v: number) { this.f[this.o + TICKS] = v; }
  get cos(): number { return this.f[this.o + COS]!; }
  set cos(v: number) { this.f[this.o + COS] = v; }
  get sin(): number { return this.f[this.o + SIN]!; }
  set sin(v: number) { this.f[this.o + SIN] = v; }
  set upkeep(v: number) { this.f[this.o + UPKEEP] = v; }
  set rayLength(v: number) { this.f[this.o + RAYLEN] = v; }

  // Sizes the memory units for a plan (all zero) and tells the kernels how many there are. The units live in a block of their own, so a plan can have any number.
  fitUnits(count: number, short: number): void {
    const bytes = 8 * Math.max(1, count);
    if (bytes > this.unitBytes) {
      const bank = this.store.bank;
      const old = this.unitBytes === 0 ? 0 : this.i[this.o * 2 + I.units]!;
      if (old) bank.free(old, this.unitBytes);
      const ptr = bank.alloc(bytes);
      this.unitBytes = bytes;
      this.i[this.o * 2 + I.units] = ptr; // after the alloc, which may have replaced this.i
    }
    const b = this.o * 2;
    this.i[b + I.short] = short;
    this.i[b + I.unitCount] = count;
    const at = this.i[b + I.units]! >> 3;
    this.f.fill(0, at, at + count);
  }

  // Frees the units block, as a new row has none.
  dropUnits(): void {
    if (this.unitBytes > 0) this.store.bank.free(this.i[this.o * 2 + I.units]!, this.unitBytes);
    this.unitBytes = 0;
  }

  // A view of the units, valid until the memory grows; made on each call, so keep it out of hot loops.
  get units(): Float64Array {
    const b = this.o * 2;
    const at = this.i[b + I.units]! >> 3;
    return this.f.subarray(at, at + this.i[b + I.unitCount]!);
  }

  // The byte address of this creature's brain outputs, for the step.
  set outPtr(bytes: number) { this.i[this.o * 2 + I.out] = bytes; }
  set species(index: number) { this.i[this.o * 2 + I.species] = index; }

  // What the fill kernel reads to build this creature's sense record and brain input: its brain slot, the number of rays, the address of
  // its ray offset tables and the byte address of its brain input vector.
  setBrain(slot: number, rays: number, offsets: number, input: number): void {
    const i = this.i;
    const b = this.o * 2;
    i[b + i32At(L.R_SLOT)] = slot;
    i[b + i32At(L.R_RAYS)] = rays;
    i[b + i32At(L.R_OFFSETS)] = offsets;
    i[b + i32At(L.R_INPUT)] = input;
  }
}

// A block of the memory that grows on demand (contents are not kept).
export class Region {
  ptr = 0;
  cap = 0;
}

// The address of region r with room for bytes, moved to a larger block of bank when needed.
export function growRegion(bank: WasmBrainBank, r: Region, bytes: number): number {
  if (bytes > r.cap) {
    if (r.cap) bank.free(r.ptr, r.cap);
    r.cap = Math.ceil(bytes * 1.25);
    r.ptr = bank.alloc(r.cap);
  }
  return r.ptr;
}

export class ResidentStore {
  f64 = new Float64Array(0);
  i32 = new Int32Array(0);
  readonly bank: WasmBrainBank;
  private readonly states: ResidentState[] = [];
  private readonly free: ResidentState[] = []; // released rows, handed out again by add before new ones are carved
  private chunk = 0;
  private left = 0;
  readonly species: EngineConfig[] = []; // the configs the rows' species indices stand for, set by the Ecosystem
  readonly rebinders = new Set<() => void>(); // views of the memory held elsewhere (the Ecosystem's crowd): each is called to re-point after the memory grew
  moved = 0; // counts the times a region moved or the memory grew, so views of them can be kept until it changes

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
    this.moved++;
    for (const rebind of this.rebinders) rebind();
  }

  // A new row (all zero), a released one when there is one.
  add(): ResidentState {
    const old = this.free.pop();
    if (old) {
      this.f64.fill(0, old.o, old.o + ROW_F);
      old.alive = true;
      return old;
    }
    if (this.left === 0) {
      this.chunk = Math.ceil(this.bank.alloc(CHUNK_ROWS * L.ROW_BYTES + 64) / 64) * 64; // rows start on a cache line
      this.left = CHUNK_ROWS;
    }
    const ptr = this.chunk + (CHUNK_ROWS - this.left--) * L.ROW_BYTES;
    this.f64.fill(0, ptr >> 3, (ptr >> 3) + ROW_F);
    const s = new ResidentState(this, ptr);
    this.states.push(s);
    return s;
  }

  // Takes back the row of a creature that is dropped; its state must not be used after this.
  release(s: ResidentState): void {
    s.dropUnits();
    this.free.push(s);
  }

  // The address of region r with room for bytes, moved to a larger block when needed.
  grow(r: Region, bytes: number): number {
    const before = r.cap;
    growRegion(this.bank, r, bytes);
    if (r.cap !== before) this.moved++;
    return r.ptr;
  }

  // Forgets every row, after the bank was reset; creatures of the previous owner must be gone.
  reset(): void {
    this.states.length = 0;
    this.free.length = 0;
    this.species.length = 0;
    this.rebinders.clear();
    this.chunk = 0;
    this.left = 0;
    this.refresh();
  }
}
