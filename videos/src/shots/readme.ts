// README loop, 7 s rendered (6 s after the loop crossfade): a close, static view of a small grazing crowd.
import { SFX, musicBed, writeMix } from "../lib/audio.ts";
import type { Cue } from "../lib/audio.ts";
import type { Ctx } from "../lib/critter.ts";
import { Crowd, SIM_DT } from "../lib/crowd.ts";
import type { Member } from "../lib/crowd.ts";
import { Effects } from "../lib/fx.ts";
import type { Shot, ShotOptions } from "../lib/shot.ts";
import { applyCamera, drawFloor, drawItem, vignette } from "../lib/stage.ts";

const WW = 200, WH = 112.5, R = 9, END = 7;

export default function make({ style, W, H }: ShotOptions): Shot {
  const fx = new Effects();
  const cues: Cue[] = [];
  let seed = 1;
  const crowd = new Crowd({ width: WW, height: WH, radius: R, families: [200, 22, 285, 335], perFamily: 2, cap: 9, food: 2.2, poison: 0.08, seed: 21 }, {
    eat(m: Member, it, t) { m.c.chew = 1; m.c.feel("happy", t, 0.8); m.c.jiggle(-0.35); fx.crumbs(it.x, it.y, R * 0.5, "#7dff9f", 6); fx.sparkle(m.c.x, m.c.y, R * 0.5, "#fff7b0", 4); cues.push({ t, sound: SFX.chomp(seed++), gain: 0.4 }); },
    poison(m, _it, t) { m.c.chew = 1; m.c.feel("sick", t, 1.5); fx.bubbles(m.c, 1.5); fx.exclaim(m.c, "!?", "#ff9bf2", 0.5); cues.push({ t, sound: SFX.uhoh(), gain: 0.4 }); },
    bump(a, b, speed, t) {
      for (const m of [a, b]) { m.c.feel("angry", t, 0.9); m.c.jiggle(-0.6, Math.atan2(b.c.y - a.c.y, b.c.x - a.c.x)); }
      fx.bonk((a.c.x + b.c.x) / 2, (a.c.y + b.c.y) / 2, R * 0.8);
      if (speed > 20) { fx.anger(a.c, 0.9); fx.anger(b.c, 0.9); }
      cues.push({ t, sound: SFX.bonk(), gain: 0.5 });
    },
    birth(p, child, t) { p.c.feel("joy", t, 1); child.c.feel("happy", t + 0.3, 1); fx.hearts(p.c, 2); fx.ring(p.c.x, p.c.y, R, `hsl(${p.c.hue}, 90%, 72%)`, 0.8, 0.14); cues.push({ t, sound: SFX.pop(1.4), gain: 0.5 }); },
  });
  for (let i = 0; i < 300; i++) crowd.step(-1);
  crowd.ghosts = [];
  for (const it of crowd.items) it.born = -1;
  let simT = 0;
  return {
    duration: END,
    mixAudio(file: string) { writeMix(file, END, cues, { sound: musicBed(END, 104, 8), gain: 0.8, fadeOut: 0.1 }); },
    frame(ctx: Ctx, t: number, dt: number) {
      fx.t = t;
      while (simT + SIM_DT <= t) { simT += SIM_DT; crowd.step(simT); }
      crowd.sync(t, dt, (t - simT) / SIM_DT);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#07140f";
      ctx.fillRect(0, 0, W, H);
      applyCamera(ctx, W, H, { x: WW / 2, y: WH / 2, zoom: 1 }, WH, t);
      drawFloor(ctx, style, WW, WH, t, 4);
      for (const it of crowd.items) drawItem(ctx, it, style, t);
      for (const g of crowd.ghosts) drawItem(ctx, g, style, t);
      for (const m of crowd.members) if (m.live) m.c.draw(ctx, style);
      fx.draw(ctx, t);
      vignette(ctx, W, H, 0.4);
    },
  };
}
