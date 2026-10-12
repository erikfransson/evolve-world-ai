import { createRng } from "../sim/rng.ts";
import { TERRAIN_FAST, TERRAIN_SLOW } from "../sim/terrain.ts";
import type { Terrain } from "../sim/terrain.ts";

// Draws a Terrain (rock and slow and fast ground) for the Trials scene and the Ecosystem renderer, in world coordinates under the
// current transform. Ground is a soft tint baked once per map into a small image (the legend names the kinds, no symbols on it).
// Rock is drawn live as stacked fills of the union of its discs, lit from the top left, so its edge is exactly where creatures bounce.

export interface View {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

// Slow ground reads as damp blue-grey mud, fast ground as pale dry gold.
const GROUND = [{ kind: TERRAIN_SLOW, tint: "rgba(86, 116, 178, 0.46)" }, { kind: TERRAIN_FAST, tint: "rgba(222, 204, 80, 0.3)" }] as const;
const GROUND_IMAGE_PX = 1600; // longest side of the baked ground image
const EDGE_SOFT = 70; // world units of blur on a patch edge

const HALO = "rgba(2, 8, 6, 0.17)";
const EDGE_DARK = "#141b19";
const EDGE_LIT = "#7b8982";
const CORE_FROM = 0.3; // scale (device px per world unit) from which the lighter core is drawn
const ROCK_TILE_UNITS = 300; // world units one grain tile covers
const ROCK_TILE_PX = 192;

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

const context2d = (c: OffscreenCanvas | HTMLCanvasElement | null): CanvasRenderingContext2D | null => (c ? (c.getContext("2d") as CanvasRenderingContext2D | null) : null);

// A seamless tile of mottled rock: flat base colour with soft light and dark blotches and a few hairline cracks.
function rockTile(base: string, seed: number): OffscreenCanvas | HTMLCanvasElement | null {
  const c = makeCanvas(ROCK_TILE_PX, ROCK_TILE_PX);
  const g = context2d(c);
  if (!c || !g) return null;
  const rng = createRng(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, ROCK_TILE_PX, ROCK_TILE_PX);
  const wrapped = (draw: (dx: number, dy: number) => void): void => {
    for (const dx of [-ROCK_TILE_PX, 0, ROCK_TILE_PX]) for (const dy of [-ROCK_TILE_PX, 0, ROCK_TILE_PX]) draw(dx, dy);
  };
  for (let i = 0; i < 140; i++) {
    const x = rng.range(0, ROCK_TILE_PX);
    const y = rng.range(0, ROCK_TILE_PX);
    const r = rng.range(3, 12);
    g.fillStyle = rng.next() < 0.5 ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.08)";
    wrapped((dx, dy) => {
      g.beginPath();
      g.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      g.fill();
    });
  }
  g.strokeStyle = "rgba(0, 0, 0, 0.22)";
  g.lineWidth = 0.8;
  for (let i = 0; i < 7; i++) {
    const x = rng.range(0, ROCK_TILE_PX);
    const y = rng.range(0, ROCK_TILE_PX);
    const a = rng.range(0, Math.PI);
    const len = rng.range(14, 40);
    wrapped((dx, dy) => {
      g.beginPath();
      g.moveTo(x + dx, y + dy);
      g.lineTo(x + dx + Math.cos(a) * len * 0.5 + rng.range(-4, 4), y + dy + Math.sin(a) * len * 0.5);
      g.lineTo(x + dx + Math.cos(a) * len, y + dy + Math.sin(a) * len);
      g.stroke();
    });
  }
  return c;
}

interface Baked {
  ground: OffscreenCanvas | HTMLCanvasElement | null; // padded by EDGE_SOFT * 2 on every side
}
const baked = new WeakMap<Terrain, Baked>();

function bakeGround(t: Terrain): OffscreenCanvas | HTMLCanvasElement | null {
  if (t.patchX.length === 0) return null;
  const pad = 2 * EDGE_SOFT;
  const s = Math.min(1, GROUND_IMAGE_PX / Math.max(t.width, t.height));
  const canvas = makeCanvas(Math.ceil((t.width + 2 * pad) * s), Math.ceil((t.height + 2 * pad) * s));
  const g = context2d(canvas);
  if (!canvas || !g) return null;
  g.scale(s, s);
  g.translate(pad, pad);
  if ("filter" in g) g.filter = `blur(${EDGE_SOFT * 0.5 * s}px)`;
  for (const { kind, tint } of GROUND) {
    g.fillStyle = tint;
    g.beginPath();
    for (let i = 0; i < t.patchX.length; i++) {
      if (t.patchKind[i] !== kind) continue;
      g.moveTo(t.patchX[i]! + t.patchR[i]!, t.patchY[i]!);
      g.arc(t.patchX[i]!, t.patchY[i]!, t.patchR[i]!, 0, Math.PI * 2);
    }
    g.fill();
  }
  return canvas;
}

const tiles = new WeakMap<CanvasRenderingContext2D, { body: CanvasPattern | null; core: CanvasPattern | null }>();

function rockPatterns(ctx: CanvasRenderingContext2D) {
  let p = tiles.get(ctx);
  if (!p) {
    const make = (base: string, seed: number): CanvasPattern | null => {
      const tile = rockTile(base, seed);
      const pattern = tile ? ctx.createPattern(tile as CanvasImageSource, "repeat") : null;
      pattern?.setTransform(new DOMMatrix().scale(ROCK_TILE_UNITS / ROCK_TILE_PX));
      return pattern;
    };
    tiles.set(ctx, (p = { body: make("#2b3633", 11), core: make("#3a4742", 12) }));
  }
  return p;
}

function drawGround(ctx: CanvasRenderingContext2D, t: Terrain): void {
  let b = baked.get(t);
  if (!b) baked.set(t, (b = { ground: bakeGround(t) }));
  if (b.ground) {
    const pad = 2 * EDGE_SOFT;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, t.width, t.height);
    ctx.clip();
    ctx.drawImage(b.ground as CanvasImageSource, -pad, -pad, t.width + 2 * pad, t.height + 2 * pad);
    ctx.restore();
  } else if (t.patchX.length > 0) {
    // No canvas to bake on: plain hard-edged tint.
    for (const { kind, tint } of GROUND) {
      ctx.fillStyle = tint;
      ctx.beginPath();
      for (let i = 0; i < t.patchX.length; i++) if (t.patchKind[i] === kind) discPath(ctx, t.patchX[i]!, t.patchY[i]!, t.patchR[i]!);
      ctx.fill();
    }
  }
}

function discPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

// Adds the rock discs in view to the current path, each shrunk by inset world units (at most a third of its radius) and moved by (dx, dy).
function addRock(ctx: CanvasRenderingContext2D, t: Terrain, view: View, inset: number, dx = 0, dy = 0): void {
  for (let i = 0; i < t.rockCount; i++) {
    const r = t.rockR[i]!;
    const x = t.rockX[i]!;
    const y = t.rockY[i]!;
    if (x + r + dx < view.x0 || x - r + dx > view.x1 || y + r + dy < view.y0 || y - r + dy > view.y1) continue;
    discPath(ctx, x + dx, y + dy, r - Math.min(inset, r / 3));
  }
}

function fillRock(ctx: CanvasRenderingContext2D, t: Terrain, view: View, inset: number, dx = 0, dy = 0): void {
  ctx.beginPath();
  addRock(ctx, t, view, inset, dx, dy);
  ctx.fill();
}

function drawRock(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View): void {
  if (t.rockCount === 0) return;
  const px = 1 / scale;
  const edge = Math.min(1, Math.max(0.5, scale / 0.25)); // thinner rim and shade from afar
  const patterns = rockPatterns(ctx);
  // The shadow reaches past the edge, softer the further out, and falls down and right.
  ctx.fillStyle = HALO;
  fillRock(ctx, t, view, -7 * edge * px, 3 * edge * px, 4.5 * edge * px);
  fillRock(ctx, t, view, -3.5 * edge * px, 2 * edge * px, 3 * edge * px);
  // Everything else stays inside the exact union of the discs, so the outline is where creatures bounce.
  ctx.save();
  ctx.beginPath();
  addRock(ctx, t, view, 0);
  ctx.clip();
  ctx.fillStyle = EDGE_DARK;
  ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
  ctx.fillStyle = EDGE_LIT; // a thin lit rim on the upper left edges, left dark on the lower right
  fillRock(ctx, t, view, 0, -1.2 * edge * px, -1.2 * edge * px);
  ctx.fillStyle = patterns.body ?? "#2b3633";
  fillRock(ctx, t, view, 2.4 * edge * px);
  if (scale >= CORE_FROM) {
    // a lighter core off to the upper left, where the light falls; too small to read from afar
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = patterns.core ?? "#3a4742";
    fillRock(ctx, t, view, 6 * px, -2.2 * px, -3 * px);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// Draws the ground, then the rock, in world coordinates. scale: device pixels per world unit. view: the visible world rectangle.
export function drawTerrain(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View = { x0: 0, x1: t.width, y0: 0, y1: t.height }): void {
  if (t.empty) return;
  drawGround(ctx, t);
  drawRock(ctx, t, scale, view);
}
