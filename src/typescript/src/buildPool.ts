// Seed pool builder (#11): Trials evolutions over a spread of body plans and worlds, then a diverse set of the good creatures
// is written as the Ecosystem's seed pool. One run per task, runs spread over worker threads.
// Usage: node src/buildPool.ts [--runs 96] [--generations 60] [--pop 150] [--size 60] [--threads 4] [--seed 1] [--out public/pool.json]

import { statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { layerSizes, randomGenome } from "./sim/brain.ts";
import { DEFAULT_CONFIG, withOverrides } from "./sim/config.ts";
import type { DeepPartial, SimConfig } from "./sim/config.ts";
import { runEpisode } from "./sim/episode.ts";
import { Evolution } from "./sim/evolution.ts";
import { createRng, deriveSeed } from "./sim/rng.ts";
import { POOL_VERSION } from "./sim/seedPool.ts";
import { planOf } from "./sim/sensors.ts";
import type { BodyPlan } from "./sim/sensors.ts";

// parameters
const GRID = {
  rayCount: [3, 4, 5, 6, 8, 10, 12],
  spreadDeg: [45, 90, 135, 180, 270, 360],
  rayLength: [60, 80, 100, 140, 180, 240],
  hiddenLayers: [[8], [12], [16], [24], [8, 8], [12, 8]],
  memory: [0, 0.125, 0.25, 0.5], // brain.memory: 0, 1 + 1, 2 + 2, 4 + 4 units
  food: [0.5, 0.7, 1.0], // Trials start densities, finite food
  poison: [0.05, 0.1, 0.2],
};
const CANDIDATES = 8; // fittest distinct genomes of a run's last generation that are validated
const KEEP_PER_RUN = 3; // validated candidates a run may pass to the final selection
const VALIDATION_LAYOUTS = 6; // held-out layouts each candidate is scored on
const BASELINE_GENOMES = 16; // random genomes of the run's plan scored on the same layouts
const MIN_GAIN = 1.5; // a kept creature lives at least this times as long as the random baseline
const DECIMALS = 3; // genome rounding in the file; validation uses the rounded genomes

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "96" },
    generations: { type: "string", default: "60" },
    pop: { type: "string", default: "150" },
    size: { type: "string", default: "60" }, // creatures in the pool
    threads: { type: "string", default: "4" },
    seed: { type: "string", default: "1" },
    out: { type: "string", default: "public/pool.json" },
  },
});

interface Task {
  index: number;
  seed: number;
  generations: number;
  overrides: DeepPartial<SimConfig>;
}
interface Candidate {
  run: number;
  plan: BodyPlan;
  world: { food: number; poison: number };
  fitness: number; // validated
  genome: number[]; // rounded
}
interface RunResult {
  index: number;
  baseline: number;
  bestEver: number;
  lastMean: number;
  seconds: number;
  candidates: Candidate[];
}

const scale = 10 ** DECIMALS;
const round = (v: number, s = scale): number => Math.round(v * s) / s;

// Mean survival on the held-out layouts of a run.
function validate(config: SimConfig, genome: Float32Array, seed: number): number {
  let sum = 0;
  for (let k = 0; k < VALIDATION_LAYOUTS; k++) sum += runEpisode(config, genome, deriveSeed(seed, 0x7a11d, k), 0);
  return sum / VALIDATION_LAYOUTS;
}

async function runTask(task: Task): Promise<RunResult> {
  const t0 = performance.now();
  const config = withOverrides(DEFAULT_CONFIG, { ...task.overrides, seed: task.seed });
  const evolution = new Evolution(config);
  let last = await evolution.runGeneration();
  for (let g = 1; g < task.generations; g++) last = await evolution.runGeneration();
  const { population, result } = last;
  const order = Array.from({ length: population.size }, (_, i) => i).sort((a, b) => result.fitness[b]! - result.fitness[a]!);
  const seen = new Set<string>();
  const plan = planOf(config);
  const world = { food: config.world.foodDensity, poison: config.world.poisonDensity };
  const candidates: Candidate[] = [];
  for (const i of order) {
    if (candidates.length >= CANDIDATES) break;
    const genome = Array.from(population.genome(i), (v) => round(v));
    const key = genome.join(",");
    if (seen.has(key)) continue; // elites and unmutated children repeat genomes
    seen.add(key);
    candidates.push({ run: task.index, plan, world, fitness: validate(config, Float32Array.from(genome), task.seed), genome });
  }
  const rng = createRng(deriveSeed(task.seed, 0xba5e));
  let baseline = 0;
  for (let k = 0; k < BASELINE_GENOMES; k++) baseline += validate(config, randomGenome(layerSizes(config), rng), task.seed) / BASELINE_GENOMES;
  candidates.sort((a, b) => b.fitness - a.fitness);
  return {
    index: task.index,
    baseline,
    bestEver: evolution.bestEver,
    lastMean: result.meanFitness,
    seconds: (performance.now() - t0) / 1000,
    candidates: candidates.filter((c) => c.fitness >= MIN_GAIN * baseline).slice(0, KEEP_PER_RUN),
  };
}

if (!isMainThread) {
  parentPort!.on("message", (task: Task) => void runTask(task).then((r) => parentPort!.postMessage(r)));
} else {
  const runs = Number(values.runs);
  const generations = Number(values.generations);
  const pop = Number(values.pop);
  const size = Number(values.size);
  const threads = Number(values.threads);
  const seed = Number(values.seed);
  for (const [name, v] of Object.entries({ runs, generations, pop, size, threads, seed })) {
    if (!Number.isInteger(v) || v < (name === "seed" ? 0 : 1)) {
      console.error(`error: --${name} must be a positive integer`);
      process.exit(1);
    }
  }
  const outPath = resolve(values.out!);

  // Each grid value appears about equally often over the runs, in a shuffled combination (a Latin-hypercube style sample).
  const rng = createRng(deriveSeed(seed, 0x9001));
  const column = <T>(choices: readonly T[]): T[] => {
    const c = Array.from({ length: runs }, (_, i) => choices[i % choices.length]!);
    for (let i = c.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [c[i], c[j]] = [c[j]!, c[i]!];
    }
    return c;
  };
  const cols = { rayCount: column(GRID.rayCount), spread: column(GRID.spreadDeg), length: column(GRID.rayLength), hidden: column(GRID.hiddenLayers), memory: column(GRID.memory), food: column(GRID.food), poison: column(GRID.poison) };
  const tasks: Task[] = Array.from({ length: runs }, (_, i) => ({
    index: i,
    seed: deriveSeed(seed, i),
    generations,
    overrides: {
      population: { size: pop },
      world: { foodDensity: cols.food[i]!, poisonDensity: cols.poison[i]! },
      creature: { rayCount: cols.rayCount[i]!, raySpread: Math.min(2 * Math.PI, round((cols.spread[i]! * Math.PI) / 180, 1e4)), rayLength: cols.length[i]! },
      brain: { hiddenLayers: cols.hidden[i]!.slice(), memory: cols.memory[i]! },
    },
  }));

  const t0 = performance.now();
  const results: RunResult[] = [];
  await new Promise<void>((done) => {
    let next = 0;
    const workers = Array.from({ length: Math.min(threads, runs) }, () => new Worker(new URL(import.meta.url)));
    const feed = (w: Worker): void => {
      if (next < tasks.length) w.postMessage(tasks[next++]);
      else void w.terminate();
    };
    for (const w of workers) {
      w.on("message", (r: RunResult) => {
        results.push(r);
        const p = tasks[r.index]!.overrides;
        console.log(
          `run ${r.index} (${results.length}/${runs}): rays ${p.creature!.rayCount} spread ${cols.spread[r.index]}° length ${p.creature!.rayLength} hidden ${p.brain!.hiddenLayers!.join("+")} memory ${p.brain!.memory} food ${p.world!.foodDensity} poison ${p.world!.poisonDensity} | ` +
            `baseline ${r.baseline.toFixed(1)} s, last mean ${r.lastMean.toFixed(1)} s, validated ${r.candidates.map((c) => c.fitness.toFixed(1)).join(" ") || "none"} (${r.seconds.toFixed(0)} s)`,
        );
        if (results.length === runs) done();
        feed(w);
      });
      w.on("error", (e) => {
        console.error(e);
        process.exit(1);
      });
      feed(w);
    }
  });

  // Farthest-point selection in normalised plan and world space, starting from the fittest; fitness breaks ties.
  const span = (xs: readonly number[]): [number, number] => [Math.min(...xs), Math.max(...xs)];
  const neurons = GRID.hiddenLayers.map((h) => h.reduce((a, b) => a + b, 0));
  const axes: [(c: Candidate) => number, [number, number], number][] = [
    [(c) => c.plan.rayCount, span(GRID.rayCount), 1],
    [(c) => (c.plan.raySpread * 180) / Math.PI, span(GRID.spreadDeg), 1],
    [(c) => c.plan.rayLength, span(GRID.rayLength), 1],
    [(c) => c.plan.hiddenLayers.reduce((a, b) => a + b, 0), span(neurons), 1],
    [(c) => c.plan.hiddenLayers.length, [1, 2], 0.5],
    [(c) => c.plan.memoryShort + c.plan.memoryLong, [0, 8], 1],
    [(c) => c.world.food, span(GRID.food), 0.5],
    [(c) => c.world.poison, span(GRID.poison), 0.5],
  ];
  const point = (c: Candidate): number[] => axes.map(([f, [lo, hi], w]) => (w * (f(c) - lo)) / (hi - lo || 1));
  const all = results.flatMap((r) => r.candidates).sort((a, b) => b.fitness - a.fitness);
  const points = all.map(point);
  const minDist = all.map(() => Infinity);
  const picked: number[] = [];
  while (picked.length < Math.min(size, all.length)) {
    let best = -1;
    for (let i = 0; i < all.length; i++) {
      if (picked.includes(i)) continue;
      if (best < 0 || minDist[i]! > minDist[best]! + 1e-9) best = i; // all is fittest first, so ties keep the fitter
    }
    picked.push(best);
    for (let i = 0; i < all.length; i++) minDist[i] = Math.min(minDist[i]!, Math.hypot(...points[i]!.map((v, k) => v - points[best]![k]!)));
  }
  const chosen = picked.map((i) => all[i]!);
  const entries = chosen.map((c) => ({
    plan: c.plan,
    world: c.world,
    fitness: round(c.fitness, 10),
    run: c.run,
    genome: c.genome,
  }));
  const command = `node src/buildPool.ts ${process.argv.slice(2).join(" ")}`.trim();
  writeFileSync(outPath, JSON.stringify({ version: POOL_VERSION, command, entries }) + "\n");

  const minutes = (performance.now() - t0) / 60000;
  const fit = chosen.map((c) => c.fitness);
  const planKey = (c: Candidate): string => JSON.stringify(c.plan);
  const count = <T>(xs: T[]): string => [...new Set(xs)].sort().map((v) => `${v}:${xs.filter((x) => x === v).length}`).join(" ");
  console.log(`candidates ${all.length} from ${results.filter((r) => r.candidates.length).length}/${runs} runs; pool ${chosen.length} creatures, ${new Set(chosen.map(planKey)).size} distinct plans`);
  console.log(`fitness ${Math.min(...fit).toFixed(1)} to ${Math.max(...fit).toFixed(1)} s (median ${fit.slice().sort((a, b) => a - b)[fit.length >> 1]!.toFixed(1)}); random baselines ${Math.min(...results.map((r) => r.baseline)).toFixed(1)} to ${Math.max(...results.map((r) => r.baseline)).toFixed(1)} s`);
  console.log(`rays ${count(chosen.map((c) => c.plan.rayCount))}`);
  console.log(`hidden ${count(chosen.map((c) => c.plan.hiddenLayers.join("+")))}; memory ${count(chosen.map((c) => c.plan.memoryShort + c.plan.memoryLong))}`);
  console.log(`wrote ${outPath}: ${(statSync(outPath).size / 1024).toFixed(0)} KiB; ${minutes.toFixed(1)} min`);
  if (chosen.length < size) console.warn(`warning: only ${chosen.length} of ${size} wanted creatures passed validation`);
}
