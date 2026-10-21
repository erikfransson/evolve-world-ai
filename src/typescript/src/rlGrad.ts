// Trains one creature in an RL environment with backprop RL (PPO on its own brain), on the main thread; a prototype to compare with rlTrain (ES).
// Usage: node src/rlGrad.ts --env nibble [--from random:1 | pool:0] [--seconds 60] [--iters 1000] [--episodes 16] [--epochs 2] [--lr 0.003]
//        [--logstd=-0.5] [--repeat 3] [--every-tick] [--repeat-then 30:1] [--target-kl 0.02] [--gamma 0.995] [--eval 32] [--every 5] [--seed 1] [--out learner.json]
// --repeat-then S:N switches to repeat N after S seconds of training; --every-tick holds only the noise while the brain acts every tick.
// Held-out: the mean action (the brain as it is) on HELD_BASE + k, as rlTrain. Time excludes the held-out checks.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { layerSizes } from "./sim/brain.ts";
import { layoutConfig, poolLearner, randomLearner, scoreLearner } from "./sim/rl/env.ts";
import { envById } from "./sim/rl/envs.ts";
import { serialiseLearner } from "./sim/rl/library.ts";
import { Ppo } from "./sim/rl/ppo.ts";
import { heldSeeds } from "./sim/rl/trainer.ts";
import { parsePool } from "./sim/seedPool.ts";

const { values } = parseArgs({
  options: {
    env: { type: "string", default: "nibble" },
    from: { type: "string", default: "random:1" },
    seconds: { type: "string", default: "60" },
    iters: { type: "string", default: "100000" },
    episodes: { type: "string", default: "16" },
    epochs: { type: "string", default: "2" },
    minibatch: { type: "string", default: "256" },
    lr: { type: "string", default: "0.003" },
    logstd: { type: "string", default: "-0.5" },
    entropy: { type: "string", default: "0" },
    repeat: { type: "string", default: "3" },
    "every-tick": { type: "boolean", default: false },
    "repeat-then": { type: "string" },
    "target-kl": { type: "string", default: "0" },
    gamma: { type: "string", default: "0.995" },
    eval: { type: "string", default: "32" },
    every: { type: "string", default: "5" },
    seed: { type: "string", default: "1" },
    pool: { type: "string", default: "public/pool.json" },
    out: { type: "string" },
  },
});

const env = envById(values.env!);
if (!env) {
  console.error(`error: unknown env "${values.env}"`);
  process.exit(1);
}
const num = (k: keyof typeof values): number => Number(values[k]);
const pool = existsSync(values.pool!) ? parsePool(JSON.parse(readFileSync(values.pool!, "utf8"))).entries : null;
const [kind, arg] = values.from!.split(/:(.*)/);
const learner = kind === "pool" && pool ? poolLearner(env, pool[Number(arg)]!) : kind === "random" ? randomLearner(env, Number(arg ?? 1)) : null;
if (!learner) {
  console.error("error: --from must be pool:N or random:SEED");
  process.exit(1);
}
const sizes = layerSizes(layoutConfig(env.world), learner.plan);
const ppo = new Ppo([env], learner, sizes, {
  episodes: num("episodes"), epochs: num("epochs"), minibatch: num("minibatch"), lr: num("lr"), logStd: num("logstd"), entropy: num("entropy"), repeat: num("repeat"), gamma: num("gamma"), everyTick: values["every-tick"], targetKl: num("target-kl"),
}, num("seed"), pool);
const seeds = heldSeeds(num("eval"));
const held = (): number => scoreLearner(env, { plan: learner.plan, genome: ppo.theta }, seeds, pool).reward;
const start = held();
console.log(`env ${env.id}, from ${values.from}, sizes ${sizes.join("-")}; held-out ${start.toFixed(3)} on ${seeds.length} seeds`);
const curve: { iter: number; episodes: number; seconds: number; train: number; held?: number }[] = [{ iter: 0, episodes: 0, seconds: 0, train: NaN, held: start }];
const [switchAt, switchTo] = values["repeat-then"] ? values["repeat-then"].split(":").map(Number) : [Infinity, 0];
let busy = 0;
while (ppo.iter < num("iters") && busy < num("seconds") * 1000) {
  if (busy >= switchAt! * 1000 && ppo.options.repeat !== switchTo) ppo.setRepeat(switchTo!);
  const t = performance.now();
  const step = ppo.step();
  busy += performance.now() - t;
  const point: (typeof curve)[number] = { iter: step.iter, episodes: ppo.episodesPlayed, seconds: busy / 1000, train: step.train };
  if (step.iter % num("every") === 0) {
    point.held = held();
    console.log(`iter ${step.iter}: episodes ${ppo.episodesPlayed}, train ${step.train.toFixed(3)}, held-out ${point.held.toFixed(3)}, std ${step.std.map((s) => s.toFixed(2)).join(" ")} (${point.seconds.toFixed(0)} s)`);
  }
  curve.push(point);
}
const end = held();
console.log(`held-out ${start.toFixed(3)} -> ${end.toFixed(3)} after ${ppo.episodesPlayed} episodes, ${(busy / 1000).toFixed(0)} s`);
if (values.out) writeFileSync(resolve(values.out), JSON.stringify({ ...serialiseLearner({ plan: learner.plan, genome: ppo.theta }), env: env.id, from: values.from, heldStart: start, heldEnd: end, curve }) + "\n");
