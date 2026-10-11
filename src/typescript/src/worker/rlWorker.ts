import { createRng, deriveSeed } from "../sim/rng.ts";
import type { StatefulRng } from "../sim/rng.ts";
import { loadPool } from "../sim/seedPool.ts";
import type { PoolEntry } from "../sim/seedPool.ts";
import type { EnvSpec, Learner, Library } from "../sim/rl/env.ts";
import { Es } from "../sim/rl/es.ts";
import { parseLibrary, serialiseLearner } from "../sim/rl/library.ts";
import { recordingBuffers } from "../sim/rl/recording.ts";
import { createBrowserRlPool } from "./browserPool.ts";
import type { RlPool } from "./rlPool.ts";
import type { RlInMessage, RlOutMessage, RlRunOptions } from "./rlProtocol.ts";

// The Arena's training loop: one ES step per pump over all chosen envs, then the step's best candidate is shown on fresh layouts.
const HELD_SEEDS = Array.from({ length: 4 }, (_, k) => 0x5eed0000 + k); // per env; as rlTrain.ts's first four
const HELD_EVERY = 5;

const post = (msg: RlOutMessage, transfer: Transferable[] = []): void => self.postMessage(msg, { transfer });

interface Run {
  envs: EnvSpec[];
  plan: Learner["plan"];
  es: Es;
  options: RlRunOptions;
  tiles: number;
  rng: StatefulRng;
  helpers: RlPool; // plays the episodes on nested workers, or here when there are none
  t0: number;
  token: number;
}
let run: Run | null = null;
let paused = false;
let token = 0;
let assets: Promise<{ pool: PoolEntry[] | null; library: Library }> | undefined;

// Fetched once per page from the URLs of the first start; a missing library leaves the league rivals random.
const loadAssets = (poolUrl: string, libraryUrl: string): Promise<{ pool: PoolEntry[] | null; library: Library }> =>
  (assets ??= Promise.all([
    loadPool(poolUrl),
    fetch(libraryUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then(parseLibrary)
      .catch((): Library => ({})),
  ]).then(([pool, library]) => ({ pool, library })));

// Mean reward over the envs of each genome, each env on the same seeds (so candidates meet the same layouts), and the per-env rewards.
// Sums seed by seed as scoreLearner does, so the numbers do not depend on the thread count.
async function score(r: Run, genomes: readonly Float32Array[], seeds: readonly number[]): Promise<{ mean: number; perEnv: number[] }[]> {
  const tasks = genomes.flatMap((genome) => r.envs.flatMap((_, env) => seeds.map((seed) => ({ env, genome, seed }))));
  const rewards = await r.helpers.rewards(tasks);
  return genomes.map((_, g) => {
    const perEnv = r.envs.map((_, e) => {
      let sum = 0;
      for (let s = 0; s < seeds.length; s++) sum += rewards[(g * r.envs.length + e) * seeds.length + s]! / seeds.length;
      return sum;
    });
    return { mean: perEnv.reduce((a, b) => a + b, 0) / perEnv.length, perEnv };
  });
}

async function show(r: Run, iter: number, genome: Float32Array): Promise<void> {
  const tasks = Array.from({ length: r.tiles }, (_, k) => ({ env: k % r.envs.length, genome, seed: deriveSeed(iter, k, 0x5404) }));
  const recordings = await r.helpers.recordings(tasks, 2, (k) => k === 0);
  post({ type: "show", iter, genome, recordings }, recordings.flatMap(recordingBuffers));
}

let pumping = -1; // token of the pump that is running, so a resume during an iteration does not start a second one

async function pump(mine: number): Promise<void> {
  if (pumping === mine) return;
  pumping = mine;
  try {
    while (run && run.token === mine && !paused) {
      const r = run;
      if (r.es.step >= r.options.iterations) {
        post({ type: "learner", iter: r.es.step, learner: serialiseLearner({ plan: r.plan, genome: r.es.theta }) });
        post({ type: "done", iter: r.es.step });
        endRun();
        return;
      }
      const seeds = Array.from({ length: r.options.episodes }, () => r.rng.int(0x5eed0000));
      const candidates = r.es.ask(r.rng);
      const rewards = (await score(r, candidates, seeds)).map((s) => s.mean);
      r.es.tell(rewards);
      const iter = r.es.step;
      let best = 0;
      for (let k = 1; k < rewards.length; k++) if (rewards[k]! > rewards[best]!) best = k;
      const held = iter % HELD_EVERY === 0 ? (await score(r, [r.es.theta], HELD_SEEDS))[0]! : null;
      post({ type: "iteration", it: { iter, train: rewards.reduce((a, b) => a + b, 0) / rewards.length, best: rewards[best]!, held: held?.mean ?? null, perEnv: held?.perEnv ?? null, seconds: (performance.now() - r.t0) / 1000 } });
      if (held) post({ type: "learner", iter, learner: serialiseLearner({ plan: r.plan, genome: r.es.theta }) });
      await show(r, iter, candidates[best]!);
      await new Promise((done) => setTimeout(done, 0)); // let pause and stop messages in
    }
  } finally {
    if (pumping === mine) pumping = -1;
  }
}

function endRun(): void {
  run?.helpers.close();
  run = null;
}

self.onmessage = (e: MessageEvent<RlInMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === "start") {
      if (!msg.envs.length) throw new Error("choose at least one environment");
      endRun();
      const mine = ++token;
      paused = false;
      void loadAssets(msg.poolUrl, msg.libraryUrl)
        .then(async ({ pool, library }) => {
          if (token !== mine) return;
          const es = new Es(Float32Array.from(msg.learner.genome), msg.options);
          const helpers = createBrowserRlPool({ envs: msg.envs, plan: msg.learner.plan, pool, library });
          const r: Run = { envs: msg.envs, plan: msg.learner.plan, es, options: msg.options, tiles: Math.max(1, Math.min(9, msg.tiles)), rng: createRng(deriveSeed(msg.seed, 0xa7e)), helpers, t0: performance.now(), token: mine };
          run = r;
          const held = (await score(r, [es.theta], HELD_SEEDS))[0]!;
          post({ type: "ready", held: held.mean, perEnv: held.perEnv });
          await show(r, 0, es.theta);
          return pump(mine);
        })
        .catch((error) => {
          if (token === mine) post({ type: "error", message: String(error) });
        });
    } else if (msg.type === "pause") paused = true;
    else if (msg.type === "resume" && run && paused) {
      paused = false;
      void pump(run.token);
    } else if (msg.type === "stop") {
      endRun();
      token++;
    }
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
