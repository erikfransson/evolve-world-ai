import { deriveSeed } from "../sim/rng.ts";
import { loadPool } from "../sim/seedPool.ts";
import type { PoolEntry } from "../sim/seedPool.ts";
import type { EnvSpec, Library } from "../sim/rl/env.ts";
import { parseLibrary, serialiseLearner } from "../sim/rl/library.ts";
import { recordingBuffers } from "../sim/rl/recording.ts";
import { Trainer, heldSeeds } from "../sim/rl/trainer.ts";
import { createBrowserRlPool } from "./browserPool.ts";
import type { RlPool } from "./rlPool.ts";
import type { RlInMessage, RlOutMessage } from "./rlProtocol.ts";

// The Arena's training loop: one ES step at a time over all chosen envs, then the step's best candidate is shown on fresh layouts.
const HELD_SEEDS = heldSeeds(4); // per env
const HELD_EVERY = 5;

const post = (msg: RlOutMessage, transfer: Transferable[] = []): void => self.postMessage(msg, { transfer });

let token = 0; // the current run's; a newer start or a stop ends the older loop at its next check
let helpers: RlPool | null = null;
let resumeGate: { wait: Promise<void>; open: () => void } | null = null; // set while paused
let showWanted = false;
let nextEnvs: EnvSpec[] | null = null; // envs to switch to at the next step, sent while paused // the page asked for a new show; steps run much faster than the page plays them
let assets: Promise<{ pool: PoolEntry[] | null; library: Library }> | undefined;

// Fetched once per page from the URLs of the first start; a missing library leaves the league rivals random.
const loadAssets = (poolUrl: string, libraryUrl: string): Promise<{ pool: PoolEntry[] | null; library: Library }> =>
  (assets ??= Promise.all([
    loadPool(poolUrl),
    fetch(libraryUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then(parseLibrary)
      .catch((): Library => parseLibrary(null)),
  ]).then(([pool, library]) => ({ pool, library })));

async function show(pool: RlPool, envs: readonly EnvSpec[], tiles: number, iter: number, genome: Float32Array): Promise<void> {
  const tasks = Array.from({ length: tiles }, (_, k) => ({ env: k % envs.length, genome, seed: deriveSeed(iter, k, 0x5404) }));
  const recordings = await pool.recordings(tasks, 2, (k) => k === 0);
  post({ type: "show", iter, genome, recordings }, recordings.flatMap(recordingBuffers));
}

// One run from start to done; a pause waits at the gate between steps, and any error ends here and reaches the page.
async function train(msg: Extract<RlInMessage, { type: "start" }>, mine: number): Promise<void> {
  const { pool, library } = await loadAssets(msg.poolUrl, msg.libraryUrl);
  if (token !== mine) return;
  let envs = msg.envs;
  let helpersHere = (helpers = createBrowserRlPool({ envs, plan: msg.learner.plan, pool, library }));
  const plan = msg.learner.plan;
  const tiles = Math.max(1, Math.min(12, msg.tiles));
  const trainer = new Trainer(Float32Array.from(msg.learner.genome), msg.options, helpersHere, msg.envs.length, msg.options.episodes, msg.seed);
  const t0 = performance.now();
  let lastBest: Float32Array | null = null; // the latest step's best candidate
  const start = await trainer.held(HELD_SEEDS);
  post({ type: "ready", held: start.mean, perEnv: start.perEnv });
  await show(helpersHere, envs, tiles, 0, trainer.es.theta);
  while (token === mine && trainer.iter < msg.options.iterations) {
    if (resumeGate) await resumeGate.wait;
    if (token !== mine) return;
    if (nextEnvs) {
      // New helpers for the new envs; the held-out reference restarts there, so before and after compare on the same worlds.
      envs = nextEnvs;
      nextEnvs = null;
      helpersHere.close();
      helpersHere = helpers = createBrowserRlPool({ envs, plan, pool, library });
      trainer.setEnvs(helpersHere, envs.length);
      const held = await trainer.held(HELD_SEEDS);
      post({ type: "rebased", iter: trainer.iter, held: held.mean, perEnv: held.perEnv });
      showWanted = true;
    }
    const step = await trainer.step();
    lastBest = step.bestGenome;
    const held = step.iter % HELD_EVERY === 0 ? await trainer.held(HELD_SEEDS) : null;
    post({ type: "iteration", it: { iter: step.iter, train: step.train, best: step.best, held: held?.mean ?? null, perEnv: held?.perEnv ?? null, seconds: (performance.now() - t0) / 1000 } });
    if (held) post({ type: "learner", iter: step.iter, learner: serialiseLearner({ plan, genome: trainer.es.theta }) });
    if (showWanted) {
      showWanted = false;
      await show(helpersHere, envs, tiles, step.iter, step.bestGenome);
    }
    await new Promise((done) => setTimeout(done, 0)); // let pause and stop messages in
  }
  if (token !== mine) return;
  if (lastBest) await show(helpersHere, envs, tiles, trainer.iter, lastBest); // so the tiles end on the trained creature
  if (token !== mine) return;
  post({ type: "learner", iter: trainer.iter, learner: serialiseLearner({ plan, genome: trainer.es.theta }) });
  post({ type: "done", iter: trainer.iter });
  endRun();
}

function endRun(): void {
  helpers?.close();
  helpers = null;
  resumeGate?.open();
  resumeGate = null;
}

self.onmessage = (e: MessageEvent<RlInMessage>) => {
  const msg = e.data;
  if (msg.type === "start") {
    endRun();
    const mine = ++token;
    showWanted = false;
    nextEnvs = null;
    if (!msg.envs.length) return post({ type: "error", message: "choose at least one environment" });
    train(msg, mine).catch((error) => {
      if (token !== mine) return;
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
      endRun();
    });
  } else if (msg.type === "show") showWanted = true;
  else if (msg.type === "envs" && msg.envs.length) nextEnvs = msg.envs;
  else if (msg.type === "pause" && !resumeGate) {
    let open = (): void => {};
    const wait = new Promise<void>((done) => (open = done));
    resumeGate = { wait, open };
  } else if (msg.type === "resume" && resumeGate) {
    resumeGate.open();
    resumeGate = null;
  } else if (msg.type === "stop") {
    token++;
    endRun();
  }
};
