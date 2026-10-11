// Fine-tunes one creature in an RL environment (#27) with evolution strategies, on worker threads.
// Usage: node src/rlTrain.ts --env forage-box [--from pool:39 | random:1 | file:creature.json] [--iters 60] [--pairs 16] [--sigma 0.04]
//        [--lr 0.02] [--episodes 2] [--eval 16] [--every 10] [--threads 6] [--seed 1] [--out learner.json] [--library public/rl/library.json] [--save]
// Each iteration scores 2 x pairs perturbed genomes on `episodes` fresh seeds; every `every` iterations the current genome is scored
// on `eval` held-out seeds no iteration trains on. --save appends the result to the library under the env id, as a rival for later envs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parsePool } from "./sim/seedPool.ts";
import type { PoolEntry } from "./sim/seedPool.ts";
import { poolLearner, randomLearner } from "./sim/rl/env.ts";
import type { Learner, Library } from "./sim/rl/env.ts";
import { envById } from "./sim/rl/envs.ts";
import { KINDS, fileLearner, parseCreatureFile } from "./sim/rl/creatureFile.ts";
import { Trainer, heldSeeds } from "./sim/rl/trainer.ts";
import { parseLibrary, serialiseLearner } from "./sim/rl/library.ts";
import { createNodeRlPool } from "./worker/nodePool.ts";


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
  library: parseLibrary(existsSync(library) ? JSON.parse(readFileSync(library, "utf8")) : null),
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
else if (kind === "file") {
  // A creature file (Arena "Save"), checked like any outside data.
  const file = parseCreatureFile(readFileSync(arg!, "utf8"));
  if (typeof file === "string" || KINDS[file.kind].world !== env.world || KINDS[file.kind].role !== env.role) {
    console.error(`error: ${arg}: ${typeof file === "string" ? file : `a ${file.kind} cannot train in ${env.id}`}`);
    process.exit(1);
  }
  learner = fileLearner(file);
}
else {
  console.error(`error: --from must be pool:N, random:SEED or file:PATH`);
  process.exit(1);
}

const helpers = createNodeRlPool({ envs: [env], plan: learner.plan, pool, library }, threads);
const trainer = new Trainer(Float32Array.from(learner.genome), { pairs, sigma: num("sigma"), lr: num("lr") }, helpers, 1, episodes, seed);
const evalSeeds = heldSeeds(evalCount);
const t0 = performance.now();
const start = (await trainer.held(evalSeeds)).mean;
const curve: { iter: number; train: number; held?: number }[] = [{ iter: 0, train: NaN, held: start }];
console.log(`env ${env.id}, from ${values.from}, ${learner.genome.length} weights; held-out ${start.toFixed(3)} on ${evalCount} seeds`);
while (trainer.iter < iters) {
  const step = await trainer.step();
  const point: (typeof curve)[number] = { iter: step.iter, train: step.train };
  if (step.iter % every === 0 || step.iter === iters) point.held = (await trainer.held(evalSeeds)).mean;
  curve.push(point);
  if (point.held !== undefined) console.log(`iter ${step.iter}: train mean ${step.train.toFixed(3)}, held-out ${point.held.toFixed(3)} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
}
const es = trainer.es;
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
