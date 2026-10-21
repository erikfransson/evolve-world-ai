// T2 probe: how much does a tiny weight change (the size of the 3-decimal rounding of saved genomes) change episode rewards?
// Scores a genome and copies with +-eps uniform noise per weight on the same seeds; reports per-episode and mean differences.
// Usage (from src/typescript): node ../../docs/rl-notes/probes/chaos.ts --env nibble --from pool:0 | --dir <lab runs/agg> --name lg8
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { checkEnv, poolLearner, randomLearner } from "../../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec, Learner, Library } from "../../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
import { parseCreatureFile } from "../../../src/typescript/src/sim/rl/creatureFile.ts";
import { parseLibrary } from "../../../src/typescript/src/sim/rl/library.ts";
import { heldSeeds } from "../../../src/typescript/src/sim/rl/trainer.ts";
import { createRng } from "../../../src/typescript/src/sim/rng.ts";
import { createNodeRlPool } from "../../../src/typescript/src/worker/nodePool.ts";

// parameters
const { values } = parseArgs({
  options: {
    env: { type: "string", default: "nibble" },
    from: { type: "string", default: "pool:0" },
    dir: { type: "string" },
    name: { type: "string" },
    envfile: { type: "string", default: "lean-grazer.json" },
    held: { type: "string", default: "inland-01,inland-06,inland-12,inland-15,inland-21,inland-22,inland-23,l-wait" },
    library: { type: "string", default: "lib-t.json" },
    seeds: { type: "string", default: "32" },
    eps: { type: "string", default: "0.0005" }, // half a unit in the third decimal
    copies: { type: "string", default: "4" },
    threads: { type: "string", default: "2" },
  },
});
const pool = existsSync("public/pool.json") ? parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries : null;
let envs: EnvSpec[];
let learner: Learner;
let library: Library = {};
if (values.dir) {
  const read = (f: string) => JSON.parse(readFileSync(`${values.dir}/${f}`, "utf8"));
  const ids = values.held!.split(",");
  envs = (read(values.envfile!) as { id: string }[]).filter((e) => ids.includes(e.id)).map((e) => checkEnv(e, "ecosystem", 0) as EnvSpec);
  library = parseLibrary(read(values.library!));
  const c = parseCreatureFile(readFileSync(`${values.dir}/${values.name}.json`, "utf8"));
  if (typeof c === "string") throw new Error(c);
  learner = { plan: c.plan, genome: Float32Array.from(c.genome) };
} else {
  envs = [envById(values.env!)!];
  const [kind, arg] = values.from!.split(":");
  learner = kind === "pool" ? poolLearner(envs[0]!, pool![Number(arg)]!) : randomLearner(envs[0]!, Number(arg));
}
const seeds = heldSeeds(Number(values.seeds));
const eps = Number(values.eps);
const rng = createRng(99);
const genomes = [learner.genome, ...Array.from({ length: Number(values.copies) }, () => Float32Array.from(learner.genome, (v) => v + eps * (2 * rng.next() - 1)))];
const helpers = createNodeRlPool({ envs, plan: learner.plan, pool, library }, Number(values.threads));
const tasks = genomes.flatMap((genome) => envs.flatMap((_, env) => seeds.map((seed) => ({ env, genome, seed }))));
const r = await helpers.rewards(tasks);
helpers.close();
const per = envs.length * seeds.length;
const rows = genomes.map((_, g) => r.slice(g * per, (g + 1) * per));
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a: number[]) => Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2)));
console.log(`${values.name ?? `${values.env} ${values.from}`}: ${envs.length} envs x ${seeds.length} seeds, eps ${eps}; base mean ${mean(rows[0]!).toFixed(3)}, per-episode sd ${sd(rows[0]!).toFixed(3)}`);
for (let g = 1; g < rows.length; g++) {
  const d = rows[g]!.map((v, i) => v - rows[0]![i]!);
  console.log(`copy ${g}: mean ${mean(rows[g]!).toFixed(3)} (diff ${mean(d).toFixed(3)}), episodes changed ${d.filter((x) => Math.abs(x) > 1e-9).length}/${per}, sd of per-episode diff ${sd(d).toFixed(3)}`);
}
