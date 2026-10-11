// Fine-tunes one creature in an RL environment (#27) with evolution strategies, on worker threads.
// Usage: node src/rlTrain.ts --env forage-box [--from pool:39 | random:1 | file:path.json] [--iters 60] [--pairs 16] [--sigma 0.04]
//        [--lr 0.02] [--episodes 2] [--eval 16] [--every 10] [--threads 6] [--seed 1] [--out learner.json] [--library public/rl/library.json] [--save]
// Each iteration scores 2 x pairs perturbed genomes on `episodes` fresh seeds; every `every` iterations the current genome is scored
// on `eval` held-out seeds no iteration trains on. --save appends the result to the library under the env id, as a rival for later envs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createRng, deriveSeed } from "./sim/rng.ts";
import { parsePool } from "./sim/seedPool.ts";
import type { PoolEntry } from "./sim/seedPool.ts";
import { poolLearner, randomLearner, runEpisode } from "./sim/rl/env.ts";
import type { EnvSpec, Learner, Library } from "./sim/rl/env.ts";
import { envById } from "./sim/rl/envs.ts";
import { Es } from "./sim/rl/es.ts";
import { parseLibrary, serialiseLearner } from "./sim/rl/library.ts";

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

interface Setup {
  env: string;
  plan: Learner["plan"];
  pool: string;
  library: string;
}
interface Job {
  id: number;
  genomes: Float32Array[];
  seeds: number[];
}

const load = (s: Setup): { env: EnvSpec; pool: PoolEntry[] | null; library: Library } => ({
  env: envById(s.env)!,
  pool: existsSync(s.pool) ? parsePool(JSON.parse(readFileSync(s.pool, "utf8"))).entries : null,
  library: existsSync(s.library) ? parseLibrary(JSON.parse(readFileSync(s.library, "utf8"))) : {},
});

if (!isMainThread) {
  const setup = workerData as Setup;
  const { env, pool, library } = load(setup);
  parentPort!.on("message", (job: Job) => {
    const rewards = job.genomes.map((genome) => {
      let sum = 0;
      for (const s of job.seeds) sum += runEpisode(env, { plan: setup.plan, genome }, s, pool, library).reward;
      return sum / job.seeds.length;
    });
    parentPort!.postMessage({ id: job.id, rewards });
  });
} else {
  const env = envById(values.env!);
  if (!env) {
    console.error(`error: unknown env "${values.env}"`);
    process.exit(1);
  }
  const num = (k: keyof typeof values): number => Number(values[k]);
  const [iters, pairs, episodes, evalCount, every, threads, seed] = (["iters", "pairs", "episodes", "eval", "every", "threads", "seed"] as const).map(num);
  const setupBase = { env: env.id, pool: resolve(values.pool!), library: resolve(values.library!) };
  const { pool, library } = load({ ...setupBase, plan: { rayCount: 1, raySpread: 0, rayLength: 1, hiddenLayers: [1], memoryShort: 0, memoryLong: 0 } });

  const [kind, arg] = values.from!.split(/:(.*)/);
  let learner: Learner;
  if (kind === "pool" && pool) learner = poolLearner(env, pool[Number(arg)]!);
  else if (kind === "random") learner = randomLearner(env, Number(arg ?? 1));
  else if (kind === "file") learner = parseLibrary({ version: 1, envs: { x: [JSON.parse(readFileSync(arg!, "utf8"))] } }).x![0]!;
  else {
    console.error(`error: --from must be pool:N, random:SEED or file:PATH`);
    process.exit(1);
  }

  const workers = Array.from({ length: threads }, () => new Worker(new URL(import.meta.url), { workerData: { ...setupBase, plan: learner.plan } }));
  let nextId = 0;
  const pending = new Map<number, (r: number[]) => void>();
  for (const w of workers) w.on("message", (m: { id: number; rewards: number[] }) => pending.get(m.id)!(m.rewards));
  // Mean reward of each genome over the seeds, the genomes split over the workers.
  const score = async (genomes: Float32Array[], seeds: number[]): Promise<number[]> => {
    const chunk = Math.ceil(genomes.length / workers.length);
    const parts = await Promise.all(
      workers.map((w, k) => {
        const part = genomes.slice(k * chunk, (k + 1) * chunk);
        if (!part.length) return Promise.resolve([] as number[]);
        const id = nextId++;
        return new Promise<number[]>((done) => {
          pending.set(id, done);
          w.postMessage({ id, genomes: part, seeds });
        });
      }),
    );
    return parts.flat();
  };
  const evalSeeds = Array.from({ length: evalCount }, (_, k) => EVAL_BASE + k);
  // Held-out score: the seeds spread over the workers, one genome.
  const scoreHeld = async (genome: Float32Array): Promise<number> => {
    const per = Math.ceil(evalSeeds.length / workers.length);
    const parts = await Promise.all(
      workers.map((w, k) => {
        const seeds = evalSeeds.slice(k * per, (k + 1) * per);
        if (!seeds.length) return Promise.resolve(0);
        const id = nextId++;
        return new Promise<number>((done) => {
          pending.set(id, (r) => done(r[0]! * seeds.length));
          w.postMessage({ id, genomes: [genome], seeds });
        });
      }),
    );
    return parts.reduce((a, b) => a + b, 0) / evalSeeds.length;
  };

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
  for (const w of workers) void w.terminate();
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
}
