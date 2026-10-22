// T3 probe: signal and noise of RL env rewards for fixed policies, and the ES candidate-difference signal-to-noise.
// Run from src/typescript: node ../../docs/rl-notes/probes/t3-snr.ts --envs nibble,fence --seeds 32 --pairs 8 --pseeds 16 --out /tmp/x.json
// Single thread, no training. Lab env files (JSON arrays of EnvSpec) can be added with --file PATH (ids taken from --envs, or all).

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { genomeLength, layerSizes } from "../../../src/typescript/src/sim/brain.ts";
import { createRng } from "../../../src/typescript/src/sim/rng.ts";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { OUT_THRUST, OUT_TURN } from "../../../src/typescript/src/sim/sensors.ts";
import type { PlanView } from "../../../src/typescript/src/sim/sensors.ts";
import { genomeLengthIn, layoutConfig, poolLearner, randomLearner, runEpisode } from "../../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec, Learner, Library } from "../../../src/typescript/src/sim/rl/env.ts";
import { ENVS } from "../../../src/typescript/src/sim/rl/envs.ts";
import { parseLibrary } from "../../../src/typescript/src/sim/rl/library.ts";
import { heldSeeds } from "../../../src/typescript/src/sim/rl/trainer.ts";

// parameters
const { values } = parseArgs({
  options: {
    envs: { type: "string", default: "" },
    file: { type: "string" },
    seeds: { type: "string", default: "32" }, // held-out seeds per fixed policy
    pairs: { type: "string", default: "8" }, // antithetic ES pairs per base point
    pseeds: { type: "string", default: "16" }, // seeds per ES candidate
    sigma: { type: "string", default: "0.08" }, // ES default (es.ts ES_DEFAULTS)
    randoms: { type: "string", default: "8" },
    pools: { type: "string", default: "4" },
    library: { type: "string", default: "public/rl/library.json" },
    out: { type: "string" },
  },
});
const SEEDS = Number(values.seeds);
const PAIRS = Number(values.pairs);
const PSEEDS = Number(values.pseeds);
const SIGMA = Number(values.sigma);

const pool = parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries;
const library: Library = parseLibrary(JSON.parse(readFileSync(values.library!, "utf8")));
const founders = JSON.parse(readFileSync("public/live-founders.json", "utf8")).founders as { id: string; plan: PlanView; genome: number[] }[];

// Lab env files leave world and role out (the lab's checkEnv fills them in as a forager).
let envs: EnvSpec[] = values.file ? (JSON.parse(readFileSync(values.file, "utf8")) as EnvSpec[]).map((e) => ({ world: "ecosystem", role: 0, ...e })) : [...ENVS];
const want = values.envs ? values.envs.split(",") : null;
if (want) envs = envs.filter((e) => want.includes(e.id));

// A one-ray, one-neuron brain whose outputs are constant: tanh(bias) for turn and thrust.
const BIAS_PLAN: PlanView = { rayCount: 1, raySpread: 0, rayLength: 10, hiddenLayers: [1], memoryShort: 0, memoryLong: 0 };
function scripted(turn: number, thrust: number): Learner {
  const sizes = layerSizes(layoutConfig("ecosystem"), BIAS_PLAN);
  const g = new Float32Array(genomeLength(sizes));
  const at = g.length - sizes[sizes.length - 1]!;
  g[at + OUT_TURN] = Math.atanh(turn);
  g[at + OUT_THRUST] = Math.atanh(thrust);
  return { plan: BIAS_PLAN, genome: g };
}

const mean = (x: number[]): number => x.reduce((a, b) => a + b, 0) / x.length;
const vari = (x: number[]): number => {
  const m = mean(x);
  return x.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, x.length - 1);
};

function policies(env: EnvSpec): { name: string; group: string; learner: Learner }[] {
  const out = [
    { name: "still", group: "scripted", learner: scripted(0, 0) },
    { name: "straight", group: "scripted", learner: scripted(0, 0.999) },
    { name: "circle", group: "scripted", learner: scripted(0.5, 0.6) },
  ];
  for (let s = 1; s <= Number(values.randoms); s++) out.push({ name: `random:${s}`, group: "random", learner: randomLearner(env, s) });
  for (let k = 0; k < Number(values.pools); k++) out.push({ name: `pool:${k}`, group: "pool", learner: poolLearner(env, pool[k]!) });
  for (const f of founders) if (f.genome.length === genomeLengthIn("ecosystem", f.plan)) out.push({ name: f.id, group: "live", learner: { plan: f.plan, genome: Float32Array.from(f.genome) } });
  return out;
}

// ES pairs around a base genome on shared seeds: per pair k and seed s, d = r(theta + sigma e) - r(theta - sigma e).
// Signal: the variance of the true pair differences across k. Noise: the per-seed spread of d within a pair.
function esProbe(env: EnvSpec, base: Learner, seeds: number[]) {
  const rng = createRng(12345);
  const n = base.genome.length;
  const d: number[][] = [];
  const cand: number[][] = [];
  for (let k = 0; k < PAIRS; k++) {
    const e = Float32Array.from({ length: n }, () => rng.normal());
    const plus = Float32Array.from(base.genome, (v, i) => v + SIGMA * e[i]!);
    const minus = Float32Array.from(base.genome, (v, i) => v - SIGMA * e[i]!);
    const rp = seeds.map((s) => runEpisode(env, { plan: base.plan, genome: plus }, s, pool, library).reward);
    const rm = seeds.map((s) => runEpisode(env, { plan: base.plan, genome: minus }, s, pool, library).reward);
    d.push(rp.map((v, i) => v - rm[i]!));
    cand.push(rp, rm);
  }
  const noise = mean(d.map(vari)); // per-episode variance of a pair difference on one shared seed
  const signal = Math.max(0, vari(d.map(mean)) - noise / seeds.length); // variance of the true pair differences
  // Candidate means (2 x pairs) on the same seeds: two-way split into candidate effect and candidate x seed interaction.
  const S = seeds.length;
  const C = cand.length;
  const grand = mean(cand.flat());
  const cm = cand.map(mean);
  const sm = seeds.map((_, s) => mean(cand.map((c) => c[s]!)));
  let resid = 0;
  for (let c = 0; c < C; c++) for (let s = 0; s < S; s++) resid += (cand[c]![s]! - cm[c]! - sm[s]! + grand) ** 2;
  const interaction = resid / ((C - 1) * (S - 1));
  const candVar = Math.max(0, vari(cm) - interaction / S);
  return {
    pairSignal: signal,
    pairNoise: noise,
    episodesFor50: signal > 0 ? noise / signal : Infinity, // shared seeds per candidate so half the pair-difference variance is real
    candVar,
    interaction,
    seedVar: vari(sm),
    candReliability1: candVar + interaction > 0 ? candVar / (candVar + interaction) : NaN, // with 1 shared seed per candidate; NaN when every candidate scores the same
    meanReward: grand,
  };
}

const results: unknown[] = [];
for (const env of envs) {
  if (env.world !== "ecosystem") {
    console.log(`${env.id}: skipped (${env.world} world)`);
    continue;
  }
  const t0 = performance.now();
  const seeds = heldSeeds(SEEDS);
  const pol = policies(env).map((p) => {
    const eps = seeds.map((s) => runEpisode(env, p.learner, s, pool, library));
    const r = eps.map((e) => e.reward);
    return { name: p.name, group: p.group, rewards: r, mean: mean(r), sd: Math.sqrt(vari(r)), zero: r.filter((v) => v === 0).length / r.length, food: mean(eps.map((e) => e.food)), alive: mean(eps.map((e) => e.seconds)) / env.seconds, rams: mean(eps.map((e) => e.rams)) };
  });
  const tPol = (performance.now() - t0) / 1000;
  const g = (grp: string) => pol.filter((p) => p.group === grp);
  const trained = [...g("pool"), ...g("live")].sort((a, b) => b.mean - a.mean);
  const best = trained[0]!;
  const second = trained[1]!;
  const weak = mean(g("random").map((p) => p.mean));
  const bestScripted = g("scripted").reduce((a, b) => (b.mean > a.mean ? b : a));
  const gap = best.mean - weak;
  const sdEp = Math.sqrt(mean(trained.map((p) => p.sd ** 2)));
  const diff = best.rewards.map((v, i) => v - second.rewards[i]!);
  const sdPaired = Math.sqrt(vari(diff));
  const corr = (() => {
    const a = best.rewards, b = second.rewards, ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; }
    return num / Math.sqrt(da * db || 1);
  })();
  // Seeds needed to detect a gain of 10% of the weak-to-good gap, paired, 5% two-sided, 80% power: n = (2.8 sd / delta)^2.
  const n10 = gap > 0 ? Math.ceil(((2.8 * sdPaired) / (0.1 * gap)) ** 2) : Infinity;
  const n10unpaired = gap > 0 ? Math.ceil(2 * ((2.8 * sdEp) / (0.1 * gap)) ** 2) : Infinity;
  const pseeds = heldSeeds(PSEEDS).map((s) => s + 1000); // other held-out seeds than the policy table
  const esRandom = esProbe(env, randomLearner(env, 1), pseeds);
  const esPool = esProbe(env, poolLearner(env, pool[0]!), pseeds);
  const secs = (performance.now() - t0) / 1000;
  const row = {
    env: env.id,
    weak, best: best.name, bestMean: best.mean, bestScripted: bestScripted.name, bestScriptedMean: bestScripted.mean, gap, sdEp, snr: gap / sdEp, sdPaired, corr, n10, n10unpaired,
    randomZero: mean(g("random").map((p) => p.zero)),
    esRandom, esPool,
    policies: pol.map(({ rewards: _, ...p }) => p),
    secs, msPerEpisode: (1000 * tPol) / (pol.length * SEEDS),
  };
  results.push(row);
  const f = (x: number, d = 2) => (Number.isNaN(x) ? "flat" : Number.isFinite(x) ? x.toFixed(d) : "inf");
  console.log(
    `${env.id}: weak ${f(weak)} best ${best.name} ${f(best.mean)} (2nd ${second.name} ${f(second.mean)}) scripted ${bestScripted.name} ${f(bestScripted.mean)} | sdEp ${f(sdEp)} SNR ${f(gap / sdEp)} sdPaired ${f(sdPaired)} r ${f(corr)} n10 ${n10} (unpaired ${n10unpaired}) randZero ${f(row.randomZero)} | ES rand rel1 ${f(esRandom.candReliability1)} E50 ${f(esRandom.episodesFor50, 1)} | ES pool rel1 ${f(esPool.candReliability1)} E50 ${f(esPool.episodesFor50, 1)} | ${f(secs, 0)} s, ${f(row.msPerEpisode, 1)} ms/ep`,
  );
  console.log("   " + pol.map((p) => `${p.name} ${f(p.mean)}±${f(p.sd)}`).join(", "));
  if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 1) + "\n");
}
