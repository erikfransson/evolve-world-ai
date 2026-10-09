import { Brain, inputSize, layerSizes } from "./brain.ts";
import { epochTicks, rayAngleOffsets } from "./config.ts";
import type { SimConfig } from "./config.ts";
import { createRng, deriveSeed } from "./rng.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON, HIT_WALL, OUTPUT_SIZE, RAY_FEATURES } from "./types.ts";
import type { CreatureState, EpisodeView, Genome, RayHit } from "./types.ts";
import { World } from "./world.ts";

// One creature alone in its own world copy.
export class Episode implements EpisodeView {
  readonly state: CreatureState;
  readonly rays: RayHit[];
  readonly world: World;

  private readonly config: SimConfig;
  private readonly brain: Brain;
  private readonly input: Float32Array;
  private readonly output: Float32Array;
  private readonly offsets: Float32Array;
  private readonly maxTicks: number;

  constructor(config: SimConfig, genome: Genome, layoutSeed: number, creatureIndex: number) {
    this.config = config;
    this.world = new World(config, createRng(layoutSeed), createRng(deriveSeed(layoutSeed, creatureIndex)));
    this.brain = new Brain(layerSizes(config), genome);
    this.input = new Float32Array(inputSize(config));
    this.output = new Float32Array(OUTPUT_SIZE);
    this.offsets = rayAngleOffsets(config);
    this.maxTicks = epochTicks(config);
    this.rays = [];
    for (let i = 0; i < config.creature.rayCount; i++) this.rays.push({ closeness: 0, kind: HIT_NONE });
    this.state = {
      x: config.world.width / 2,
      y: config.world.height / 2,
      heading: createRng(deriveSeed(layoutSeed, 0x5eed)).next() * 2 * Math.PI,
      speed: 0,
      energy: config.creature.startEnergy,
      alive: true,
      ticksAlive: 0,
    };
  }

  get done(): boolean {
    return !this.state.alive || this.state.ticksAlive >= this.maxTicks;
  }

  step(): void {
    if (this.done) return;
    const { dt, creature: c, world: w } = this.config;
    const s = this.state;
    const input = this.input;
    const rays = this.rays;

    for (let i = 0; i < rays.length; i++) {
      const ray = rays[i];
      this.world.castRay(s.x, s.y, s.heading + this.offsets[i], ray);
      const k = i * RAY_FEATURES;
      input[k] = ray.closeness;
      input[k + 1] = ray.kind === HIT_FOOD ? 1 : 0;
      input[k + 2] = ray.kind === HIT_POISON ? 1 : 0;
      input[k + 3] = ray.kind === HIT_WALL ? 1 : 0;
    }
    input[rays.length * RAY_FEATURES] = s.energy / c.maxEnergy;

    this.brain.forward(input, this.output);
    s.heading += this.output[0] * c.maxTurnRate * dt;
    const accel = this.output[1] * c.maxAccel;
    s.speed = Math.min(c.maxSpeed, Math.max(0, s.speed + accel * dt));

    const ox = s.x;
    const oy = s.y;
    s.x += Math.cos(s.heading) * s.speed * dt;
    s.y += Math.sin(s.heading) * s.speed * dt;
    s.x = Math.min(w.width - c.radius, Math.max(c.radius, s.x));
    s.y = Math.min(w.height - c.radius, Math.max(c.radius, s.y));
    const moved = Math.hypot(s.x - ox, s.y - oy);

    s.energy -= c.livingCost * dt + c.moveCost * moved + c.accelCost * Math.abs(accel) * dt;

    const eaten = this.world.eatAt(s.x, s.y, c.radius);
    if (eaten === HIT_FOOD) s.energy = Math.min(c.maxEnergy, s.energy + w.foodEnergy);
    else if (eaten === HIT_POISON) s.energy -= w.poisonEnergy;

    if (s.energy <= 0) {
      s.energy = 0;
      s.alive = false;
    } else {
      s.ticksAlive++;
    }
  }

  fitness(): number {
    const { dt, creature: c } = this.config;
    return this.state.ticksAlive * dt + (this.state.energy / c.maxEnergy) * dt;
  }
}

export function runEpisode(config: SimConfig, genome: Genome, layoutSeed: number, creatureIndex: number): number {
  const episode = new Episode(config, genome, layoutSeed, creatureIndex);
  while (!episode.done) episode.step();
  return episode.fitness();
}
