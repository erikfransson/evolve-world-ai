// T2 probe: scores trained genomes (rlTrain --out files) and their start genome on fresh seeds no run trained or checked on.
// Usage (from src/typescript): node ../../docs/rl-notes/probes/score-final.ts --seeds 128 file1.json file2.json ...
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { poolLearner } from "../../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
import { HELD_BASE, scoreGenomes } from "../../../src/typescript/src/sim/rl/trainer.ts";
import { createNodeRlPool } from "../../../src/typescript/src/worker/nodePool.ts";

// parameters
const { values, positionals } = parseArgs({ allowPositionals: true, options: { seeds: { type: "string", default: "128" }, threads: { type: "string", default: "2" } } });
const seeds = Array.from({ length: Number(values.seeds) }, (_, k) => HELD_BASE + 30000 + k);
const pool = existsSync("public/pool.json") ? parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries : null;
const runs = positionals.map((f) => ({ f, ...(JSON.parse(readFileSync(f, "utf8")) as { env: string; from: string; plan: never; genome: number[]; heldEnd: number }) }));
for (const id of [...new Set(runs.map((r) => r.env))]) {
  const env = envById(id)!;
  const mine = runs.filter((r) => r.env === id);
  const start = poolLearner(env, pool![Number(mine[0]!.from.split(":")[1])]!);
  const helpers = createNodeRlPool({ envs: [env], plan: start.plan, pool, library: {} }, Number(values.threads));
  const scores = (await scoreGenomes(helpers, 1, [start.genome, ...mine.map((r) => Float32Array.from(r.genome))], seeds)).map((s) => s.mean);
  helpers.close();
  console.log(`${id} start ${scores[0]!.toFixed(3)} on ${seeds.length} fresh seeds`);
  mine.forEach((r, i) => console.log(`${r.f.split("/").pop()} held64 ${r.heldEnd.toFixed(3)} fresh ${scores[i + 1]!.toFixed(3)}`));
}
