import "./style.css";
import { DEFAULT_CONFIG, itemCounts } from "./sim/config.ts";
import type { SimConfig } from "./sim/config.ts";
import type { GenerationMessage, InMessage } from "./worker/protocol.ts";
import { BrainView } from "./ui/brainView.ts";
import { fitCanvas } from "./ui/canvas.ts";
import { initCard } from "./ui/overlays.ts";
import { Replay } from "./ui/replay.ts";
import { drawScene } from "./ui/scene.ts";
import type { ViewOptions } from "./ui/scene.ts";
import { fillForm, initSettingsForm, readConfig } from "./ui/settingsForm.ts";
import { initTooltips } from "./ui/tooltip.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("view");
const ctx = canvas.getContext("2d")!;
const note = $("note");
const settings = $<HTMLFieldSetElement>("settings");
const startBtn = $<HTMLButtonElement>("start");
const pauseBtn = $<HTMLButtonElement>("pause");
const resetBtn = $<HTMLButtonElement>("reset");
const skipBtn = $<HTMLButtonElement>("skip");
const setupForm = $<HTMLFormElement>("setup");
const legendCard = $("legendCard");
const brainCard = $("brainCard");
const legendRest = $("legendRest");
const legendPoison = $("legendPoison");
initCard(legendCard, "evolve.card.legend", false);
const brainPanel = initCard(brainCard, "evolve.card.brain", window.matchMedia("(max-width: 700px)").matches);
const brainView = new BrainView($<HTMLCanvasElement>("brainView"));
const replay = new Replay();

interface RunState {
  phase: "idle" | "running" | "paused";
  worker: Worker | null;
  config: SimConfig; // the run's config while active, the form's while idle
  latest: GenerationMessage | null; // newest generation received
  computeSeconds: number; // wall time between the last two generations
  lastMessageAt: number;
}
const run: RunState = { phase: "idle", worker: null, config: DEFAULT_CONFIG, latest: null, computeSeconds: 0, lastMessageAt: 0 };

// Updated by change events, not read from the DOM every frame.
const view: ViewOptions = { showAll: true, showRays: true, pov: false };
let ticksPerFrame = 4;

function readView(): void {
  view.showAll = $<HTMLInputElement>("showAll").checked;
  view.showRays = $<HTMLInputElement>("rays").checked;
  view.pov = $<HTMLInputElement>("pov").checked;
  ticksPerFrame = Number(document.querySelector<HTMLInputElement>('input[name="speed"]:checked')!.value);
  renderOverlays();
}

// Legend rows follow the view and run config, the cards appear once a replay exists.
function renderOverlays(): void {
  legendRest.hidden = !view.showAll;
  legendPoison.hidden = itemCounts(run.config).poison <= 0;
  legendCard.hidden = brainCard.hidden = replay.best === null;
}

function send(msg: InMessage): void {
  run.worker?.postMessage(msg);
}

function renderControls(): void {
  const idle = run.phase === "idle";
  startBtn.disabled = !idle;
  pauseBtn.disabled = idle;
  pauseBtn.textContent = run.phase === "paused" ? "Resume" : "Pause";
  resetBtn.disabled = idle;
  skipBtn.disabled = run.latest === null;
  settings.disabled = !idle;
  setupForm.classList.toggle("locked", !idle);
  note.textContent = !idle && run.latest === null ? "Computing generation 0..." : "";
  legendCard.hidden = brainCard.hidden = replay.best === null;
}

function renderStats(): void {
  const m = run.latest;
  const sec = (id: string, v: number | null): void => {
    const el = $(id);
    el.textContent = v === null ? "-" : v.toFixed(1);
    el.dataset.unit = v === null ? "" : " s"; // unit is drawn by CSS
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
}

// Replays the newest generation received, looping the same one if no newer has arrived.
function loadReplay(): void {
  if (run.latest) replay.load(run.latest, run.config);
  refresh();
}

function onMessage(e: MessageEvent<GenerationMessage>): void {
  if (e.target !== run.worker) return;
  const now = performance.now();
  run.latest = e.data;
  run.computeSeconds = (now - run.lastMessageAt) / 1000;
  run.lastMessageAt = now;
  if (replay.best) refresh();
  else loadReplay();
}

function start(): void {
  run.config = readConfig();
  fillForm(run.config);
  run.latest = null;
  replay.clear();
  run.phase = "running";
  run.worker = new Worker(new URL("./worker/simWorker.ts", import.meta.url), { type: "module" });
  run.worker.onmessage = onMessage;
  run.lastMessageAt = performance.now();
  send({ type: "start", config: run.config });
  refresh();
}

function reset(): void {
  run.worker?.terminate();
  run.worker = null;
  run.phase = "idle";
  run.latest = null;
  replay.clear();
  run.config = readConfig();
  refresh();
}

function togglePause(): void {
  run.phase = run.phase === "paused" ? "running" : "paused";
  if (run.phase === "running") run.lastMessageAt = performance.now(); // the pause is not compute time
  send({ type: run.phase === "paused" ? "pause" : "resume" });
  renderControls();
}

function frame(): void {
  fitCanvas(canvas);
  if (replay.best && run.phase !== "paused") {
    replay.advance(ticksPerFrame);
    if (run.latest && replay.done) loadReplay();
  }
  drawScene(ctx, run.config, replay.episodes, replay.bestIndex, view);
  const best = replay.best;
  if (best && brainPanel.isExpanded()) brainView.draw(best.brain, best.state.alive);
  requestAnimationFrame(frame);
}

startBtn.onclick = start;
resetBtn.onclick = reset;
skipBtn.onclick = loadReplay;
pauseBtn.onclick = togglePause;
for (const id of ["showAll", "rays", "pov"]) $(id).addEventListener("change", readView);
document.querySelector(".seg")!.addEventListener("change", readView);
initSettingsForm(setupForm, (c) => { if (run.phase === "idle") run.config = c; });
initTooltips($("tooltip"));

fillForm(DEFAULT_CONFIG);
readView();
refresh();
requestAnimationFrame(frame);
