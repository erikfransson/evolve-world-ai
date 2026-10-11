// Mini story, ~15 s: yum, poison, learning, avoiding, a bump, making up.
import { SFX, musicBed, voice, writeMix } from "../lib/audio.ts";
import type { Cue, Mono } from "../lib/audio.ts";
import { Critter } from "../lib/critter.ts";
import type { Ctx } from "../lib/critter.ts";
import { clamp, lerp, lerpAngle, noise1, path, rng, smooth, smoother, track } from "../lib/ease.ts";
import { Effects } from "../lib/fx.ts";
import type { Shot, ShotOptions } from "../lib/shot.ts";
import { applyCamera, drawFloor, drawItem, item, vignette } from "../lib/stage.ts";
import type { Item } from "../lib/stage.ts";

const WW = 320, WH = 180, R = 11;

export default function make({ style, W, H }: ShotOptions): Shot {
  const hero = new Critter(60, 120, R, 205, 1);
  const pal = new Critter(280, 60, R, 22, 2);
  const fx = new Effects();
  const heroPath = path([
    { t: 0, x: 40, y: 128 }, { t: 1.4, x: 92, y: 110 }, { t: 2.3, x: 128, y: 96 }, { t: 3.3, x: 152, y: 100 },
    { t: 4.2, x: 178, y: 90 }, { t: 5.0, x: 184, y: 91 }, { t: 8.4, x: 186, y: 93 }, { t: 9.0, x: 196, y: 103 },
    { t: 9.5, x: 203, y: 108.5 }, { t: 10.1, x: 204, y: 109.5 }, { t: 10.6, x: 211, y: 123 }, { t: 11.0, x: 222, y: 133 },
    { t: 11.5, x: 212, y: 130 }, { t: 12.85, x: 214, y: 129 }, { t: 13.9, x: 219, y: 127 }, { t: 15.5, x: 221, y: 126 },
  ]);
  const palPath = path([
    { t: 0, x: 300, y: 40 }, { t: 3, x: 280, y: 70 }, { t: 6, x: 290, y: 110 }, { t: 9, x: 287, y: 142 }, { t: 10.3, x: 268, y: 140 },
    { t: 11.0, x: 245, y: 134 }, { t: 11.5, x: 256, y: 136 }, { t: 12.85, x: 253, y: 133 }, { t: 13.9, x: 245, y: 129 }, { t: 15.5, x: 243, y: 128 },
  ]);
  const extras = [
    { c: new Critter(0, 0, R * 0.8, 285, 3), x: 70, y: 45, s: 3 },
    { c: new Critter(0, 0, R * 0.8, 50, 4), x: 250, y: 30, s: 4 },
    { c: new Critter(0, 0, R * 0.8, 340, 5), x: 120, y: 160, s: 5 },
    { c: new Critter(0, 0, R * 0.8, 150, 6), x: 30, y: 60, s: 6 },
  ];
  // Mouth position of the hero at time t, so the item sits where it gets eaten.
  const mouthAt = (t: number): { x: number; y: number } => {
    const p = heroPath(t), a = Math.atan2(p.vy, p.vx);
    return { x: p.x + Math.cos(a) * R * 1.05, y: p.y + Math.sin(a) * R * 1.05 };
  };
  const berry = (t: number, kind: "food" | "poison", seed: number): Item => { const m = mouthAt(t); return item(m.x, m.y, kind, R * 0.42, -1, seed); };
  const yum = berry(2.3, "food", 11), bad = berry(4.15, "poison", 12);
  const avoid = item(215, 118, "poison", R * 0.42, -1, 13);
  const items: Item[] = [yum, bad, avoid];
  // Scatter the rest, clear of both paths so nothing gets walked over.
  const sr = rng(77);
  const clear = (x: number, y: number): boolean => {
    for (let t = 0; t <= 15.5; t += 0.1) {
      const h = heroPath(t), p = palPath(t);
      if (Math.hypot(x - h.x, y - h.y) < R * 1.9 || Math.hypot(x - p.x, y - p.y) < R * 1.9) return false;
    }
    return items.every((o) => Math.hypot(x - o.x, y - o.y) > R * 1.6);
  };
  for (let k = 0; items.length < 36 && k < 2000; k++) {
    const x = 8 + sr() * (WW - 16), y = 8 + sr() * (WH - 16);
    if (clear(x, y)) items.push(item(x, y, sr() < 0.1 ? "poison" : "food", R * 0.42, -1, 20 + k));
  }


  const cues: Cue[] = [];
  let now = 0, camNowX = 160;
  // Sound at the current time, panned by where `x` sits on screen.
  const snd = (sound: Mono, gain = 1, x = camNowX, delay = 0): void => { cues.push({ t: now + delay, sound, gain, pan: clamp((x - camNowX) / 70, -0.45, 0.45) }); };
  const HV = 1.25, PV = 0.85; // voice pitch of hero and pal
  const events: [number, () => void][] = [
    [1.3, () => { snd(voice("surprised", HV, 1), 0.5, hero.x); snd(SFX.pop(1.3), 0.3, hero.x); hero.feel("surprised", 1.3, 0.5); fx.exclaim(hero, "!"); hero.jiggle(0.25, -Math.PI / 2); }],
    [2.3, () => { snd(SFX.nomnom(1), 0.7, hero.x); snd(SFX.yum(), 0.5, hero.x, 0.1); snd(SFX.sparkle(), 0.5, hero.x, 0.05); snd(voice("happy", HV, 2), 0.5, hero.x, 0.35); yum.eatenAt = 2.3; yum.eater = hero; hero.chew = 1; hero.feel("joy", 2.3, 1.1); hero.jiggle(-0.5); fx.crumbs(yum.x, yum.y, R * 0.5, "#7dff9f"); fx.sparkle(hero.x, hero.y, R * 0.7); fx.word("yum!", { x: hero.x - R * 0.5, y: hero.y - R * 2 }, R * 1.0, "#9dffb5"); }],
    [3.6, () => { hero.feel("happy", 3.6, 0.5); }],
    [4.15, () => { snd(SFX.nomnom(4), 0.7, hero.x); bad.eatenAt = 4.15; bad.eater = hero; hero.chew = 1; hero.feel("happy", 4.15, 0.3); }],
    [4.45, () => { snd(SFX.uhoh(), 0.45, hero.x); snd(SFX.boing(0.8), 0.3, hero.x); hero.feel("surprised", 4.45, 0.4); hero.jiggle(0.6, -Math.PI / 2); fx.exclaim(hero, "!?", "#ff9bf2", 0.45); }],
    [4.85, () => { snd(voice("sick", HV, 3), 0.5, hero.x); snd(SFX.bleh(), 0.25, hero.x, 0.15); hero.feel("sick", 4.85, 2.0); fx.bubbles(hero, 2.2); fx.word("bleh…", { x: hero.x + R * 1.3, y: hero.y - R * 2.1 }, R * 0.9, "#c4f27a", 1.3, 0.1); }],
    [6.0, () => { snd(voice("sad", HV, 4), 0.45, hero.x); hero.feel("sad", 6.0, 0.7); fx.sweat(hero, 1.0); }],
    [6.5, () => { snd(SFX.whoosh(0.4), 0.4, hero.x); snd(SFX.bleeps(7), 0.6, hero.x, 0.2); snd(voice("hmm", HV, 5), 0.35, hero.x, 0.1); hero.feel("focus", 6.5, 1.4); fx.brain(hero, 1.95); }],
    [7.9, () => { snd(SFX.ding(), 0.6, hero.x); snd(SFX.sparkle(9), 0.4, hero.x); snd(voice("happy", HV, 6), 0.5, hero.x, 0.15); fx.eureka(hero); hero.feel("joy", 7.9, 0.6); hero.jiggle(0.5, -Math.PI / 2); }],
    [9.5, () => { snd(SFX.pop(0.9), 0.25, hero.x); hero.feel("surprised", 9.5, 0.25); hero.jiggle(-0.3); }],
    [9.75, () => { hero.feel("focus", 9.75, 0.35); }],
    [10.0, () => { snd(SFX.nope(), 0.55, hero.x); hero.feel("happy", 10.0, 0.8); fx.word("nope!", { x: avoid.x + R * 0.3, y: avoid.y - R * 1.7 }, R * 0.85, "#ffd6fa", 1.0, 0.12); }],
    [11.0, () => { snd(SFX.bonk(), 0.9, (hero.x + pal.x) / 2);
      const mx = (hero.x + pal.x) / 2, my = (hero.y + pal.y) / 2;
      fx.bonk(mx, my, R * 1.1);
      hero.jiggle(-0.9, 0); pal.jiggle(-0.9, 0);
      hero.feel("surprised", 11.0, 0.3); pal.feel("surprised", 11.0, 0.3);
      fx.dizzy(pal, 1.0);
    }],
    [11.35, () => { snd(SFX.grr(1.1, 5), 0.5, hero.x); snd(voice("angry", PV, 7), 0.45, pal.x, 0.1); snd(SFX.steam(1.0), 0.15, pal.x, 0.2);
      hero.feel("angry", 11.35, 1.5); pal.feel("angry", 11.4, 1.45);
      fx.anger(hero, 1.4); fx.anger(pal, 1.4); fx.steam(pal, 1.2);
      fx.word("grr!", { x: (hero.x + pal.x) / 2, y: hero.y - R * 2.3 }, R * 1.0, "#ff8a7a", 1.2, -0.08);
    }],
    [12.9, () => { snd(SFX.aww(), 0.5); snd(voice("love", HV, 8), 0.4, hero.x, 0.1); snd(voice("love", PV, 9), 0.4, pal.x, 0.35);
      hero.feel("love", 12.9, 2.4); pal.feel("love", 12.95, 2.3);
      fx.hearts(hero, 3); fx.hearts(pal, 2);
    }],
  ];
  let ei = 0;

  const camX = track([{ t: 0, v: 160 }, { t: 1.6, v: 120 }, { t: 3.2, v: 160 }, { t: 5, v: 186 }, { t: 8.4, v: 190 }, { t: 10.0, v: 208 }, { t: 11.0, v: 230 }, { t: 13.0, v: 234 }, { t: 15.5, v: 200 }]);
  const camY = track([{ t: 0, v: 90 }, { t: 1.6, v: 100 }, { t: 5, v: 80 }, { t: 8.4, v: 80 }, { t: 10.0, v: 108 }, { t: 11.0, v: 122 }, { t: 13.0, v: 122 }, { t: 15.5, v: 100 }]);
  const camZ = track([{ t: 0, v: 1.0 }, { t: 1.8, v: 1.55 }, { t: 4.2, v: 1.9 }, { t: 6.2, v: 2.3 }, { t: 8.4, v: 2.2 }, { t: 9.7, v: 2.5 }, { t: 10.5, v: 2.2 }, { t: 11.0, v: 2.4 }, { t: 13.2, v: 2.6 }, { t: 15.5, v: 1.45 }]);
  const END = 15.5;

  return {
    duration: END,
    mixAudio(file: string) { writeMix(file, END, cues, { sound: musicBed(END, 104), gain: 0.8, fadeOut: 1.2 }); },
    frame(ctx: Ctx, t: number, dt: number) {
      fx.t = t;
      now = t;
      while (ei < events.length && events[ei]![0] <= t) events[ei++]![1]();
      const hp = heroPath(t);
      hero.moveTo(hp.x, hp.y, hp.vx, hp.vy);
      hero.shake = t > 4.85 && t < 6.4 ? 0.5 : t > 11.35 && t < 12.8 ? 0.7 : 0;
      pal.shake = t > 11.35 && t < 12.8 ? 0.7 : 0;
      const lookAt = (it: Item): void => { hero.lookX = clamp((it.x - hero.x) / 15, -1, 1); hero.lookY = clamp((it.y - hero.y) / 15, -1, 1); };
      if (t > 1.3 && t < 2.3) lookAt(yum);
      else if (t > 3.4 && t < 4.15) lookAt(bad);
      else if (t > 9.3 && t < 9.75) lookAt(avoid);
      else if (t >= 9.75 && t < 10.15) { hero.lookX = Math.sin((t - 9.75) * 30); hero.lookY = 0; } // eyes shake "no no"
      else if (t > 10.4 && t < 11.0) { hero.lookX = 1; hero.lookY = 0.3; }
      else { hero.lookX = 0; hero.lookY = 0; }
      const pp = palPath(t);
      pal.moveTo(pp.x, pp.y, pp.vx, pp.vy);
      if (t > 11.0) { pal.heading = lerpAngle(pal.heading, Math.PI, 0.15); hero.heading = lerpAngle(hero.heading, 0, 0.15); }
      hero.energy = t < 2.3 ? 0.45 : t < 4.85 ? 0.75 : t < 7.9 ? 0.4 : 0.6;
      hero.update(t, dt); pal.update(t, dt);
      for (const e of extras) {
        const x = e.x + 18 * noise1(t * 0.4, e.s), y = e.y + 12 * noise1(t * 0.4, e.s + 50);
        const vx = 18 * 0.4 * (noise1(t * 0.4 + 0.01, e.s) - noise1(t * 0.4, e.s)) * 100, vy = 12 * 0.4 * (noise1(t * 0.4 + 0.01, e.s + 50) - noise1(t * 0.4, e.s + 50)) * 100;
        e.c.moveTo(x, y, vx, vy);
        e.c.update(t, dt);
      }
      const follow = smooth((t - 1.2) / 1.0) * (1 - smooth((t - 14.4) / 1.1));
      const cam = { x: lerp(160, camX(t), follow), y: lerp(90, camY(t), follow), zoom: camZ(t), shake: t > 11.0 && t < 11.25 ? 1.2 * (1 - (t - 11.0) / 0.25) : 0 };
      camNowX = cam.x;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = style === "neon" ? "#020504" : "#07140f";
      ctx.fillRect(0, 0, W, H);
      applyCamera(ctx, W, H, cam, WH, t);
      drawFloor(ctx, style, WW, WH, t);
      for (const it of items) drawItem(ctx, it, style, t);
      for (const e of extras) e.c.draw(ctx, style);
      pal.draw(ctx, style);
      hero.draw(ctx, style);
      fx.draw(ctx, t);
      vignette(ctx, W, H, style === "classic" ? 0.25 : 0.55);
      // Fade in and out.
      const fade = smoother(t / 0.4) * smoother((END - t) / 0.5);
      if (fade < 1) { ctx.fillStyle = `rgba(0, 0, 0, ${1 - fade})`; ctx.fillRect(0, 0, W, H); }
    },
  };
}
