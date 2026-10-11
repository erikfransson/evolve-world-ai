// The Great Hunt, ~13 s: a hunter sneaks up on a grazer, a chase, the grazer hides with its family,
// four glares send the hunter off sulking.
import { SFX, SNEAKY, drums, layer, musicBed, voice, writeMix } from "../lib/audio.ts";
import type { Cue, Mono } from "../lib/audio.ts";
import { Critter } from "../lib/critter.ts";
import type { Ctx } from "../lib/critter.ts";
import { clamp, lerp, lerpAngle, noise1, path, rng, smoother, track } from "../lib/ease.ts";
import { Effects } from "../lib/fx.ts";
import type { Shot, ShotOptions } from "../lib/shot.ts";
import { applyCamera, clampCamera, drawFloor, drawItem, item, vignette } from "../lib/stage.ts";
import type { Item } from "../lib/stage.ts";

const WW = 320, WH = 180, R = 11, END = 13;

export default function make({ style, W, H }: ShotOptions): Shot {
  const fx = new Effects();
  const prey = new Critter(150, 95, R, 205, 1);
  const hunter = new Critter(20, 60, R * 1.1, 2, 2);
  hunter.hunter = true;
  hunter.base = "focus";
  const fam = [{ x: 110, y: 110 }, { x: 140, y: 152 }, { x: 103, y: 139 }].map((p, i) => ({ ...p, c: new Critter(p.x, p.y, R, 205 + (i - 1) * 14, 10 + i) }));
  const preyPath = path([
    { t: 0, x: 148, y: 96 }, { t: 1.5, x: 156, y: 92 }, { t: 3.2, x: 160, y: 92 }, { t: 3.9, x: 161, y: 90 },
    { t: 4.4, x: 185, y: 76 }, { t: 4.9, x: 220, y: 70 }, { t: 5.4, x: 244, y: 92 }, { t: 5.9, x: 228, y: 124 },
    { t: 6.4, x: 192, y: 136 }, { t: 6.9, x: 158, y: 130 }, { t: 7.3, x: 130, y: 128 }, { t: 9.5, x: 129, y: 128 }, { t: END, x: 128, y: 127 },
  ]);
  const hunterPath = path([
    { t: 0, x: -20, y: 60 }, { t: 1.6, x: 55, y: 70 }, { t: 3.2, x: 112, y: 84 }, { t: 3.9, x: 118, y: 86 },
    { t: 4.5, x: 140, y: 86 }, { t: 5.0, x: 182, y: 72 }, { t: 5.5, x: 226, y: 72 }, { t: 5.85, x: 258, y: 90 }, { t: 6.3, x: 240, y: 124 },
    { t: 6.8, x: 208, y: 136 }, { t: 7.3, x: 180, y: 134 }, { t: 7.7, x: 168, y: 131 }, { t: 8.6, x: 170, y: 130 },
    { t: 9.4, x: 196, y: 118 }, { t: 11, x: 246, y: 86 }, { t: END, x: 262, y: 72 },
  ]);
  const items: Item[] = [];
  const sr = rng(31);
  const clear = (x: number, y: number): boolean => {
    for (let t = 0; t <= END; t += 0.1) {
      const a = preyPath(t), b = hunterPath(t);
      if (Math.hypot(x - a.x, y - a.y) < R * 2 || Math.hypot(x - b.x, y - b.y) < R * 2.2) return false;
    }
    return fam.every((f) => Math.hypot(x - f.x, y - f.y) > R * 2) && items.every((o) => Math.hypot(x - o.x, y - o.y) > R * 1.6);
  };
  const snack = item(162, 96, "food", R * 0.42, -1, 5); // the meal before the chase
  items.push(snack);
  for (let k = 0; items.length < 30 && k < 3000; k++) {
    const x = 8 + sr() * (WW - 16), y = 8 + sr() * (WH - 16);
    if (clear(x, y)) items.push(item(x, y, sr() < 0.08 ? "poison" : "food", R * 0.42, -1, 40 + k));
  }

  const cues: Cue[] = [];
  let now = 0, camX = 150;
  const snd = (sound: Mono, gain = 1, x = camX, delay = 0): void => { cues.push({ t: now + delay, sound, gain, pan: clamp((x - camX) / 70, -0.45, 0.45) }); };

  const events: [number, () => void][] = [
    [0.9, () => { snack.eatenAt = 0.9; snack.eater = prey; prey.chew = 1; prey.feel("happy", 0.9, 1.6); fx.crumbs(snack.x, snack.y, R * 0.5, "#7dff9f"); snd(SFX.nomnom(2), 0.6, prey.x); snd(voice("happy", 1.25, 1), 0.4, prey.x, 0.35); }],
    [2.6, () => { hunter.feel("happy", 2.6, 0.9); fx.word("hehe", { x: hunter.x, y: hunter.y - R * 2.1 }, R * 0.75, "#ffb0a0", 0.9, -0.1); snd(voice("happy", 0.75, 2), 0.35, hunter.x); }],
    [3.45, () => { prey.feel("surprised", 3.45, 0.5); prey.jiggle(0.9, -Math.PI / 2); fx.exclaim(prey, "!", "#ffd23f", 0.6); snd(SFX.boing(1.1), 0.5, prey.x); snd(voice("surprised", 1.3, 3), 0.5, prey.x); }],
    [3.95, () => { prey.feel("scared", 3.95, 3.3); fx.sweat(prey, 1.2); fx.puff(prey.x, prey.y + R * 0.6, R * 0.8); fx.speed(prey, 3.2); snd(SFX.whoosh(0.35), 0.5, prey.x); }],
    [4.1, () => { hunter.feel("angry", 4.1, 3.4, 0.6); fx.speed(hunter, 3.4, "rgba(255, 200, 190, 0.5)"); fx.puff(hunter.x, hunter.y + R * 0.6, R * 0.8); snd(voice("angry", 0.7, 4), 0.35, hunter.x); }],
    [5.85, () => { fx.puff(hunter.x, hunter.y, R * 1.0, 7); snd(SFX.steam(0.3), 0.3, hunter.x); hunter.jiggle(-0.5); }],
    [7.3, () => { prey.jiggle(-0.6); fx.puff(prey.x, prey.y, R * 0.6); }],
    [7.55, () => {
      for (const f of fam) { f.c.feel("angry", 7.55, 2.0); fx.anger(f.c, 1.8); }
      prey.feel("angry", 7.7, 1.8);
      fx.word("HEY!", { x: 128, y: 104 }, R * 1.1, "#ff8a7a", 1.2, -0.06);
      snd(voice("angry", 1.0, 5), 0.45, 125); snd(voice("angry", 1.15, 6), 0.4, 140, 0.08); snd(voice("angry", 0.9, 7), 0.4, 118, 0.15);
    }],
    [7.65, () => { hunter.feel("surprised", 7.65, 0.5); hunter.jiggle(0.8, -Math.PI / 2); fx.exclaim(hunter, "!?", "#ffd23f", 0.6); snd(SFX.boing(0.7), 0.4, hunter.x); }],
    [8.15, () => { hunter.feel("scared", 8.15, 1.2); fx.sweat(hunter, 1.2); fx.word("eep", { x: hunter.x + R, y: hunter.y - R * 2 }, R * 0.7, "#ffe0a0", 0.9, 0.1); snd(voice("surprised", 0.8, 8), 0.4, hunter.x); }],
    [9.4, () => { hunter.feel("sad", 9.4, 3.6); snd(voice("sad", 0.75, 9), 0.4, hunter.x); }],
    [9.6, () => { for (const f of [prey, ...fam.map((g) => g.c)]) f.feel("joy", 9.6, 1.6); fx.hearts(prey, 3); fx.sparkle(132, 132, R * 0.8); snd(SFX.yum(), 0.4, 130); snd(voice("love", 1.25, 10), 0.4, 132, 0.1); }],
    [11.3, () => { prey.feel("happy", 11.3, 1.7); fx.sweat(prey, 0.9); fx.word("phew", { x: prey.x + R * 0.3, y: prey.y - R * 2.1 }, R * 0.7, "#c9f5ff", 1.0, -0.1); }],
  ];
  let ei = 0;

  // Camera: on the grazer, reveal the sneak, punch in on the scare, ride the chase, the family, the sulk.
  const cx = track([{ t: 0, v: 150 }, { t: 1.5, v: 150 }, { t: 3.0, v: 120 }, { t: 3.45, v: 160 }, { t: 3.9, v: 160 }, { t: 7.2, v: 150 }, { t: 9.3, v: 145 }, { t: 10.8, v: 205 }, { t: END, v: 215 }]);
  const cy = track([{ t: 0, v: 94 }, { t: 3.0, v: 84 }, { t: 3.45, v: 90 }, { t: 3.9, v: 90 }, { t: 7.2, v: 118 }, { t: 9.3, v: 122 }, { t: 10.8, v: 100 }, { t: END, v: 95 }]);
  const cz = track([{ t: 0, v: 2.3 }, { t: 1.5, v: 2.1 }, { t: 3.0, v: 1.45 }, { t: 3.45, v: 2.6 }, { t: 3.9, v: 2.3 }, { t: 4.6, v: 1.25 }, { t: 6.6, v: 1.3 }, { t: 7.6, v: 2.0 }, { t: 9.3, v: 2.1 }, { t: 10.8, v: 1.5 }, { t: END, v: 1.4 }]);
  const chase = (t: number): number => smoother((t - 4.0) / 0.4) * (1 - smoother((t - 6.8) / 0.5));

  return {
    duration: END,
    mixAudio(file: string) {
      const bed = musicBed(END, 120, 11, SNEAKY);
      layer(bed, drums(END, 140, 3.95, 7.3), 0.9);
      writeMix(file, END, cues, { sound: bed, gain: 0.8, fadeOut: 1.2 });
    },
    frame(ctx: Ctx, t: number, dt: number) {
      now = t; fx.t = t;
      while (ei < events.length && events[ei]![0] <= t) events[ei++]![1]();
      const p = preyPath(t), h = hunterPath(t);
      prey.moveTo(p.x, p.y, p.vx, p.vy);
      hunter.moveTo(h.x, h.y, h.vx, h.vy);
      prey.shake = t > 3.95 && t < 7.3 ? 0.4 : 0;
      hunter.shake = t > 8.15 && t < 9.4 ? 0.5 : 0;
      // Eyes: the grazer watches its snack, then the hunter; the hunter stares at the grazer.
      const look = (c: Critter, x: number, y: number): void => { c.lookX = clamp((x - c.x) / 15, -1, 1); c.lookY = clamp((y - c.y) / 15, -1, 1); };
      if (t < 0.9) look(prey, snack.x, snack.y); else if (t > 3.45) look(prey, hunter.x, hunter.y); else { prey.lookX = 0; prey.lookY = 0; }
      if (t < 9.4) look(hunter, prey.x, prey.y); else { hunter.lookX = -0.6; hunter.lookY = 0.4; }
      // Facing: at rest they turn to face each other.
      if (t > 7.3 && t < 9.3) hunter.heading = lerpAngle(hunter.heading, Math.PI, 0.1);
      if (t > 7.3) prey.heading = lerpAngle(prey.heading, t < 9.4 ? 0 : -Math.PI / 2, 0.1);
      prey.update(t, dt); hunter.update(t, dt);
      for (const [i, f] of fam.entries()) {
        const x = f.x + 1.5 * noise1(t * 0.7, i + 3), y = f.y + 1.5 * noise1(t * 0.7, i + 9);
        f.c.moveTo(x, y, 0, 0);
        f.c.heading = lerpAngle(f.c.heading, t > 7.2 && t < 9.5 ? Math.atan2(hunter.y - y, hunter.x - x) : -Math.PI / 2 + (i - 1) * 0.6, 0.08);
        if (t > 7.2 && t < 9.5) { f.c.lookX = clamp((hunter.x - x) / 20, -1, 1); f.c.lookY = clamp((hunter.y - y) / 20, -1, 1); } else { f.c.lookX = 0; f.c.lookY = 0; }
        f.c.update(t, dt);
      }
      // The chase camera rides the midpoint of the two.
      const k = chase(t);
      const cam = clampCamera({
        x: lerp(cx(t), (p.x + h.x) / 2, k), y: lerp(cy(t), (p.y + h.y) / 2, k), zoom: cz(t),
        rot: 0.03 * Math.sin(t * 1.3) * k, shake: t > 3.45 && t < 3.7 ? 0.6 : 0,
      }, W, H, WH, WW, WH);
      camX = cam.x;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = style === "neon" ? "#020504" : "#07140f";
      ctx.fillRect(0, 0, W, H);
      applyCamera(ctx, W, H, cam, WH, t);
      drawFloor(ctx, style, WW, WH, t, 9);
      for (const it of items) drawItem(ctx, it, style, t);
      for (const f of fam) f.c.draw(ctx, style);
      prey.draw(ctx, style);
      hunter.draw(ctx, style);
      fx.draw(ctx, t);
      vignette(ctx, W, H, style === "classic" ? 0.25 : 0.55);
      const fade = smoother(t / 0.4) * smoother((END - t) / 0.5);
      if (fade < 1) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = `rgba(0, 0, 0, ${1 - fade})`; ctx.fillRect(0, 0, W, H); }
    },
  };
}
