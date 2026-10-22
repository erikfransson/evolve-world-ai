// T3 probe: short serial ES runs for curriculum and reward-shaping comparisons on custom env stages.
// Run from src/typescript: node ../../docs/rl-notes/probes/t3-train.ts --plan PLAN.json --seed 1 --out /tmp/x.json
// PLAN.json: { "eval": EnvSpec, "stages": [{ "env": EnvSpec, "iters": n }, ...] }. Every stage trains from the previous weights
// (fresh ES state, as an Arena run whose envs change). The eval env is scored on held-out seeds before, between stages and at the end;
// eval reward and food eaten are both kept, so shaped stages are judged on the same measure.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { poolLearner, randomLearner, runEpisode } from "../../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec } from "../../../src/typescript/src/sim/rl/env.ts";
import { Trainer, heldSeeds } from "../../../src/typescript/src/sim/rl/trainer.ts";
import type { RlTask, Scorer } from "../../../src/typescript/src/sim/rl/trainer.ts";

// parameters
const { values } = parseArgs({
  options: {
    plan: { type: "string" },
    from: { type: "string", default: "random:1" },
    seed: { type: "string", default: "1" },
    pairs: { type: "string", default: "50" }, // population 100, the Arena default
    episodes: { type: "string", default: "1" },
    eval: { type: "string", default: "64" },
    out: { type: "string" },
  },
});
const plan = JSON.parse(readFileSync(values.plan!, "utf8")) as { eval: EnvSpec; stages: { env: EnvSpec; iters: number }[] };
const pool = parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries;
const [kind, arg] = values.from!.split(":");
const learner = kind === "pool" ? poolLearner(plan.eval, pool[Number(arg)]!) : randomLearner(plan.eval, Number(arg));

let env: EnvSpec = plan.stages[0]!.env;
const scorer: Scorer = { rewards: async (tasks: readonly RlTask[]) => tasks.map((t) => runEpisode(env, { plan: learner.plan, genome: t.genome }, t.seed, pool).reward) };
const evalSeeds = heldSeeds(Number(values.eval));
const evalOf = (g: Float32Array) => {
  const eps = evalSeeds.map((s) => runEpisode(plan.eval, { plan: learner.plan, genome: g }, s, pool));
  return { reward: eps.reduce((a, e) => a + e.reward, 0) / eps.length, food: eps.reduce((a, e) => a + e.food, 0) / eps.length, rewards: eps.map((e) => e.reward) };
};

const t0 = performance.now();
let genome = Float32Array.from(learner.genome);
const curve = [{ stage: -1, iter: 0, ...evalOf(genome) }];
for (let k = 0; k < plan.stages.length; k++) {
  env = plan.stages[k]!.env;
  const trainer = new Trainer(genome, { pairs: Number(values.pairs) }, scorer, 1, Number(values.episodes), Number(values.seed) * 100 + k);
  while (trainer.iter < plan.stages[k]!.iters) await trainer.step();
  genome = Float32Array.from(trainer.theta);
  curve.push({ stage: k, iter: trainer.iter, ...evalOf(genome) });
}
const last = curve[curve.length - 1]!;
console.log(`${values.plan} seed ${values.seed}: eval ${curve[0]!.reward.toFixed(3)} -> ${last.reward.toFixed(3)}, food ${curve[0]!.food.toFixed(2)} -> ${last.food.toFixed(2)}; stages ${curve.slice(1).map((c) => c.reward.toFixed(2)).join(" ")}; ${((performance.now() - t0) / 1000).toFixed(0)} s`);
if (values.out) writeFileSync(values.out, JSON.stringify({ plan: values.plan, seed: values.seed, from: values.from, curve }) + "\n");
