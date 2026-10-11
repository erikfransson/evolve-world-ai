import type { Creature, SenseBatch } from "../creature.ts";
import type { Crowd } from "../crowd.ts";
import type { World } from "../world.ts";
import { WasmBrainBank } from "./brainKernel.ts";
import { WasmRayCaster } from "./rayKernel.ts";
import { WasmSenser } from "./senser.ts";

// senseThinkBatch on the WASM kernels: item and wall rays stay in JS, the crowd rays and the brains run in WebAssembly.
// Each creature keeps a brain slot here for as long as this owner holds it (creatures are recycled, not dropped), and
// the slot is set again whenever reset gave the creature a new genome or plan. Results are f32, so they differ from the
// JS path, but each creature's result depends only on its own inputs and the crowd, so any split into batches agrees.
export class SenseKernels {
  private readonly brains: WasmBrainBank;
  private readonly caster: WasmRayCaster;
  private readonly versions: number[] = []; // brainVersion of the creature each slot was set from
  static full = typeof process !== "undefined" && process.env.SENSE_FULL === "1"; // prototype switch: one-call sense (sense.wat)
  private senser: WasmSenser | null = null;
  private nextSlot = 0;
  private slots = new Int32Array(64);

  private constructor(brains: WasmBrainBank, caster: WasmRayCaster) {
    this.brains = brains;
    this.caster = caster;
  }

  // Null when WebAssembly SIMD is unavailable or disabled; use the JS path then.
  static create(): SenseKernels | null {
    const brains = WasmBrainBank.createSync();
    const caster = brains && WasmRayCaster.createSync();
    return brains && caster ? new SenseKernels(brains, caster) : null;
  }

  run(world: World, crowd: Crowd, batch: SenseBatch): void {
    const n = batch.count;
    if (n === 0) return;
    const { creatures, selves } = batch;
    if (SenseKernels.full) return this.runFull(world, crowd, batch);
    const caster = this.caster;
    caster.loadCrowd(crowd);
    for (let k = 0; k < n; k++) {
      const c = creatures[k]!;
      c.senseWorld(world);
      if (c.rays.length > 0) c.queueCrowd(caster, selves[k]!);
    }
    caster.run();
    caster.apply();

    if (n > this.slots.length) this.slots = new Int32Array(Math.max(n, 2 * this.slots.length));
    const slots = this.slots;
    const brains = this.brains;
    for (let k = 0; k < n; k++) slots[k] = this.slotOf(creatures[k]!);
    let f32 = brains.f32; // after the sets, which may grow the memory
    for (let k = 0; k < n; k++) f32.set(creatures[k]!.encode(), brains.inputAt(slots[k]!));
    brains.forwardSlots(slots, n);
    f32 = brains.f32;
    for (let k = 0; k < n; k++) {
      const out = creatures[k]!.outputs;
      const at = brains.outputAt(slots[k]!);
      for (let i = 0; i < out.length; i++) out[i] = f32[at + i]!;
    }
  }

  private runFull(world: World, crowd: Crowd, batch: SenseBatch): void {
    const n = batch.count;
    const { creatures, selves } = batch;
    const senser = (this.senser ??= WasmSenser.create(this.brains));
    if (!senser) throw new Error("sense.wat unavailable");
    if (n > this.slots.length) this.slots = new Int32Array(Math.max(n, 2 * this.slots.length));
    const slots = this.slots;
    const brains = this.brains;
    for (let k = 0; k < n; k++) slots[k] = this.slotOf(creatures[k]!);
    const stride = creatures[0]!.rayStride;
    senser.run(world, crowd, creatures, slots, selves, n, stride, creatures[0]!.startEnergy);
    brains.forwardSlots(slots, n);
    const f32 = brains.f32;
    for (let k = 0; k < n; k++) {
      const out = creatures[k]!.outputs;
      const at = brains.outputAt(slots[k]!);
      for (let i = 0; i < out.length; i++) out[i] = f32[at + i]!;
    }
  }

  // The creature's slot, holding its current brain.
  private slotOf(c: Creature): number {
    if (c.kernelOwner !== this) {
      c.kernelOwner = this;
      c.kernelSlot = this.nextSlot++;
      this.versions[c.kernelSlot] = -1;
    }
    const slot = c.kernelSlot;
    if (this.versions[slot] !== c.brainVersion) {
      this.brains.set(slot, c.brain.sizes, c.brain.genome);
      if (SenseKernels.full) (this.senser ??= WasmSenser.create(this.brains))!.setOffsets(slot, c);
      this.versions[slot] = c.brainVersion;
    }
    return slot;
  }
}
