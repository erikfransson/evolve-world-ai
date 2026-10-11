// Times RL episodes per env and fingerprints the results, to check optimisations leave them identical.
// Usage: nice -n 10 node src/rlBench.ts [--seeds 6] [--reps 3] [--env id] [--prof]
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePool } from "./sim/seedPool.ts";
import { poolLearner, randomLearner, runEpisode } from "./sim/rl/env.ts";
import type { EpisodeResult, Learner } from "./sim/rl/env.ts";
import { ENVS } from "./sim/rl/envs.ts";

// parameters
const { values } = parseArgs({ options: { seeds: { type: "string", default: "6" }, reps: { type: "string", default: "3" }, env: { type: "string" } } });
const seeds = Array.from({ length: Number(values.seeds) }, (_, k) => 1000 + k);
const reps = Number(values.reps);

const pool = existsSync("public/pool.json") ? parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries : null;
if (!pool) throw new Error("public/pool.json missing");
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }; // CPU time, steady under machine load
let hash = 0;
const mix = (x: number) => {
  const b = new Float64Array([x]);
  const u = new Uint32Array(b.buffer);
  hash = (Math.imul(hash ^ u[0]!, 16777619) ^ u[1]!) >>> 0;
  hash = Math.imul(hash, 16777619) >>> 0;
};

console.log("env".padEnd(16), "learner".padEnd(8), "ms/episode (median of reps)");
let total = 0;
for (const env of ENVS) {
  if (values.env && env.id !== values.env) continue;
  const learners: [string, Learner][] = [["pool:39", poolLearner(env, pool[39]!)], ["random", randomLearner(env, 7)]];
  for (const [name, learner] of learners) {
    const times: number[] = [];
    for (let rep = 0; rep < reps + 1; rep++) { // first rep warms the JIT and is dropped
      const t0 = cpuMs();
      const results: EpisodeResult[] = seeds.map((s) => runEpisode(env, learner, s, pool));
      if (rep > 0) times.push((cpuMs() - t0) / seeds.length);
      if (rep === 0) for (const r of results) [r.reward, r.food, r.kills, r.seconds, r.energy].forEach(mix);
    }
    const ms = median(times);
    total += ms;
    console.log(env.id.padEnd(16), name.padEnd(8), ms.toFixed(2));
  }
}
console.log("sum of medians", total.toFixed(2), "ms; result fingerprint", hash);
