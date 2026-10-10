// Benchmark: times generations at a given population and prints a fingerprint of the results.
// Usage: node src/bench.ts [--pop 1000] [--gens 3] [--seed 1]

import { parseArgs } from "node:util";
import { DEFAULT_CONFIG, withOverrides } from "./sim/config.ts";
import { Evolution } from "./sim/evolution.ts";

// parameters
const { values } = parseArgs({
  options: { pop: { type: "string", default: "1000" }, gens: { type: "string", default: "3" }, seed: { type: "string", default: "1" } },
});
const pop = Number(values.pop);
const gens = Number(values.gens);
const seed = Number(values.seed);

const config = withOverrides(DEFAULT_CONFIG, { seed, population: { size: pop } });
const evolution = new Evolution(config);
const seconds: number[] = [];
let fingerprint = 0;
for (let g = 0; g < gens; g++) {
  const t0 = performance.now();
  const { result } = evolution.runGeneration();
  seconds.push((performance.now() - t0) / 1000);
  for (let i = 0; i < result.fitness.length; i++) fingerprint = (fingerprint * 31 + Math.round(result.fitness[i]! * 1000)) % 1_000_000_007;
}
const total = seconds.reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ pop, gens, seed, secondsPerGen: seconds.map((s) => +s.toFixed(3)), total: +total.toFixed(3), fingerprint }));
