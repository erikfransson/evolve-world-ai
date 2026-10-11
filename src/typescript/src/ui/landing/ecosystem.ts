import { genomeLength, layerSizes } from "../../sim/brain.ts";
import { collide } from "../../sim/physics.ts";
import { createRng } from "../../sim/rng.ts";
import type { CreatureState } from "../../sim/types.ts";
import type { Creature } from "../../sim/creature.ts";
import { beginFrame, drawItems } from "../scene.ts";
import { LAUNCH_SPEED, POP_SECONDS, RING_SECONDS, TICK_SECONDS, clamp, drawColoured, easeOutBack, foodWorld, moveAndEat, nearestFood, sceneConfig, scriptedCreature, steer, ticksOf } from "./kit.ts";
import type { Scene } from "./kit.ts";

const ECO_HUES = [200, 20, 280, 50, 340];
export const WARMUP_TICKS = 150; // ticks stepped before the first frame
const ECO_CAP = 6; // living creatures
const ECO_SLOTS = 10; // cap plus fading ones
const FIRST_BIRTH_SECONDS = 6; // after warm-up, about 4 s on screen at the page's 1.5x
const BIRTH_FULL = 3; // birth at this many times the start energy
const BIRTH_COST = 1.5; // same unit
const FADE_SECONDS = 1.2;

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
