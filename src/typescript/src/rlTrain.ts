// Fine-tunes one creature in an RL environment (#27) with evolution strategies, on worker threads.
// Usage: node src/rlTrain.ts --env nibble [--from pool:39 | random:1 | file:creature.json] [--iters 60] [--pairs 16] [--sigma 0.08]
//        [--lr 0.02] [--episodes 2] [--eval 16] [--every 10] [--vary 0] [--threads N] [--seed 1] [--out learner.json] [--library public/rl/library.json] [--save]
//        [--mix nibble,far-food,...] [--selfplay [--crowd 5,50] [--lineage 0] [--foodw 3] [--poisonw 0]] [--budget SECONDS]
// --poison W sets the cost per poison bite on every env; unset, envs without their own poison cost get 1 (the Arena ES default). Not with --selfplay.
// --mix rotates through the envs, one per iteration (all candidates on it). --selfplay (S1) trains on a new procedurally drawn crowded world every
// episode, the learner's genome playing half the bodies and the league (current weights, recent bests) the rest; the env is then ignored.
// --from founder:ID starts from a Live founder of public/live-founders.json, design:ID from a fixed design of sim/rl/designPanel.ts. --budget stops after that many wall seconds (after iters at the latest).
// --state FILE resumes from FILE when it exists and saves the training state there at the end (weights, Adam, rngs), so --iters is the target total;
// --ckpt 300,900 --ckpt-dir DIR writes DIR/<n>.json (a learner file for rlTransfer) the first iteration the run's cumulative process CPU seconds divided by the threads
// (training steps only, all threads) reach n; the run stops after the last one. --chunk SECONDS stops this invocation after that many wall seconds of steps.
// --state refuses to resume when the other settings (envs, --from, --seed, plan, --pairs --sigma --lr --episodes --vary --poison, selfplay) differ. A chunk killed before it ends leaves the last
// state, so the rerun repeats its iterations. --save needs a finite held-out start and end (a resumed run keeps the start of its first chunk).
// Each iteration scores 2 x pairs perturbed genomes on `episodes` fresh seeds; every `every` iterations the current genome is scored
// on `eval` held-out seeds no iteration trains on. --vary F plays every episode, held-out ones too, on a varied env (varied in env.ts). --save appends the result to the library under the env id, as a rival for later envs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parsePool } from "./sim/seedPool.ts";
import type { PoolEntry } from "./sim/seedPool.ts";
import { poolLearner, randomLearner, varied } from "./sim/rl/env.ts";
import type { EnvSpec, Learner, Library } from "./sim/rl/env.ts";
import { DEFAULT_POISON_COST, envById } from "./sim/rl/envs.ts";
import { KINDS, fileLearner, parseCreatureFile } from "./sim/rl/creatureFile.ts";
import { assertSameSettings } from "./sim/rl/resume.ts";
import { Trainer, heldSeeds } from "./sim/rl/trainer.ts";
import { parseCkpts, writeFileAtomic } from "./rlResume.ts";
import { PROC_DEFAULTS, procEnv } from "./sim/rl/procEnv.ts";
import { parseFounders } from "./live/founders.ts";
import { DESIGN_PANEL, designLearner } from "./sim/rl/designPanel.ts";
import { parseLibrary, serialiseLearner } from "./sim/rl/library.ts";
import { createNodeRlPool, parseThreads } from "./worker/nodePool.ts";


const { values } = parseArgs({
  options: {
    env: { type: "string", default: "nibble" },
    from: { type: "string", default: "pool:0" },
    iters: { type: "string", default: "60" },
    pairs: { type: "string", default: "16" },
    sigma: { type: "string", default: "0.08" },
    lr: { type: "string", default: "0.02" },
    episodes: { type: "string", default: "2" },
    eval: { type: "string", default: "16" },
    every: { type: "string", default: "10" },
    vary: { type: "string", default: "0" },
    threads: { type: "string" }, // default: the machine's cores less one, as the other CLIs
    seed: { type: "string", default: "1" },
    pool: { type: "string", default: "public/pool.json" },
    library: { type: "string", default: "public/rl/library.json" },
    out: { type: "string" },
    save: { type: "boolean", default: false },
    mix: { type: "string" },
    selfplay: { type: "boolean", default: false },
    crowd: { type: "string", default: PROC_DEFAULTS.crowd.join(",") },
    lineage: { type: "string", default: "0" },
    poisonw: { type: "string", default: "0" },
    foodw: { type: "string", default: String(PROC_DEFAULTS.foodWeight) },
    budget: { type: "string", default: "0" },
    state: { type: "string" },
    ckpt: { type: "string" },
    "ckpt-dir": { type: "string" },
    chunk: { type: "string", default: "0" },
    poison: { type: "string" }, // reward.poison per poison bite; unset: DEFAULT_POISON_COST on envs without their own, set: on every env of the mix
  },
});

const load = (pool: string, library: string): { pool: PoolEntry[] | null; library: Library } => ({
  pool: existsSync(pool) ? parsePool(JSON.parse(readFileSync(pool, "utf8"))).entries : null,
  library: parseLibrary(existsSync(library) ? JSON.parse(readFileSync(library, "utf8")) : null),
});

const mixIds = values.mix ? values.mix.split(",") : [values.env!];
const crowd = values.crowd!.split(",").map(Number);
if (crowd.length !== 2 || !(crowd[0]! >= 1 && crowd[0]! <= crowd[1]!)) {
  console.error("error: --crowd must be LO,HI");
  process.exit(1);
}
const procSpec = { ...PROC_DEFAULTS, crowd: [crowd[0]!, crowd[1]!] as const, lineageWeight: Number(values.lineage), foodWeight: Number(values.foodw), poisonWeight: Number(values.poisonw) };
const mix = values.selfplay ? [procEnv(procSpec)] : mixIds.map((id) => envById(id));
const env = mix[0] ?? envById("nibble")!;
if (mix.some((e) => !e)) {
  console.error(`error: unknown env in "${values.mix ?? values.env}"`);
  process.exit(1);
}
const num = (k: keyof typeof values): number => Number(values[k]);
const int = (k: "iters" | "pairs" | "episodes" | "eval" | "every" | "seed", min: number): number => {
  const v = num(k);
  if (!Number.isInteger(v) || v < min) {
    console.error(`error: --${k} must be an integer of at least ${min}`);
    process.exit(1);
  }
  return v;
};
const [iters, pairs, episodes, evalCount, every] = (["iters", "pairs", "episodes", "eval", "every"] as const).map((k) => int(k, 1));
const seed = int("seed", 0);
const vary = num("vary");
if (!(vary >= 0 && vary <= 0.9)) {
  console.error("error: --vary must be 0 to 0.9");
  process.exit(1);
}
for (const k of ["sigma", "lr"] as const) {
  if (!(num(k) > 0) || !Number.isFinite(num(k))) {
    console.error(`error: --${k} must be a positive number`);
    process.exit(1);
  }
}
const threads = parseThreads(values.threads);
const { pool, library } = load(resolve(values.pool!), resolve(values.library!));

const [kind, arg] = values.from!.split(/:(.*)/);
let learner: Learner;
if (kind === "pool" && pool) learner = poolLearner(env, pool[Number(arg)]!);
else if (kind === "design" && DESIGN_PANEL.some((x) => x.id === arg)) learner = designLearner(DESIGN_PANEL.find((x) => x.id === arg)!);
else if (kind === "founder") {
  const f = parseFounders(JSON.parse(readFileSync(resolve("public/live-founders.json"), "utf8"))).find((x) => x.id === arg);
  if (!f) {
    console.error(`error: no founder "${arg}"`);
    process.exit(1);
  }
  learner = { plan: f.plan, genome: f.genome };
}
else if (kind === "random") learner = randomLearner(env, Number(arg ?? 1));
else if (kind === "file") {
  // A creature file (Arena "Save"), checked like any outside data.
  const file = parseCreatureFile(readFileSync(arg!, "utf8"));
  if (typeof file === "string" || KINDS[file.kind].world !== env.world || KINDS[file.kind].role !== env.role) {
    console.error(`error: ${arg}: ${typeof file === "string" ? file : `a ${file.kind} cannot train in ${env.id}`}`);
    process.exit(1);
  }
  learner = fileLearner(file);
}
else {
  console.error(`error: --from must be pool:N, random:SEED or file:PATH`);
  process.exit(1);
}

const poisonGiven = values.poison !== undefined;
const poisonCost = poisonGiven ? Number(values.poison) : DEFAULT_POISON_COST;
if (values.selfplay && poisonGiven && poisonCost !== 0) {
  console.error("error: --poison does not apply to --selfplay (the crowd world scores poison with --poisonw, a different unit)");
  process.exit(1);
}
const envs = (mix as EnvSpec[]).map((e) => varied(values.selfplay || poisonCost === 0 || (!poisonGiven && e.reward.poison !== undefined) ? e : { ...e, reward: { ...e.reward, poison: poisonCost } }, vary));
const helpers = createNodeRlPool({ envs: [envs[0]!], plan: learner.plan, pool, library }, threads);
const trainer = new Trainer(Float32Array.from(learner.genome), { pairs, sigma: num("sigma"), lr: num("lr") }, helpers, 1, episodes, seed);
const evalSeeds = heldSeeds(evalCount);
const t0 = performance.now();
const ckptList = parseCkpts(values.ckpt, false);
if (typeof ckptList === "string") {
  console.error(`error: ${ckptList}`);
  process.exit(1);
}
const ckpts = ckptList;
if (ckpts.length && !values["ckpt-dir"]) {
  console.error("error: --ckpt needs --ckpt-dir");
  process.exit(1);
}
let cpu = 0; // cumulative CPU seconds of the training steps, over all chunks
let firstHeld = NaN; // the held-out score of the first chunk's start, kept over the chunks
const settings = { envs: envs.map((e) => e.id), selfplay: values.selfplay ? procSpec : false, from: values.from, seed, plan: learner.plan, genomeLength: learner.genome.length, pairs, sigma: num("sigma"), lr: num("lr"), episodes, vary, poison: poisonGiven ? poisonCost : null };
const resumed = values.state !== undefined && existsSync(values.state);
if (resumed) {
  try {
    const saved = JSON.parse(readFileSync(values.state!, "utf8")) as { trainer: Parameters<Trainer["load"]>[0]; cpu: number; settings?: unknown; heldStart?: number | null };
    if (saved.settings) assertSameSettings(saved.settings, settings);
    else console.error("warning: the state file has no settings to compare (saved by an older version)");
    if (!(Number.isFinite(saved.cpu) && saved.cpu >= 0)) throw new Error("saved state has a bad CPU time");
    trainer.load(saved.trainer);
    cpu = saved.cpu;
    firstHeld = saved.heldStart ?? NaN;
  } catch (e) {
    helpers.close();
    console.error(`error: ${values.state}: ${(e as Error).message}`);
    process.exit(1);
  }
}
const rotate = (k: number): void => { // the next iteration plays env k of the mix; held-out checks play them all (k < 0)
  const these = k < 0 ? envs : [envs[k % envs.length]!];
  helpers.setEnvs(these);
  trainer.setEnvs(helpers, these);
};
if (envs.length > 1) rotate(-1);
const start = resumed ? firstHeld : (await trainer.held(evalSeeds)).mean;
const curve: { iter: number; train: number; held?: number }[] = [{ iter: 0, train: NaN, held: start }];
console.log(`env ${env.id}, from ${values.from}, ${learner.genome.length} weights; held-out ${start.toFixed(3)} on ${evalCount} seeds`);
const budget = num("budget"); // wall seconds of training steps, held-out checks not counted
let trained = 0;
const chunk = num("chunk");
while (trainer.iter < iters && !(budget > 0 && trained >= budget) && !(chunk > 0 && trained >= chunk) && !(ckpts.length && cpu >= ckpts[ckpts.length - 1]!)) {
  const t1 = performance.now();
  const c1 = process.cpuUsage();
  if (envs.length > 1) rotate(trainer.iter);
  const step = await trainer.step();
  trained += (performance.now() - t1) / 1000;
  const c2 = process.cpuUsage(c1);
  const before = cpu;
  cpu += (c2.user + c2.system) / 1e6 / threads; // per thread, so it reads as seconds of a 2-thread run
  for (const c of ckpts) {
    if (before < c && cpu >= c) {
      mkdirSync(values["ckpt-dir"]!, { recursive: true });
      writeFileAtomic(resolve(values["ckpt-dir"]!, `${c}.json`), JSON.stringify(serialiseLearner({ plan: learner.plan, genome: trainer.es.theta })) + "\n");
      console.log(`checkpoint ${c} s CPU at iter ${step.iter} (${cpu.toFixed(0)} s)`);
    }
  }
  const point: (typeof curve)[number] = { iter: step.iter, train: step.train };
  const last = step.iter === iters || (budget > 0 && trained >= budget);
  if (step.iter % every === 0 || last) {
    if (envs.length > 1) rotate(-1);
    point.held = (await trainer.held(evalSeeds)).mean;
  }
  curve.push(point);
  if (point.held !== undefined) console.log(`iter ${step.iter}: train mean ${step.train.toFixed(3)}, held-out ${point.held.toFixed(3)} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
}
const es = trainer.es;
let end = curve[curve.length - 1]!.held; // a chunk can stop between held-out checks
if (end === undefined || curve.length === 1) {
  if (envs.length > 1) rotate(-1);
  end = (await trainer.held(evalSeeds)).mean;
}
helpers.close();
if (values.state) {
  writeFileAtomic(values.state, JSON.stringify({ trainer: trainer.save(), cpu, settings, heldStart: start }));
  console.log(`state saved at iter ${trainer.iter}, ${cpu.toFixed(0)} s CPU`);
}
const result = { ...serialiseLearner({ plan: learner.plan, genome: es.theta }), env: env.id, from: values.from, heldStart: start, heldEnd: end, iters, curve };
console.log(`held-out ${start.toFixed(3)} -> ${end.toFixed(3)} (${end >= start ? "+" : ""}${(end - start).toFixed(3)}); ${((performance.now() - t0) / 60000).toFixed(1)} min`);
if (values.out) writeFileSync(resolve(values.out), JSON.stringify(result) + "\n");
if (values.save && !(Number.isFinite(start) && Number.isFinite(end))) {
  console.error(`error: --save skipped, the held-out start (${start}) or end (${end}) is not a number`);
  process.exit(1);
}
if (values.save) {
  const path = resolve(values.library!);
  const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, envs: {} };
  (data.envs[env.id] ??= []).push({ ...serialiseLearner({ plan: learner.plan, genome: es.theta }), from: values.from, heldStart: start, heldEnd: end });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data) + "\n");
  console.log(`saved to ${path} under ${env.id} (${data.envs[env.id].length} there)`);
}
