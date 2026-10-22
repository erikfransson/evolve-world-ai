// T7 probe: one ES run over env stages (single env, env mix, curriculum, reward variants, body size), then the final genome on a
// fixed battery of trained and untrained envs, every held-out episode kept so runs can be compared seed by seed.
// Run from src/typescript: node ../../docs/rl-notes/probes/t7-run.ts --cfg CFG.json --seed 1 --out run.json
// CFG.json: { "body": PlanView | "random:K" | "founder:NAME", "stages": [{ "envs": [id, ...], "iters": n, "reward"?: "std" | "early" | "net" }],
//   "eval": [id, ...], "evalSeeds"?: 64, "every"?: 100, "pairs"?: 50, "sigma"?: 0.08, "lr"?: 0.02 }
// A stage with several envs rotates: each step plays one env, picked from the step's seed, so every candidate meets the same env and
// the zscore shaping normalises each env's reward scale. Rewards: std = the env's own; early = 2 x share of the episode left per bite
// (the Fading reward) in place of food and fast; net = energy at the end minus the start energy, over the food energy (income).
// The battery always uses the envs' own rewards. Genome init and ES noise come from --seed; held-out seeds are heldSeeds(evalSeeds).

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { layerSizes, randomGenome } from "../../../src/typescript/src/sim/brain.ts";
import { createRng, deriveSeed } from "../../../src/typescript/src/sim/rng.ts";
import { layoutConfig, randomLearner, runEpisode } from "../../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec, Learner } from "../../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
import { parseLibrary } from "../../../src/typescript/src/sim/rl/library.ts";
import { Trainer, heldSeeds } from "../../../src/typescript/src/sim/rl/trainer.ts";
import type { RlTask, Scorer } from "../../../src/typescript/src/sim/rl/trainer.ts";
import type { PlanView } from "../../../src/typescript/src/sim/sensors.ts";

// parameters
const { values } = parseArgs({ options: { cfg: { type: "string" }, seed: { type: "string", default: "1" }, out: { type: "string" } } });
type RewardKind = "std" | "early" | "net";
interface Cfg { body: PlanView | string; stages: { envs: string[]; iters: number; reward?: RewardKind }[]; eval: string[]; evalSeeds?: number; every?: number; pairs?: number; sigma?: number; lr?: number }
const cfg = JSON.parse(readFileSync(values.cfg!, "utf8")) as Cfg;
const seed = Number(values.seed);
const FOOD_ENERGY = 40; // ecoConfig world.foodEnergy
const SPECIES_START = 50;

const pool = parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries;
const library = parseLibrary(JSON.parse(readFileSync("public/rl/library.json", "utf8")));
const env = (id: string): EnvSpec => envById(id) ?? (() => { throw new Error(`unknown env ${id}`); })();

let plan: PlanView;
let founderGenome: number[] | null = null; // "founder:NAME" with "useGenome": true scores that founder itself (a reference row)
if (typeof cfg.body === "string" && cfg.body.startsWith("random:")) plan = randomLearner(env("nibble"), Number(cfg.body.slice(7))).plan;
else if (typeof cfg.body === "string" && cfg.body.startsWith("founder:")) {
  const f = (JSON.parse(readFileSync("public/live-founders.json", "utf8")) as { founders: { name: string; plan: PlanView }[] }).founders.find((x) => x.name === (cfg.body as string).slice(8));
  plan = f!.plan;
  if ((cfg as { useGenome?: boolean }).useGenome) founderGenome = (f as unknown as { genome: number[] }).genome;
} else plan = cfg.body as PlanView;
const genome0 = founderGenome ? Float32Array.from(founderGenome) : randomGenome(layerSizes(layoutConfig("ecosystem"), plan), createRng(deriveSeed(seed, 0x7a11)));

const shaped = (e: EnvSpec, kind: RewardKind): EnvSpec => (kind === "early" ? { ...e, reward: { ...e.reward, food: 0, fast: undefined, early: 2 } } : e);
const rewardOf = (e: EnvSpec, kind: RewardKind, g: Float32Array, s: number): number => {
  const r = runEpisode(e, { plan, genome: g } as Learner, s, pool, library);
  return kind === "net" ? (r.energy - (e.learnerEnergy ?? SPECIES_START)) / FOOD_ENERGY : r.reward;
};

let stageEnvs: EnvSpec[] = [];
let stageKind: RewardKind = "std";
const pick = (s: number): EnvSpec => stageEnvs[deriveSeed(s, 0x707) % stageEnvs.length]!;
const scorer: Scorer = { rewards: async (tasks: readonly RlTask[]) => tasks.map((t) => rewardOf(pick(t.seed), stageKind, t.genome, t.seed)) };

const evalSeeds = heldSeeds(cfg.evalSeeds ?? 64);
const battery = (g: Float32Array) => Object.fromEntries(cfg.eval.map((id) => {
  const eps = evalSeeds.map((s) => runEpisode(env(id), { plan, genome: g } as Learner, s, pool, library));
  return [id, { reward: eps.map((e) => Math.round(e.reward * 1e4) / 1e4), food: eps.map((e) => e.food) }];
}));
const means = (b: ReturnType<typeof battery>) => Object.fromEntries(Object.entries(b).map(([id, v]) => [id, v.reward.reduce((a, x) => a + x, 0) / v.reward.length]));

const t0 = performance.now();
let genome = Float32Array.from(genome0);
const checks: { iter: number; means: Record<string, number> }[] = [];
let done = 0;
for (let k = 0; k < cfg.stages.length; k++) {
  const st = cfg.stages[k]!;
  stageKind = st.reward ?? "std";
  stageEnvs = st.envs.map((id) => shaped(env(id), stageKind));
  const trainer = new Trainer(genome, { pairs: cfg.pairs ?? 50, sigma: cfg.sigma ?? 0.08, lr: cfg.lr ?? 0.02 }, scorer, 1, 1, seed * 100 + k);
  while (trainer.iter < st.iters) {
    await trainer.step();
    if ((done + trainer.iter) % (cfg.every ?? 100) === 0 && trainer.iter < st.iters) checks.push({ iter: done + trainer.iter, means: means(battery(trainer.theta)) });
  }
  done += st.iters;
  genome = Float32Array.from(trainer.theta);
}
const final = battery(genome);
checks.push({ iter: done, means: means(final) });
const m = means(final);
console.log(`${values.cfg} seed ${seed}: ${Object.entries(m).map(([id, v]) => `${id} ${v.toFixed(2)}`).join(", ")}; ${((performance.now() - t0) / 1000).toFixed(0)} s`);
if (values.out) writeFileSync(values.out, JSON.stringify({ cfg: values.cfg, seed, plan, checks, final, genome: Array.from(genome, (v) => Math.round(v * 1e4) / 1e4) }) + "\n");
