// Screen-space title cards: logo word, LIVE pill, URL line.
import type { Ctx } from "./critter.ts";
import { clamp, easeOutBack, smooth } from "./ease.ts";
import { roundRect, textSprite } from "./fx.ts";

const SPRITE_PX = 160;

// Draws outlined text from the sprite cache, centred at (x, y) with cap height about `size` px.
export function text(ctx: Ctx, s: string, x: number, y: number, size: number, fill: string, outline = "#0b1d16", alpha = 1, scale = 1): void {
  if (alpha <= 0 || scale <= 0) return;
  const spr = textSprite(s, fill, outline);
  const k = (size / SPRITE_PX) * scale;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.drawImage(spr, x - (spr.width / 2) * k, y - (spr.height / 2) * k, spr.width * k, spr.height * k);
  ctx.restore();
}

// The end card: "Evolve World" pops in letter group by group, a pulsing LIVE pill, then the URL.
export function titleCard(ctx: Ctx, W: number, H: number, age: number, opts: { sub?: string; url?: string; live?: boolean } = {}): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const dim = smooth(age / 0.5) * 0.55;
  ctx.fillStyle = `rgba(4, 14, 10, ${dim})`;
  ctx.fillRect(0, 0, W, H);
  const u = H / 1080;
  const pop = (d: number): number => easeOutBack(clamp((age - d) / 0.45), 2.2);
  text(ctx, "Evolve", W / 2 - 250 * u, H * 0.42, 170 * u, "#ffffff", "#0b1d16", clamp((age - 0.1) / 0.15), pop(0.1));
  text(ctx, "World", W / 2 + 270 * u, H * 0.42, 170 * u, "#7dffb0", "#0b1d16", clamp((age - 0.3) / 0.15), pop(0.3));
  if (opts.live) {
    const a = clamp((age - 0.7) / 0.2), s = pop(0.7);
    if (a > 0) {
      const pw = 190 * u * s, ph = 64 * u * s, x = W / 2 - pw / 2, y = H * 0.56 - ph / 2;
      const beat = 0.5 + 0.5 * Math.sin(age * 5);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = `rgba(255, 60, 80, ${0.85 + 0.15 * beat})`;
      roundRect(ctx, x, y, pw, ph, ph / 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(x + ph * 0.55, y + ph / 2, ph * (0.16 + 0.05 * beat), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      text(ctx, "LIVE", W / 2 + 18 * u * s, H * 0.56, 46 * u, "#ffffff", "#b3122a", a, s);
    }
  }
  if (opts.sub) text(ctx, opts.sub, W / 2, H * (opts.live ? 0.66 : 0.58), 56 * u, "#d9f7e6", "#0b1d16", clamp((age - 1.0) / 0.3), pop(1.0));
  if (opts.url) text(ctx, opts.url, W / 2, H * 0.8, 40 * u, "#9fe8c0", "#0b1d16", clamp((age - 1.4) / 0.4), 1);
}
