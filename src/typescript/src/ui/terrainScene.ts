import { createRng } from "../sim/rng.ts";
import { TERRAIN_FAST, TERRAIN_SLOW } from "../sim/terrain.ts";
import type { Terrain } from "../sim/terrain.ts";

// Draws a Terrain (rock and slow and fast ground) for the Trials scene and the Ecosystem renderer, in world coordinates under the
// current transform. Ground is a soft tint baked once per map into a small image, with vector marks (ripples, chevrons) that fade in
// when zoomed in. Rock is drawn live as stacked fills of its discs, so edges stay crisp at every zoom.

export interface View {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

// Slow ground reads as damp blue-grey mud, fast ground as pale dry gold.
const GROUND = [{ kind: TERRAIN_SLOW, tint: "rgba(86, 116, 178, 0.46)", mark: "rgba(176, 198, 240, 0.5)" }, { kind: TERRAIN_FAST, tint: "rgba(222, 204, 80, 0.3)", mark: "rgba(255, 238, 150, 0.6)" }] as const;
const GROUND_IMAGE_PX = 1600; // longest side of the baked ground image
const EDGE_SOFT = 70; // world units of blur on a patch edge
const MARK_CELL = 100; // world units between ripples and chevrons
const MARKS_FROM = 0.1; // marks fade in between these scales (device px per world unit)
const MARKS_FULL = 0.22;

const HALO = "rgba(3, 9, 7, 0.3)";
const RIM = "#5e686f";
const HALO_PX = 7; // screen px the shadow reaches past the rim, offset down and right
const BEVEL_PX = 3.2; // screen px between the rim, the body and the core
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
    tiles.set(ctx, (p = { body: make("#2d3439", 11), core: make("#384046", 12) }));
  }
  return p;
}

const hash = (i: number, j: number, k: number): number => {
  let h = Math.imul(i * 73856093 ^ j * 19349663 ^ k * 83492791, 0x2545f491);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
};

// One ripple (slow) or chevron (fast) per cell of the view that lies on that ground.
function drawMarks(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View): void {
  const fade = Math.min(1, Math.max(0, (scale - MARKS_FROM) / (MARKS_FULL - MARKS_FROM)));
  if (fade <= 0) return;
  ctx.globalAlpha = fade;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1.4 / scale, 2.2);
  const i0 = Math.max(0, Math.floor(view.x0 / MARK_CELL));
  const i1 = Math.min(Math.floor(t.width / MARK_CELL), Math.floor(view.x1 / MARK_CELL));
  const j0 = Math.max(0, Math.floor(view.y0 / MARK_CELL));
  const j1 = Math.min(Math.floor(t.height / MARK_CELL), Math.floor(view.y1 / MARK_CELL));
  for (const { kind, mark } of GROUND) {
    ctx.strokeStyle = mark;
    ctx.beginPath();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.15 + 0.7 * hash(i, j, 1)) * MARK_CELL;
        const y = (j + 0.15 + 0.7 * hash(i, j, 2)) * MARK_CELL;
        if (x > t.width || y > t.height || t.valueAt(x, y) !== kind) continue;
        if (kind === TERRAIN_SLOW) {
          // a short wave
          ctx.moveTo(x - 14, y);
          ctx.quadraticCurveTo(x - 7, y - 7, x, y);
          ctx.quadraticCurveTo(x + 7, y + 7, x + 14, y);
        } else {
          // a chevron pointing right, two of them
          for (const dx of [-8, 6]) {
            ctx.moveTo(x + dx - 6, y - 8);
            ctx.lineTo(x + dx + 4, y);
            ctx.lineTo(x + dx - 6, y + 8);
          }
        }
      }
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
}

function drawGround(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View): void {
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
  if (t.patchX.length > 0) drawMarks(ctx, t, scale, view);
}

function discPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

// Fills the union of the rock discs in view, each shrunk by inset world units (at most a third of its radius) and moved by (dx, dy).
function fillRock(ctx: CanvasRenderingContext2D, t: Terrain, view: View, inset: number, dx = 0, dy = 0): void {
  ctx.beginPath();
  for (let i = 0; i < t.rockCount; i++) {
    const r = t.rockR[i]!;
    const x = t.rockX[i]!;
    const y = t.rockY[i]!;
    if (x + r + dx < view.x0 || x - r + dx > view.x1 || y + r + dy < view.y0 || y - r + dy > view.y1) continue;
    discPath(ctx, x + dx, y + dy, r - Math.min(inset, r / 3));
  }
  ctx.fill();
}

function drawRock(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View): void {
  if (t.rockCount === 0) return;
  const px = 1 / scale;
  const patterns = rockPatterns(ctx);
  ctx.fillStyle = HALO;
  // The shadow spreads past the rim (negative inset) and falls down and right.
  fillRock(ctx, t, view, -HALO_PX * 0.6 * px, HALO_PX * 0.5 * px, HALO_PX * 0.7 * px);
  ctx.fillStyle = RIM;
  fillRock(ctx, t, view, 0);
  ctx.fillStyle = patterns.body ?? "#2d3439";
  fillRock(ctx, t, view, BEVEL_PX * px);
  ctx.fillStyle = patterns.core ?? "#384046";
  fillRock(ctx, t, view, 3.2 * BEVEL_PX * px);
}

// Draws the ground, then the rock, in world coordinates. scale: device pixels per world unit. view: the visible world rectangle.
export function drawTerrain(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View = { x0: 0, x1: t.width, y0: 0, y1: t.height }): void {
  if (t.empty) return;
  drawGround(ctx, t, scale, view);
  drawRock(ctx, t, scale, view);
}
