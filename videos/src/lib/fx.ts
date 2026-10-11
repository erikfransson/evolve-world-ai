// Short-lived effects: sparkles, hearts, anger marks, comic words, the brain hologram and friends.
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import type { Canvas } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";
import type { Critter, Ctx } from "./critter.ts";
import { clamp, easeOut, easeOutBack, easeOutElastic, lerp, rng, smooth } from "./ease.ts";

GlobalFonts.registerFromPath(fileURLToPath(new URL("../../assets/fonts/Fredoka.ttf", import.meta.url)), "Fredoka");
export const FONT = "Fredoka";

const TAU = Math.PI * 2;

type Anchor = () => { x: number; y: number };
const at = (x: number, y: number): Anchor => () => ({ x, y });
const above = (c: Critter, dy = 1.35, dx = 0): Anchor => () => ({ x: c.x + dx * c.r, y: c.y - dy * c.r });

interface Fx { t0: number; dur: number; draw(ctx: Ctx, u: number, age: number): void }

// A list of timed effects; `spawn` at the shot time, `draw` with the current time.
export class Effects {
  private list: Fx[] = [];
  private rand = rng(4242);
  t = 0;

  private add(dur: number, draw: Fx["draw"]): void {
    this.list.push({ t0: this.t, dur, draw });
  }

  draw(ctx: Ctx, t: number): void {
    this.t = t;
    this.list = this.list.filter((f) => t - f.t0 < f.dur);
    for (const f of this.list) {
      ctx.save();
      f.draw(ctx, clamp((t - f.t0) / f.dur), t - f.t0);
      ctx.restore();
    }
  }

  // Four-point stars bursting outward.
  sparkle(x: number, y: number, size: number, color = "#fff7b0", n = 7): void {
    const parts = Array.from({ length: n }, (_, i) => ({ a: (i / n) * TAU + this.rand() * 0.6, d: 0.8 + this.rand() * 0.8, s: 0.6 + this.rand() * 0.6, spin: this.rand() * 4 - 2 }));
    this.add(0.9, (ctx, u) => {
      for (const p of parts) {
        const d = size * (0.6 + 2.2 * easeOut(u) * p.d);
        const s = size * 0.32 * p.s * Math.sin(Math.PI * Math.min(1, u * 1.4));
        if (s <= 0) continue;
        star(ctx, x + Math.cos(p.a) * d, y + Math.sin(p.a) * d, s, p.spin * u, color);
      }
    });
  }

  crumbs(x: number, y: number, size: number, color: string, n = 9): void {
    const parts = Array.from({ length: n }, () => ({ a: this.rand() * TAU, d: 0.5 + this.rand(), s: 0.4 + this.rand() * 0.6 }));
    this.add(0.6, (ctx, u) => {
      ctx.fillStyle = color;
      ctx.globalAlpha = 1 - u * u;
      for (const p of parts) {
        const d = size * 2.2 * easeOut(u) * p.d;
        ctx.beginPath();
        ctx.arc(x + Math.cos(p.a) * d, y + Math.sin(p.a) * d, size * 0.18 * p.s * (1 - u * 0.6), 0, TAU);
        ctx.fill();
      }
    });
  }

  ring(x: number, y: number, r: number, color: string, dur = 0.7, width = 0.12): void {
    this.add(dur, (ctx, u) => {
      ctx.globalAlpha = (1 - u) ** 1.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = r * width * (1.2 - u);
      ctx.beginPath();
      ctx.arc(x, y, r * (1 + 1.1 * easeOut(u)), 0, TAU);
      ctx.stroke();
    });
  }

  hearts(c: Critter, n = 3): void {
    const parts = Array.from({ length: n }, (_, i) => ({ dx: (i - (n - 1) / 2) * 0.7 + (this.rand() - 0.5) * 0.3, delay: i * 0.15, s: 0.8 + this.rand() * 0.4 }));
    const t0 = this.t;
    this.add(1.8, (ctx, _u, age) => {
      for (const p of parts) {
        const v = clamp((age - p.delay) / 1.4);
        if (v <= 0 || v >= 1) continue;
        const pos = { x: c.x + c.r * (p.dx + 0.25 * Math.sin((age + t0) * 6 + p.dx)), y: c.y - c.r * (1.1 + 1.6 * easeOut(v)) };
        ctx.globalAlpha = 1 - smooth((v - 0.7) / 0.3);
        heart(ctx, pos.x, pos.y, c.r * 0.32 * p.s * easeOutBack(Math.min(1, v * 4)), "#ff5f8f");
      }
    });
  }

  // Comic anger mark at the top corner of the head, throbbing.
  anger(c: Critter, dur = 1.2): void {
    const anchor = above(c, 0.85, 0.75);
    this.add(dur, (ctx, u, age) => {
      const { x, y } = anchor();
      const s = c.r * 0.38 * easeOutBack(Math.min(1, age * 5)) * (1 + 0.15 * Math.sin(age * 22)) * (1 - smooth((u - 0.85) / 0.15));
      ctx.translate(x, y);
      ctx.rotate(0.2);
      ctx.lineCap = "round";
      for (const [w, col] of [[0.55, "#ffffff"], [0.3, "#ff2d4a"]] as const) {
        ctx.strokeStyle = col;
        ctx.lineWidth = s * w;
        for (let k = 0; k < 4; k++) {
          ctx.save();
          ctx.rotate((k * Math.PI) / 2);
          ctx.beginPath();
          ctx.moveTo(s * 0.3, s * 1.0);
          ctx.quadraticCurveTo(s * 0.3, s * 0.3, s * 1.0, s * 0.3);
          ctx.stroke();
          ctx.restore();
        }
      }
    });
  }

  // Steam puffs from both sides of the head.
  steam(c: Critter, dur = 1): void {
    this.add(dur, (ctx, _u, age) => {
      for (let k = 0; k < 6; k++) {
        const side = k % 2 ? 1 : -1;
        const v = (age * 1.8 + k * 0.17) % 1;
        const x = c.x + side * c.r * (0.9 + 0.7 * v);
        const y = c.y - c.r * (0.5 + 0.9 * v);
        ctx.globalAlpha = 0.7 * Math.sin(Math.PI * v) * (1 - smooth((age - dur + 0.3) / 0.3));
        ctx.fillStyle = "#f2f2f2";
        ctx.beginPath();
        ctx.arc(x, y, c.r * (0.12 + 0.18 * v), 0, TAU);
        ctx.fill();
      }
    });
  }

  sweat(c: Critter, dur = 1.2): void {
    this.add(dur, (ctx, u) => {
      const x = c.x - c.r * 0.82, y = c.y - c.r * (0.6 - 0.5 * easeOut(u));
      ctx.globalAlpha = 1 - smooth((u - 0.7) / 0.3);
      const s = c.r * 0.2 * easeOutBack(Math.min(1, u * 5));
      ctx.fillStyle = "#9fe0ff";
      ctx.strokeStyle = "#1d5a7a";
      ctx.lineWidth = s * 0.2;
      ctx.beginPath();
      ctx.moveTo(x, y - s * 1.6);
      ctx.quadraticCurveTo(x + s * 1.1, y, x, y + s);
      ctx.quadraticCurveTo(x - s * 1.1, y, x, y - s * 1.6);
      ctx.fill();
      ctx.stroke();
    });
  }

  // Green bubbles rising off a sick creature.
  bubbles(c: Critter, dur = 2): void {
    const parts = Array.from({ length: 7 }, () => ({ dx: this.rand() * 1.6 - 0.8, ph: this.rand(), s: 0.5 + this.rand() * 0.6 }));
    this.add(dur, (ctx, u, age) => {
      for (const p of parts) {
        const v = (age * 0.9 + p.ph) % 1;
        ctx.globalAlpha = Math.sin(Math.PI * v) * (1 - smooth((u - 0.8) / 0.2));
        ctx.strokeStyle = "#b8f26b";
        ctx.fillStyle = "rgba(160, 230, 80, 0.25)";
        ctx.lineWidth = c.r * 0.04;
        ctx.beginPath();
        ctx.arc(c.x + c.r * (p.dx + 0.15 * Math.sin(age * 5 + p.ph * 9)), c.y - c.r * (0.6 + 1.5 * v), c.r * 0.12 * p.s * (0.5 + v), 0, TAU);
        ctx.fill();
        ctx.stroke();
      }
    });
  }

  // Stars circling the head after a knock.
  dizzy(c: Critter, dur = 1.5): void {
    this.add(dur, (ctx, u, age) => {
      ctx.globalAlpha = 1 - smooth((u - 0.8) / 0.2);
      for (let k = 0; k < 3; k++) {
        const a = age * 6 + (k * TAU) / 3;
        star(ctx, c.x + Math.cos(a) * c.r * 0.8, c.y - c.r * 1.15 + Math.sin(a) * c.r * 0.25, c.r * 0.18, a, "#ffe066");
      }
    });
  }

  // Pop-in comic word with a thick outline, drifting up.
  word(text: string, anchor: Anchor | { x: number; y: number }, size: number, fill: string, dur = 1.1, tilt = -0.12): void {
    const pos = typeof anchor === "function" ? anchor : at(anchor.x, anchor.y);
    this.add(dur, (ctx, u, age) => {
      const { x, y } = pos();
      const s = easeOutElastic(Math.min(1, age * 2.2)) * (1 - smooth((u - 0.85) / 0.15) * 0.4);
      ctx.globalAlpha = 1 - smooth((u - 0.8) / 0.2);
      ctx.translate(x, y - size * 0.6 * easeOut(u));
      ctx.rotate(tilt + 0.05 * Math.sin(age * 8));
      ctx.scale(s, s);
      const spr = textSprite(text, fill);
      const k = size / SPRITE_PX;
      ctx.drawImage(spr, (-spr.width / 2) * k, (-spr.height / 2) * k, spr.width * k, spr.height * k);
    });
  }

  exclaim(c: Critter, text = "!", color = "#ffd23f", dur = 0.9): void {
    this.word(text, above(c, 1.55), c.r * 0.9, color, dur, 0);
  }

  // Comic impact flash between two bumping bodies.
  bonk(x: number, y: number, size: number): void {
    this.add(0.35, (ctx, u) => {
      ctx.globalAlpha = 1 - u;
      ctx.translate(x, y);
      ctx.rotate(u * 0.5);
      const s = size * (0.6 + 0.8 * easeOut(u));
      ctx.fillStyle = "#fff4c2";
      ctx.beginPath();
      for (let k = 0; k < 16; k++) {
        const rr = s * (k % 2 ? 0.45 : 1);
        const a = (k / 16) * TAU;
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
    });
  }

  // The creature's neural net as a little hologram above its head: poison goes in, pulses run, edges light up, "no" comes out.
  brain(c: Critter, dur = 2.4, hue = 190): void {
    const layers = [3, 4, 2];
    this.add(dur, (ctx, u, age) => {
      const out = smooth((u - 0.86) / 0.14); // pops outward and fades at the end
      const show = easeOutBack(Math.min(1, age * 3.5)) * (1 + 0.25 * out);
      ctx.globalAlpha *= 1 - out;
      if (out >= 0.99) return;
      const learn = smooth((age - 0.3) / (dur * 0.55)); // how much is learned
      const w = c.r * 3.4, h = c.r * 1.7;
      ctx.translate(c.x, c.y - c.r * 2.55);
      ctx.scale(show, show);
      const beam = ctx.createLinearGradient(0, h * 0.5, 0, c.r * 1.45);
      beam.addColorStop(0, `hsla(${hue}, 100%, 70%, 0.0)`);
      beam.addColorStop(1, `hsla(${hue}, 100%, 75%, 0.4)`);
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(-w * 0.3, h * 0.5);
      ctx.lineTo(w * 0.3, h * 0.5);
      ctx.lineTo(c.r * 0.22, c.r * 1.45);
      ctx.lineTo(-c.r * 0.22, c.r * 1.45);
      ctx.fill();
      ctx.save();
      ctx.shadowColor = `hsla(${hue}, 100%, 70%, 0.8)`;
      ctx.shadowBlur = c.r * 0.5;
      ctx.fillStyle = `hsla(${hue}, 70%, 14%, 0.78)`;
      ctx.strokeStyle = `hsla(${hue}, 100%, 78%, 0.95)`;
      ctx.lineWidth = c.r * 0.06;
      roundRect(ctx, -w / 2, -h / 2, w, h, c.r * 0.3);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      const x0 = -w * 0.22, x1 = w * 0.22;
      const node = (l: number, i: number): [number, number] => [lerp(x0, x1, l / (layers.length - 1)), (-0.5 + (i + 0.5) / layers[l]!) * h * 0.78];
      for (let l = 0; l + 1 < layers.length; l++)
        for (let i = 0; i < layers[l]!; i++)
          for (let j = 0; j < layers[l + 1]!; j++) {
            const [ax, ay] = node(l, i), [bx, by] = node(l + 1, j);
            const k = (i * 7 + j * 3 + l * 5) % 7;
            const strong = k % 3 === 0; // the connections that matter light up as it learns
            const lit = strong ? learn : learn * 0.25;
            ctx.strokeStyle = `hsla(${hue + 20 * l}, 100%, ${45 + 35 * lit}%, ${0.25 + 0.7 * lit})`;
            ctx.lineWidth = c.r * (0.025 + 0.06 * lit);
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
            if (strong && age > 0.3) {
              const p = (age * 1.3 + k / 7) % 1;
              ctx.fillStyle = "#ffffff";
              ctx.beginPath();
              ctx.arc(lerp(ax, bx, p), lerp(ay, by, p), c.r * 0.05, 0, TAU);
              ctx.fill();
            }
          }
      for (let l = 0; l < layers.length; l++)
        for (let i = 0; i < layers[l]!; i++) {
          const [x, y] = node(l, i);
          const glow = learn * (0.5 + 0.5 * Math.sin(age * 7 + i * 1.7 + l * 2.3));
          ctx.save();
          ctx.fillStyle = `hsl(${hue + 25 * l}, 100%, ${55 + 35 * glow}%)`;
          ctx.shadowColor = ctx.fillStyle;
          ctx.shadowBlur = c.r * 0.4 * glow;
          ctx.beginPath();
          ctx.arc(x, y, c.r * 0.1, 0, TAU);
          ctx.fill();
          ctx.restore();
        }
      // Input: the poison berry. Output: a "no" sign that appears once learned.
      const ix = -w * 0.38, ox = w * 0.38, ir = c.r * 0.26;
      ctx.fillStyle = "#b03ad6";
      ctx.beginPath();
      ctx.arc(ix, 0, ir, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 240, 255, 0.95)";
      ctx.beginPath();
      ctx.arc(ix, -ir * 0.1, ir * 0.45, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "#4a0c5e";
      for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(ix + sx * ir * 0.18, -ir * 0.1, ir * 0.11, 0, TAU); ctx.fill(); }
      const no = easeOutBack(clamp((learn - 0.75) / 0.25));
      if (no > 0) {
        ctx.save();
        ctx.translate(ox, 0);
        ctx.scale(no, no);
        ctx.strokeStyle = "#ff4d5e";
        ctx.lineWidth = ir * 0.32;
        ctx.beginPath();
        ctx.arc(0, 0, ir, 0, TAU);
        ctx.moveTo(-ir * 0.7, -ir * 0.7);
        ctx.lineTo(ir * 0.7, ir * 0.7);
        ctx.stroke();
        ctx.restore();
      } else {
        const q = textSprite("?", `hsl(${hue}, 100%, 80%)`, `hsl(${hue}, 60%, 20%)`);
        const k = (ir * 1.8) / SPRITE_PX;
        ctx.drawImage(q, ox - (q.width / 2) * k, -(q.height / 2) * k, q.width * k, q.height * k);
      }
    });
  }

  // Speed streaks behind a running creature and dust puffs where it pushes off.
  speed(c: Critter, dur: number, color = "rgba(230, 255, 240, 0.55)"): void {
    this.add(dur, (ctx, u) => {
      const sp = Math.hypot(c.vx, c.vy);
      if (sp < 20) return;
      const a = Math.atan2(c.vy, c.vx), nx = -Math.sin(a), ny = Math.cos(a);
      ctx.globalAlpha = Math.min(1, sp / 80) * (1 - smooth((u - 0.85) / 0.15));
      ctx.strokeStyle = color;
      ctx.lineCap = "round";
      for (const off of [-0.6, 0, 0.6]) {
        ctx.lineWidth = c.r * (off === 0 ? 0.12 : 0.08);
        ctx.beginPath();
        const len = Math.min(3.2, sp / 30) * c.r;
        const bx = c.x - Math.cos(a) * c.r * 1.2 + nx * off * c.r, by = c.y - Math.sin(a) * c.r * 1.2 + ny * off * c.r;
        ctx.moveTo(bx, by);
        ctx.lineTo(bx - Math.cos(a) * len * (off === 0 ? 1 : 0.7), by - Math.sin(a) * len * (off === 0 ? 1 : 0.7));
        ctx.stroke();
      }
    });
  }

  puff(x: number, y: number, size: number, n = 5): void {
    const parts = Array.from({ length: n }, () => ({ a: this.rand() * TAU, d: 0.6 + this.rand() * 0.6, s: 0.6 + this.rand() * 0.5 }));
    this.add(0.55, (ctx, u) => {
      ctx.fillStyle = "rgba(220, 235, 225, 0.5)";
      ctx.globalAlpha = 1 - u;
      for (const p of parts) {
        ctx.beginPath();
        ctx.arc(x + Math.cos(p.a) * size * p.d * easeOut(u), y + Math.sin(p.a) * size * p.d * easeOut(u), size * 0.35 * p.s * (0.6 + u), 0, TAU);
        ctx.fill();
      }
    });
  }

  // A soft upward glow and a chime-like ring when something is learned.
  eureka(c: Critter): void {
    this.sparkle(c.x, c.y - c.r * 2.5, c.r * 0.7, "#bff6ff", 9);
    this.ring(c.x, c.y, c.r * 0.7, "#c8fbff", 0.45, 0.2);
  }
}

export function star(ctx: Ctx, x: number, y: number, s: number, rot: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const rr = k % 2 ? s * 0.32 : s;
    const a = (k / 8) * TAU;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function heart(ctx: Ctx, x: number, y: number, s: number, color: string): void {
  if (s <= 0) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = s * 0.18;
  ctx.beginPath();
  ctx.moveTo(0, s * 0.9);
  ctx.bezierCurveTo(-s * 1.4, -s * 0.1, -s * 0.7, -s * 1.1, 0, -s * 0.35);
  ctx.bezierCurveTo(s * 0.7, -s * 1.1, s * 1.4, -s * 0.1, 0, s * 0.9);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Outlined comic text rendered once at high resolution; text layout per frame is slow.
const SPRITE_PX = 160;
const sprites = new Map<string, Canvas>();
export function textSprite(text: string, fill: string, outline = "#1a0f1f"): Canvas {
  const key = `${text}|${fill}|${outline}`;
  let c = sprites.get(key);
  if (c) return c;
  const probe = createCanvas(8, 8).getContext("2d");
  probe.font = `600 ${SPRITE_PX}px ${FONT}`;
  const w = Math.ceil(probe.measureText(text).width + SPRITE_PX * 0.5);
  c = createCanvas(w, Math.ceil(SPRITE_PX * 1.6));
  const ctx = c.getContext("2d");
  ctx.font = `600 ${SPRITE_PX}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.strokeStyle = outline;
  ctx.lineWidth = SPRITE_PX * 0.22;
  ctx.strokeText(text, c.width / 2, c.height / 2);
  ctx.fillStyle = fill;
  ctx.fillText(text, c.width / 2, c.height / 2);
  sprites.set(key, c);
  return c;
}
