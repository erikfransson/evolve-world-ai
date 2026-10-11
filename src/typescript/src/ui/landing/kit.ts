import { genomeLength, layerSizes } from "../../sim/brain.ts";
import { DEFAULT_CONFIG, itemCounts, withOverrides } from "../../sim/config.ts";
import type { SimConfig } from "../../sim/config.ts";
import { Creature } from "../../sim/creature.ts";
import { HIT_NONE } from "../../sim/types.ts";
import type { CreatureState, HitKind, Rng } from "../../sim/types.ts";
import { World } from "../../sim/world.ts";

// Shared pieces of the small looping worlds on the landing page cards, built from the real simulation pieces.
export interface Scene {
  step(): void; // one tick of config.dt
  draw(ctx: CanvasRenderingContext2D): void;
}

export const TICK_SECONDS = DEFAULT_CONFIG.dt;
export const POP_SECONDS = 0.3;
export const LAUNCH_SPEED = 55;
export const RING_SECONDS = 0.8;
const BURST_SECONDS = 1;
export const ticksOf = (seconds: number): number => Math.round(seconds / TICK_SECONDS);

export const sceneConfig = (width: number, height: number, foodDensity: number, creature: Partial<SimConfig["creature"]> = {}): SimConfig =>
  withOverrides(DEFAULT_CONFIG, { world: { width, height, foodDensity, poisonDensity: 0, respawn: true }, creature });

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export function foodWorld(config: SimConfig, rng: Rng): World {
  const { food } = itemCounts(config);
  const world = new World(config, food);
  world.scatter(food, 0, rng);
  return world;
}

// The scenes steer their creatures by script, so the brain stays unused.
export function scriptedCreature(config: SimConfig, x: number, y: number, heading: number): Creature {
  return new Creature(config, new Float32Array(genomeLength(layerSizes(config))), x, y, heading);
}

// Moves the creature one tick and respawns what it ate elsewhere.
export function moveAndEat(c: Creature, world: World, turn: number, thrust: number, rng: Rng): void {
  const eaten = c.move(world, turn, thrust);
  if (eaten >= 0) world.placeRandomly(eaten, world.kinds[eaten] as HitKind, rng);
}

// Index of the food item closest to (x, y), skipping `skip` nearer ones so creatures do not all chase the same piece.
export function nearestFood(world: World, x: number, y: number, skip = 0): number {
  let best = -1;
  let bestD = Infinity;
  let second = -1;
  let secondD = Infinity;
  for (let i = 0; i < world.count; i++) {
    if (world.kinds[i] === HIT_NONE) continue;
    const d = (world.xs[i]! - x) ** 2 + (world.ys[i]! - y) ** 2;
    if (d < bestD) { second = best; secondD = bestD; best = i; bestD = d; }
    else if (d < secondD) { second = i; secondD = d; }
  }
  return skip > 0 && second >= 0 ? second : best;
}

// Turns toward a point and thrusts harder the better it is lined up.
export function steer(s: CreatureState, tx: number, ty: number): { turn: number; thrust: number } {
  const d = wrapAngle(Math.atan2(ty - s.y, tx - s.x) - s.heading);
  return { turn: clamp(2 * d, -1, 1), thrust: 0.3 + 0.6 * Math.max(0, Math.cos(d)) };
}

// Overshooting ease, 0 to 1 with a small bounce past 1.
export const easeOutBack = (t: number): number => Math.max(0, 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2);

export function drawColoured(ctx: CanvasRenderingContext2D, px: number, s: Pick<CreatureState, "x" | "y" | "heading">, r: number, hue: number): void {
  ctx.fillStyle = `hsl(${hue}, 75%, 58%)`;
  ctx.strokeStyle = `hsl(${hue}, 85%, 80%)`;
  ctx.lineWidth = 1.6 * px;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  const cs = Math.cos(s.heading);
  const sn = Math.sin(s.heading);
  ctx.beginPath();
  ctx.moveTo(s.x + cs * r * 0.2, s.y + sn * r * 0.2);
  ctx.lineTo(s.x + cs * r * 1.7, s.y + sn * r * 1.7);
  ctx.lineWidth = 2 * px;
  ctx.strokeStyle = `hsl(${hue}, 85%, 80%)`;
  ctx.stroke();
}

export interface Effect {
  at: number; // tick
  x: number;
  y: number;
  hue: number;
}

// The in-game death effect: a thin ring at the body outline and a few specks drifting out, in the prey's colour.
export function drawBursts(ctx: CanvasRenderingContext2D, px: number, list: Effect[], tick: number, r: number): void {
  while (list.length && (tick - list[0]!.at) * TICK_SECONDS >= BURST_SECONDS) list.shift();
  for (const e of list) {
    const t = ((tick - e.at) * TICK_SECONDS) / BURST_SECONDS;
    const color = `hsl(${e.hue}, 90%, 68%)`;
    ctx.globalAlpha = (1 - t) ** 2;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = (2 - 1 * t) * px;
    ctx.beginPath();
    ctx.arc(e.x, e.y, r * (1 + 1.4 * t), 0, 2 * Math.PI);
    ctx.stroke();
    const spread = r * (0.8 + 3 * t);
    const speck = Math.max(0.6 * px, r * 0.17 * (1 - t));
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k + 0.37 * (k % 3)) * (Math.PI / 4) + e.y;
      const d = spread * (0.7 + (0.3 * ((k * 5) % 3)) / 2);
      ctx.moveTo(e.x + Math.cos(a) * d + speck, e.y + Math.sin(a) * d);
      ctx.arc(e.x + Math.cos(a) * d, e.y + Math.sin(a) * d, speck, 0, 2 * Math.PI);
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// The ecosystem card's birth ring.
export function drawBirthRings(ctx: CanvasRenderingContext2D, px: number, list: Effect[], tick: number, r: number): void {
  while (list.length && (tick - list[0]!.at) * TICK_SECONDS >= RING_SECONDS) list.shift();
  for (const e of list) {
    const t = ((tick - e.at) * TICK_SECONDS) / RING_SECONDS;
    ctx.globalAlpha = 0.95 * (1 - t);
    ctx.strokeStyle = `hsl(${e.hue}, 90%, 70%)`;
    ctx.lineWidth = (3 - 1.5 * t) * px;
    ctx.beginPath();
    ctx.arc(e.x, e.y, r * (1.2 + 2.6 * (1 - (1 - t) ** 2)), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
