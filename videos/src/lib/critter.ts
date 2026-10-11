// A creature with a face: motion, squash and stretch, blinking, emotions, and three drawing styles.
import type { SKRSContext2D } from "@napi-rs/canvas";
import { approach, clamp, lerp, lerpAngle, noise1, rng, smooth, wrapAngle } from "./ease.ts";
import { EMOTIONS, NEUTRAL, blend, relax } from "./face.ts";
import { softShadow } from "./paint.ts";
import type { Emotion, Expr } from "./face.ts";

export type Ctx = SKRSContext2D;
export type StyleName = "classic" | "cute" | "neon";

interface Feeling { emotion: Emotion; t0: number; t1: number; amount: number }

const TAU = Math.PI * 2;

export class Critter {
  x = 0; y = 0; vx = 0; vy = 0;
  heading = 0; // radians, smoothed toward the direction of motion
  r: number;
  hue: number;
  energy = 0.7; // 0..1, the classic body fill
  scale = 1; // pop-in and shrink-out
  alpha = 1;
  brain = 0; // 0..1 learning glow
  chew = 0; // 0..1, decays; flaps the mouth
  lookX = 0; lookY = 0; // pupil target in -1..1
  expr: Expr = { ...NEUTRAL };
  base: Emotion = "neutral";
  private feelings: Feeling[] = [];
  private sq = 0; private sqV = 0; private sqAxis = 0; // squash spring
  private blinkAt: number; private rand: () => number;
  private t = 0;
  private seed: number;
  shake = 0; // 0..1 tremble (angry, scared)
  hunter = false; // teardrop body with a pointed nose, horns and fangs

  constructor(x: number, y: number, r: number, hue: number, seed = 1) {
    this.x = x; this.y = y; this.r = r; this.hue = hue; this.seed = seed;
    this.rand = rng(seed * 7919 + 13);
    this.blinkAt = 0.5 + 3 * this.rand();
  }

  // Shows an emotion from t0 for dur seconds, on top of the base emotion; later feelings win.
  feel(emotion: Emotion, t0: number, dur: number, amount = 1): void {
    this.feelings.push({ emotion, t0, t1: t0 + dur, amount });
  }

  // Kicks the squash spring: positive stretches along `axis`, negative squashes.
  jiggle(amount: number, axis = this.heading): void {
    this.sqAxis = axis;
    this.sqV += amount * 9;
  }

  // Sets position and velocity from a path sample.
  moveTo(x: number, y: number, vx: number, vy: number): void {
    this.x = x; this.y = y; this.vx = vx; this.vy = vy;
  }

  update(t: number, dt: number): void {
    this.t = t;
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > 4) this.heading = lerpAngle(this.heading, Math.atan2(this.vy, this.vx), 1 - Math.exp(-10 * dt));
    // Damped spring, about 3.2 Hz.
    const w = 20, z = 0.32;
    this.sqV += (-w * w * this.sq - 2 * z * w * this.sqV) * dt;
    this.sq += this.sqV * dt;
    this.chew = approach(this.chew, 0, 3, dt);
    // Active feeling: the latest that covers t, faded in and out over 0.12 s.
    let target = EMOTIONS[this.base];
    for (const f of this.feelings) {
      if (t < f.t0 || t > f.t1) continue;
      const fade = smooth((t - f.t0) / 0.12) * smooth((f.t1 - t) / 0.25);
      target = blend(target, EMOTIONS[f.emotion], fade * f.amount);
    }
    relax(this.expr, target, 14, dt);
    if (t > this.blinkAt + 0.16) this.blinkAt = t + 1.8 + 3.2 * this.rand();
  }

  private blink(): number {
    const d = (this.t - this.blinkAt) / 0.16;
    return d < 0 || d > 1 ? 1 : Math.abs(2 * d - 1) ** 1.5;
  }

  draw(ctx: Ctx, style: StyleName): void {
    if (this.scale <= 0.01 || this.alpha <= 0.01) return;
    const speed = Math.hypot(this.vx, this.vy);
    const stretch = clamp(speed / (this.r * 60), 0, 0.07);
    const moveAxis = speed > 4 ? Math.atan2(this.vy, this.vx) : this.heading;
    ctx.save();
    const tremble = this.shake * this.r * 0.06;
    ctx.translate(this.x + tremble * noise1(this.t * 40, this.seed), this.y + tremble * noise1(this.t * 40, this.seed + 9));
    ctx.globalAlpha *= this.alpha;
    // Volume-preserving squash and stretch: speed stretches along motion, the spring along its kick axis.
    ctx.rotate(moveAxis);
    ctx.scale(1 + stretch, 1 / (1 + stretch));
    ctx.rotate(this.sqAxis - moveAxis);
    const s = clamp(1 + this.sq, 0.6, 1.5);
    ctx.scale(s, 1 / s);
    ctx.rotate(-this.sqAxis);
    ctx.scale(this.scale, this.scale);
    if (style === "classic") this.bodyClassic(ctx);
    else if (style === "cute") this.bodyCute(ctx);
    else this.bodyNeon(ctx);
    this.face(ctx, style);
    ctx.restore();
  }

  private colors(style: StyleName): { fill: string; light: string; dark: string; rim: string } {
    const tint = this.expr.tint;
    const h = lerp(this.hue, 95, tint);
    const sat = lerp(style === "cute" ? 78 : 80, 45, tint);
    return {
      fill: `hsl(${h}, ${sat}%, ${style === "cute" ? 62 : 58}%)`,
      light: `hsl(${h}, ${sat}%, ${style === "cute" ? 78 : 82}%)`,
      dark: `hsl(${h}, ${sat * 0.8}%, ${style === "cute" ? 34 : 30}%)`,
      rim: `hsl(${h}, ${sat}%, 46%)`,
    };
  }

  // Body outline: a circle, or for hunters a round back with a pointed nose along the heading.
  private bodyPath(ctx: Ctx, k = 1): void {
    const r = this.r * k;
    ctx.beginPath();
    if (!this.hunter) { ctx.arc(0, 0, r, 0, TAU); return; }
    const n = r * 1.75, half = Math.acos(1 / 1.75), h = this.heading;
    ctx.moveTo(Math.cos(h) * n, Math.sin(h) * n);
    ctx.arc(0, 0, r, h + half, h - half + TAU);
    ctx.closePath();
  }

  // Two small curved horns on top of a hunter's head.
  private horns(ctx: Ctx, col: { dark: string; light: string }): void {
    const r = this.r;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(side * r * 0.45, -r * 0.82);
      ctx.rotate(side * 0.35);
      ctx.fillStyle = col.light;
      ctx.strokeStyle = col.dark;
      ctx.lineWidth = r * 0.06;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(-r * 0.2, r * 0.1);
      ctx.quadraticCurveTo(-r * 0.05, -r * 0.3, side * r * 0.12, -r * 0.48);
      ctx.quadraticCurveTo(r * 0.12, -r * 0.15, r * 0.2, r * 0.1);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  private nose(ctx: Ctx, base: number, tip: number, half: number): void {
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    ctx.beginPath();
    ctx.moveTo(c * tip, s * tip);
    ctx.lineTo(c * base - s * half, s * base + c * half);
    ctx.lineTo(c * base + s * half, s * base - c * half);
    ctx.closePath();
  }

  // The site look: dark body, energy level fill, light rim and a small nose triangle.
  private bodyClassic(ctx: Ctx): void {
    const r = this.r, col = this.colors("classic");
    ctx.save();
    this.bodyPath(ctx);
    ctx.fillStyle = "rgba(15, 23, 20, 0.92)";
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = col.fill;
    const top = r - 2 * r * clamp(this.energy);
    const wave = r * 0.06 * Math.sin(this.t * 5);
    ctx.beginPath();
    ctx.moveTo(-2 * r, 2 * r);
    ctx.lineTo(-2 * r, top + wave);
    ctx.quadraticCurveTo(0, top - wave * 2, 2 * r, top + wave);
    ctx.lineTo(2 * r, 2 * r);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = col.light;
    ctx.lineWidth = r * 0.09;
    ctx.lineJoin = "round";
    this.bodyPath(ctx);
    ctx.stroke();
    if (this.hunter) return;
    ctx.fillStyle = col.light;
    this.nose(ctx, r * 1.08, r * 1.55, r * 0.3);
    ctx.fill();
  }

  // Two feelers on top of the head, leaning toward the heading; they droop when sad and perk up when happy.
  private antennae(ctx: Ctx, col: { light: string; dark: string; fill: string }): void {
    const r = this.r, e = this.expr;
    const perk = 0.3 * e.browY + 0.25 * e.mouthCurve - 0.35 * e.tint - 0.2 * Math.max(0, -e.lidTilt);
    const lean = 0.45 * Math.cos(this.heading);
    for (const side of [-1, 1]) {
      const sway = 0.1 * Math.sin(this.t * 3.1 + side) + 0.12 * noise1(this.t * 2, this.seed + side);
      const a0 = -Math.PI / 2 + side * 0.42 + lean * 0.3;
      const a1 = -Math.PI / 2 + side * (0.55 - perk * 0.35) + lean + sway;
      const bx = Math.cos(a0) * r * 0.82, by = Math.sin(a0) * r * 0.82;
      const len = r * (0.62 + 0.18 * perk);
      const droop = Math.max(0, -perk) * r * 0.25;
      const tx = bx + Math.cos(a1) * len, ty = by + Math.sin(a1) * len + droop;
      const mx = bx + Math.cos(a0) * len * 0.6, my = by + Math.sin(a0) * len * 0.6;
      ctx.strokeStyle = col.dark;
      ctx.lineWidth = r * 0.08;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(mx, my, tx, ty);
      ctx.stroke();
      const g = ctx.createRadialGradient(tx - r * 0.05, ty - r * 0.06, 0, tx, ty, r * 0.19);
      g.addColorStop(0, "#ffffff");
      g.addColorStop(0.45, col.light);
      g.addColorStop(1, col.fill);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(tx, ty, r * 0.16, 0, TAU);
      ctx.fill();
      ctx.lineWidth = r * 0.045;
      ctx.stroke();
    }
  }

  // Soft round toy: drop shadow, gradient body, rim, gloss highlight, feelers for heading.
  private bodyCute(ctx: Ctx): void {
    const r = this.r, col = this.colors("cute");
    softShadow(ctx, r * 0.12, r * 0.32, r * 1.3, r * 1.15, 0.55);
    if (this.hunter) this.horns(ctx, col); else this.antennae(ctx, col);
    ctx.fillStyle = col.rim;
    this.bodyPath(ctx);
    ctx.fill();
    const g = ctx.createRadialGradient(-r * 0.35, -r * 0.45, r * 0.1, 0, 0, r * 1.05);
    g.addColorStop(0, col.light);
    g.addColorStop(0.55, col.fill);
    g.addColorStop(1, col.rim);
    ctx.fillStyle = g;
    this.bodyPath(ctx, 0.94);
    ctx.fill();
    ctx.strokeStyle = col.dark;
    ctx.lineWidth = r * 0.07;
    ctx.lineJoin = "round";
    this.bodyPath(ctx);
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
    ctx.beginPath();
    ctx.ellipse(-r * 0.42, -r * 0.55, r * 0.22, r * 0.12, -0.6, 0, TAU);
    ctx.fill();
  }

  // Glowing outline over a dark body, line-art face; reads as "digital".
  private bodyNeon(ctx: Ctx): void {
    const r = this.r, col = this.colors("neon");
    ctx.fillStyle = "rgba(6, 14, 11, 0.9)";
    this.bodyPath(ctx);
    ctx.fill();
    const g = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r);
    g.addColorStop(0, `hsla(${this.hue}, 90%, 60%, 0)`);
    g.addColorStop(1, `hsla(${lerp(this.hue, 95, this.expr.tint)}, 90%, 60%, 0.35)`);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.save();
    ctx.shadowColor = col.fill;
    ctx.shadowBlur = r * 0.7;
    ctx.strokeStyle = col.light;
    ctx.lineWidth = r * 0.09;
    ctx.stroke();
    if (!this.hunter) {
      ctx.fillStyle = col.light;
      this.nose(ctx, r * 1.12, r * 1.55, r * 0.28);
      ctx.fill();
    }
    ctx.restore();
  }

  private face(ctx: Ctx, style: StyleName): void {
    const r = this.r, e = this.expr, col = this.colors(style);
    // The face stays upright and slides toward the heading so the creature looks where it goes.
    const fx = Math.cos(this.heading) * r * 0.2, fy = Math.sin(this.heading) * r * 0.16;
    const eyeR = r * (style === "cute" ? 0.27 : 0.22);
    const gap = r * (style === "cute" ? 0.36 : 0.38);
    const eyeY = fy - r * 0.12;
    const open = clamp(e.eyeOpen * this.blink(), 0, 1.3);
    const lookX = clamp(this.lookX + Math.cos(this.heading) * 0.5, -1, 1);
    const lookY = clamp(this.lookY + Math.sin(this.heading) * 0.5, -1, 1);
    const skin = style === "classic" ? "rgb(15, 23, 20)" : style === "neon" ? "rgb(6, 14, 11)" : col.fill;
    const ink = style === "neon" ? col.light : style === "classic" ? "rgb(232, 245, 238)" : col.dark;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(fx + side * gap, eyeY);
      this.eye(ctx, style, eyeR, open, side, lookX, lookY, skin, ink);
      ctx.restore();
      // Brows: inner end down when angry (lidTilt > 0), up when sad.
      if (e.brow > 0.02) {
        const by = -eyeR * (open * 0.9 + 0.55) - r * 0.08 * e.browY;
        const tilt = 0.55 * e.lidTilt;
        ctx.save();
        ctx.translate(fx + side * gap, eyeY + by);
        ctx.rotate(-side * tilt);
        ctx.globalAlpha *= clamp(e.brow);
        ctx.strokeStyle = ink;
        ctx.lineCap = "round";
        ctx.lineWidth = r * 0.075;
        ctx.beginPath();
        ctx.moveTo(-eyeR * 0.85, 0);
        ctx.quadraticCurveTo(0, -eyeR * 0.25, eyeR * 0.85, 0);
        ctx.stroke();
        ctx.restore();
      }
    }
    // Blush.
    if (e.blush > 0.02 && style !== "neon") {
      ctx.fillStyle = `rgba(255, 120, 150, ${clamp(e.blush * 0.38, 0, 0.6)})`;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(fx + side * gap * 1.32, eyeY + eyeR * 1.35, eyeR * 0.62, eyeR * 0.34, 0, 0, TAU);
        ctx.fill();
      }
    }
    this.mouth(ctx, style, fx, fy + r * 0.32, ink);
  }

  private eye(ctx: Ctx, style: StyleName, er: number, open: number, side: number, lx: number, ly: number, skin: string, ink: string): void {
    const e = this.expr;
    const ry = er * 1.08 * open;
    if (open < 0.14) {
      // Closed: a soft arc, smiling when happy.
      ctx.strokeStyle = ink;
      ctx.lineWidth = er * 0.28;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(-er * 0.8, 0);
      ctx.quadraticCurveTo(0, er * (0.45 - e.happyLids * 0.9), er * 0.8, 0);
      ctx.stroke();
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, er, ry, 0, 0, TAU);
    if (style === "neon") {
      ctx.fillStyle = "rgba(220, 255, 240, 0.12)";
      ctx.fill();
    } else {
      ctx.fillStyle = "#fbfffd";
      ctx.fill();
    }
    ctx.clip();
    // Pupil, shrinking a bit with surprise.
    const pr = er * 0.6 * e.pupil;
    const px = lx * er * 0.32, py = ly * ry * 0.3 + er * 0.06;
    if (style === "neon") {
      ctx.fillStyle = ink;
      ctx.shadowColor = ink;
      ctx.shadowBlur = er;
      ctx.beginPath();
      ctx.arc(px, py, pr * 0.62, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = style === "cute" ? "#1d1430" : "#0b1410";
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, TAU);
      ctx.fill();
      if (style === "cute") {
        ctx.fillStyle = `hsla(${this.hue}, 70%, 45%, 0.55)`;
        ctx.beginPath();
        ctx.arc(px, py + pr * 0.35, pr * 0.6, 0, Math.PI);
        ctx.fill();
      }
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(px - pr * 0.35, py - pr * 0.38, pr * 0.32, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px + pr * 0.3, py + pr * 0.32, pr * 0.14, 0, TAU);
      ctx.fill();
    }
    // Upper lid: a sloped edge, inner corner lower when angry, outer lower when sad.
    const tilt = e.lidTilt;
    const lidDrop = Math.max(0, 0.95 - open) * 0.6;
    const inner = -ry + ry * 2 * (lidDrop + Math.max(0, tilt) * 0.55);
    const outer = -ry + ry * 2 * (lidDrop + Math.max(0, -tilt) * 0.5);
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.moveTo(side * er * 1.1, outer - er * 0.1 * Math.abs(tilt));
    ctx.lineTo(-side * er * 1.1, inner);
    ctx.lineTo(-side * er * 1.1, -ry * 2);
    ctx.lineTo(side * er * 1.1, -ry * 2);
    ctx.closePath();
    ctx.fill();
    if (Math.abs(tilt) > 0.05 && style !== "neon") {
      ctx.strokeStyle = ink;
      ctx.lineWidth = er * 0.16;
      ctx.beginPath();
      ctx.moveTo(side * er * 1.1, outer - er * 0.1 * Math.abs(tilt));
      ctx.lineTo(-side * er * 1.1, inner);
      ctx.stroke();
    }
    // Happy lower lids push up into a crescent.
    if (e.happyLids > 0.02) {
      ctx.beginPath();
      ctx.arc(0, ry * (2.15 - 1.25 * e.happyLids), er * 1.35, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    // Rim.
    ctx.strokeStyle = ink;
    ctx.lineWidth = er * (style === "cute" ? 0.14 : 0.12);
    ctx.beginPath();
    ctx.ellipse(0, 0, er, ry, 0, 0, TAU);
    if (style === "neon") {
      ctx.save();
      ctx.shadowColor = ink;
      ctx.shadowBlur = er * 0.8;
      ctx.stroke();
      ctx.restore();
    } else if (style === "cute") ctx.stroke();
  }

  private mouth(ctx: Ctx, style: StyleName, mx: number, my: number, ink: string): void {
    const e = this.expr, r = this.r;
    const w = r * 0.3 * e.mouthWide;
    const curve = e.mouthCurve * r * 0.16;
    const open = clamp(e.mouthOpen + this.chew * 0.5 * (0.5 + 0.5 * Math.sin(this.t * 38)), 0, 1.1);
    const wob = (u: number): number => e.wobble * r * 0.045 * Math.sin(u * Math.PI * 4 + this.t * 9);
    const N = 16;
    const upper: [number, number][] = [];
    const lower: [number, number][] = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N, x = (u - 0.5) * 2 * w;
      const arc = 1 - (2 * u - 1) ** 2;
      upper.push([x, curve * (arc - 0.5) + wob(u)]); // smile: centre below the corners
      lower.push([x, upper[i]![1] + open * r * 0.32 * arc + Math.max(0, curve) * arc * 0.5 * open]);
    }
    ctx.save();
    ctx.translate(mx, my);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (open > 0.06) {
      ctx.beginPath();
      upper.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      for (let i = N; i >= 0; i--) ctx.lineTo(lower[i]![0], lower[i]![1]);
      ctx.closePath();
      ctx.fillStyle = style === "neon" ? "rgba(255, 255, 255, 0.08)" : "#3a0f1c";
      ctx.fill();
      ctx.save();
      ctx.clip();
      if (style !== "neon" && e.teeth < 0.6) {
        ctx.fillStyle = "#ff7b93";
        ctx.beginPath();
        ctx.ellipse(0, lower[N / 2]![1], w * 0.55, open * r * 0.14, 0, 0, TAU);
        ctx.fill();
      }
      // Gritted teeth: the mouth fills white with a bite line and tooth gaps.
      if (e.teeth > 0.05) {
        ctx.globalAlpha *= clamp(e.teeth);
        ctx.fillStyle = style === "neon" ? "rgba(230, 255, 245, 0.5)" : "#ffffff";
        ctx.fillRect(-w * 1.2, -r, w * 2.4, 2 * r);
        ctx.strokeStyle = style === "neon" ? ink : "rgba(60, 20, 30, 0.7)";
        ctx.lineWidth = r * 0.03;
        ctx.beginPath();
        const mid = (upper[N / 2]![1] + lower[N / 2]![1]) / 2;
        ctx.moveTo(-w * 1.2, mid);
        ctx.lineTo(w * 1.2, mid);
        for (let k = -2; k <= 2; k++) { ctx.moveTo((k * w) / 3, -r); ctx.lineTo((k * w) / 3, r); }
        ctx.stroke();
      }
      ctx.restore();
      ctx.beginPath();
      upper.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      for (let i = N; i >= 0; i--) ctx.lineTo(lower[i]![0], lower[i]![1]);
      ctx.closePath();
      ctx.strokeStyle = ink;
      ctx.lineWidth = r * 0.06;
      if (style === "neon") { ctx.shadowColor = ink; ctx.shadowBlur = r * 0.2; }
      ctx.stroke();
    } else {
      ctx.strokeStyle = style === "classic" ? "rgb(232, 245, 238)" : ink;
      ctx.lineWidth = r * 0.07;
      if (style === "neon") { ctx.shadowColor = ink; ctx.shadowBlur = r * 0.2; }
      ctx.beginPath();
      upper.forEach(([x, y], i) => (i ? ctx.lineTo(x, y + (lower[i]![1] - y) * 0.5) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    // Hunters show two little fangs under the upper lip.
    if (this.hunter && e.teeth < 0.5) {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = style === "neon" ? ink : "rgba(40, 10, 20, 0.6)";
      ctx.lineWidth = r * 0.025;
      for (const side of [-1, 1]) {
        const x = side * w * 0.5, y = curve * ((1 - (2 * (0.5 + side * 0.25) - 1) ** 2) - 0.5);
        ctx.beginPath();
        ctx.moveTo(x - r * 0.06, y);
        ctx.lineTo(x + r * 0.06, y);
        ctx.lineTo(x, y + r * 0.13);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Anchor above the head for emote icons, in world space.
  head(dy = 1.25): { x: number; y: number } {
    return { x: this.x, y: this.y - this.r * dy * this.scale };
  }

  get facing(): number { return wrapAngle(this.heading); }
}
