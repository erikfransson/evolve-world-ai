import type { EcoConfig } from "../sim/ecoConfig.ts";
import type { SelectedDetails, SnapshotViews } from "../worker/ecoProtocol.ts";
import type { RenderInMessage, RenderOutMessage } from "../worker/renderProtocol.ts";
import type { Camera } from "./camera.ts";
import { fitCanvas } from "./canvas.ts";
import { BirthRings } from "./ecoBirths.ts";
import { drawIdleWorld } from "./ecoIdle.ts";
import { ImpactEffects } from "./ecoImpacts.ts";
import { pickCreature } from "./ecoPick.ts";
import { applyMap } from "./mapReady.ts";
import type { MapReady } from "./mapReady.ts";
import { EcoRenderer } from "./ecoScene.ts";
import type { EcoDrawConfig } from "./ecoScene.ts";

const RENDER_READY_MS = 5000; // a render worker that has not said ready by then is dropped and the page draws

export interface FrameArgs {
  run: number;
  camera: Camera;
  cfg: EcoDrawConfig;
  views: SnapshotViews | null; // null when a render worker holds the buffer
  selected: SelectedDetails | null;
  showRays: boolean;
  dpr: number;
  highlight: number;
  now: number;
}

export interface RenderHostEvents {
  onPick(id: number, x: number, y: number, run: number): void; // id -1 for a click on nothing
  onDead(message: string): void; // the render worker failed after taking the canvas
}

// Whoever draws the world: the page itself or a render worker that owns the canvas (OffscreenCanvas).
export interface RenderHost {
  backing(): { width: number; height: number }; // size of the backing store
  fit(): number; // matches the backing store to the layout; returns the device pixel ratio
  idle(config: EcoConfig): void; // the empty world before a run
  useMap(map: MapReady): void; // a named map built elsewhere, drawn from the next frame on
  observe(views: SnapshotViews | null, events: Float32Array | undefined, now: number): void; // a new snapshot
  reset(): void; // a new run
  frame(args: FrameArgs): boolean; // false when drawing has stopped for good
  pick(x: number, y: number, reach: number, run: number, views: SnapshotViews | null): void; // answers through onPick
  takePort(): MessagePort | null; // the simulation worker's end of the snapshot channel, once; null when the page draws
}

class PageHost implements RenderHost {
  private readonly renderer = new EcoRenderer();
  private readonly births = new BirthRings();
  private readonly impacts = new ImpactEffects();

  private readonly canvas: HTMLCanvasElement;
  private readonly events: RenderHostEvents;

  constructor(canvas: HTMLCanvasElement, events: RenderHostEvents) {
    this.canvas = canvas;
    this.events = events;
  }

  backing = () => this.canvas;
  fit = () => fitCanvas(this.canvas);

  useMap = applyMap;

  idle(config: EcoConfig): void {
    const dpr = this.fit();
    drawIdleWorld(this.canvas.getContext("2d")!, config, this.canvas.width, this.canvas.height, dpr);
  }

  observe(views: SnapshotViews | null, events: Float32Array | undefined, now: number): void {
    if (!views) return;
    this.births.observe(views, now);
    if (events) this.impacts.add(events, now);
  }

  reset(): void {
    this.births.reset();
    this.impacts.reset();
  }

  frame(a: FrameArgs): boolean {
    this.renderer.draw(this.canvas.getContext("2d")!, a.camera, a.cfg, a.views!, a.selected, a.showRays, a.dpr, a.highlight, this.births, a.now, this.impacts);
    return true;
  }

  pick(x: number, y: number, reach: number, run: number, views: SnapshotViews | null): void {
    const v = views!;
    const i = pickCreature(v.x, v.y, v.count, x, y, reach);
    if (i >= 0) this.events.onPick(v.ids[i]!, v.x[i]!, v.y[i]!, run);
    else this.events.onPick(-1, 0, 0, run);
  }

  takePort = () => null;
}

class WorkerHost implements RenderHost {
  private backW: number;
  private backH: number; // tracked here since the canvas can no longer be resized from the page
  private pickRequests = 0;
  private dead = false;
  private port: MessagePort | null;

  private readonly canvas: HTMLCanvasElement;
  private readonly worker: Worker;

  constructor(canvas: HTMLCanvasElement, worker: Worker, events: RenderHostEvents) {
    this.canvas = canvas;
    this.worker = worker;
    fitCanvas(canvas);
    this.backW = canvas.width;
    this.backH = canvas.height;
    const offscreen = canvas.transferControlToOffscreen();
    const channel = new MessageChannel();
    this.port = channel.port2;
    worker.postMessage({ type: "init", canvas: offscreen, port: channel.port1 } satisfies RenderInMessage, [offscreen, channel.port1]);
    // Any uncaught error stops worker drawing for good, even though the worker might survive it; a page note is safer than a half-drawn world.
    worker.onerror = (e) => {
      this.dead = true;
      this.port = null;
      events.onDead(e.message);
    };
    worker.onmessage = (e: MessageEvent<RenderOutMessage>) => {
      const m = e.data;
      if (m.type === "picked" && m.request === this.pickRequests) events.onPick(m.id, m.x, m.y, m.run);
    };
  }

  backing = () => ({ width: this.backW, height: this.backH });

  fit(): number {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (w !== this.backW || h !== this.backH) {
      this.backW = w;
      this.backH = h;
      this.worker.postMessage({ type: "size", width: w, height: h } satisfies RenderInMessage);
    }
    return dpr;
  }

  idle(config: EcoConfig): void {
    this.worker.postMessage({ type: "idle", config, dpr: this.fit() } satisfies RenderInMessage);
  }

  useMap(map: MapReady): void {
    this.worker.postMessage({ type: "map", map } satisfies RenderInMessage);
  }

  observe = () => {};
  reset = () => {};

  frame(a: FrameArgs): boolean {
    if (this.dead) return false;
    const { cx, cy, zoom, focusX, focusY } = a.camera;
    this.worker.postMessage({ type: "frame", run: a.run, view: { cx, cy, zoom, focusX, focusY }, cfg: a.cfg, selectedId: a.selected?.id ?? null, showRays: a.showRays, dpr: a.dpr, highlight: a.highlight } satisfies RenderInMessage);
    return true;
  }

  pick(x: number, y: number, reach: number, run: number): void {
    if (!this.dead) this.worker.postMessage({ type: "pick", request: ++this.pickRequests, run, x, y, reach } satisfies RenderInMessage);
  }

  takePort(): MessagePort | null {
    const port = this.port;
    this.port = null;
    return port;
  }
}

// A render worker takes the canvas when the browser can draw 2D on an OffscreenCanvas (Chrome, Firefox, Safari 16.4+).
// Otherwise, or with ?offscreen=0, the page draws itself.
function offscreenSupported(canvas: HTMLCanvasElement): boolean {
  if (new URLSearchParams(location.search).get("offscreen") === "0" || typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return false;
  if (typeof canvas.transferControlToOffscreen !== "function") return false;
  try {
    return new OffscreenCanvas(1, 1).getContext("2d") !== null;
  } catch {
    return false;
  }
}

// Resolves true once the worker has loaded and said ready; a load failure or silence falls back to drawing on the page.
function workerReady(w: Worker): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), RENDER_READY_MS);
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      resolve(ok);
    };
    w.onmessage = (e: MessageEvent<RenderOutMessage>) => done(e.data.type === "ready");
    w.onerror = () => done(false);
    w.onmessageerror = () => done(false);
  });
}

// Picks who draws, once per page. The canvas stays untouched until a render worker says ready.
export async function createRenderHost(canvas: HTMLCanvasElement, events: RenderHostEvents): Promise<RenderHost> {
  if (!offscreenSupported(canvas)) return new PageHost(canvas, events);
  let w: Worker;
  try {
    w = new Worker(new URL("../worker/renderWorker.ts", import.meta.url), { type: "module" });
  } catch {
    return new PageHost(canvas, events);
  }
  if (await workerReady(w)) return new WorkerHost(canvas, w, events);
  w.terminate();
  return new PageHost(canvas, events);
}
