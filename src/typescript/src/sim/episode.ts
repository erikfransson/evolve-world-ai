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
      vx: 0,
      vy: 0,
      turnRate: 0,
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
    const base = rays.length * RAY_FEATURES;
    input[base] = s.energy / c.maxEnergy;
    input[base + 1] = ((s.vx * Math.cos(s.heading) + s.vy * Math.sin(s.heading)) * c.drag) / c.maxThrust;
    input[base + 2] = s.turnRate / c.maxTurnRate;

    this.brain.forward(input, this.output);
    const thrust = Math.max(0, this.output[1]);

    // Exact exponential relaxation each tick keeps motion smooth and independent of dt.
    const targetTurn = this.output[0] * c.maxTurnRate;
    s.turnRate = targetTurn + (s.turnRate - targetTurn) * Math.exp(-c.turnDamping * dt);
    s.heading += s.turnRate * dt;

    const cos = Math.cos(s.heading);
    const sin = Math.sin(s.heading);
    const terminal = (thrust * c.maxThrust) / c.drag;
    const fwd = terminal + (s.vx * cos + s.vy * sin - terminal) * Math.exp(-c.drag * dt);
    const side = (-s.vx * sin + s.vy * cos) * Math.exp(-c.sideDrag * dt);
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
