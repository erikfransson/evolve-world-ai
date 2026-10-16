import { readyTerrainOf } from "./sim/terrain.ts";
import "./base.css";
import "./style.css";
import { DEFAULT_CONFIG, itemCounts } from "./sim/config.ts";
import type { SimConfig } from "./sim/config.ts";
import type { Episode } from "./sim/episode.ts";
import { History, captureTop } from "./sim/history.ts";
import { MAX_TRAJECTORIES } from "./sim/trajectory.ts";
import type { GenerationMessage, InMessage, OutMessage } from "./worker/protocol.ts";
import { BrainView } from "./ui/brainView.ts";
import { fitCanvas } from "./ui/canvas.ts";
import { FitnessGraph } from "./ui/fitnessGraph.ts";
import { initCard } from "./ui/overlays.ts";
import { buildPreview } from "./ui/preview.ts";
import { Replay, sourceOfLive, sourceOfPast } from "./ui/replay.ts";
import type { ReplaySource } from "./ui/replay.ts";
import { drawScene } from "./ui/scene.ts";
import { paintTerrainLegend, syncTerrainLegend, terrainLegendHtml } from "./ui/terrainLegend.ts";
import type { ViewOptions } from "./ui/scene.ts";
import { TRIALS_LOCKED, TRIALS_PRESETS, CUSTOM, withTrialsPreset } from "./sim/presets.ts";
import { initRunSession, renderRunControls } from "./ui/runSession.ts";
import { buildForm } from "./ui/settingsForm.ts";
import { TRIALS_FORM } from "./ui/trialsForm.ts";
import { TickClock } from "./ui/tickClock.ts";
import { downloadJson } from "./ui/download.ts";
import { trialsCreatureFile, trialsFileName } from "./ui/trialsSave.ts";
import { $, durationText, formatDuration, setTile } from "./ui/page.ts";
import { initTooltips } from "./ui/tooltip.ts";
import { bindGentle, readGentle } from "./ui/gentle.ts";

const canvas = $<HTMLCanvasElement>("view");
const ctx = canvas.getContext("2d")!;
const note = $("note");
const settings = $<HTMLFieldSetElement>("settings");
const startBtn = $<HTMLButtonElement>("start");
const pauseBtn = $<HTMLButtonElement>("pause");
const resetBtn = $<HTMLButtonElement>("reset");
const skipBtn = $<HTMLButtonElement>("skip");
const saveBtn = $<HTMLButtonElement>("saveBest");
const saveNote = $("saveNote");
const setupForm = $<HTMLFormElement>("setup");
const form = buildForm(settings, TRIALS_FORM);
const { read: readConfig, fill: fillForm } = form;
const legendCard = $("legendCard");
const brainCard = $("brainCard");
const legendRest = $("legendRest");
const legendRestText = $("legendRestText");
const legendPoison = $("legendPoison");
legendCard.querySelector("ul")!.insertAdjacentHTML("beforeend", terrainLegendHtml());
initCard(legendCard, "evolve.card.legend", false);
const brainPanel = initCard(brainCard, "evolve.card.brain", window.matchMedia("(max-width: 700px)").matches);
const brainView = new BrainView($<HTMLCanvasElement>("brainView"));
const replay = new Replay();
let preview: Episode | null = null; // idle-phase world built from the form, rebuilt on change only
const fitnessCard = $("fitnessCard");
const fitnessNote = $("fitnessNote");
const watchLatestBtn = $<HTMLButtonElement>("watchLatest");
initCard(fitnessCard, "evolve.card.fitness", window.matchMedia("(max-width: 700px)").matches);
const history = new History();
const graph = new FitnessGraph($<HTMLCanvasElement>("fitnessView"), requestPast);
let watching: ReplaySource | null = null; // a picked past generation, looped until the newest is asked for again
let pastRequest = 0; // id of the newest request, replies to older ones are dropped
let loadingGeneration: number | null = null;
let pastError: string | null = null; // why the last past replay failed, shown until the next request

interface RunState {
  phase: "idle" | "running" | "paused";
  worker: Worker | null;
  config: SimConfig; // the run's config while active, the form's while idle
  latest: GenerationMessage | null; // newest generation received
  computeSeconds: number; // wall time between the last two generations
  lastMessageAt: number;
  error: string | null; // why the last run stopped, shown until the next start
}
const run: RunState = { phase: "idle", worker: null, config: DEFAULT_CONFIG, latest: null, computeSeconds: 0, lastMessageAt: 0, error: null };

// Updated by change events, not read from the DOM every frame.
const view: ViewOptions = { showAll: true, showRays: true, pov: false };
let replaySpeed = 4; // simulated seconds per real second
const STEP_BUDGET_MS = 6; // replay stepping per frame, beyond it the replay runs slower than asked
const clock = new TickClock(performance.now());
const BRAIN_INTERVAL_MS = 25; // the brain panel is the costliest draw, so it refreshes about every second frame at 60 Hz, so about 30 Hz
let lastBrainAt = 0;

function readView(): void {
  view.showAll = $<HTMLInputElement>("showAll").checked;
  view.showRays = $<HTMLInputElement>("rays").checked;
  view.pov = $<HTMLInputElement>("pov").checked;
  replaySpeed = Number(document.querySelector<HTMLInputElement>('input[name="speed"]:checked')!.value);
  renderOverlays();
}

// Legend rows follow the view and run config, the cards appear once a replay exists.
function renderOverlays(): void {
  legendRest.hidden = !view.showAll;
  legendRestText.textContent = run.config.population.size > MAX_TRAJECTORIES + 1 ? `Top ${MAX_TRAJECTORIES} of the rest` : "Rest of generation";
  legendPoison.hidden = itemCounts(run.config).poison <= 0;
  syncTerrainLegend(run.config);
  paintTerrainLegend(readyTerrainOf(run.config));
  legendCard.hidden = brainCard.hidden = fitnessCard.hidden = replay.best === null;
}

function rebuildPreview(): void {
  preview = run.phase === "idle" ? buildPreview(run.config) : null;
}

function send(msg: InMessage): void {
  run.worker?.postMessage(msg);
}

function renderControls(): void {
  const idle = run.phase === "idle";
  renderRunControls({ start: startBtn, pause: pauseBtn, reset: resetBtn, settings, form: setupForm }, run.phase);
  skipBtn.disabled = saveBtn.disabled = run.latest === null;
  note.textContent = run.error ?? (!idle && run.latest === null ? "Computing generation 0..." : "");
}

function renderFitness(): void {
  graph.setWatched(replay.best ? replay.generation : null);
  watchLatestBtn.hidden = watching === null;
  fitnessNote.textContent = pastError ?? (loadingGeneration !== null ? `Loading gen ${loadingGeneration}...` : watching ? `Watching gen ${watching.generation}` : "");
}

function renderStats(): void {
  const m = run.latest;
  const sec = (id: string, v: number | null): void => {
    const d = v === null ? null : formatDuration(v);
    setTile(id, d && d.text, d?.unit);
  };
  $("statGen").textContent = m ? String(m.result.generation) : run.phase === "idle" ? "-" : "0";
  sec("statBestEver", m && m.bestEver);
  sec("statBest", m && m.result.bestFitness);
  sec("statMean", m && m.result.meanFitness);
  sec("statCompute", m && run.computeSeconds);
  $("statReplay").textContent = replay.best ? String(replay.generation) : "-";
}

function refresh(): void {
  renderControls();
  renderStats();
  renderOverlays();
  renderFitness();
}

// Replays the picked past generation, else the newest received, looping the same one if no newer has arrived.
function loadReplay(): void {
  const source = watching ?? (run.latest ? sourceOfLive(run.latest) : null);
  if (source) replay.load(source, run.config);
  refresh();
}

// Back to following the newest generation.
function watchLatest(): void {
  watching = null;
  loadingGeneration = null;
  pastError = null;
  pastRequest++;
  loadReplay();
}

// The worker re-simulates the kept generation nearest to the clicked one.
function requestPast(generation: number): void {
  const past = history.nearest(generation);
  if (!past || !run.worker) return;
  loadingGeneration = past.generation;
  pastError = null;
  send({ type: "past", request: ++pastRequest, ...past });
  renderFitness();
}

function onMessage(e: MessageEvent<OutMessage>): void {
  if (e.target !== run.worker) return;
  if (e.data.type === "error") {
    reset();
    run.error = `Run stopped: ${e.data.message}`;
    renderControls();
    return;
  }
  if (e.data.type === "pastError") {
    if (e.data.request !== pastRequest) return;
    loadingGeneration = null;
    pastError = `Replay failed: ${e.data.message}`;
    renderFitness();
    return;
  }
  if (e.data.type === "past") {
    if (e.data.request !== pastRequest) return;
    loadingGeneration = null;
    watching = sourceOfPast(e.data);
    loadReplay();
    return;
  }
  const { result } = e.data;
  history.add({ generation: result.generation, best: result.bestFitness, mean: result.meanFitness }, captureTop(result.generation, result.layoutSeed, result.fitness, e.data.genomes, e.data.genomeLength));
  graph.setData(history.stats, history.keptGenerations);
  const now = performance.now();
  run.latest = e.data;
  saveNote.textContent = ""; // it names the generation saved, which is no longer the newest
  session.record(e.data.bestEver);
  run.computeSeconds = (now - run.lastMessageAt) / 1000;
  run.lastMessageAt = now;
  if (replay.best) refresh();
  else loadReplay();
}

// The best creature of the newest generation as a creature file, for the RL Arena's "Start from" and Live's "Add your creature".
function saveBest(): void {
  const m = run.latest;
  if (!m) return;
  downloadJson(trialsFileName(m), trialsCreatureFile(run.config, m));
  saveNote.textContent = `Saved the best of generation ${m.result.generation} (${durationText(m.result.bestFitness)}).`;
}

function clearHistory(): void {
  saveNote.textContent = "";
  history.clear();
  graph.setData([], []);
  watching = null;
  loadingGeneration = null;
  pastError = null;
  pastRequest++;
}

function start(): void {
  run.config = readConfig();
  fillForm(run.config);
  session.begin(run.config); // the run's best survival time goes on the preset's Top 3 as it improves
  run.latest = null;
  run.error = null;
  replay.clear();
  preview = null;
  clearHistory();
  run.phase = "running";
  run.worker = new Worker(new URL("./worker/simWorker.ts", import.meta.url), { type: "module" });
  run.worker.onmessage = onMessage;
  run.lastMessageAt = performance.now();
  send({ type: "start", config: run.config, gentle: readGentle() });
  refresh();
}

function reset(): void {
  run.worker?.terminate();
  run.worker = null;
  run.phase = "idle";
  run.latest = null;
  replay.clear();
  clearHistory();
  run.config = readConfig();
  rebuildPreview();
  refresh();
}

function togglePause(): void {
  run.phase = run.phase === "paused" ? "running" : "paused";
  if (run.phase === "running") run.lastMessageAt = performance.now(); // the pause is not compute time
  send({ type: run.phase === "paused" ? "pause" : "resume" });
  renderControls();
}

// Generation, how long the replayed creature has lived, and the longest life so far.
function replayLabel(ticksAlive: number): string {
  const elapsed = durationText(ticksAlive * run.config.dt);
  const bestEver = run.latest ? ` · best ${durationText(run.latest.bestEver)}` : "";
  return `Generation ${replay.generation} · ${elapsed}${bestEver}`;
}

function frame(now: number): void {
  const dpr = fitCanvas(canvas);
  // Wall time drives the replay so speed is the same at any refresh rate.
  if (replay.best && run.phase !== "paused") {
    replay.advance(clock.advance(now, replaySpeed / run.config.dt), performance.now() + STEP_BUDGET_MS);
    if (run.latest && replay.done) loadReplay();
  } else {
    clock.reset(now);
  }
  const best = replay.best;
  if (best) drawScene(ctx, run.config, best, replay.others, view, replayLabel(best.state.ticksAlive), dpr);
  else if (preview) drawScene(ctx, run.config, preview, [], { showAll: false, showRays: true, pov: false }, "Preview", dpr);
  else drawScene(ctx, run.config, null, [], view, null, dpr);
  if (best && brainPanel.isExpanded() && now - lastBrainAt >= BRAIN_INTERVAL_MS) {
    brainView.draw(best.brain, best.state.alive);
    lastBrainAt = now;
  }
  requestAnimationFrame(frame);
}

startBtn.onclick = start;
resetBtn.onclick = reset;
skipBtn.onclick = watchLatest;
saveBtn.onclick = saveBest;
watchLatestBtn.onclick = watchLatest;
pauseBtn.onclick = togglePause;
bindGentle($<HTMLInputElement>("gentle"), (gentle) => send({ type: "gentle", gentle }));
for (const id of ["showAll", "rays", "pov"]) $(id).addEventListener("change", readView);
document.querySelector(".seg")!.addEventListener("change", readView);
form.init(setupForm, (c) => {
  if (run.phase !== "idle") return;
  run.config = c;
  rebuildPreview();
});
const session = initRunSession({
  mode: "trials",
  container: settings,
  form: setupForm,
  presets: TRIALS_PRESETS,
  locked: TRIALS_LOCKED,
  formatScore: (s) => `${s.toFixed(1)} s`,
  read: readConfig,
  fill: fillForm,
  withPreset: withTrialsPreset,
});
const presets = session.presets;
initTooltips($("tooltip"));

fillForm(DEFAULT_CONFIG);
presets.select("normal");
rebuildPreview();
readView();
refresh();
requestAnimationFrame(frame);
