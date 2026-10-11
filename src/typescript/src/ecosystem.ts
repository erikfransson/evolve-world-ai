import "./base.css";
import "./style.css";
import "./ecosystem.css";
import { seasonFactor, seasonName, winterness } from "./sim/ecoConfig.ts";
import { fullEnergy, speciesList } from "./sim/species.ts";
import type { EcoConfig } from "./sim/ecoConfig.ts";
import type { Board } from "./sim/leaderboard.ts";
import type { EcoInMessage, EcoOutMessage, EcoSnapshot, SelectedDetails, SnapshotViews } from "./worker/ecoProtocol.ts";
import { snapshotViews } from "./worker/ecoProtocol.ts";
import { Camera } from "./ui/camera.ts";
import type { Point } from "./ui/camera.ts";
import { buildSelectedBrain } from "./ui/ecoBrain.ts";
import type { SelectedBrain } from "./ui/ecoBrain.ts";
import { createEcoView } from "./ui/ecoPage.ts";
import { ECOSYSTEM_PAGE, PREDATORS_PAGE, openingConfig } from "./ui/ecoModes.ts";
import { createRenderHost } from "./ui/renderHost.ts";
import type { RenderHost } from "./ui/renderHost.ts";
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
// Overrides for testing: ?threads=N helper threads (0 runs on one thread).
const params = new URLSearchParams(location.search);
const THREADS = params.has("threads") ? Math.max(0, Math.floor(Number(params.get("threads"))) || 0) : undefined;

interface Live {
  msg: EcoSnapshot;
  views: SnapshotViews | null; // null when a render worker holds the buffer
}

// The followed creature: the latest details, the last ones while alive (for the card), and a brain rebuilt from its genome.
interface Selection {
  id: number;
  details: SelectedDetails | null;
  last: SelectedDetails | null;
  brain: SelectedBrain | null;
  died: boolean;
}

// This script runs the Ecosystem page and, with <body data-mode="predators">, the Great Hunt page.
const PAGE = document.body.dataset.mode === "predators" ? PREDATORS_PAGE : ECOSYSTEM_PAGE;
// The page opens on the Normal preset.
const NORMAL = openingConfig(PAGE);
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
let goneNoted = 0; // species that died out and have been noted, as a bit mask
let canvasW = 0;
let canvasH = 0;
let lastUiAt = 0;
let lastBrainAt = 0;

let host: RenderHost | null = null; // who draws; null until the probe has decided
let ready: Promise<void>; // settles when it is known who draws
const camera = new Camera(config.world.width, config.world.height, 1, 1);

function drawIdle(): void {
  if (!active) host?.idle(config);
}

// Acknowledges a snapshot: gives its buffer back, or with a render worker (which holds the buffer) only says it was handled.
function recycle(m: EcoSnapshot): void {
  if (m.buffer.byteLength) send({ type: "recycle", buffer: m.buffer, run: m.run }, [m.buffer]);
  else send({ type: "recycle", run: m.run });
}

function send(msg: EcoInMessage, transfer: Transferable[] = []): void {
  worker?.postMessage(msg, { transfer });
}

const several = (c: EcoConfig): boolean => (c.species?.length ?? 0) > 1;
let species = speciesList(config); // the config's species, resolved
function setConfig(c: EcoConfig): void {
  config = c;
  species = speciesList(c);
}

function drawConfig(): EcoDrawConfig {
  const { world, creature, eco } = config;
  const winter = eco.seasons && live ? winterness(eco, live.msg.simTime) : 0;
  const kinds = species.map((sp) => ({ fullEnergy: fullEnergy(sp), hunter: sp.prey.length > 0 }));
  return { worldW: world.width, worldH: world.height, radius: creature.radius, itemRadius: world.itemRadius, species: kinds, winter };
}

// Matches the canvas and camera to the layout; returns the device pixel ratio.
function syncCanvas(): number {
  const dpr = host!.fit();
  const { width, height } = host!.backing();
  if (width !== canvasW || height !== canvasH) {
    canvasW = width;
    canvasH = height;
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
  return ((r.right - c.left) / 2) * (host!.backing().width / c.width);
}

function releaseLive(): void {
  if (live) recycle(live.msg);
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
    recycle(msg);
    return;
  }
  const previous = live;
  live = { msg, views: msg.buffer.byteLength ? snapshotViews(msg.buffer, msg.count, msg.itemCount, msg.creatureCap, msg.itemCap) : null };
  if (previous) recycle(previous.msg);
  host!.observe(live.views, msg.events, performance.now());
  if (msg.history) view.setHistory(toSamples(msg.history));
  if (msg.lineageHistory) view.setLineageHistory(msg.lineageHistory);
  if (msg.traits) view.setTraits(msg.traits);
  if (msg.leaders) view.setLeaders(msg.leaders);
  if (msg.lineages) view.setLineages(msg.lineages, msg.population, msg.species?.map((c) => c.population));
  if (msg.species && !msg.extinct) noteGone(msg.species.map((c) => c.population));
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

// A species that dies out while others live on gets a note; the run goes on.
function noteGone(populations: readonly number[]): void {
  let gone = 0;
  populations.forEach((p, s) => { if (p === 0) gone |= 1 << s; });
  if (gone === goneNoted) return;
  goneNoted = gone;
  const names = species.filter((_, s) => gone & (1 << s)).map((sp) => sp.name.toLowerCase());
  view.setNote(names.length ? `Every ${names.join(" and every ")} has died. The run goes on without them.` : null);
}

function toSamples(h: Float64Array): PopulationSample[] {
  const out: PopulationSample[] = [];
  const kinds = several(config) ? species.length : 0;
  const size = 3 + kinds;
  for (let i = 0; i + size - 1 < h.length; i += size) {
    const sample: PopulationSample = { time: h[i]!, population: h[i + 1]!, food: h[i + 2]! };
    if (kinds) sample.species = Array.from(h.subarray(i + 3, i + size));
    out.push(sample);
  }
  return out;
}

function startRun(c: EcoConfig): void {
  setConfig(c);
  active = true;
  run++;
  extinctShown = false;
  goneNoted = 0;
  worker ??= createWorker();
  releaseLive();
  host!.reset();
  clearSelection();
  syncCanvas();
  camera.setWorld(c.world.width, c.world.height);
  view.setHistory([]);
  view.setSeasons(c.eco);
  view.clearLineages();
  view.clearStatistics();
  highlight = -1;
  view.setStats(null);
  view.setNote(null);
  send({ type: "start", config: c, run, poolUrl: POOL_URL, threads: THREADS });
  send({ type: "speed", speed: view.speed() });
}

function createWorker(): Worker {
  const w = new Worker(new URL("./worker/ecoWorker.ts", import.meta.url), { type: "module" });
  w.onmessage = onSnapshot;
  const port = host!.takePort();
  if (port) w.postMessage({ type: "renderPort", port }, [port]);
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
function select(id: number, x: number, y: number): void {
  clearSelection();
  send({ type: "select", id });
  beginSelection(id, x, y, config.creature.rayLength);
}

// Asks the worker for the best creature; the zoom-in starts when it answers.
function selectBest(by: Board): void {
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
  host!.pick(wx, wy, reach, run, live.views);
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
  view.setStats({ population: m.population, births: m.births, deaths: m.deaths, food: m.food, poison: m.poison, simTime: m.simTime, oldestDepth: m.oldestDepth, speed: m.speed > 0 ? m.speed : null, helpers: m.helpers, wasm: m.wasm, season: config.eco.seasons ? { name: seasonName(config.eco, m.simTime), factor: seasonFactor(config.eco, m.simTime) } : null, species: m.species });
  const d = selection?.last;
  if (selection && d) {
    const sp = species[d.species]!;
    const kind = several(config) ? { name: sp.name, index: d.species, kills: d.kills, hunter: sp.prey.length > 0 } : undefined;
    view.setSelected({ id: d.id, energy: d.energy, fullEnergy: d.birthEnergy, age: d.age, children: d.children, eaten: d.eaten, depth: d.depth, plan: d.plan, upkeep: d.upkeep, drain: d.drain, birth: { energy: d.birthEnergy, cost: d.birthCost, cooldown: d.birthCooldown }, founderId: d.founderId, founderPool: d.founderPool, founderHue: d.founderHue, species: kind, died: selection.died });
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
  if (!host!.frame({ run, camera, cfg: drawConfig(), views: live.views, selected: selection?.details ?? null, showRays, dpr, highlight, now })) return;
  if (now - lastUiAt >= UI_INTERVAL_MS) {
    lastUiAt = now;
    updateUi();
  }
  drawBrain(now);
}

const view = createEcoView({
  onStart: (c) => void ready.then(() => startRun(c)), // not before it is known who draws
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
    goneNoted = 0;
    setConfig(view.readConfig());
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
    setConfig(c);
    drawIdle();
  },
}, PAGE);

ready = createRenderHost(view.canvas, {
  onPick(id, x, y, pickRun) {
    if (!active || pickRun !== run) return;
    if (id >= 0) select(id, x, y);
    else if (selection) clearSelection();
  },
  onDead(message) {
    view.setNote(`Drawing stopped: ${message}`);
    worker?.postMessage({ type: "renderGone" }); // snapshots go to the page with their buffers again
  },
}).then((h) => { host = h; drawIdle(); });
camera.attach(view.canvas, () => host?.backing() ?? view.canvas);
showRays = view.showRays();
view.fillConfig(NORMAL);
new ResizeObserver(drawIdle).observe(view.canvas);
drawIdle();
requestAnimationFrame(frame);
