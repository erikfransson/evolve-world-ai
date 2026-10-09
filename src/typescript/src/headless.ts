// Headless runner: evolves for N generations and writes one JSON line per generation.
// Usage: node src/headless.ts --generations 50 --out runs/run.jsonl [--seed 3] [--config overrides.json]

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_CONFIG } from "./sim/config.ts";
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

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

// Recursively merges over into base; arrays and scalars are replaced.
function deepMerge(base: Plain, over: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] = isPlain(value) && isPlain(current) ? deepMerge(current, value) : value;
  }
  return out;
}

const overrides: Plain = values.config ? JSON.parse(readFileSync(values.config, "utf8")) : {};
const merged = deepMerge(structuredClone(DEFAULT_CONFIG) as unknown as Plain, overrides);
const config = merged as unknown as SimConfig;
if (values.seed !== undefined) config.seed = Number(values.seed);

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
