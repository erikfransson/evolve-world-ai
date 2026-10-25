// T7 probe: population-based training against independent runs at the same compute. M ES members train on one rotated env mix;
// every `every` iterations each member's theta plays a selection set (the mix envs on seeds disjoint from the reporting set). With
// --pbt the worst member restarts from a copy of the best with sigma and lr each x 0.8 or x 1.25; without, members stay independent.
// At the end the member best on the selection set is scored on the battery (t7-run.ts output format, so t7-agg.py reads it).
// Run from src/typescript: node ../../docs/rl-notes/probes/t7-pbt.ts --cfg CFG.json --seed 1 [--pbt] --out run.json
// CFG.json: as t7-run.ts with one stage, plus "members" (4), "every" (50) and "selSeeds" (16).

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { layerSizes, randomGenome } from "../../../src/typescript/src/sim/brain.ts";
import { createRng, deriveSeed } from "../../../src/typescript/src/sim/rng.ts";
import { layoutConfig, runEpisode } from "../../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec, Learner } from "../../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
import { parseLibrary } from "../../../src/typescript/src/sim/rl/library.ts";
import { HELD_BASE, Trainer, heldSeeds } from "../../../src/typescript/src/sim/rl/trainer.ts";
import type { RlTask, Scorer } from "../../../src/typescript/src/sim/rl/trainer.ts";
import type { PlanView } from "../../../src/typescript/src/sim/sensors.ts";

// parameters
const { values } = parseArgs({ options: { cfg: { type: "string" }, seed: { type: "string", default: "1" }, pbt: { type: "boolean", default: false }, out: { type: "string" } } });
interface Cfg { body: string; stages: [{ envs: string[]; iters: number }]; eval: string[]; evalSeeds?: number; members?: number; every?: number; selSeeds?: number }
const cfg = JSON.parse(readFileSync(values.cfg!, "utf8")) as Cfg;
const seed = Number(values.seed);
const M = cfg.members ?? 4;
const EVERY = cfg.every ?? 50;
const SEL_OFFSET = 100000; // selection seeds HELD_BASE + 100000 + k, never in heldSeeds(64)

const pool = parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries;
const library = parseLibrary(JSON.parse(readFileSync("public/rl/library.json", "utf8")));
const env = (id: string): EnvSpec => envById(id) ?? (() => { throw new Error(`unknown env ${id}`); })();
const founders = (JSON.parse(readFileSync("public/live-founders.json", "utf8")) as { founders: { name: string; plan: PlanView }[] }).founders;
const plan = founders.find((x) => x.name === cfg.body.slice(8))!.plan;
const run = (e: EnvSpec, g: Float32Array, s: number) => runEpisode(e, { plan, genome: g } as Learner, s, pool, library);

const mix = cfg.stages[0].envs.map(env);
const scorer: Scorer = { rewards: async (tasks: readonly RlTask[]) => tasks.map((t) => run(mix[deriveSeed(t.seed, 0x707) % mix.length]!, t.genome, t.seed).reward) };
const selSeeds = Array.from({ length: cfg.selSeeds ?? 16 }, (_, k) => HELD_BASE + SEL_OFFSET + k);
const selScore = (g: Float32Array): number => mix.reduce((a, e) => a + selSeeds.reduce((b, s) => b + run(e, g, s).reward, 0) / selSeeds.length, 0) / mix.length;

const rng = createRng(deriveSeed(seed, 0x9b7));
const members = Array.from({ length: M }, (_, m) => {
  const g = randomGenome(layerSizes(layoutConfig("ecosystem"), plan), createRng(deriveSeed(seed * 10 + m, 0x7a11)));
  return { sigma: 0.08, lr: 0.02, trainer: new Trainer(g, { pairs: 50 }, scorer, 1, 1, (seed * 10 + m) * 100), sel: 0 };
});
const t0 = performance.now();
const log: string[] = [];
let restarts = 0;
for (let it = 0; it < cfg.stages[0].iters; it += EVERY) {
  for (const mb of members) while (mb.trainer.iter < EVERY) await mb.trainer.step();
  for (const mb of members) mb.sel = selScore(mb.trainer.theta);
  const order = members.map((_, k) => k).sort((a, b) => members[b]!.sel - members[a]!.sel);
  log.push(`${it + EVERY}: ${members.map((mb) => `${mb.sel.toFixed(2)}(${mb.sigma.toFixed(3)},${mb.lr.toFixed(3)})`).join(" ")}`);
  const last = it + EVERY >= cfg.stages[0].iters;
  for (let k = 0; k < M; k++) {
    const mb = members[k]!;
    const best = members[order[0]!]!;
    const exploit = values.pbt && !last && k === order[M - 1];
    if (exploit) {
      mb.sigma = best.sigma * (rng.next() < 0.5 ? 0.8 : 1.25);
      mb.lr = best.lr * (rng.next() < 0.5 ? 0.8 : 1.25);
      restarts++;
    }
    // every member gets a new Trainer each round (fresh Adam state), so the two modes differ only in the exploit step
    const g = Float32Array.from((exploit ? best : mb).trainer.theta);
    mb.trainer = new Trainer(g, { pairs: 50, sigma: mb.sigma, lr: mb.lr }, scorer, 1, 1, (seed * 10 + k) * 100 + it + EVERY);
  }
}
const pick = members.reduce((a, b) => (b.sel > a.sel ? b : a));
const evalSeeds = heldSeeds(cfg.evalSeeds ?? 64);
const final = Object.fromEntries(cfg.eval.map((id) => {
  const eps = evalSeeds.map((s) => run(env(id), pick.trainer.theta, s));
  return [id, { reward: eps.map((e) => Math.round(e.reward * 1e4) / 1e4), food: eps.map((e) => e.food) }];
}));
const means = Object.fromEntries(Object.entries(final).map(([id, v]) => [id, v.reward.reduce((a, x) => a + x, 0) / v.reward.length]));
console.log(`${values.cfg} ${values.pbt ? "pbt" : "indep"} seed ${seed}: restarts ${restarts}; ${Object.entries(means).map(([id, v]) => `${id} ${v.toFixed(2)}`).join(", ")}; ${((performance.now() - t0) / 1000).toFixed(0)} s`);
if (values.out) writeFileSync(values.out, JSON.stringify({ cfg: values.cfg, seed, pbt: values.pbt, log, final }) + "\n");
