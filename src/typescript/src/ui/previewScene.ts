import { Creature } from "../sim/creature.ts";
import type { EngineConfig } from "../sim/config.ts";
import { createRng } from "../sim/rng.ts";
import type { StatefulRng } from "../sim/rng.ts";
import type { PlanView } from "../sim/sensors.ts";
import { inputLayout } from "../sim/sensors.ts";
import type { InputLayout } from "../sim/sensors.ts";
import type { Genome } from "../sim/types.ts";
import { HIT_FOOD, HIT_NONE, HIT_POISON } from "../sim/types.ts";
import { World } from "../sim/world.ts";

// The Arena's design preview scene: a small real room with food and poison, and a creature that is carried along a smooth
// loop (never steered by its brain) so the page shows what its rays see and how its brain reacts.
export const ROOM_W = 720; // 1.5x the first draft: zoomed out so more of the room is in view
export const ROOM_H = 450;
const MARGIN = 46; // the path keeps this far from the walls
export const PERIOD = 30; // seconds per lap
const FOOD_COUNT = 30;
const POISON_COUNT = 18;
const KEEP_AWAY = 70; // a relocated item lands at least this far from the creature

// Figure-eight through the room at time t (seconds): position and heading along the direction of travel.
export function pathAt(t: number, w = ROOM_W, h = ROOM_H): { x: number; y: number; heading: number } {
  const a = (2 * Math.PI * t) / PERIOD;
  const ax = w / 2 - MARGIN;
  const ay = h / 2 - MARGIN;
  const dx = ax * Math.cos(a);
  const dy = 2 * ay * Math.cos(2 * a); // never both zero (cos 2a = -1 where cos a = 0), so the heading is always defined
  return { x: w / 2 + ax * Math.sin(a), y: h / 2 + ay * Math.sin(2 * a), heading: Math.atan2(dy, dx) };
}

export class PreviewScene {
  readonly world: World;
  readonly config: EngineConfig;
  creature!: Creature; // set by setCreature
  layout!: InputLayout;
  t = 0;
  private readonly rng: StatefulRng;
  private output: Float32Array;

  constructor(config: EngineConfig, plan: PlanView, genome: Genome, seed = 7) {
    this.config = { ...config, world: { ...config.world, width: ROOM_W, height: ROOM_H } };
    this.rng = createRng(seed);
    this.world = new World(this.config, FOOD_COUNT + POISON_COUNT);
    for (let i = 0; i < FOOD_COUNT + POISON_COUNT; i++) this.place(i, i < FOOD_COUNT ? HIT_FOOD : HIT_POISON);
    this.output = new Float32Array(inputLayout(this.config, plan).outputs);
    this.setCreature(plan, genome);
  }

  // Another body or brain; the room and the creature's place on its path stay.
  setCreature(plan: PlanView, genome: Genome): void {
    this.creature = new Creature(this.config, genome, 0, 0, 0, plan);
    this.layout = inputLayout(this.config, plan);
    this.output = new Float32Array(this.layout.outputs);
    this.update();
  }

  // Moves on by dt seconds, relocating items the creature has touched, and senses and thinks at the new place.
  step(dt: number): void {
    this.t += dt;
    this.update();
  }

  private place(i: number, kind: typeof HIT_FOOD | typeof HIT_POISON, avoid?: { x: number; y: number }): void {
    const m = 14;
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 20; tries++) {
      x = this.rng.range(m, ROOM_W - m);
      y = this.rng.range(m, ROOM_H - m);
      if (!avoid || Math.hypot(x - avoid.x, y - avoid.y) >= KEEP_AWAY) break;
    }
    this.world.setItem(i, x, y, kind);
  }

  private update(): void {
    const c = this.creature;
    const p = pathAt(this.t);
    const s = c.state;
    s.x = p.x;
    s.y = p.y;
    s.heading = p.heading;
    c.heading.cos = Math.cos(p.heading);
    c.heading.sin = Math.sin(p.heading);
    const touch = this.config.creature.radius + this.world.itemRadius;
    const w = this.world;
    for (let i = 0; i < w.count; i++) {
      if (w.kinds[i] !== HIT_NONE && Math.hypot(w.xs[i]! - s.x, w.ys[i]! - s.y) < touch) this.place(i, w.kinds[i] === HIT_FOOD ? HIT_FOOD : HIT_POISON, s);
    }
    c.sense(w);
    c.brain.forward(c.encode(), this.output);
  }
}
