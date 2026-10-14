import { genomeLength, layerSizes } from "../../sim/brain.ts";
import { collide } from "../../sim/physics.ts";
import { createRng } from "../../sim/rng.ts";
import type { Creature } from "../../sim/creature.ts";
import type { HitKind } from "../../sim/types.ts";
import { RAY_COLORS, beginFrame, drawItems } from "../scene.ts";
import { LAUNCH_SPEED, POP_SECONDS, RING_SECONDS, TICK_SECONDS, clamp, easeOutBack, foodWorld, nearestFood, sceneConfig, scriptedCreature, steer, ticksOf } from "./kit.ts";
import type { Scene } from "./kit.ts";

export const WARMUP_TICKS = 150; // ticks stepped before the first frame
const FAMILY_HUES = [200, 20, 280, 50, 340]; // one family per lineage
const PER_FAMILY = 3;
const SLOTS = FAMILY_HUES.length * PER_FAMILY + 5; // spare slots for newborns
export const ECO_CAP = FAMILY_HUES.length * PER_FAMILY + 2;
const EAT_GAIN = 0.16; // energy ratio per food item
const DRAIN = 0.025; // energy ratio per second
const BIRTH_AT = 1;
const BIRTH_LEFT = 0.55;
const FADE_SECONDS = 1.2;
const FAN = 5;
const FAN_SPREAD = 0.9; // radians either side

interface Body {
  creature: Creature;
  hue: number;
  e: number; // energy ratio 0..1
  skip: number;
  live: boolean;
  fadeAt: number;
  bornAt: number;
  ringAt: number;
  ringX: number;
  ringY: number;
}

export interface EcoScene extends Scene {
  births: number;
  living(): number; // creatures not fading out
}

// Ecosystem: a busy world, small families of distinct colours grazing, giving birth and crowding together.
export function ecosystemScene(seed: number): EcoScene {
  const config = sceneConfig(360, 225, 2.6, { radius: 9, raySpread: 2 * FAN_SPREAD, rayLength: 42 });
  const world = foodWorld(config, createRng(seed));
  const respawnRng = createRng(seed + 1);
  const rng = createRng(seed + 2);
  const { width: W, height: H } = config.world;
  const r = config.creature.radius;
  const start = config.creature.startEnergy;
  const genome = new Float32Array(genomeLength(layerSizes(config)));
  let tick = 0;
  const bodies: Body[] = Array.from({ length: SLOTS }, (_, i) => {
    const creature = scriptedCreature(config, 0, 0, 0);
    const first = i < FAMILY_HUES.length * PER_FAMILY;
    const hue = ((FAMILY_HUES[Math.floor(i / PER_FAMILY)] ?? 0) + rng.range(-12, 12) + 360) % 360;
    if (first) creature.reset(genome, rng.range(r, W - r), rng.range(r, H - r), rng.range(0, 2 * Math.PI), start);
    return { creature, hue, e: rng.range(0.3, 0.95), skip: i % 2, live: first, fadeAt: -1, bornAt: 0, ringAt: -1, ringX: 0, ringY: 0 };
  });
  const lit = (i: number): boolean => ((i * 7 + Math.floor(tick / ticksOf(5))) % bodies.length) % 5 === 0; // rotates every 5 s

  function birth(parent: Body): void {
    const child = bodies.find((b) => !b.live);
    parent.e = BIRTH_LEFT;
    if (!child) return;
    let living = 0;
    let oldest: Body | null = null;
    for (const b of bodies) {
      if (!b.live || b.fadeAt >= 0) continue;
      living++;
      if (!oldest || b.bornAt < oldest.bornAt) oldest = b;
    }
    if (living >= ECO_CAP && oldest) oldest.fadeAt = tick;
    const p = parent.creature.state;
    const a = rng.range(0, 2 * Math.PI);
    const d = 2 * r + 1;
    child.creature.reset(genome, clamp(p.x + Math.cos(a) * d, r, W - r), clamp(p.y + Math.sin(a) * d, r, H - r), a, start);
    child.creature.state.vx = Math.cos(a) * LAUNCH_SPEED;
    child.creature.state.vy = Math.sin(a) * LAUNCH_SPEED;
    child.hue = (parent.hue + rng.range(-10, 10) + 360) % 360;
    child.e = 0.4;
    child.live = true;
    child.fadeAt = -1;
    child.bornAt = tick;
    parent.ringAt = tick;
    parent.ringX = p.x;
    parent.ringY = p.y;
    scene.births++;
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
        const s = b.creature.state;
        const target = nearestFood(world, s.x, s.y, b.skip);
        const { turn, thrust } = steer(s, world.xs[target]!, world.ys[target]!);
        const eaten = b.creature.move(world, turn, thrust);
        s.energy = start;
        if (eaten >= 0) {
          world.placeRandomly(eaten, world.kinds[eaten] as HitKind, respawnRng);
          b.e += EAT_GAIN;
        }
        b.e = Math.max(0.15, b.e - DRAIN * TICK_SECONDS);
      }
      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i]!;
        if (!a.live) continue;
        for (let j = i + 1; j < bodies.length; j++) if (bodies[j]!.live) collide(a.creature.state, bodies[j]!.creature.state, r, 1);
      }
      for (const b of bodies) if (b.live && b.fadeAt < 0 && b.e >= BIRTH_AT && tick - b.bornAt > ticksOf(3)) birth(b);
    },
    draw(ctx) {
      const f = beginFrame(ctx, config);
      drawItems(ctx, f, world);
      const px = f.px;
      // Ray fans under the bodies, for a rotating few.
      ctx.lineWidth = px;
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i]!;
        if (!b.live || b.fadeAt >= 0 || !lit(i)) continue;
        const rays = b.creature.rays;
        const offs = b.creature.rayOffsets;
        const s = b.creature.state;
        for (let k = 0; k < Math.min(FAN, rays.length); k++) {
          const hit = rays[k]!;
          const d = hit.kind === 0 ? f.rayLength : f.rayLength * (1 - hit.closeness);
          const a = s.heading + offs[k]!;
          ctx.strokeStyle = RAY_COLORS[hit.kind]!;
          ctx.globalAlpha = hit.kind === 0 ? 0.5 : 0.9;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      for (const b of bodies) {
        if (!b.live) continue;
        const s = b.creature.state;
        const grow = b.bornAt === 0 ? 1 : easeOutBack(Math.min(1, ((tick - b.bornAt) * TICK_SECONDS) / POP_SECONDS));
        const R = Math.max(r * grow, 0.1);
        ctx.globalAlpha = b.fadeAt < 0 ? 1 : Math.max(0, 1 - ((tick - b.fadeAt) * TICK_SECONDS) / FADE_SECONDS);
        // Energy fill, level in screen space, in the family colour.
        ctx.save();
        ctx.beginPath();
        ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(15, 23, 20, 0.85)";
        ctx.fill();
        ctx.clip();
        const top = s.y + R - 2 * R * Math.min(1, b.e);
        ctx.fillStyle = `hsl(${b.hue}, 80%, 58%)`;
        ctx.fillRect(s.x - R, top, 2 * R, s.y + R - top);
        ctx.restore();
        ctx.strokeStyle = `hsl(${b.hue}, 90%, 82%)`;
        ctx.lineWidth = 1.6 * px;
        ctx.beginPath();
        ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
        ctx.stroke();
        const cs = Math.cos(s.heading);
        const sn = Math.sin(s.heading);
        const base = R + 1.2 * px;
        const tip = R + 5.5 * px;
        const hw = 3 * px;
        ctx.fillStyle = `hsl(${b.hue}, 90%, 82%)`;
        ctx.beginPath();
        ctx.moveTo(s.x + cs * tip, s.y + sn * tip);
        ctx.lineTo(s.x + cs * base - sn * hw, s.y + sn * base + cs * hw);
        ctx.lineTo(s.x + cs * base + sn * hw, s.y + sn * base - cs * hw);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      for (const b of bodies) {
        if (b.ringAt < 0) continue;
        const t = ((tick - b.ringAt) * TICK_SECONDS) / RING_SECONDS;
        if (t >= 1) { b.ringAt = -1; continue; }
        ctx.globalAlpha = 0.95 * (1 - t);
        ctx.strokeStyle = `hsl(${b.hue}, 90%, 70%)`;
        ctx.lineWidth = (3 - 1.5 * t) * px;
        ctx.beginPath();
        ctx.arc(b.ringX, b.ringY, r * (1.2 + 2.6 * (1 - (1 - t) ** 2)), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
  };
  return scene;
}
