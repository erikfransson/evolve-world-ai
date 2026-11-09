import type { EnvSpec } from "../sim/rl/env.ts";
import { RECOMMENDED_MIX, envById } from "../sim/rl/envs.ts";
import { TRAIN_TIERS, TRAIN_TIERS_TRAINED } from "../sim/rl/trainTiers.ts";
import type { TrainTier } from "../sim/rl/trainTiers.ts";
import type { BodyPlan } from "../sim/sensors.ts";
import type { RlInMessage, RlOutMessage } from "../worker/rlProtocol.ts";

// Quick training in the visitor's browser before an add, on the RL Arena's worker, bounded in time and by a tier (Light, Medium, Strong).
// A fresh brain trains with PPO on the tier's recipe (sim/rl/trainTiers.ts). A founder's or a file's brain gets the gentler PPO recipe of
// TRAIN_TIERS_TRAINED (same seconds), and the page keeps the trained brain only if it beats the start on a re-score (heldScore below).
// A run waits while the tab is hidden, and its clock with it.
export { TRAIN_TIERS };
export type { TrainTier };
export const DEFAULT_TIER = "light";
export type TrainKind = "pretrain" | "finetune" | "tier";
export interface LivePhase {
  kind: TrainKind;
  envs: readonly string[];
  seconds: number; // of this phase
  cap?: number; // episode length cap in seconds
  method: "es" | "backprop";
  backprop?: { lr: number; episodes: number };
  es?: Partial<typeof ES_OPTIONS>; // the tier phase's own ES settings over ES_OPTIONS
}
export const tierById = (id: string): TrainTier => TRAIN_TIERS.find((t) => t.id === id) ?? TRAIN_TIERS[0]!;

// The tier a start mode follows: a fresh brain the tier itself, a founder's or a file's brain the trained-start tier of the same id.
export const tierFor = (fresh: boolean, tier: TrainTier): TrainTier => (fresh ? tier : TRAIN_TIERS_TRAINED.find((t) => t.id === tier.id) ?? tier);

// The phases a start mode trains in.
export function phasesFor(fresh: boolean, tier: TrainTier): LivePhase[] {
  const t = tierFor(fresh, tier);
  return t.phases.map((p) => ({ kind: "tier" as const, envs: p.envs, seconds: t.seconds * p.share, cap: p.seconds, method: p.method, backprop: p.backprop, es: p.es }));
}

// Envs longer than the cap become copies of the cap's length, held-out checks included (as rlTiers.ts does).
export function cappedEnvs(ids: readonly string[], cap?: number): EnvSpec[] {
  return ids.map(envById).filter((e): e is EnvSpec => e !== undefined).map((e) => (cap && e.seconds > cap ? { ...e, id: `${e.id}-${cap}`, seconds: cap } : e));
}

// Seconds of the whole run still to go, after `before` seconds of earlier phases and `share` of this phase.
export const secondsLeft = (total: number, before: number, phase: number, share: number): number => Math.max(0, Math.ceil(total - before - share * phase));

const HELPERS = 3; // helper threads at most: about 50 MB each in Chrome, so a small device keeps its memory
const HIDDEN_MAX_MS = 10 * 60_000; // hidden this long in all (every hidden stretch of the run counts), it ends with its best so far and frees the worker
const SCORE_MAX_MS = 120_000; // a re-score (32 seeds x 8 envs, about 8 times the start score) has this long, sized for a slow phone
const START_MAX_MS = 60_000; // the worker has this long to load its assets and score the start brain; the training clock starts after that
const ES_OPTIONS = { pairs: 24, sigma: 0.05, lr: 0.02, decay: 0.005, episodes: 1, iterations: 100_000 }; // smaller steps than the Arena: polish, not relearn

export interface TrainProgress {
  kind: TrainKind;
  share: number; // 0 to 1 of the time; 0 while the worker still loads
  starting: boolean; // the worker has not scored the start brain yet, so the clock has not started
  poolMissing: boolean; // the seed pool did not load: the live-* and league rivals are random brains
  iter: number;
  score: number | null; // the current brain on held-out layouts (mean reward), when known
  start: number | null; // the same before training
}

export interface TrainJob {
  done: Promise<Float32Array | null>; // the best genome on held-out layouts, null when cancelled or nothing beat the start
  cancel(): void;
  readonly stoppedHidden: boolean; // ended by HIDDEN_MAX_MS: the visitor is away, so nothing should follow until they are back
}

// Trains genome for `seconds` of visible-tab time after the worker is ready, reporting progress; ends early with the best result so far on cancel.
// Never throws: a worker failure resolves to the latest genome, or null with onError called.
export function train(phase: LivePhase, plan: BodyPlan, genome: Float32Array, onProgress: (p: TrainProgress) => void, onError: (message: string) => void, seconds = phase.seconds): TrainJob {
  const kind = phase.kind;
  const envs = cappedEnvs(phase.envs, phase.cap);
  let worker: Worker | null = null;
  let latest: Float32Array | null = null; // the best brain seen on held-out layouts, if it beat the start
  let best = -Infinity;
  let start: number | null = null;
  let score: number | null = null;
  let iter = 0;
  let poolMissing = false;
  let finish: (g: Float32Array | null) => void = () => {};
  const done = new Promise<Float32Array | null>((resolve) => (finish = resolve));
  let started = false; // the worker sent "ready": loading is over and the clock runs
  let used = 0; // visible ms before the current stretch
  let hiddenSince = 0; // start of the current hidden stretch
  let since: number | null = null; // start of the current visible stretch, null while hidden or before the start
  let ticker: ReturnType<typeof setInterval> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let ended = false;
  let hiddenUsed = 0; // hidden ms before the current hidden stretch
  let stoppedHidden = false;
  const onVisibility = (): void => {
    if (ended) return;
    if (!started) {
      worker?.postMessage({ type: document.hidden ? "pause" : "resume" } satisfies RlInMessage);
      return;
    }
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
  // The worker has loaded its assets and scored the start brain: the clock starts here, so a cold start-up does not eat the tier's seconds.
  const begin = (): void => {
    started = true;
    clearTimeout(timer);
    if (document.hidden) {
      since = null; // hidden already: start the hidden stretch, the visible clock waits
      hiddenSince = performance.now();
      timer = setTimeout(() => {
        stoppedHidden = true;
        end();
      }, HIDDEN_MAX_MS);
      worker?.postMessage({ type: "pause" } satisfies RlInMessage);
    } else {
      since = performance.now();
      timer = setTimeout(end, seconds * 1000);
    }
  };
  const report = (): void => onProgress({ kind, share: !started ? 0 : Math.min(1, (used + (since === null ? 0 : performance.now() - since)) / (seconds * 1000)), starting: !started, poolMissing, iter, score, start });
  try {
    worker = new Worker(new URL("../worker/rlWorker.ts", import.meta.url), { type: "module" });
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
    queueMicrotask(end);
    return { done, cancel: () => {}, stoppedHidden: false };
  }
  worker.onmessage = (ev: MessageEvent<RlOutMessage>) => {
    const m = ev.data;
    if (m.type === "ready") {
      start = best = score = m.held;
      poolMissing = m.poolMissing === true;
      if (!started && !ended) begin();
    } else if (m.type === "iteration") {
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
  const backprop = phase.method === "backprop" && phase.backprop ? { backprop: phase.backprop } : {};
  const msg: RlInMessage = {
    type: "start",
    envs,
    learner: { plan: { ...plan, hiddenLayers: plan.hiddenLayers.slice() }, genome: Array.from(genome) },
    method: phase.method,
    options: { ...ES_OPTIONS, ...phase.es, ...backprop }, // RlRunOptions still carries the ES fields; PPO reads options.backprop
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
  timer = setTimeout(() => { // a worker that never gets ready ends the run with nothing
    onError("the training worker did not start in time");
    end();
  }, START_MAX_MS);
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

export interface ScoreJob {
  done: Promise<number | null>; // null when it failed, timed out, was cancelled, or the tab is hidden
  cancel(): void;
}

// The re-score of a brain: its mean reward on `seeds` held-out seeds per env of the uncapped recommended mix, as the worker's "ready" of a
// 0-iteration run (poison costs 1 per bite). Its own worker, ended on every path; a hidden tab does not stop it (the worker cannot pause
// its start score). null when the seed pool is missing: the rivals would differ from the start's score.
export function heldScore(plan: BodyPlan, genome: Float32Array, seeds: number): ScoreJob {
  let worker: Worker | null = null;
  let finish: (v: number | null) => void = () => {};
  const done = new Promise<number | null>((resolve) => (finish = resolve));
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = (v: number | null): void => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    worker?.terminate();
    worker = null;
    finish(v);
  };
  try {
    worker = new Worker(new URL("../worker/rlWorker.ts", import.meta.url), { type: "module" });
  } catch {
    queueMicrotask(() => end(null));
    return { done, cancel: () => {} };
  }
  worker.onmessage = (ev: MessageEvent<RlOutMessage>) => {
    const m = ev.data;
    if (m.type === "ready") end(Number.isFinite(m.held) && m.poolMissing !== true ? m.held : null);
    else if (m.type === "error" || m.type === "done") end(null);
  };
  worker.onerror = (e) => {
    e.preventDefault();
    end(null);
  };
  const base = new URL("../", document.baseURI);
  const msg: RlInMessage = {
    type: "start",
    envs: RECOMMENDED_MIX.map(envById).filter((e): e is EnvSpec => e !== undefined),
    learner: { plan: { ...plan, hiddenLayers: plan.hiddenLayers.slice() }, genome: Array.from(genome) },
    method: "es",
    options: { ...ES_OPTIONS, iterations: 0 },
    held: seeds,
    tiles: 1,
    seed: 1,
    poolUrl: new URL("pool.json", base).href,
    libraryUrl: new URL("rl/library.json", base).href,
    playback: false,
    gentle: false,
    helpers: HELPERS,
  };
  worker.postMessage(msg);
  timer = setTimeout(() => end(null), SCORE_MAX_MS);
  return { done, cancel: () => end(null) };
}
