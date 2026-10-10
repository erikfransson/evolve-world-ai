import { Brain, layerSizes, refit } from "./brain.ts";
import type { EngineConfig } from "./config.ts";
import { consume, decaysFor, settle, stepBody } from "./physics.ts";
import type { Decays, Heading } from "./physics.ts";
import { OUTPUT_SIZE, OUT_THRUST, OUT_TURN, copyPlan, encodeInputs, planOf, planUpkeep, rayAngleOffsets, sameShape, thrustCommand } from "./sensors.ts";
import type { BodyPlan } from "./sensors.ts";
import { HIT_NONE } from "./types.ts";
import type { CreatureState, Genome, HitKind, RayHit } from "./types.ts";
import { RayCache } from "./world.ts";
import type { World } from "./world.ts";
import type { Crowd } from "./crowd.ts";

// One creature's body, brain and senses; the world it lives in is passed to each call.
// rays, rayOffsets, memory and brain sizes follow the plan, which only reset changes.
export class Creature {
  readonly state: CreatureState;
  readonly rays: RayHit[] = [];
  rayOffsets = new Float32Array(0); // treat as read-only
  readonly brain: Brain;
  readonly heading: Heading = { cos: 0, sin: 0 };
  readonly plan: BodyPlan; // this creature's own copy; treat as read-only
  memory = new Float64Array(0); // short units first, then long; treat as read-only
  upkeep = 0; // energy per second besides thrust and turning, from the plan

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
  constructor(config: EngineConfig, genome: Genome, x: number, y: number, heading: number, plan: BodyPlan = planOf(config)) {
    this.config = config;
    this.plan = { ...plan, hiddenLayers: plan.hiddenLayers.slice() };
    const sizes = layerSizes(config, this.plan);
    this.brain = new Brain(sizes, genome);
    this.decays = decaysFor(config);
    this.fitPlan(sizes);
    this.state = { x, y, heading, vx: 0, vy: 0, turnRate: 0, energy: config.creature.startEnergy, alive: true, ticksAlive: 0 };
    this.heading.cos = Math.cos(heading);
    this.heading.sin = Math.sin(heading);
  }

  // Sizes the per-plan buffers, reusing them when large enough.
  private fitPlan(sizes: readonly number[]): void {
    const plan = this.plan;
    const n = plan.rayCount;
    this.memoryAt = sizes[0]! - plan.memoryShort - plan.memoryLong;
    this.input = refit(this.input, sizes[0]!);
    this.output = refit(this.output, sizes[sizes.length - 1]!);
    this.memory = refit(this.memory, plan.memoryShort + plan.memoryLong);
    this.memory.fill(0);
    this.rayOffsets = refit(this.rayOffsets, n);
    rayAngleOffsets(plan, this.rayOffsets);
    this.rayOffCos = refit(this.rayOffCos, n);
    this.rayOffSin = refit(this.rayOffSin, n);
    for (let i = 0; i < n; i++) {
      this.rayOffCos[i] = Math.cos(this.rayOffsets[i]!);
      this.rayOffSin[i] = Math.sin(this.rayOffsets[i]!);
    }
    this.rayDirX = refit(this.rayDirX, n);
    this.rayDirY = refit(this.rayDirY, n);
    while (this.rays.length < n) this.rays.push({ closeness: 0, kind: HIT_NONE, energy: 0 });
    this.rays.length = n;
    this.upkeep = planUpkeep(plan, this.config);
  }

  // Reuses this creature for a newcomer: copies the genome into its brain and resets body, senses and memory.
  // With a plan, the creature takes it over and genome must be sized for it.
  reset(genome: Genome, x: number, y: number, heading: number, energy: number, plan?: BodyPlan): void {
    if (plan) {
      const reshape = !sameShape(plan, this.plan);
      copyPlan(plan, this.plan);
      if (reshape) this.brain.reshape(layerSizes(this.config, this.plan), genome);
      else this.brain.load(genome);
      this.fitPlan(this.brain.sizes);
    } else {
      this.brain.load(genome);
      this.memory.fill(0);
    }
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
    const length = this.plan.rayLength;
    world.castRays(this.state.x, this.state.y, dirX, dirY, rays, this.cache, length);
    if (crowd) crowd.castRays(this.state.x, this.state.y, dirX, dirY, rays, self, length);
  }

  // Runs the brain on the last sensed rays, the current body and the memory, then updates the memory from its targets.
  think(): void {
    const input = this.input;
    const output = this.output;
    const memory = this.memory;
    encodeInputs(this.state, this.rays, this.config, input, this.heading.cos, this.heading.sin);
    input.set(memory, this.memoryAt);
    this.brain.forward(input, output);
    // Outputs are already tanh-squashed, so each unit relaxes toward tanh of its target's pre-activation.
    const { shortRate, longRate } = this.config.brain;
    const short = this.plan.memoryShort;
    for (let i = 0; i < memory.length; i++) memory[i] += (i < short ? shortRate : longRate) * (output[OUTPUT_SIZE + i] - memory[i]);
  }

  // One tick driven by the brain from the last sensed rays; returns what move returns.
  act(world: World): number {
    this.think();
    return this.move(world, this.output[OUT_TURN], thrustCommand(this.output[OUT_THRUST], this.config.creature.brakeThreshold));
  }

  // Motion and energy costs from the last think, without eating or death; touches only this creature.
  steer(): void {
    stepBody(this.state, this.output[OUT_TURN], thrustCommand(this.output[OUT_THRUST], this.config.creature.brakeThreshold), this.config, this.decays, this.heading, this.upkeep);
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
    stepBody(this.state, turn, thrust, this.config, this.decays, this.heading, this.upkeep);
    const eaten = this.eat(world);
    settle(this.state);
    return eaten;
  }
}
