import type { Brain } from "./brain.ts";
import { itemCounts, maxLifeTicks } from "./config.ts";
import type { SimConfig } from "./config.ts";
import { Creature } from "./creature.ts";
import { createRng, deriveSeed } from "./rng.ts";
import { OUT_THRUST, OUT_TURN, energySignal, thrustCommand } from "./sensors.ts";
import type { FrameRecorder } from "./trajectory.ts";
import type { CreatureState, EpisodeView, Genome, HitKind, RayHit, Rng } from "./types.ts";
import { World } from "./world.ts";
import { MAX_BRAIN_SIZES, MAX_LAYER_NEURONS, WasmBrainBank } from "./wasm/brainKernel.ts";

const CLEAR_MARGIN = 10; // world units kept free of items around the start point
const CLEAR_MAX_SHARE = 0.35; // of the shorter world side, so small worlds keep room for poison

// Radius around the start point where no poison is placed.
export function poisonClearRadius(config: SimConfig): number {
  const { width, height, itemRadius, poisonClearRadius: wanted } = config.world;
  const touching = config.creature.radius + itemRadius + CLEAR_MARGIN;
  return Math.max(touching, Math.min(wanted, CLEAR_MAX_SHARE * Math.min(width, height)));
}

const DISTANCE_BONUS = 1e-6; // fitness seconds per world unit travelled (1e-3 s per 1000 units), far below one tick; ranks movers above stand-stills with equal lifetimes

// The brain runs on the WebAssembly kernel when available (false keeps the JS path). Senses and motion stay in JS: the batch kernels of the
// Ecosystem cost more per call than they save for one creature. The kernel sums in f32, so fitness differs slightly from the JS path, but each
// episode depends only on its own inputs, so results are the same in Node and every browser and for any thread count.
export const TRIALS_WASM = true;

// One bank per thread, reused by successive runEpisode calls; an Episode made directly gets its own, so a replay and a preview can live side by side.
let spareBank: WasmBrainBank | null = null;
const SLOT = new Int32Array(1); // the run list: slot 0

// Whether the brain kernel takes a brain of these layer sizes; a larger one runs on the JS path.
const fitsKernel = (sizes: readonly number[]): boolean => sizes.length <= MAX_BRAIN_SIZES && sizes.every((n) => n <= MAX_LAYER_NEURONS);

// One creature alone in its own world copy.
export class Episode implements EpisodeView {
  readonly creature: Creature;
  readonly world: World;
  readonly state: CreatureState;
  readonly rays: RayHit[];
  readonly rayOffsets: Float32Array;
  readonly brain: Brain;

  private readonly config: SimConfig;
  private readonly maxTicks: number;
  private readonly respawnRng: Rng;
  private travelled = 0;
  private readonly bank: WasmBrainBank | null;
  private readonly view: boolean;
  private viewOutput: Float32Array | null = null;
  private f32: Float32Array | null = null; // the bank's memory
  private inputAt = 0;
  private outputAt = 0;

  // view keeps every brain layer current for drawing (a replay), which the kernel does not. bank: the brain kernel to run on (the
  // caller owns it, one Episode at a time; its slot 0 is set here), null for the JS path; by default a new one when available.
  constructor(config: SimConfig, genome: Genome, layoutSeed: number, creatureIndex: number, view = true, bank: WasmBrainBank | null | undefined = undefined) {
    this.config = config;
    const counts = itemCounts(config);
    this.world = new World(config, counts.food + counts.poison);
    const { width, height } = config.world;
    const start = this.world.terrain.nearestFree(width / 2, height / 2, config.creature.radius); // the centre, or the nearest spot clear of rock
    const clear = { ...start, radius: poisonClearRadius(config) };
    this.world.scatter(counts.food, counts.poison, createRng(layoutSeed), clear);
    this.respawnRng = createRng(deriveSeed(layoutSeed, creatureIndex));
    const heading = createRng(deriveSeed(layoutSeed, 0x5eed)).next() * 2 * Math.PI;
    this.creature = new Creature(config, genome, clear.x, clear.y, heading);
    this.maxTicks = maxLifeTicks(config);
    this.state = this.creature.state;
    this.rays = this.creature.rays;
    this.rayOffsets = this.creature.rayOffsets;
    this.brain = this.creature.brain;
    this.view = view;
    const given = !TRIALS_WASM ? null : bank === undefined ? WasmBrainBank.createSync() : bank;
    this.bank = given && fitsKernel(this.brain.sizes) ? given : null;
    if (this.bank) {
      this.bank.set(0, this.brain.sizes, genome); // replaces the previous episode's brain, inputs and outputs zeroed
      this.bank.fixRun(SLOT, 1);
      // Nothing allocates in the bank until the episode ends, so its memory, and these views of it, stay put.
      this.f32 = this.bank.f32;
      this.inputAt = this.bank.inputAt(0);
      this.outputAt = this.bank.outputAt(0);
      this.creature.adoptOutput({ f32: this.f32 }, this.outputAt);
    }
  }

  get done(): boolean {
    return !this.state.alive || this.state.ticksAlive >= this.maxTicks;
  }

  // Casts the rays from the current pose into this.rays without advancing the simulation.
  sense(): void {
    this.creature.sense(this.world);
  }

  step(): void {
    if (this.done) return;
    this.creature.sense(this.world);
    const { x, y } = this.state;
    const eaten = this.bank ? this.actOnKernel() : this.creature.act(this.world);
    this.travelled += Math.hypot(this.state.x - x, this.state.y - y);
    if (eaten < 0) return;
    // An eaten item respawns elsewhere or is gone for good.
    if (this.config.world.respawn) this.world.placeRandomly(eaten, this.world.kinds[eaten] as HitKind,this.respawnRng);
    else this.world.removeItem(eaten);
  }

  // Creature.act with the brain on the kernel.
  private actOnKernel(): number {
    const c = this.creature;
    const input = c.encode();
    const f32 = this.f32!;
    f32.set(input, this.inputAt);
    this.bank!.forwardFixed();
    if (this.view) c.brain.forward(input, (this.viewOutput ??= new Float32Array(c.outputs.length))); // display only
    c.remember();
    const at = this.outputAt;
    return c.move(this.world, f32[at + OUT_TURN]!, thrustCommand(f32[at + OUT_THRUST]!, this.config.creature.brakeThreshold));
  }

  fitness(): number {
    const { dt, creature: c } = this.config;
    return this.state.ticksAlive * dt + energySignal(this.state.energy, c.startEnergy) * dt + this.travelled * DISTANCE_BONUS;
  }
}

// Runs the episode to its end and returns its fitness, recording every frame too when given a recorder.
export function runEpisode(config: SimConfig, genome: Genome, layoutSeed: number, creatureIndex: number, recorder?: FrameRecorder): number {
  const bank = TRIALS_WASM ? (spareBank ?? WasmBrainBank.createSync()) : null;
  spareBank = null; // taken until this episode ends
  const episode = new Episode(config, genome, layoutSeed, creatureIndex, false, bank);
  if (recorder) {
    recorder.push(episode.state);
    while (!episode.done) {
      episode.step();
      recorder.push(episode.state);
    }
    recorder.endCreature();
  } else {
    while (!episode.done) episode.step();
  }
  spareBank = bank;
  return episode.fitness();
}
