import type { SelectedDetails, SnapshotViews } from "../worker/ecoProtocol.ts";
import { HIT_NONE } from "../sim/types.ts";
import type { Camera } from "./camera.ts";
import { HUNTER_REACH, hunterPath } from "./speciesStyle.ts";
import type { BirthRings } from "./ecoBirths.ts";
import type { ImpactEffects } from "./ecoImpacts.ts";
import { readyTerrainOf } from "../sim/terrain.ts";
import type { Terrain } from "../sim/terrain.ts";
import type { TerrainSettings } from "../sim/terrain.ts";
import { BACKGROUND, FLOOR, FOOD, POISON, RAY_COLORS, WALL } from "./scene.ts";
import { context2d, makeCanvas } from "./groundScene.ts";
import { TerrainCache } from "./terrainCache.ts";
import { drawTerrain } from "./terrainScene.ts";

export interface EcoDrawConfig {
  worldW: number;
  worldH: number;
  radius: number;
  itemRadius: number;
  species: readonly { fullEnergy: number; hunter: boolean }[]; // per species: energy at which the body fill is full, and hunters drawn with a pointed nose
  winter?: number; // 0 (summer) to 1 (mid-winter): how far the floor is tinted cold
  terrain?: TerrainSettings; // the map to draw (rock and slow and fast ground); none without
  map?: Terrain; // or the map already built (the Live page builds it on a worker), used instead of terrain
}

// Adds a creature's outline to the current path: a circle, or a hunter's teardrop.
function bodyPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, heading: number, hunter: boolean): void {
  if (hunter) return hunterPath(ctx, x, y, r, heading);
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
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
const ATLAS_PX = 1024; // side of the dot atlas (4 MB): room for over 500 colours and sizes of 4 x 4 dots each

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
  private seen = new Int32Array(1024); // snapshot indices of the visible items
  private readonly counts = new Int32Array(DIM_BUCKET + 2);
  private readonly terrainCache = new TerrainCache();
  private readonly dots = new Map<string, { x: number; y: number; size: number }>(); // atlas blocks of dots per radius and colour, stamped per creature
  private atlas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private atlasCtx: CanvasRenderingContext2D | null = null;
  private readonly shelf = { x: 0, y: 0, h: 0 }; // where the next block goes: rows of blocks, left to right

  // Where the dots of this colour and device px radius sit in the atlas: a block of 4 x 4 cells of `size` px, the cell at (fx, fy) holding
  // the dot with its centre fx, fy quarter pixels past the cell's middle, so a stamp on whole pixels lands it where the path would have,
  // with the same edge. One atlas, so the GPU draws all stamps from one texture. Null where no canvas can be made.
  private dot(style: string, r: number): { x: number; y: number; size: number } | null {
    const key = `${r} ${style}`;
    let at = this.dots.get(key);
    if (at !== undefined) return at;
    const size = 2 * Math.ceil(r + 1);
    const block = 4 * size;
    if (block > ATLAS_PX) return null;
    if (!this.atlas) {
      this.atlas = makeCanvas(ATLAS_PX, ATLAS_PX);
      this.atlasCtx = context2d(this.atlas);
    }
    const g = this.atlasCtx;
    if (!g) return null;
    const a = this.shelf;
    if (a.x + block > ATLAS_PX) Object.assign(a, { x: 0, y: a.y + a.h, h: 0 });
    if (a.y + block > ATLAS_PX) { // full: start over, the dots in use come back on the next frames
      g.clearRect(0, 0, ATLAS_PX, ATLAS_PX);
      this.dots.clear();
      Object.assign(a, { x: 0, y: 0, h: 0 });
    }
    at = { x: a.x, y: a.y, size };
    a.x += block;
    a.h = Math.max(a.h, block);
    g.fillStyle = style;
    for (let fy = 0; fy < 4; fy++) {
      for (let fx = 0; fx < 4; fx++) {
        g.beginPath();
        g.arc(at.x + fx * size + size / 2 + fx / 4, at.y + fy * size + size / 2 + fy / 4, r, 0, Math.PI * 2);
        g.fill();
      }
    }
    this.dots.set(key, at);
    return at;
  }

  // One pass of round dots in one colour, stamped from bitmaps on whole device pixels: a path of a thousand circles costs the GPU tens of
  // ms a frame, the stamps a few. Hunters keep their pointed path. False when no bitmap could be made or the view is rotated, and then
  // the caller draws the path.
  private stampDots(ctx: CanvasRenderingContext2D, v: SnapshotViews, order: Int32Array, from: number, to: number, style: string, r: number, z: number, hunter: (i: number) => boolean): boolean {
    const rd = Math.round(r * z * 4) / 4; // device px
    const blk = this.dot(style, rd);
    if (!blk) return false;
    const m = ctx.getTransform();
    if (m.b !== 0 || m.c !== 0) return false;
    const atlas = this.atlas as CanvasImageSource;
    const size = blk.size;
    const half = size / 2;
    let hunters = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let at = from; at < to; at++) {
      const i = order[at]!;
      if (hunter(i)) {
        hunters = true;
        continue;
      }
      const qx = Math.round((m.a * v.x[i]! + m.e) * 4); // the centre in quarter device px
      const qy = Math.round((m.d * v.y[i]! + m.f) * 4);
      const ix = qx >> 2;
      const iy = qy >> 2;
      ctx.drawImage(atlas, blk.x + (qx & 3) * size, blk.y + (qy & 3) * size, size, size, ix - half, iy - half, size, size);
    }
    ctx.setTransform(m);
    if (hunters) {
      ctx.fillStyle = style;
      ctx.beginPath();
      for (let at = from; at < to; at++) if (hunter(order[at]!)) bodyPath(ctx, v.x[order[at]!]!, v.y[order[at]!]!, r, v.heading[order[at]!]!, true);
      ctx.fill();
    }
    return true;
  }

  // highlight: a founder id whose descendants stay bright while everyone else is dimmed, or -1 for none.
  draw(ctx: CanvasRenderingContext2D, cam: Camera, cfg: EcoDrawConfig, v: SnapshotViews, selected: SelectedDetails | null, showRays: boolean, dpr: number, highlight = -1, births: BirthRings | null = null, now = 0, impacts: ImpactEffects | null = null): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.lineCap = "butt"; // impacts and hunters set round ends and joins, which would otherwise carry over to the next frame
    ctx.lineJoin = "miter";
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
    const terrain = cfg.map ?? (cfg.terrain ? readyTerrainOf(cfg.terrain) : null); // none while a named map is on its way
    const view = { x0: tl.x, x1: br.x, y0: tl.y, y1: br.y };
    if (terrain && !this.terrainCache.draw(ctx, terrain, z, view, cam.animating)) drawTerrain(ctx, terrain, z, view);
    ctx.strokeStyle = WALL;
    ctx.lineWidth = Math.max(2, 1.5 * dpr) * dev;
    ctx.strokeRect(0, 0, cfg.worldW, cfg.worldH);

    this.drawItems(ctx, cfg, v, x0, x1, y0, y1, dev, z);
    this.drawCreatures(ctx, cfg, v, x0, x1, y0, y1, css, z, dpr, highlight);
    births?.draw(ctx, now, cfg.radius, css, z / dpr);
    impacts?.draw(ctx, now, cfg.radius, css, z / dpr);
    if (selected?.alive) this.drawSelected(ctx, cfg, selected, showRays, css);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawItems(ctx: CanvasRenderingContext2D, cfg: EcoDrawConfig, v: SnapshotViews, x0: number, x1: number, y0: number, y1: number, dev: number, z: number): void {
    const r = cfg.itemRadius;
    const px = r * z; // device px radius
    const tiny = px < TINY_ITEM;
    const dense = (cfg.map ?? (cfg.terrain ? readyTerrainOf(cfg.terrain) : null))?.designed === true; // a map with tens of thousands of items: food dots stay light from afar
    const side = 2 * TINY_ITEM * dev * (dense ? 0.4 : 0.55); // about 1.6 device px
    // Dim while small, opaque once large, so mid zoom blends into the full-size items.
    const solid = Math.min(1, Math.max(0, (px - TINY_ITEM) / (SOLID_ITEM - TINY_ITEM)));
    // One pass over all items collects the visible ones per kind, in snapshot order: food from the front of the scratch array, poison from the back.
    const n = v.itemCount;
    if (this.seen.length < n) this.seen = new Int32Array(Math.max(n, 2 * this.seen.length));
    const seen = this.seen;
    const cap = seen.length;
    let nFood = 0;
    let nPoison = 0;
    for (let i = 0; i < n; i++) {
      const kind = v.itemKind[i]!;
      if (kind !== 1 && kind !== 2) continue;
      const x = v.itemX[i]!;
      const y = v.itemY[i]!;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (kind === 1) seen[nFood++] = i;
      else seen[cap - 1 - nPoison++] = i;
    }
    for (const [kind, color, boost] of [[1, FOOD, 0], [2, POISON, 0.15]] as const) {
      ctx.fillStyle = color;
      ctx.globalAlpha = Math.min(1, ITEM_DIM + boost + (1 - ITEM_DIM - boost) * solid) * (dense && kind === 1 ? 0.5 + 0.5 * solid : 1);
      ctx.beginPath();
      const count = kind === 1 ? nFood : nPoison;
      for (let k = 0; k < count; k++) {
        const i = kind === 1 ? seen[k]! : seen[cap - 1 - k]!;
        const x = v.itemX[i]!;
        const y = v.itemY[i]!;
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

  private drawCreatures(ctx: CanvasRenderingContext2D, cfg: EcoDrawConfig, v: SnapshotViews, x0: number, x1: number, y0: number, y1: number, css: number, z: number, dpr: number, highlight: number): void {
    const cssZoom = z / dpr;
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
    const hunter = (i: number): boolean => cfg.species[v.species[i]!]!.hunter;
    // Creatures outside the highlighted lineage come first, faint and without outline, so the lineage is drawn over them.
    const dimAt = counts[DIM_BUCKET - 1]!;
    const dimEnd = counts[DIM_BUCKET]!;
    // One pass in one colour: stamped where it can be, else one path and fill.
    const pass = (from: number, to: number, style: string, r: number): void => {
      if (to <= from || this.stampDots(ctx, v, order, from, to, style, r, z, hunter)) return;
      ctx.fillStyle = style;
      ctx.beginPath();
      for (let at = from; at < to; at++) {
        const i = order[at]!;
        bodyPath(ctx, v.x[i]!, v.y[i]!, r, v.heading[i]!, hunter(i));
      }
      ctx.fill();
    };
    if (dimEnd > dimAt) {
      ctx.globalAlpha = DIM_ALPHA;
      pass(dimAt, dimEnd, DIM_STYLE, dotR);
      ctx.globalAlpha = 1;
    }
    pass(0, dimAt, DOT_OUTLINE, outline);
    let at = 0;
    for (let b = 0; b < BUCKETS; b++) {
      const end = counts[b]!;
      pass(at, end, STYLES[b]!, dotR);
      at = end;
    }
  }

  // Dark body, level fill in the creature's colour, ring and heading tick; a hunter has a pointed nose instead of the tick.
  private drawDetailed(ctx: CanvasRenderingContext2D, cfg: EcoDrawConfig, v: SnapshotViews, i: number, style: string, css: number, alpha: number): void {
    const x = v.x[i]!;
    const y = v.y[i]!;
    const R = cfg.radius;
    const sp = cfg.species[v.species[i]!]!;
    const e = Math.min(1, Math.max(0, v.energy[i]! / sp.fullEnergy));
    ctx.globalAlpha = alpha;
    if (sp.hunter) {
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
      const reach = HUNTER_REACH * R; // the shape lies within this distance of the centre
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
        ctx.globalAlpha = kind === HIT_NONE ? 0.6 : 0.9;
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
