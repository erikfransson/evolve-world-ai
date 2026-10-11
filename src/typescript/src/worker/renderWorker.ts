import type { SnapshotViews } from "./ecoProtocol.ts";
import type { RenderInMessage, RenderOutMessage, RenderSnapshot } from "./renderProtocol.ts";
import { snapshotViews } from "./ecoProtocol.ts";
import { Camera } from "../ui/camera.ts";
import { BirthRings } from "../ui/ecoBirths.ts";
import { drawIdleWorld } from "../ui/ecoIdle.ts";
import { ImpactEffects } from "../ui/ecoImpacts.ts";
import { pickCreature } from "../ui/ecoPick.ts";
import { EcoRenderer } from "../ui/ecoScene.ts";

// Draws the ecosystem on an OffscreenCanvas with the page's EcoRenderer, off the page's main thread.
let canvas: OffscreenCanvas;
let ctx: CanvasRenderingContext2D;
let port: MessagePort;
let snap: { msg: RenderSnapshot; views: SnapshotViews } | null = null;
let run = -1;
let frame: Extract<RenderInMessage, { type: "frame" }> | null = null; // newest request, drawn at the next animation frame
let scheduled = false;
let camera: Camera | null = null;
const renderer = new EcoRenderer();
const births = new BirthRings();
const impacts = new ImpactEffects();
const NO_BUFFER = new ArrayBuffer(0);
const out = (m: RenderOutMessage): void => self.postMessage(m);

function giveBack(msg: RenderSnapshot): void {
  port.postMessage({ type: "recycle", buffer: msg.buffer, run: msg.run }, [msg.buffer]);
}

function onSnapshot(msg: RenderSnapshot): void {
  if (msg.run < run) return giveBack(msg);
  if (msg.run > run) {
    run = msg.run;
    births.reset();
    impacts.reset();
  }
  const previous = snap;
  snap = { msg, views: snapshotViews(msg.buffer, msg.count, msg.itemCount, msg.creatureCap, msg.itemCap) };
  if (previous) giveBack(previous.msg);
  const stamp = performance.now();
  births.observe(snap.views, stamp);
  if (msg.events) impacts.add(msg.events, stamp);
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  if (typeof self.requestAnimationFrame === "function") self.requestAnimationFrame(draw);
  else setTimeout(draw, 16);
}

function draw(): void {
  scheduled = false;
  const f = frame;
  frame = null;
  if (!f || !snap || snap.msg.run !== f.run) return;
  if (!camera) camera = new Camera(f.cfg.worldW, f.cfg.worldH, canvas.width, canvas.height);
  if (camera.width !== canvas.width || camera.height !== canvas.height) camera.resize(canvas.width, canvas.height);
  camera.setState(f.view);
  const t0 = performance.now();
  const sel = snap.msg.selected;
  renderer.draw(ctx, camera, f.cfg, snap.views, sel && sel.id === f.selectedId ? sel : null, f.showRays, f.dpr, f.highlight, births, performance.now(), impacts);
  out({ type: "drew", ms: performance.now() - t0 });
}

self.onmessage = async (e: MessageEvent<RenderInMessage>) => {
  const m = e.data;
  switch (m.type) {
    case "init":
      canvas = m.canvas;
      ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
      port = m.port;
      port.onmessage = (p: MessageEvent<RenderSnapshot>) => onSnapshot(p.data);
      break;
    case "size":
      canvas.width = m.width;
      canvas.height = m.height;
      break;
    case "frame":
      frame = m;
      schedule();
      break;
    case "pick": {
      const v = snap?.views;
      const i = v ? pickCreature(v.x, v.y, v.count, m.x, m.y, m.reach) : -1;
      out({ type: "picked", request: m.request, id: i >= 0 ? v!.ids[i]! : -1, x: i >= 0 ? v!.x[i]! : 0, y: i >= 0 ? v!.y[i]! : 0 });
      break;
    }
    case "grab":
      out({ type: "grabbed", png: await canvas.convertToBlob(), buffer: snap!.msg.buffer.slice(0), snapshot: { ...snap!.msg, buffer: NO_BUFFER } });
      break;
    case "idle":
      drawIdleWorld(ctx, m.config, canvas.width, canvas.height, m.dpr);
      break;
  }
};
