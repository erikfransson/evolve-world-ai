// Live World, ~16 s: a busy shared world from the real simulation; the camera follows one creature through
// meals, bumps and a birth, pulls out wide, and ends on the title.
import { SFX, musicBed, voice, writeMix } from "../lib/audio.ts";
import type { Cue, Mono } from "../lib/audio.ts";
import type { Ctx } from "../lib/critter.ts";
import { Crowd, SIM_DT } from "../lib/crowd.ts";
import type { Member } from "../lib/crowd.ts";
import { clamp, lerp, smoother, track } from "../lib/ease.ts";
import { Effects } from "../lib/fx.ts";
import type { Shot, ShotOptions } from "../lib/shot.ts";
import { applyCamera, drawFloor, drawItem, vignette } from "../lib/stage.ts";
import { titleCard } from "../lib/titles.ts";

const WW = 400, WH = 225, R = 9, END = 16, TITLE = 12.2;

export default function make({ style, W, H }: ShotOptions): Shot {
  const fx = new Effects();
  const cues: Cue[] = [];
  let now = 0, cam = { x: WW / 2, y: WH / 2, zoom: 1 };
  const view = (): number => WH / cam.zoom; // visible world height
  // Louder near the camera centre, panned by screen position.
  const snd = (sound: Mono, gain: number, x: number, y: number, delay = 0): void => {
    const d = Math.hypot(x - cam.x, y - cam.y) / view();
    const g = gain * clamp(1.2 - 1.6 * d, 0, 1);
    if (g > 0.02) cues.push({ t: now + delay, sound, gain: g, pan: clamp(((x - cam.x) / view()) * 1.6, -0.45, 0.45) });
  };
  const near = (m: Member): boolean => Math.hypot(m.c.x - cam.x, m.c.y - cam.y) < view() * 0.7;
  let seed = 1;
  const crowd = new Crowd({ width: WW, height: WH, radius: R, families: [200, 22, 285, 48, 335], perFamily: 3, cap: 18, food: 3.4, poison: 0.07, seed: 7 }, {
    eat(m, it, t) {
      m.c.chew = 1;
      m.c.feel("happy", t, 0.7);
      m.c.jiggle(-0.3);
      if (near(m)) fx.crumbs(it.x, it.y, R * 0.5, "#7dff9f", 6);
      snd(SFX.chomp(seed++), 0.35, m.c.x, m.c.y);
      if (m === star && t > 1) { fx.sparkle(m.c.x, m.c.y, R * 0.6, "#fff7b0", 5); snd(voice("happy", 1.25, seed++), 0.35, m.c.x, m.c.y, 0.1); }
    },
    poison(m, _it, t) {
      m.c.chew = 1;
      m.c.feel("surprised", t, 0.3);
      m.c.feel("sick", t + 0.3, 1.6);
      m.c.jiggle(0.6, -Math.PI / 2);
      if (near(m)) { fx.bubbles(m.c, 1.8); fx.exclaim(m.c, "!?", "#ff9bf2", 0.5); }
      snd(SFX.uhoh(), 0.4, m.c.x, m.c.y);
      snd(voice("sick", 1.1, seed++), 0.35, m.c.x, m.c.y, 0.3);
    },
    bump(a, b, speed, t) {
      const mx = (a.c.x + b.c.x) / 2, my = (a.c.y + b.c.y) / 2;
      const big = speed > 25;
      for (const m of [a, b]) { m.c.feel("surprised", t, 0.25); m.c.feel("angry", t + 0.25, big ? 1.1 : 0.7); m.c.jiggle(-0.6, Math.atan2(b.c.y - a.c.y, b.c.x - a.c.x)); }
      if (near(a)) { fx.bonk(mx, my, R * (big ? 1.0 : 0.7)); if (big) { fx.anger(a.c, 1.0); fx.anger(b.c, 1.0); } }
      snd(SFX.bonk(), big ? 0.6 : 0.35, mx, my);
      if (big) snd(voice("angry", 0.9, seed++), 0.35, mx, my, 0.2);
    },
    birth(p, child, t) {
      p.c.feel("joy", t, 1.0);
      p.c.jiggle(0.7, -Math.PI / 2);
      child.c.feel("surprised", t, 0.4);
      child.c.feel("happy", t + 0.4, 1.0);
      fx.ring(p.c.x, p.c.y, R * 1.1, `hsl(${p.c.hue}, 90%, 72%)`, 0.8, 0.14);
      if (near(p)) { fx.hearts(p.c, 2); fx.sparkle(child.c.x, child.c.y, R * 0.5, "#ffffff", 6); }
      snd(SFX.pop(1.4), 0.5, p.c.x, p.c.y);
      snd(SFX.aww(), 0.25, p.c.x, p.c.y, 0.1);
      snd(voice("love", 1.2, seed++), 0.3, p.c.x, p.c.y, 0.15);
    },
  });
  const star = crowd.members[0]!;
  // Warm up so the scene starts mid-action.
  for (let i = 0; i < 240; i++) crowd.step(-1);
  for (const m of crowd.members) m.bornAt = m.live ? -999 : m.bornAt;
  crowd.ghosts = [];
  for (const it of crowd.items) it.born = -1;

  const zoom = track([{ t: 0, v: 1.0 }, { t: 2.5, v: 1.0 }, { t: 5.0, v: 2.1 }, { t: 9.5, v: 2.3 }, { t: 11.8, v: 1.05 }, { t: END, v: 1.0 }]);
  const follow = track([{ t: 0, v: 0 }, { t: 2.5, v: 0 }, { t: 5.0, v: 1 }, { t: 9.5, v: 1 }, { t: 11.8, v: 0 }]);
  let simT = 0, fx0 = WW / 2, fy0 = WH / 2;

  return {
    duration: END,
    mixAudio(file: string) {
      cues.push({ t: TITLE, sound: SFX.whoosh(0.5), gain: 0.35 }, { t: TITLE + 0.1, sound: SFX.pop(1.0), gain: 0.4 }, { t: TITLE + 0.3, sound: SFX.pop(1.2), gain: 0.4 }, { t: TITLE + 0.7, sound: SFX.ding(), gain: 0.4 });
      writeMix(file, END, cues, { sound: musicBed(END, 104, 5), gain: 0.8, fadeOut: 1.5 });
    },
    frame(ctx: Ctx, t: number, dt: number) {
      now = t;
      fx.t = t;
      while (simT + SIM_DT <= t) { simT += SIM_DT; crowd.step(simT); }
      crowd.sync(t, dt, (t - simT) / SIM_DT);
      // The camera eases toward the star with a little lag.
      const k = 1 - Math.exp(-3 * dt);
      fx0 += (star.c.x - fx0) * k; fy0 += (star.c.y - fy0) * k;
      const f = smoother(follow(t));
      const z = zoom(t);
      const halfW = (WH * (W / H)) / (2 * z), halfH = WH / (2 * z);
      cam = {
        x: clamp(lerp(WW / 2, fx0, f), Math.min(halfW, WW / 2), Math.max(WW - halfW, WW / 2)),
        y: clamp(lerp(WH / 2, fy0, f), Math.min(halfH, WH / 2), Math.max(WH - halfH, WH / 2)),
        zoom: z,
      };
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = style === "neon" ? "#020504" : "#07140f";
      ctx.fillRect(0, 0, W, H);
      applyCamera(ctx, W, H, cam, WH * 1.06, t);
      drawFloor(ctx, style, WW, WH, t);
      for (const it of crowd.items) drawItem(ctx, it, style, t);
      for (const g of crowd.ghosts) drawItem(ctx, g, style, t);
      for (const m of crowd.members) if (m.live && m !== star) m.c.draw(ctx, style);
      if (star.live) star.c.draw(ctx, style);
      fx.draw(ctx, t);
      vignette(ctx, W, H, style === "classic" ? 0.25 : 0.5);
      if (t >= TITLE) titleCard(ctx, W, H, t - TITLE, { live: true, sub: "a shared world, evolving right now", url: "erikfransson.github.io/evolve-world-ai" });
      const fade = smoother(t / 0.5) * smoother((END - t) / 0.6);
      if (fade < 1) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = `rgba(0, 0, 0, ${1 - fade})`; ctx.fillRect(0, 0, W, H); }
    },
  };
}
