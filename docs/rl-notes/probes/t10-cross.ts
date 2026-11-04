// T10 distinctness probe: train ES on each env of --train from a random body, score the result on each env of --targets.
// Run from src/typescript: node ../../docs/rl-notes/probes/t10-cross.ts --targets thorny,bitter-rows --train thorny,bitter-rows,stings,minefield --bodies 1,2 --iters 60 --out /tmp/x.json
// Prints, per body and target, the target's own gain (trained on itself, 64 held-out seeds) and every other training env's gain as a share of it (85% or more is a duplicate), plus poison bites per episode before and after.

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { randomLearner, scoreLearner } from "../../../src/typescript/src/sim/rl/env.ts";
import type { Learner } from "../../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
import { Trainer, heldSeeds } from "../../../src/typescript/src/sim/rl/trainer.ts";
import { createNodeRlPool } from "../../../src/typescript/src/worker/nodePool.ts";

// parameters
const { values } = parseArgs({
  options: {
    targets: { type: "string" },
    train: { type: "string" },
    bodies: { type: "string", default: "1,2" },
    iters: { type: "string", default: "60" },
    pairs: { type: "string", default: "100" }, // population 200
    seeds: { type: "string", default: "64" },
    threads: { type: "string", default: "2" },
    out: { type: "string" },
  },
});
const targets = values.targets!.split(",").map((id) => envById(id)!);
const trainIds = [...new Set([...targets.map((e) => e.id), ...values.train!.split(",")])];
const ITERS = Number(values.iters);
const seeds = heldSeeds(Number(values.seeds));

const results: Record<string, unknown>[] = [];
for (const body of values.bodies!.split(",").map(Number)) {
  const start = randomLearner(targets[0]!, body); // the same body for every env of this world
  const trained = new Map<string, Learner>();
  for (const id of trainIds) {
    const env = envById(id)!;
    const helpers = createNodeRlPool({ envs: [env], plan: start.plan, pool: null, library: {} }, Number(values.threads));
    const trainer = new Trainer(Float32Array.from(start.genome), { pairs: Number(values.pairs), sigma: 0.08, lr: 0.02 }, helpers, 1, 1, 1);
    while (trainer.iter < ITERS) await trainer.step();
    trained.set(id, { plan: start.plan, genome: Float32Array.from(trainer.es.theta) });
    helpers.close();
  }
  for (const t of targets) {
    const base = scoreLearner(t, start, seeds);
    const own = scoreLearner(t, trained.get(t.id)!, seeds);
    const gain = own.reward - base.reward;
    const row: Record<string, unknown> = { body, target: t.id, start: base.reward, own: own.reward, gain, poisonStart: base.poison, poisonOwn: own.poison, share: {} };
    const line: string[] = [];
    for (const id of trainIds) {
      if (id === t.id) continue;
      const r = scoreLearner(t, trained.get(id)!, seeds);
      const share = (r.reward - base.reward) / gain;
      (row.share as Record<string, number>)[id] = share;
      line.push(`${id} ${(100 * share).toFixed(0)}% (${r.poison.toFixed(2)})`);
    }
    console.log(`random:${body} ${t.id}: ${base.reward.toFixed(2)} -> ${own.reward.toFixed(2)} (gain ${gain.toFixed(2)}), poison bites/ep ${base.poison.toFixed(2)} -> ${own.poison.toFixed(2)}; others' share (poison bites/ep): ${line.join(", ")}`);
    results.push(row);
  }
}
if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 1) + "\n");
process.exit(0);
