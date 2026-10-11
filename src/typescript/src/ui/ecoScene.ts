import type { SelectedDetails, SnapshotViews } from "../worker/ecoProtocol.ts";
import { HIT_NONE } from "../sim/types.ts";
import type { Camera } from "./camera.ts";
import type { BirthRings } from "./ecoBirths.ts";
import { BACKGROUND, FLOOR, FOOD, POISON, RAY_COLORS, WALL } from "./scene.ts";

export interface EcoDrawConfig {
  worldW: number;
  worldH: number;
  radius: number;
  itemRadius: number;
  fullEnergy: number; // energy at which the body fill is full
  species?: readonly { fullEnergy: number; hunter: boolean }[]; // per species, with several; hunters are drawn with a pointed nose
  winter?: number; // 0 (summer) to 1 (mid-winter): how far the floor is tinted cold
}

const NOSE = 2; // a hunter's nose tip, in radii ahead of its centre
const NOSE_HALF = Math.acos(1 / NOSE); // where the nose lines touch the round back, so the outline is a smooth teardrop

// Adds a creature's outline to the current path: a circle, or for a hunter a round back with a pointed nose along its heading.
function bodyPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, heading: number, hunter: boolean): void {
  if (!hunter) {
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
    return;
  }
  ctx.moveTo(x + Math.cos(heading) * r * NOSE, y + Math.sin(heading) * r * NOSE);
  ctx.arc(x, y, r, heading + NOSE_HALF, heading - NOSE_HALF + 2 * Math.PI);
  ctx.closePath();
}

const WINTER_TINT = 0.16; // floor overlay opacity at mid-winter
const HUE_BUCKETS = 72;
const AGE_LEVELS = 8;
const AGE_SATURATE_S = 180; // age at which a creature has reached its most muted look
const BUCKETS = HUE_BUCKETS * AGE_LEVELS;
const DIM_BUCKET = BUCKETS; // creatures outside the highlighted lineage
const DIM_STYLE = "hsl(150, 12%, 55%)";
const DIM_ALPHA = 0.3;
const BODY = "rgba(15, 23, 20, 0.85)";
const SELECT_RING = "#eef5f1";
const DETAIL_MIN_RADIUS = 3; // CSS px; smaller creatures are drawn as flat dots
const DETAIL_MAX_COUNT = 800; // more visible creatures than this are drawn as flat dots too
const TINY_ITEM = 1.5; // device px; items smaller than this are drawn as small dim squares
const SOLID_ITEM = 4; // device px radius from which items are drawn fully opaque
const ITEM_DIM = 0.75; // item opacity at the smallest size, so the creatures stand out
const DOT_RADIUS = 2.4; // CSS px; creatures never draw smaller than this when drawn as dots
const DOT_OUTLINE = "rgba(6, 12, 9, 0.75)";

// Bright and saturated when young, lighter touch of grey-green when old.
const STYLES: string[] = [];
for (let h = 0; h < HUE_BUCKETS; h++) {
  for (let a = 0; a < AGE_LEVELS; a++) {
    const t = a / (AGE_LEVELS - 1);
    STYLES.push(`hsl(${(h * 360) / HUE_BUCKETS}, ${Math.round(88 - 48 * t)}%, ${Math.round(64 - 20 * t)}%)`);
  }
}

export function creatureBucket(hue: number, ageSeconds: number): number {
  const h = Math.round((((hue % 360) + 360) % 360) / (360 / HUE_BUCKETS)) % HUE_BUCKETS;
  const a = Math.min(AGE_LEVELS - 1, Math.max(0, Math.floor((ageSeconds / AGE_SATURATE_S) * AGE_LEVELS)));
  return h * AGE_LEVELS + a;
}

export const creatureStyle = (hue: number, ageSeconds: number): string => STYLES[creatureBucket(hue, ageSeconds)]!;

// Draws the ecosystem through a camera. Scratch arrays are kept between frames so a frame allocates nothing.
export class EcoRenderer {
  private vis = new Int32Array(1024); // snapshot indices of the creatures in view
  private visBucket = new Int32Array(1024);
  private order = new Int32Array(1024);
  private readonly counts = new Int32Array(DIM_BUCKET + 2);

  // highlight: a founder id whose descendants stay bright while everyone else is dimmed, or -1 for none.
  draw(ctx: CanvasRenderingContext2D, cam: Camera, cfg: EcoDrawConfig, v: SnapshotViews, selected: SelectedDetails | null, showRays: boolean, dpr: number, highlight = -1, births: BirthRings | null = null, now = 0): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    cam.apply(ctx);
    const z = cam.zoom;
    const dev = 1 / z; // one device pixel in world units
    const css = dpr / z;
    const pad = 2 * cfg.radius + 4 * css;
    const tl = cam.screenToWorld(0, 0);
    const br = cam.screenToWorld(ctx.canvas.width, ctx.canvas.height);
    const x0 = tl.x - pad;
    const x1 = br.x + pad;
    const y0 = tl.y - pad;
    const y1 = br.y + pad;

    ctx.fillStyle = FLOOR;
    ctx.fillRect(0, 0, cfg.worldW, cfg.worldH);
    if (cfg.winter) {
      ctx.fillStyle = `rgba(150, 190, 235, ${WINTER_TINT * cfg.winter})`;
      ctx.fillRect(0, 0, cfg.worldW, cfg.worldH);
    }
    ctx.strokeStyle = WALL;
    ctx.lineWidth = Math.max(2, 1.5 * dpr) * dev;
    ctx.strokeRect(0, 0, cfg.worldW, cfg.worldH);

    this.drawItems(ctx, cfg, v, x0, x1, y0, y1, dev, z);
    this.drawCreatures(ctx, cfg, v, x0, x1, y0, y1, css, z / dpr, highlight);
    births?.draw(ctx, now, cfg.radius, css, z / dpr);
    if (selected?.alive) this.drawSelected(ctx, cfg, selected, showRays, css);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawItems(ctx: CanvasRenderingContext2D, cfg: EcoDrawConfig, v: SnapshotViews, x0: number, x1: number, y0: number, y1: number, dev: number, z: number): void {
    const r = cfg.itemRadius;
    const px = r * z; // device px radius
    const tiny = px < TINY_ITEM;
    const side = 2 * TINY_ITEM * dev * 0.55; // about 1.6 device px
    // Dim while small, opaque once large, so mid zoom blends into the full-size items.
    const solid = Math.min(1, Math.max(0, (px - TINY_ITEM) / (SOLID_ITEM - TINY_ITEM)));
    for (const [kind, color, boost] of [[1, FOOD, 0], [2, POISON, 0.15]] as const) {
      ctx.fillStyle = color;
      ctx.globalAlpha = Math.min(1, ITEM_DIM + boost + (1 - ITEM_DIM - boost) * solid);
      ctx.beginPath();
      for (let i = 0; i < v.itemCount; i++) {
        if (v.itemKind[i] !== kind) continue;
        const x = v.itemX[i]!;
        const y = v.itemY[i]!;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        if (tiny) {
          ctx.rect(x - side / 2, y - side / 2, side, side);
        } else {
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawCreatures(ctx: CanvasRenderingContext2D, cfg: EcoDrawConfig, v: SnapshotViews, x0: number, x1: number, y0: number, y1: number, css: number, cssZoom: number, highlight: number): void {
    if (this.vis.length < v.count) {
      const size = Math.max(v.count, 2 * this.vis.length);
      this.vis = new Int32Array(size);
      this.visBucket = new Int32Array(size);
      this.order = new Int32Array(size);
    }
    const { vis, visBucket, counts } = this;
    counts.fill(0);
    let n = 0;
    for (let i = 0; i < v.count; i++) {
      const x = v.x[i]!;
      const y = v.y[i]!;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const b = highlight >= 0 && v.founder[i] !== highlight ? DIM_BUCKET : creatureBucket(v.hue[i]!, v.age[i]!);
      vis[n] = i;
      visBucket[n++] = b;
      counts[b + 1]!++;
    }
    const R = cfg.radius;
    if (R * cssZoom >= DETAIL_MIN_RADIUS && n <= DETAIL_MAX_COUNT) {
      for (let k = 0; k < n; k++) this.drawDetailed(ctx, cfg, v, vis[k]!, visBucket[k] === DIM_BUCKET ? DIM_STYLE : STYLES[visBucket[k]!]!, css, visBucket[k] === DIM_BUCKET ? DIM_ALPHA : 1);
      return;
    }
    // Flat dots grouped by colour, one path and fill per colour.
    for (let b = 0; b <= DIM_BUCKET; b++) counts[b + 1]! += counts[b]!;
    const order = this.order;
    for (let k = 0; k < n; k++) order[counts[visBucket[k]!]!++] = vis[k]!;
    // counts[b] is now the end of bucket b, which is the start of bucket b + 1.
    // Round dots at least DOT_RADIUS big, over a dark outline pass, so creatures stand out from the small dim items.
    const dotR = Math.max(R, DOT_RADIUS * css);
    const outline = dotR + 0.9 * css;
    const hunter = (i: number): boolean => cfg.species?.[v.species[i]!]?.hunter ?? false;
    // Creatures outside the highlighted lineage come first, faint and without outline, so the lineage is drawn over them.
    const dimAt = counts[DIM_BUCKET - 1]!;
    const dimEnd = counts[DIM_BUCKET]!;
    if (dimEnd > dimAt) {
      ctx.globalAlpha = DIM_ALPHA;
      ctx.fillStyle = DIM_STYLE;
      ctx.beginPath();
      for (let at = dimAt; at < dimEnd; at++) {
        const i = order[at]!;
        bodyPath(ctx, v.x[i]!, v.y[i]!, dotR, v.heading[i]!, hunter(i));
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = DOT_OUTLINE;
    ctx.beginPath();
    for (let k = 0; k < dimAt; k++) {
      const i = order[k]!;
      bodyPath(ctx, v.x[i]!, v.y[i]!, outline, v.heading[i]!, hunter(i));
    }
    ctx.fill();
    let at = 0;
    for (let b = 0; b < BUCKETS; b++) {
      const end = counts[b]!;
      if (end === at) continue;
      ctx.fillStyle = STYLES[b]!;
      ctx.beginPath();
      for (; at < end; at++) {
        const i = order[at]!;
        bodyPath(ctx, v.x[i]!, v.y[i]!, dotR, v.heading[i]!, hunter(i));
      }
      ctx.fill();
    }
  }

  // Dark body, level fill in the creature's colour, ring and heading tick; a hunter has a pointed nose instead of the tick.
  private drawDetailed(ctx: CanvasRenderingContext2D, cfg: EcoDrawConfig, v: SnapshotViews, i: number, style: string, css: number, alpha: number): void {
    const x = v.x[i]!;
    const y = v.y[i]!;
    const R = cfg.radius;
    const sp = cfg.species?.[v.species[i]!];
    const e = Math.min(1, Math.max(0, v.energy[i]! / (sp?.fullEnergy ?? cfg.fullEnergy)));
    ctx.globalAlpha = alpha;
    if (sp?.hunter) {
      this.drawHunter(ctx, x, y, R, v.heading[i]!, e, style, css);
      ctx.globalAlpha = 1;
      return;
    }
    ctx.fillStyle = BODY;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();
    if (e > 0) {
      // The circle segment below a level line, filled from the bottom.
      const half = Math.acos(1 - 2 * e);
      ctx.fillStyle = style;
      ctx.beginPath();
      ctx.arc(x, y, R, Math.PI / 2 - half, Math.PI / 2 + half);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = style;
    ctx.lineWidth = 1.5 * css;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.stroke();
    const cs = Math.cos(v.heading[i]!);
    const sn = Math.sin(v.heading[i]!);
    ctx.lineWidth = 2 * css;
    ctx.beginPath();
    ctx.moveTo(x + cs * R, y + sn * R);
    ctx.lineTo(x + cs * R * 1.6, y + sn * R * 1.6);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // The pointed body filled from the bottom up to the energy level, which reaches the nose tip only when full.
  private drawHunter(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, heading: number, e: number, style: string, css: number): void {
    ctx.beginPath();
    bodyPath(ctx, x, y, R, heading, true);
    ctx.fillStyle = BODY;
    ctx.fill();
    if (e > 0) {
      ctx.save();
      ctx.clip();
      const reach = NOSE * R; // the shape lies within this distance of the centre
      ctx.fillStyle = style;
      ctx.fillRect(x - reach, y + reach - 2 * reach * e, 2 * reach, 2 * reach * e);
      ctx.restore();
    }
    ctx.strokeStyle = style;
    ctx.lineWidth = 1.5 * css;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  private drawSelected(ctx: CanvasRenderingContext2D, cfg: EcoDrawConfig, s: SelectedDetails, showRays: boolean, css: number): void {
    if (showRays) {
      ctx.lineWidth = css;
      const rayLength = s.plan.rayLength;
      for (let i = 0; i < s.rayKinds.length; i++) {
        const kind = s.rayKinds[i]!;
        const d = kind === HIT_NONE ? rayLength : rayLength * (1 - s.rayCloseness[i]!);
        const a = s.heading + s.rayOffsets[i]!;
        ctx.strokeStyle = RAY_COLORS[kind]!;
        ctx.globalAlpha = kind === HIT_NONE ? 0.4 : 0.9;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    const r = Math.max(cfg.radius * 1.4, 7 * css);
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(6, 12, 9, 0.7)"; // dark halo keeps the ring readable on any background
    ctx.lineWidth = 3.6 * css;
    ctx.stroke();
    ctx.strokeStyle = SELECT_RING;
    ctx.lineWidth = 1.6 * css;
    ctx.stroke();
  }
}
