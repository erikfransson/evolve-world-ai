import { genomeLength, layerSizes } from "../../sim/brain.ts";
import { withOverrides } from "../../sim/config.ts";
import type { Creature } from "../../sim/creature.ts";
import { DEFAULT_PREDATOR_CONFIG } from "../../sim/ecoConfig.ts";
import { collide } from "../../sim/physics.ts";
import { createRng } from "../../sim/rng.ts";
import type { CreatureState } from "../../sim/types.ts";
import { HUNTER_NOSE, HUNTER_REACH, hunterPath } from "../speciesStyle.ts";
import { beginFrame, drawItems } from "../scene.ts";
import { LAUNCH_SPEED, POP_SECONDS, TICK_SECONDS, clamp, drawBirthRings, drawBursts, drawColoured, easeOutBack, foodWorld, moveAndEat, nearestFood, sceneConfig, scriptedCreature, steer, ticksOf, wrapAngle } from "./kit.ts";
import type { Effect, Scene } from "./kit.ts";

// Hues within each species' band of the Great Hunt defaults: calm blue prey, a red hunter.
const [PREY_SPECIES, HUNTER_SPECIES] = DEFAULT_PREDATOR_CONFIG.species!;
const PREY_HUES = [-0.3, 0, 0.2, -0.15, 0.4].map((k) => PREY_SPECIES!.hue + k * PREY_SPECIES!.hueSpread);
const HUNTER_HUE = HUNTER_SPECIES!.hue;
const PREY_SLOTS = 7; // living prey plus fading ones
const PREY_LIVE = 5;
const HUNTER_EDGE = 1.2; // the hunter's top speed over the prey's
const FLEE_RANGE = 80; // prey bolt when the hunter is this close
const REST_SECONDS = 3.5; // the hunter cruises after a catch, so each chase reads as one story
const TOUCH = 0.9; // a prey whose centre is within this many radii of the hunter's outline is touching it
const REPLACE_SECONDS = 2.5; // a surviving prey gives birth this long after a catch
const CATCH_FADE_SECONDS = 0.18; // the caught prey shrinks away under the burst
const LUNGE_RANGE = 4.5; // radii: the hunter surges when a target is this close
const LUNGE_ACCEL = 160; // px/s^2 along the heading during a lunge

// Signed distance from (px, py) to the hunter's teardrop (round back of radius r, flanks to the nose tip), negative inside.
export function hunterDistance(h: CreatureState, r: number, px: number, py: number): number {
  const cs = Math.cos(h.heading);
  const sn = Math.sin(h.heading);
  const dx = px - h.x;
  const dy = py - h.y;
  const along = dx * cs + dy * sn;
  const across = Math.abs(-dx * sn + dy * cs);
  const L = HUNTER_NOSE * r;
  if (along < (r * r) / L) return Math.hypot(along, across) - r;
  if (along > L) return Math.hypot(along - L, across);
  const sin = r / L;
  return across * Math.sqrt(1 - sin * sin) - (L - along) * sin;
}

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
  overlaps(): number; // uncaught prey drawn overlapping the hunter, always 0 after a step
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
  const bursts: Effect[] = []; // catches
  const rings: Effect[] = []; // births

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
    rings.push({ at: tick, x, y, hue: child.hue });
    scene.births++;
  }

  // Pushes a prey out of the hunter's outline, away from the nearest point of its spine, and takes the inward speed off.
  function holdOff(s: CreatureState): void {
    const cs = Math.cos(hs.heading);
    const sn = Math.sin(hs.heading);
    const along = clamp((s.x - hs.x) * cs + (s.y - hs.y) * sn, 0, HUNTER_NOSE * r);
    const nx0 = s.x - (hs.x + cs * along);
    const ny0 = s.y - (hs.y + sn * along);
    const d = Math.hypot(nx0, ny0) || 1;
    const nx = nx0 / d;
    const ny = ny0 / d;
    for (let k = 0; k < 8 && hunterDistance(hs, r, s.x, s.y) < r; k++) {
      s.x += nx * 0.5 * r;
      s.y += ny * 0.5 * r;
    }
    const inward = s.vx * nx + s.vy * ny;
    if (inward < 0) { s.vx -= inward * nx; s.vy -= inward * ny; }
  }

  const scene: PredatorScene = {
    catches: 0,
    births: 0,
    prey: () => alive().length,
    overlaps: () => alive().filter((p) => hunterDistance(hs, r, p.state.x, p.state.y) < 0.85 * r).length,
    step() {
      tick++;
      // Prey: graze, or bolt away from the hunter when it is close.
      for (const p of prey) {
        if (!p.live) continue;
        if (p.eatenAt >= 0) {
          if (tick - p.eatenAt > ticksOf(CATCH_FADE_SECONDS)) p.live = false;
          continue;
        }
        const s = p.state;
        const dx = s.x - hs.x;
        const dy = s.y - hs.y;
        const d = Math.hypot(dx, dy);
        if (d < (tick >= restUntil ? FLEE_RANGE : 0.6 * FLEE_RANGE)) {
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
        // Lunge: surge along the heading once close and lined up.
        if (Math.hypot(t.x - hs.x, t.y - hs.y) < LUNGE_RANGE * r && Math.abs(wrapAngle(Math.atan2(t.y - hs.y, t.x - hs.x) - hs.heading)) < 0.5) {
          hs.vx += Math.cos(hs.heading) * LUNGE_ACCEL * TICK_SECONDS;
          hs.vy += Math.sin(hs.heading) * LUNGE_ACCEL * TICK_SECONDS;
        }
      } else {
        const { turn } = steer(hs, W / 2 + Math.cos(tick * 0.012) * W * 0.3, H / 2 + Math.sin(tick * 0.017) * H * 0.3);
        hunter.move(world, turn, 0.35);
      }
      hs.energy = config.creature.startEnergy;
      fullness = Math.max(0.3, fullness - 0.05 * TICK_SECONDS);
      // Prey bump each other; the hunter never shoves them. A touch is a catch, or while resting they are held off its outline.
      const crowd = alive();
      for (let i = 0; i < crowd.length; i++) for (let j = i + 1; j < crowd.length; j++) collide(crowd[i]!.state, crowd[j]!.state, r, 1);
      let caught = false;
      for (const p of crowd) {
        const s = p.state;
        if (hunterDistance(hs, r, s.x, s.y) >= TOUCH * r) continue;
        if (tick >= restUntil && !caught) {
          caught = true;
          p.eatenAt = tick;
          bursts.push({ at: tick, x: s.x, y: s.y, hue: p.hue });
          fullness = 1;
          restUntil = tick + ticksOf(REST_SECONDS);
          replaceAt = tick + ticksOf(REPLACE_SECONDS);
          scene.catches++;
        } else holdOff(s);
      }
      if (replaceAt >= 0 && tick >= replaceAt) {
        replaceAt = -1;
        giveBirth();
      }
    },
    draw(ctx) {
      const f = beginFrame(ctx, config);
      drawItems(ctx, f, world);
      // The hunter's gaze: a faint cone ahead of it.
      const h = hs.heading;
      const gaze = ctx.createRadialGradient(hs.x, hs.y, r, hs.x, hs.y, 95);
      gaze.addColorStop(0, `hsla(${HUNTER_HUE}, 90%, 62%, 0.26)`);
      gaze.addColorStop(0.6, `hsla(${HUNTER_HUE}, 90%, 62%, 0.12)`);
      gaze.addColorStop(1, `hsla(${HUNTER_HUE}, 90%, 62%, 0)`);
      ctx.fillStyle = gaze;
      ctx.beginPath();
      ctx.moveTo(hs.x, hs.y);
      ctx.arc(hs.x, hs.y, 95, h - 0.45, h + 0.45);
      ctx.closePath();
      ctx.fill();
      // Faint edge rays, so the field of view reads at a glance.
      const edge = ctx.createLinearGradient(hs.x, hs.y, hs.x + 95 * Math.cos(h), hs.y + 95 * Math.sin(h));
      edge.addColorStop(0, `hsla(${HUNTER_HUE}, 90%, 70%, 0.35)`);
      edge.addColorStop(1, `hsla(${HUNTER_HUE}, 90%, 70%, 0)`);
      ctx.strokeStyle = edge;
      ctx.lineWidth = f.px;
      ctx.beginPath();
      for (const a of [h - 0.45, h + 0.45]) {
        ctx.moveTo(hs.x, hs.y);
        ctx.lineTo(hs.x + 95 * Math.cos(a), hs.y + 95 * Math.sin(a));
      }
      ctx.stroke();
      for (const p of prey) {
        if (!p.live) continue;
        const grow = p.bornAt === 0 ? 1 : easeOutBack(Math.min(1, ((tick - p.bornAt) * TICK_SECONDS) / POP_SECONDS));
        const gone = p.eatenAt < 0 ? 0 : Math.min(1, ((tick - p.eatenAt) * TICK_SECONDS) / CATCH_FADE_SECONDS);
        if (gone >= 1) continue;
        ctx.globalAlpha = 1 - gone;
        drawColoured(ctx, f.px, p.state, r * grow * (1 - 0.6 * gone), p.hue);
      }
      ctx.globalAlpha = 1;
      drawHunter(ctx, f.px, hs, r, fullness);
      drawBursts(ctx, f.px, bursts, tick, r);
      drawBirthRings(ctx, f.px, rings, tick, r);
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
