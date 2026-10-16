import type { EnvSpec } from "../sim/rl/env.ts";
import { envById } from "../sim/rl/envs.ts";
import type { BodyPlan } from "../sim/sensors.ts";
import type { RlInMessage, RlOutMessage } from "../worker/rlProtocol.ts";

// Quick training in the visitor's browser before an add, on the RL Arena's worker (evolution strategies), bounded in time.
// Pretrain: the Trials skills on small rooms (find food, clear a patch, avoid poison). Fine-tune: living among others.
// A run waits while the tab is hidden, and its clock with it.
export type TrainKind = "pretrain" | "finetune";
export const TRAIN_ENVS: Record<TrainKind, readonly string[]> = { pretrain: ["far-food", "patch", "minefield"], finetune: ["crowd", "rivals"] };
export const TRAIN_SECONDS = 30; // per kind
const HELPERS = 3; // helper threads at most: about 50 MB each in Chrome, so a small device keeps its memory
const HIDDEN_MAX_MS = 10 * 60_000; // hidden this long in all (every hidden stretch of the run counts), it ends with its best so far and frees the worker
const OPTIONS = { pairs: 24, sigma: 0.05, lr: 0.02, decay: 0.005, episodes: 1, iterations: 100_000 }; // smaller steps than the Arena: polish, not relearn

export interface TrainProgress {
  kind: TrainKind;
  share: number; // 0 to 1 of the time
  iter: number;
  score: number | null; // the current brain on held-out layouts (mean reward), when known
  start: number | null; // the same before training
}

export interface TrainJob {
  done: Promise<Float32Array | null>; // the best genome on held-out layouts, null when cancelled or nothing beat the start
  cancel(): void;
  readonly stoppedHidden: boolean; // ended by HIDDEN_MAX_MS: the visitor is away, so nothing should follow until they are back
}

// Trains genome for `seconds` of visible-tab time, reporting progress; ends early with the best result so far on cancel.
// Never throws: a worker failure resolves to the latest genome, or null with onError called.
export function train(kind: TrainKind, plan: BodyPlan, genome: Float32Array, onProgress: (p: TrainProgress) => void, onError: (message: string) => void, seconds = TRAIN_SECONDS): TrainJob {
  const envs = TRAIN_ENVS[kind].map(envById).filter((e): e is EnvSpec => e !== undefined);
  let worker: Worker | null = null;
  let latest: Float32Array | null = null; // the best brain seen on held-out layouts, if it beat the start
  let best = -Infinity;
  let start: number | null = null;
  let score: number | null = null;
  let iter = 0;
  let finish: (g: Float32Array | null) => void = () => {};
  const done = new Promise<Float32Array | null>((resolve) => (finish = resolve));
  let used = 0; // visible ms before the current stretch
  let hiddenSince = 0; // start of the current hidden stretch
  let since: number | null = performance.now(); // start of the current visible stretch, null while hidden
  let ticker: ReturnType<typeof setInterval> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let ended = false;
  let hiddenUsed = 0; // hidden ms before the current hidden stretch
  let stoppedHidden = false;
  const onVisibility = (): void => {
    if (ended) return;
    if (document.hidden && since !== null) {
      const now = performance.now();
      used += now - since;
      since = null;
      hiddenSince = now;
      clearTimeout(timer);
      timer = setTimeout(() => {
        stoppedHidden = true;
        end();
      }, Math.max(0, HIDDEN_MAX_MS - hiddenUsed));
      worker?.postMessage({ type: "pause" } satisfies RlInMessage);
    } else if (!document.hidden && since === null) {
      since = performance.now();
      hiddenUsed += since - hiddenSince;
      clearTimeout(timer);
      timer = setTimeout(end, Math.max(0, seconds * 1000 - used));
      worker?.postMessage({ type: "resume" } satisfies RlInMessage);
    }
  };
  const end = (): void => {
    if (ended) return;
    ended = true;
    clearInterval(ticker);
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    worker?.terminate();
    worker = null;
    finish(cancelled ? null : latest);
  };
  const report = (): void => onProgress({ kind, share: Math.min(1, (used + (since === null ? 0 : performance.now() - since)) / (seconds * 1000)), iter, score, start });
  try {
    worker = new Worker(new URL("../worker/rlWorker.ts", import.meta.url), { type: "module" });
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
    queueMicrotask(end);
    return { done, cancel: () => {}, stoppedHidden: false };
  }
  worker.onmessage = (ev: MessageEvent<RlOutMessage>) => {
    const m = ev.data;
    if (m.type === "ready") start = best = score = m.held;
    else if (m.type === "iteration") {
      iter = m.it.iter;
      if (m.it.held !== null) score = m.it.held;
    } else if (m.type === "learner" && score !== null && score > best) {
      best = score; // the learner message follows the held-out check of its iteration
      latest = Float32Array.from(m.learner.genome);
    }
    else if (m.type === "error") {
      onError(m.message);
      end();
    } else if (m.type === "done") end();
  };
  worker.onerror = (e) => {
    e.preventDefault();
    onError(e.message || "the training worker failed");
    end();
  };
  const base = new URL("../", document.baseURI);
  const msg: RlInMessage = {
    type: "start",
    envs: envs.slice(),
    learner: { plan: { ...plan, hiddenLayers: plan.hiddenLayers.slice() }, genome: Array.from(genome) },
    method: "es",
    options: OPTIONS,
    tiles: 1,
    seed: Math.floor(Math.random() * 0x7fffffff),
    poolUrl: new URL("pool.json", base).href,
    libraryUrl: new URL("rl/library.json", base).href,
    playback: false,
    gentle: false,
    helpers: HELPERS,
  };
  worker.postMessage(msg);
  document.addEventListener("visibilitychange", onVisibility);
  ticker = setInterval(report, 250);
  timer = setTimeout(end, seconds * 1000);
  if (document.hidden) onVisibility();
  return {
    done,
    cancel: () => {
      cancelled = true;
      end();
    },
    get stoppedHidden() {
      return stoppedHidden;
    },
  };
}
