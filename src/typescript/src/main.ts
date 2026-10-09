import "./style.css";
import { DEFAULT_CONFIG } from "./sim/config.ts";
import type { SelectionMethod, SimConfig } from "./sim/config.ts";
import { unpackGenome } from "./sim/protocol.ts";
import type { GenerationMessage } from "./sim/protocol.ts";
import { Episode } from "./sim/episode.ts";
import { drawScene } from "./ui/render.ts";
import type { ViewOptions } from "./ui/render.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("view");
const ctx = canvas.getContext("2d")!;
const note = $("note");
const settings = $<HTMLFieldSetElement>("settings");
const startBtn = $<HTMLButtonElement>("start");
const pauseBtn = $<HTMLButtonElement>("pause");
const resetBtn = $<HTMLButtonElement>("reset");

const num = (id: string): number => $<HTMLInputElement>(id).valueAsNumber;
const clamp = (v: number, lo: number, hi: number, fallback: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

function fillForm(c: SimConfig): void {
  $<HTMLInputElement>("seed").value = String(c.seed);
  $<HTMLInputElement>("worldSize").value = String(c.world.width);
  $<HTMLInputElement>("foodCount").value = String(c.world.foodCount);
  $<HTMLInputElement>("poisonOn").checked = c.world.poisonEnabled;
  $<HTMLInputElement>("poisonCount").value = String(c.world.poisonCount);
  $<HTMLInputElement>("popSize").value = String(c.population.size);
  $<HTMLInputElement>("epochSeconds").value = String(c.population.epochSeconds);
  $<HTMLInputElement>("mutationRate").value = String(c.ga.mutationRate);
  $<HTMLInputElement>("layers").value = String(c.brain.hiddenLayers.length);
  $<HTMLInputElement>("neurons").value = String(c.brain.hiddenLayers[0] ?? 16);
  $<HTMLSelectElement>("selection").value = c.ga.selection;
}

function readConfig(): SimConfig {
  const d = DEFAULT_CONFIG;
  const size = clamp(num("worldSize"), 200, 5000, d.world.width);
  const layers = Math.round(clamp(num("layers"), 1, 4, 1));
  const neurons = Math.round(clamp(num("neurons"), 4, 32, 16));
  return {
    ...d,
    seed: Math.round(clamp(num("seed"), 0, 2 ** 31, d.seed)),
    world: {
      ...d.world,
      width: size,
      height: size,
      foodCount: Math.round(clamp(num("foodCount"), 0, 2000, d.world.foodCount)),
      poisonEnabled: $<HTMLInputElement>("poisonOn").checked,
      poisonCount: Math.round(clamp(num("poisonCount"), 0, 2000, d.world.poisonCount)),
    },
    brain: { hiddenLayers: new Array<number>(layers).fill(neurons) },
    population: {
      size: Math.round(clamp(num("popSize"), 4, 2000, d.population.size)),
      epochSeconds: clamp(num("epochSeconds"), 5, 1000, d.population.epochSeconds),
    },
    ga: {
      ...d.ga,
      selection: $<HTMLSelectElement>("selection").value as SelectionMethod,
      mutationRate: clamp(num("mutationRate"), 0, 1, d.ga.mutationRate),
    },
  };
}

// run state
let worker: Worker | null = null;
let config: SimConfig = DEFAULT_CONFIG;
let running = false;
let paused = false;
let latest: GenerationMessage | null = null;
let latestStats = { bestEver: 0, best: 0, mean: 0, generation: 0 };
let episodes: Episode[] = [];
let bestInEpisodes = 0;
let replayGen = -1;

function view(): ViewOptions {
  return {
    mode: $<HTMLSelectElement>("mode").value as "all" | "best",
    showRays: $<HTMLInputElement>("rays").checked,
    pov: $<HTMLInputElement>("pov").checked,
  };
}

function buildReplay(): void {
  episodes = [];
  if (!latest) return;
  const { result, genomes, genomeLength } = latest;
  const slice = (i: number) => unpackGenome(genomes, genomeLength, i);
  if (view().mode === "best") {
    episodes = [new Episode(config, slice(result.bestIndex), result.layoutSeed, result.bestIndex)];
    bestInEpisodes = 0;
  } else {
    const n = result.fitness.length;
    for (let i = 0; i < n; i++) episodes.push(new Episode(config, slice(i), result.layoutSeed, i));
    bestInEpisodes = result.bestIndex;
  }
  replayGen = result.generation;
  $("statReplay").textContent = String(replayGen);
}

function setStats(): void {
  $("statGen").textContent = running ? String(latestStats.generation) : "-";
  const sec = (v: number) => `${v.toFixed(1)} s`;
  $("statBestEver").textContent = latest ? sec(latestStats.bestEver) : "-";
  $("statBest").textContent = latest ? sec(latestStats.best) : "-";
  $("statMean").textContent = latest ? sec(latestStats.mean) : "-";
  if (!latest) $("statReplay").textContent = "-";
}

function onMessage(e: MessageEvent<GenerationMessage>): void {
  const m = e.data;
  if (m.type !== "generation") return;
  latest = m;
  latestStats = {
    bestEver: m.bestEver,
    best: m.result.bestFitness,
    mean: m.result.meanFitness,
    generation: m.result.generation,
  };
  setStats();
  if (episodes.length === 0) buildReplay();
}

function start(): void {
  config = readConfig();
  fillForm(config);
  latest = null;
  episodes = [];
  running = true;
  paused = false;
  settings.disabled = true;
  startBtn.disabled = true;
  pauseBtn.disabled = false;
  pauseBtn.textContent = "Pause";
  resetBtn.disabled = false;
  worker = new Worker(new URL("./ui/simWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = onMessage;
  worker.postMessage({ type: "start", config });
  setStats();
}

function reset(): void {
  worker?.terminate();
  worker = null;
  running = false;
  paused = false;
  latest = null;
  episodes = [];
  settings.disabled = false;
  startBtn.disabled = false;
  pauseBtn.disabled = true;
  pauseBtn.textContent = "Pause";
  resetBtn.disabled = true;
  config = readConfig();
  setStats();
}

startBtn.onclick = start;
resetBtn.onclick = reset;
pauseBtn.onclick = () => {
  paused = !paused;
  worker?.postMessage({ type: paused ? "pause" : "resume" });
  pauseBtn.textContent = paused ? "Resume" : "Pause";
};
$("mode").onchange = () => buildReplay();

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}
window.addEventListener("resize", resize);

function frame(): void {
  resize();
  const ticks = Number($<HTMLSelectElement>("speed").value);
  if (episodes.length > 0) {
    for (let t = 0; t < ticks; t++) for (const ep of episodes) if (!ep.done) ep.step();
    if (latest && episodes.every((ep) => ep.done)) buildReplay(); // newest generation, looping if no newer one
  }
  drawScene(ctx, config, episodes, bestInEpisodes, view());
  note.textContent = running && !latest ? "Computing generation 0..." : "";
  requestAnimationFrame(frame);
}

fillForm(DEFAULT_CONFIG);
setStats();
resize();
requestAnimationFrame(frame);
