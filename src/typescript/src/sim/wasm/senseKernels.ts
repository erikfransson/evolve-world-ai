import type { Creature } from "../creature.ts";
import type { Genome } from "../types.ts";
import type { EcoConfig } from "../ecoConfig.ts";
import { inputLayout } from "../sensors.ts";
import { seenEnergyScale, speciesList } from "../species.ts";
import type { Crowd } from "../crowd.ts";
import type { Terrain } from "../terrain.ts";
import type { World } from "../world.ts";
import { WasmBrainBank } from "./brainKernel.ts";
import type { PhaseTimer } from "../profile.ts";
import { ResidentStore } from "./resident.ts";
import { MAX_RAYS, WasmSenser } from "./senser.ts";
import { WasmFiller } from "./fillKernel.ts";
import { WasmStepper } from "./stepKernel.ts";

// The WASM kernels of one owner of creatures (an Ecosystem or a helper thread): sense.wat does rays and brain inputs for the whole batch in one call, then the
// brains run in WebAssembly too, and the creatures' bodies are rows of the same memory (ResidentStore), filled, stepped and scanned by kernels of their own.
// Each creature keeps a brain slot here for as long as this owner holds it, and the slot is set again by attach whenever reset gave the creature a new genome or plan;
// a creature dropped for good gives its slot and row back (release) for the next one made. Results are f32 in the crowd rays and the brain, so they differ from the JS path, but each creature's result depends only on its
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
  private sameStart!: boolean; // every species starts with the energyScale, so a creature's own energy signal is the one the crowd kernel packs for others
  private energyScale!: number; // seen energies are squashed against this, the largest species start energy (speciesEngine's seenEnergyScale)
  private nextSlot = 0;
  private readonly freeSlots: number[] = []; // released slots, taken by attach before new ones
  private readonly owners: (Creature | undefined)[] = []; // the creature holding each slot, whose brain addresses a block move (compact() or a slide inside set()) changes

  private constructor(brains: WasmBrainBank, senser: WasmSenser, store: ResidentStore, filler: WasmFiller, stepper: WasmStepper, config: EcoConfig) {
    this.brains = brains;
    this.senser = senser;
    this.store = store;
    this.filler = filler;
    this.stepper = stepper;
    this.stride = inputLayout(config).rayFeatures;
    this.setScale(config);
    brains.onMove = (slot) => this.bindBrain(this.owners[slot]!, slot);
  }

  private setScale(config: EcoConfig): void {
    const species = speciesList(config);
    this.energyScale = seenEnergyScale(species);
    this.sameStart = species.every((s) => s.startEnergy === this.energyScale);
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
    this.freeSlots.length = 0;
    this.owners.length = 0;
    this.detail = null;
    this.stride = inputLayout(config).rayFeatures;
    this.setScale(config);
    return this;
  }

  // Whether the crowd kernel's pack stores each creature's own energy signal into its row (run's last argument), else the fill kernel's prepare does.
  private packsOwnSignal(crowd: Crowd): boolean {
    return this.sameStart && crowd.kernel !== null;
  }

  // The body inputs of the rows (see WasmFiller.prepare), with the energy signal unless the crowd kernel packs it.
  prepareRows(rows: Int32Array, n: number, terrain: Terrain, crowd: Crowd): void {
    this.filler.prepare(rows, n, terrain, !this.packsOwnSignal(crowd));
  }

  // The item tables the step kernel looks items up in, or null when stale (see WasmSenser.itemTables).
  itemTables(world: World): { start: number; xy: number; ids: number; cols: number } | null {
    return this.senser.itemTables(world);
  }

  // The kernel memory as floats, where adopted outputs live; read it fresh, as growth replaces it.
  get f32(): Float32Array {
    return this.brains.f32;
  }

  // The creature's brain input vector in kernel memory (a view; read it fresh, growth replaces the memory).
  inputOf(c: Creature): Float32Array {
    const at = this.brains.inputAt(c.kernelSlot);
    return this.brains.f32.subarray(at, at + c.brain.sizes[0]!);
  }

  // Gives a resident creature (see ResidentStore) its brain slot and tells its row where the kernels find it. The Creature calls it when made and on each
  // reset; the creature's brain then stays in its slot and a tick needs no per-creature slot work.
  attach(c: Creature, genome: Genome = c.brain.genome, sizes: readonly number[] = c.brain.sizes): void {
    if (c.kernelOwner !== this) {
      c.kernelOwner = this;
      c.kernelSlot = this.freeSlots.pop() ?? this.nextSlot++;
    }
    const slot = c.kernelSlot;
    this.brains.set(slot, sizes, genome, Math.min(c.plan.rayCount * this.stride, sizes[0]!));
    c.brain.lendTo(this.brains, slot, sizes, genome); // the block now holds the weights
    this.senser.setOffsets(slot, c);
    this.owners[slot] = c;
    this.bindBrain(c, slot);
    c.resident!.rayLength = c.plan.rayLength;
  }

  // Points the creature and its row at the slot's brain input and output.
  private bindBrain(c: Creature, slot: number): void {
    c.adoptOutput(this.brains, this.brains.outputAt(slot));
    c.resident!.setBrain(slot, c.plan.rayCount, this.senser.offsetsAt(slot), this.brains.inputAt(slot) * 4);
  }

  // Frees what a creature that is dropped (not kept for reuse) holds here, its brain block, offset table and row, and keeps its slot and row for the next creature.
  release(c: Creature): void {
    if (c.kernelOwner !== this) return;
    const slot = c.kernelSlot;
    c.brain.own(); // before the block goes
    this.brains.release(slot);
    this.owners[slot] = undefined;
    this.senser.release(slot);
    this.freeSlots.push(slot);
    c.kernelOwner = null;
    c.kernelSlot = -1;
    if (c.resident) this.store.release(c.resident);
  }

  // run for resident creatures given as their row addresses and crowd indices, in brain run order: the fill kernel builds the records
  // and brain inputs from the rows, and the slot list of the brain run. detail, when in the batch, gets its rays and input read back.
  runRows(world: World, crowd: Crowd, rows: Int32Array, selves: Int32Array, n: number, detail: Creature | null, prof: PhaseTimer | null = null): void {
    if (n === 0) return;
    this.brains.compact();
    const slotsAt = this.brains.runRegion(n);
    prof?.lap("slots");
    this.senser.run(world, crowd, n, selves, this.stride, this.energyScale, detail, this.filler, rows, slotsAt, this.packsOwnSignal(crowd));
    prof?.lap("senser");
    this.brains.forwardRun(n);
    prof?.lap("brain forward");
    if (detail) {
      this.senser.readRays(detail, crowd);
      detail.adoptInput(this.brains.f32, this.brains.inputAt(detail.kernelSlot));
    }
  }
}
