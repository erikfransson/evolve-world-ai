// Fine-tunes one creature in an RL environment (#27) with evolution strategies, on worker threads.
// Usage: node src/rlTrain.ts --env forage-box [--from pool:39 | random:1 | file:path.json] [--iters 60] [--pairs 16] [--sigma 0.04]
//        [--lr 0.02] [--episodes 2] [--eval 16] [--every 10] [--threads 6] [--seed 1] [--out learner.json] [--library public/rl/library.json] [--save]
// Each iteration scores 2 x pairs perturbed genomes on `episodes` fresh seeds; every `every` iterations the current genome is scored
// on `eval` held-out seeds no iteration trains on. --save appends the result to the library under the env id, as a rival for later envs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createRng, deriveSeed } from "./sim/rng.ts";
import { parsePool } from "./sim/seedPool.ts";
import type { PoolEntry } from "./sim/seedPool.ts";
import { poolLearner, randomLearner } from "./sim/rl/env.ts";
import type { EnvSpec, Learner, Library } from "./sim/rl/env.ts";
import { envById } from "./sim/rl/envs.ts";
import { Es } from "./sim/rl/es.ts";
import { parseLibrary, serialiseLearner } from "./sim/rl/library.ts";
import { createNodeRlPool } from "./worker/nodePool.ts";

const EVAL_BASE = 0x5eed0000; // held-out seeds are EVAL_BASE + k; training seeds come from the run seed and never land there

const { values } = parseArgs({
  options: {
    env: { type: "string", default: "forage-box" },
    from: { type: "string", default: "pool:0" },
    iters: { type: "string", default: "60" },
    pairs: { type: "string", default: "16" },
    sigma: { type: "string", default: "0.04" },
    lr: { type: "string", default: "0.02" },
    episodes: { type: "string", default: "2" },
    eval: { type: "string", default: "16" },
    every: { type: "string", default: "10" },
    threads: { type: "string", default: "6" },
    seed: { type: "string", default: "1" },
    pool: { type: "string", default: "public/pool.json" },
    library: { type: "string", default: "public/rl/library.json" },
    out: { type: "string" },
    save: { type: "boolean", default: false },
  },
});

const load = (pool: string, library: string): { pool: PoolEntry[] | null; library: Library } => ({
  pool: existsSync(pool) ? parsePool(JSON.parse(readFileSync(pool, "utf8"))).entries : null,
  library: existsSync(library) ? parseLibrary(JSON.parse(readFileSync(library, "utf8"))) : {},
});

const env = envById(values.env!);
if (!env) {
  console.error(`error: unknown env "${values.env}"`);
  process.exit(1);
}
const num = (k: keyof typeof values): number => Number(values[k]);
const [iters, pairs, episodes, evalCount, every, threads, seed] = (["iters", "pairs", "episodes", "eval", "every", "threads", "seed"] as const).map(num);
const { pool, library } = load(resolve(values.pool!), resolve(values.library!));

const [kind, arg] = values.from!.split(/:(.*)/);
let learner: Learner;
if (kind === "pool" && pool) learner = poolLearner(env, pool[Number(arg)]!);
else if (kind === "random") learner = randomLearner(env, Number(arg ?? 1));
else if (kind === "file") learner = parseLibrary({ version: 1, envs: { x: [JSON.parse(readFileSync(arg!, "utf8"))] } }).x![0]!;
else {
  console.error(`error: --from must be pool:N, random:SEED or file:PATH`);
  process.exit(1);
}

const helpers = createNodeRlPool({ envs: [env], plan: learner.plan, pool, library }, threads);
// Mean reward of each genome over the seeds; every episode is its own job, so threads that drew short lives take more.
const score = async (genomes: Float32Array[], seeds: number[]): Promise<number[]> => {
  const rewards = await helpers.rewards(genomes.flatMap((genome) => seeds.map((seed) => ({ env: 0, genome, seed }))));
  return genomes.map((_, g) => rewards.slice(g * seeds.length, (g + 1) * seeds.length).reduce((a, b) => a + b, 0) / seeds.length);
};
const evalSeeds = Array.from({ length: evalCount }, (_, k) => EVAL_BASE + k);
const scoreHeld = async (genome: Float32Array): Promise<number> => (await score([genome], evalSeeds))[0]!;

const es = new Es(Float32Array.from(learner.genome), { pairs, sigma: num("sigma"), lr: num("lr") });
const rng = createRng(deriveSeed(seed, 0xe5));
const t0 = performance.now();
const start = await scoreHeld(es.theta);
const curve: { iter: number; train: number; held?: number }[] = [{ iter: 0, train: NaN, held: start }];
console.log(`env ${env.id}, from ${values.from}, ${learner.genome.length} weights; held-out ${start.toFixed(3)} on ${evalCount} seeds`);
for (let it = 1; it <= iters; it++) {
  const seeds = Array.from({ length: episodes }, () => rng.int(EVAL_BASE)); // fresh layouts each iteration, so no layout is learned by heart
  const rewards = await score(es.ask(rng), seeds);
  es.tell(rewards);
  const train = rewards.reduce((a, b) => a + b, 0) / rewards.length;
  const point: (typeof curve)[number] = { iter: it, train };
  if (it % every === 0 || it === iters) point.held = await scoreHeld(es.theta);
  curve.push(point);
  if (point.held !== undefined) console.log(`iter ${it}: train mean ${train.toFixed(3)}, held-out ${point.held.toFixed(3)} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
}
helpers.close();
const end = curve[curve.length - 1]!.held!;
const result = { ...serialiseLearner({ plan: learner.plan, genome: es.theta }), env: env.id, from: values.from, heldStart: start, heldEnd: end, iters, curve };
console.log(`held-out ${start.toFixed(3)} -> ${end.toFixed(3)} (${end >= start ? "+" : ""}${(end - start).toFixed(3)}); ${((performance.now() - t0) / 60000).toFixed(1)} min`);
if (values.out) writeFileSync(resolve(values.out), JSON.stringify(result) + "\n");
if (values.save) {
  const path = resolve(values.library!);
  const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, envs: {} };
  (data.envs[env.id] ??= []).push({ ...serialiseLearner({ plan: learner.plan, genome: es.theta }), from: values.from, heldStart: start, heldEnd: end });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data) + "\n");
  console.log(`saved to ${path} under ${env.id} (${data.envs[env.id].length} there)`);
}
