import type { Creature } from "../creature.ts";
import type { EcoConfig } from "../ecoConfig.ts";
import { inputLayout } from "../sensors.ts";
import { seenEnergyScale, speciesList } from "../species.ts";
import type { Crowd } from "../crowd.ts";
import type { World } from "../world.ts";
import { WasmBrainBank } from "./brainKernel.ts";
import type { PhaseTimer } from "../profile.ts";
import { ResidentStore } from "./resident.ts";
import { MAX_RAYS, WasmSenser } from "./senser.ts";
import { WasmFiller } from "./fillKernel.ts";
import { WasmStepper } from "./stepKernel.ts";

// The WASM kernels of one owner of creatures (an Ecosystem or a helper thread): sense.wat does rays and brain inputs for the whole batch in one call, then the
// brains run in WebAssembly too, and the creatures' bodies are rows of the same memory (ResidentStore), filled, stepped and scanned by kernels of their own.
// Each creature keeps a brain slot here for as long as this owner holds it (creatures are recycled, not dropped), and the slot is set again by attach whenever reset gave
// the creature a new genome or plan. Results are f32 in the crowd rays and the brain, so they differ from the JS path, but each creature's result depends only on its
// own inputs and the item and crowd snapshots, so any split into batches agrees. Without WebAssembly SIMD, or with a kernel missing, there are no kernels and the JS path runs.
export class SenseKernels {
  // The creature whose rays (creature.rays) and brain input must be current after the batch, such as the selected one.
  // Everyone else's RayHit objects are left stale.
  detail: Creature | null = null;
  readonly store: ResidentStore; // where the creatures' bodies live
  readonly stepper: WasmStepper;
  private readonly brains: WasmBrainBank;
  private readonly senser: WasmSenser;
  private readonly filler: WasmFiller;
  private stride: number; // ray features per ray in the brain input
  private energyScale: number; // seen energies are squashed against this, the largest species start energy (speciesEngine's seenEnergyScale)
  private nextSlot = 0;

  private constructor(brains: WasmBrainBank, senser: WasmSenser, store: ResidentStore, filler: WasmFiller, stepper: WasmStepper, config: EcoConfig) {
    this.brains = brains;
    this.senser = senser;
    this.store = store;
    this.filler = filler;
    this.stepper = stepper;
    this.stride = inputLayout(config).rayFeatures;
    this.energyScale = seenEnergyScale(speciesList(config));
  }

  // Null when WebAssembly SIMD is unavailable or disabled, when a kernel does not load, or when creatures may have more than MAX_RAYS rays (maxRays);
  // use the JS path then.
  static create(config: EcoConfig, maxRays = 0): SenseKernels | null {
    if (maxRays > MAX_RAYS) return null;
    const brains = WasmBrainBank.createSync();
    const senser = brains && WasmSenser.create(brains);
    if (!brains || !senser) return null;
    const store = new ResidentStore(brains);
    const filler = WasmFiller.create(store);
    const stepper = WasmStepper.create(store);
    return filler && stepper ? new SenseKernels(brains, senser, store, filler, stepper, config) : null;
  }

  // Back to the state of a new SenseKernels for this config, so successive Ecosystems on one thread can share the instances
  // (RL builds one per episode). Results are bit-identical to fresh kernels. One owner at a time; creatures of the previous owner must be gone.
  // Resident rows are forgotten here, but the previous owner's ResidentStates still point at the same memory, which the new owner reuses:
  // they must not be read or written after this.
  reset(config: EcoConfig): this {
    this.brains.reset();
    this.senser.reset();
    this.store.reset();
    this.filler.reset();
    this.stepper.reset();
    this.nextSlot = 0;
    this.detail = null;
    this.stride = inputLayout(config).rayFeatures;
    this.energyScale = seenEnergyScale(speciesList(config));
    return this;
  }

  // The item tables the step kernel looks items up in, or null when stale (see WasmSenser.itemTables).
  itemTables(world: World): { start: number; xy: number; ids: number; cols: number } | null {
    return this.senser.itemTables(world);
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
    c.adoptOutput(this.brains, this.brains.outputAt(slot));
    const r = c.resident!;
    r.setBrain(slot, c.plan.rayCount, this.senser.offsetsAt(slot), this.brains.inputAt(slot) * 4);
    r.rayLength = c.plan.rayLength;
  }

  // run for resident creatures given as their row addresses and crowd indices, in brain run order: the fill kernel builds the records
  // and brain inputs from the rows, and the slot list of the brain run. detail, when in the batch, gets its rays and input read back.
  runRows(world: World, crowd: Crowd, rows: Int32Array, selves: Int32Array, n: number, detail: Creature | null, prof: PhaseTimer | null = null): void {
    if (n === 0) return;
    const slotsAt = this.brains.runRegion(n);
    prof?.lap("slots");
    this.senser.run(world, crowd, n, selves, this.stride, this.energyScale, detail, this.filler, rows, slotsAt);
    prof?.lap("senser");
    this.brains.forwardRun(n);
    prof?.lap("brain forward");
    if (detail) {
      this.senser.readRays(detail, crowd);
      detail.adoptInput(this.brains.f32, this.brains.inputAt(detail.kernelSlot));
    }
  }
}
