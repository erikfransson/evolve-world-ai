import { createRng, deriveSeed } from "../sim/rng.ts";
import type { StatefulRng } from "../sim/rng.ts";
import { loadPool } from "../sim/seedPool.ts";
import type { PoolEntry } from "../sim/seedPool.ts";
import { scoreLearner } from "../sim/rl/env.ts";
import type { EnvSpec, Learner, Library } from "../sim/rl/env.ts";
import { Es } from "../sim/rl/es.ts";
import { parseLibrary, serialiseLearner } from "../sim/rl/library.ts";
import { recordEpisode, recordingBuffers } from "../sim/rl/recording.ts";
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

// Mean reward over the envs, each on the same seeds (so candidates meet the same layouts), and the per-env rewards.
function score(r: Run, genome: Float32Array, seeds: readonly number[], pool: PoolEntry[] | null, library: Library): { mean: number; perEnv: number[] } {
  const perEnv = r.envs.map((env) => scoreLearner(env, { plan: r.plan, genome }, seeds, pool, library).reward);
  return { mean: perEnv.reduce((a, b) => a + b, 0) / perEnv.length, perEnv };
}

function show(r: Run, iter: number, genome: Float32Array, pool: PoolEntry[] | null, library: Library): void {
  const recordings = Array.from({ length: r.tiles }, (_, k) => recordEpisode(r.envs[k % r.envs.length]!, { plan: r.plan, genome }, deriveSeed(iter, k, 0x5404), pool, library, 2, k === 0));
  post({ type: "show", iter, genome, recordings }, recordings.flatMap(recordingBuffers));
}

async function pump(mine: number): Promise<void> {
  const { pool, library } = await assets!;
  while (run && run.token === mine && !paused) {
    const r = run;
    if (r.es.step >= r.options.iterations) {
      post({ type: "learner", iter: r.es.step, learner: serialiseLearner({ plan: r.plan, genome: r.es.theta }) });
      post({ type: "done", iter: r.es.step });
      run = null;
      return;
    }
    const seeds = Array.from({ length: r.options.episodes }, () => r.rng.int(0x5eed0000));
    const candidates = r.es.ask(r.rng);
    const rewards = candidates.map((g) => score(r, g, seeds, pool, library).mean);
    r.es.tell(rewards);
    const iter = r.es.step;
    let best = 0;
    for (let k = 1; k < rewards.length; k++) if (rewards[k]! > rewards[best]!) best = k;
    const held = iter % HELD_EVERY === 0 ? score(r, r.es.theta, HELD_SEEDS, pool, library) : null;
    post({ type: "iteration", it: { iter, train: rewards.reduce((a, b) => a + b, 0) / rewards.length, best: rewards[best]!, held: held?.mean ?? null, perEnv: held?.perEnv ?? null, seconds: (performance.now() - r.t0) / 1000 } });
    if (held) post({ type: "learner", iter, learner: serialiseLearner({ plan: r.plan, genome: r.es.theta }) });
    show(r, iter, candidates[best]!, pool, library);
    await new Promise((done) => setTimeout(done, 0)); // let pause and stop messages in
  }
}

self.onmessage = (e: MessageEvent<RlInMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === "start") {
      if (!msg.envs.length) throw new Error("choose at least one environment");
      const es = new Es(Float32Array.from(msg.learner.genome), msg.options);
      const mine = ++token;
      paused = false;
      const r: Run = { envs: msg.envs, plan: msg.learner.plan, es, options: msg.options, tiles: Math.max(1, Math.min(9, msg.tiles)), rng: createRng(deriveSeed(msg.seed, 0xa7e)), t0: performance.now(), token: mine };
      run = r;
      void loadAssets(msg.poolUrl, msg.libraryUrl)
        .then(({ pool, library }) => {
          if (run?.token !== mine) return;
          const held = score(r, es.theta, HELD_SEEDS, pool, library);
          post({ type: "ready", held: held.mean, perEnv: held.perEnv });
          show(r, 0, es.theta, pool, library);
          return pump(mine);
        })
        .catch((error) => post({ type: "error", message: String(error) }));
    } else if (msg.type === "pause") paused = true;
    else if (msg.type === "resume" && run && paused) {
      paused = false;
      void pump(run.token);
    } else if (msg.type === "stop") {
      run = null;
      token++;
    }
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
