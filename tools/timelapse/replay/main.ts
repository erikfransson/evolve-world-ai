// Replay page: draws recorded Live world states with the Live page's own code (EcoRenderer, the map's Terrain, ItemMirror, the clock chip's CSS),
// driven by replay.mjs over loopback. No WebSocket and no other network: views and item sets come from replay.mjs, pixels go back to it.
import "../../../src/typescript/src/base.css";
import "../../../src/typescript/src/style.css";
import "../../../src/typescript/src/ecosystem.css";
import "../../../src/typescript/src/live.css";
import { DEFAULT_ECO_CONFIG, seasonName, winterness } from "../../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../../src/typescript/src/sim/ecoConfig.ts";
import { EcoRenderer } from "../../../src/typescript/src/ui/ecoScene.ts";
import type { EcoDrawConfig } from "../../../src/typescript/src/ui/ecoScene.ts";
import type { GroundBackdrop } from "../../../src/typescript/src/ui/groundBackdrop.ts";
import type { Camera } from "../../../src/typescript/src/ui/camera.ts";
import { BirthRings } from "../../../src/typescript/src/ui/ecoBirths.ts";
import { MapCache } from "../../../src/typescript/src/live/mapTerrain.ts";
import { mapLoader } from "../../../src/typescript/src/live/mapAsset.ts";
import { MAP_FILES } from "../../../src/typescript/src/live/mapFiles.ts";
import { useRockFarm, warmRock } from "../../../src/typescript/src/ui/abyssRock.ts";
import { rockFarm } from "../../../src/typescript/src/ui/rockFarm.ts";
import { drawTerrain, prepareTerrain } from "../../../src/typescript/src/ui/terrainScene.ts";
import { mapSpec, mapVersion } from "../../../src/typescript/src/sim/maps/index.ts";
import { decodeItems } from "../../../src/typescript/src/live/protocol.ts";
import { ItemMirror } from "../../../src/typescript/src/live/items.ts";
import { durationText } from "../../../src/typescript/src/ui/page.ts";
import type { SnapshotViews } from "../../../src/typescript/src/worker/ecoProtocol.ts";
import type { Terrain } from "../../../src/typescript/src/sim/terrain.ts";

const SEASON_COLORS: Record<string, string> = { Summer: "#fbbf24", Autumn: "#fb923c", Winter: "#93c5fd", Spring: "#4ade80" }; // live.ts
const CHIP_INSET_CSS = 14; // timelapse.mjs chipInsetCss: the chip's top-right corner this far inside the world rectangle's
const MIN_VIEWPORT_CSS = 1000; // the page is laid out at least this wide, so the phone and narrow-screen rules (700, 960 px) never restyle the chip

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("view");
const stage = $("stage");
const timer = $("timer");
const engine: EcoConfig = structuredClone(DEFAULT_ECO_CONFIG);
const maps = new MapCache(mapLoader(MAP_FILES));
useRockFarm(rockFarm());
const renderer = new EcoRenderer();
const layered = new EcoRenderer(); // draws over the cached map layer; its own TerrainCache never sees the real map, so it never takes the stand-in for a finished map
const births = new BirthRings();
const mirror = new ItemMirror();
const empty = { x: new Float32Array(0), y: new Float32Array(0), kind: new Uint8Array(0) };

interface Init { map: string; worldW: number; worldH: number; radius: number; itemRadius: number; fullEnergy: number; W: number; H: number; dpr: number }
interface Cam { Z: number; Tx: number; Ty: number; dpr: number }
interface Frame { blob: string; cam: Cam; simSeconds: number; yearMinutes: number; winterFood: number; chip: boolean; wall: boolean; items: boolean; fade: number; nowMs: number; rings: boolean; ground: "cache" | "direct"; winterTint: number; chipFixed: boolean; creatures: "fade" | "live" | "dots" }

let init: Init | null = null;
let draw: EcoDrawConfig | null = null;
let terrain: Terrain | null = null;
let views: SnapshotViews | null = null;
const chipCache = new Map<string, ImageBitmap>(); // chip text and the pixels under it -> the chip as Chrome composites it (blur included)
let pending: { clip: { x: number; y: number; width: number; height: number }; px: { x: number; y: number; w: number; h: number }; key: string } | null = null;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The camera EcoRenderer reads: device px = world * Z + T. A fixed transform, never animating.
function camOf(c: Cam): Camera {
  return { zoom: c.Z, animating: false, apply: (ctx: CanvasRenderingContext2D) => ctx.setTransform(c.Z, 0, 0, c.Z, c.Tx, c.Ty), screenToWorld: (sx: number, sy: number) => ({ x: (sx - c.Tx) / c.Z, y: (sy - c.Ty) / c.Z }) } as unknown as Camera;
}

async function start(a: Init): Promise<{ mapVersion: string; ok: boolean; error?: string }> {
  init = a;
  const spec = mapSpec(a.map);
  if (!spec) return { mapVersion: "", ok: false, error: `this checkout has no map "${a.map}"` };
  if (spec.width !== a.worldW || spec.height !== a.worldH) return { mapVersion: mapVersion(a.map), ok: false, error: `the log's world is ${a.worldW} x ${a.worldH}, the map is ${spec.width} x ${spec.height}` };
  canvas.width = a.W;
  canvas.height = a.H;
  layout(a.W, a.H, a.dpr);
  terrain = await maps.get(a.map, a.worldW, a.worldH);
  if (!terrain) return { mapVersion: mapVersion(a.map), ok: false, error: "map could not be built" };
  warmRock(terrain, a.W / a.worldW);
  draw = { worldW: a.worldW, worldH: a.worldH, radius: a.radius, itemRadius: a.itemRadius, species: [{ fullEnergy: a.fullEnergy, hunter: false }], winter: 0, map: terrain, backdrop: null };
  return { mapVersion: mapVersion(a.map), ok: true };
}

// The canvas shown 1:1 in device px at the top left, so a screenshot of the chip shows exactly the canvas pixels under it.
function layout(W: number, H: number, dpr: number): void {
  const w = W / dpr, h = H / dpr;
  stage.style.cssText = `position:absolute;left:0;top:0;width:${w}px;height:${h}px;flex:none`;
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${w}px;height:${h}px;border:0;border-radius:0;background:none`;
}
export const viewportOf = (W: number, H: number, dpr: number): { width: number; height: number } => ({ width: Math.max(MIN_VIEWPORT_CSS, Math.ceil(W / dpr)), height: Math.ceil(H / dpr) });

// Makes the map's images for this view, a few per idle moment (as live.ts warmMap), so the frame draws the sharp map, never a stand-in.
// The waiting is bounded per frame (60 s) and per run (warmBudgetMs); after that a frame draws what is ready and counts as not sharp.
let warmBudgetMs = 180_000;
async function warm(c: Cam): Promise<void> {
  const a = init!, x0 = -c.Tx / c.Z, y0 = -c.Ty / c.Z, x1 = (a.W - c.Tx) / c.Z, y1 = (a.H - c.Ty) / c.Z, mx = 0.25 * (x1 - x0), my = 0.25 * (y1 - y0), t0 = performance.now();
  for (let i = 0; i < 3000 && warmBudgetMs - (performance.now() - t0) > 0 && !prepareTerrain(terrain!, c.Z, { x0: x0 - mx, x1: x1 + mx, y0: y0 - my, y1: y1 + my }); i++) await sleep(20);
  warmBudgetMs -= performance.now() - t0;
}

// A frame's creatures as replay.mjs packs them: u32 count, then ids, x, y, heading, energy share, hue, age, founder, 4 bytes each.
function viewsOf(buf: ArrayBuffer): SnapshotViews {
  const n = new Uint32Array(buf, 0, 1)[0]!, at = (k: number): number => 4 + 4 * n * k;
  const energy = new Float32Array(buf, at(4), n).map((e) => e * init!.fullEnergy);
  return { count: n, ids: new Int32Array(buf, at(0), n), x: new Float32Array(buf, at(1), n), y: new Float32Array(buf, at(2), n), heading: new Float32Array(buf, at(3), n), energy, hue: new Float32Array(buf, at(5), n), age: new Float32Array(buf, at(6), n), founder: new Int32Array(buf, at(7), n), species: new Int32Array(n), itemCount: 0, itemX: empty.x, itemY: empty.y, itemKind: empty.kind };
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  return r.arrayBuffer();
}

// The item set: an ITEMS wire message (the real decoder and the page's mirror), or none.
async function setItems(url: string | null): Promise<number> {
  if (!url) { mirror.clear(); return 0; }
  mirror.reset(decodeItems(new Uint8Array(await fetchBytes(url)), { width: init!.worldW, height: init!.worldH }));
  return mirror.count;
}

const seasonEco = (yearMinutes: number, winterFood: number): EcoConfig["eco"] => ({ ...engine.eco, seasons: true, yearMinutes, winterFood });

// The map drawn into a see-through layer at the camera's own resolution, laid over the floor and the winter tint each frame (EcoRenderer draws a backdrop there when the map
// is not drawn). A still camera reuses it; a moving one redraws it every frame, so a zoom never shows a stretched bitmap (the page's TerrainCache stretches one up to 2x while
// a visitor zooms and redraws once the zoom settles: the layer is what the page shows once settled). One layer of W x H px (8 MB at 1920x1080, 33 MB at 3840x2160).
// The stand-in map keeps the items' look of a designed map and has nothing to draw itself. ground=direct draws through the page's own path instead (TerrainCache included).
let warmed = "", lastCam: Cam | null = null, layer: { key: string; canvas: HTMLCanvasElement; sharp: boolean } | null = null;
const standIn = { designed: true, empty: true } as unknown as Terrain;
function groundLayer(c: Cam): { key: string; canvas: HTMLCanvasElement; sharp: boolean } {
  const a = init!, key = `${c.Z} ${c.Tx} ${c.Ty}`;
  if (layer?.key === key && layer.sharp) return layer;
  const cv = layer?.canvas ?? document.createElement("canvas");
  if (cv.width !== a.W || cv.height !== a.H) { cv.width = a.W; cv.height = a.H; }
  const g = cv.getContext("2d")!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, a.W, a.H);
  g.setTransform(c.Z, 0, 0, c.Z, c.Tx, c.Ty);
  const sharp = drawTerrain(g, terrain!, c.Z, { x0: -c.Tx / c.Z, x1: (a.W - c.Tx) / c.Z, y0: -c.Ty / c.Z, y1: (a.H - c.Ty) / c.Z });
  g.setTransform(1, 0, 0, 1, 0, 0);
  return (layer = { key, canvas: cv, sharp }); // not sharp: a stand-in drew somewhere (the run's warm-up budget is spent), drawn again next frame
}

// Creatures: the page draws dots (at least 2.4 CSS px) until a creature's radius reaches 3 CSS px with at most 800 in view, then detailed bodies, in one frame.
// creatures=fade (films) keeps the dots at their true size up to that point (by raising the dpr the renderer sees, so it never switches) and cross-fades to the page's bodies
// as the radius goes from 3 to BODY_FADE_END CSS px and the count in view from 800 to 700; live draws as the page does; dots never switches.
const DOT_MIN_CSS = 2.4; // ecoScene.ts DOT_RADIUS
const BODY_FROM = 3, BODY_FADE_END = 5, BODY_MAX_COUNT = 800, COUNT_FADE = 100; // ecoScene.ts DETAIL_MIN_RADIUS and DETAIL_MAX_COUNT
let scratch: HTMLCanvasElement | null = null;
function inView(v: SnapshotViews, c: Cam): number {
  const a = init!, pad = 2 * draw!.radius + (4 * c.dpr) / c.Z, x0 = -c.Tx / c.Z - pad, x1 = (a.W - c.Tx) / c.Z + pad, y0 = -c.Ty / c.Z - pad, y1 = (a.H - c.Ty) / c.Z + pad;
  let n = 0;
  for (let i = 0; i < v.count; i++) { const x = v.x[i]!, y = v.y[i]!; if (x >= x0 && x <= x1 && y >= y0 && y <= y1) n++; }
  return n;
}
function bodyWeight(mode: Frame["creatures"], c: Cam, v: SnapshotViews): number {
  if (mode === "live") return -1;
  if (mode === "dots") return 0;
  const rCss = (draw!.radius * c.Z) / c.dpr;
  if (rCss < BODY_FROM) return 0;
  const n = inView(v, c), uz = Math.min(1, (rCss - BODY_FROM) / (BODY_FADE_END - BODY_FROM)), un = Math.min(1, Math.max(0, (BODY_MAX_COUNT - n) / COUNT_FADE));
  return uz * un;
}

// EcoRenderer stamps dots from its DotAtlas only once their size held for a frame (on the page a still view always does), else fills them as paths,
// whose edges differ slightly. A replay frame may be the first at its size, so the atlas is told the size first (the key as ecoScene drawCreatures makes it).
function primeDots(r: EcoRenderer, c: Cam): void {
  const css = c.dpr / c.Z, dotR = Math.max(draw!.radius, 2.4 * css), outline = dotR + 0.9 * css;
  (r as unknown as { dots: { frame(k: string): void } }).dots.frame(`${Math.round(dotR * c.Z * 4)} ${Math.round(outline * c.Z * 4)}`);
}

// Draws one frame. Returns the chip's clip when Chrome must composite a chip not in the cache (replay.mjs screenshots it and calls chip()).
async function frame(f: Frame): Promise<{ clip: { x: number; y: number; width: number; height: number } | null; sharp: boolean; tm: number[]; skipped: boolean }> {
  const a = init!, d = draw!;
  const tm: number[] = [performance.now()];
  views = viewsOf(await fetchBytes(f.blob));
  if (f.items) { views.itemX = mirror.x; views.itemY = mirror.y; views.itemKind = mirror.kind; views.itemCount = mirror.count; }
  if (`${f.cam.Z} ${f.cam.Tx} ${f.cam.Ty}` !== warmed) await warm(f.cam);
  tm.push(performance.now());
  const seasons = f.yearMinutes > 0;
  d.winter = seasons ? Math.max(0, f.winterTint) * winterness(seasonEco(f.yearMinutes, f.winterFood), f.simSeconds) : 0; // winterTint scales the page's winter tint (1 as Live, 0 off)
  const ck = `${f.cam.Z} ${f.cam.Tx} ${f.cam.Ty}`;
  const L = f.ground === "cache" ? groundLayer(f.cam) : null, drawer = L ? layered : renderer;
  d.map = L ? standIn : terrain!;
  d.backdrop = L ? ({ draw: (g: CanvasRenderingContext2D) => { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(L.canvas, 0, 0); g.restore(); return true; } } as unknown as GroundBackdrop) : null;
  const ctx = canvas.getContext("2d")!;
  if (f.rings) births.observe(views, f.nowMs);
  // A last bound on the creatures' drawn size: a radius over a quarter of the frame's shorter side (a camera or radius far out of the usual) skips them for this frame, counted.
  const rDev = Math.max(d.radius * f.cam.Z, DOT_MIN_CSS * f.cam.dpr), skipped = views.count > 0 && rDev > Math.min(a.W, a.H) / 4;
  if (skipped) views.count = 0;
  const w = bodyWeight(f.creatures, f.cam, views);
  const pass = (g: CanvasRenderingContext2D, dpr: number): void => {
    const c = { ...f.cam, dpr };
    // clean plate: EcoRenderer strokes only the world's border with strokeRect; the dots pass at a raised dpr strokes it at the camera's own width (max(2, 1.5 dpr) device px, ecoScene.ts)
    if (!f.wall) g.strokeRect = () => undefined;
    else if (dpr !== f.cam.dpr) g.strokeRect = function (this: CanvasRenderingContext2D, x: number, y: number, ww: number, hh: number): void { this.lineWidth = Math.max(2, 1.5 * f.cam.dpr) / f.cam.Z; CanvasRenderingContext2D.prototype.strokeRect.call(this, x, y, ww, hh); };
    primeDots(drawer, c);
    try { drawer.draw(g, camOf(c), d, views!, null, false, dpr, -1, f.rings ? births : null, f.nowMs, null); }
    finally { delete (g as { strokeRect?: unknown }).strokeRect; }
  };
  if (w < 0 || w >= 1) pass(ctx, f.cam.dpr); // the page's own choice
  else {
    pass(ctx, Math.max(f.cam.dpr, (d.radius * f.cam.Z) / (BODY_FROM - 1e-3))); // dots at their true size: the renderer never sees a radius of 3 CSS px
    if (w > 0) {
      scratch ??= document.createElement("canvas");
      if (scratch.width !== a.W || scratch.height !== a.H) { scratch.width = a.W; scratch.height = a.H; }
      const g = scratch.getContext("2d")!;
      pass(g, f.cam.dpr);
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = w; ctx.drawImage(scratch, 0, 0); ctx.restore();
    }
  }
  lastCam = f.cam;
  tm.push(performance.now());
  const sharp = (L ? L.sharp : true) && prepareTerrain(terrain!, f.cam.Z, { x0: -f.cam.Tx / f.cam.Z, x1: (a.W - f.cam.Tx) / f.cam.Z, y0: -f.cam.Ty / f.cam.Z, y1: (a.H - f.cam.Ty) / f.cam.Z });
  warmed = sharp ? ck : ""; // a still camera whose map is complete needs no more warming
  pending = null;
  timer.hidden = !f.chip || (!views.count && !skipped); // live.ts hides the clock while no creature is drawn
  if (timer.hidden) return { clip: null, sharp, tm, skipped };
  const name = seasons ? seasonName(seasonEco(f.yearMinutes, f.winterFood), f.simSeconds) : "";
  $("timerText").textContent = durationText(f.simSeconds);
  const pill = $("timerSeason");
  if (pill.textContent !== name) { pill.textContent = name; pill.style.setProperty("--season", SEASON_COLORS[name] ?? "#3ddc97"); }
  if (f.chipFixed) fixChipWidth(); else timerWidth = "";
  placeChip(f.cam);
  const r = timer.getBoundingClientRect(), dpr = a.dpr; // the chip is laid out at the viewport's pixel ratio, fixed for a run, whatever the frame's dpr
  const px = { x: Math.floor(r.left * dpr) - 2, y: Math.floor(r.top * dpr) - 2, w: 0, h: 0 }; // 2 device px around it for the antialiased border
  px.w = Math.min(a.W, Math.ceil(r.right * dpr) + 2) - Math.max(0, px.x); px.h = Math.min(a.H, Math.ceil(r.bottom * dpr) + 2) - Math.max(0, px.y);
  px.x = Math.max(0, px.x); px.y = Math.max(0, px.y);
  if (px.w <= 0 || px.h <= 0) return { clip: null, sharp, tm, skipped };
  const under = ctx.getImageData(px.x, px.y, px.w, px.h).data; // the blur reads only the canvas under the chip's box
  let hsh = 2166136261;
  for (let i = 0; i < under.length; i += 4) hsh = Math.imul(hsh ^ (under[i]! | (under[i + 1]! << 8) | (under[i + 2]! << 16)), 16777619);
  const key = `${timer.textContent}|${pill.textContent}|${px.x},${px.y},${px.w},${px.h}|${hsh >>> 0}|${under.length}`;
  const hit = chipCache.get(key);
  if (hit) { ctx.drawImage(hit, px.x, px.y); return { clip: null, sharp, tm, skipped }; }
  pending = { clip: { x: px.x / dpr, y: px.y / dpr, width: px.w / dpr, height: px.h / dpr }, px, key };
  return { clip: pending.clip, sharp, tm, skipped };
}

// The chip's top-right corner CHIP_INSET_CSS inside the world rectangle's top-right corner, kept inside the frame (as the capture's restyle).
function placeChip(c: Cam): void {
  const a = init!, w = a.W / a.dpr, h = a.H / a.dpr;
  const right = Math.min(w - CHIP_INSET_CSS, (c.Tx + a.worldW * c.Z) / a.dpr - CHIP_INSET_CSS);
  const top = Math.max(CHIP_INSET_CSS, Math.min(h - CHIP_INSET_CSS - 60, c.Ty / a.dpr + CHIP_INSET_CSS));
  timer.style.cssText = `top:${top.toFixed(2)}px;right:${(w - right).toFixed(2)}px;left:auto${timerWidth}`;
}
// chipFixed: the chip as wide as its widest text (a two-digit day count and the widest season), text right-aligned, so its left edge holds still when the text changes.
let timerWidth = "";
function fixChipWidth(): void {
  if (timerWidth) return;
  const text = $("timerText"), pill = $("timerSeason"), keep = [text.textContent, pill.textContent, pill.style.getPropertyValue("--season")];
  timer.style.cssText = "top:0;right:0;left:auto"; timer.hidden = false;
  let wMax = 0;
  for (const name of Object.keys(SEASON_COLORS)) { text.textContent = "88d 88h 88m"; pill.textContent = name; wMax = Math.max(wMax, timer.getBoundingClientRect().width); }
  [text.textContent, pill.textContent] = [keep[0]!, keep[1]!]; pill.style.setProperty("--season", keep[2]!);
  timerWidth = `;min-width:${Math.ceil(wMax)}px;justify-content:flex-end;box-sizing:border-box`;
}

// The chip as Chrome composited it (a PNG screenshot of its clip), drawn into the canvas and kept for frames with the same text over the same pixels.
async function chip(png: string): Promise<void> {
  if (!pending) return;
  const bytes = Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  if (chipCache.size > 64) { for (const b of chipCache.values()) b.close(); chipCache.clear(); }
  chipCache.set(pending.key, bmp);
  canvas.getContext("2d")!.drawImage(bmp, pending.px.x, pending.px.y, pending.px.w, pending.px.h);
  pending = null;
}

// Fades the world's rectangle to black (0 none, 1 black; the margins keep their colour), reads the canvas back and posts its bytes to replay.mjs.
async function finish(fade: number, out: string, yuv: boolean): Promise<{ read: number; post: number }> {
  const ctx = canvas.getContext("2d")!;
  if (fade > 0 && lastCam) { const c = lastCam; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = Math.min(1, fade); ctx.fillStyle = "#000"; ctx.fillRect(c.Tx, c.Ty, init!.worldW * c.Z, init!.worldH * c.Z); ctx.globalAlpha = 1; }
  timer.hidden = true;
  const t0 = performance.now(), img = ctx.getImageData(0, 0, canvas.width, canvas.height), t1 = performance.now();
  const ws = await socket(out);
  const ack = new Promise<void>((res, rej) => { ws.onmessage = (e) => (e.data === "ok" ? res() : rej(new Error(String(e.data)))); ws.onclose = () => rej(new Error("pixel socket closed")); });
  ws.send(yuv ? toYuv420(img.data, canvas.width, canvas.height) : img.data); // a WebSocket message: a fetch upload of the same bytes takes over 100 times longer
  await ack;
  return { read: t1 - t0, post: performance.now() - t1 };
}
// RGBA to planar YUV 4:2:0, BT.709 limited range, chroma from the mean of each 2x2 block (centre sited): 3/8 of the bytes to send, which is what limits the frame rate.
const Y_R = new Int32Array(256), Y_G = new Int32Array(256), Y_B = new Int32Array(256), FIX = 1 << 16;
for (let v = 0; v < 256; v++) { Y_R[v] = Math.round(((219 * 0.2126) / 255) * v * FIX); Y_G[v] = Math.round(((219 * 0.7152) / 255) * v * FIX); Y_B[v] = Math.round(((219 * 0.0722) / 255) * v * FIX); }
let yuvBuf: Uint8Array<ArrayBuffer> = new Uint8Array(0);
export function toYuv420(px: Uint8ClampedArray, W: number, H: number): Uint8Array<ArrayBuffer> {
  const n = W * H, cw = W >> 1;
  if (yuvBuf.length !== n + (n >> 1)) yuvBuf = new Uint8Array(n + (n >> 1));
  const out = yuvBuf, U = n, V = n + (n >> 2), half = FIX >> 1, Y0 = 16 * FIX + half;
  const cb = 224 / (1.8556 * 255 * 4), cr = 224 / (1.5748 * 255 * 4);
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const a = 4 * (y * W + x), b = a + 4 * W;
      const r0 = px[a]!, g0 = px[a + 1]!, b0 = px[a + 2]!, r1 = px[a + 4]!, g1 = px[a + 5]!, b1 = px[a + 6]!;
      const r2 = px[b]!, g2 = px[b + 1]!, b2 = px[b + 2]!, r3 = px[b + 4]!, g3 = px[b + 5]!, b3 = px[b + 6]!;
      const o = y * W + x;
      out[o] = (Y0 + Y_R[r0]! + Y_G[g0]! + Y_B[b0]!) >> 16; out[o + 1] = (Y0 + Y_R[r1]! + Y_G[g1]! + Y_B[b1]!) >> 16;
      out[o + W] = (Y0 + Y_R[r2]! + Y_G[g2]! + Y_B[b2]!) >> 16; out[o + W + 1] = (Y0 + Y_R[r3]! + Y_G[g3]! + Y_B[b3]!) >> 16;
      const R = r0 + r1 + r2 + r3, G = g0 + g1 + g2 + g3, B = b0 + b1 + b2 + b3, L = 0.2126 * R + 0.7152 * G + 0.0722 * B, c = (y >> 1) * cw + (x >> 1);
      out[U + c] = Math.min(240, Math.max(16, Math.round(128 + (B - L) * cb))); out[V + c] = Math.min(240, Math.max(16, Math.round(128 + (R - L) * cr)));
    }
  }
  return out;
}
let px: WebSocket | null = null;
async function socket(url: string): Promise<WebSocket> {
  if (px?.readyState === WebSocket.OPEN) return px;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("pixel socket failed")); });
  return (px = ws);
}

Object.assign(window, { replay: { start, setItems, frame, chip, finish, viewportOf, ready: true } });
