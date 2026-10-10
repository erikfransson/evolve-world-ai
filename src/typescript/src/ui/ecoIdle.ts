import type { EcoConfig } from "../sim/ecoConfig.ts";
import { BACKGROUND, FLOOR, WALL } from "./scene.ts";

const MARGIN = 12; // CSS px around the world
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// The empty world fitted into the canvas, drawn before a run starts. w and h are canvas pixels.
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
  ctx.strokeStyle = WALL;
  ctx.lineWidth = 2 * dpr;
  ctx.strokeRect(x, y, ww, wh);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(143, 174, 159, 0.85)";
  ctx.font = `500 ${15 * dpr}px ${FONT}`;
  ctx.fillText(`${config.world.width} × ${config.world.height}`, w / 2, h / 2 - 10 * dpr);
  ctx.fillStyle = "rgba(143, 174, 159, 0.6)";
  ctx.font = `${13 * dpr}px ${FONT}`;
  ctx.fillText("Press Start", w / 2, h / 2 + 12 * dpr);
}
