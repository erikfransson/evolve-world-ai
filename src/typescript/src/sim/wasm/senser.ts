import type { Creature } from "../creature.ts";
import type { Crowd } from "../crowd.ts";
import { energySignal } from "../sensors.ts";
import type { World } from "../world.ts";
import type { WasmBrainBank } from "./brainKernel.ts";
import { HIT_CREATURE } from "../types.ts";
import { SENSE_BYTES } from "./loader.ts";

// The whole Ecosystem sense in one WebAssembly call per batch (sense.wat): ray directions, item and wall rays in f64 with the
// JS candidate order, crowd rays in f32 as rays.wat, and the ray features written into the brain's input vector in place.
// Shares the brain bank's linear memory. Per tick the item grid and the crowd are copied in whole, which costs far less
// than the per-creature object traffic it replaces. The creature's RayHit objects are not updated, except for the one
// creature given as detail (the selected one), whose rays are read back for the UI.

const MAX_RAYS = 64;
const P_BYTES = 128;
const SCRATCH_BYTES = 2816;
const REC_BYTES = 64;

interface SenseExports extends WebAssembly.Exports {
  sense(p: number): void;
}

interface Region {
  ptr: number;
  cap: number;
}

export class WasmSenser {
  private readonly bank: WasmBrainBank;
  private readonly exports: SenseExports;
  private readonly offPtr: number[] = [];
  private readonly offBytes: number[] = [];
  private readonly regions = new Map<string, Region>();

  private constructor(bank: WasmBrainBank, exports: SenseExports) {
    this.bank = bank;
    this.exports = exports;
  }

  static create(bank: WasmBrainBank): WasmSenser | null {
    try {
      const imports = { brain: { mem: bank.memory } };
      const instance = new WebAssembly.Instance(new WebAssembly.Module(SENSE_BYTES), imports);
      return new WasmSenser(bank, instance.exports as SenseExports);
    } catch {
      return null;
    }
  }

  // Stores the creature's ray offset cos and sin tables for its slot; call when the slot's brain is set.
  setOffsets(slot: number, c: Creature): void {
    const n = c.rays.length;
    if (n > MAX_RAYS) throw new Error(`${n} rays exceed ${MAX_RAYS}`);
    const bytes = 16 * n;
    let ptr = this.offPtr[slot];
    if (ptr === undefined || this.offBytes[slot] !== bytes) {
      if (ptr !== undefined) this.bank.free(ptr, this.offBytes[slot]!);
      ptr = this.bank.alloc(bytes);
      this.offPtr[slot] = ptr;
      this.offBytes[slot] = bytes;
    }
    const f64 = new Float64Array(this.bank.memory.buffer, ptr, 2 * n);
    f64.set(c.offsetCos, 0);
    f64.set(c.offsetSin, n);
  }

  private region(name: string, bytes: number): number {
    let r = this.regions.get(name);
    if (!r) this.regions.set(name, (r = { ptr: -1, cap: 0 }));
    if (bytes > r.cap) {
      if (r.ptr >= 0) this.bank.free(r.ptr, r.cap);
      r.cap = Math.ceil(bytes * 1.25);
      r.ptr = this.bank.alloc(r.cap);
    }
    return r.ptr;
  }

  // Senses the batch and writes each creature's complete brain input (rays, extras, memory) at its slot.
  run(world: World, crowd: Crowd, creatures: readonly Creature[], slots: Int32Array, selves: Int32Array, n: number, stride: number, startEnergy: number, detail: Creature | null = null): void {
    const cells = world.cols * world.rows;
    const count = crowd.count;
    const ccells = crowd.cols * crowd.rows;
    const pItems = this.region("ix", world.count * 4);
    const pItemsY = this.region("iy", world.count * 4);
    const pKinds = this.region("ik", world.count + 4);
    const pHead = this.region("hd", cells * 4);
    const pNext = this.region("nx", world.count * 4);
    const pCStart = this.region("cs", (ccells + 1) * 4);
    const pSx = this.region("sx", count * 4 + 16);
    const pSy = this.region("sy", count * 4 + 16);
    const pOwn = this.region("ow", count * 4 + 16);
    const pSig = this.region("sg", count * 4 + 16);
    const pRec = this.region("rc", n * REC_BYTES);
    const pCand = this.region("cd", Math.max(world.count * 32, count * 16) + 64);
    const pScr = this.region("sr", SCRATCH_BYTES);
    const pDetail = this.region("dt", 16 * MAX_RAYS);
    const pP = this.region("pp", P_BYTES);
    const buffer = this.bank.memory.buffer;
    const f32 = new Float32Array(buffer);
    const i32 = new Int32Array(buffer);
    f32.set(world.xs, pItems >> 2);
    f32.set(world.ys, pItemsY >> 2);
    new Uint8Array(buffer, pKinds, world.count).set(world.kinds);
    i32.set(world.cellHead, pHead >> 2);
    i32.set(world.nextItem, pNext >> 2);
    i32.set(crowd.cellStart, pCStart >> 2);
    const sx = pSx >> 2;
    const sy = pSy >> 2;
    const own = pOwn >> 2;
    const sig = pSig >> 2;
    const { xs, ys, owners, energies } = crowd;
    for (let k = 0; k < count; k++) {
      f32[sx + k] = xs[k]!;
      f32[sy + k] = ys[k]!;
      i32[own + k] = owners[k]!;
      f32[sig + k] = energySignal(energies[k]!, startEnergy);
    }
    const rec = new Float64Array(buffer, pRec, n * (REC_BYTES / 8));
    const recI = new Int32Array(buffer, pRec, n * (REC_BYTES / 4));
    for (let k = 0; k < n; k++) {
      const c = creatures[k]!;
      const s = c.state;
      const o = k * 8;
      const slot = slots[k]!;
      const rays = c.rays.length;
      rec[o] = s.x;
      rec[o + 1] = s.y;
      rec[o + 2] = c.heading.cos;
      rec[o + 3] = c.heading.sin;
      rec[o + 4] = c.plan.rayLength;
      const w = k * 16;
      recI[w + 10] = selves[k]!;
      recI[w + 11] = rays;
      recI[w + 12] = this.offPtr[slot]!;
      const inFloat = this.bank.inputAt(slot);
      recI[w + 13] = inFloat * 4;
      recI[w + 14] = c === detail ? pDetail : 0;
      c.writeBodyInputs(f32, inFloat + rays * stride);
    }
    const P = new Float64Array(buffer, pP, P_BYTES / 8);
    const PF = new Float32Array(buffer, pP, P_BYTES / 4);
    const PI = new Int32Array(buffer, pP, P_BYTES / 4);
    P[0] = world.width;
    P[1] = world.height;
    P[2] = world.itemRadius;
    P[3] = 1 / world.cell;
    PF[8] = 1 / crowd.cell;
    PF[9] = crowd.radius;
    PI[10] = world.cols;
    PI[11] = world.rows;
    PI[12] = pHead;
    PI[13] = pNext;
    PI[14] = pItems;
    PI[15] = pItemsY;
    PI[16] = pKinds;
    PI[17] = crowd.cols;
    PI[18] = crowd.rows;
    PI[19] = pCStart;
    PI[20] = pSx;
    PI[21] = pSy;
    PI[22] = pOwn;
    PI[23] = pSig;
    PI[24] = pRec;
    PI[25] = n;
    PI[26] = stride;
    PI[27] = pCand;
    PI[28] = pScr;
    this.exports.sense(pP);
  }

  // After run with this creature as detail: writes its rays (closeness, kind, seen energy) into c.rays.
  readRays(c: Creature, crowd: Crowd): void {
    const ptr = this.regions.get("dt")!.ptr;
    const buffer = this.bank.memory.buffer;
    const f64 = new Float64Array(buffer, ptr, 2 * c.rays.length);
    const i32 = new Int32Array(buffer, ptr, 4 * c.rays.length);
    for (let i = 0; i < c.rays.length; i++) {
      const ray = c.rays[i]!;
      ray.closeness = f64[2 * i]!;
      ray.kind = i32[4 * i + 2] as typeof ray.kind;
      if (ray.kind === HIT_CREATURE) ray.energy = crowd.energies[i32[4 * i + 3]!]!;
    }
  }
}
