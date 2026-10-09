// Headless runner: evolves for N generations and writes one JSON line per generation.
// Usage: node src/headless.ts --generations 50 --out runs/run.jsonl [--seed 3] [--config overrides.json]

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_CONFIG, withOverrides } from "./sim/config.ts";
import type { SimConfig } from "./sim/config.ts";
import { Evolution } from "./sim/evolution.ts";

// parameters
const { values } = parseArgs({
  options: {
    generations: { type: "string" },
    out: { type: "string" },
    seed: { type: "string" },
    config: { type: "string" },
  },
});
const generations = Number(values.generations);
if (values.generations === undefined || !Number.isInteger(generations) || generations <= 0) {
  console.error("error: --generations must be a positive integer");
  process.exit(1);
}
if (values.out === undefined) {
  console.error("error: --out is required");
  process.exit(1);
}
const outPath = resolve(values.out);

let seed: number | undefined;
if (values.seed !== undefined) {
  if (!/^-?\d+$/.test(values.seed)) {
    console.error(`error: --seed must be an integer, got "${values.seed}"`);
    process.exit(1);
  }
  seed = Number(values.seed);
}

let config: SimConfig;
try {
  const overrides = values.config ? JSON.parse(readFileSync(values.config, "utf8")) : {};
  config = withOverrides(DEFAULT_CONFIG, seed === undefined ? overrides : { ...overrides, seed });
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ type: "config", config }) + "\n");

const evolution = new Evolution(config);
for (let i = 0; i < generations; i++) {
  const start = performance.now();
  const { result } = evolution.runGeneration();
  const seconds = (performance.now() - start) / 1000;
  const line = {
    type: "generation",
    generation: result.generation,
    layoutSeed: result.layoutSeed,
    bestFitness: result.bestFitness,
    meanFitness: result.meanFitness,
    bestEver: evolution.bestEver,
    seconds,
  };
  appendFileSync(outPath, JSON.stringify(line) + "\n");
  console.log(
    `gen ${result.generation}: best ${result.bestFitness.toFixed(2)} mean ${result.meanFitness.toFixed(2)} bestEver ${evolution.bestEver.toFixed(2)} (${seconds.toFixed(2)}s)`,
  );
}
