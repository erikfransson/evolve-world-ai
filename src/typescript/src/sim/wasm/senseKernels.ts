import type { Creature, SenseBatch } from "../creature.ts";
import type { EcoConfig } from "../ecoConfig.ts";
import { inputLayout } from "../sensors.ts";
import { seenEnergyScale, speciesList } from "../species.ts";
import type { Crowd } from "../crowd.ts";
import type { World } from "../world.ts";
import { WasmBrainBank } from "./brainKernel.ts";
import { MAX_RAYS, WasmSenser } from "./senser.ts";

// senseThinkBatch on the WASM kernels: sense.wat does rays and brain inputs for the whole batch in one call, then the brains run
// in WebAssembly too. Each creature keeps a brain slot here for as long as this owner holds it (creatures are recycled, not
// dropped), and the slot is set again whenever reset gave the creature a new genome or plan. Results are f32 in the crowd rays
// and the brain, so they differ from the JS path, but each creature's result depends only on its own inputs and the item and
// crowd snapshots, so any split into batches agrees.
export class SenseKernels {
  // The creature whose rays (creature.rays) and brain input must be current after the batch, such as the selected one.
  // Everyone else's RayHit objects are left stale.
  detail: Creature | null = null;
  private readonly brains: WasmBrainBank;
  private readonly senser: WasmSenser;
  private readonly stride: number; // ray features per ray in the brain input
  private readonly energyScale: number; // seen energies are squashed against this, the largest species start energy (speciesEngine's seenEnergyScale)
  private readonly versions: number[] = []; // brainVersion of the creature each slot was set from
  private nextSlot = 0;
  private slots = new Int32Array(64);

  private constructor(brains: WasmBrainBank, senser: WasmSenser, config: EcoConfig) {
    this.brains = brains;
    this.senser = senser;
    this.stride = inputLayout(config).rayFeatures;
    this.energyScale = seenEnergyScale(speciesList(config));
  }

  // Null when WebAssembly SIMD is unavailable or disabled, or when creatures may have more than MAX_RAYS rays (maxRays);
  // use the JS path then.
  static create(config: EcoConfig, maxRays = 0): SenseKernels | null {
    if (maxRays > MAX_RAYS) return null;
    const brains = WasmBrainBank.createSync();
    const senser = brains && WasmSenser.create(brains);
    return brains && senser ? new SenseKernels(brains, senser, config) : null;
  }

  run(world: World, crowd: Crowd, batch: SenseBatch): void {
    const n = batch.count;
    if (n === 0) return;
    const { creatures, selves } = batch;
    if (n > this.slots.length) this.slots = new Int32Array(Math.max(n, 2 * this.slots.length));
    const slots = this.slots;
    const brains = this.brains;
    let at = -1; // index of the detail creature in this batch
    for (let k = 0; k < n; k++) {
      slots[k] = this.slotOf(creatures[k]!);
      if (creatures[k] === this.detail) at = k;
    }
    const detail = at >= 0 ? this.detail : null;
    this.senser.run(world, crowd, creatures, slots, selves, n, this.stride, this.energyScale, detail);
    brains.forwardSlots(slots, n);
    const f32 = brains.f32;
    for (let k = 0; k < n; k++) {
      const out = creatures[k]!.outputs;
      const at = brains.outputAt(slots[k]!);
      for (let i = 0; i < out.length; i++) out[i] = f32[at + i]!;
    }
    if (detail) {
      this.senser.readRays(detail, crowd);
      detail.adoptInput(f32, brains.inputAt(slots[at]!));
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
      this.senser.setOffsets(slot, c);
      this.versions[slot] = c.brainVersion;
    }
    return slot;
  }
}
