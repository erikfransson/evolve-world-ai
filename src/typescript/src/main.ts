import "./style.css";
import { DEFAULT_CONFIG, itemCounts } from "./sim/config.ts";
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
const setupForm = $<HTMLFormElement>("setup");

const num = (id: string): number => $<HTMLInputElement>(id).valueAsNumber;
const clamp = (v: number, lo: number, hi: number, fallback: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

// Live value badges and filled slider tracks.
const formats: Record<string, (v: number) => string> = {
  size: (v) => `${v}`,
  deg: (v) => `${v}°`,
  pct: (v) => `${Math.round(v * 100)}%`,
  dens: (v) => v.toFixed(2),
};

function syncSlider(input: HTMLInputElement): void {
  const lo = Number(input.min);
  const hi = Number(input.max);
  input.style.setProperty("--p", `${((input.valueAsNumber - lo) / (hi - lo)) * 100}%`);
  const out = document.querySelector<HTMLOutputElement>(`output[for="${input.id}"]`);
  if (out) out.textContent = (formats[out.dataset.fmt ?? ""] ?? String)(input.valueAsNumber);
}

function syncControls(): void {
  document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(syncSlider);
  syncItemHints();
}

// Resulting item counts for the current width, height and densities.
function syncItemHints(): void {
  const c = itemCounts(readConfig());
  $("foodItems").textContent = `≈ ${c.food} items`;
  $("poisonItems").textContent = `≈ ${c.poison} items`;
}

const radio = (name: string): string =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)!.value;

function fillForm(c: SimConfig): void {
  $<HTMLInputElement>("seed").value = String(c.seed);
  $<HTMLInputElement>("worldWidth").value = String(c.world.width);
  $<HTMLInputElement>("worldHeight").value = String(c.world.height);
  $<HTMLInputElement>("foodDensity").value = String(c.world.foodDensity);
  $<HTMLInputElement>("poisonDensity").value = String(c.world.poisonDensity);
  $<HTMLInputElement>("popSize").value = String(c.population.size);
  $<HTMLInputElement>("respawn").checked = c.world.respawn;
  $<HTMLInputElement>("mutationRate").value = String(c.ga.mutationRate);
  $<HTMLInputElement>("layers").value = String(c.brain.hiddenLayers.length);
  $<HTMLInputElement>("rayCount").value = String(c.creature.rayCount);
  $<HTMLInputElement>("raySpread").value = String(Math.round((c.creature.raySpread * 180) / Math.PI));
  $<HTMLInputElement>("neurons").value = String(c.brain.hiddenLayers[0] ?? 16);
  $<HTMLSelectElement>("selection").value = c.ga.selection;
  syncControls();
}

function readConfig(): SimConfig {
  const d = DEFAULT_CONFIG;
  const layers = Math.round(clamp(num("layers"), 1, 4, 1));
  const neurons = Math.round(clamp(num("neurons"), 4, 32, 16));
  return {
    ...d,
    seed: Math.round(clamp(num("seed"), 0, 2 ** 31, d.seed)),
    world: {
      ...d.world,
      width: clamp(num("worldWidth"), 200, 4000, d.world.width),
      height: clamp(num("worldHeight"), 200, 3000, d.world.height),
      foodDensity: clamp(num("foodDensity"), 0, 1, d.world.foodDensity),
      poisonDensity: clamp(num("poisonDensity"), 0, 1, d.world.poisonDensity),
      respawn: $<HTMLInputElement>("respawn").checked,
    },
    creature: {
      ...d.creature,
      rayCount: Math.round(clamp(num("rayCount"), 1, 16, d.creature.rayCount)),
      raySpread: (clamp(num("raySpread"), 10, 360, 75) * Math.PI) / 180,
    },
    brain: { hiddenLayers: new Array<number>(layers).fill(neurons) },
    population: {
      size: Math.round(clamp(num("popSize"), 4, 2000, d.population.size)),
      epochSeconds: d.population.epochSeconds,
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
let latestStats = { bestEver: 0, best: 0, mean: 0, generation: 0, compute: 0 };
let lastMessageAt = 0;
let episodes: Episode[] = [];
let bestInEpisodes = 0;
let replayGen = -1;

function view(): ViewOptions {
  return {
    mode: $<HTMLInputElement>("showAll").checked ? "all" : "best",
    showRays: $<HTMLInputElement>("rays").checked,
    pov: $<HTMLInputElement>("pov").checked,
  };
}

function buildReplay(): void {
  episodes = [];
  if (!latest) return;
  const { result, genomes, genomeLength } = latest;
  const slice = (i: number) => unpackGenome(genomes, genomeLength, i);
  // Always replay every creature so switching the view never restarts the replay.
  const n = result.fitness.length;
  for (let i = 0; i < n; i++) episodes.push(new Episode(config, slice(i), result.layoutSeed, i));
  bestInEpisodes = result.bestIndex;
  replayGen = result.generation;
  $("statReplay").textContent = String(replayGen);
}

function setStats(): void {
  $("statGen").textContent = running ? String(latestStats.generation) : "-";
  const sec = (id: string, v: number | null): void => {
    const el = $(id);
    el.textContent = v === null ? "-" : v.toFixed(1);
    el.dataset.unit = v === null ? "" : " s"; // unit is drawn by CSS
  };
  sec("statBestEver", latest ? latestStats.bestEver : null);
  sec("statBest", latest ? latestStats.best : null);
  sec("statMean", latest ? latestStats.mean : null);
  sec("statCompute", latest ? latestStats.compute : null);
  if (!latest) $("statReplay").textContent = "-";
}

function onMessage(e: MessageEvent<GenerationMessage>): void {
  const m = e.data;
  if (m.type !== "generation") return;
  latest = m;
  const now = performance.now();
  latestStats = {
    bestEver: m.bestEver,
    best: m.result.bestFitness,
    mean: m.result.meanFitness,
    generation: m.result.generation,
    compute: (now - lastMessageAt) / 1000,
  };
  lastMessageAt = now;
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
  setupForm.classList.add("locked");
  startBtn.disabled = true;
  pauseBtn.disabled = false;
  pauseBtn.textContent = "Pause";
  resetBtn.disabled = false;
  worker = new Worker(new URL("./ui/simWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = onMessage;
  lastMessageAt = performance.now();
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
  setupForm.classList.remove("locked");
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
setupForm.addEventListener("input", (e) => {
  if ((e.target as HTMLInputElement).type === "range") syncSlider(e.target as HTMLInputElement);
  syncItemHints();
});

// Tooltips: one shared fixed bubble, so the scrolling sidebar cannot clip it.
const bubble = $("tooltip");
let tipOwner: HTMLElement | null = null;
function showTip(el: HTMLElement): void {
  tipOwner = el;
  bubble.textContent = el.dataset.tip ?? "";
  bubble.hidden = false;
  const r = el.getBoundingClientRect();
  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
  const below = r.bottom + 8 + h <= window.innerHeight;
  bubble.style.left = `${left}px`;
  bubble.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - 8 - h)}px`;
}
function hideTip(): void {
  tipOwner = null;
  bubble.hidden = true;
}
const tipOf = (t: EventTarget | null): HTMLElement | null => (t as HTMLElement | null)?.closest?.<HTMLElement>(".tip") ?? null;
document.addEventListener("mouseover", (e) => { const t = tipOf(e.target); if (t) showTip(t); });
document.addEventListener("mouseout", (e) => { if (tipOf(e.target)) hideTip(); });
document.addEventListener("focusin", (e) => { const t = tipOf(e.target); if (t) showTip(t); });
document.addEventListener("focusout", (e) => { if (tipOf(e.target)) hideTip(); });
document.addEventListener("click", (e) => {
  const t = tipOf(e.target);
  if (t && t !== tipOwner) showTip(t); // tap on touch
  else if (!t) hideTip();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
document.addEventListener("scroll", () => { if (tipOwner) showTip(tipOwner); }, true);
$("dice").onclick = () => {
  $<HTMLInputElement>("seed").value = String(Math.floor(Math.random() * 1_000_000));
};

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
  const ticks = Number(radio("speed"));
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
