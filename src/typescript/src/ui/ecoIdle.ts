import { itemCounts } from "../sim/config.ts";
import { startRng } from "../sim/ecoConfig.ts";
import type { EcoConfig } from "../sim/ecoConfig.ts";
import { HIT_FOOD, HIT_POISON } from "../sim/types.ts";
import { World } from "../sim/world.ts";
import { terrainOf } from "../sim/terrain.ts";
import { BACKGROUND, FLOOR, FOOD, POISON, WALL } from "./scene.ts";
import { drawTerrain } from "./terrainScene.ts";

const MARGIN = 12; // CSS px around the world
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// The starting items as the run will scatter them (same seed and stream), rebuilt only when the settings that shape them change.
let cached: { key: string; world: World | null } = { key: "", world: null };
export function startItems(config: EcoConfig): World | null {
  const { food, poison } = itemCounts(config);
  const key = [config.seed, config.world.width, config.world.height, config.world.itemRadius, config.creature.rayLength, food, poison].join();
  if (cached.key === key) return cached.world;
  let world: World | null = null;
  try {
    world = new World(config, food + poison);
    world.scatter(food, poison, startRng(config));
  } catch (error) {
    console.warn("No preview for these settings:", error);
  }
  cached = { key, world };
  return world;
}

function drawItems(ctx: CanvasRenderingContext2D, world: World, config: EcoConfig, x: number, y: number, scale: number, dpr: number): void {
  const r = Math.max(config.world.itemRadius * scale, 0.9 * dpr);
  for (const [kind, color] of [[HIT_FOOD, FOOD], [HIT_POISON, POISON]] as const) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    for (let i = 0; i < world.count; i++) {
      if (world.kinds[i] !== kind) continue;
      const cx = x + world.xs[i]! * scale;
      const cy = y + world.ys[i]! * scale;
      ctx.moveTo(cx + r, cy);
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// The world with its starting food and poison fitted into the canvas, drawn before a run starts. w and h are canvas pixels.
export function drawIdleWorld(ctx: CanvasRenderingContext2D, config: EcoConfig, w: number, h: number, dpr: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, w, h);
  const scale = Math.min((w - 2 * MARGIN * dpr) / config.world.width, (h - 2 * MARGIN * dpr) / config.world.height);
  if (!(scale > 0)) return;
  const ww = config.world.width * scale;
  const wh = config.world.height * scale;
  const x = (w - ww) / 2;
  const y = (h - wh) / 2;
  ctx.fillStyle = FLOOR;
  ctx.fillRect(x, y, ww, wh);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  drawTerrain(ctx, terrainOf(config), scale, undefined, true);
  ctx.restore();
  const items = startItems(config);
  if (items) drawItems(ctx, items, config, x, y, scale, dpr);
  ctx.strokeStyle = WALL;
  ctx.lineWidth = 2 * dpr;
  ctx.strokeRect(x, y, ww, wh);
  ctx.fillStyle = "rgba(11, 29, 22, 0.8)"; // plate so the label stays readable over the items
  ctx.beginPath();
  ctx.roundRect(w / 2 - 80 * dpr, h / 2 - 28 * dpr, 160 * dpr, 56 * dpr, 10 * dpr);
  ctx.fill();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(143, 174, 159, 0.85)";
  ctx.font = `500 ${15 * dpr}px ${FONT}`;
  ctx.fillText(`${config.world.width} × ${config.world.height}`, w / 2, h / 2 - 10 * dpr);
  ctx.fillStyle = "rgba(143, 174, 159, 0.6)";
  ctx.font = `${13 * dpr}px ${FONT}`;
  ctx.fillText("Press Start", w / 2, h / 2 + 12 * dpr);
}
