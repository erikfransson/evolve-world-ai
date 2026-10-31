import "./base.css";
import "./style.css";
import "./ecosystem.css";
import "./live.css";
import { DEFAULT_ECO_CONFIG, seasonFactor, seasonName, winterness } from "./sim/ecoConfig.ts";
import type { EcoConfig } from "./sim/ecoConfig.ts";
import type { Lineage } from "./sim/ecosystem.ts";
import type { Leaders } from "./sim/leaderboard.ts";
import { versionLabel } from "./live/versionLabel.ts";
import { Camera } from "./ui/camera.ts";
import { fitCanvas } from "./ui/canvas.ts";
import { pickCreature } from "./ui/ecoPick.ts";
import { BirthRings } from "./ui/ecoBirths.ts";
import { ImpactEffects } from "./ui/ecoImpacts.ts";
import { EcoRenderer } from "./ui/ecoScene.ts";
import type { EcoDrawConfig } from "./ui/ecoScene.ts";
import { buildSelectedBrain } from "./ui/ecoBrain.ts";
import type { SelectedBrain } from "./ui/ecoBrain.ts";
import { BrainView } from "./ui/brainView.ts";
import { PopulationGraph } from "./ui/populationGraph.ts";
import type { PopulationSample } from "./ui/populationGraph.ts";
import { LineagePanel, lineageColor, rowLiving } from "./ui/lineagePanel.ts";
import { BOARD_SPECS, LeaderPanel } from "./ui/leaderPanel.ts";
import { formatBirth, formatPlan } from "./ui/ecoPage.ts";
import { initCard } from "./ui/overlays.ts";
import { initTooltips } from "./ui/tooltip.ts";
import { $, durationText, setTile } from "./ui/page.ts";
import type { SelectedDetails } from "./worker/ecoProtocol.ts";
import { LiveLink, historyAxis } from "./live/connection.ts";
import type { LinkState } from "./live/connection.ts";
import { LiveScene } from "./live/scene.ts";
import { serverUrl } from "./live/serverUrl.ts";
import { HISTORY_FIELDS, LINEAGE_FIELDS, MAX_HISTORY, MAX_LINEAGE_HISTORY } from "./live/protocol.ts";
import type { Hello, Season, Stats } from "./live/protocol.ts";
import { AddPanel } from "./live/addPanel.ts";
import { parseFounders } from "./live/founders.ts";
import { renderMapInfo } from "./live/mapInfo.ts";
import { LIVE_MAP, MapCache } from "./live/mapTerrain.ts";
import { mapLoader } from "./live/mapAsset.ts";
import { GROUND_FILES, MAP_FILES } from "./live/mapFiles.ts";
import { GroundBackdrop } from "./ui/groundBackdrop.ts";
import { fitWorld } from "./ui/camera.ts";
import { useRockFarm, warmRock } from "./ui/abyssRock.ts";
import { rockFarm } from "./ui/rockFarm.ts";
import { recastRays } from "./live/rayRecast.ts";
import { paintMapLegendWhenSeen } from "./live/mapLegend.ts";
import { mapSpec, mapVersion } from "./sim/maps/index.ts";
import { BACKGROUND } from "./ui/palette.ts";
import { prepareTerrain } from "./ui/terrainScene.ts";
import type { Terrain } from "./sim/terrain.ts";

// TODO(L6): admin panel. `?admin` opens a second socket to the owner's loopback admin port (ws://127.0.0.1:8788), sends {t:"auth", token}
// with a token the owner pastes in, then {t:"get-config"} and {t:"set-config", changes}. See server/src/admin.ts.

const MAX_CREATURE_PX = 60; // CSS px radius of a creature at the closest zoom
const PICK_RADII = 3; // click reach in creature radii
const PICK_MIN_PX = 14; // click reach never below this many CSS px
const SELECT_RAY_LENGTHS = 4.5; // follow zoom for every jump to a creature: this many ray lengths across the free part of the view (Erik: 1.5x further out than 3)
const ZOOM_STEP = 1.6;
const UI_INTERVAL_MS = 100;
const BRAIN_INTERVAL_MS = 25;
const STORE = "evolve.live.card";
const ENTRY_KEY = "evolve.live.entry"; // sessionStorage: the entry card was answered this visit
const REVEAL_FADE_MS = 450; // the world fades in over this once its ground, food and creatures are all ready
const REVEAL_CAP_MS = 2000; // after the hello, shown as it is if the ground is still not ready, rather than hold the world back
const SEASON_COLORS: Record<string, string> = { Summer: "#fbbf24", Autumn: "#fb923c", Winter: "#93c5fd", Spring: "#4ade80" };

// The ground and rock of a hand-designed map, built from its name on a worker (once per map and size). The live world's map starts
// building at once, in parallel with loading the page and connecting; a hello naming another map builds that one instead.
// The map comes from the file the build ships (live/mapAsset.ts), else it is built on a worker; its rock images are made on workers.
const WARM_SCALE = 0.03; // a whole-map view: its rock images are the ones a first view of the map needs (abyssRock's cellFor is the same below about 0.08)
const maps = new MapCache(mapLoader(MAP_FILES));
useRockFarm(rockFarm());
const liveSpec = mapSpec(LIVE_MAP)!;
void maps.get(LIVE_MAP, liveSpec.width, liveSpec.height).then((t) => t && warmRock(t, WARM_SCALE));

// The page font, preloaded by live/index.html and applied here, so the first paint does not wait for it.
const fontLink = document.getElementById("pageFont") as HTMLLinkElement | null;
if (fontLink) {
  const font = document.createElement("link");
  font.rel = "stylesheet";
  font.crossOrigin = "";
  font.href = fontLink.href;
  document.head.append(font);
}

const canvas = $<HTMLCanvasElement>("view");
// The live map's ground as a picture (ui/groundBackdrop.ts): under the canvas by CSS from the first paint, then on it until the map is drawn sharp.
const backdrop = new GroundBackdrop(liveSpec.width, liveSpec.height, GROUND_FILES[LIVE_MAP]!);
backdrop.load(fitWorld(liveSpec.width, liveSpec.height, Math.max(1, canvas.clientWidth) * devicePixelRatio, Math.max(1, canvas.clientHeight) * devicePixelRatio));
const chip = $("chip");
const versionEl = $("version");
versionEl.textContent = versionLabel(null); // the page's own version until the server says hello
const mobile = window.matchMedia("(max-width: 700px)").matches;
const camera = new Camera(1, 1, 1, 1);
const renderer = new EcoRenderer();
const births = new BirthRings();
const impacts = new ImpactEffects();
const scene = new LiveScene();
const url = serverUrl(location.search, import.meta.env.DEV || ["127.0.0.1", "localhost"].includes(location.hostname));
const nf = new Intl.NumberFormat("en-US");
// The engine settings the brain view needs (input layout); the live world uses the Ecosystem's single species.
const engine: EcoConfig = structuredClone(DEFAULT_ECO_CONFIG);

initTooltips($("tooltip"));
initCard($("legendCard"), `${STORE}.legend`, mobile);
initCard($("selectedCard"), `${STORE}.selected`, false);
const brainPanel = initCard($("brainCard"), `${STORE}.brain`, mobile);
initCard($("graphCard"), `${STORE}.graph`, false);
initCard($("lineageCard"), `${STORE}.lineage`, mobile);
initCard($("leaderCard"), `${STORE}.leaders`, mobile);
const brainView = new BrainView($<HTMLCanvasElement>("brainView"));
const graph = new PopulationGraph($<HTMLCanvasElement>("graphView"));
const lineages = new LineagePanel($("lineageCard"), (f) => {
  highlight = f ?? -1;
  syncFamily();
});
const leaderCard = $("leaderCard");
let leaderPanel: LeaderPanel | null = null;

let hello: Hello | null = null;
let draw: EcoDrawConfig | null = null;
let canvasW = 0;
let canvasH = 0;
let lastUiAt = 0;
let lastBrainAt = 0;
let lastDrawAt = 0;
let lastStats: Stats | null = null;
let season: Season | null = null;
let retryTimer: ReturnType<typeof setInterval> | undefined;
let highlight = -1; // founder whose family is lit (a row's founder), -1 for none
let litOf = -1; // the highlight the stats handler last saw, and since when (performance.now): a fresh highlight is never let go at once
let litAt = 0;
let familyOf = new Map<number, number>(); // founder -> the founder of the lineage row it is counted in, from the latest stats
let lastLineages: readonly { founder: number; name?: string }[] = []; // the rows of the last stats, to follow a lit group
const rowOf = (f: number): number => familyOf.get(f) ?? f;
// The views with every founder of the lit row drawn as that row's founder, so the whole named family lights up.
let litFounder: Uint32Array | null = null;
function litViews<V extends { founder: ArrayLike<number> }>(v: V): V {
  if (highlight < 0 || familyOf.size === 0) return v;
  const n = v.founder.length;
  if (!litFounder || litFounder.length < n) litFounder = new Uint32Array(Math.max(n, 1024));
  const out = litFounder.subarray(0, n);
  for (let i = 0; i < n; i++) out[i] = rowOf(v.founder[i]!);
  return { ...v, founder: out };
}
let samples: number[] = []; // population history, HISTORY_FIELDS each
let names = new Map<number, string>(); // founder id -> name, for the named lineages
let starters = new Set<number>(); // the named ones that are starter founders, not visitor adds
let lineageHistory: number[] = [];

// The followed creature: its latest details (from the timeline), the genome once it came, and a brain built from both.
interface Selection {
  id: number;
  last: SelectedDetails | null; // while alive
  founderName: string; // "" for none
  founderStarter: boolean;
  died: boolean;
  genome: Float32Array | null;
  brain: SelectedBrain | null;
  zoomed: boolean; // the zoom-in has started (it waits until the creature is on screen)
}
let selection: Selection | null = null;
let following = false;
let pendingFollow = false; // follow once the zoom-in has ended (following cuts an animation short)
let followAfter = 0; // camera.animationsCompleted that means the zoom-in finished

function setChip(state: LinkState, text: string, more = ""): void {
  chip.dataset.state = state;
  $("chipText").textContent = text;
  $("chipMore").textContent = more;
}

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`;
}

function onState(state: LinkState, retryInS: number): void {
  clearInterval(retryTimer);
  $("offline").hidden = state !== "offline";
  $("worldLoading").hidden = revealAt >= 0 || state === "offline";
  if (state !== "live") {
    addPanel.disconnected();
    $("emptyNote").hidden = true;
    $("entryLive").textContent = state === "connecting" ? "Connecting to the world" : state === "full" ? "Full of viewers right now" : state === "updating" ? "The world is being updated, back soon" : state === "outdated" ? "This page is out of date, reload it" : "The world is offline right now";
  }
  if (state === "connecting") setChip(state, "Connecting");
  else if (state === "full") setChip(state, "Full of viewers", `, retrying in ${retryInS} s`);
  else if (state === "updating") setChip(state, "Updating", ", back soon");
  else if (state === "outdated") setChip(state, "Reload", " for the new version");
  else if (state === "live") {
    chip.dataset.state = "live";
    renderStats();
  } else {
    setChip(state, "World offline");
    let left = retryInS;
    const tick = (): void => {
      $("offlineRetry").textContent = left > 0 ? `Trying again in ${left} s` : "Trying again";
      left = Math.max(0, left - 1);
    };
    tick();
    retryTimer = setInterval(tick, 1000);
    clearSelection();
  }
}

const seasonEco = (s: Season): EcoConfig["eco"] => ({ ...engine.eco, seasons: true, yearMinutes: s.yearMinutes, winterFood: s.winterFood });

function renderStats(): void {
  const s = lastStats;
  if (s) {
    setTile("statPop", nf.format(s.population));
    setTile("statViewers", nf.format(s.viewers));
    setTile("statLived", s.lived === undefined ? null : nf.format(s.lived));
    setTile("statKills", s.kills === undefined ? null : nf.format(s.kills));
    setTile("statFood", nf.format(s.food));
    setTile("statTime", durationText(s.simSeconds));
    setTile("statDepth", nf.format(s.depth));
    setTile("statSpeed", s.speed.toFixed(1), " ×");
    setTile("statUptime", fmtUptime(s.uptimeS));
    $("statSeasonTile").hidden = !s.season;
    if (s.season) showSeason(seasonName(seasonEco(s.season), s.simSeconds), `food\u00a0${seasonFactor(seasonEco(s.season), s.simSeconds).toFixed(2)}×`);
  }
  if (chip.dataset.state === "live") setChip("live", mapStale ? "Map updating" : "Live", s ? ` · ${nf.format(s.viewers)} watching` : "");
  if (chip.dataset.state === "live" && revealAt < 0) $("entryLive").textContent = "Loading the world";
  else if (s && chip.dataset.state === "live") $("entryLive").textContent = s.population > 0 ? `${nf.format(s.population)} creatures alive · ${nf.format(s.viewers)} watching` : `No creatures right now, add one to start the world again · ${nf.format(s.viewers)} watching`;
  $("emptyNote").hidden = !(s && chip.dataset.state === "live" && s.population === 0);
}

// The season and its food factor; the separator between them is CSS, so a wrapped factor starts its line clean.
function showSeason(name: string, food: string): void {
  const dd = $("statSeason");
  dd.dataset.unit = "";
  const wrap = document.createElement("span");
  wrap.className = "s-wrap";
  const a = document.createElement("span");
  a.className = "s-name";
  a.textContent = name;
  const b = document.createElement("span");
  b.className = "s-food";
  b.textContent = food;
  wrap.append(a, b);
  dd.replaceChildren(wrap);
}

function onHello(h: Hello): void {
  hello = h;
  helloAt = performance.now();
  mapStale = false;
  versionEl.textContent = versionLabel(h.serverVersion);
  scene.reset();
  scene.fullEnergy = h.fullEnergy;
  scene.dt = h.dt;
  draw = { worldW: h.world.width, worldH: h.world.height, radius: h.radius, itemRadius: h.itemRadius, species: [{ fullEnergy: h.fullEnergy, hunter: false }], winter: 0 };
  showMap(h);
  camera.setWorld(h.world.width, h.world.height);
  births.reset();
  impacts.reset();
  samples = [];
  lineageHistory = [];
  showHistory();
  lineages.reset();
  highlight = -1;
  leaderPanel ??= new LeaderPanel(leaderCard, [], h.radius);
  leaderPanel.clear();
  clearSelection();
  names = new Map();
  starters = new Set();
  familyOf = new Map();
  lastLineages = [];
  addPanel.setRules(h.add);
  renderMapInfo($("info"), h);
}

let mapStale = false;
let mapFailed = false; // the map of the latest hello could not be built: plain ground
function showMap(h: Hello): void {
  const name = h.map.name;
  if (!name) return;
  const d = draw;
  // The server runs another design of this map than this page has: plain ground, and the pill says so, until the page is updated.
  mapStale = h.map.version !== undefined && h.map.version !== mapVersion(name);
  if (d) d.backdrop = !mapStale && name === LIVE_MAP && h.world.width === liveSpec.width && h.world.height === liveSpec.height ? backdrop : null;
  mapFailed = false;
  renderStats();
  if (mapStale) return;
  void maps.get(name, h.world.width, h.world.height).then((t) => {
    if (draw !== d) return; // a newer hello has its own
    if (!t) mapFailed = true;
    else {
      // With the ground picture on screen the sharp map can wait: its first draw makes its images for a moment, so it starts once the world shows and the page is idle.
      const use = (): void => {
        if (draw !== d) return;
        d!.map = t;
        paintMapLegendWhenSeen($("info"), t);
      };
      if (d!.backdrop?.ready) afterReveal(() => warmMap(t, use));
      else use();
    }
  });
}

// Makes the map's images for the current view (and the margin the terrain cache draws past it) a few per idle moment, then calls done,
// so the sharp map replaces the ground picture without one long frame.
const WARM_MARGIN = 0.25; // of the view per side, as ui/terrainCache.ts caches
function warmMap(t: Terrain, done: () => void): void {
  const later = (fn: () => void): void => void (typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 50));
  const step = (): void => {
    const tl = camera.screenToWorld(0, 0);
    const br = camera.screenToWorld(canvas.width, canvas.height);
    const mx = WARM_MARGIN * (br.x - tl.x);
    const my = WARM_MARGIN * (br.y - tl.y);
    if (prepareTerrain(t, camera.zoom, { x0: tl.x - mx, x1: br.x + mx, y0: tl.y - my, y1: br.y + my })) done();
    else later(step);
  };
  later(step);
}

// Population samples for the graph, shifted to start near time 0 (historyAxis).
function showHistory(): void {
  const first = samples[0] ?? 0;
  const last = samples.at(-HISTORY_FIELDS) ?? first;
  const { shift, aligned } = historyAxis(first, last, season ? season.yearMinutes * 60 : 0);
  const out: PopulationSample[] = [];
  for (let i = 0; i + HISTORY_FIELDS <= samples.length; i += HISTORY_FIELDS) out.push({ time: samples[i]! - shift, population: samples[i + 1]!, food: samples[i + 2]! });
  graph.setSeasons(season && aligned ? seasonEco(season) : null);
  graph.setData(out);
  $("graphNote").textContent = shift > 0 ? `last ${durationText(last - first)} · simulated time` : "simulated time";
  const lin = Float64Array.from(lineageHistory);
  const t0 = lin[0] ?? 0;
  for (let i = 0; i < lin.length; i += LINEAGE_FIELDS) lin[i]! -= t0;
  lineages.setHistory(lin);
}

function syncCanvas(): number {
  const dpr = fitCanvas(canvas);
  if (canvas.width !== canvasW || canvas.height !== canvasH) {
    canvasW = canvas.width;
    canvasH = canvas.height;
    camera.resize(canvasW, canvasH);
  }
  if (hello) camera.maxZoom = (MAX_CREATURE_PX * dpr) / hello.radius;
  return dpr;
}

// Shifts the view centre into the part of the canvas the overlay cards leave free. Phones have the cards below the canvas.
function overlayShift(): number {
  const stack = document.querySelector<HTMLElement>(".ov-stack");
  if (!stack || getComputedStyle(stack).position !== "absolute") return 0;
  const c = canvas.getBoundingClientRect();
  // The open cards only: folded ones are small chips, and with all folded the creature is centred in the whole view.
  let right = c.left;
  for (const card of stack.querySelectorAll<HTMLElement>(":scope > .ov:not(.min):not([hidden])")) right = Math.max(right, card.getBoundingClientRect().right);
  if (right <= c.left || c.right - right < 0.4 * c.width) return 0;
  return ((right - c.left) / 2) * (canvasW / c.width);
}

function setFollowing(on: boolean): void {
  following = on;
  $("follow").setAttribute("aria-pressed", String(on));
}

function clearSelection(): void {
  if (selection) link.select(null);
  selection = null;
  pendingFollow = false;
  setFollowing(false);
  camera.follow(null);
  camera.setFocusOffset(0, 0);
  $("selectedCard").classList.remove("has-sel");
  $("brainCard").hidden = true;
  markRecords();
}

function followSelected(): void {
  camera.follow(() => {
    const i = selection ? scene.slotOf(selection.id) : -1;
    return i >= 0 ? { x: scene.views.x[i]!, y: scene.views.y[i]! } : null;
  });
  setFollowing(true);
}

// Follows creature id: asks the server for its details and zooms in once it is on screen.
function select(id: number): void {
  if (selection?.id === id) return;
  selection = { id, last: null, founderName: "", founderStarter: false, died: false, genome: null, brain: null, zoomed: false };
  link.select(id); // replaces the last one on the server: one message per click, so the select rate is not spent on letting go
  $("selectedCard").classList.add("has-sel");
  $("brainCard").hidden = false;
  $("brainWait").hidden = false;
  $("brainView").hidden = true;
  zoomToSelection();
  markRecords();
  updateSelectedCard();
}

function zoomToSelection(): void {
  const s = selection;
  if (!s || s.zoomed) return;
  const i = scene.slotOf(s.id);
  if (i < 0) return;
  s.zoomed = true;
  const shift = overlayShift();
  const rayLength = s.last?.plan.rayLength ?? engine.creature.rayLength;
  camera.cancel();
  camera.setFocusOffset(shift, 0);
  camera.animateTo(scene.views.x[i]!, scene.views.y[i]!, Math.min(canvasW - 2 * shift, canvasH) / (SELECT_RAY_LENGTHS * rayLength));
  pendingFollow = true;
  followAfter = camera.animationsCompleted + 1;
  setFollowing(true);
}

// Starts following once the zoom-in has ended, and notices when following stopped: the user dragged, or the creature died.
function syncFollow(): void {
  if (pendingFollow) {
    if (camera.animating) return;
    pendingFollow = false;
    if (camera.animationsCompleted >= followAfter && selection && scene.slotOf(selection.id) >= 0) followSelected();
    else setFollowing(false);
  } else if (following && !camera.following) setFollowing(false);
}

camera.onClick = (wx, wy) => {
  if (!hello) return;
  const v = scene.views;
  const dpr = window.devicePixelRatio || 1;
  const reach = Math.max(PICK_RADII * hello.radius, (PICK_MIN_PX * dpr) / camera.zoom);
  const i = pickCreature(v.x, v.y, v.count, wx, wy, reach);
  if (i >= 0) select(v.ids[i]! >>> 0); // ids are u32, the views hold them as i32
  else clearSelection();
};

let rayKinds = new Uint8Array(0); // the selected creature's rays cast this frame (recastRays)
let rayCloseness = new Float32Array(0);

function onDetail(d: SelectedDetails, founderName: string, founderStarter: boolean): void {
  const s = selection;
  if (!s || d.id !== s.id) return;
  if (!d.alive) {
    s.died = true;
    followNextCopy(s.id);
    return;
  }
  s.founderName = founderName;
  s.founderStarter = founderStarter;
  const replan = s.last && formatPlan(s.last.plan) !== formatPlan(d.plan);
  s.last = d;
  if (replan) s.brain = null;
  buildBrain();
}

function buildBrain(): void {
  const s = selection;
  if (!s?.last || !s.genome || s.brain) return;
  try {
    s.brain = buildSelectedBrain(engine, { ...s.last, genome: s.genome });
    $("brainWait").hidden = true;
    $("brainView").hidden = false;
  } catch {
    s.genome = null; // a genome that does not fit the plan: wait for none rather than draw a wrong brain
  }
}

function updateSelectedCard(): void {
  const s = selection;
  if (!s) return;
  const d = s.last;
  if (!d) {
    $("selEnergy").textContent = s.died ? "died" : "…";
    $("selId").textContent = `#${s.id}`;
    return;
  }
  const full = Math.max(1, d.birthEnergy);
  const frac = Math.min(1, Math.max(0, d.energy / full));
  $("selFill").style.width = `${frac * 100}%`;
  const meter = $("selMeter");
  meter.setAttribute("aria-valuemax", String(Math.round(full)));
  meter.setAttribute("aria-valuenow", String(Math.round(d.energy)));
  $("selEnergy").textContent = s.died ? "died" : `${Math.round(d.energy)} / ${Math.round(full)}`;
  $("selAge").textContent = durationText(d.age);
  $("selChildren").textContent = nf.format(d.children);
  $("selKills").textContent = nf.format(d.kills);
  $("selEaten").textContent = nf.format(d.eaten);
  $("selDepth").textContent = nf.format(d.depth);
  $("selId").textContent = `#${d.id}`;
  $("selPlan").textContent = `${formatPlan(d.plan)} · ${formatBirth({ energy: d.birthEnergy, cost: d.birthCost, cooldown: d.birthCooldown })}`;
  $("selBase").textContent = d.upkeep.toFixed(2);
  $("selDrain").textContent = s.died ? "-" : d.drain.toFixed(2);
  $("selFounderSw").style.background = lineageColor(d.founderHue);
  const named = s.founderName;
  $("selFounderText").textContent = named ? `${named} · founder #${d.founderId} · ${s.founderStarter ? "starter" : "added"}` : `Founder #${d.founderId} · ${d.founderPool ? "trained pool" : "random"}`;
  syncFamily();
}

// The family toggle on the selected card. When one founder's family is the whole world, lighting it dims nobody, so it says so.
function syncFamily(): void {
  const f = selection?.last?.founderId;
  const on = highlight >= 0 && f !== undefined && rowOf(f) === highlight;
  const b = $("selFounder");
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
  const size = lastStats?.lineages?.find((l) => f !== undefined && l.founder === rowOf(f))?.count ?? 0;
  const everyone = !!lastStats && lastStats.population > 0 && size >= lastStats.population;
  $("selFamilyLabel").textContent = everyone ? (on ? "Everyone shares this founder" : "Everyone's founder") : on ? "Family lit" : "Highlight family";
}

// The records card, with each living entry clickable to follow it. Cells come out of LeaderPanel in BOARD_SPECS order.
let recordIds: (number | null)[] = [];
function setRecords(records: NonNullable<Stats["records"]>): void {
  if (!leaderPanel) return;
  const leaders: Leaders[] = records.map((r) => ({ species: 0, board: r.board, entries: r.entries.map((e) => ({ ...e, species: 0 })) }));
  leaderPanel.set(leaders);
  recordIds = BOARD_SPECS.flatMap((spec) => leaders.find((l) => l.board === spec.board)?.entries.map((e) => (e.alive ? e.id : null)) ?? []);
  markRecords();
}

function markRecords(): void {
  leaderCard.querySelectorAll<HTMLElement>(".lead-cell").forEach((cell, k) => {
    const id = recordIds[k] ?? null;
    cell.classList.toggle("live-pick", id !== null);
    cell.classList.toggle("following", id !== null && id === selection?.id);
    if (id === null) {
      cell.removeAttribute("tabindex");
      cell.removeAttribute("role");
      delete cell.dataset.id;
    } else {
      cell.tabIndex = 0;
      cell.setAttribute("role", "button");
      cell.dataset.id = String(id);
    }
  });
}

leaderCard.addEventListener("click", (e) => {
  const cell = (e.target as HTMLElement).closest<HTMLElement>(".lead-cell[data-id]");
  if (cell) select(Number(cell.dataset.id));
});
leaderCard.addEventListener("keydown", (e) => {
  const cell = (e.target as HTMLElement).closest<HTMLElement>(".lead-cell[data-id]");
  if (cell && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    select(Number(cell.dataset.id));
  }
});

function onStats(s: Stats): void {
  lastStats = s;
  const seasonChanged = JSON.stringify(s.season) !== JSON.stringify(season);
  season = s.season;
  if (s.sample) {
    samples.push(...s.sample);
    if (samples.length > MAX_HISTORY * HISTORY_FIELDS) samples.splice(0, HISTORY_FIELDS);
  }
  if (s.lineageSample) {
    lineageHistory.push(...s.lineageSample);
    if (lineageHistory.length > MAX_LINEAGE_HISTORY * LINEAGE_FIELDS) lineageHistory.splice(0, LINEAGE_FIELDS);
  }
  if (s.sample || s.lineageSample || seasonChanged) showHistory();
  if (s.lineages) {
    // A named group's row is its lowest living founder; when that line dies out the row moves to the next one. A lit group follows it.
    const litName = highlight >= 0 ? (lastLineages.find((l) => l.founder === highlight)?.name ?? "") : "";
    familyOf = new Map();
    for (const l of s.lineages) {
      for (const f of l.founders ?? []) familyOf.set(f, l.founder); // the seeded copies of a starter share its row and its light
      // Each listed lineage carries its name every time, so a missing one (an admin cleared it) clears the page's copy.
      if (l.name) names.set(l.founder, l.name);
      else names.delete(l.founder);
      if (l.starter) starters.add(l.founder);
      else starters.delete(l.founder);
    }
    if (starters.size > 200) starters = new Set([...starters].slice(-100));
    if (names.size > 200) names = new Map([...names].slice(-100)); // only the listed ones matter; old ones go
    if (litName && !s.lineages.some((l) => l.founder === highlight)) {
      const row = s.lineages.find((l) => l.name === litName);
      if (row) {
        highlight = row.founder;
        lineages.setHighlight(highlight);
        syncFamily();
      }
    }
    // A lit family that died out lets go, so everyone gets their colour back (the views still hold its fading ghosts for a moment).
    // A family lit in the last 3 s is kept: a visitor's new copies reach the views a frame and a motion span after the add's reply.
    const now = performance.now();
    if (highlight !== litOf) [litOf, litAt] = [highlight, now];
    if (highlight >= 0 && now - litAt > 3000 && scene.views.count > 0 && !rowLiving(scene.views.founder, scene.views.count, highlight, rowOf)) {
      highlight = -1;
      lineages.setHighlight(null);
      syncFamily();
    }
    lastLineages = s.lineages;
    lineages.setLineages(s.lineages.map((l): Lineage => ({ founder: l.founder, hue: l.hue, pool: l.pool, count: l.count, species: 0 })), s.population, names, starters);
  }
  if (s.records) setRecords(s.records);
  $<HTMLButtonElement>("pickAge").disabled = !s.best;
  $<HTMLButtonElement>("pickChildren").disabled = !s.best;
  $<HTMLButtonElement>("pickKills").disabled = !s.best;
  renderStats();
}

function drawConfig(): EcoDrawConfig {
  draw!.winter = season ? winterness(seasonEco(season), scene.displayTick * scene.dt) : 0;
  return draw!;
}

function updateTimer(): void {
  const t = scene.displayTick * scene.dt;
  const timer = $("timer");
  timer.hidden = !scene.views.count;
  $("timerText").textContent = durationText(t);
  const name = season ? seasonName(seasonEco(season), t) : "";
  const pill = $("timerSeason");
  if (pill.textContent !== name) {
    pill.textContent = name;
    pill.style.setProperty("--season", SEASON_COLORS[name] ?? "#3ddc97");
  }
}

function drawBrain(now: number): void {
  const s = selection;
  if (!s?.brain || !s.last || !brainPanel.isExpanded() || now - lastBrainAt < BRAIN_INTERVAL_MS) return;
  lastBrainAt = now;
  s.brain.brain.forward(s.last.inputs, s.brain.out);
  brainView.draw(s.brain.brain, !s.died, s.brain.layout);
}

// The world shows at once as a whole: the item set and a creature frame are in and the ground can be drawn, then it fades in.
// Until then the plain background shows. Without a map, a stale or failed one, or past REVEAL_CAP_MS, it shows with what it has.
let helloAt = 0;
let revealAt = -1; // performance.now() of the reveal, -1 before
let gotCreatures = false;
function worldReady(now: number): boolean {
  if (!hello || !draw) return false;
  if (now - helloAt > REVEAL_CAP_MS) return true;
  return gotCreatures && scene.hasItems && groundReady();
}
// Whether the ground can be drawn: its picture is in, the map's Terrain is built, or there is no map to wait for.
function groundReady(): boolean {
  return !hello!.map.name || mapStale || mapFailed || draw!.map !== undefined || draw!.backdrop?.ready === true;
}
function reveal(now: number): void {
  revealAt = now;
  $("worldLoading").hidden = true;
  renderStats();
  setTimeout(runDeferred); // after the first frame of the world
  loadFounders();
}
// Stats and history (tiles, graphs, lineages, records) wait until the world shows, so the first messages go to the world; then they run in order.
let deferred: (() => void)[] | null = [];
function afterReveal(fn: () => void): void {
  if (deferred) deferred.push(fn);
  else fn();
}
function runDeferred(): void {
  while (deferred?.length) deferred.shift()!();
  deferred = null;
}

const IDLE_FRAME_MS = 1000 / 30 - 2; // with nothing followed or animating, draw at most 30 times a second (every frame while the world fades in)
function frame(now: number): void {
  requestAnimationFrame(frame);
  if (!selection && !camera.animating && now - revealAt > REVEAL_FADE_MS && now - lastDrawAt < IDLE_FRAME_MS) return;
  lastDrawAt = now;
  const dpr = syncCanvas();
  const ctx = canvas.getContext("2d")!;
  camera.update(now);
  if (draw && revealAt < 0) {
    scene.sample(now); // applies the item set when it is due
    if (worldReady(now)) reveal(now);
  }
  if (!draw || revealAt < 0) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bd = draw ? (draw.backdrop ?? null) : backdrop; // none once a hello names another map
    if (bd && !bd.ready) return ctx.clearRect(0, 0, canvas.width, canvas.height); // clear: the page's CSS shows the ground pictures under the canvas meanwhile
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    bd?.drawFitted(ctx, canvas.width, canvas.height, dpr);
    return;
  }
  // An empty world is still drawn: its ground and food stay in view until creatures are added again.
  if (scene.sample(now)) births.observe(scene.views, now);
  zoomToSelection();
  syncFollow();
  const views = scene.views;
  const i = selection ? scene.slotOf(selection.id) : -1;
  // The ring at the creature as drawn now. Its rays are cast again each frame at that heading against what is drawn (so they turn with the body and end at
  // their hits), once the map's rock is known; until then, and when the page's map design is stale, the latest details' rays at the heading they were sensed at.
  const d = selection?.last;
  const selected = i >= 0 && !selection!.died ? ({ ...(d ?? { rayKinds: new Uint8Array(0), rayCloseness: new Float32Array(0), rayOffsets: new Float32Array(0), plan: { rayLength: 0 } }), alive: true, x: views.x[i]!, y: views.y[i]!, heading: views.heading[i]!, rayHeading: d?.heading } as SelectedDetails) : null;
  if (selected && d && d.plan.rayLength > 0 && draw && hello && (!hello.map.name || (draw.map && !mapStale))) {
    const n = d.rayKinds.length;
    if (rayKinds.length !== n) {
      rayKinds = new Uint8Array(n);
      rayCloseness = new Float32Array(n);
    }
    recastRays({ width: draw.worldW, height: draw.worldH, itemRadius: draw.itemRadius, radius: draw.radius, terrain: draw.map ?? null, items: scene.items, creatures: views, self: i }, selected.x, selected.y, selected.heading, d.rayOffsets, d.plan.rayLength, rayKinds, rayCloseness);
    selected.rayKinds = rayKinds;
    selected.rayCloseness = rayCloseness;
    selected.rayHeading = undefined;
  }
  renderer.draw(ctx, camera, drawConfig(), litViews(views), selected, true, dpr, highlight, births, now, impacts);
  const fade = 1 - (now - revealAt) / REVEAL_FADE_MS;
  if (fade > 0) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = fade * fade;
    if (draw.backdrop?.ready) {
      backdrop.drawFitted(ctx, canvas.width, canvas.height, dpr); // the ground stays: only the creatures and food fade in over it
    } else {
      ctx.fillStyle = BACKGROUND;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.globalAlpha = 1;
  }
  if (now - lastUiAt >= UI_INTERVAL_MS) {
    lastUiAt = now;
    updateSelectedCard();
    updateTimer();
  }
  drawBrain(now);
}

scene.handlers = {
  onEvents: (events) => impacts.add(events, performance.now()),
  onDetail: (d) => onDetail(d.details, d.founderName, d.founderStarter),
};

const link = new LiveLink(url, {
  onState,
  onHello,
  onCreatures(f) {
    gotCreatures = true;
    scene.push(f, performance.now());
  },
  onItems: (f) => scene.setItems(f),
  onDelta: (d) => scene.addDeltas(d),
  onDetail: (d) => scene.addDetail(d),
  onGenome(id, genome) {
    if (selection?.id !== id) return;
    selection.genome = genome;
    buildBrain();
  },
  onStats: (s) => afterReveal(() => onStats(s)),
  onAdd: (r) => addPanel.reply(r),
  onRules: (r) => addPanel.setRules(r),
  onHistory: (h) => afterReveal(() => {
    samples = h.samples.slice();
    lineageHistory = h.lineage.slice();
    showHistory();
  }),
});

function zoomBy(factor: number): void {
  const g = camera.goal;
  camera.animateTo(g.cx, g.cy, g.zoom * factor);
}

camera.attach(canvas);
$("zoomIn").addEventListener("click", () => zoomBy(ZOOM_STEP));
$("zoomOut").addEventListener("click", () => zoomBy(1 / ZOOM_STEP));
$("zoomFit").addEventListener("click", () => {
  pendingFollow = false;
  setFollowing(false);
  camera.follow(null);
  camera.setFocusOffset(0, 0);
  camera.animateToFit();
});
$("worldView").addEventListener("click", () => {
  clearSelection();
  camera.animateToFit();
});
$("follow").addEventListener("click", () => {
  pendingFollow = false;
  if (following) {
    camera.follow(null);
    setFollowing(false);
  } else if (selection && scene.slotOf(selection.id) >= 0) followSelected();
});
$("selFounder").addEventListener("click", () => {
  const f = selection?.last?.founderId;
  if (f !== undefined && f >= 0) lineages.pick(rowOf(f));
});
$("pickAge").addEventListener("click", () => { if (lastStats?.best) select(lastStats.best.age); });
$("pickChildren").addEventListener("click", () => { if (lastStats?.best) select(lastStats.best.children); });
$("pickKills").addEventListener("click", () => { if (lastStats?.best) select(lastStats.best.kills); });

// The visitor's last added copies: when the followed one dies, the page moves on to a living copy and lights its family.
let myCopies: number[] = [];
function followNextCopy(dead: number): void {
  if (!myCopies.includes(dead)) return;
  myCopies = myCopies.filter((i) => i !== dead);
  const next = myCopies.find((i) => scene.slotOf(i) >= 0);
  if (next === undefined) return;
  setTimeout(() => {
    if (selection?.id !== dead || scene.slotOf(next) < 0) return; // the visitor picked something else meanwhile
    select(next);
    highlight = rowOf(next); // a copy's family is counted in its name's row
    lineages.setHighlight(highlight);
    syncFamily();
  }, 1500);
}

// Entry card and "Add your creature". The card shows once a visit; its answer is kept in sessionStorage.
const addPanel = new AddPanel($("addPanel"), {
  send: (req) => link.add(req),
  added(r) {
    addPanel.close();
    $("addPeek").hidden = true;
    myCopies = r.ids.slice();
    const id = r.ids[0]!; // an added creature founds its own lineage: its id is the family's founder
    select(id);
    highlight = rowOf(id);
    lineages.setHighlight(highlight);
    syncFamily();
  },
  minimised: (on) => ($("addPeek").hidden = !on),
});
// The starter creatures for the add panel, fetched once the world shows or the panel opens, so they never hold up the world.
let foundersAsked = false;
function loadFounders(): void {
  if (foundersAsked) return;
  foundersAsked = true;
  void fetch(new URL("../live-founders.json", document.baseURI).href)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => addPanel.setFounders(parseFounders(data)))
    .catch(() => addPanel.setFounders([]));
}
function remember(): void {
  try {
    sessionStorage.setItem(ENTRY_KEY, "1");
  } catch {
    // storage blocked: the card shows again on the next load
  }
}
function openAdd(): void {
  loadFounders();
  $("entry").hidden = true;
  remember();
  addPanel.open();
}
$("entryWatch").addEventListener("click", () => {
  $("entry").hidden = true;
  remember();
  canvas.focus({ preventScroll: true });
});
$("entryAdd").addEventListener("click", openAdd);
$("openAdd").addEventListener("click", openAdd);
$("emptyAdd").addEventListener("click", openAdd);
$("addPeek").addEventListener("click", () => addPanel.open());
let answered = false;
try {
  answered = sessionStorage.getItem(ENTRY_KEY) === "1";
} catch {
  // storage blocked: show the card
}
if (new URLSearchParams(location.search).has("add")) openAdd();
else if (!answered) {
  $("entry").hidden = false;
  $("entryAdd").focus({ preventScroll: true });
}

// The world view fills the window below the banner; the page scrolls on to the info section.
const banner = document.querySelector<HTMLElement>(".banner")!;
new ResizeObserver(() => document.documentElement.style.setProperty("--banner-h", `${banner.offsetHeight}px`)).observe(banner);

new ResizeObserver(() => syncCanvas()).observe(canvas);
link.start();
requestAnimationFrame(frame);
