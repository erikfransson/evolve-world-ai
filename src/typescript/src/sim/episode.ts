import type { Brain } from "./brain.ts";
import { itemCounts, maxLifeTicks } from "./config.ts";
import type { SimConfig } from "./config.ts";
import { Creature } from "./creature.ts";
import { createRng, deriveSeed } from "./rng.ts";
import { energySignal } from "./sensors.ts";
import type { FrameRecorder } from "./trajectory.ts";
import type { CreatureState, EpisodeView, Genome, HitKind, RayHit, Rng } from "./types.ts";
import { World } from "./world.ts";

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

  constructor(config: SimConfig, genome: Genome, layoutSeed: number, creatureIndex: number) {
    this.config = config;
    const counts = itemCounts(config);
    this.world = new World(config, counts.food + counts.poison);
    this.world.scatter(counts.food, counts.poison, createRng(layoutSeed));
    this.respawnRng = createRng(deriveSeed(layoutSeed, creatureIndex));
    const heading = createRng(deriveSeed(layoutSeed, 0x5eed)).next() * 2 * Math.PI;
    this.creature = new Creature(config, genome, config.world.width / 2, config.world.height / 2, heading);
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
    const eaten = this.creature.act(this.world);
    if (eaten < 0) return;
    // An eaten item respawns elsewhere or is gone for good.
    if (this.config.world.respawn) this.world.placeRandomly(eaten, this.world.kinds[eaten] as HitKind,this.respawnRng);
    else this.world.removeItem(eaten);
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
