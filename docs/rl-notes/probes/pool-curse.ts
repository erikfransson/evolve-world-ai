// T2 probe: winner's curse in the lab founder pools (agg lab rlTrain --poolOut). The pool is the top K of 3K variants ranked on the
// same held-out seeds that report it, so its scores are biased upward. This scores the pool entries and the trained creature on those
// seeds again (set A, HELD_BASE + k) and on fresh ones (set B), on the run's fixed held-out envs.
// Usage (from src/typescript): node ../../docs/rl-notes/probes/pool-curse.ts --dir <lab runs/agg> --name lg8 [--seeds 12] [--threads 2]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { checkEnv } from "../../../src/typescript/src/sim/rl/env.ts";
import { parseCreatureFile } from "../../../src/typescript/src/sim/rl/creatureFile.ts";
import { parseLibrary } from "../../../src/typescript/src/sim/rl/library.ts";
import { HELD_BASE, heldSeeds, scoreGenomes } from "../../../src/typescript/src/sim/rl/trainer.ts";
import { createNodeRlPool } from "../../../src/typescript/src/worker/nodePool.ts";

// parameters
const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    name: { type: "string", default: "lg8" },
    envfile: { type: "string", default: "lean-grazer.json" },
    held: { type: "string", default: "inland-01,inland-06,inland-12,inland-15,inland-21,inland-22,inland-23,l-wait" }, // from the run's log
    library: { type: "string", default: "lib-t.json" },
    seeds: { type: "string", default: "12" },
    entries: { type: "string", default: "30" },
    threads: { type: "string", default: "2" },
  },
});
const dir = values.dir!;
const read = (f: string) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
const ids = values.held!.split(",");
const envs = (read(values.envfile!) as { id: string }[]).filter((e) => ids.includes(e.id)).map((e) => {
  const c = checkEnv(e, "ecosystem", 0);
  if (typeof c === "string") throw new Error(`${e.id}: ${c}`);
  return c;
});
const library = parseLibrary(read(values.library!));
const creature = parseCreatureFile(readFileSync(`${dir}/${values.name}.json`, "utf8"));
if (typeof creature === "string") throw new Error(creature);
const pool = read(`${values.name}-pool.json`) as { plan: unknown; entries: { held: number; genome: number[] }[] };
const entries = pool.entries.slice(0, Number(values.entries));
const genomes = [Float32Array.from(creature.genome), ...entries.map((e) => Float32Array.from(e.genome))];
const S = Number(values.seeds);
const setA = heldSeeds(S);
const setB = Array.from({ length: S }, (_, k) => HELD_BASE + 20000 + k);
const helpers = createNodeRlPool({ envs, plan: creature.plan, pool: null, library }, Number(values.threads));
const t0 = performance.now();
const a = (await scoreGenomes(helpers, envs.length, genomes, setA)).map((s) => s.mean);
const b = (await scoreGenomes(helpers, envs.length, genomes, setB)).map((s) => s.mean);
helpers.close();
const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
console.log(`${values.name}: ${envs.length} envs (${envs.map((e) => e.id).join(",")}), ${S} seeds per set, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
console.log(`creature (theta, stored): A ${a[0]!.toFixed(3)} B ${b[0]!.toFixed(3)}; training log said ${creature.training?.heldEnd ?? "?"}`);
console.log(`pool entries: recorded A ${mean(entries.map((e) => e.held)).toFixed(3)} (${entries[0]!.held} .. ${entries.at(-1)!.held}); re-scored A ${mean(a.slice(1)).toFixed(3)}; fresh B ${mean(b.slice(1)).toFixed(3)} (min ${Math.min(...b.slice(1)).toFixed(3)} max ${Math.max(...b.slice(1)).toFixed(3)})`);
console.log(`entries beating theta on B: ${b.slice(1).filter((v) => v > b[0]!).length}/${entries.length}`);
console.log(`per entry (recorded A, re-scored A, B): ${entries.map((e, i) => `${e.held.toFixed(2)}/${a[i + 1]!.toFixed(2)}/${b[i + 1]!.toFixed(2)}`).join(" ")}`);
