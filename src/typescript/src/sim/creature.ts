import { Brain, layerSizes } from "./brain.ts";
import type { SimConfig } from "./config.ts";
import { consume, decaysFor, settle, stepBody } from "./physics.ts";
import type { Decays, Heading } from "./physics.ts";
import { OUTPUT_SIZE, OUT_THRUST, OUT_TURN, encodeInputs, inputSize, rayAngleOffsets } from "./sensors.ts";
import { HIT_NONE } from "./types.ts";
import type { CreatureState, Genome, HitKind, RayHit } from "./types.ts";
import { RayCache } from "./world.ts";
import type { World } from "./world.ts";

// One creature's body, brain and senses; the world it lives in is passed to each call.
export class Creature {
  readonly state: CreatureState;
  readonly rays: RayHit[];
  readonly rayOffsets: Float32Array;
  readonly brain: Brain;
  readonly heading: Heading = { cos: 0, sin: 0 };

  private readonly config: SimConfig;
  private readonly input: Float32Array;
  private readonly output: Float32Array;
  private readonly decays: Decays;
  private readonly rayOffCos: Float64Array;
  private readonly rayOffSin: Float64Array;
  private readonly rayDirX: Float64Array;
  private readonly rayDirY: Float64Array;
  private readonly cache = new RayCache();

  constructor(config: SimConfig, genome: Genome, x: number, y: number, heading: number) {
    this.config = config;
    this.brain = new Brain(layerSizes(config), genome);
    this.input = new Float32Array(inputSize(config));
    this.output = new Float32Array(OUTPUT_SIZE);
    this.rayOffsets = rayAngleOffsets(config);
    this.rayOffCos = Float64Array.from(this.rayOffsets, Math.cos);
    this.rayOffSin = Float64Array.from(this.rayOffsets, Math.sin);
    this.rayDirX = new Float64Array(config.creature.rayCount);
    this.rayDirY = new Float64Array(config.creature.rayCount);
    this.decays = decaysFor(config);
    this.rays = [];
    for (let i = 0; i < config.creature.rayCount; i++) this.rays.push({ closeness: 0, kind: HIT_NONE });
    this.state = { x, y, heading, vx: 0, vy: 0, turnRate: 0, energy: config.creature.startEnergy, alive: true, ticksAlive: 0 };
    this.heading.cos = Math.cos(heading);
    this.heading.sin = Math.sin(heading);
  }

  // Casts the rays from the current pose into this.rays without advancing the simulation.
  sense(world: World): void {
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
    world.castRays(this.state.x, this.state.y, dirX, dirY, rays, this.cache);
  }

  // One tick driven by the brain from the last sensed rays; returns what move returns.
  act(world: World): number {
    encodeInputs(this.state, this.rays, this.config, this.input, this.heading.cos, this.heading.sin);
    this.brain.forward(this.input, this.output);
    return this.move(world, this.output[OUT_TURN], Math.max(0, this.output[OUT_THRUST]));
  }

  // One tick of motion, eating and energy. Returns the index of the item eaten, still in the world for the caller to move or remove, or -1.
  move(world: World, turn: number, thrust: number): number {
    const s = this.state;
    stepBody(s, turn, thrust, this.config, this.decays, this.heading);
    const eaten = world.eatAt(s.x, s.y, this.config.creature.radius, this.cache);
    consume(s, eaten < 0 ? HIT_NONE : (world.kinds[eaten] as HitKind), this.config.world.foodEnergy);
    settle(s);
    return eaten;
  }
}
