import type { EngineConfig } from "./config.ts";
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

export function decaysFor(config: EngineConfig): Decays {
  const c = config.creature;
  return {
    turn: Math.exp(-c.turnDamping * config.dt),
    drag: Math.exp(-c.drag * config.dt),
    side: Math.exp(-c.sideDrag * config.dt),
  };
}

// Old-age upkeep: from startTicks on, the upkeep grows by perTick of itself per tick lived (agingRate per minute).
export interface Aging {
  startTicks: number;
  perTick: number;
}

// Factor on the plan's upkeep for a creature that has lived this many ticks; 1 up to startTicks.
export function agingFactor(aging: Aging | null, ticksAlive: number): number {
  return aging && ticksAlive > aging.startTicks ? 1 + aging.perTick * (ticksAlive - aging.startTicks) : 1;
}

// Advances one creature's motion and energy by one tick: turn, thrust with drag, walls, energy costs.
// turnOut and thrust in [-1, 1]; negative thrust brakes at maxBrake x its size (free, never reverses). Eating and death are separate (consume, settle).
// upkeep is the plan's energy per second besides thrust and turning (planUpkeep).
export function stepBody(s: CreatureState, turnOut: number, thrust: number, config: EngineConfig, k: Decays, heading: Heading, upkeep: number): void {
  const { dt, creature: c, world: w } = config;
  // Exact exponential relaxation each tick keeps motion smooth and independent of dt.
  const targetTurn = turnOut * c.maxTurnRate;
  s.turnRate = targetTurn + (s.turnRate - targetTurn) * k.turn;
  s.heading += s.turnRate * dt;

  heading.cos = Math.cos(s.heading);
  heading.sin = Math.sin(s.heading);
  const cos = heading.cos;
  const sin = heading.sin;
  const v = s.vx * cos + s.vy * sin;
  let fwd: number;
  if (thrust >= 0) {
    const terminal = (thrust * c.maxThrust) / c.drag;
    fwd = terminal + (v - terminal) * k.drag;
  } else {
    // Braking shrinks the forward speed toward 0, never past it.
    const slowed = Math.abs(v) * k.drag + thrust * c.maxBrake * dt;
    fwd = slowed > 0 ? (v < 0 ? -slowed : slowed) : 0;
  }
  const side = (-s.vx * sin + s.vy * cos) * k.side;
  s.vx = fwd * cos - side * sin;
  s.vy = fwd * sin + side * cos;

  s.x += s.vx * dt;
  s.y += s.vy * dt;
  keepInside(s, c.radius, w.width, w.height, c.wallBounce);

  s.energy -= (upkeep + c.thrustCost * Math.max(0, thrust) + (c.turnCost * Math.abs(s.turnRate)) / c.maxTurnRate) * dt;
}

type Body = Pick<CreatureState, "x" | "y" | "vx" | "vy">;

// Out parameter of collide: how fast the pair approached along the line between centres, units/s.
export interface Contact {
  speed: number;
}

// Clamps a disc into the box and reflects the velocity component pointing into a wall, scaled by restitution
// (0 absorbs it). Tangential velocity is kept, so kinetic energy never grows.
export function keepInside(s: Body, radius: number, width: number, height: number, restitution: number): void {
  if (s.x < radius) { s.x = radius; if (s.vx < 0) s.vx = -restitution * s.vx; }
  else if (s.x > width - radius) { s.x = width - radius; if (s.vx > 0) s.vx = -restitution * s.vx; }
  if (s.y < radius) { s.y = radius; if (s.vy < 0) s.vy = -restitution * s.vy; }
  else if (s.y > height - radius) { s.y = height - radius; if (s.vy > 0) s.vy = -restitution * s.vy; }
}

// Pushes two overlapping equal-mass discs of this radius apart along the line between their centres, half each,
// and if they approach, reflects their relative normal velocity scaled by restitution (1 swaps the normal components).
// Momentum is conserved. Returns whether they overlapped. If contact is given, its speed is set to the normal approach
// speed before the bounce, 0 for a pair that is separating or apart, so one impact counts once (the bounce ends the approach).
export function collide(a: Body, b: Body, radius: number, restitution: number, contact?: Contact): boolean {
  let nx = b.x - a.x;
  let ny = b.y - a.y;
  const d2 = nx * nx + ny * ny;
  const reach = 2 * radius;
  if (d2 >= reach * reach) {
    if (contact) contact.speed = 0;
    return false;
  }
  const d = Math.sqrt(d2);
  if (d > 0) {
    nx /= d;
    ny /= d;
  } else {
    nx = 1; // coincident centres: separate along +x
    ny = 0;
  }
  const push = (reach - d) / 2;
  a.x -= nx * push;
  a.y -= ny * push;
  b.x += nx * push;
  b.y += ny * push;
  const approach = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (contact) contact.speed = approach < 0 ? -approach : 0;
  if (approach < 0) {
    const j = (-(1 + restitution) * approach) / 2;
    a.vx -= j * nx;
    a.vy -= j * ny;
    b.vx += j * nx;
    b.vy += j * ny;
  }
  return true;
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

// Collision damage: both lose damagePerSpeed x the approach speed. If exactly one would die, the survivor also gains the
// dead one's energy from just before the hit, and the dead one is left at 0 for settle. If both die nobody gains.
// Creatures already at 0 energy (dying this tick) are left alone.
export function hurt(a: CreatureState, b: CreatureState, speed: number, damagePerSpeed: number): void {
  const beforeA = a.energy;
  const beforeB = b.energy;
  if (speed <= 0 || beforeA <= 0 || beforeB <= 0) return;
  const damage = damagePerSpeed * speed;
  a.energy -= damage;
  b.energy -= damage;
  const aDead = a.energy <= 0;
  const bDead = b.energy <= 0;
  if (aDead && !bDead) b.energy += beforeA;
  else if (bDead && !aDead) a.energy += beforeB;
  if (aDead) a.energy = 0;
  if (bDead) b.energy = 0;
}
