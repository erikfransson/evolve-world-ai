// T6 probe: one training run at a fixed CPU budget, as phases of ES and PPO, then the final genome on fixed paired seed sets.
// Usage (from src/typescript): node ../../docs/rl-notes/probes/t6-train.ts --env fading --from random:1 --phases es:80 --seed 1 --out x.json
// --phases: comma list of es:S or ppo:S, S in process CPU seconds (all threads; held-out checks excluded). --init N swaps the genome for
// a fresh random one (seed N) on the same body. --sigma-end / --lr-end anneal geometrically over each ES phase.
// Final: theta on the test set (HELD_BASE + 30000 + k, per-seed rewards kept for paired comparisons) and the selection set (HELD_BASE + 50000 + k).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { layoutConfig, poolLearner, randomLearner } from "../../../src/typescript/src/sim/rl/env.ts";
import type { Learner } from "../../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
import { HELD_BASE, Trainer } from "../../../src/typescript/src/sim/rl/trainer.ts";
import { Ppo } from "../../../src/typescript/src/sim/rl/ppo.ts";
import { layerSizes, randomGenome } from "../../../src/typescript/src/sim/brain.ts";
import { createRng, deriveSeed } from "../../../src/typescript/src/sim/rng.ts";
import { createNodeRlPool } from "../../../src/typescript/src/worker/nodePool.ts";

// parameters
const { values } = parseArgs({
  options: {
    env: { type: "string", default: "fading" },
    from: { type: "string", default: "random:1" },
    init: { type: "string" },
    "ray-length": { type: "string" }, // overrides the body's ray length (same genome size), a sensor test
    phases: { type: "string", default: "es:80" },
    seed: { type: "string", default: "1" },
    pairs: { type: "string", default: "50" },
    episodes: { type: "string", default: "1" },
    sigma: { type: "string", default: "0.08" },
    "sigma-end": { type: "string" },
    lr: { type: "string", default: "0.02" },
    "lr-end": { type: "string" },
    "ppo-lr": { type: "string", default: "0.003" },
    "every-tick": { type: "boolean", default: false },
    "target-kl": { type: "string", default: "0" },
    repeat: { type: "string", default: "3" },
    check: { type: "string", default: "20" }, // CPU seconds between 32-seed curve checks
    test: { type: "string", default: "64" },
    sel: { type: "string", default: "32" },
    threads: { type: "string", default: "2" },
    out: { type: "string" },
  },
});
const N = (k: keyof typeof values) => Number(values[k]);

const env = envById(values.env!)!;
const pool = existsSync("public/pool.json") ? parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries : null;
const [kind, arg] = values.from!.split(":");
let learner: Learner = kind === "pool" ? poolLearner(env, pool![Number(arg)]!) : randomLearner(env, Number(arg));
if (values["ray-length"]) learner = { plan: { ...learner.plan, rayLength: N("ray-length") }, genome: learner.genome };
const sizes = layerSizes(layoutConfig(env.world), learner.plan);
if (values.init) learner = { plan: learner.plan, genome: randomGenome(sizes, createRng(deriveSeed(N("init"), 0x7e6))) };
const helpers = createNodeRlPool({ envs: [env], plan: learner.plan, pool, library: {} }, N("threads"));
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; };
const seedSet = (base: number, n: number) => Array.from({ length: n }, (_, k) => HELD_BASE + base + k);
const curveSeeds = seedSet(0, 32), testSeeds = seedSet(30000, N("test")), selSeeds = seedSet(50000, N("sel"));
const play = (genome: Float32Array, seeds: number[]) => helpers.rewards(seeds.map((seed) => ({ env: 0, genome, seed })));
const mean = (a: readonly number[]) => a.reduce((s, v) => s + v, 0) / a.length;

let theta = Float32Array.from(learner.genome);
let used = 0, nextCheck = 0, episodes = 0;
const curve: { cpu: number; phase: string; held: number }[] = [];
const check = async (phase: string) => {
  curve.push({ cpu: used, phase, held: mean(await play(theta, curveSeeds)) });
  console.log(`${phase} cpu ${used.toFixed(0)} s, episodes ${episodes}, held32 ${curve.at(-1)!.held.toFixed(3)}`);
};
await check("start");
let ppo: Ppo | null = null;
for (const [p, phase] of values.phases!.split(",").entries()) {
  const [type, secs] = phase.split(":");
  const budget = used + Number(secs);
  const t0 = used;
  if (type === "es") {
    const trainer = new Trainer(theta, { pairs: N("pairs"), sigma: N("sigma"), lr: N("lr") }, helpers, 1, N("episodes"), deriveSeed(N("seed"), p));
    const ratio = (end: string | undefined, start: number) => (end ? Number(end) / start : 1);
    while (used < budget) {
      const f = (used - t0) / (budget - t0);
      trainer.es.options.sigma = N("sigma") * ratio(values["sigma-end"], N("sigma")) ** f;
      trainer.es.options.lr = N("lr") * ratio(values["lr-end"], N("lr")) ** f;
      const c = cpu();
      await trainer.step();
      used += cpu() - c;
      episodes += 2 * N("pairs") * N("episodes");
      theta = trainer.es.theta;
      if (used >= nextCheck) { nextCheck += N("check"); await check(phase); }
    }
    theta = Float32Array.from(trainer.es.theta);
  } else {
    ppo = new Ppo([env], { plan: learner.plan, genome: theta }, sizes, { lr: N("ppo-lr"), repeat: N("repeat"), everyTick: values["every-tick"], targetKl: N("target-kl") }, deriveSeed(N("seed"), p), pool);
    while (used < budget) {
      const c = cpu();
      await ppo.stepWith(helpers);
      used += cpu() - c;
      episodes += ppo.options.episodes;
      theta = ppo.theta;
      if (used >= nextCheck) { nextCheck += N("check"); await check(phase); }
    }
    theta = Float32Array.from(ppo.theta);
  }
}
const test = await play(theta, testSeeds);
const sel = mean(await play(theta, selSeeds));
helpers.close();
console.log(`final test${testSeeds.length} ${mean(test).toFixed(3)} sel${selSeeds.length} ${sel.toFixed(3)} cpu ${used.toFixed(0)} s episodes ${episodes}`);
if (values.out) writeFileSync(values.out, JSON.stringify({ args: values, test, testMean: mean(test), sel, cpu: used, episodes, curve, plan: learner.plan, genome: Array.from(theta, (v) => Math.round(v * 1e4) / 1e4) }) + "\n");
