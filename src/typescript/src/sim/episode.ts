import type { Brain } from "./brain.ts";
import { itemCounts, maxLifeTicks } from "./config.ts";
import type { SimConfig } from "./config.ts";
import { Creature } from "./creature.ts";
import { createRng, deriveSeed } from "./rng.ts";
import { energySignal } from "./sensors.ts";
import type { FrameRecorder } from "./trajectory.ts";
import type { CreatureState, EpisodeView, Genome, HitKind, RayHit, Rng } from "./types.ts";
import { World } from "./world.ts";

const CLEAR_MARGIN = 10; // world units kept free of items around the start point
const CLEAR_MAX_SHARE = 0.35; // of the shorter world side, so small worlds keep room for poison

// Radius around the start point where no poison is placed.
export function poisonClearRadius(config: SimConfig): number {
  const { width, height, itemRadius, poisonClearRadius: wanted } = config.world;
  const touching = config.creature.radius + itemRadius + CLEAR_MARGIN;
  return Math.max(touching, Math.min(wanted, CLEAR_MAX_SHARE * Math.min(width, height)));
}

const DISTANCE_BONUS = 1e-6; // fitness seconds per world unit travelled (1e-3 s per 1000 units), far below one tick; ranks movers above stand-stills with equal lifetimes

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

  constructor(config: SimConfig, genome: Genome, layoutSeed: number, creatureIndex: number) {
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
    const eaten = this.creature.act(this.world);
    this.travelled += Math.hypot(this.state.x - x, this.state.y - y);
    if (eaten < 0) return;
    // An eaten item respawns elsewhere or is gone for good.
    if (this.config.world.respawn) this.world.placeRandomly(eaten, this.world.kinds[eaten] as HitKind,this.respawnRng);
    else this.world.removeItem(eaten);
  }

  fitness(): number {
    const { dt, creature: c } = this.config;
    return this.state.ticksAlive * dt + energySignal(this.state.energy, c.startEnergy) * dt + this.travelled * DISTANCE_BONUS;
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
