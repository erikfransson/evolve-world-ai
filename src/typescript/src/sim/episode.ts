import { Brain, layerSizes } from "./brain.ts";
import { maxLifeTicks } from "./config.ts";
import type { SimConfig } from "./config.ts";
import { createRng, deriveSeed } from "./rng.ts";
import { OUTPUT_SIZE, OUT_THRUST, OUT_TURN, encodeInputs, energySignal, inputSize, rayAngleOffsets } from "./sensors.ts";
import type { FrameRecorder } from "./trajectory.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON } from "./types.ts";
import type { CreatureState, EpisodeView, Genome, RayHit } from "./types.ts";
import { World } from "./world.ts";

// One creature alone in its own world copy.
export class Episode implements EpisodeView {
  readonly state: CreatureState;
  readonly rays: RayHit[];
  readonly rayOffsets: Float32Array;
  readonly world: World;
  readonly brain: Brain;

  private readonly config: SimConfig;
  private readonly input: Float32Array;
  private readonly output: Float32Array;
  private readonly maxTicks: number;
  // Per-tick decay factors of the exact exponential relaxation, constant for the episode.
  private readonly turnDecay: number;
  private readonly dragDecay: number;
  private readonly sideDecay: number;
  private headCos = 0;
  private headSin = 0;
  private readonly rayOffCos: Float64Array;
  private readonly rayOffSin: Float64Array;

  constructor(config: SimConfig, genome: Genome, layoutSeed: number, creatureIndex: number) {
    this.config = config;
    this.world = new World(config, createRng(layoutSeed), createRng(deriveSeed(layoutSeed, creatureIndex)));
    this.brain = new Brain(layerSizes(config), genome);
    this.input = new Float32Array(inputSize(config));
    this.output = new Float32Array(OUTPUT_SIZE);
    this.rayOffsets = rayAngleOffsets(config);
    this.rayOffCos = Float64Array.from(this.rayOffsets, Math.cos);
    this.rayOffSin = Float64Array.from(this.rayOffsets, Math.sin);
    this.maxTicks = maxLifeTicks(config);
    this.turnDecay = Math.exp(-config.creature.turnDamping * config.dt);
    this.dragDecay = Math.exp(-config.creature.drag * config.dt);
    this.sideDecay = Math.exp(-config.creature.sideDrag * config.dt);
    this.rays = [];
    for (let i = 0; i < config.creature.rayCount; i++) this.rays.push({ closeness: 0, kind: HIT_NONE });
    this.state = {
      x: config.world.width / 2,
      y: config.world.height / 2,
      heading: createRng(deriveSeed(layoutSeed, 0x5eed)).next() * 2 * Math.PI,
      vx: 0,
      vy: 0,
      turnRate: 0,
      energy: config.creature.startEnergy,
      alive: true,
      ticksAlive: 0,
    };
    this.setTrig(this.state.heading);
  }

  private setTrig(heading: number): void {
    this.headCos = Math.cos(heading);
    this.headSin = Math.sin(heading);
  }

  get done(): boolean {
    return !this.state.alive || this.state.ticksAlive >= this.maxTicks;
  }

  step(): void {
    if (this.done) return;
    const { dt, creature: c, world: w } = this.config;
    const s = this.state;
    const rays = this.rays;

    // Ray directions by angle addition from the heading's cos/sin.
    const hc = this.headCos;
    const hs = this.headSin;
    const oc = this.rayOffCos;
    const os = this.rayOffSin;
    for (let i = 0; i < rays.length; i++) this.world.castRayDir(s.x, s.y, hc * oc[i] - hs * os[i], hs * oc[i] + hc * os[i], rays[i]);
    encodeInputs(s, rays, this.config, this.input, hc, hs);

    this.brain.forward(this.input, this.output);
    const thrust = Math.max(0, this.output[OUT_THRUST]);

    // Exact exponential relaxation each tick keeps motion smooth and independent of dt.
    const targetTurn = this.output[OUT_TURN] * c.maxTurnRate;
    s.turnRate = targetTurn + (s.turnRate - targetTurn) * this.turnDecay;
    s.heading += s.turnRate * dt;

    this.setTrig(s.heading); // reused by the next step's rays and inputs
    const cos = this.headCos;
    const sin = this.headSin;
    const terminal = (thrust * c.maxThrust) / c.drag;
    const fwd = terminal + (s.vx * cos + s.vy * sin - terminal) * this.dragDecay;
    const side = (-s.vx * sin + s.vy * cos) * this.sideDecay;
    s.vx = fwd * cos - side * sin;
    s.vy = fwd * sin + side * cos;

    s.x += s.vx * dt;
    s.y += s.vy * dt;
    // Walls absorb the velocity component pointing into them.
    if (s.x < c.radius) { s.x = c.radius; s.vx = Math.max(0, s.vx); }
    else if (s.x > w.width - c.radius) { s.x = w.width - c.radius; s.vx = Math.min(0, s.vx); }
    if (s.y < c.radius) { s.y = c.radius; s.vy = Math.max(0, s.vy); }
    else if (s.y > w.height - c.radius) { s.y = w.height - c.radius; s.vy = Math.min(0, s.vy); }

    s.energy -= (c.livingCost + c.thrustCost * thrust) * dt;

    const eaten = this.world.eatAt(s.x, s.y, c.radius);
    if (eaten === HIT_FOOD) s.energy += w.foodEnergy;
    else if (eaten === HIT_POISON) s.energy = 0; // poison always kills

    if (s.energy <= 0) {
      s.energy = 0;
      s.alive = false;
    } else {
      s.ticksAlive++;
    }
  }

  fitness(): number {
    const { dt, creature: c } = this.config;
    return this.state.ticksAlive * dt + energySignal(this.state.energy, c.startEnergy) * dt;
  }
}

// Runs the episode to its end and returns its fitness, recording every frame too when given a recorder.
export function runEpisode(config: SimConfig, genome: Genome, layoutSeed: number, creatureIndex: number, recorder?: FrameRecorder): number {
  const episode = new Episode(config, genome, layoutSeed, creatureIndex);
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
  return episode.fitness();
}
