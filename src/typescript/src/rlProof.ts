// Tests whether a learner learns in an RL env beyond luck: several training runs, each scored at checkpoints on one fixed set of held-out seeds,
// then compared paired on those seeds with the pre-training copy, random designs and trivial policies, with bootstrap 95% intervals.
// Usage: node src/rlProof.ts --env nibble [--learner es | ppo] [--from random | pool:N] [--runs 3] [--iters 60] [--checks 4] [--held 64]
//        [--pairs 50] [--episodes 1] [--sigma 0.08] [--lr 0.02] (ES) [--every-tick] [--target-kl 0.02] [--repeat 3] [--ppo-lr 0.003] (PPO)
//        [--randoms 8] [--boot 2000] [--threads 2] [--out proof.json]
// --from random starts run k from random:k (a fresh design each run); pool:N starts every run from the same founder.
// The final weights are the last iteration's (no checkpoint is picked), so the held-out seeds are never used to select.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { genomeLength, layerSizes } from "./sim/brain.ts";
import { parsePool } from "./sim/seedPool.ts";
import { OUT_THRUST, OUT_TURN } from "./sim/sensors.ts";
import type { PlanView } from "./sim/sensors.ts";
import { layoutConfig, poolLearner, randomLearner, runEpisode } from "./sim/rl/env.ts";
import type { EnvSpec, Learner } from "./sim/rl/env.ts";
import { envById } from "./sim/rl/envs.ts";
import { parseLibrary } from "./sim/rl/library.ts";
import { Ppo } from "./sim/rl/ppo.ts";
import { curveSlope, mean, pairedDiff } from "./sim/rl/proofStats.ts";
import type { Interval } from "./sim/rl/proofStats.ts";
import { Trainer, heldSeeds } from "./sim/rl/trainer.ts";
import { createNodeRlPool, parseThreads } from "./worker/nodePool.ts";

const { values } = parseArgs({
  options: {
    env: { type: "string", default: "nibble" },
    learner: { type: "string", default: "es" },
    from: { type: "string", default: "random" },
    runs: { type: "string", default: "3" },
    iters: { type: "string", default: "60" }, // ES iterations or PPO updates per run
    checks: { type: "string", default: "4" }, // held-out checkpoints after the start
    held: { type: "string", default: "64" },
    pairs: { type: "string", default: "50" },
    episodes: { type: "string", default: "1" },
    sigma: { type: "string", default: "0.08" },
    lr: { type: "string", default: "0.02" },
    "every-tick": { type: "boolean", default: false },
    "target-kl": { type: "string", default: "0" },
    repeat: { type: "string", default: "3" },
    "ppo-lr": { type: "string", default: "0.003" },
    randoms: { type: "string", default: "8" },
    boot: { type: "string", default: "2000" },
    threads: { type: "string", default: "2" },
    pool: { type: "string", default: "public/pool.json" },
    library: { type: "string", default: "public/rl/library.json" },
    out: { type: "string" },
  },
});

const fail = (msg: string): never => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
const env = envById(values.env!) ?? fail(`unknown env "${values.env}"`);
const int = (k: "runs" | "iters" | "checks" | "held" | "pairs" | "episodes" | "repeat" | "randoms" | "boot"): number => {
  const v = Number(values[k]);
  return Number.isInteger(v) && v >= 1 ? v : fail(`--${k} must be a positive integer`);
};
const real = (k: "sigma" | "lr" | "ppo-lr" | "target-kl", zeroOk = false): number => {
  const v = Number(values[k]);
  return Number.isFinite(v) && (v > 0 || (zeroOk && v === 0)) ? v : fail(`--${k} must be a finite number above 0${zeroOk ? " (or 0 for off)" : ""}`);
};
const [sigma, lr, ppoLr, targetKl] = [real("sigma"), real("lr"), real("ppo-lr"), real("target-kl", true)];
const [runs, iters, checks, heldCount, randoms, boot] = (["runs", "iters", "checks", "held", "randoms", "boot"] as const).map(int);
if (values.learner !== "es" && values.learner !== "ppo") fail("--learner must be es or ppo");
const threads = parseThreads(values.threads);
const pool = existsSync(values.pool!) ? parsePool(JSON.parse(readFileSync(values.pool!, "utf8"))).entries : null;
const library = parseLibrary(existsSync(values.library!) ? JSON.parse(readFileSync(values.library!, "utf8")) : null);
const founder = /^pool:(\d+)$/.exec(values.from!);
if (values.from !== "random" && !(founder && pool?.[Number(founder[1])])) fail("--from must be random or pool:N (with a pool file)");
const startOf = (run: number): Learner => (founder ? poolLearner(env, pool![Number(founder[1])]!) : randomLearner(env, run));

const seeds = heldSeeds(heldCount);
const perSeed = (learner: Learner): number[] => seeds.map((s) => runEpisode(env, learner, s, pool, library).reward);

// A one-ray, one-neuron brain whose outputs are constant: tanh(bias) for turn and thrust (as probes/t3-snr.ts).
const BIAS_PLAN: PlanView = { rayCount: 1, raySpread: 0, rayLength: 10, hiddenLayers: [1], memoryShort: 0, memoryLong: 0 };
function constant(world: EnvSpec["world"], turn: number, thrust: number): Learner {
  const sizes = layerSizes(layoutConfig(world), BIAS_PLAN);
  const g = new Float32Array(genomeLength(sizes));
  const at = g.length - sizes[sizes.length - 1]!;
  g[at + OUT_TURN] = Math.atanh(turn);
  g[at + OUT_THRUST] = Math.atanh(thrust);
  return { plan: BIAS_PLAN, genome: g };
}

const t0 = performance.now();
const trivial = { still: perSeed(constant(env.world, 0, 0)), straight: perSeed(constant(env.world, 0, 0.999)), circle: perSeed(constant(env.world, 0.5, 0.6)) };
const randomRows = Array.from({ length: randoms }, (_, k) => perSeed(randomLearner(env, 1000 + k))); // other designs than the runs' starts
const randomMean = seeds.map((_, s) => mean(randomRows.map((r) => r[s]!)));
const bestTrivial = (Object.keys(trivial) as (keyof typeof trivial)[]).reduce((a, b) => (mean(trivial[b]) > mean(trivial[a]) ? b : a));
const f = (x: number): string => x.toFixed(2);
console.log(`env ${env.id}, ${values.learner} from ${values.from}, ${runs} runs x ${iters} iters, ${heldCount} held-out seeds`);
console.log(`baselines: random designs ${f(mean(randomMean))}, ${Object.entries(trivial).map(([k, r]) => `${k} ${f(mean(r))}`).join(", ")}`);

// One training run: held-out rewards per seed at iteration 0 and at each checkpoint.
async function train(run: number): Promise<{ iters: number[]; curve: number[][] }> {
  const learner = startOf(run);
  const at = Array.from({ length: checks + 1 }, (_, c) => Math.round((c * iters) / checks));
  const curve = [perSeed(learner)];
  if (values.learner === "es") {
    const helpers = createNodeRlPool({ envs: [env], plan: learner.plan, pool, library }, threads);
    const trainer = new Trainer(Float32Array.from(learner.genome), { pairs: int("pairs"), sigma, lr }, helpers, 1, int("episodes"), run);
    for (const target of at.slice(1)) {
      while (trainer.iter < target) await trainer.step();
      curve.push(perSeed({ plan: learner.plan, genome: trainer.theta }));
    }
    helpers.close();
  } else {
    const sizes = layerSizes(layoutConfig(env.world), learner.plan);
    const ppo = new Ppo([env], learner, sizes, { lr: ppoLr, repeat: int("repeat"), everyTick: values["every-tick"], targetKl }, run, pool, library);
    for (const target of at.slice(1)) {
      while (ppo.iter < target) ppo.step();
      curve.push(perSeed({ plan: learner.plan, genome: ppo.theta }));
    }
  }
  console.log(`run ${run}: ${curve.map((c) => f(mean(c))).join(" -> ")} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  return { iters: at, curve };
}

const results: { iters: number[]; curve: number[][] }[] = [];
for (let run = 1; run <= runs; run++) results.push(await train(run));
const finals = results.map((r) => r.curve[checks]!);
const starts = results.map((r) => r.curve[0]!);
const x = results[0]!.iters.map((i) => i / iters);
const ci = (i: Interval): string => `${i.mean >= 0 ? "+" : ""}${f(i.mean)} [${f(i.lo)}, ${f(i.hi)}]`;
const summary = {
  final: mean(finals.map(mean)),
  start: mean(starts.map(mean)),
  vsStart: pairedDiff(finals, starts, boot),
  vsRandom: pairedDiff(finals, [randomMean], boot),
  vsTrivial: pairedDiff(finals, [trivial[bestTrivial]], boot),
  slope: curveSlope(results.map((r) => r.curve), x, boot), // held-out gain per whole run, from the fit over checkpoints
  perRun: finals.map((fin, r) => pairedDiff([fin], [starts[r]!], boot, r + 2)),
};
const up = summary.perRun.filter((i) => i.lo > 0).length;
console.log(`per run, final minus start: ${summary.perRun.map(ci).join(", ")} (${up} of ${runs} above 0)`);
console.log(`all runs: start ${f(summary.start)}, final ${f(summary.final)}; vs start ${ci(summary.vsStart)}, vs random ${ci(summary.vsRandom)}, vs ${bestTrivial} ${ci(summary.vsTrivial)}, slope ${ci(summary.slope)}`);
console.log(`learns beyond luck: ${summary.vsStart.lo > 0 && summary.slope.lo > 0 && summary.vsTrivial.lo > 0 && up === runs ? "yes" : "no"} (${((performance.now() - t0) / 60000).toFixed(1)} min)`);
if (values.out) {
  const out = { env: env.id, learner: values.learner, from: values.from, runs, iters, heldSeeds: heldCount, options: values, baselines: { randomMean, ...trivial }, bestTrivial, runsData: results, summary };
  writeFileSync(resolve(values.out), JSON.stringify(out) + "\n");
}
