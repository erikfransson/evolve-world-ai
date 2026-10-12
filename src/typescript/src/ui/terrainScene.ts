import { createRng } from "../sim/rng.ts";
import { TERRAIN_FAST, TERRAIN_SLOW } from "../sim/terrain.ts";
import type { Terrain } from "../sim/terrain.ts";
import { rockBodies, traceLoop } from "./rockOutline.ts";
import type { RockBody } from "./rockOutline.ts";

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

const HALO = "rgba(2, 8, 6, 0.2)";
const EDGE_DARK = "#141b19";
const EDGE_LIT = "#7b8982";
const CRACKS_FROM = 0.25; // scale (device px per world unit) from which cracks are drawn
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
  for (let i = 0; i < 520; i++) {
    const x = rng.range(0, ROCK_TILE_PX);
    const y = rng.range(0, ROCK_TILE_PX);
    const big = i < 60; // a few broad soft mottles, then fine grain
    const r = big ? rng.range(8, 20) : rng.range(0.5, 1.4);
    g.fillStyle = big ? (rng.next() < 0.5 ? "rgba(255, 255, 255, 0.012)" : "rgba(0, 0, 0, 0.035)") : rng.next() < 0.5 ? "rgba(255, 255, 255, 0.07)" : "rgba(0, 0, 0, 0.16)";
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

interface Drawable {
  body: RockBody;
  outline: Path2D;
  detail: { tones: Path2D[]; cracks: Path2D } | null; // the facets and cracks as paths, made when first drawn
}
const drawables = new WeakMap<Terrain, Drawable[]>();

function drawablesOf(t: Terrain): Drawable[] {
  let d = drawables.get(t);
  if (!d) {
    d = rockBodies(t).map((body) => {
      const outline = new Path2D();
      for (const loop of body.loops) traceLoop(outline, loop);
      return { body, outline, detail: null };
    });
    drawables.set(t, d);
  }
  return d;
}

function detailOf(d: Drawable): { tones: Path2D[]; cracks: Path2D } {
  if (!d.detail) {
    const { facets, cracks: lines } = d.body.shading();
    const tones = facets.map((polys) => {
      const path = new Path2D();
      for (const poly of polys) {
        path.moveTo(poly[0]!, poly[1]!);
        for (let i = 2; i < poly.length; i += 2) path.lineTo(poly[i]!, poly[i + 1]!);
        path.closePath();
      }
      return path;
    });
    const cracks = new Path2D();
    for (const line of lines) {
      cracks.moveTo(line[0]!, line[1]!);
      for (let i = 2; i < line.length; i += 2) cracks.lineTo(line[i]!, line[i + 1]!);
    }
    d.detail = { tones, cracks };
  }
  return d.detail;
}

// Facet fills, as the tone classes of rockOutline.ts: dark 2, dark 1, light 1, light 2.
const FACET_FILL = ["rgba(2, 8, 6, 0.3)", "rgba(2, 8, 6, 0.15)", "rgba(215, 235, 225, 0.1)", "rgba(215, 235, 225, 0.22)"] as const;
const FLAT_BODY = "#2b3633"; // a body seen from afar, and where patterns are unavailable
const CRACK = "rgba(6, 12, 10, 0.5)";
const EDGE_FADE_SCALE = 0.25; // below this scale (device px per world unit) rims and shadows thin out, to half at half of it
const VIEW_PAD_PX = 12; // screen px past a body that still draw, for its shadow
const SHADOW_NEAR = { grow: 6, alpha: 0.8 }; // two shadow layers (px): a tight dark one and a wide faint one
const SHADOW_FAR = { grow: 14, alpha: 0.5 };
const SHADOW_SHIFT = { x: 3, y: 4.5 }; // px, down and right
const RIM_PX = 2.2; // width of the dark rim band inside the edge
const LIT_SHIFT = 0.7; // the lit rim band is the outline moved this many rim widths down and right, so it shows only on the upper left
const LIT_WIDTH = 1.1; // in rim widths
const CRACK_PX = 1.1;
const NEAR_FACETS = 0.07; // from this scale the facets and cracks are drawn, below it a body is one fill and one rim

// quick: from-afar drawing at any scale (no facets or cracks), for the settings preview that redraws while sliders move.
function drawRock(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View, quick: boolean): void {
  if (t.rockCount === 0) return;
  if (typeof Path2D === "undefined") {
    ctx.fillStyle = FLAT_BODY;
    ctx.beginPath();
    for (let i = 0; i < t.rockCount; i++) discPath(ctx, t.rockX[i]!, t.rockY[i]!, t.rockR[i]!);
    ctx.fill();
    return;
  }
  const px = 1 / scale;
  const edge = Math.min(1, Math.max(0.5, scale / EDGE_FADE_SCALE));
  const pad = VIEW_PAD_PX * px;
  const shown = drawablesOf(t).filter(({ body: b }) => b.x1 + pad >= view.x0 && b.x0 - pad <= view.x1 && b.y1 + pad >= view.y0 && b.y0 - pad <= view.y1);
  const detailed = scale >= NEAR_FACETS && !quick;
  const patterns = detailed ? rockPatterns(ctx) : null;
  ctx.lineJoin = "round";
  // Shadows first, so a body never lies under the shadow of a neighbour: soft, down and right. One layer when far.
  ctx.fillStyle = HALO;
  ctx.strokeStyle = HALO;
  ctx.save();
  ctx.translate(SHADOW_SHIFT.x * edge * px, SHADOW_SHIFT.y * edge * px);
  for (const { grow, alpha } of detailed ? [SHADOW_FAR, SHADOW_NEAR] : [SHADOW_NEAR]) {
    ctx.globalAlpha = alpha;
    ctx.lineWidth = grow * edge * px;
    for (const { outline } of shown) {
      ctx.fill(outline, "evenodd");
      ctx.stroke(outline);
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  const band = RIM_PX * edge * px;
  if (!detailed) {
    // From afar: one fill and one rim per body.
    ctx.fillStyle = FLAT_BODY;
    ctx.strokeStyle = EDGE_DARK;
    ctx.lineWidth = band;
    for (const { outline } of shown) {
      ctx.fill(outline, "evenodd");
      ctx.stroke(outline);
    }
    ctx.lineJoin = "miter";
    return;
  }
  for (const d of shown) {
    const { outline } = d;
    ctx.save();
    ctx.clip(outline, "evenodd");
    ctx.fillStyle = patterns?.body ?? FLAT_BODY;
    ctx.fill(outline, "evenodd");
    const { tones, cracks } = detailOf(d);
    for (let k = 0; k < tones.length; k++) {
      ctx.fillStyle = FACET_FILL[k]!;
      ctx.fill(tones[k]!);
    }
    if (scale >= CRACKS_FROM) {
      ctx.strokeStyle = CRACK;
      ctx.lineWidth = CRACK_PX * px;
      ctx.stroke(cracks);
    }
    ctx.strokeStyle = EDGE_DARK; // a dark band inside the whole edge, a lit one on the upper left ones
    ctx.lineWidth = 2 * band;
    ctx.stroke(outline);
    ctx.save();
    ctx.translate(LIT_SHIFT * band, LIT_SHIFT * band);
    ctx.strokeStyle = EDGE_LIT;
    ctx.lineWidth = LIT_WIDTH * band;
    ctx.stroke(outline);
    ctx.restore();
    ctx.restore();
  }
  ctx.lineJoin = "miter";
}

// Draws the ground, then the rock, in world coordinates. scale: device pixels per world unit. view: the visible world rectangle.
// quick: rock as plain discs without building outlines, for previews that redraw while settings change.
export function drawTerrain(ctx: CanvasRenderingContext2D, t: Terrain, scale: number, view: View = { x0: 0, x1: t.width, y0: 0, y1: t.height }, quick = false): void {
  if (t.empty) return;
  drawGround(ctx, t);
  drawRock(ctx, t, scale, view, quick);
}
