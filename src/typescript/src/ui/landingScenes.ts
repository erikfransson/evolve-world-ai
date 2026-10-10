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
export const WARMUP_TICKS = 150; // ticks stepped before the first frame
const ECO_CAP = 6; // living creatures
const ECO_SLOTS = 10; // cap plus fading ones
const FIRST_BIRTH_SECONDS = 6; // after warm-up, about 4 s on screen at the page's 1.5x
const BIRTH_FULL = 3; // birth at this many times the start energy
const BIRTH_COST = 1.5; // same unit
const POP_SECONDS = 0.3;
const RING_SECONDS = 0.8;
const FADE_SECONDS = 1.2;
const LAUNCH_SPEED = 55;
const ticksOf = (seconds: number): number => Math.round(seconds / TICK_SECONDS);

interface EcoBody {
  creature: Creature;
  state: CreatureState;
  hue: number;
  skip: number;
  live: boolean; // slot in use
  fadeAt: number; // tick the fade-out began, -1 while healthy
  bornAt: number;
  e0: number; // energy at t0, rising linearly to the birth level at birthAt
  t0: number;
  birthAt: number;
  ringAt: number; // tick a ring started at (ringX, ringY), -1 for none
  ringX: number;
  ringY: number;
  ringHue: number;
}

export interface EcoScene extends Scene {
  births: number;
  living(): number; // creatures not fading out
}

// Ecosystem: several coloured creatures sharing regrowing food and bumping into each other, now and then giving birth.
export function ecosystemScene(seed: number): EcoScene {
  const config = sceneConfig(360, 225, 1.6, { radius: 10 });
  const world = foodWorld(config, createRng(seed));
  const respawnRng = createRng(seed + 1);
  const rng = createRng(seed + 2);
  const r = config.creature.radius;
  const start = config.creature.startEnergy;
  const genome = new Float32Array(genomeLength(layerSizes(config)));
  let tick = 0;
  const bodies: EcoBody[] = Array.from({ length: ECO_SLOTS }, (_, i) => {
    const creature = scriptedCreature(config, 0, 0, 0);
    const first = i < ECO_HUES.length;
    if (first) creature.reset(genome, rng.range(r, 360 - r), rng.range(r, 225 - r), rng.range(0, 2 * Math.PI), 0);
    return {
      creature, state: creature.state, hue: ECO_HUES[i] ?? 0, skip: i % 2, live: first, fadeAt: -1, bornAt: 0,
      e0: BIRTH_COST * start, t0: 0, birthAt: first ? WARMUP_TICKS + ticksOf(FIRST_BIRTH_SECONDS + 2.2 * i) : 0,
      ringAt: -1, ringX: 0, ringY: 0, ringHue: 0,
    };
  });

  function birth(parent: EcoBody): void {
    const child = bodies.find((b) => !b.live);
    const p = parent.state;
    parent.e0 = (BIRTH_FULL - BIRTH_COST) * start;
    parent.t0 = tick;
    parent.birthAt = tick + ticksOf(rng.range(8, 15));
    if (!child) return;
    let living = 0;
    let oldest: EcoBody | null = null;
    for (const b of bodies) {
      if (!b.live || b.fadeAt >= 0) continue;
      living++;
      if (!oldest || b.bornAt < oldest.bornAt) oldest = b;
    }
    if (living >= ECO_CAP && oldest) oldest.fadeAt = tick;
    const a = rng.range(0, 2 * Math.PI);
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    const d = 2 * r + 1;
    const x = clamp(p.x + cs * d, r, 360 - r);
    const y = clamp(p.y + sn * d, r, 225 - r);
    child.creature.reset(genome, x, y, a, start);
    child.state.vx = cs * LAUNCH_SPEED;
    child.state.vy = sn * LAUNCH_SPEED;
    child.hue = (parent.hue + rng.range(-25, 25) + 360) % 360;
    child.live = true;
    child.fadeAt = -1;
    child.bornAt = tick;
    child.e0 = start;
    child.t0 = tick;
    child.birthAt = tick + ticksOf(rng.range(8, 15));
    scene.births++;
    parent.ringAt = tick;
    parent.ringX = p.x;
    parent.ringY = p.y;
    parent.ringHue = parent.hue;
  }

  const scene: EcoScene = {
    births: 0,
    living() {
      return bodies.filter((b) => b.live && b.fadeAt < 0).length;
    },
    step() {
      tick++;
      const dead = ticksOf(FADE_SECONDS);
      for (const b of bodies) {
        if (!b.live) continue;
        if (b.fadeAt >= 0 && tick - b.fadeAt > dead) { b.live = false; continue; }
        const s = b.state;
        const target = nearestFood(world, s.x, s.y, b.skip);
        const { turn, thrust } = steer(s, world.xs[target]!, world.ys[target]!);
        moveAndEat(b.creature, world, turn, thrust, respawnRng);
        s.energy = b.e0 + ((BIRTH_FULL * start - b.e0) * Math.min(1, (tick - b.t0) / (b.birthAt - b.t0)));
      }
      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i]!;
        if (!a.live) continue;
        for (let j = i + 1; j < bodies.length; j++) if (bodies[j]!.live) bump(a.state, bodies[j]!.state, 2 * r);
      }
      for (const b of bodies) if (b.live && b.fadeAt < 0 && tick >= b.birthAt) birth(b);
    },
    draw(ctx) {
      const f = beginFrame(ctx, config);
      drawItems(ctx, f, world);
      for (const b of bodies) {
        if (!b.live) continue;
        const pop = Math.min(1, (tick - b.bornAt) * TICK_SECONDS / POP_SECONDS);
        const grow = b.bornAt === 0 ? 1 : easeOutBack(pop);
        const fade = b.fadeAt < 0 ? 1 : Math.max(0, 1 - (tick - b.fadeAt) * TICK_SECONDS / FADE_SECONDS);
        ctx.globalAlpha = fade;
        drawColoured(ctx, f.px, b.state, r * grow, b.hue);
      }
      ctx.globalAlpha = 1;
      for (const b of bodies) {
        if (b.ringAt < 0) continue;
        const t = (tick - b.ringAt) * TICK_SECONDS / RING_SECONDS;
        if (t >= 1) { b.ringAt = -1; continue; }
        ctx.globalAlpha = 0.95 * (1 - t);
        ctx.strokeStyle = `hsl(${b.ringHue}, 90%, 70%)`;
        ctx.lineWidth = (3 - 1.5 * t) * f.px;
        ctx.beginPath();
        ctx.arc(b.ringX, b.ringY, r * (1.2 + 2.6 * (1 - (1 - t) ** 2)), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
  };
  return scene;
}

// Overshooting ease, 0 to 1 with a small bounce past 1.
const easeOutBack = (t: number): number => Math.max(0, 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2);

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
