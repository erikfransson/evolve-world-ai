import "./base.css";
import "./style.css";
import "./ecosystem.css";
import { DEFAULT_ECO_CONFIG, seasonFactor, seasonName, winterness } from "./sim/ecoConfig.ts";
import { withEcoPreset } from "./sim/presets.ts";
import type { EcoConfig } from "./sim/ecoConfig.ts";
import type { BestBy, EcoInMessage, EcoOutMessage, EcoSnapshot, SelectedDetails, SnapshotViews } from "./worker/ecoProtocol.ts";
import { snapshotViews } from "./worker/ecoProtocol.ts";
import { Camera } from "./ui/camera.ts";
import type { Point } from "./ui/camera.ts";
import { fitCanvas } from "./ui/canvas.ts";
import { pickCreature } from "./ui/ecoPick.ts";
import { drawIdleWorld } from "./ui/ecoIdle.ts";
import { buildSelectedBrain } from "./ui/ecoBrain.ts";
import type { SelectedBrain } from "./ui/ecoBrain.ts";
import { createEcoView } from "./ui/ecoPage.ts";
import { BirthRings } from "./ui/ecoBirths.ts";
import { EcoRenderer } from "./ui/ecoScene.ts";
import type { EcoDrawConfig } from "./ui/ecoScene.ts";
import type { PopulationSample } from "./ui/populationGraph.ts";

const SELECT_RAY_LENGTHS = 3; // ray lengths across the shorter free side after a click
const MAX_CREATURE_PX = 60; // CSS px radius of a creature at the closest zoom
const PICK_RADII = 3; // click reach in creature radii
const PICK_MIN_PX = 14; // click reach never below this many CSS px
const UI_INTERVAL_MS = 100; // stat tiles and selected card
const BRAIN_INTERVAL_MS = 25;
const ZOOM_STEP = 1.6;
// public/pool.json sits at the site root, one level above this page; resolved here since the worker's own URL differs in dev and build.
const POOL_URL = new URL("../pool.json", document.baseURI).href;
// Overrides for testing: ?threads=N helper threads (0 runs on one thread), ?shared=0 keeps helpers on messages.
const params = new URLSearchParams(location.search);
const THREADS = params.has("threads") ? Math.max(0, Math.floor(Number(params.get("threads"))) || 0) : undefined;
const SHARED = params.get("shared") !== "0";

interface Live {
  msg: EcoSnapshot;
  views: SnapshotViews;
}

// The followed creature: the latest details, the last ones while alive (for the card), and a brain rebuilt from its genome.
interface Selection {
  id: number;
  details: SelectedDetails | null;
  last: SelectedDetails | null;
  brain: SelectedBrain | null;
  died: boolean;
}

const NORMAL = withEcoPreset(DEFAULT_ECO_CONFIG, "normal"); // the page opens on the Normal preset
let config: EcoConfig = NORMAL; // the form's while idle, the run's while active
let active = false; // a run exists (running, paused or extinct)
let run = 0; // run number, so snapshots of an earlier run are dropped
let worker: Worker | null = null;
let live: Live | null = null;
let selection: Selection | null = null;
let following = false; // the Follow toggle as the page shows it
let pendingFollow = false; // follow once the zoom-in animation has ended
let bestRequests = 0; // selectBest requests sent
let pendingBest = 0; // the selectBest request whose answer starts the next selection, 0 for none
let followAfter = 0; // camera.animationsCompleted that means the zoom-in finished
let showRays = true;
let highlight = -1; // founder whose lineage is highlighted in the world, -1 for none
let extinctShown = false;
let canvasW = 0;
let canvasH = 0;
let lastUiAt = 0;
let lastBrainAt = 0;

const camera = new Camera(config.world.width, config.world.height, 1, 1);
const renderer = new EcoRenderer();
const births = new BirthRings();

function drawIdle(): void {
  if (active) return;
  const dpr = fitCanvas(view.canvas);
  drawIdleWorld(view.canvas.getContext("2d")!, config, view.canvas.width, view.canvas.height, dpr);
}

function send(msg: EcoInMessage, transfer: Transferable[] = []): void {
  worker?.postMessage(msg, { transfer });
}

function drawConfig(): EcoDrawConfig {
  const { world, creature, eco } = config;
  const winter = eco.seasons && live ? winterness(eco, live.msg.simTime) : 0;
  return { worldW: world.width, worldH: world.height, radius: creature.radius, itemRadius: world.itemRadius, fullEnergy: eco.birthEnergy, winter };
}

// Matches the canvas and camera to the layout; returns the device pixel ratio.
function syncCanvas(): number {
  const dpr = fitCanvas(view.canvas);
  if (view.canvas.width !== canvasW || view.canvas.height !== canvasH) {
    canvasW = view.canvas.width;
    canvasH = view.canvas.height;
    camera.resize(canvasW, canvasH);
  }
  camera.maxZoom = (MAX_CREATURE_PX * dpr) / config.creature.radius;
  return dpr;
}

// Shifts the view centre into the part of the canvas the overlay cards leave free. Phones have the cards below the canvas.
function overlayShift(): number {
  const stack = document.querySelector<HTMLElement>(".ov-stack");
  if (!stack || getComputedStyle(stack).position !== "absolute") return 0;
  const c = view.canvas.getBoundingClientRect();
  const r = stack.getBoundingClientRect();
  const free = c.right - r.right;
  if (free < 0.4 * c.width) return 0; // too narrow to be worth it
  return ((r.right - c.left) / 2) * (view.canvas.width / c.width);
}

function releaseLive(): void {
  if (live) send({ type: "recycle", buffer: live.msg.buffer, run: live.msg.run }, [live.msg.buffer]);
  live = null;
}

function clearSelection(): void {
  selection = null;
  pendingBest = 0;
  pendingFollow = false;
  following = false;
  camera.follow(null);
  camera.setFocusOffset(0, 0);
  send({ type: "select", id: null });
  view.setSelected(null);
}

function onSnapshot(e: MessageEvent<EcoOutMessage>): void {
  const msg = e.data;
  if (msg.type === "error") {
    active = false;
    view.setPhase("idle");
    view.setNote(`Run stopped: ${msg.message}`);
    return;
  }
  if (!active || msg.run !== run) {
    send({ type: "recycle", buffer: msg.buffer, run: msg.run }, [msg.buffer]);
    return;
  }
  const previous = live;
  live = { msg, views: snapshotViews(msg.buffer, msg.count, msg.itemCount, msg.creatureCap, msg.itemCap) };
  if (previous) send({ type: "recycle", buffer: previous.msg.buffer, run: previous.msg.run }, [previous.msg.buffer]);
  births.observe(live.views, performance.now());
  if (msg.history) view.setHistory(toSamples(msg.history));
  if (msg.lineageHistory) view.setLineageHistory(msg.lineageHistory);
  if (msg.lineages) view.setLineages(msg.lineages, msg.population);
  const d = msg.selected;
  if (pendingBest && msg.bestRequest === pendingBest) {
    pendingBest = 0;
    if (d?.alive && d.genome) beginSelection(d.id, d.x, d.y, d.plan.rayLength);
  }
  if (selection && d && d.id === selection.id) {
    if (d.genome) selection.brain = buildSelectedBrain(config, d);
    selection.details = d;
    selection.died = !d.alive;
    if (d.alive) selection.last = d;
  }
  if (msg.extinct && !extinctShown) {
    extinctShown = true;
    view.showExtinct(msg.simTime);
  }
}

function toSamples(h: Float64Array): PopulationSample[] {
  const out: PopulationSample[] = [];
  for (let i = 0; i + 2 < h.length; i += 3) out.push({ time: h[i]!, population: h[i + 1]!, food: h[i + 2]! });
  return out;
}

function startRun(c: EcoConfig): void {
  config = c;
  active = true;
  run++;
  extinctShown = false;
  worker ??= createWorker();
  releaseLive();
  births.reset();
  clearSelection();
  syncCanvas();
  camera.setWorld(c.world.width, c.world.height);
  view.setHistory([]);
  view.setSeasons(c.eco);
  view.clearLineages();
  highlight = -1;
  view.setStats(null);
  view.setNote(null);
  send({ type: "start", config: c, run, poolUrl: POOL_URL, threads: THREADS, shared: SHARED });
  send({ type: "speed", speed: view.speed() });
}

function createWorker(): Worker {
  const w = new Worker(new URL("./worker/ecoWorker.ts", import.meta.url), { type: "module" });
  w.onmessage = onSnapshot;
  w.onerror = (e) => {
    active = false;
    view.setPhase("idle");
    view.setNote(`Run stopped: ${e.message}`);
  };
  return w;
}

function startFollow(): void {
  pendingFollow = false;
  following = true;
  camera.follow((): Point | null => (selection?.details?.alive ? selection.details : null));
  view.setFollowing(true);
}

// Zooms in on a clicked creature, then follows it.
function select(index: number): void {
  const v = live!.views;
  clearSelection();
  send({ type: "select", id: v.ids[index]! });
  beginSelection(v.ids[index]!, v.x[index]!, v.y[index]!, config.creature.rayLength);
}

// Asks the worker for the best creature; the zoom-in starts when it answers.
function selectBest(by: BestBy): void {
  if (!live) return;
  clearSelection();
  pendingBest = ++bestRequests;
  send({ type: "selectBest", by, request: pendingBest });
}

function beginSelection(id: number, x: number, y: number, rayLength: number): void {
  selection = { id, details: null, last: null, brain: null, died: false };
  const shift = overlayShift();
  const zoom = Math.min(canvasW - 2 * shift, canvasH) / (SELECT_RAY_LENGTHS * rayLength);
  camera.cancel();
  camera.setFocusOffset(shift, 0);
  camera.animateTo(x, y, zoom);
  pendingFollow = true;
  followAfter = camera.animationsCompleted + 1;
  following = true;
  view.setFollowing(true);
}

camera.onClick = (wx, wy) => {
  if (!live) return;
  const dpr = window.devicePixelRatio || 1;
  const reach = Math.max(PICK_RADII * config.creature.radius, (PICK_MIN_PX * dpr) / camera.zoom);
  const index = pickCreature(live.views.x, live.views.y, live.views.count, wx, wy, reach);
  if (index >= 0) select(index);
  else if (selection) clearSelection();
};

// Starts following once the zoom-in has ended, and notices when following stopped: the user dragged, or the creature died.
function syncFollow(): void {
  if (pendingFollow) {
    if (camera.animating) return;
    const arrived = camera.animationsCompleted >= followAfter; // else the user took over
    if (arrived && !selection?.details) return; // the first details have not arrived yet
    if (arrived && selection?.details?.alive) startFollow();
    else {
      pendingFollow = false;
      following = false;
      view.setFollowing(false);
    }
  } else if (following && !camera.following) {
    following = false;
    view.setFollowing(false);
  }
}

function updateUi(): void {
  if (!live) return;
  const m = live.msg;
  view.setStats({ population: m.population, births: m.births, deaths: m.deaths, food: m.food, poison: m.poison, simTime: m.simTime, oldestDepth: m.oldestDepth, speed: m.speed > 0 ? m.speed : null, helpers: m.helpers, sharedMemory: m.sharedMemory, wasm: m.wasm, season: config.eco.seasons ? { name: seasonName(config.eco, m.simTime), factor: seasonFactor(config.eco, m.simTime) } : null });
  const d = selection?.last;
  if (selection && d) {
    view.setSelected({ id: d.id, energy: d.energy, fullEnergy: config.eco.birthEnergy, age: d.age, children: d.children, eaten: d.eaten, depth: d.depth, plan: d.plan, upkeep: d.upkeep, founderId: d.founderId, founderPool: d.founderPool, founderHue: d.founderHue, died: selection.died });
    view.setFollowing(following);
  }
}

function drawBrain(now: number): void {
  const s = selection;
  if (!s?.brain || !s.last || !view.brainPanel.isExpanded() || now - lastBrainAt < BRAIN_INTERVAL_MS) return;
  lastBrainAt = now;
  s.brain.brain.forward(s.last.inputs, s.brain.out);
  view.brain.draw(s.brain.brain, !s.died, s.brain.layout);
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (!live || !active) return;
  const dpr = syncCanvas();
  camera.update(now);
  syncFollow();
  const ctx = view.canvas.getContext("2d")!;
  renderer.draw(ctx, camera, drawConfig(), live.views, selection?.details ?? null, showRays, dpr, highlight, births, now);
  if (now - lastUiAt >= UI_INTERVAL_MS) {
    lastUiAt = now;
    updateUi();
  }
  drawBrain(now);
}

const view = createEcoView({
  onStart: startRun,
  onPause: () => send({ type: "pause" }),
  onResume: () => send({ type: "resume" }),
  onReset() {
    active = false;
    send({ type: "reset" });
    releaseLive();
    clearSelection();
    view.setStats(null);
    view.setHistory([]);
    view.clearLineages();
    highlight = -1;
    view.setNote(null);
    config = view.readConfig();
    camera.setWorld(config.world.width, config.world.height);
    drawIdle();
  },
  onReseed() {
    const next = { ...config, seed: Math.floor(Math.random() * 1_000_000) };
    view.fillConfig(next);
    startRun(next);
  },
  onSpeed: (speed) => send({ type: "speed", speed }),
  onZoom(action) {
    if (action === "fit") {
      pendingFollow = false;
      camera.cancel();
      camera.animateToFit();
      return;
    }
    pendingFollow = false; // a zoom press during the zoom-in to a selection is the user taking over
    const g = camera.goal;
    camera.animateTo(g.cx, g.cy, action === "in" ? g.zoom * ZOOM_STEP : g.zoom / ZOOM_STEP);
  },
  onPickBest: selectBest,
  onFollow(on) {
    if (on && selection?.details?.alive) startFollow();
    else {
      pendingFollow = false;
      following = false;
      camera.follow(null);
      view.setFollowing(false);
    }
  },
  onWorldView() {
    pendingFollow = false;
    following = false;
    camera.cancel();
    camera.animateToFit();
  },
  onShowRays: (show) => { showRays = show; },
  onHighlight: (founder) => { highlight = founder ?? -1; },
  onConfigChange(c) {
    config = c;
    drawIdle();
  },
});

camera.attach(view.canvas);
showRays = view.showRays();
view.fillConfig(NORMAL);
new ResizeObserver(drawIdle).observe(view.canvas);
drawIdle();
requestAnimationFrame(frame);
