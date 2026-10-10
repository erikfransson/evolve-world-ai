import { genomeLength, layerSizes } from "../sim/brain.ts";
import { DEFAULT_CONFIG, itemCounts, withOverrides } from "../sim/config.ts";
import type { SimConfig } from "../sim/config.ts";
import { Creature } from "../sim/creature.ts";
import { createRng } from "../sim/rng.ts";
import { HIT_NONE } from "../sim/types.ts";
import type { CreatureState, EpisodeView, HitKind, Rng } from "../sim/types.ts";
import { World } from "../sim/world.ts";
import { BACKGROUND, FOOD, OTHER, beginFrame, drawItems, drawScene } from "./scene.ts";

// Small looping worlds for the landing page cards, built from the real simulation pieces.
export interface Scene {
  step(): void; // one tick of config.dt
  draw(ctx: CanvasRenderingContext2D): void;
}

export const TICK_SECONDS = DEFAULT_CONFIG.dt;
const VIEW = { showAll: false, showRays: true, pov: false };

const sceneConfig = (width: number, height: number, foodDensity: number, creature: Partial<SimConfig["creature"]> = {}): SimConfig =>
  withOverrides(DEFAULT_CONFIG, { world: { width, height, foodDensity, poisonDensity: 0, respawn: true }, creature });

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

function foodWorld(config: SimConfig, rng: Rng): World {
  const { food } = itemCounts(config);
  const world = new World(config, food);
  world.scatter(food, 0, rng);
  return world;
}

// The scenes steer their creatures by script, so the brain stays unused.
function scriptedCreature(config: SimConfig, x: number, y: number, heading: number): Creature {
  return new Creature(config, new Float32Array(genomeLength(layerSizes(config))), x, y, heading);
}

// Moves the creature one tick and respawns what it ate elsewhere.
function moveAndEat(c: Creature, world: World, turn: number, thrust: number, rng: Rng): void {
  const eaten = c.move(world, turn, thrust);
  if (eaten >= 0) world.placeRandomly(eaten, world.kinds[eaten] as HitKind, rng);
}

// Index of the food item closest to (x, y), skipping `skip` nearer ones so creatures do not all chase the same piece.
function nearestFood(world: World, x: number, y: number, skip = 0): number {
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
function steer(s: CreatureState, tx: number, ty: number): { turn: number; thrust: number } {
  const d = wrapAngle(Math.atan2(ty - s.y, tx - s.x) - s.heading);
  return { turn: clamp(2 * d, -1, 1), thrust: 0.3 + 0.6 * Math.max(0, Math.cos(d)) };
}

// Trials: one creature with its ray fan, chasing food in its own arena. Energy never runs out here.
export function trialsScene(seed: number): Scene {
  const config = sceneConfig(300, 190, 1.6, { raySpread: (110 * Math.PI) / 180 });
  const world = foodWorld(config, createRng(seed));
  const respawnRng = createRng(seed + 1);
  const creature = scriptedCreature(config, 150, 95, 0.4);
  const { state, rays, rayOffsets } = creature;
  const view: EpisodeView = { state, rays, rayOffsets, world };
  return {
    step() {
      creature.sense(world);
      const target = nearestFood(world, state.x, state.y);
      const { turn, thrust } = steer(state, world.xs[target]!, world.ys[target]!);
      moveAndEat(creature, world, turn, thrust, respawnRng);
      state.energy = Math.max(state.energy, 0.2 * config.creature.startEnergy); // keep the body fill in the readable range
    },
    draw(ctx) {
      drawScene(ctx, config, view, [], VIEW);
    },
  };
}

const ECO_HUES = [200, 20, 280, 50, 340];

// Ecosystem: several coloured creatures sharing regrowing food and bumping into each other.
export function ecosystemScene(seed: number): Scene {
  const config = sceneConfig(360, 225, 1.6, { radius: 10 });
  const world = foodWorld(config, createRng(seed));
  const respawnRng = createRng(seed + 1);
  const rng = createRng(seed + 2);
  const r = config.creature.radius;
  const bodies = ECO_HUES.map((hue, i) => {
    const creature = scriptedCreature(config, rng.range(r, 360 - r), rng.range(r, 225 - r), rng.range(0, 2 * Math.PI));
    return { hue, creature, state: creature.state, skip: i % 2 };
  });
  return {
    step() {
      for (const b of bodies) {
        const s = b.state;
        const target = nearestFood(world, s.x, s.y, b.skip);
        const { turn, thrust } = steer(s, world.xs[target]!, world.ys[target]!);
        moveAndEat(b.creature, world, turn, thrust, respawnRng);
        s.energy = clamp(s.energy, 0.5 * config.creature.startEnergy, 3 * config.creature.startEnergy);
      }
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) bump(bodies[i]!.state, bodies[j]!.state, 2 * r);
      }
    },
    draw(ctx) {
      const f = beginFrame(ctx, config);
      drawItems(ctx, f, world);
      for (const b of bodies) drawColoured(ctx, f.px, b.state, r, b.hue);
    },
  };
}

// Equal-mass collision: separates overlapping bodies and swaps their approach speed along the contact line.
function bump(a: CreatureState, b: CreatureState, minDist: number): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d >= minDist || d === 0) return;
  const nx = dx / d;
  const ny = dy / d;
  const push = (minDist - d) / 2;
  a.x -= nx * push; a.y -= ny * push;
  b.x += nx * push; b.y += ny * push;
  const approach = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (approach <= 0) return;
  a.vx -= approach * nx; a.vy -= approach * ny;
  b.vx += approach * nx; b.vy += approach * ny;
}

function drawColoured(ctx: CanvasRenderingContext2D, px: number, s: CreatureState, r: number, hue: number): void {
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

// Live World: a dim world of slowly drifting specks and ghost creatures under a veil.
export function liveScene(seed: number): Scene {
  const config = sceneConfig(360, 225, 0, { radius: 10 });
  const rng = createRng(seed);
  const { width: W, height: H } = config.world;
  const specks = Array.from({ length: 22 }, () => ({ x: rng.range(0, W), y: rng.range(0, H), a: rng.range(0, 2 * Math.PI), v: rng.range(1.5, 4) }));
  const ghosts = Array.from({ length: 6 }, () => ({ x: rng.range(20, W - 20), y: rng.range(20, H - 20), a: rng.range(0, 2 * Math.PI), v: rng.range(4, 9), phase: rng.range(0, 6) }));
  let tick = 0;
  const wrap = (v: number, max: number): number => ((v % max) + max) % max;
  return {
    step() {
      tick++;
      for (const p of specks) {
        p.x = wrap(p.x + Math.cos(p.a) * p.v * TICK_SECONDS, W);
        p.y = wrap(p.y + Math.sin(p.a) * p.v * TICK_SECONDS, H);
      }
      for (const g of ghosts) {
        g.a += Math.sin(tick * 0.02 + g.phase) * 0.03;
        g.x = clamp(g.x + Math.cos(g.a) * g.v * TICK_SECONDS, 12, W - 12);
        g.y = clamp(g.y + Math.sin(g.a) * g.v * TICK_SECONDS, 12, H - 12);
        if (g.x <= 12 || g.x >= W - 12 || g.y <= 12 || g.y >= H - 12) g.a += Math.PI * 0.6;
      }
    },
    draw(ctx) {
      const f = beginFrame(ctx, config);
      ctx.fillStyle = FOOD;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      for (const p of specks) {
        ctx.moveTo(p.x + f.itemR, p.y);
        ctx.arc(p.x, p.y, f.itemR, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.fillStyle = OTHER;
      ctx.strokeStyle = OTHER;
      ctx.lineWidth = f.px;
      for (const g of ghosts) {
        ctx.globalAlpha = 0.28;
        ctx.beginPath();
        ctx.arc(g.x, g.y, config.creature.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        ctx.moveTo(g.x + Math.cos(g.a) * 10, g.y + Math.sin(g.a) * 10);
        ctx.lineTo(g.x + Math.cos(g.a) * 17, g.y + Math.sin(g.a) * 17);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Veil over everything, breathing slowly.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = BACKGROUND;
      ctx.globalAlpha = 0.5 + 0.08 * Math.sin(tick * 0.03);
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.globalAlpha = 1;
    },
  };
}
