import { Brain, layerSizes } from "./brain.ts";
import { maxLifeTicks } from "./config.ts";
import type { SimConfig } from "./config.ts";
import { consume, decaysFor, settle, stepBody } from "./physics.ts";
import type { Decays, Heading } from "./physics.ts";
import { createRng, deriveSeed } from "./rng.ts";
import { OUTPUT_SIZE, OUT_THRUST, OUT_TURN, encodeInputs, energySignal, inputSize, rayAngleOffsets } from "./sensors.ts";
import type { FrameRecorder } from "./trajectory.ts";
import { HIT_NONE } from "./types.ts";
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
  private readonly decays: Decays;
  private readonly heading: Heading = { cos: 0, sin: 0 };
  private readonly rayOffCos: Float64Array;
  private readonly rayOffSin: Float64Array;
  private readonly rayDirX: Float64Array;
  private readonly rayDirY: Float64Array;

  constructor(config: SimConfig, genome: Genome, layoutSeed: number, creatureIndex: number) {
    this.config = config;
    this.world = new World(config, createRng(layoutSeed), createRng(deriveSeed(layoutSeed, creatureIndex)));
    this.brain = new Brain(layerSizes(config), genome);
    this.input = new Float32Array(inputSize(config));
    this.output = new Float32Array(OUTPUT_SIZE);
    this.rayOffsets = rayAngleOffsets(config);
    this.rayOffCos = Float64Array.from(this.rayOffsets, Math.cos);
    this.rayOffSin = Float64Array.from(this.rayOffsets, Math.sin);
    this.rayDirX = new Float64Array(config.creature.rayCount);
    this.rayDirY = new Float64Array(config.creature.rayCount);
    this.maxTicks = maxLifeTicks(config);
    this.decays = decaysFor(config);
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
    this.heading.cos = Math.cos(this.state.heading);
    this.heading.sin = Math.sin(this.state.heading);
  }

  get done(): boolean {
    return !this.state.alive || this.state.ticksAlive >= this.maxTicks;
  }

  step(): void {
    if (this.done) return;
    const { creature: c, world: w } = this.config;
    const s = this.state;
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
    this.world.castRays(s.x, s.y, dirX, dirY, rays);
    encodeInputs(s, rays, this.config, this.input, hc, hs);

    this.brain.forward(this.input, this.output);
    const thrust = Math.max(0, this.output[OUT_THRUST]);

    stepBody(s, this.output[OUT_TURN], thrust, this.config, this.decays, this.heading);
    consume(s, this.world.eatAt(s.x, s.y, c.radius), w.foodEnergy);
    settle(s);
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
