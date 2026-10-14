import type { Creature, SenseBatch } from "../creature.ts";
import type { EcoConfig } from "../ecoConfig.ts";
import { inputLayout } from "../sensors.ts";
import { seenEnergyScale, speciesList } from "../species.ts";
import type { Crowd } from "../crowd.ts";
import type { World } from "../world.ts";
import { WasmBrainBank } from "./brainKernel.ts";
import type { PhaseTimer } from "../profile.ts";
import { ResidentStore } from "./resident.ts";
import { prepareRows } from "./residentStep.ts";
import { MAX_RAYS, WasmSenser } from "./senser.ts";
import { WasmFiller } from "./fillKernel.ts";
import { WasmStepper } from "./stepKernel.ts";

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
  private resident: { store: ResidentStore; filler: WasmFiller } | null | undefined; // made by residentStore, when an Ecosystem wants its creatures' bodies in this memory
  private stride: number; // ray features per ray in the brain input
  private energyScale: number; // seen energies are squashed against this, the largest species start energy (speciesEngine's seenEnergyScale)
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

  // Back to the state of a new SenseKernels for this config, so successive Ecosystems on one thread can share the instances
  // (RL builds one per episode). Results are bit-identical to fresh kernels. One owner at a time; creatures of the previous owner must be gone.
  // Resident rows are forgotten here, but the previous owner's ResidentStates still point at the same memory, which the new owner reuses:
  // they must not be read or written after this.
  reset(config: EcoConfig): this {
    this.brains.reset();
    this.senser.reset();
    if (this.resident) {
      this.resident.store.reset();
      this.resident.filler.reset();
      this.resident.store.stepper?.reset();
    }
    this.versions.length = 0;
    this.nextSlot = 0;
    this.detail = null;
    this.stride = inputLayout(config).rayFeatures;
    this.energyScale = seenEnergyScale(speciesList(config));
    return this;
  }

  // Where creature bodies can live in this memory (see ResidentStore), or null when WebAssembly cannot instantiate the fill kernel.
  residentStore(): ResidentStore | null {
    if (this.resident === undefined) {
      const store = new ResidentStore(this.brains);
      const filler = WasmFiller.create(store);
      store.stepper = WasmStepper.create(store);
      this.resident = filler ? { store, filler } : null;
    }
    return this.resident?.store ?? null;
  }

  // The item tables the step kernel looks items up in, or null when stale (see WasmSenser.itemTables).
  itemTables(world: World): { start: number; xy: number; ids: number; cols: number } | null {
    return this.senser.itemTables(world);
  }

  get filler(): WasmFiller {
    return this.resident!.filler;
  }

  // The kernel memory as floats, where adopted outputs live; read it fresh, as growth replaces it.
  get f32(): Float32Array {
    return this.brains.f32;
  }

  // Gives a resident creature (see ResidentStore) its brain slot and tells its row where the kernels find it. Call after each new Creature
  // and each reset; the creature's brain then stays in its slot and a tick needs no per-creature slot work.
  attach(c: Creature): void {
    if (c.kernelOwner !== this) {
      c.kernelOwner = this;
      c.kernelSlot = this.nextSlot++;
    }
    const slot = c.kernelSlot;
    this.brains.set(slot, c.brain.sizes, c.brain.genome);
    this.senser.setOffsets(slot, c);
    this.versions[slot] = c.brainVersion;
    c.adoptOutput(this.brains, this.brains.outputAt(slot));
    const r = c.resident!;
    r.setBrain(slot, c.plan.rayCount, this.senser.offsetsAt(slot), this.brains.inputAt(slot) * 4);
    r.rayLength = c.plan.rayLength;
  }

  run(world: World, crowd: Crowd, batch: SenseBatch, prof: PhaseTimer | null = null): void {
    const n = batch.count;
    if (n === 0) return;
    const { creatures, selves } = batch;
    if (creatures[0]!.resident) {
      // a batch of resident creatures that is not the whole world (Ecosystem.sensePhase passes its row list straight to runRows)
      if (n > this.slots.length) this.slots = new Int32Array(Math.max(n, 2 * this.slots.length));
      const rows = this.slots;
      let detail: Creature | null = null;
      for (let k = 0; k < n; k++) {
        rows[k] = creatures[k]!.resident!.ptr;
        if (creatures[k] === this.detail) detail = this.detail;
      }
      prepareRows(this.resident!.store, rows, n, world.terrain);
      return this.runRows(world, crowd, rows, selves, n, detail, prof);
    }
    if (n > this.slots.length) this.slots = new Int32Array(Math.max(n, 2 * this.slots.length));
    const slots = this.slots;
    const brains = this.brains;
    let at = -1; // index of the detail creature in this batch
    for (let k = 0; k < n; k++) {
      slots[k] = this.slotOf(creatures[k]!);
      if (creatures[k] === this.detail) at = k;
    }
    const detail = at >= 0 ? this.detail : null;
    prof?.lap("slots");
    this.senser.run(world, crowd, n, selves, this.stride, this.energyScale, detail, { creatures, slots });
    prof?.lap("senser");
    brains.forwardSlots(slots, n);
    prof?.lap("brain forward");
    for (let k = 0; k < n; k++) creatures[k]!.adoptOutput(brains, brains.outputAt(slots[k]!));
    prof?.lap("adopt output");
    if (detail) {
      this.senser.readRays(detail, crowd);
      detail.adoptInput(brains.f32, brains.inputAt(slots[at]!));
    }
  }

  // run for resident creatures given as their row addresses and crowd indices, in brain run order: the fill kernel builds the records
  // and brain inputs from the rows, and the slot list of the brain run. detail, when in the batch, gets its rays and input read back.
  runRows(world: World, crowd: Crowd, rows: Int32Array, selves: Int32Array, n: number, detail: Creature | null, prof: PhaseTimer | null = null): void {
    if (n === 0) return;
    const slotsAt = this.brains.runRegion(n);
    prof?.lap("slots");
    this.senser.run(world, crowd, n, selves, this.stride, this.energyScale, detail, { filler: this.filler, rows, slotsAt });
    prof?.lap("senser");
    this.brains.forwardRun(n);
    prof?.lap("brain forward");
    if (detail) {
      this.senser.readRays(detail, crowd);
      detail.adoptInput(this.brains.f32, this.brains.inputAt(detail.kernelSlot));
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
