import { Brain, layerSizes, refit } from "./brain.ts";
import type { EngineConfig } from "./config.ts";
import { agingFactor, consume, decaysFor, settle, stepBody } from "./physics.ts";
import type { Aging, Decays, Heading } from "./physics.ts";
import { OUTPUT_SIZE, OUT_THRUST, OUT_TURN, copyPlan, encodeInputs, planOf, planUpkeep, rayAngleOffsets, thrustCommand } from "./sensors.ts";
import type { BodyPlan, PlanView } from "./sensors.ts";
import { HIT_NONE } from "./types.ts";
import type { CreatureState, Genome, HitKind, RayHit } from "./types.ts";
import { RayCache } from "./world.ts";
import type { World } from "./world.ts";
import type { Crowd } from "./crowd.ts";
import type { WasmRayCaster } from "./wasm/rayKernel.ts";
import type { SenseKernels } from "./wasm/senseKernels.ts";

// One creature's body, brain and senses; the world it lives in is passed to each call.
// rays, rayOffsets, memory and brain sizes follow the plan, which only reset changes.
export class Creature {
  readonly state: CreatureState;
  readonly rays: RayHit[] = [];
  readonly brain: Brain;
  readonly heading: Heading = { cos: 0, sin: 0 };
  aging: Aging | null = null; // old-age upkeep, set by the owner
  brainVersion = 0; // bumped whenever reset changes the genome or plan, so a copy of the brain elsewhere (WASM) knows to refresh
  kernelSlot = -1; // this creature's brain slot in kernelOwner, the SenseKernels that last ran it
  kernelOwner: SenseKernels | null = null;

  private readonly ownPlan: BodyPlan; // this creature's own copy
  private offsets = new Float32Array(0);
  private units = new Float64Array(0);
  private energyUpkeep = 0;
  private readonly config: EngineConfig;
  private readonly decays: Decays;
  private input = new Float32Array(0);
  private output = new Float32Array(0);
  private memoryAt = 0;
  private rayOffCos = new Float64Array(0);
  private rayOffSin = new Float64Array(0);
  private rayDirX = new Float64Array(0);
  private rayDirY = new Float64Array(0);
  private readonly cache = new RayCache();

  // plan defaults to the config's; genome must be sized for it.
  constructor(config: EngineConfig, genome: Genome, x: number, y: number, heading: number, plan: PlanView = planOf(config)) {
    this.config = config;
    this.ownPlan = { ...plan, hiddenLayers: plan.hiddenLayers.slice() };
    const sizes = layerSizes(config, this.ownPlan);
    this.brain = new Brain(sizes, genome);
    this.decays = decaysFor(config);
    this.fitPlan(sizes);
    this.state = { x, y, heading, vx: 0, vy: 0, turnRate: 0, energy: config.creature.startEnergy, alive: true, ticksAlive: 0 };
    this.heading.cos = Math.cos(heading);
    this.heading.sin = Math.sin(heading);
  }

  get plan(): PlanView {
    return this.ownPlan;
  }

  get rayOffsets(): Readonly<Float32Array> {
    return this.offsets;
  }

  // Short units first, then long.
  get memory(): Readonly<Float64Array> {
    return this.units;
  }

  // Energy per second besides thrust and turning, from the plan.
  get upkeep(): number {
    return this.energyUpkeep;
  }

  // Sizes the per-plan buffers, reusing them when large enough.
  private fitPlan(sizes: readonly number[]): void {
    const plan = this.ownPlan;
    const n = plan.rayCount;
    this.memoryAt = sizes[0]! - plan.memoryShort - plan.memoryLong;
    this.input = refit(this.input, sizes[0]!);
    this.output = refit(this.output, sizes[sizes.length - 1]!);
    this.units = refit(this.units, plan.memoryShort + plan.memoryLong);
    this.units.fill(0);
    this.offsets = refit(this.offsets, n);
    rayAngleOffsets(plan, this.offsets);
    this.rayOffCos = refit(this.rayOffCos, n);
    this.rayOffSin = refit(this.rayOffSin, n);
    for (let i = 0; i < n; i++) {
      this.rayOffCos[i] = Math.cos(this.offsets[i]!);
      this.rayOffSin[i] = Math.sin(this.offsets[i]!);
    }
    this.rayDirX = refit(this.rayDirX, n);
    this.rayDirY = refit(this.rayDirY, n);
    while (this.rays.length < n) this.rays.push({ closeness: 0, kind: HIT_NONE, energy: 0 });
    this.rays.length = n;
    this.energyUpkeep = planUpkeep(plan, this.config);
  }

  // Reuses this creature for a newcomer: copies the genome into its brain and resets body, senses and memory.
  // With a plan, the creature takes it over; either way genome must be sized for the plan.
  reset(genome: Genome, x: number, y: number, heading: number, energy: number, plan: PlanView = this.ownPlan): void {
    copyPlan(plan, this.ownPlan);
    const sizes = layerSizes(this.config, this.ownPlan);
    this.brain.load(sizes, genome);
    this.fitPlan(sizes);
    this.brainVersion++;
    const s = this.state;
    s.x = x;
    s.y = y;
    s.heading = heading;
    s.vx = 0;
    s.vy = 0;
    s.turnRate = 0;
    s.energy = energy;
    s.alive = true;
    s.ticksAlive = 0;
    this.heading.cos = Math.cos(heading);
    this.heading.sin = Math.sin(heading);
    this.cache.version = -1;
    for (const ray of this.rays) {
      ray.closeness = 0;
      ray.kind = HIT_NONE;
      ray.energy = 0;
    }
  }

  // Casts the rays from the current pose into this.rays without advancing the simulation.
  // With a crowd, rays also see the other creatures in it; self is this creature's slot there.
  sense(world: World, crowd?: Crowd, self = -1): void {
    this.senseWorld(world);
    if (crowd) crowd.castRays(this.state.x, this.state.y, this.rayDirX, this.rayDirY, this.rays, self, this.ownPlan.rayLength);
  }

  // The part of sense before the crowd: ray directions from the pose, then items and walls.
  senseWorld(world: World): void {
    const rays = this.rays;
    // Ray directions by angle addition from the heading's cos/sin.
    const hc = this.heading.cos;
    const hs = this.heading.sin;
    const oc = this.rayOffCos;
    const os = this.rayOffSin;
    const dirX = this.rayDirX;
    const dirY = this.rayDirY;
    for (let i = 0; i < rays.length; i++) {
      dirX[i] = hc * oc[i] - hs * os[i];
      dirY[i] = hs * oc[i] + hc * os[i];
    }
    const length = this.ownPlan.rayLength;
    world.castRays(this.state.x, this.state.y, dirX, dirY, rays, this.cache, length);
  }

  // Queues the crowd part of sense on a WASM caster, after senseWorld; the caster's apply() finishes the rays.
  queueCrowd(caster: WasmRayCaster, self: number): void {
    caster.queue(this.state.x, this.state.y, this.rayDirX, this.rayDirY, this.rays, self, this.ownPlan.rayLength);
  }

  // Runs the brain on the last sensed rays, the current body and the memory, then updates the memory from its targets.
  think(): void {
    this.decide();
    this.remember();
  }

  // Senses, then runs the brain on the result, without changing body or memory: writes rays and outputs only.
  // Ecosystem ticks reach it only through senseThinkBatch.
  senseThink(world: World, crowd: Crowd, self: number): void {
    this.sense(world, crowd, self);
    this.decide();
  }

  // Brain outputs of the last decide: turn, thrust, then one target per memory unit. Writable, so a coordinator can put in a helper's result.
  get outputs(): Float32Array {
    return this.output;
  }

  // Overwrites the memory units with from[at ..], e.g. with a coordinator's published values.
  setMemory(from: ArrayLike<number>, at: number): void {
    const memory = this.units;
    for (let i = 0; i < memory.length; i++) memory[i] = from[at + i]!;
  }

  // The brain on the last sensed rays, the current body and the memory, into outputs.
  private decide(): void {
    this.brain.forward(this.encode(), this.output);
  }

  // The brain's input from the last sensed rays, the body and the memory; also what brain.layerActivations()[0] shows.
  encode(): Float32Array {
    const input = this.input;
    encodeInputs(this.state, this.rays, this.config, input, this.heading.cos, this.heading.sin);
    input.set(this.units, this.memoryAt);
    this.brain.showInput(input);
    return input;
  }

  // Moves each memory unit toward its target from the last decide.
  remember(): void {
    const output = this.output;
    const memory = this.units;
    // Outputs are already tanh-squashed, so each unit relaxes toward tanh of its target's pre-activation.
    const { shortRate, longRate } = this.config.brain;
    const short = this.ownPlan.memoryShort;
    for (let i = 0; i < memory.length; i++) memory[i] += (i < short ? shortRate : longRate) * (output[OUTPUT_SIZE + i] - memory[i]);
  }

  // One tick driven by the brain from the last sensed rays; returns what move returns.
  act(world: World): number {
    this.think();
    return this.move(world, this.output[OUT_TURN], thrustCommand(this.output[OUT_THRUST], this.config.creature.brakeThreshold));
  }

  // Motion and energy costs from the last think, without eating or death; touches only this creature.
  steer(): void {
    const upkeep = this.energyUpkeep * agingFactor(this.aging, this.state.ticksAlive);
    stepBody(this.state, this.output[OUT_TURN], thrustCommand(this.output[OUT_THRUST], this.config.creature.brakeThreshold), this.config, this.decays, this.heading, upkeep);
  }

  // Eats the first item touched, if any. Returns its index, still in the world for the caller to move or remove, or -1.
  eat(world: World): number {
    const s = this.state;
    const eaten = world.eatAt(s.x, s.y, this.config.creature.radius, this.cache);
    consume(s, eaten < 0 ? HIT_NONE : (world.kinds[eaten] as HitKind), this.config.world.foodEnergy);
    return eaten;
  }

  // One tick of motion, eating and energy. Returns what eat returns.
  move(world: World, turn: number, thrust: number): number {
    stepBody(this.state, turn, thrust, this.config, this.decays, this.heading, this.energyUpkeep);
    const eaten = this.eat(world);
    settle(this.state);
    return eaten;
  }
}

// Creatures to sense and think for in one tick: creatures[k] sits at crowd index selves[k], k < count. Reused across ticks.
export class SenseBatch {
  readonly creatures: Creature[] = [];
  selves = new Int32Array(64);
  count = 0;

  clear(): void {
    this.count = 0;
  }

  add(creature: Creature, self: number): void {
    const k = this.count++;
    if (k === this.selves.length) {
      const grown = new Int32Array(2 * k);
      grown.set(this.selves);
      this.selves = grown;
    }
    this.creatures[k] = creature;
    this.selves[k] = self;
  }
}

// Sense and think for a whole batch; writes only each creature's rays and outputs. The one boundary for the per-tick
// creature work, used by Ecosystem.sensePhase and the helper threads (ecoShare.ts). With kernels, the crowd rays and the
// brains run in WebAssembly (f32); every owner of creatures (an Ecosystem, a helper) has its own kernels.
export function senseThinkBatch(world: World, crowd: Crowd, batch: SenseBatch, kernels: SenseKernels | null = null): void {
  if (kernels) return kernels.run(world, crowd, batch);
  const { creatures, selves } = batch;
  for (let k = 0; k < batch.count; k++) creatures[k]!.senseThink(world, crowd, selves[k]!);
}
