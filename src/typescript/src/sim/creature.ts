import { Brain, layerSizes, refit } from "./brain.ts";
import type { EngineConfig } from "./config.ts";
import { agingFactor, consume, decaysFor, settle, stepBody } from "./physics.ts";
import type { Aging, Decays, Heading } from "./physics.ts";
import { EXTRA_TERRAIN, energySignal, OUTPUT_SIZE, OUT_THRUST, OUT_TURN, copyPlan, encodeInputs, planOf, planUpkeep, rayAngleOffsets, thrustCommand } from "./sensors.ts";
import type { BodyPlan, PlanView } from "./sensors.ts";
import { HIT_NONE } from "./types.ts";
import type { CreatureState, Genome, HitKind, RayHit } from "./types.ts";
import { Terrain, terrainOf } from "./terrain.ts";
import { RayCache } from "./world.ts";
import type { World } from "./world.ts";
import type { Crowd } from "./crowd.ts";
import type { SenseKernels } from "./wasm/senseKernels.ts";
import type { ResidentState, ResidentStore } from "./wasm/resident.ts";
import type { PhaseTimer } from "./profile.ts";

let created = 0; // objects made so far in this process

// Ray directions of the creature being sensed, shared by all creatures since a sense is one synchronous call.
let dirX = new Float64Array(64);
let dirY = new Float64Array(64);
// Never used for lookups, only so touched() has a cache to pass before the creature has sensed on the JS path.
const IDLE_CACHE = new RayCache();

// One creature's body, brain and senses; the world it lives in is passed to each call.
// rays, rayOffsets, memory and brain sizes follow the plan, which only reset changes.
export class Creature {
  readonly state: CreatureState;
  readonly resident: ResidentState | null; // the state and heading when the body lives in WASM memory (stepped by the kernel), else null
  readonly slot = created++; // construction order, which follows heap order; SenseBatch sorts by it
  private rayList: RayHit[] | null = null; // made on first use, since the WebAssembly sense only fills the detail creature's
  readonly brain: Brain;
  readonly heading: Heading;
  aging: Aging | null = null; // old-age upkeep, set by the owner
  brainVersion = 0; // bumped whenever reset changes the genome or plan, so a copy of the brain elsewhere (WASM) knows to refresh
  kernelSlot = -1; // this creature's brain slot in kernelOwner, the SenseKernels that last ran it
  kernelOwner: SenseKernels | null = null;

  private readonly ownPlan: BodyPlan; // this creature's own copy
  private offsets = new Float32Array(0);
  private ownUnits = new Float64Array(0);
  private energyUpkeep = 0;
  private readonly config: EngineConfig;
  private readonly terrain: Terrain;
  private groundX = NaN; // the ground value last read and where, so sensing and moving from one spot read it once
  private groundY = NaN;
  private groundValue = 0;
  private readonly decays: Decays;
  private input = new Float32Array(0);
  private output = new Float32Array(0);
  private outBank: { readonly f32: Float32Array } | null = null; // a WASM kernel's memory holding the outputs at outAt, else this.output; looked up at each read, as memory growth replaces the array
  private outAt = 0;
  private memoryAt = 0;
  private rayOffCos = new Float64Array(0); // built by the JS sense path only
  private rayOffSin = new Float64Array(0);
  private trigFresh = false;
  private inputLength = 0;
  private cache: RayCache | null = null; // made by the JS sense path only

  // plan defaults to the config's; genome must be sized for it. With a store the body is a resident row of it.
  constructor(config: EngineConfig, genome: Genome, x: number, y: number, heading: number, plan: PlanView = planOf(config), store: ResidentStore | null = null) {
    this.config = config;
    const res = (this.resident = store ? store.add() : null);
    this.heading = res ?? { cos: 0, sin: 0 };
    if (res) res.params = store!.block(config);
    this.terrain = terrainOf(config);
    this.ownPlan = { ...plan, hiddenLayers: plan.hiddenLayers.slice() };
    const sizes = layerSizes(config, this.ownPlan);
    this.brain = new Brain(sizes, genome);
    this.decays = decaysFor(config);
    this.fitPlan(sizes);
    this.state = res ?? { x, y, heading, vx: 0, vy: 0, turnRate: 0, energy: config.creature.startEnergy, alive: true, ticksAlive: 0 };
    if (res) {
      res.x = x;
      res.y = y;
      res.heading = heading;
      res.energy = config.creature.startEnergy;
      res.groundFactor = 1;
    }
    this.heading.cos = Math.cos(heading);
    this.heading.sin = Math.sin(heading);
  }

  // One hit per ray, as of the last sense on the JS path (or as detail on the WebAssembly path).
  get rays(): RayHit[] {
    if (!this.rayList) {
      this.rayList = [];
      this.fitRays();
    }
    return this.rayList;
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

  private get units(): Float64Array {
    return this.resident ? this.resident.units : this.ownUnits;
  }

  // The terrain value under the creature (0 on a map without ground), read again only after it moved.
  private ground(): number {
    const s = this.state;
    if (s.x !== this.groundX || s.y !== this.groundY) {
      this.groundX = s.x;
      this.groundY = s.y;
      this.groundValue = this.terrain.empty ? 0 : this.terrain.valueAt(s.x, s.y);
    }
    return this.groundValue;
  }

  // Writes the brain input that does not come from rays (extras, then memory units) at f32[at], where at is the first extra's index.
  writeBodyInputs(f32: Float32Array, at: number): void {
    const c = this.config.creature;
    const s = this.state;
    const cos = this.heading.cos;
    const sin = this.heading.sin;
    f32[at] = energySignal(s.energy, c.startEnergy);
    f32[at + 1] = ((s.vx * cos + s.vy * sin) * c.drag) / c.maxThrust;
    f32[at + 2] = ((s.vy * cos - s.vx * sin) * c.drag) / c.maxThrust;
    f32[at + 3] = s.turnRate / c.maxTurnRate;
    const ground = this.ground();
    f32[at + EXTRA_TERRAIN] = ground;
    if (this.resident && !this.terrain.empty) this.resident.groundFactor = Terrain.factor(ground); // the step kernel moves by it
    const u = this.units;
    for (let i = 0; i < u.length; i++) f32[at + EXTRA_TERRAIN + 1 + i] = u[i]!;
  }

  // Energy per second besides thrust and turning, from the plan.
  get upkeep(): number {
    return this.energyUpkeep;
  }

  // Energy per second right now: upkeep with old age, plus thrust and turning as of the last tick.
  get drain(): number {
    const c = this.config.creature;
    const thrust = Math.max(0, thrustCommand(this.outView()[this.outAt + OUT_THRUST] ?? 0, c.brakeThreshold));
    return this.energyUpkeep * agingFactor(this.aging, this.state.ticksAlive) + c.thrustCost * thrust + (c.turnCost * Math.abs(this.state.turnRate)) / c.maxTurnRate;
  }

  // Sizes the per-plan buffers, reusing them when large enough.
  private fitPlan(sizes: readonly number[]): void {
    const plan = this.ownPlan;
    const n = plan.rayCount;
    this.memoryAt = sizes[0]! - plan.memoryShort - plan.memoryLong;
    this.inputLength = sizes[0]!;
    this.input = this.input.length === 0 ? this.input : refit(this.input, this.inputLength); // an input buffer exists once encode or adoptInput needs one
    this.output = refit(this.output, sizes[sizes.length - 1]!);
    this.outBank = null;
    this.outAt = 0;
    if (this.resident) this.resident.fitUnits(plan.memoryShort + plan.memoryLong, plan.memoryShort);
    else {
      this.ownUnits = refit(this.ownUnits, plan.memoryShort + plan.memoryLong);
      this.ownUnits.fill(0);
    }
    this.offsets = refit(this.offsets, n);
    rayAngleOffsets(plan, this.offsets);
    this.trigFresh = false;
    if (this.rayList) this.fitRays();
    this.energyUpkeep = planUpkeep(plan, this.config);
    if (this.resident) this.resident.upkeep = this.energyUpkeep;
  }

  private fitRays(): void {
    const list = this.rayList!;
    const n = this.ownPlan.rayCount;
    while (list.length < n) list.push({ closeness: 0, kind: HIT_NONE, energy: 0, species: 0 });
    list.length = n;
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
    if (this.cache) this.cache.version = -1;
    for (const ray of this.rayList ?? []) {
      ray.closeness = 0;
      ray.kind = HIT_NONE;
      ray.energy = 0;
      ray.species = 0;
    }
  }

  // Casts the rays from the current pose into this.rays without advancing the simulation.
  // With a crowd, rays also see the other creatures in it; self is this creature's slot there.
  sense(world: World, crowd?: Crowd, self = -1): void {
    this.senseWorld(world);
    if (crowd) crowd.castRays(this.state.x, this.state.y, dirX, dirY, this.rays, self, this.ownPlan.rayLength);
  }

  // The part of sense before the crowd: ray directions from the pose, then items and walls.
  senseWorld(world: World): void {
    const rays = this.rays;
    // Ray directions by angle addition from the heading's cos/sin.
    const hc = this.heading.cos;
    const hs = this.heading.sin;
    if (!this.trigFresh) this.fitTrig();
    const oc = this.rayOffCos;
    const os = this.rayOffSin;
    if (dirX.length < rays.length) {
      dirX = new Float64Array(rays.length);
      dirY = new Float64Array(rays.length);
    }
    for (let i = 0; i < rays.length; i++) {
      dirX[i] = hc * oc[i] - hs * os[i];
      dirY[i] = hs * oc[i] + hc * os[i];
    }
    const length = this.ownPlan.rayLength;
    world.castRays(this.state.x, this.state.y, dirX, dirY, rays, (this.cache ??= new RayCache()), length);
  }

  // Takes the brain input a WASM kernel built for this creature (f32[at ..]), so encode()'s view of it (what the brain panel shows) is current.
  adoptInput(f32: Float32Array, at: number): void {
    const input = this.inputBuffer();
    input.set(f32.subarray(at, at + input.length));
    this.brain.showInput(input);
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
    return this.outBank === null ? this.output : this.outBank.f32.subarray(this.outAt, this.outAt + this.output.length);
  }

  // The array this creature's outputs live in, given the kernel memory its adopted outputs would be in (saves the bank's getter per creature).
  outputArray(bank: Float32Array | undefined): Float32Array {
    return this.outBank === null ? this.output : (bank ?? this.outBank.f32);
  }

  private outView(): Float32Array {
    return this.outBank === null ? this.output : this.outBank.f32;
  }

  // Reads the outputs of a WASM kernel in place (f32[at ..]) instead of copying them, until the next decide or adoptOutput.
  adoptOutput(bank: { readonly f32: Float32Array }, at: number): void {
    this.outBank = bank;
    this.outAt = at;
    if (this.resident) this.resident.outPtr = at * 4;
  }

  // Overwrites the memory units with from[at ..], e.g. with a coordinator's published values.
  setMemory(from: ArrayLike<number>, at: number): void {
    const memory = this.units;
    for (let i = 0; i < memory.length; i++) memory[i] = from[at + i]!;
  }

  // The brain on the last sensed rays, the current body and the memory, into outputs.
  private decide(): void {
    this.outBank = null;
    this.outAt = 0;
    this.brain.forward(this.encode(), this.output);
  }

  private inputBuffer(): Float32Array {
    if (this.input.length !== this.inputLength) this.input = refit(this.input, this.inputLength);
    return this.input;
  }

  // Cosine and sine of the ray offsets, for the JS sense path.
  private fitTrig(): void {
    const n = this.offsets.length;
    this.rayOffCos = refit(this.rayOffCos, n);
    this.rayOffSin = refit(this.rayOffSin, n);
    for (let i = 0; i < n; i++) {
      this.rayOffCos[i] = Math.cos(this.offsets[i]!);
      this.rayOffSin[i] = Math.sin(this.offsets[i]!);
    }
    this.trigFresh = true;
  }

  // The brain's input from the last sensed rays, the body and the memory; also what brain.layerActivations()[0] shows.
  encode(): Float32Array {
    const input = this.inputBuffer();
    encodeInputs(this.state, this.rays, this.config, input, this.heading.cos, this.heading.sin, this.ground());
    input.set(this.units, this.memoryAt);
    this.brain.showInput(input);
    return input;
  }

  // Moves each memory unit toward its target from the last decide.
  // output is the array outputs live in (outView()); a caller doing many creatures passes the kernel's, fetched once.
  remember(output: Float32Array = this.outView()): void {
    const at = this.outAt + OUTPUT_SIZE;
    const memory = this.units;
    // Outputs are already tanh-squashed, so each unit relaxes toward tanh of its target's pre-activation.
    const { shortRate, longRate } = this.config.brain;
    const short = this.ownPlan.memoryShort;
    for (let i = 0; i < memory.length; i++) memory[i] += (i < short ? shortRate : longRate) * (output[at + i] - memory[i]);
  }

  // One tick driven by the brain from the last sensed rays; returns what move returns.
  act(world: World): number {
    this.think();
    return this.move(world, this.outView()[this.outAt + OUT_TURN], thrustCommand(this.outView()[this.outAt + OUT_THRUST], this.config.creature.brakeThreshold));
  }

  // Motion and energy costs from the last think, without eating or death; touches only this creature.
  steer(output: Float32Array = this.outView()): void {
    const upkeep = this.energyUpkeep * agingFactor(this.aging, this.state.ticksAlive);
    stepBody(this.state, output[this.outAt + OUT_TURN], thrustCommand(output[this.outAt + OUT_THRUST], this.config.creature.brakeThreshold), this.config, this.decays, this.heading, upkeep, this.terrain, this.ground());
  }

  // The first item this creature touches at its position, or -1; changes nothing.
  touched(world: World): number {
    const s = this.state;
    return world.eatAt(s.x, s.y, this.config.creature.radius, this.cache ?? IDLE_CACHE);
  }

  // Eats item, an index from touched (or -1), if any. Returns it, still in the world for the caller to move or remove.
  eatItem(world: World, item: number): number {
    consume(this.state, item < 0 ? HIT_NONE : (world.kinds[item] as HitKind), this.config.world.foodEnergy, this.config.world.poisonDamage);
    return item;
  }

  // Eats the first item touched, if any. Returns its index, still in the world for the caller to move or remove, or -1.
  eat(world: World): number {
    return this.eatItem(world, this.touched(world));
  }

  // One tick of motion, eating and energy. Returns what eat returns.
  move(world: World, turn: number, thrust: number): number {
    stepBody(this.state, turn, thrust, this.config, this.decays, this.heading, this.energyUpkeep, this.terrain, this.ground());
    const eaten = this.eat(world);
    settle(this.state);
    return eaten;
  }
}

const KEY_STRIDE = 2 ** 22; // batch positions below this; slot * stride + position stays exact in a double

// Creatures to sense and think for in one tick: creatures[k] sits at crowd index selves[k], k < count. Reused across ticks.
export class SenseBatch {
  readonly creatures: Creature[] = [];
  selves = new Int32Array(64);
  count = 0;
  sorted = false; // already in slot order, so sortBySlot has nothing to do; cleared by clear
  private keys = new Float64Array(64);
  private scratchCreatures: Creature[] = [];
  private scratchSelves = new Int32Array(64);

  clear(): void {
    this.count = 0;
    this.sorted = false;
  }

  // Puts the batch in creature construction order, so the per-creature data (brain weights, ray caches) is read front to back
  // however the list was reordered by deaths and births. Sensing and thinking write only a creature's own data, so results do not depend on it.
  sortBySlot(): void {
    const n = this.count;
    if (n < 2 || this.sorted) return;
    if (this.keys.length < n) this.keys = new Float64Array(Math.max(n, 2 * this.keys.length));
    const keys = this.keys.subarray(0, n);
    const { creatures, selves } = this;
    for (let k = 0; k < n; k++) keys[k] = creatures[k]!.slot * KEY_STRIDE + k;
    keys.sort();
    const sortedCreatures: Creature[] = this.scratchCreatures;
    sortedCreatures.length = n;
    const sortedSelves = this.scratchSelves.length >= n ? this.scratchSelves : (this.scratchSelves = new Int32Array(selves.length));
    for (let j = 0; j < n; j++) {
      const k = keys[j]! % KEY_STRIDE;
      sortedCreatures[j] = creatures[k]!;
      sortedSelves[j] = selves[k]!;
    }
    for (let j = 0; j < n; j++) {
      creatures[j] = sortedCreatures[j]!;
      selves[j] = sortedSelves[j]!;
    }
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
export function senseThinkBatch(world: World, crowd: Crowd, batch: SenseBatch, kernels: SenseKernels | null = null, prof: PhaseTimer | null = null): void {
  batch.sortBySlot();
  prof?.lap("sort batch");
  if (kernels) return kernels.run(world, crowd, batch, prof);
  const { creatures, selves } = batch;
  for (let k = 0; k < batch.count; k++) creatures[k]!.senseThink(world, crowd, selves[k]!);
  prof?.lap("js sense and think");
}
