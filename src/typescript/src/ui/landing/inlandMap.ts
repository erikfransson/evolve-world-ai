import { createRng } from "../../sim/rng.ts";
import { makeCanvas } from "../canvas.ts";
import { FLOOR } from "../scene.ts";
import { FOOD, POISON } from "../palette.ts";
import { GRID, GRID_H, GRID_W } from "./inlandGrid.ts";
import { TICK_SECONDS, drawBirthRings, ticksOf } from "./kit.ts";
import type { Effect, RingLook, Scene } from "./kit.ts";

// Live World: the whole Inland Sea from above, a few hundred creatures of six lineages grazing its rich places, giving birth and dying out.
// The map is the real one (a picture and a coarse grid of rock, food and poison); the creatures are scripted, not the engine's.

const CELL = 10; // world units per grid cell
export const MAP_W = GRID_W * CELL;
export const MAP_H = GRID_H * CELL;
const HUES = [200, 20, 280, 50, 340, 160];
const PER_LINEAGE = 34;
export const MAP_CAP = 260;
const SPEED = 16; // world units per second
const LOOK = 26; // how far ahead a creature tastes the ground
const EDGE = 45; // ground this close to the map edge tastes worse, so crowds do not line the frame
const TURN = 2.2; // radians per second at most
const GAIN = 0.16; // energy per second on the richest ground
const DRAIN = 0.045; // energy per second
const POISON_COST = 0.2; // energy per second on the most poisoned ground
const BIRTH_AT = 1;
const MIN_AGE_S = 8; // before the first birth
const LIFE_S = [70, 140] as const;
const FADE_SECONDS = 1.2;
const HUE_DRIFT = 3; // degrees a child's colour moves, as in the live world
const FOLLOW_S = 9; // the followed creature changes this often (or when it dies)
const SPECKS_PER_FOOD = 0.08; // food specks per cell per food level above FOOD_SPECKS_FROM
const FOOD_SPECKS_FROM = 6; // of 15: only the richer ground shows food
const RING_LOOK: RingLook = { alpha: 0.9, lightness: 72, width: 1.6, shrink: 0.8, radius: 1.4, growth: 2.6, eased: false };

const cells = Uint8Array.from(atob(GRID), (c) => c.charCodeAt(0));
const cellAt = (x: number, y: number): number => {
  const i = Math.min(GRID_W - 1, Math.max(0, Math.floor(x / CELL)));
  const j = Math.min(GRID_H - 1, Math.max(0, Math.floor(y / CELL)));
  return cells[j * GRID_W + i]!;
};
export const rockAt = (x: number, y: number): boolean => x < 0 || y < 0 || x >= MAP_W || y >= MAP_H || (cellAt(x, y) & 0x80) !== 0;
const foodAt = (x: number, y: number): number => (cellAt(x, y) & 0x0f) / 15;
const poisonAt = (x: number, y: number): number => ((cellAt(x, y) >> 4) & 0x07) / 7;

interface Dot {
  x: number;
  y: number;
  h: number; // heading
  e: number; // energy 0..1
  hue: number;
  born: number; // tick
  dies: number; // tick of old age
  fading: number; // tick the fade began, -1 while alive
}

export interface MapScene extends Scene {
  background: CanvasImageSource | null; // the map picture, drawn under everything once it has loaded
  births: number;
  deaths: number;
  living(): number;
  dots(): readonly { x: number; y: number }[];
}

export function inlandMapScene(seed: number): MapScene {
  const rng = createRng(seed);
  const dots: Dot[] = [];
  const rings: Effect[] = [];
  let tick = 0;
  let followed: Dot | null = null;
  let followAt = 0;

  // Food and poison specks, placed once from the grid, so the rich places read at a glance.
  const specks: number[] = [];
  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      const c = cells[j * GRID_W + i]!;
      if (c & 0x80) continue;
      const n = Math.floor(Math.max(0, (c & 0x0f) - FOOD_SPECKS_FROM) * SPECKS_PER_FOOD + rng.next());
      for (let k = 0; k < n; k++) specks.push((i + rng.next()) * CELL, (j + rng.next()) * CELL, 0);
      if (((c >> 4) & 0x07) >= 3 && rng.next() < 0.5) specks.push((i + rng.next()) * CELL, (j + rng.next()) * CELL, 1);
    }
  }

  // A rich, clean open spot away from the edge; the map centre if a regenerated grid had none.
  const free = (): { x: number; y: number } => {
    for (let k = 0; k < 10000; k++) {
      const x = rng.range(0, MAP_W);
      const y = rng.range(0, MAP_H);
      if (!rockAt(x, y) && foodAt(x, y) > 0.6 && poisonAt(x, y) === 0 && x > 80 && x < MAP_W - 80 && y > 80 && y < MAP_H - 80) return { x, y };
    }
    return { x: MAP_W / 2, y: MAP_H / 2 };
  };
  const spawn = (x: number, y: number, hue: number, e: number): Dot => {
    const d: Dot = { x, y, h: rng.range(0, 2 * Math.PI), e, hue, born: tick, dies: tick + ticksOf(rng.range(LIFE_S[0], LIFE_S[1])), fading: -1 };
    dots.push(d);
    return d;
  };
  for (const hue of HUES) {
    const a = free();
    for (let k = 0; k < PER_LINEAGE; k++) {
      const x = a.x + rng.range(-50, 50);
      const y = a.y + rng.range(-35, 35);
      if (!rockAt(x, y)) spawn(x, y, (hue + rng.range(-8, 8) + 360) % 360, rng.range(0.3, 0.9)).born = -ticksOf(rng.range(0, 60));
    }
  }

  const living = (): number => dots.reduce((n, d) => n + (d.fading < 0 ? 1 : 0), 0);
  const dt = TICK_SECONDS;
  let cache: { w: number; h: number; bg: CanvasImageSource | null; canvas: OffscreenCanvas | HTMLCanvasElement | null } | null = null;

  const scene: MapScene = {
    background: null,
    births: 0,
    deaths: 0,
    living,
    dots: () => dots.filter((d) => d.fading < 0),
    step() {
      tick++;
      let alive = living();
      for (let k = dots.length - 1; k >= 0; k--) {
        const d = dots[k]!;
        if (d.fading >= 0) {
          if ((tick - d.fading) * dt > FADE_SECONDS) dots.splice(k, 1);
          continue;
        }
        // Taste the ground ahead, a little to each side, and turn toward the best.
        let best = 0;
        let bestV = -Infinity;
        for (const off of [-0.7, 0, 0.7]) {
          const a = d.h + off;
          const px = d.x + Math.cos(a) * LOOK;
          const py = d.y + Math.sin(a) * LOOK;
          const edge = Math.min(px, py, MAP_W - px, MAP_H - py) < EDGE ? 1.2 : 0;
          const v = rockAt(px, py) ? -1 : foodAt(px, py) - poisonAt(px, py) - edge + 0.35 * rng.next();
          if (v > bestV) { bestV = v; best = off; }
        }
        d.h += Math.max(-TURN * dt, Math.min(TURN * dt, best * 3 * dt)) + rng.range(-1, 1) * dt;
        const nx = d.x + Math.cos(d.h) * SPEED * dt;
        const ny = d.y + Math.sin(d.h) * SPEED * dt;
        if (rockAt(nx, ny)) d.h += Math.PI + rng.range(-0.8, 0.8); // turn back, so nobody slides along a shore or the edge
        else { d.x = nx; d.y = ny; }
        d.e = Math.min(1.2, d.e + (GAIN * foodAt(d.x, d.y) - DRAIN - POISON_COST * poisonAt(d.x, d.y)) * dt);
        if (d.e <= 0 || tick >= d.dies) {
          d.fading = tick;
          alive--;
          scene.deaths++;
          continue;
        }
        if (d.e >= BIRTH_AT && alive < MAP_CAP && (tick - d.born) * dt >= MIN_AGE_S) {
          d.e = 0.5;
          const a = rng.range(0, 2 * Math.PI);
          const cx = d.x + Math.cos(a) * 4;
          const cy = d.y + Math.sin(a) * 4;
          if (rockAt(cx, cy)) continue;
          spawn(cx, cy, (d.hue + rng.range(-HUE_DRIFT, HUE_DRIFT) + 360) % 360, 0.45).h = a;
          rings.push({ at: tick, x: d.x, y: d.y, hue: d.hue });
          alive++;
          scene.births++;
        }
      }
      if (!followed || followed.fading >= 0 || (tick - followAt) * dt > FOLLOW_S) {
        // Another living creature, picked at random.
        const was = followed;
        const pick = dots.filter((d) => d.fading < 0 && d !== was);
        followed = pick.length ? pick[Math.floor(rng.next() * pick.length)]! : was && was.fading < 0 ? was : null;
        followAt = tick;
      }
    },
    draw(ctx) {
      const cw = ctx.canvas.width;
      const ch = ctx.canvas.height;
      const k = cw / MAP_W;
      const css = Math.max(1, cw / Math.max(1, (ctx.canvas as HTMLCanvasElement).clientWidth || cw)); // device pixels per CSS pixel
      // The map and its specks, redrawn into a cached canvas only when the size or the picture changes.
      if (!cache || cache.w !== cw || cache.h !== ch || cache.bg !== scene.background) {
        const canvas = makeCanvas(cw, ch);
        const g = canvas?.getContext("2d") as CanvasRenderingContext2D | null | undefined;
        if (g) {
          g.fillStyle = FLOOR;
          g.fillRect(0, 0, cw, ch);
          if (scene.background) g.drawImage(scene.background, 0, 0, cw, MAP_H * k);
          const s = 0.9 * css;
          for (let i = 0; i < specks.length; i += 3) {
            g.globalAlpha = specks[i + 2] ? 0.7 : 0.4;
            g.fillStyle = specks[i + 2] ? POISON : FOOD;
            g.fillRect(specks[i]! * k - s / 2, specks[i + 1]! * k - s / 2, s, s);
          }
          g.globalAlpha = 1;
        }
        cache = { w: cw, h: ch, bg: scene.background, canvas };
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      if (cache.canvas) ctx.drawImage(cache.canvas, 0, 0);
      else {
        ctx.fillStyle = FLOOR;
        ctx.fillRect(0, 0, cw, ch);
      }
      const r = 2.6 * css;
      ctx.lineWidth = 0.9 * css;
      for (const d of dots) {
        const grow = Math.min(1, ((tick - d.born) * dt) / 0.4);
        ctx.globalAlpha = d.fading < 0 ? 1 : Math.max(0, 1 - ((tick - d.fading) * dt) / FADE_SECONDS);
        ctx.fillStyle = `hsl(${d.hue}, 80%, ${40 + 25 * Math.min(1, d.e)}%)`;
        ctx.strokeStyle = `hsl(${d.hue}, 90%, 82%)`;
        ctx.beginPath();
        ctx.arc(d.x * k, d.y * k, Math.max(0.1, r * (0.5 + 0.5 * grow)), 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.scale(k, k); // the rings are in world units
      drawBirthRings(ctx, css / k, rings, tick, r / k, RING_LOOK);
      ctx.restore();
      if (followed) {
        // The followed creature, ringed as the live page marks a selection.
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.4 * css;
        ctx.beginPath();
        ctx.arc(followed.x * k, followed.y * k, r + 3.5 * css, 0, 2 * Math.PI);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
  };
  return scene;
}
