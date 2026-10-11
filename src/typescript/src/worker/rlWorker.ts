import { createRng, deriveSeed } from "../sim/rng.ts";
import { loadPool } from "../sim/seedPool.ts";
import type { PoolEntry } from "../sim/seedPool.ts";
import { scoreLearner } from "../sim/rl/env.ts";
import type { EnvSpec, Learner, Library } from "../sim/rl/env.ts";
import { envById } from "../sim/rl/envs.ts";
import { Es } from "../sim/rl/es.ts";
import { parseLibrary, serialiseLearner } from "../sim/rl/library.ts";
import { recordEpisode, recordingBuffers } from "../sim/rl/recording.ts";
import type { RlInMessage, RlOutMessage } from "./rlProtocol.ts";

// The Arena's training loop: one ES step per pump, the current genome shown on a new layout after each step.
const HELD_SEEDS = Array.from({ length: 8 }, (_, k) => 0x5eed0000 + k); // as rlTrain.ts's first eight
const HELD_EVERY = 5;

const post = (msg: RlOutMessage, transfer: Transferable[] = []): void => self.postMessage(msg, { transfer });

let run: { env: EnvSpec; plan: Learner["plan"]; es: Es; episodes: number; rng: ReturnType<typeof createRng>; t0: number; token: number } | null = null;
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

async function pump(mine: number): Promise<void> {
  const { pool, library } = await assets!;
  while (run && run.token === mine) {
    if (paused) return;
    const r = run;
    const seeds = Array.from({ length: r.episodes }, () => r.rng.int(0x5eed0000));
    const candidates = r.es.ask(r.rng);
    const rewards = candidates.map((genome) => scoreLearner(r.env, { plan: r.plan, genome }, seeds, pool, library).reward);
    r.es.tell(rewards);
    const iter = r.es.step;
    const held = iter % HELD_EVERY === 0 ? scoreLearner(r.env, { plan: r.plan, genome: r.es.theta }, HELD_SEEDS, pool, library).reward : null;
    post({ type: "iteration", it: { iter, train: rewards.reduce((a, b) => a + b, 0) / rewards.length, held, seconds: (performance.now() - r.t0) / 1000 } });
    if (held !== null) post({ type: "learner", iter, learner: serialiseLearner({ plan: r.plan, genome: r.es.theta }) });
    const recording = recordEpisode(r.env, { plan: r.plan, genome: r.es.theta }, deriveSeed(iter, 0x5404), pool, library);
    post({ type: "show", iter, recording }, recordingBuffers(recording));
    await new Promise((done) => setTimeout(done, 0)); // let pause and stop messages in
  }
}

self.onmessage = (e: MessageEvent<RlInMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === "start") {
      const env = envById(msg.env);
      if (!env) throw new Error(`unknown env ${msg.env}`);
      const plan = msg.learner.plan;
      const es = new Es(Float32Array.from(msg.learner.genome), msg.options);
      const mine = ++token;
      paused = false;
      run = { env, plan, es, episodes: msg.options.episodes ?? 1, rng: createRng(deriveSeed(msg.seed, 0xa7e)), t0: performance.now(), token: mine };
      void loadAssets(msg.poolUrl, msg.libraryUrl).then(({ pool, library }) => {
        if (run?.token !== mine) return;
        post({ type: "ready", held: scoreLearner(env, { plan, genome: es.theta }, HELD_SEEDS, pool, library).reward });
        const first = recordEpisode(env, { plan, genome: es.theta }, deriveSeed(0, 0x5404), pool, library);
        post({ type: "show", iter: 0, recording: first }, recordingBuffers(first));
        return pump(mine);
      }).catch((error) => post({ type: "error", message: String(error) }));
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
