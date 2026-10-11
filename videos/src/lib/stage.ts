// Floor, food and poison, and the camera, in the three styles.
import { createCanvas } from "@napi-rs/canvas";
import type { Canvas } from "@napi-rs/canvas";
import type { Critter, Ctx, StyleName } from "./critter.ts";
import { clamp, easeIn, easeOutBack, noise1, rng } from "./ease.ts";
import { glow, softShadow } from "./paint.ts";

const TAU = Math.PI * 2;
export const SITE = { background: "#0b1d16", floor: "#10291f", wall: "#9fb8ad", food: "#4ade80", poison: "#e040fb" };

export interface Camera { x: number; y: number; zoom: number; rot?: number; shake?: number }

// World units to pixels: `zoom` 1 fits `fit` world units across the frame height.
export function applyCamera(ctx: Ctx, W: number, H: number, cam: Camera, fit: number, t: number): void {
  const s = (H / fit) * cam.zoom;
  const sh = (cam.shake ?? 0) * fit * 0.01;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(W / 2 + sh * noise1(t * 30, 3) * s, H / 2 + sh * noise1(t * 30, 7) * s);
  ctx.scale(s, s);
  ctx.rotate(cam.rot ?? 0);
  ctx.translate(-cam.x, -cam.y);
}

// Keeps the view inside a world of ww x wh (with room for a slight rotation).
export function clampCamera(cam: Camera, W: number, H: number, fit: number, ww: number, wh: number): Camera {
  const halfH = (fit / cam.zoom / 2) * (1 + Math.abs(cam.rot ?? 0) * 2), halfW = halfH * (W / H);
  const x = halfW * 2 >= ww ? ww / 2 : clamp(cam.x, halfW, ww - halfW);
  const y = halfH * 2 >= wh ? wh / 2 : clamp(cam.y, halfH, wh - halfH);
  return { ...cam, x, y };
}

export type ItemKind = "food" | "poison";
export interface Item { x: number; y: number; kind: ItemKind; r: number; born: number; eatenAt: number; eater?: Critter; seed: number }

export function item(x: number, y: number, kind: ItemKind, r: number, born = -1, seed = 1): Item {
  return { x, y, kind, r, born, eatenAt: -1, seed };
}

// Draws one item; eaten items shrink into the eater's mouth over 0.18 s.
export function drawItem(ctx: Ctx, it: Item, style: StyleName, t: number): void {
  if (t < it.born) return;
  let x = it.x, y = it.y;
  let s = it.born < 0 ? 1 : easeOutBack(clamp((t - it.born) / 0.35));
  if (it.eatenAt >= 0 && t >= it.eatenAt) {
    const u = clamp((t - it.eatenAt) / 0.18);
    if (u >= 1) return;
    if (it.eater) { x += (it.eater.x - x) * easeIn(u); y += (it.eater.y + it.eater.r * 0.3 - y) * easeIn(u); }
    s *= 1 - u;
  }
  const r = it.r * s * (1 + 0.06 * Math.sin(t * 3 + it.seed * 5));
  if (r <= 0) return;
  const poison = it.kind === "poison";
  if (style === "classic") {
    ctx.fillStyle = poison ? SITE.poison : SITE.food;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    return;
  }
  if (style === "neon") {
    glow(ctx, x, y, r * 3, poison ? "255, 61, 245" : "77, 255, 154", 0.55);
    ctx.fillStyle = poison ? "#ffb3fb" : "#c6ffd9";
    ctx.beginPath();
    ctx.arc(x, y, r * 0.75, 0, TAU);
    ctx.fill();
    return;
  }
  // Cute: a glossy berry with a leaf, or a spotted toxic berry with a tiny skull.
  softShadow(ctx, x + r * 0.12, y + r * 0.45, r * 1.25, r * 0.95, 0.5);
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  g.addColorStop(0, poison ? "#f6b6ff" : "#c9ffd9");
  g.addColorStop(0.5, poison ? "#b03ad6" : "#3fd476");
  g.addColorStop(1, poison ? "#5e1a7a" : "#1b8a48");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  if (poison) {
    ctx.fillStyle = "rgba(40, 0, 50, 0.55)";
    const sp = rng(it.seed);
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.arc(x + (sp() - 0.5) * r, y + (sp() - 0.3) * r, r * (0.1 + 0.08 * sp()), 0, TAU);
      ctx.fill();
    }
    skull(ctx, x, y + r * 0.1, r * 0.42);
  } else {
    ctx.fillStyle = "#2f7d3a";
    ctx.beginPath();
    ctx.ellipse(x + r * 0.35, y - r * 0.95, r * 0.45, r * 0.2, -0.5, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
  ctx.beginPath();
  ctx.ellipse(x - r * 0.38, y - r * 0.42, r * 0.22, r * 0.13, -0.6, 0, TAU);
  ctx.fill();
}

function skull(ctx: Ctx, x: number, y: number, s: number): void {
  ctx.fillStyle = "rgba(255, 240, 255, 0.92)";
  ctx.beginPath();
  ctx.arc(x, y - s * 0.15, s * 0.62, 0, TAU);
  ctx.fill();
  ctx.fillRect(x - s * 0.35, y + s * 0.2, s * 0.7, s * 0.38);
  ctx.fillStyle = "#4a0c5e";
  for (const sx of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + sx * s * 0.24, y - s * 0.12, s * 0.15, 0, TAU);
    ctx.fill();
  }
}

// Floor of a world `w` x `h` in the given style, drawn in world space.
export function drawFloor(ctx: Ctx, style: StyleName, w: number, h: number, t: number, seed = 5): void {
  if (style === "classic") {
    ctx.fillStyle = SITE.floor;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = SITE.wall;
    ctx.lineWidth = Math.max(w, h) * 0.004;
    ctx.strokeRect(0, 0, w, h);
    return;
  }
  if (style === "neon") {
    ctx.fillStyle = "#050c0a";
    ctx.fillRect(0, 0, w, h);
    const step = Math.max(w, h) / 24;
    ctx.strokeStyle = "rgba(80, 255, 190, 0.07)";
    ctx.lineWidth = step * 0.03;
    ctx.beginPath();
    for (let x = 0; x <= w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = 0; y <= h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    ctx.save();
    ctx.shadowColor = "#5dffc0";
    ctx.shadowBlur = step * 0.5;
    ctx.strokeStyle = "rgba(140, 255, 210, 0.8)";
    ctx.lineWidth = step * 0.06;
    ctx.strokeRect(0, 0, w, h);
    ctx.restore();
    return;
  }
  // Cute: a mossy pond floor (cached, it never changes) with drifting light on top.
  const key = `${w}x${h}:${seed}`;
  let tex = floorCache.get(key);
  if (!tex) {
    const k = FLOOR_PX;
    tex = createCanvas(Math.round(w * k), Math.round(h * k));
    const c = tex.getContext("2d");
    c.scale(k, k);
    mossFloor(c, w, h, seed);
    floorCache.set(key, tex);
  }
  ctx.drawImage(tex, 0, 0, w, h);
  const m = Math.max(w, h);
  // Slow caustic light bands.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let k = 0; k < 6; k++) {
    const cx = (w * (k + 0.5)) / 6 + Math.sin(t * 0.3 + k) * w * 0.05;
    const cy = h * (0.3 + 0.4 * ((k * 37) % 10) / 10) + Math.cos(t * 0.25 + k * 2) * h * 0.05;
    const rr = m * 0.18;
    const b = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
    b.addColorStop(0, "rgba(160, 255, 200, 0.05)");
    b.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = b;
    ctx.fillRect(cx - rr, cy - rr, 2 * rr, 2 * rr);
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(190, 240, 210, 0.35)";
  ctx.lineWidth = m * 0.004;
  ctx.strokeRect(0, 0, w, h);
}

// Screen-space vignette and backdrop outside the world.
export function vignette(ctx: Ctx, W: number, H: number, amount = 0.55): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  g.addColorStop(0, "rgba(0, 0, 0, 0)");
  g.addColorStop(1, `rgba(0, 6, 3, ${amount})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

const FLOOR_PX = 12; // texture pixels per world unit, enough for the closest zoom at 1080p
const floorCache = new Map<string, Canvas>();

function mossFloor(ctx: Ctx, w: number, h: number, seed: number): void {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#1c4a35");
  g.addColorStop(1, "#123426");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const r = rng(seed);
  const m = Math.max(w, h);
  for (let k = 0; k < 40; k++) {
    const x = r() * w, y = r() * h, rr = m * (0.03 + 0.08 * r());
    const b = ctx.createRadialGradient(x, y, 0, x, y, rr);
    const light = r() < 0.5;
    b.addColorStop(0, light ? "rgba(120, 200, 140, 0.10)" : "rgba(5, 25, 15, 0.18)");
    b.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = b;
    ctx.fillRect(x - rr, y - rr, 2 * rr, 2 * rr);
  }
  for (let k = 0; k < 70; k++) {
    const x = r() * w, y = r() * h, rr = m * (0.002 + 0.004 * r());
    ctx.fillStyle = `rgba(${170 + 40 * r()}, ${210 + 30 * r()}, 190, ${0.08 + 0.1 * r()})`;
    ctx.beginPath();
    ctx.ellipse(x, y, rr * 1.3, rr, r() * 3, 0, TAU);
    ctx.fill();
  }
}
