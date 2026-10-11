// Cheap soft shapes from radial gradients; shadowBlur is slow on the CPU rasterizer.
import type { Ctx } from "./critter.ts";

export function softShadow(ctx: Ctx, x: number, y: number, rx: number, ry: number, alpha = 0.45): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, `rgba(0, 10, 6, ${alpha})`);
  g.addColorStop(0.55, `rgba(0, 10, 6, ${alpha * 0.6})`);
  g.addColorStop(1, "rgba(0, 10, 6, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(-rx, -rx, 2 * rx, 2 * rx);
  ctx.restore();
}

// Additive halo; `rgb` like "77, 255, 154".
export function glow(ctx: Ctx, x: number, y: number, r: number, rgb: string, alpha = 0.6): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb}, ${alpha})`);
  g.addColorStop(0.35, `rgba(${rgb}, ${alpha * 0.35})`);
  g.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
}
