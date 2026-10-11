import { createRng } from "../../sim/rng.ts";
import { BACKGROUND, FOOD, OTHER } from "../palette.ts";
import { beginFrame } from "../scene.ts";
import { TICK_SECONDS, clamp, sceneConfig } from "./kit.ts";
import type { Scene } from "./kit.ts";

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
