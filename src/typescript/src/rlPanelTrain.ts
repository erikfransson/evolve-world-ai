// Trains each design of the panel (designPanel.ts) with the Arena's default recipe and a fixed budget, as the reference every idea is compared against.
// Usage: node src/rlPanelTrain.ts --method es|backprop --out DIR [--iters N] [--design p3-mid] [--threads 2]
// Arena defaults: ES population 100 (50 pairs), sigma 0.08, lr 0.02, decay 0.005, 1 episode per step; backprop lr 0.003, 16 episodes per update.
// Every step plays all envs of the mix, as the Arena does. Writes DIR/<design id>.json ({plan, genome}); the same fixed seeds for every run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { parsePool } from "./sim/seedPool.ts";
import { DESIGN_PANEL, designLearner } from "./sim/rl/designPanel.ts";
import { envById } from "./sim/rl/envs.ts";
import type { EnvSpec } from "./sim/rl/env.ts";
import { parseLibrary, serialiseLearner } from "./sim/rl/library.ts";
import { BackpropTrainer } from "./sim/rl/ppo.ts";
import { Trainer, heldSeeds } from "./sim/rl/trainer.ts";
import type { RlTrainer } from "./sim/rl/trainer.ts";
import { createNodeRlPool, parseThreads } from "./worker/nodePool.ts";

// parameters
const MIX = ["nibble", "far-food", "corridor", "patch", "minefield"]; // the transfer battery meets its own seeds, never these
const { values } = parseArgs({
  options: {
    method: { type: "string", default: "es" },
    out: { type: "string" },
    iters: { type: "string", default: "300" },
    design: { type: "string" },
    threads: { type: "string", default: "2" },
    pool: { type: "string", default: "public/pool.json" },
    library: { type: "string", default: "public/rl/library.json" },
  },
});
const fail = (msg: string): never => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
if (values.method !== "es" && values.method !== "backprop") fail("--method must be es or backprop");
if (!values.out) fail("--out DIR is required");
const iters = Number(values.iters);
if (!Number.isInteger(iters) || iters < 1) fail("--iters must be a positive integer");
const threads = parseThreads(values.threads);
const envs = MIX.map((id) => envById(id) ?? fail(`env ${id}`)) as EnvSpec[];
const pool = existsSync(values.pool!) ? parsePool(JSON.parse(readFileSync(values.pool!, "utf8"))).entries : null;
const library = parseLibrary(existsSync(values.library!) ? JSON.parse(readFileSync(values.library!, "utf8")) : null);
const dir = resolve(values.out!);
mkdirSync(dir, { recursive: true });

for (const [k, design] of DESIGN_PANEL.entries()) {
  if (values.design && values.design !== design.id) continue;
  const learner = designLearner(design);
  const helpers = createNodeRlPool({ envs, plan: learner.plan, pool, library }, threads);
  const seed = 1000 + k;
  const trainer: RlTrainer =
    values.method === "backprop"
      ? new BackpropTrainer({ plan: learner.plan, genome: Float32Array.from(learner.genome) }, envs, { lr: 0.003, episodes: 16 }, helpers, seed, pool, library)
      : new Trainer(Float32Array.from(learner.genome), { pairs: 50, sigma: 0.08, lr: 0.02, decay: 0.005 }, helpers, envs.length, 1, seed);
  const held = heldSeeds(16);
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const start = (await trainer.held(held)).mean;
  while (trainer.iter < iters) await trainer.step();
  const end = (await trainer.held(held)).mean;
  helpers.close();
  const cpu = process.cpuUsage(cpu0);
  writeFileSync(resolve(dir, `${design.id}.json`), JSON.stringify(serialiseLearner({ plan: learner.plan, genome: trainer.theta })) + "\n");
  console.log(`${design.id} ${values.method} ${iters} iters: training held-out mix ${start.toFixed(2)} -> ${end.toFixed(2)}, ${((performance.now() - t0) / 1000).toFixed(0)} s wall (main thread cpu ${((cpu.user + cpu.system) / 1e6).toFixed(0)} s)`);
}
