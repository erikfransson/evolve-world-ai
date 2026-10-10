import type { SimConfig } from "./config.ts";
import { HIT_FOOD, HIT_POISON } from "./types.ts";
import type { CreatureState, HitKind } from "./types.ts";

// Per-tick decay factors of the exact exponential relaxation, constant for a config.
export interface Decays {
  turn: number;
  drag: number;
  side: number;
}

// Heading cos/sin, kept up to date by stepBody so rays and inputs reuse them.
export interface Heading {
  cos: number;
  sin: number;
}

export function decaysFor(config: SimConfig): Decays {
  const c = config.creature;
  return {
    turn: Math.exp(-c.turnDamping * config.dt),
    drag: Math.exp(-c.drag * config.dt),
    side: Math.exp(-c.sideDrag * config.dt),
  };
}

// Advances one creature's motion and energy by one tick: turn, thrust with drag, walls, energy costs.
// turnOut in [-1, 1], thrust in [0, 1]. Eating and death are separate (consume, settle).
export function stepBody(s: CreatureState, turnOut: number, thrust: number, config: SimConfig, k: Decays, heading: Heading): void {
  const { dt, creature: c, world: w } = config;
  // Exact exponential relaxation each tick keeps motion smooth and independent of dt.
  const targetTurn = turnOut * c.maxTurnRate;
  s.turnRate = targetTurn + (s.turnRate - targetTurn) * k.turn;
  s.heading += s.turnRate * dt;

  heading.cos = Math.cos(s.heading);
  heading.sin = Math.sin(s.heading);
  const cos = heading.cos;
  const sin = heading.sin;
  const terminal = (thrust * c.maxThrust) / c.drag;
  const fwd = terminal + (s.vx * cos + s.vy * sin - terminal) * k.drag;
  const side = (-s.vx * sin + s.vy * cos) * k.side;
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
}

// Applies what the creature ate this tick (a HitKind from World.eatAt).
export function consume(s: CreatureState, eaten: HitKind, foodEnergy: number): void {
  if (eaten === HIT_FOOD) s.energy += foodEnergy;
  else if (eaten === HIT_POISON) s.energy = 0; // poison always kills
}

// Ends the tick: dies at zero energy, otherwise counts the tick alive.
export function settle(s: CreatureState): void {
  if (s.energy <= 0) {
    s.energy = 0;
    s.alive = false;
  } else {
    s.ticksAlive++;
  }
}
