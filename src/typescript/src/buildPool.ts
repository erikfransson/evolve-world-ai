// Seed pool builder (#11): Trials evolutions over a spread of body plans and worlds, then a diverse set of the good creatures
// is written as the Ecosystem's seed pool. One run per task, runs spread over worker threads.
// With --refine, the entries of earlier pool files are also fine-tuned, each in its own training world, from a population of its mutated copies.
// Usage: node src/buildPool.ts [--refine a.json,b.json] [--runs 144] [--generations 200] [--pop 200] [--size 120] [--threads 6] [--seed 1] [--out public/pool.json]

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { layerSizes, randomGenome } from "./sim/brain.ts";
import { DEFAULT_CONFIG, memoryUnits, withOverrides } from "./sim/config.ts";
import { DEFAULT_ECO_CONFIG } from "./sim/ecoConfig.ts";
import type { DeepPartial, SimConfig } from "./sim/config.ts";
import { Episode } from "./sim/episode.ts";
import { Evolution } from "./sim/evolution.ts";
import { mutate } from "./sim/ga.ts";
import { createRng, deriveSeed } from "./sim/rng.ts";
import { POOL_VERSION, parsePool } from "./sim/seedPool.ts";
import { planOf } from "./sim/sensors.ts";
import type { BodyPlan } from "./sim/sensors.ts";

// parameters
// Spans the Ecosystem plan ranges (ecoConfig.ts) end to end, so founders differ in kind and compete.
const GRID = {
  rayCount: [2, 3, 4, 6, 8, 12, 16],
  spreadDeg: [20, 45, 90, 180, 270, 360],
  rayLength: [50, 80, 120, 170, 250],
  hiddenLayers: [[4], [8], [16], [32], [8, 8], [16, 16], [32, 32], [12, 12, 12], [8, 8, 8, 8]],
  memory: [0, 0.125, 0.25, 0.5, 1], // brain.memory: 0, 1 + 1, 2 + 2, 4 + 4, 8 + 8 units
  food: [0.25, 0.5, 0.8, 1.2], // Trials start densities
  poison: [0, 0.1, 0.25, 0.4],
  respawn: [false, true], // finite food, or eaten items reappear elsewhere
  foodEnergy: [10, 20, 40],
  worldScale: [0.75, 1, 1.5], // of the 1600 x 1000 Trials world, same densities
  poisonDamage: [100, 100, 40], // energy per poison item, 100 (POISON_LETHAL) kills
};
// Trials with the Ecosystem's creature (start energy, costs, physics), since the founders live there; rays never see creatures here.
const BASE = withOverrides(DEFAULT_CONFIG, { creature: { ...DEFAULT_ECO_CONFIG.creature, seesCreatures: false } });
const LIFE_CAP = 300; // s; Trials maxLifeSeconds, bounds respawn worlds where good creatures never starve
const CANDIDATES = 8; // fittest distinct genomes of a run's last generation that are validated
const KEEP_PER_RUN = 3; // validated candidates a run may pass to the final selection
const VALIDATION_LAYOUTS = 6; // held-out layouts each candidate is scored on
const BASELINE_GENOMES = 16; // random genomes of the run's plan scored on the same layouts
const SATURATED = 0.95; // refine skips a start that validates at this share of LIFE_CAP or more
const STALL_GENERATIONS = 50; // a run whose fittest creature still validates below MIN_GAIN x baseline here stops
const MIN_GAIN = 1.5; // a kept creature lives at least this times as long as the random baseline
const DECIMALS = 3; // genome rounding in the file; validation uses the rounded genomes

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "144" },
    generations: { type: "string", default: "200" },
    pop: { type: "string", default: "200" },
    size: { type: "string", default: "120" }, // creatures in the pool
    threads: { type: "string", default: "6" },
    seed: { type: "string", default: "1" },
    out: { type: "string", default: "public/pool.json" },
    refine: { type: "string" }, // comma-separated pool files
  },
});

interface Task {
  index: number;
  seed: number;
  generations: number;
  overrides: DeepPartial<SimConfig>;
  start?: number[]; // refine: the genome the population starts from
  run?: number; // refine: the entry's original run label, kept so siblings stay recognisable
}
interface World {
  food: number;
  poison: number;
  respawn: boolean;
  foodEnergy: number;
  scale: number;
  poisonDamage: number;
}
interface Candidate {
  run: number;
  plan: BodyPlan;
  world: World;
  fitness: number; // validated
  speed: number; // mean speed on the validation layouts, units/s
  turn: number; // mean |turn rate|, radians/s
  genome: number[]; // rounded
}
interface RunResult {
  index: number;
  baseline: number;
  generations: number;
  bestEver: number;
  lastMean: number;
  seconds: number;
  candidates: Candidate[];
}

const scale = 10 ** DECIMALS;
const round = (v: number, s = scale): number => Math.round(v * s) / s;

// Mean survival on the held-out layouts of a run, with the creature's mean speed and turn rate there.
function validate(config: SimConfig, genome: Float32Array, seed: number): { fitness: number; speed: number; turn: number } {
  let fitness = 0;
  let ticks = 0;
  let speed = 0;
  let turn = 0;
  for (let k = 0; k < VALIDATION_LAYOUTS; k++) {
    const e = new Episode(config, genome, deriveSeed(seed, 0x7a11d, k), 0);
    while (!e.done) {
      e.step();
      speed += Math.hypot(e.state.vx, e.state.vy);
      turn += Math.abs(e.state.turnRate);
      ticks++;
    }
    fitness += e.fitness() / VALIDATION_LAYOUTS;
  }
  return { fitness, speed: speed / ticks, turn: turn / ticks };
}

async function runTask(task: Task): Promise<RunResult> {
  const t0 = performance.now();
  const config = withOverrides(BASE, { ...task.overrides, seed: task.seed });
  const rng = createRng(deriveSeed(task.seed, 0xba5e));
  let baseline = 0;
  for (let k = 0; k < BASELINE_GENOMES; k++) baseline += validate(config, randomGenome(layerSizes(config), rng), task.seed).fitness / BASELINE_GENOMES;
  const seen = new Set<string>();
  const plan = planOf(config);
  const w = config.world;
  const world = { food: w.foodDensity, poison: w.poisonDensity, respawn: w.respawn, foodEnergy: w.foodEnergy, scale: round(w.width / BASE.world.width, 100), poisonDamage: w.poisonDamage };
  const candidates: Candidate[] = [];
  if (task.start) {
    // The starting genome competes too, so fine-tuning never loses a creature.
    seen.add(task.start.join(","));
    candidates.push({ run: task.run ?? task.index, plan, world, ...validate(config, Float32Array.from(task.start), task.seed), genome: task.start });
  }
  const finish = (generations: number, bestEver: number, lastMean: number): RunResult => ({
    index: task.index,
    baseline,
    generations,
    bestEver,
    lastMean,
    seconds: (performance.now() - t0) / 1000,
    candidates: candidates.sort((a, b) => b.fitness - a.fitness).filter((c) => c.fitness >= MIN_GAIN * baseline).slice(0, task.start ? 1 : KEEP_PER_RUN),
  });
  // Merge only, or a start already near the life cap, where fine-tuning has nothing left to gain.
  if (task.generations === 0 || (task.start && candidates[0]!.fitness >= SATURATED * LIFE_CAP)) return finish(0, 0, 0);
  const evolution = new Evolution(config);
  if (task.start) {
    // Copy 0 unchanged, the others mutated like children.
    const mrng = createRng(deriveSeed(task.seed, 0x5eed));
    for (let i = 0; i < config.population.size; i++) {
      const genome = evolution.population.genome(i);
      genome.set(task.start);
      if (i) mutate(genome, config.ga.mutationRate, config.ga.mutationStd, mrng);
    }
  }
  let last = await evolution.runGeneration();
  let g = 1;
  for (; g < task.generations; g++) {
    if (g === STALL_GENERATIONS && validate(config, last.population.genome(last.result.bestIndex), task.seed).fitness < MIN_GAIN * baseline) break; // a world this hard stays hopeless
    last = await evolution.runGeneration();
  }
  const { population, result } = last;
  const order = Array.from({ length: population.size }, (_, i) => i).sort((a, b) => result.fitness[b]! - result.fitness[a]!);
  for (const i of order) {
    if (candidates.length >= CANDIDATES) break;
    const genome = Array.from(population.genome(i), (v) => round(v));
    const key = genome.join(",");
    if (seen.has(key)) continue; // elites and unmutated children repeat genomes
    seen.add(key);
    candidates.push({ run: task.run ?? task.index, plan, world, ...validate(config, Float32Array.from(genome), task.seed), genome });
  }
  return finish(g, evolution.bestEver, result.meanFitness);
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
    if (!Number.isInteger(v) || v < (name === "seed" || name === "runs" || name === "generations" ? 0 : 1)) {
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
  const cols = {
    rayCount: column(GRID.rayCount),
    spread: column(GRID.spreadDeg),
    length: column(GRID.rayLength),
    hidden: column(GRID.hiddenLayers),
    memory: column(GRID.memory),
    food: column(GRID.food),
    poison: column(GRID.poison),
    respawn: column(GRID.respawn),
    foodEnergy: column(GRID.foodEnergy),
    scale: column(GRID.worldScale),
    poisonDamage: column(GRID.poisonDamage),
  };
  const { width, height } = BASE.world;
  const sweep: Task[] = Array.from({ length: runs }, (_, i) => ({
    index: i,
    seed: deriveSeed(seed, i),
    generations,
    overrides: {
      population: { size: pop },
      world: {
        foodDensity: cols.food[i]!,
        poisonDensity: cols.poison[i]!,
        respawn: cols.respawn[i]!,
        foodEnergy: cols.foodEnergy[i]!,
        width: Math.round(width * cols.scale[i]!),
        height: Math.round(height * cols.scale[i]!),
        poisonDamage: cols.poisonDamage[i]!,
      },
      creature: {
        rayCount: cols.rayCount[i]!,
        raySpread: Math.min(2 * Math.PI, round((cols.spread[i]! * Math.PI) / 180, 1e4)),
        rayLength: cols.length[i]!,
        maxLifeSeconds: LIFE_CAP,
      },
      brain: { hiddenLayers: cols.hidden[i]!.slice(), memory: cols.memory[i]! },
    },
  }));

  // Fine-tuning tasks; entries of older files lack the world fields added later and get the defaults they were trained with.
  const refine: Task[] = [];
  const label = (file: number, run: number): number => (run >= 1000 ? run : 1000 * (file + 1) + run); // file number, then its run; merged labels stay
  for (const [fi, file] of (values.refine?.split(",") ?? []).entries()) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const { entries } = parsePool(data);
    entries.forEach((e, k) => {
      const raw = data.entries[k].world;
      const units = e.plan.memoryShort + e.plan.memoryLong;
      const memory = units / 16;
      const m = memoryUnits(memory);
      if (m.short !== e.plan.memoryShort || m.long !== e.plan.memoryLong) return void console.warn(`${file} entry ${k}: memory split not reachable, skipped`);
      const s = raw.scale ?? 1;
      refine.push({
        index: runs + refine.length,
        seed: deriveSeed(seed, 0xf1e, runs + refine.length),
        generations,
        start: Array.from(e.genome, (v) => round(v)),
        run: label(fi, data.entries[k].run ?? k),
        overrides: {
          population: { size: pop },
          world: { foodDensity: e.world.food, poisonDensity: e.world.poison, respawn: raw.respawn ?? false, foodEnergy: raw.foodEnergy ?? 20, width: Math.round(width * s), height: Math.round(height * s), poisonDamage: raw.poisonDamage ?? BASE.world.poisonDamage },
          creature: { rayCount: e.plan.rayCount, raySpread: e.plan.raySpread, rayLength: e.plan.rayLength, maxLifeSeconds: LIFE_CAP },
          brain: { hiddenLayers: e.plan.hiddenLayers.slice(), memory },
        },
      });
    });
  }
  const tasks = [...refine, ...sweep]; // refine first: its tasks are the longest
  const total = tasks.length;
  if (!total) {
    console.error("error: nothing to do, give --runs or --refine");
    process.exit(1);
  }

  const t0 = performance.now();
  const results: RunResult[] = [];
  await new Promise<void>((done) => {
    let next = 0;
    const workers = Array.from({ length: Math.min(threads, total) }, () => new Worker(new URL(import.meta.url)));
    const feed = (w: Worker): void => {
      if (next < tasks.length) w.postMessage(tasks[next++]);
      else void w.terminate();
    };
    for (const w of workers) {
      w.on("message", (r: RunResult) => {
        results.push(r);
        const t = tasks.find((x) => x.index === r.index)!;
        const p = t.overrides;
        const scaleOf = p.world!.width! / width;
        console.log(
          `${t.start ? "refine" : "run"} ${r.index} (${results.length}/${total}): rays ${p.creature!.rayCount} spread ${Math.round((p.creature!.raySpread! * 180) / Math.PI)}° length ${p.creature!.rayLength} hidden ${p.brain!.hiddenLayers!.join("+")} memory ${p.brain!.memory} food ${p.world!.foodDensity} poison ${p.world!.poisonDensity} ` +
            `respawn ${p.world!.respawn} energy ${p.world!.foodEnergy} poison damage ${p.world!.poisonDamage} scale ${round(scaleOf, 100)} | ` +
            `${r.generations} gens, baseline ${r.baseline.toFixed(1)} s, last mean ${r.lastMean.toFixed(1)} s, validated ${r.candidates.map((c) => `${c.fitness.toFixed(1)} (v ${c.speed.toFixed(0)}, w ${c.turn.toFixed(2)})`).join(" ") || "none"} (${r.seconds.toFixed(0)} s)`,
        );
        if (results.length === total) done();
        feed(w);
      });
      w.on("error", (e) => {
        console.error(e);
        process.exit(1);
      });
      feed(w);
    }
  });

  // Farthest-point selection in normalised plan, world and behaviour space, starting from the fittest; fitness breaks ties.
  const span = (xs: readonly number[]): [number, number] => [Math.min(...xs), Math.max(...xs)];
  const all = results.flatMap((r) => r.candidates).sort((a, b) => b.fitness - a.fitness);
  const neurons = GRID.hiddenLayers.map((h) => h.reduce((a, b) => a + b, 0));
  const axes: [(c: Candidate) => number, [number, number], number][] = [
    [(c) => c.plan.rayCount, span(GRID.rayCount), 1],
    [(c) => (c.plan.raySpread * 180) / Math.PI, span(GRID.spreadDeg), 1],
    [(c) => c.plan.rayLength, span(GRID.rayLength), 1],
    [(c) => c.plan.hiddenLayers.reduce((a, b) => a + b, 0), span(neurons), 1],
    [(c) => c.plan.hiddenLayers.length, [1, 4], 0.5],
    [(c) => c.plan.memoryShort + c.plan.memoryLong, [0, 16], 1],
    [(c) => c.world.food, span(GRID.food), 0.5],
    [(c) => c.world.poison, span(GRID.poison), 0.5],
    [(c) => Number(c.world.respawn), [0, 1], 0.5],
    [(c) => c.world.foodEnergy, span(GRID.foodEnergy), 0.5],
    [(c) => c.world.scale, span(GRID.worldScale), 0.5],
    [(c) => c.world.poisonDamage, span(GRID.poisonDamage), 0.5],
    [(c) => c.speed, span(all.map((c) => c.speed)), 1],
    [(c) => c.turn, span(all.map((c) => c.turn)), 1],
  ];
  const point = (c: Candidate): number[] => axes.map(([f, [lo, hi], w]) => (w * (f(c) - lo)) / (hi - lo || 1));
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
    speed: round(c.speed, 10),
    turn: round(c.turn, 100),
    run: c.run,
    genome: c.genome,
  }));
  const command = `node src/buildPool.ts ${process.argv.slice(2).join(" ")}`.trim();
  writeFileSync(outPath, JSON.stringify({ version: POOL_VERSION, command, entries }) + "\n");

  const minutes = (performance.now() - t0) / 60000;
  const fit = chosen.map((c) => c.fitness);
  const planKey = (c: Candidate): string => JSON.stringify(c.plan);
  const count = <T>(xs: T[]): string => [...new Set(xs)].sort().map((v) => `${v}:${xs.filter((x) => x === v).length}`).join(" ");
  console.log(`candidates ${all.length} from ${results.filter((r) => r.candidates.length).length}/${total} tasks; pool ${chosen.length} creatures, ${new Set(chosen.map(planKey)).size} distinct plans`);
  if (chosen.length) {
    console.log(`fitness ${Math.min(...fit).toFixed(1)} to ${Math.max(...fit).toFixed(1)} s (median ${fit.slice().sort((a, b) => a - b)[fit.length >> 1]!.toFixed(1)}); random baselines ${Math.min(...results.map((r) => r.baseline)).toFixed(1)} to ${Math.max(...results.map((r) => r.baseline)).toFixed(1)} s`);
    console.log(`rays ${count(chosen.map((c) => c.plan.rayCount))}`);
    console.log(`hidden ${count(chosen.map((c) => c.plan.hiddenLayers.join("+")))}; memory ${count(chosen.map((c) => c.plan.memoryShort + c.plan.memoryLong))}`);
    console.log(`respawn ${count(chosen.map((c) => c.world.respawn))}; food energy ${count(chosen.map((c) => c.world.foodEnergy))}; scale ${count(chosen.map((c) => c.world.scale))}; poison damage ${count(chosen.map((c) => c.world.poisonDamage))}`);
    const spd = chosen.map((c) => c.speed);
    console.log(`speed ${Math.min(...spd).toFixed(0)} to ${Math.max(...spd).toFixed(0)} units/s; turn ${Math.min(...chosen.map((c) => c.turn)).toFixed(2)} to ${Math.max(...chosen.map((c) => c.turn)).toFixed(2)} rad/s`);
  }
  console.log(`wrote ${outPath}: ${(statSync(outPath).size / 1024).toFixed(0)} KiB; ${minutes.toFixed(1)} min`);
  if (chosen.length < size) console.warn(`warning: only ${chosen.length} of ${size} wanted creatures passed validation`);
}
