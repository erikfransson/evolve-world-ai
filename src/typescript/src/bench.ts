// Benchmark: times generations at a given population and prints a fingerprint of the results.
// Usage: node src/bench.ts [--pop 1000] [--gens 3] [--seed 1] [--threads N]   (threads 1 = serial)

import { parseArgs } from "node:util";
import { DEFAULT_CONFIG, withOverrides } from "./sim/config.ts";
import { Evolution } from "./sim/evolution.ts";
import { createNodeEvaluator, parseThreads } from "./worker/nodePool.ts";

// parameters
const { values } = parseArgs({
  options: {
    pop: { type: "string", default: "1000" },
    gens: { type: "string", default: "3" },
    seed: { type: "string", default: "1" },
    threads: { type: "string" },
  },
});
const pop = Number(values.pop);
const gens = Number(values.gens);
const seed = Number(values.seed);
let threads: number;
try {
  threads = parseThreads(values.threads);
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
for (const [name, v] of Object.entries({ pop, gens, seed })) {
  if (!Number.isInteger(v) || (name !== "seed" && v <= 0)) {
    console.error(`error: --${name} must be an integer${name === "seed" ? "" : " > 0"}`);
    process.exit(1);
  }
}

const config = withOverrides(DEFAULT_CONFIG, { seed, population: { size: pop } });
const evolution = new Evolution(config);
const evaluator = createNodeEvaluator(config, threads);
const seconds: number[] = [];
let fingerprint = 0; // depends on fitness only, so it is the same for every thread count
for (let g = 0; g < gens; g++) {
  const t0 = performance.now();
  const { result } = await evolution.runGeneration(evaluator);
  seconds.push((performance.now() - t0) / 1000);
  for (let i = 0; i < result.fitness.length; i++) fingerprint = (fingerprint * 31 + Math.round(result.fitness[i]! * 1000)) % 1_000_000_007;
}
evaluator.close();
const total = seconds.reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ pop, gens, seed, threads, secondsPerGen: seconds.map((s) => +s.toFixed(3)), total: +total.toFixed(3), fingerprint }));
