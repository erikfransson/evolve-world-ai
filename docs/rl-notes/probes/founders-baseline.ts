// Baselines for the Founders envs: mean seconds survived on held-out seeds by a still creature, random designs and each Live founder.
// Run from src/typescript: nice -n 19 node ../../docs/rl-notes/probes/founders-baseline.ts [--envs bloom-race,blight] [--seeds 32] [--randoms 4] [--over JSON]

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { genomeLength, layerSizes } from "../../../src/typescript/src/sim/brain.ts";
import { parseFounders } from "../../../src/typescript/src/live/founders.ts";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import type { PlanView } from "../../../src/typescript/src/sim/sensors.ts";
import { layoutConfig, randomLearner, runEpisode } from "../../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec, Learner } from "../../../src/typescript/src/sim/rl/env.ts";
import { ENVS } from "../../../src/typescript/src/sim/rl/envs.ts";
import { withFounders } from "../../../src/typescript/src/sim/rl/library.ts";
import { heldSeeds } from "../../../src/typescript/src/sim/rl/trainer.ts";

// parameters
const { values } = parseArgs({ options: { envs: { type: "string", default: "" }, seeds: { type: "string", default: "32" }, randoms: { type: "string", default: "4" }, over: { type: "string", default: "{}" } } }); // over: JSON of per-env field overrides for tuning, e.g. {"blight":{"learnerEnergy":120}}
const SEEDS = heldSeeds(Number(values.seeds));
const RANDOMS = Number(values.randoms);

const founders = parseFounders(JSON.parse(readFileSync("public/live-founders.json", "utf8")));
const library = withFounders({}, founders);
const pool = parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries;
const want = values.envs ? values.envs.split(",") : null;
const over = JSON.parse(values.over!) as Record<string, Partial<EnvSpec>>;
const envs: EnvSpec[] = ENVS.filter((e) => (want ? want.includes(e.id) : e.tags.includes("founders"))).map((e) => ({ ...e, ...over[e.id] }));

// A one-ray brain with all-zero weights: no thrust, no turn.
const STILL_PLAN: PlanView = { rayCount: 1, raySpread: 0, rayLength: 10, hiddenLayers: [1], memoryShort: 0, memoryLong: 0 };
const still: Learner = { plan: STILL_PLAN, genome: new Float32Array(genomeLength(layerSizes(layoutConfig("ecosystem"), STILL_PLAN))) };

const policies: [string, Learner][] = [["still", still], ...Array.from({ length: RANDOMS }, (_, k): [string, Learner] => [`random${k + 1}`, randomLearner({ world: "ecosystem", role: 0 }, k + 1)]), ...founders.map((f): [string, Learner] => [f.id, { plan: f.plan, genome: f.genome }])];

for (const env of envs) {
  const row: string[] = [];
  let ms = 0, eps = 0, randomSum = 0;
  for (const [name, learner] of policies) {
    let sec = 0, ceiling = 0;
    const t0 = performance.now();
    for (const seed of SEEDS) {
      const r = runEpisode(env, learner, seed, pool, library);
      sec += r.seconds / SEEDS.length;
      ceiling += (1 - r.died) / SEEDS.length;
    }
    ms += performance.now() - t0;
    eps += SEEDS.length;
    if (name.startsWith("random")) randomSum += sec / RANDOMS;
    else row.push(`${name} ${sec.toFixed(1)} (${Math.round(ceiling * 100)}% reach end)`);
  }
  row.splice(1, 0, `random ${randomSum.toFixed(1)}`);
  console.log(`${env.id} (${env.seconds} s): ${row.join(" | ")}; ${(ms / eps).toFixed(0)} ms/episode`);
}
