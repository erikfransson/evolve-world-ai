import "./base.css";
import "./style.css";
import "./ecosystem.css";
import "./arena.css";
import { loadPool } from "./sim/seedPool.ts";
import type { PoolEntry } from "./sim/seedPool.ts";
import { poolLearner, randomLearner } from "./sim/rl/env.ts";
import type { EnvSpec } from "./sim/rl/env.ts";
import { ENVS } from "./sim/rl/envs.ts";
import { serialiseLearner } from "./sim/rl/library.ts";
import type { StoredLearner } from "./sim/rl/library.ts";
import type { Recording } from "./sim/rl/recording.ts";
import type { RlInMessage, RlIteration, RlOutMessage } from "./worker/rlProtocol.ts";
import { drawArena, frameAt, loopSeconds } from "./ui/arenaScene.ts";
import { ROLE_LABELS, change, planSummary, roleGroup } from "./ui/arenaPick.ts";
import { fitCanvas } from "./ui/canvas.ts";
import { $, durationText } from "./ui/page.ts";
import { RewardGraph } from "./ui/rewardGraph.ts";
import { initTooltips } from "./ui/tooltip.ts";

// public/pool.json and rl/library.json sit at the site root, one level above this page.
const POOL_URL = new URL("../pool.json", document.baseURI).href;
const LIBRARY_URL = new URL("../rl/library.json", document.baseURI).href;

type State = "idle" | "running" | "paused";
let state: State = "idle";
let worker: Worker | null = null;
let pool: PoolEntry[] = [];
let its: RlIteration[] = [];
let start: number | null = null;
let latest: { iter: number; learner: StoredLearner } | null = null;
let envUsed: EnvSpec | null = null;
let fromUsed = "";
let playing: { rec: Recording; iter: number; t0: number } | null = null;
let queued: { rec: Recording; iter: number } | null = null;

const canvas = $<HTMLCanvasElement>("view");
const ctx = canvas.getContext("2d")!;
const graph = new RewardGraph($<HTMLCanvasElement>("graphView"));
const startBtn = $<HTMLButtonElement>("start");
const pauseBtn = $<HTMLButtonElement>("pause");
const resetBtn = $<HTMLButtonElement>("reset");
const downloadBtn = $<HTMLButtonElement>("download");
const envSel = $<HTMLSelectElement>("env");
const founderSel = $<HTMLSelectElement>("founder");
const settings = $<HTMLFieldSetElement>("settings");
const sourceInputs = document.querySelectorAll<HTMLInputElement>("input[name=source]");
const source = (): string => [...sourceInputs].find((i) => i.checked)!.value;
const env = (): EnvSpec => ENVS.find((e) => e.id === envSel.value)!;

function fillEnvs(): void {
  for (const label of ROLE_LABELS) {
    const group = document.createElement("optgroup");
    group.label = label;
    for (const e of ENVS.filter((x) => roleGroup(x) === label)) group.append(new Option(e.name, e.id));
    if (group.children.length) envSel.append(group);
  }
  envSel.addEventListener("change", showEnv);
  showEnv();
}

function showEnv(): void {
  const e = env();
  $("envDesc").textContent = e.description;
  const chips = $("envFacts");
  chips.replaceChildren();
  const add = (text: string, cls = ""): void => {
    const s = document.createElement("span");
    s.textContent = text;
    s.className = cls;
    chips.append(s);
  };
  add(e.role === 1 ? "you play a predator" : "you play prey", "role");
  add(`${e.size[0]}×${e.size[1]}`);
  add(`${e.seconds} s episodes`);
  if (e.rivals.length) add(`${e.rivals.reduce((n, r) => n + r.count, 0)} rivals`);
  for (const t of e.tags) add(t);
}

function fillFounders(): void {
  founderSel.replaceChildren(...pool.map((p, i) => new Option(`#${i + 1}  ·  fitness ${p.fitness.toFixed(0)}`, String(i))));
  $("poolField").hidden = source() !== "pool" || pool.length === 0;
  showPlan();
}

function showPlan(): void {
  const el = $("planDesc");
  if (source() === "random") el.textContent = "A random brain of the default body. Expect a low start and a long climb.";
  else if (pool.length === 0) el.textContent = "The seed pool is not available, pick Random.";
  else {
    const p = pool[Number(founderSel.value)]!;
    el.textContent = `${planSummary(p.plan)}. Trained fitness ${p.fitness.toFixed(0)} s.`;
  }
}

function numberOf(id: string, fallback: number): number {
  const input = $<HTMLInputElement>(id);
  const v = Number(input.value);
  const lo = Number(input.min);
  const hi = Number(input.max);
  const clamped = Number.isFinite(v) && input.value !== "" ? Math.min(hi, Math.max(lo, v)) : fallback;
  input.value = String(clamped);
  return clamped;
}

function begin(): void {
  const e = env();
  const seed = Math.floor(Math.random() * 0x7fffffff);
  let learner;
  if (source() === "pool" && pool.length > 0) {
    const i = Number(founderSel.value);
    learner = poolLearner(e, pool[i]!);
    fromUsed = `pool #${i + 1}`;
  } else {
    learner = randomLearner(e, seed);
    fromUsed = "random";
  }
  envUsed = e;
  its = [];
  start = null;
  latest = null;
  playing = null;
  queued = null;
  worker?.terminate();
  worker = new Worker(new URL("./worker/rlWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<RlOutMessage>) => onMessage(ev.data);
  worker.onerror = (ev) => fail(ev.message);
  const options = { pairs: Math.round(numberOf("pairs", 8)), sigma: numberOf("sigma", 0.04), lr: numberOf("lr", 0.02), episodes: Math.round(numberOf("episodes", 1)) };
  send({ type: "start", env: e.id, learner: serialiseLearner(learner), options, seed, poolUrl: POOL_URL, libraryUrl: LIBRARY_URL });
  $("note").textContent = "Starting…";
  $("note").hidden = false;
  setState("running");
  render();
}

function send(msg: RlInMessage): void {
  worker?.postMessage(msg);
}

function fail(message: string): void {
  worker?.terminate();
  worker = null;
  $("note").textContent = `Training stopped: ${message}`;
  $("note").hidden = false;
  setState("idle");
}

function onMessage(m: RlOutMessage): void {
  if (m.type === "ready") start = m.held;
  else if (m.type === "iteration") its.push(m.it);
  else if (m.type === "learner") latest = { iter: m.iter, learner: m.learner };
  else if (m.type === "show") {
    if (playing) queued = { rec: m.recording, iter: m.iter };
    else playing = { rec: m.recording, iter: m.iter, t0: performance.now() };
    $("note").hidden = true;
  } else if (m.type === "error") return fail(m.message);
  render();
}

function setState(s: State): void {
  state = s;
  startBtn.disabled = s !== "idle";
  pauseBtn.disabled = s === "idle";
  resetBtn.disabled = s === "idle";
  pauseBtn.textContent = s === "paused" ? "Resume" : "Pause";
  settings.disabled = s !== "idle";
}

function reset(): void {
  worker?.terminate();
  worker = null;
  its = [];
  start = null;
  playing = null;
  queued = null;
  setState("idle");
  $("note").textContent = "Pick an environment and a creature, then press Start.";
  $("note").hidden = false;
  $("caption").hidden = true;
  render();
}

function download(): void {
  if (!latest || !envUsed) return;
  const body = JSON.stringify({ env: envUsed.id, from: fromUsed, iter: latest.iter, plan: latest.learner.plan, genome: latest.learner.genome });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  a.download = `${envUsed.id}-iter${latest.iter}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const fixed = (v: number | null): string => (v === null ? "-" : v.toFixed(1));

function render(): void {
  const lastIt = its[its.length - 1];
  $("statIter").textContent = lastIt ? String(lastIt.iter) : "-";
  const heldNow = [...its].reverse().find((i) => i.held !== null)?.held ?? start;
  const held = $("statHeld");
  held.textContent = fixed(heldNow);
  if (heldNow !== null && start !== null) {
    const c = change(heldNow, start);
    const d = document.createElement("span");
    d.className = `delta ${c.dir}`;
    d.textContent = c.text;
    held.append(d);
  }
  $("statStart").textContent = fixed(start);
  $("statTrain").textContent = lastIt ? fixed(lastIt.train) : "-";
  $("statTime").textContent = lastIt ? durationText(lastIt.seconds) : "-";
  downloadBtn.disabled = latest === null;
  $("saveNote").textContent = latest ? `Latest creature: iteration ${latest.iter}, saved every 5 iterations.` : "Train for a while, then download the current creature as JSON.";
  graph.setData(its, start);
}

function draw(now: number): void {
  const dpr = fitCanvas(canvas);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (playing) {
    const elapsed = (now - playing.t0) / 1000;
    if (queued && elapsed >= loopSeconds(playing.rec)) {
      playing = { ...queued, t0: now }; // switch at the next loop start
      queued = null;
    }
  }
  if (playing) {
    const { rec, iter, t0 } = playing;
    const f = frameAt(rec, (now - t0) / 1000);
    drawArena(ctx, rec, f, w, h);
    const r = rec.result;
    const cap = $("caption");
    cap.hidden = false;
    cap.textContent = `iteration ${iter}, food ${r.food}, kills ${r.kills}, alive ${r.seconds.toFixed(0)} s`;
  } else drawArena(ctx, { width: 1, height: 1, dt: 0, frames: 0 } as Recording, 0, w, h);
  requestAnimationFrame(draw);
}

pauseBtn.addEventListener("click", () => {
  if (state === "running") {
    send({ type: "pause" });
    setState("paused");
  } else if (state === "paused") {
    send({ type: "resume" });
    setState("running");
  }
});
startBtn.addEventListener("click", begin);
resetBtn.addEventListener("click", reset);
downloadBtn.addEventListener("click", download);
founderSel.addEventListener("change", showPlan);
sourceInputs.forEach((i) => i.addEventListener("change", fillFounders));
$("setup").addEventListener("submit", (e) => e.preventDefault());

initTooltips($("tooltip"));
fillEnvs();
fillFounders();
render();
requestAnimationFrame(draw);
void loadPool(POOL_URL).then((p) => {
  pool = p ?? [];
  fillFounders();
});
