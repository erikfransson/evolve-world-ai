// Watch them learn, ~16 s: generation 1 bumbles (spins, bonks walls, eats poison); a dive into the brain while
// the generation counter rolls; generation 200 zips between berries and dodges poison; title.
import { SFX, musicBed, voice, writeMix } from "../lib/audio.ts";
import type { Cue, Mono } from "../lib/audio.ts";
import { Critter } from "../lib/critter.ts";
import type { Ctx } from "../lib/critter.ts";
import { clamp, easeInOut, easeOutBack, lerp, noise1, rng, smooth, smoother, wrapAngle } from "../lib/ease.ts";
import { Effects, roundRect } from "../lib/fx.ts";
import type { Shot, ShotOptions } from "../lib/shot.ts";
import { applyCamera, drawFloor, drawItem, item, vignette } from "../lib/stage.ts";
import type { Item } from "../lib/stage.ts";
import { text, titleCard } from "../lib/titles.ts";

const WW = 320, WH = 180, R = 10, STEP = 1 / 120;
const GEN1 = [0.3, 5.6], DIVE = [5.6, 7.4], GEN2 = [7.4, 13.0], TITLE = 13.0, END = 16.5;

interface Agent { c: Critter; x: number; y: number; h: number; v: number; skill: number; spin: number; seed: number; sickUntil: number; dizzyUntil: number }

export default function make({ style, W, H }: ShotOptions): Shot {
  const fx = new Effects();
  const cues: Cue[] = [];
  let now = 0;
  const snd = (sound: Mono, gain: number, x = WW / 2, delay = 0): void => { cues.push({ t: now + delay, sound, gain, pan: clamp((x - WW / 2) / 120, -0.45, 0.45) }); };
  const r = rng(5);
  const hues = [200, 22, 285, 48, 335, 160];
  let items: Item[] = [], agents: Agent[] = [], eaten = 0, gen = 1;

  function populate(skill: number, seed: number): void {
    const rr = rng(seed);
    items = [];
    for (let k = 0; k < 26; k++) items.push(item(12 + rr() * (WW - 24), 12 + rr() * (WH - 24), k % 5 === 0 ? "poison" : "food", R * 0.42, -1, seed * 100 + k));
    agents = hues.map((hue, i) => {
      const c = new Critter(0, 0, R, hue, seed + i);
      const a: Agent = { c, x: 30 + rr() * (WW - 60), y: 30 + rr() * (WH - 60), h: rr() * 6.28, v: 0, skill, spin: (rr() - 0.5) * 2, seed: seed + i * 7, sickUntil: 0, dizzyUntil: 0 };
      c.heading = a.h;
      return a;
    });
    // Clear the berries from under the starting bodies.
    items = items.filter((it) => agents.every((a) => Math.hypot(it.x - a.x, it.y - a.y) > R * 2.5));
    eaten = 0;
  }
  populate(0, 11);

  function respawn(it: Item, t: number): void {
    const ghost = { ...it, eatenAt: t };
    ghosts.push(ghost);
    it.x = 12 + r() * (WW - 24); it.y = 12 + r() * (WH - 24); it.born = t + 0.5; it.seed += 13;
    return;
  }
  let ghosts: Item[] = [];

  function think(a: Agent, t: number, dt: number): void {
    const dumb = 1 - a.skill;
    let turn = 0, speed = 0;
    if (t < a.dizzyUntil) { turn = 3; speed = 4; } // spins in place after a bonk
    else if (t < a.sickUntil) { turn = 0.6 * noise1(t * 2, a.seed); speed = 6; }
    else {
      // Find the best target: nearest food, poison avoided by skilled agents.
      let best: Item | null = null, bd = Infinity;
      for (const it of items) {
        if (it.born > t) continue;
        const d = Math.hypot(it.x - a.x, it.y - a.y);
        const taken = a.skill > 0.5 && agents.some((o) => o !== a && Math.hypot(it.x - o.x, it.y - o.y) < d * 0.8);
        const score = it.kind === "food" ? (taken ? d * 3 : d) : a.skill > 0.5 ? Infinity : d * 1.3;
        if (score < bd) { bd = score; best = it; }
      }
      let want = best ? Math.atan2(best.y - a.y, best.x - a.x) : a.h;
      if (a.skill > 0.5) {
        // Bend around poison that sits close to the line.
        for (const it of items) {
          if (it.kind !== "poison" || it.born > t) continue;
          const dx = it.x - a.x, dy = it.y - a.y, d = Math.hypot(dx, dy);
          if (d < R * 4) want += Math.sign(wrapAngle(want - Math.atan2(dy, dx)) || 1) * 1.4 * (1 - d / (R * 4));
        }
        // And away from walls.
        const m = R * 2.5;
        if (a.x < m) want = lerpA(want, 0, 0.5); if (a.x > WW - m) want = lerpA(want, Math.PI, 0.5);
        if (a.y < m) want = lerpA(want, Math.PI / 2, 0.5); if (a.y > WH - m) want = lerpA(want, -Math.PI / 2, 0.5);
      }
      const err = wrapAngle(want - a.h);
      turn = a.skill * clamp(err * 5, -4, 4) + dumb * (a.spin * 3.2 + 2.6 * noise1(t * 0.9, a.seed));
      speed = a.skill * (34 + 14 * Math.cos(err)) + dumb * (9 + 9 * noise1(t * 0.6, a.seed + 3));
    }
    a.h += turn * dt;
    a.v += (speed - a.v) * (1 - Math.exp(-6 * dt));
    a.x += Math.cos(a.h) * a.v * dt;
    a.y += Math.sin(a.h) * a.v * dt;
    // Walls: a bonk for the clumsy, a slide for the skilled.
    const lo = R, hx = WW - R, hy = WH - R;
    if (a.x < lo || a.x > hx || a.y < lo || a.y > hy) {
      const nx = a.x < lo ? 1 : a.x > hx ? -1 : 0, ny = a.y < lo ? 1 : a.y > hy ? -1 : 0;
      a.x = clamp(a.x, lo, hx); a.y = clamp(a.y, lo, hy);
      if (a.v > 7 && t > a.dizzyUntil + 0.5) {
        a.c.feel("surprised", t, 0.2); a.c.feel("sad", t + 0.2, 1.0); a.c.jiggle(-0.9, Math.atan2(ny, nx));
        fx.bonk(a.x - nx * R, a.y - ny * R, R * 0.8); fx.dizzy(a.c, 1.1);
        snd(SFX.bonk(), 0.45, a.x); snd(voice("sad", 1.1, a.seed), 0.25, a.x, 0.15);
        a.dizzyUntil = t + 0.9;
      }
      a.h = Math.atan2(Math.sin(a.h) * (ny ? -1 : 1), Math.cos(a.h) * (nx ? -1 : 1));
      a.v *= 0.4;
    }
    // Eating.
    for (const it of items) {
      if (it.born > t || Math.hypot(it.x - a.x, it.y - a.y) > R + it.r) continue;
      if (it.kind === "poison" && a.skill > 0.5) continue; // the trained ones squeeze past
      a.c.chew = 1;
      if (it.kind === "food") {
        eaten++;
        a.c.feel(a.skill > 0.5 ? "joy" : "happy", t, 0.6); a.c.jiggle(-0.35);
        fx.crumbs(it.x, it.y, R * 0.45, "#7dff9f", 6);
        if (a.skill > 0.5) fx.sparkle(a.x, a.y, R * 0.5, "#fff7b0", 4);
        snd(SFX.chomp(eaten + a.seed), 0.3, a.x); if (a.skill > 0.5) snd(SFX.pop(1.6 + 0.1 * (eaten % 5)), 0.15, a.x, 0.06);
      } else {
        a.c.feel("sick", t, 1.6); a.c.jiggle(0.6, -Math.PI / 2); fx.bubbles(a.c, 1.6); a.sickUntil = t + 1.4;
        snd(SFX.uhoh(), 0.3, a.x); snd(voice("sick", 1.1, a.seed + 1), 0.25, a.x, 0.25);
      }
      it.eater = a.c;
      respawn(it, t);
    }
  }
  const lerpA = (a: number, b: number, k: number): number => a + wrapAngle(b - a) * k;

  let simT = 0, phase = 1, dived = false;
  const meter = { shown: 0 };
  return {
    duration: END,
    mixAudio(file: string) {
      cues.push({ t: DIVE[0]!, sound: SFX.whoosh(0.7), gain: 0.5 }, { t: DIVE[0]! + 0.3, sound: SFX.bleeps(3), gain: 0.5 }, { t: DIVE[0]! + 0.9, sound: SFX.bleeps(4), gain: 0.5 },
        { t: DIVE[1]! - 0.35, sound: SFX.ding(), gain: 0.5 }, { t: DIVE[1]! - 0.2, sound: SFX.whoosh(0.4), gain: 0.4 },
        { t: TITLE, sound: SFX.pop(1.0), gain: 0.4 }, { t: TITLE + 0.3, sound: SFX.pop(1.2), gain: 0.4 }, { t: TITLE + 1.0, sound: SFX.sparkle(5), gain: 0.4 });
      writeMix(file, END, cues, { sound: musicBed(END, 108, 3), gain: 0.8, fadeOut: 1.5 });
    },
    frame(ctx: Ctx, t: number, dt: number) {
      now = t; fx.t = t;
      if (phase === 1 && t >= DIVE[0]! - 0.9 && !dived) {
        dived = true;
        const h0 = agents[0]!;
        h0.sickUntil = 0; h0.dizzyUntil = 0;
        h0.c.feel("focus", t, 2.5);
        fx.brain(h0.c, 1.4);
      }
      if (phase === 1 && t >= GEN2[0]!) { phase = 2; gen = 200; populate(1, 23); ghosts = []; meter.shown = 0; }
      const running = (t >= GEN1[0]! && t < DIVE[0]! + 0.3) || t >= GEN2[0]!;
      while (simT + STEP <= t) {
        simT += STEP;
        if (!running) continue;
        for (const a of agents) think(a, simT, STEP);
        // Bodies push apart.
        for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
          const p = agents[i]!, q = agents[j]!, dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
          if (d > 0 && d < 2 * R) { const k = (2 * R - d) / (2 * d); p.x -= dx * k; p.y -= dy * k; q.x += dx * k; q.y += dy * k; }
        }
      }
      for (const a of agents) { a.c.moveTo(a.x, a.y, Math.cos(a.h) * a.v, Math.sin(a.h) * a.v); a.c.heading = a.h; a.c.update(t, dt); }
      ghosts = ghosts.filter((g) => t - g.eatenAt < 0.3);
      meter.shown += (eaten - meter.shown) * (1 - Math.exp(-10 * dt));

      // World view; during the dive the camera pushes into the first creature's head.
      const d = clamp((t - DIVE[0]!) / (DIVE[1]! - DIVE[0]!));
      const hero = agents[0]!;
      const push = t < GEN2[0]! ? easeInOut(clamp(d / 0.35)) : 1 - easeInOut(clamp((t - GEN2[0]!) / 0.6));
      const cam = { x: lerp(WW / 2, hero.x, push), y: lerp(WH / 2, hero.y - R * (t < GEN2[0]! ? 2.55 : 0.2), push), zoom: lerp(1, 9, push ** 2) }; // dives into the brain hologram
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = style === "neon" ? "#020504" : "#07140f";
      ctx.fillRect(0, 0, W, H);
      applyCamera(ctx, W, H, cam, WH * 1.04, t);
      drawFloor(ctx, style, WW, WH, t, phase === 1 ? 5 : 8);
      for (const it of items) drawItem(ctx, it, style, t);
      for (const g of ghosts) drawItem(ctx, g, style, t);
      for (const a of agents) a.c.draw(ctx, style);
      fx.draw(ctx, t);
      vignette(ctx, W, H, style === "classic" ? 0.25 : 0.5);
      // The brain: a full-screen network rewiring while the generation counter rolls up.
      const brainA = t < GEN2[0]! ? smooth((d - 0.25) / 0.15) : 1 - smooth((t - GEN2[0]!) / 0.35);
      if (brainA > 0) brain(ctx, W, H, t, brainA, clamp((d - 0.35) / 0.5), style);
      // HUD: generation pill and berries counter.
      const hudA = t < DIVE[0]! ? smooth((t - 0.4) / 0.4) * (1 - smooth((t - DIVE[0]!) / 0.3 + 1)) : t >= GEN2[0]! + 0.3 ? smooth((t - GEN2[0]! - 0.3) / 0.4) * (1 - smooth((t - TITLE + 0.3) / 0.3)) : 0;
      if (hudA > 0) hud(ctx, W, H, gen, Math.round(meter.shown), hudA, t - (gen === 1 ? 0.4 : GEN2[0]! + 0.3));
      if (t >= TITLE) titleCard(ctx, W, H, t - TITLE, { sub: "watch them learn", url: "erikfransson.github.io/evolve-world-ai" });
      const fade = smoother(t / 0.4) * smoother((END - t) / 0.6);
      if (fade < 1) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = `rgba(0, 0, 0, ${1 - fade})`; ctx.fillRect(0, 0, W, H); }
    },
  };
}

function hud(ctx: Ctx, W: number, H: number, gen: number, eaten: number, a: number, age: number): void {
  const u = H / 1080, s = easeOutBack(clamp(age / 0.4));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(70 * u, 60 * u);
  ctx.scale(s, s);
  ctx.fillStyle = "rgba(6, 20, 14, 0.75)";
  ctx.strokeStyle = gen === 1 ? "rgba(255, 190, 120, 0.9)" : "rgba(130, 255, 190, 0.9)";
  ctx.lineWidth = 4 * u;
  roundRect(ctx, 0, 0, 560 * u, 110 * u, 55 * u);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  text(ctx, `Generation ${gen}`, 70 * u + 280 * u * s, 60 * u + 55 * u * s, 54 * u, gen === 1 ? "#ffd7a8" : "#b8ffd6", "#0b1d16", a, s);
  // Berry counter on the right.
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = "#3fd476";
  ctx.beginPath();
  ctx.arc(W - 250 * u, 115 * u, 30 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  text(ctx, `× ${eaten}`, W - 150 * u, 115 * u, 64 * u, "#ffffff", "#0b1d16", a, 1);
}

// A big glowing network whose connections flicker and settle as the counter rolls 1 -> 200.
function brain(ctx: Ctx, W: number, H: number, t: number, a: number, k: number, style: string): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.save();
  ctx.globalAlpha = a;
  const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.7);
  g.addColorStop(0, style === "neon" ? "#06231d" : "#0d3a4a");
  g.addColorStop(1, "#030b10");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const layers = [6, 8, 8, 3];
  const node = (l: number, i: number): [number, number] => [W * (0.2 + (0.6 * l) / (layers.length - 1)), H * (0.5 + ((i - (layers[l]! - 1) / 2) / 8) * 0.8)];
  const rr = rng(Math.floor(t * 12)); // flicker re-rolls 12 times a second while learning
  for (let l = 0; l + 1 < layers.length; l++)
    for (let i = 0; i < layers[l]!; i++)
      for (let j = 0; j < layers[l + 1]!; j++) {
        const [x0, y0] = node(l, i), [x1, y1] = node(l + 1, j);
        const settled = ((i * 5 + j * 3 + l) % 4) / 3; // the final weights
        const w = lerp(rr(), settled, smooth(k));
        const hue = w > 0.5 ? 165 : 20;
        ctx.strokeStyle = `hsla(${hue}, 100%, ${50 + 30 * w}%, ${0.08 + 0.55 * w * w})`;
        ctx.lineWidth = (1 + 5 * w * w) * (H / 1080);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        if (w > 0.6) {
          const p = (t * 1.5 + (i + j) * 0.13) % 1;
          ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
          ctx.beginPath();
          ctx.arc(lerp(x0, x1, p), lerp(y0, y1, p), 4 * (H / 1080), 0, Math.PI * 2);
          ctx.fill();
        }
      }
  for (let l = 0; l < layers.length; l++)
    for (let i = 0; i < layers[l]!; i++) {
      const [x, y] = node(l, i);
      const glow = 0.5 + 0.5 * Math.sin(t * 8 + i + l * 2);
      ctx.fillStyle = `hsl(${180 + l * 25}, 100%, ${60 + 25 * glow * k}%)`;
      ctx.beginPath();
      ctx.arc(x, y, (14 + 6 * glow * k) * (H / 1080), 0, Math.PI * 2);
      ctx.fill();
    }
  ctx.restore();
  const n = Math.max(1, Math.round(1 + 199 * easeInOut(k)));
  text(ctx, `Generation ${n}`, W / 2, H * 0.13, 70 * (H / 1080), n >= 200 ? "#b8ffd6" : "#ffffff", "#0b1d16", a, 1 + 0.08 * (n >= 200 ? easeOutBack(clamp((k - 0.95) / 0.05)) : 0));
}
