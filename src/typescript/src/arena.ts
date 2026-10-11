import "./base.css";
import "./style.css";
import "./ecosystem.css";
import "./arena.css";
import { layerSizes, randomGenome } from "./sim/brain.ts";
import { createRng } from "./sim/rng.ts";
import { loadPool } from "./sim/seedPool.ts";
import type { PoolEntry } from "./sim/seedPool.ts";
import { layoutConfig, libraryFits, poolLearner } from "./sim/rl/env.ts";
import type { EnvSpec, Learner, Rivals } from "./sim/rl/env.ts";
import { ENVS } from "./sim/rl/envs.ts";
import { KINDS, MAX_FILE_BYTES, creatureFile, fileLearner, parseCreatureFile } from "./sim/rl/creatureFile.ts";
import type { CreatureFile, CreatureKind } from "./sim/rl/creatureFile.ts";
import { serialiseLearner } from "./sim/rl/library.ts";
import type { StoredLearner } from "./sim/rl/library.ts";
import { planOf, planUpkeep } from "./sim/sensors.ts";
import type { BodyPlan, PlanView } from "./sim/sensors.ts";
import type { RlInMessage, RlIteration, RlOutMessage } from "./worker/rlProtocol.ts";
import { BrainReplay } from "./ui/arenaBrain.ts";
import { DEFAULT_DESIGN, DEFAULT_RUN, DESIGN_FORM, RUN_FORM, designPlan, planDesign } from "./ui/arenaForm.ts";
import { ARENA_KIND, bestFounder, change, customEnv, envsForKind, kindRejection, planSummary } from "./ui/arenaPick.ts";
import { addFavourite, loadFavourites, loadSpeed, removeFavourite, saveSpeed } from "./ui/arenaStore.ts";
import { drawBrainSketch, drawCreaturePreview } from "./ui/creaturePreview.ts";
import { fitCanvas } from "./ui/canvas.ts";
import { DEFAULT_TILES, TILE_COUNTS, TileGrid } from "./ui/arenaTiles.ts";
import { Zoom } from "./ui/arenaZoom.ts";
import { EnvGallery } from "./ui/envGallery.ts";
import { setEnvs, summaryLine, toggleEnv } from "./ui/envSelect.ts";
import type { PreviewIn, PreviewOut } from "./worker/envPreviewWorker.ts";
import { $, durationText } from "./ui/page.ts";
import { buildForm } from "./ui/settingsForm.ts";
import { RewardGraph } from "./ui/rewardGraph.ts";
import { initTooltips } from "./ui/tooltip.ts";

// public/pool.json and rl/library.json sit at the site root, one level above this page.
const POOL_URL = new URL("../pool.json", document.baseURI).href;
const LIBRARY_URL = new URL("../rl/library.json", document.baseURI).href;
const DECAY = 0.005;

type RunState = "idle" | "running" | "paused";
type Source = "design" | "pool" | "import" | "saved";

let state: RunState = "idle";
let worker: Worker | null = null;
let pool: PoolEntry[] = [];
let imported: CreatureFile | null = null;
let favourites: CreatureFile[] = [];
const customs: EnvSpec[] = [];
const DEFAULT_ENV = "nibble";
let picked = new Set<string>();
let seeded = false; // the default env is picked once, so Clear all can leave none
let customCount = 0;

// The run in progress or just finished.
interface Run {
  kind: CreatureKind;
  envs: EnvSpec[];
  plan: BodyPlan;
  from: string;
  iterations: number;
  its: RlIteration[];
  startHeld: number | null;
  startPerEnv: number[] | null;
  latest: { iter: number; learner: StoredLearner } | null;
  nextEnvs: EnvSpec[] | null; // sent while paused; they become envs when the worker confirms with "rebased", so earlier shows keep their names
}
let run: Run | null = null;

const grid = new TileGrid($("tiles"));
const zoom = new Zoom(grid, $("zoom"), { canvas: $<HTMLCanvasElement>("zoomCanvas"), title: $("zoomTitle"), stats: $("zoomStats") }, $("zoomClose"));
const brainReplay = new BrainReplay($<HTMLCanvasElement>("brainView"));
const graph = new RewardGraph($<HTMLCanvasElement>("rewardView"));
const startBtn = $<HTMLButtonElement>("start");
const pauseBtn = $<HTMLButtonElement>("pause");
const resetBtn = $<HTMLButtonElement>("reset");
const settings = $<HTMLFieldSetElement>("settings");
const envSettings = $<HTMLFieldSetElement>("envSettings");
const runSettings = $<HTMLFieldSetElement>("runSettings");

const radio = (name: string): string => document.querySelector<HTMLInputElement>(`input[name=${name}]:checked`)!.value;
const kind = (): CreatureKind => ARENA_KIND;
const source = (): Source => radio("source") as Source;
const input = (id: string): HTMLInputElement => $<HTMLInputElement>(id);

const worldConfig = (k: CreatureKind) => layoutConfig(KINDS[k].world);

// ---- creature

const designForm = buildForm($("designForm"), DESIGN_FORM);
const runForm = buildForm($("runForm"), RUN_FORM);
const fillDesign = (plan: BodyPlan): void => designForm.fill(planDesign(plan));

// The creature to start from, or the reason there is none.
function resolveStart(): { learner: Learner; from: string } | string {
  const k = kind();
  const world = KINDS[k].world;
  const src = source();
  if (src === "design") {
    const plan = designPlan(designForm.read());
    const rng = createRng((Math.random() * 2 ** 31) | 0);
    return { learner: { plan, genome: randomGenome(layerSizes(worldConfig(k), plan), rng) }, from: "designed" };
  }
  if (src === "pool") {
    const entry = pool[Number(input("founder").value)];
    return entry ? { learner: poolLearner({ world }, entry), from: `pool #${Number(input("founder").value) + 1}` } : "The seed pool is not available.";
  }
  const file = src === "import" ? imported : favourites[Number(input("saved").value)];
  if (!file) return src === "import" ? "Choose a creature file." : "No creature saved in this browser yet.";
  const rejected = kindRejection(file.kind);
  if (rejected) return rejected;
  return { learner: fileLearner(file), from: src === "import" ? `file ${file.name}` : `saved ${file.name}` };
}

function showStart(): void {
  const k = kind();
  $("kindDesc").textContent = KINDS[k].label;
  for (const s of ["pool", "import", "saved"]) $(`src${s[0]!.toUpperCase()}${s.slice(1)}`).hidden = source() !== s;
  $("designForm").hidden = source() !== "design";
  const r = resolveStart();
  const note = $("startNote");
  const desc = $("planDesc");
  if (typeof r === "string") {
    note.textContent = r;
    desc.textContent = "";
    preview = null;
  } else {
    note.textContent = selectedEnvs().length === 0 ? "Pick at least one environment." : "";
    const plan = r.learner.plan;
    preview = plan;
    desc.textContent = `${planSummary(plan)}. Upkeep ${planUpkeep(plan, worldConfig(k)).toFixed(2)} energy per second: a bigger body and brain cost more to keep alive.`;
  }
  updateStartButton();
  drawPreview();
}

// The creature preview shows the plan about to start, only while no run is on screen.
let preview: PlanView | null = null;
function drawPreview(): void {
  const card = $("previewCard");
  card.hidden = run !== null || preview === null;
  if (card.hidden || !preview) return;
  const plan = preview;
  const paint = (id: string, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void => {
    const canvas = $<HTMLCanvasElement>(id);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = fitCanvas(canvas);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, w, h);
  };
  const sizes = layerSizes(worldConfig(kind()), plan);
  paint("previewView", (ctx, w, h) => drawCreaturePreview(ctx, plan, w, h));
  paint("previewBrain", (ctx, w, h) => drawBrainSketch(ctx, sizes, w, h));
  const deg = Math.round((plan.raySpread * 180) / Math.PI);
  $("previewStats").textContent = `${plan.rayCount} ray${plan.rayCount === 1 ? "" : "s"} over ${deg}°, sight ${Math.round(plan.rayLength)} (room 200 x 200, creature radius 12). Upkeep ${planUpkeep(plan, worldConfig(kind())).toFixed(2)} energy per second.`;
  $("previewBrainText").textContent = `Brain: ${sizes[0]} inputs, hidden ${plan.hiddenLayers.join(" + ") || "none"}, ${sizes[sizes.length - 1]} outputs (turn, thrust, ${plan.memoryShort + plan.memoryLong} memory).`;
}
window.addEventListener("resize", drawPreview);

function fillFounders(): void {
  const sel = $<HTMLSelectElement>("founder");
  sel.replaceChildren(...pool.map((p, i) => new Option(`#${i + 1} · ${p.plan.rayCount} rays, hidden ${p.plan.hiddenLayers.join("+")} · fitness ${p.fitness.toFixed(0)}`, String(i))));
  if (pool.length) sel.value = String(bestFounder(pool)); // the strongest founder shows learning soonest
  showStart();
}

function fillSaved(): void {
  favourites = loadFavourites();
  const sel = $<HTMLSelectElement>("saved");
  sel.replaceChildren(...favourites.map((f, i) => new Option(`${f.name} (${f.kind})`, String(i)))); // Option text, never HTML
  showStart();
}

async function importFile(): Promise<void> {
  const file = input("importFile").files?.[0];
  const msg = $("importMsg");
  imported = null;
  msg.className = "msg";
  if (!file) {
    msg.textContent = "";
  } else if (file.size > MAX_FILE_BYTES) {
    msg.className = "msg error";
    msg.textContent = "file too large";
  } else {
    const parsed = parseCreatureFile(await file.text());
    const bad = typeof parsed === "string" ? parsed : kindRejection(parsed.kind);
    if (bad || typeof parsed === "string") {
      msg.className = "msg error";
      msg.textContent = bad ?? "";
    } else {
      imported = parsed;
      msg.textContent = parsed.name;
    }
  }
  showStart();
}

// ---- environments

const allEnvs = (): EnvSpec[] => envsForKind([...ENVS, ...customs], kind());

function pick(next: Set<string>): void {
  picked = next;
  gallery.sync(picked);
  showStart();
}

const gallery = new EnvGallery($("gallery"), {
  toggle: (id) => pick(toggleEnv(picked, id)),
  setMany: (ids, on) => pick(setEnvs(picked, ids, on)),
  remove: (id) => {
    customs.splice(customs.findIndex((e) => e.id === id), 1);
    picked.delete(id);
    showEnvs();
    showStart();
  },
});

// Clips are recorded by a worker, once per env id, as soon as the page loads and whenever a custom env is added.
const previewWorker = new Worker(new URL("./worker/envPreviewWorker.ts", import.meta.url), { type: "module" });
const requested = new Set<string>();
previewWorker.onmessage = (ev: MessageEvent<PreviewOut>) => {
  if (ev.data.type === "clip") gallery.setClip(ev.data.id, ev.data.rec);
  else console.warn("env preview failed", ev.data.id, ev.data.message);
};
function requestClips(envs: readonly EnvSpec[]): void {
  const fresh = envs.filter((e) => !requested.has(e.id));
  for (const e of fresh) requested.add(e.id);
  if (fresh.length) previewWorker.postMessage({ type: "record", envs: fresh, poolUrl: POOL_URL, libraryUrl: LIBRARY_URL } satisfies PreviewIn);
}

function showEnvs(): void {
  const list = allEnvs();
  if (!seeded) {
    seeded = true;
    picked.add((list.find((e) => e.id === DEFAULT_ENV) ?? list[0])?.id ?? "");
  }
  gallery.setEnvs(list, picked);
  requestClips(list);
  updateStartButton();
}

// The gallery shows unless a run is going; while paused or finished it folds, so the tiles stay in view.
function showGallery(): void {
  $("gallery").hidden = state === "running";
  gallery.setCompact(run !== null);
  gallery.play(state !== "running");
  $("viewrow").hidden = run === null && state === "idle";
}

const selectedEnvs = (): EnvSpec[] => allEnvs().filter((e) => picked.has(e.id));

function addRivalRow(r: Rivals = { species: 0, count: 2, source: "random" }): void {
  const hunt = KINDS[kind()].world === "hunt";
  const row = document.createElement("div");
  row.className = "rival";
  const sp = document.createElement("select");
  sp.ariaLabel = "Rival species";
  sp.append(new Option("prey", "0"));
  if (hunt) sp.append(new Option("predators", "1"));
  sp.value = String(r.species);
  const count = document.createElement("input");
  count.type = "number";
  count.min = "0";
  count.max = "30";
  count.value = String(r.count);
  count.ariaLabel = "Rival count";
  const src = document.createElement("select");
  src.ariaLabel = "Rival brains";
  // Only creatures trained as this world's foragers fit a forager rival slot (same input layout and species).
  const { world, role } = KINDS[kind()];
  src.append(
    new Option("random brains", "random"),
    new Option("seed pool", "pool"),
    new Option("copies of itself", "self"),
    ...ENVS.filter((e) => libraryFits(e.id, world, role)).map((e) => new Option(`trained in ${e.name}`, `library:${e.id}`)),
  );
  src.value = r.source;
  const del = document.createElement("button");
  del.type = "button";
  del.className = "env-del";
  del.textContent = "×";
  del.title = "Remove";
  del.addEventListener("click", () => row.remove());
  row.append(sp, count, src, del);
  $("rivals").append(row);
}

function customForm() {
  const val = (id: string): number => Number(input(id).value);
  const opt = (id: string): number | null => (input(id).value.trim() === "" ? null : Number(input(id).value));
  const rivals: Rivals[] = [...$("rivals").children].map((row) => {
    const [sp, count, src] = row.querySelectorAll<HTMLInputElement | HTMLSelectElement>("select, input");
    return { species: Number(sp!.value), count: Number(count!.value), source: src!.value as Rivals["source"] };
  });
  return {
    name: input("cName").value,
    width: val("cWidth"),
    height: val("cHeight"),
    food: val("cFood"),
    poison: val("cPoison"),
    regrow: val("cRegrow"),
    seconds: val("cSeconds"),
    rivals,
    reward: { food: opt("rFood"), kill: opt("rKill"), survive: opt("rSurvive"), energy: opt("rEnergy") },
  };
}

function checkCustom(): EnvSpec | string {
  return customEnv(customForm(), `custom-${customCount + 1}`, kind());
}

function showCustom(): void {
  const r = checkCustom();
  $("customMsg").textContent = typeof r === "string" ? r : "";
  $<HTMLButtonElement>("addCustom").disabled = typeof r === "string";
}

function addCustom(): void {
  const r = checkCustom();
  if (typeof r === "string") return;
  customCount++;
  customs.push(r);
  picked = new Set(picked).add(r.id);
  showEnvs();
  showStart();
}

// ---- running

function updateStartButton(): void {
  const n = selectedEnvs().length;
  $("envSummary").textContent = summaryLine(n);
  $("envSummary").classList.toggle("warn", n === 0);
  const blocked = typeof resolveStart() === "string" || selectedEnvs().length === 0;
  startBtn.disabled = state !== "idle" || blocked;
  if (state === "paused") pauseBtn.disabled = selectedEnvs().length === 0; // Resume needs an env
  $("legendRival").hidden = !(run?.envs ?? selectedEnvs()).some((e) => e.rivals.some((r) => r.count > 0));
}

function setState(s: RunState): void {
  state = s;
  pauseBtn.disabled = s === "idle";
  resetBtn.disabled = run === null;
  pauseBtn.textContent = s === "paused" ? "Resume" : "Pause";
  settings.disabled = runSettings.disabled = s !== "idle";
  envSettings.disabled = s === "running"; // envs can change while paused, and apply on Resume
  grid.paused = s === "paused";
  showGallery();
  updateStartButton();
}

function send(msg: RlInMessage): void {
  worker?.postMessage(msg);
}

function begin(): void {
  const start = resolveStart();
  const envs = selectedEnvs();
  if (typeof start === "string" || envs.length === 0) return;
  const cfg = runForm.read();
  const tiles = Number(cfg.tiles);
  const options = { pairs: Math.round(cfg.population / 2), sigma: cfg.sigma, lr: cfg.lr, decay: DECAY, episodes: cfg.episodes, iterations: cfg.iterations };
  const seed = Math.floor(Math.random() * 0x7fffffff);
  run = { kind: kind(), envs, plan: { ...start.learner.plan, hiddenLayers: start.learner.plan.hiddenLayers.slice() }, from: start.from, iterations: options.iterations, its: [], startHeld: null, startPerEnv: null, latest: null, nextEnvs: null };
  worker?.terminate();
  worker = new Worker(new URL("./worker/rlWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<RlOutMessage>) => onMessage(ev.data);
  worker.onerror = (ev) => {
    console.error("RL Arena worker error", ev.error ?? ev);
    fail(ev.message || "the training worker crashed (details in the browser console)");
  };
  grid.setCount(TILE_COUNTS.includes(tiles as 1) ? tiles : DEFAULT_TILES);
  zoom.close();
  grid.clear();
  brainReplay.reset();
  send({ type: "start", envs, learner: serialiseLearner(start.learner), options, tiles: grid.size, seed, poolUrl: POOL_URL, libraryUrl: LIBRARY_URL });
  $("note").textContent = "Starting…";
  $("note").hidden = false;
  setState("running");
  drawPreview();
  render();
}

function fail(message: string): void {
  worker?.terminate();
  worker = null;
  $("note").textContent = `Training stopped: ${message}`;
  $("note").hidden = false;
  setState("idle");
}

function onMessage(m: RlOutMessage): void {
  if (!run) return;
  if (m.type === "ready") {
    run.startHeld = m.held;
    run.startPerEnv = m.perEnv;
  } else if (m.type === "rebased") {
    // The envs changed: held-out values now refer to the new set, so its start is the reference from here on, and the
    // re-measured value is the latest held-out point (so the stats and table never compare across env sets).
    run.envs = run.nextEnvs ?? run.envs;
    run.nextEnvs = null;
    run.startHeld = m.held;
    run.startPerEnv = m.perEnv;
    const last = run.its[run.its.length - 1];
    run.its.push({ iter: m.iter, train: last?.train ?? m.held, best: last?.best ?? m.held, held: m.held, perEnv: m.perEnv, seconds: last?.seconds ?? 0 });
  } else if (m.type === "iteration") run.its.push(m.it);
  else if (m.type === "learner") run.latest = { iter: m.iter, learner: m.learner };
  else if (m.type === "show") {
    grid.show({ iter: m.iter, genome: m.genome, recordings: m.recordings, names: m.recordings.map((_, k) => run!.envs[k % run!.envs.length]!.name), envCount: run.envs.length }, performance.now());
    $("note").hidden = true;
  } else if (m.type === "done") setState("idle");
  else if (m.type === "error") return fail(m.message);
  render();
}

function reset(): void {
  worker?.terminate();
  worker = null;
  run = null;
  zoom.close();
  grid.clear();
  brainReplay.reset();
  $("note").textContent = "Design or pick a creature, choose environments, then press Start.";
  $("note").hidden = false;
  setState("idle");
  drawPreview();
  render();
}

const fixed = (v: number | null | undefined): string => (v === null || v === undefined ? "-" : v.toFixed(1));
function lastHeld(r: Run): RlIteration | undefined {
  for (let i = r.its.length - 1; i >= 0; i--) if (r.its[i]!.held !== null) return r.its[i];
  return undefined;
}

function render(): void {
  const r = run;
  const last = r?.its[r.its.length - 1];
  $("iterNow").textContent = String(last?.iter ?? 0);
  $("iterTotal").textContent = r ? String(r.iterations) : String(runForm.read().iterations);
  $("iterFill").style.width = r && r.iterations > 0 ? `${Math.min(100, ((last?.iter ?? 0) / r.iterations) * 100)}%` : "0%";
  const heldIt = r ? lastHeld(r) : undefined;
  const heldNow = heldIt?.held ?? r?.startHeld ?? null;
  const held = $("statHeld");
  held.textContent = fixed(heldNow);
  if (heldNow !== null && r?.startHeld != null) {
    const c = change(heldNow, r.startHeld);
    held.append(Object.assign(document.createElement("span"), { className: `delta ${c.dir}`, textContent: c.text }));
  }
  $("statStart").textContent = fixed(r?.startHeld);
  $("statBest").textContent = fixed(last?.best);
  $("statTrain").textContent = fixed(last?.train);
  $("statTime").textContent = last ? durationText(last.seconds) : "-";
  graph.setData(r?.its ?? [], r?.startHeld ?? null);
  renderTable(r, heldIt);
  const canSave = !!r?.latest;
  $<HTMLButtonElement>("saveFile").disabled = !canSave;
  $<HTMLButtonElement>("saveBrowser").disabled = !canSave;
}

function renderTable(r: Run | null, heldIt: RlIteration | undefined): void {
  const table = $("envTable");
  const body = table.querySelector("tbody")!;
  table.hidden = !r?.startPerEnv || r.envs.length < 2;
  body.replaceChildren();
  if (table.hidden || !r) return;
  r.envs.forEach((e, k) => {
    const row = body.insertRow();
    const start = r.startPerEnv![k]!;
    const now = heldIt?.perEnv?.[k] ?? start;
    const c = change(now, start);
    row.insertCell().textContent = e.name;
    row.insertCell().textContent = start.toFixed(1);
    row.insertCell().textContent = now.toFixed(1);
    const cell = row.insertCell();
    cell.textContent = c.text;
    cell.className = c.dir;
  });
}

// ---- saving

function currentFile(): CreatureFile | null {
  if (!run?.latest) return null;
  const heldIt = lastHeld(run);
  const learner: Learner = { plan: run.latest.learner.plan, genome: Float32Array.from(run.latest.learner.genome) };
  return creatureFile(run.kind, input("saveName").value, learner, {
    envs: run.envs.map((e) => e.id),
    iterations: run.latest.iter,
    from: run.from,
    heldStart: run.startHeld,
    heldEnd: heldIt?.held ?? null,
    date: new Date().toISOString().slice(0, 10),
  });
}

function saveFile(): void {
  const f = currentFile();
  if (!f) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(f)], { type: "application/json" }));
  a.download = `${f.name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "creature"}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000); // revoking at once can cancel the download in some browsers
  $("saveMsg").textContent = `Saved ${f.name} at iteration ${f.training.iterations}.`;
}

function saveBrowser(): void {
  const f = currentFile();
  if (!f) return;
  const ok = addFavourite(f);
  $("saveMsg").textContent = ok ? `Kept ${f.name} in this browser (up to 20).` : "This browser would not store it. Use Save creature instead.";
  fillSaved();
}

// ---- frame loop

function draw(now: number): void {
  const shown = grid.draw(now);
  const on = input("brainOn").checked;
  if (on && shown && run && grid.current) {
    brainReplay.setGenome(run.envs[0]!, run.plan, grid.current.genome);
    brainReplay.draw(shown.rec, shown.frame);
  }
  requestAnimationFrame(draw);
}

// ---- wiring

pauseBtn.addEventListener("click", () => {
  if (state === "running") {
    send({ type: "pause" });
    setState("paused");
  } else if (state === "paused") {
    const envs = selectedEnvs();
    if (!envs.length) return;
    if (run && envs.map((e) => e.id).join() !== (run.nextEnvs ?? run.envs).map((e) => e.id).join()) {
      run.nextEnvs = envs;
      send({ type: "envs", envs });
    }
    send({ type: "resume" });
    setState("running");
  }
});
startBtn.addEventListener("click", begin);
resetBtn.addEventListener("click", reset);
$("saveFile").addEventListener("click", saveFile);
$("saveBrowser").addEventListener("click", saveBrowser);
$("unsave").addEventListener("click", () => {
  removeFavourite(Number(input("saved").value));
  fillSaved();
});
$("importFile").addEventListener("change", () => void importFile());
$("founder").addEventListener("change", showStart);
$("saved").addEventListener("change", showStart);
designForm.init($<HTMLFormElement>("setup"), showStart);
runForm.init($<HTMLFormElement>("setup"), () => render());
document.querySelectorAll<HTMLInputElement>("input[name=source]").forEach((el) => el.addEventListener("change", showStart));
$("customBox").addEventListener("input", showCustom);
$("customBox").addEventListener("change", showCustom);
$("addRival").addEventListener("click", () => {
  if ($("rivals").children.length < 4) addRivalRow();
  showCustom();
});
$("addCustom").addEventListener("click", addCustom);
$("brainOn").addEventListener("change", () => {
  $("brainCard").hidden = !input("brainOn").checked;
  brainReplay.reset();
});
const speedRadios = document.querySelectorAll<HTMLInputElement>("input[name=speed]");
const speed = loadSpeed();
grid.speed = speed;
speedRadios.forEach((el) => {
  el.checked = Number(el.value) === speed;
  el.addEventListener("change", () => {
    grid.speed = Number(el.value);
    saveSpeed(grid.speed);
  });
});
grid.onOpen = (k) => zoom.open(k);
grid.onFinished = () => {
  if (state !== "idle") send({ type: "show" }); // the tiles played to the end: ask for the next best candidate
};

initTooltips($("tooltip"));
designForm.fill(DEFAULT_DESIGN);
runForm.fill(DEFAULT_RUN);
grid.setCount(DEFAULT_TILES);
fillSaved();
showEnvs();
showCustom();
render();
setState("idle");
requestAnimationFrame(draw);
void loadPool(POOL_URL).then((p) => {
  pool = p ?? [];
  fillFounders();
});
