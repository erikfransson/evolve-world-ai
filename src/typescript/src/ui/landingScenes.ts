import { genomeLength, layerSizes } from "../sim/brain.ts";
import { DEFAULT_CONFIG, itemCounts, withOverrides } from "../sim/config.ts";
import type { SimConfig } from "../sim/config.ts";
import { Creature } from "../sim/creature.ts";
import { collide } from "../sim/physics.ts";
import { createRng } from "../sim/rng.ts";
import { HIT_NONE } from "../sim/types.ts";
import type { CreatureState, EpisodeView, HitKind, Rng } from "../sim/types.ts";
import { DEFAULT_PREDATOR_CONFIG } from "../sim/ecoConfig.ts";
import { World } from "../sim/world.ts";
import { HUNTER_REACH, hunterPath } from "./speciesStyle.ts";
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
        for (let j = i + 1; j < bodies.length; j++) if (bodies[j]!.live) collide(a.state, bodies[j]!.state, r, 1);
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

// Hues within each species' band of the Great Hunt defaults: calm blue prey, a red hunter.
const [PREY_SPECIES, HUNTER_SPECIES] = DEFAULT_PREDATOR_CONFIG.species!;
const PREY_HUES = [-0.3, 0, 0.2, -0.15, 0.4].map((k) => PREY_SPECIES!.hue + k * PREY_SPECIES!.hueSpread);
const HUNTER_HUE = HUNTER_SPECIES!.hue;
const PREY_SLOTS = 7; // living prey plus fading ones
const PREY_LIVE = 5;
const HUNTER_EDGE = 1.2; // the hunter's top speed over the prey's
const FLEE_RANGE = 80; // prey bolt when the hunter is this close
const REST_SECONDS = 4.5; // the hunter cruises after a catch, so each chase reads as one story
const REPLACE_SECONDS = 2.5; // a surviving prey gives birth this long after a catch
const CATCH_RING_SECONDS = 0.9;

interface PreyBody {
  creature: Creature;
  state: CreatureState;
  hue: number;
  skip: number;
  live: boolean;
  eatenAt: number; // tick it was caught, -1 while alive
  bornAt: number;
}

export interface PredatorScene extends Scene {
  catches: number;
  births: number;
  prey(): number; // living prey, not counting one being eaten
}

// The Great Hunt: blue prey graze regrowing plants, a faster red hunter with a pointed nose chases the nearest and
// catches it; the prey scatter when it comes close, and a survivor soon gives birth to keep the herd.
export function predatorScene(seed: number): PredatorScene {
  const config = sceneConfig(360, 225, 1.3, { radius: 9 });
  const hunterConfig = withOverrides(config, { creature: { maxThrust: config.creature.maxThrust * HUNTER_EDGE, maxTurnRate: 2.6 } });
  const W = config.world.width;
  const H = config.world.height;
  const world = foodWorld(config, createRng(seed));
  const respawnRng = createRng(seed + 1);
  const rng = createRng(seed + 2);
  const r = config.creature.radius;
  const genome = new Float32Array(genomeLength(layerSizes(config)));
  let tick = 0;
  const prey: PreyBody[] = Array.from({ length: PREY_SLOTS }, (_, i) => {
    const creature = scriptedCreature(config, 0, 0, 0);
    const live = i < PREY_LIVE;
    creature.reset(genome, rng.range(W * 0.35, W - r), rng.range(r, H - r), rng.range(0, 2 * Math.PI), config.creature.startEnergy);
    return { creature, state: creature.state, hue: PREY_HUES[i % PREY_HUES.length]!, skip: i % 2, live, eatenAt: -1, bornAt: 0 };
  });
  const hunter = scriptedCreature(hunterConfig, 40, H / 2, 0);
  const hs = hunter.state;
  let restUntil = 0;
  let replaceAt = -1;
  let fullness = 0.35; // the hunter's drawn energy level, 0 to 1
  let ring = { at: -1, x: 0, y: 0 };

  const alive = (): PreyBody[] => prey.filter((p) => p.live && p.eatenAt < 0);

  function giveBirth(): void {
    const parents = alive();
    const child = prey.find((p) => !p.live);
    if (!child || parents.length === 0) return;
    // The parent farthest from the hunter, so the newborn is not caught at once.
    let parent = parents[0]!;
    for (const p of parents) if ((p.state.x - hs.x) ** 2 + (p.state.y - hs.y) ** 2 > (parent.state.x - hs.x) ** 2 + (parent.state.y - hs.y) ** 2) parent = p;
    const a = rng.range(0, 2 * Math.PI);
    const x = clamp(parent.state.x + Math.cos(a) * (2 * r + 1), r, W - r);
    const y = clamp(parent.state.y + Math.sin(a) * (2 * r + 1), r, H - r);
    child.creature.reset(genome, x, y, a, config.creature.startEnergy);
    child.state.vx = Math.cos(a) * LAUNCH_SPEED;
    child.state.vy = Math.sin(a) * LAUNCH_SPEED;
    child.hue = (parent.hue + rng.range(-10, 10) + 360) % 360;
    child.live = true;
    child.eatenAt = -1;
    child.bornAt = tick;
    scene.births++;
  }

  const scene: PredatorScene = {
    catches: 0,
    births: 0,
    prey: () => alive().length,
    step() {
      tick++;
      // Prey: graze, or bolt away from the hunter when it is close.
      for (const p of prey) {
        if (!p.live) continue;
        if (p.eatenAt >= 0) {
          if (tick - p.eatenAt > ticksOf(CATCH_RING_SECONDS)) p.live = false;
          continue;
        }
        const s = p.state;
        const dx = s.x - hs.x;
        const dy = s.y - hs.y;
        const d = Math.hypot(dx, dy);
        if (d < FLEE_RANGE && tick >= restUntil) {
          // Away from the hunter, bent toward the middle so prey do not pin themselves to a wall.
          const tx = s.x + (dx / d) * 60 + (W / 2 - s.x) * 0.35;
          const ty = s.y + (dy / d) * 60 + (H / 2 - s.y) * 0.35;
          const { turn } = steer(s, tx, ty);
          moveAndEat(p.creature, world, turn, 1, respawnRng);
        } else {
          const target = nearestFood(world, s.x, s.y, p.skip);
          const { turn, thrust } = steer(s, world.xs[target]!, world.ys[target]!);
          moveAndEat(p.creature, world, turn, 0.6 * thrust, respawnRng);
        }
        s.energy = config.creature.startEnergy;
      }
      // Hunter: cruise while resting, otherwise chase the nearest prey, aiming a little ahead of it.
      const targets = alive();
      let target: PreyBody | null = null;
      for (const p of targets) if (!target || (p.state.x - hs.x) ** 2 + (p.state.y - hs.y) ** 2 < (target.state.x - hs.x) ** 2 + (target.state.y - hs.y) ** 2) target = p;
      if (target && tick >= restUntil) {
        const t = target.state;
        const { turn } = steer(hs, t.x + t.vx * 0.25, t.y + t.vy * 0.25);
        hunter.move(world, turn, 1);
      } else {
        const { turn } = steer(hs, W / 2 + Math.cos(tick * 0.012) * W * 0.3, H / 2 + Math.sin(tick * 0.017) * H * 0.3);
        hunter.move(world, turn, 0.35);
      }
      hs.energy = config.creature.startEnergy;
      fullness = Math.max(0.3, fullness - 0.05 * TICK_SECONDS);
      // A touch is a catch.
      if (target && tick >= restUntil && Math.hypot(target.state.x - hs.x, target.state.y - hs.y) < 2 * r) {
        target.eatenAt = tick;
        ring = { at: tick, x: target.state.x, y: target.state.y };
        fullness = 1;
        restUntil = tick + ticksOf(REST_SECONDS);
        replaceAt = tick + ticksOf(REPLACE_SECONDS);
        scene.catches++;
      }
      if (replaceAt >= 0 && tick >= replaceAt) {
        replaceAt = -1;
        giveBirth();
      }
      const bodies = [hs, ...alive().map((p) => p.state)];
      for (let i = 1; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) collide(bodies[i]!, bodies[j]!, r, 1);
    },
    draw(ctx) {
      const f = beginFrame(ctx, config);
      drawItems(ctx, f, world);
      // The hunter's gaze: a faint cone ahead of it.
      const h = hs.heading;
      const gaze = ctx.createRadialGradient(hs.x, hs.y, r, hs.x, hs.y, 95);
      gaze.addColorStop(0, `hsla(${HUNTER_HUE}, 90%, 62%, 0.16)`);
      gaze.addColorStop(1, `hsla(${HUNTER_HUE}, 90%, 62%, 0)`);
      ctx.fillStyle = gaze;
      ctx.beginPath();
      ctx.moveTo(hs.x, hs.y);
      ctx.arc(hs.x, hs.y, 95, h - 0.45, h + 0.45);
      ctx.closePath();
      ctx.fill();
      for (const p of prey) {
        if (!p.live) continue;
        const grow = p.bornAt === 0 ? 1 : easeOutBack(Math.min(1, ((tick - p.bornAt) * TICK_SECONDS) / POP_SECONDS));
        const gone = p.eatenAt < 0 ? 0 : Math.min(1, ((tick - p.eatenAt) * TICK_SECONDS) / 0.25);
        if (gone >= 1) continue;
        ctx.globalAlpha = 1 - gone;
        drawColoured(ctx, f.px, p.state, r * grow * (1 - 0.6 * gone), p.hue);
      }
      ctx.globalAlpha = 1;
      drawHunter(ctx, f.px, hs, r, fullness);
      if (ring.at >= 0) {
        const t = ((tick - ring.at) * TICK_SECONDS) / CATCH_RING_SECONDS;
        if (t < 1) {
          ctx.globalAlpha = 0.95 * (1 - t);
          ctx.strokeStyle = `hsl(${HUNTER_HUE}, 95%, 70%)`;
          ctx.lineWidth = (3 - 1.5 * t) * f.px;
          ctx.beginPath();
          ctx.arc(ring.x, ring.y, r * (1 + 2.4 * (1 - (1 - t) ** 2)), 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        } else ring.at = -1;
      }
    },
  };
  return scene;
}

// A hunter: dark pointed body filled in red up to its fullness, outlined, nose along its heading.
function drawHunter(ctx: CanvasRenderingContext2D, px: number, s: CreatureState, r: number, fullness: number): void {
  const h = s.heading;
  const path = (): void => {
    ctx.beginPath();
    hunterPath(ctx, s.x, s.y, r, h);
  };
  path();
  ctx.fillStyle = "rgba(15, 23, 20, 0.9)";
  ctx.fill();
  ctx.save();
  ctx.clip();
  const reach = HUNTER_REACH * r;
  ctx.fillStyle = `hsl(${HUNTER_HUE}, 82%, 60%)`;
  ctx.fillRect(s.x - reach, s.y + reach - 2 * reach * fullness, 2 * reach, 2 * reach * fullness);
  ctx.restore();
  path();
  ctx.strokeStyle = `hsl(${HUNTER_HUE}, 90%, 74%)`;
  ctx.lineWidth = 1.6 * px;
  ctx.lineJoin = "round";
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
