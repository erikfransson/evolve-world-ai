// Trains one creature in an RL environment with backprop RL (PPO on its own brain), on the main thread; a prototype to compare with rlTrain (ES).
// Usage: node src/rlGrad.ts --env nibble [--from random:1 | pool:0] [--seconds 60] [--iters 1000] [--episodes 16] [--epochs 2] [--lr 0.003]
//        [--envs a,b,c|all] [--diag diag.csv] [--logstd=-0.5] [--repeat 3] [--every-tick] [--repeat-then 30:1] [--target-kl 0.02] [--gamma 0.995] [--eval 32] [--every 5] [--seed 1] [--out learner.json]
// --envs trains on several envs as the Arena does (episode k plays env k % count); --from founder:ID starts from public/live-founders.json; --diag writes one CSV row per update (see PpoDiag).
// --poison W adds a cost per poison bite to the env reward (default 0: PPO has its own training-only --poison-penalty, 1 by default, skipped on envs with their own poison cost).
// --repeat-then S:N switches to repeat N after S seconds of training; --every-tick holds only the noise while the brain acts every tick.
// --state FILE resumes from FILE when it exists and saves the whole training state there at the end (genome, critic, log-std, Adam, rng), so --iters is the target total and --seconds the limit of this chunk;
// --ckpt 2000,6000 --ckpt-dir DIR writes DIR/<iter>.json (a learner file for rlTransfer) when those updates are reached; --trace FILE appends one JSON line of log-std every --trace-every updates.
// --state is for one run at a time and not with --repeat-then; it refuses to resume when the other settings (envs, --from, --seed, plan, options) differ.
// A chunk killed before it ends leaves the last state, so the rerun repeats its updates and appends their --trace and logstd.jsonl lines again (dedupe by iter).
// Held-out: the mean action (the brain as it is) on HELD_BASE + k, as rlTrain. Time excludes the held-out checks.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { layerSizes } from "./sim/brain.ts";
import { DESIGN_PANEL, designLearner } from "./sim/rl/designPanel.ts";
import { layoutConfig, poolLearner, randomLearner, scoreLearner } from "./sim/rl/env.ts";
import type { EnvSpec, Learner } from "./sim/rl/env.ts";
import { ENVS, envById } from "./sim/rl/envs.ts";
import { serialiseLearner } from "./sim/rl/library.ts";
import { LOG_STD_RANGE, PPO_DEFAULTS, Ppo } from "./sim/rl/ppo.ts";
import { assertSameSettings } from "./sim/rl/resume.ts";
import { heldSeeds } from "./sim/rl/trainer.ts";
import { parseCkpts, writeFileAtomic } from "./rlResume.ts";
import { parsePool } from "./sim/seedPool.ts";
import { parseFounders } from "./live/founders.ts";

const { values } = parseArgs({
  options: {
    env: { type: "string", default: "nibble" },
    envs: { type: "string" },
    diag: { type: "string" },
    founders: { type: "string", default: "public/live-founders.json" },
    from: { type: "string", default: "random:1" },
    seconds: { type: "string", default: "60" },
    iters: { type: "string", default: "100000" },
    episodes: { type: "string", default: "16" },
    epochs: { type: "string", default: "2" },
    minibatch: { type: "string", default: "256" },
    lr: { type: "string", default: "0.003" },
    logstd: { type: "string", default: "-0.5" },
    entropy: { type: "string", default: "0" },
    "poison-penalty": { type: "string", default: String(PPO_DEFAULTS.poisonPenalty) },
    poison: { type: "string", default: "0" }, // reward.poison for every env (cost per poison bite, in the env reward); 0 by default since PPO has its own --poison-penalty
    "logstd-min": { type: "string", default: String(PPO_DEFAULTS.logStdMin) },
    repeat: { type: "string", default: "3" },
    "every-tick": { type: "boolean", default: false },
    "repeat-then": { type: "string" },
    "target-kl": { type: "string", default: "0" },
    gamma: { type: "string", default: "0.995" },
    eval: { type: "string", default: "32" },
    every: { type: "string", default: "5" },
    seed: { type: "string", default: "1" },
    pool: { type: "string", default: "public/pool.json" },
    out: { type: "string" },
    state: { type: "string" },
    ckpt: { type: "string" },
    "ckpt-dir": { type: "string" },
    trace: { type: "string" },
    "trace-every": { type: "string", default: "250" },
  },
});

const envList0: EnvSpec[] = values.envs === "all" ? ENVS.filter((e) => e.world === "ecosystem") : (values.envs ?? values.env!).split(",").map((id) => envById(id)!);
if (envList0.some((e) => !e)) {
  console.error(`error: unknown env in "${values.envs ?? values.env}"`);
  process.exit(1);
}
const envList = Number(values.poison) === 0 ? envList0 : envList0.map((e) => ({ ...e, reward: { ...e.reward, poison: Number(values.poison) } }));
const env = envList[0]!;
const num = (k: keyof typeof values): number => Number(values[k]);
const pool = existsSync(values.pool!) ? parsePool(JSON.parse(readFileSync(values.pool!, "utf8"))).entries : null;
const [kind, arg] = values.from!.split(/:(.*)/);
const founder = kind === "founder" ? parseFounders(JSON.parse(readFileSync(values.founders!, "utf8"))).find((f) => f.id === arg) : undefined;
const design = kind === "design" ? DESIGN_PANEL.find((d) => d.id.startsWith(arg!)) : undefined;
const learner = design ? designLearner(design) : founder ? { plan: founder.plan, genome: founder.genome } : kind === "pool" && pool ? poolLearner(env, pool[Number(arg)]!) : kind === "random" ? randomLearner(env, Number(arg ?? 1)) : null;
if (!learner) {
  console.error("error: --from must be pool:N, random:SEED, founder:ID or design:pN (src/sim/rl/designPanel.ts)");
  process.exit(1);
}
const logStdMin = num("logstd-min");
if (!(Number.isFinite(logStdMin) && logStdMin >= LOG_STD_RANGE[0] && logStdMin <= LOG_STD_RANGE[1])) {
  console.error(`error: --logstd-min must be a number from ${LOG_STD_RANGE[0]} to ${LOG_STD_RANGE[1]}`);
  process.exit(1);
}
const sizes = layerSizes(layoutConfig(env.world), learner.plan);
const ppo = new Ppo(envList, learner, sizes, {
  episodes: num("episodes"), epochs: num("epochs"), minibatch: num("minibatch"), lr: num("lr"), logStd: num("logstd"), entropy: num("entropy"), repeat: num("repeat"), gamma: num("gamma"), everyTick: values["every-tick"], targetKl: num("target-kl"), poisonPenalty: num("poison-penalty"), logStdMin, diag: values.diag !== undefined,
}, num("seed"), pool);
const resumed = values.state !== undefined && existsSync(values.state);
let start = NaN; // the held-out score of the first chunk's start, kept over the chunks
if (values.state && values["repeat-then"]) {
  console.error("error: --repeat-then cannot be resumed, so not with --state");
  process.exit(1);
}
const { diag: _diag, ...settingOptions } = ppo.options;
const settings = { envs: envList.map((e) => e.id), poison: num("poison"), from: values.from, seed: num("seed"), plan: learner.plan, options: settingOptions };
if (resumed) {
  try {
    const saved = JSON.parse(readFileSync(values.state!, "utf8")) as { settings?: unknown; heldStart?: number | null };
    if (saved.settings) assertSameSettings(saved.settings, settings);
    else console.error("warning: the state file has no settings to compare (saved by an older version)");
    ppo.load(saved as Parameters<Ppo["load"]>[0]);
    start = saved.heldStart ?? NaN;
  } catch (e) {
    console.error(`error: ${values.state}: ${(e as Error).message}`);
    process.exit(1);
  }
}
const ckptList = parseCkpts(values.ckpt, true);
if (typeof ckptList === "string") {
  console.error(`error: ${ckptList}`);
  process.exit(1);
}
const ckpts = ckptList;
if (ckpts.length && !values["ckpt-dir"]) {
  console.error("error: --ckpt needs --ckpt-dir");
  process.exit(1);
}
const seeds = heldSeeds(num("eval"));
// The mean over the envs of each env's mean on the held-out seeds, as the Arena's held-out score.
let perEnv: number[] = [];
const held = (): number => {
  perEnv = envList.map((e) => scoreLearner(e, { plan: learner.plan, genome: ppo.theta }, seeds, pool).reward);
  return perEnv.reduce((a, b) => a + b, 0) / perEnv.length;
};
if (!resumed) start = held();
console.log(`env ${envList.map((e) => e.id).join(",")}, from ${values.from}, sizes ${sizes.join("-")}; held-out ${start.toFixed(3)} on ${seeds.length} seeds`);
const curve: { iter: number; episodes: number; seconds: number; train: number; held?: number }[] = [{ iter: 0, episodes: 0, seconds: 0, train: NaN, held: start }];
const [switchAt, switchTo] = values["repeat-then"] ? values["repeat-then"].split(":").map(Number) : [Infinity, 1];
if (!(switchAt! >= 0) || !Number.isInteger(switchTo) || switchTo! < 1) {
  console.error("error: --repeat-then must be S:N, seconds S >= 0 and repeat N a positive integer");
  process.exit(1);
}
const csv: string[] = [];
let busy = 0;
while (ppo.iter < num("iters") && busy < num("seconds") * 1000) {
  if (busy >= switchAt! * 1000 && ppo.options.repeat !== switchTo) ppo.setRepeat(switchTo!);
  const t = performance.now();
  const step = ppo.step();
  busy += performance.now() - t;
  const point: (typeof curve)[number] = { iter: step.iter, episodes: ppo.episodesPlayed, seconds: busy / 1000, train: step.train };
  if (step.iter % num("every") === 0) {
    point.held = held();
    console.log(`iter ${step.iter}: episodes ${ppo.episodesPlayed}, train ${step.train.toFixed(3)}, held-out ${point.held.toFixed(3)}, std ${step.std.map((s) => s.toFixed(2)).join(" ")} (${point.seconds.toFixed(0)} s)`);
  }
  curve.push(point);
  if (values.trace && step.iter % num("trace-every") === 0) appendFileSync(values.trace, JSON.stringify({ iter: step.iter, train: step.train, logStd: Array.from(ppo.logStd) }) + "\n");
  if (ckpts.includes(step.iter)) {
    mkdirSync(values["ckpt-dir"]!, { recursive: true });
    writeFileAtomic(resolve(values["ckpt-dir"]!, `${step.iter}.json`), JSON.stringify(serialiseLearner({ plan: learner.plan, genome: ppo.theta })) + "\n");
    appendFileSync(resolve(values["ckpt-dir"]!, "logstd.jsonl"), JSON.stringify({ iter: step.iter, train: step.train, logStd: Array.from(ppo.logStd) }) + "\n");
  }
  const d = ppo.lastDiag;
  if (d) {
    if (csv.length === 0) csv.push(["iter", "episodes", "seconds", "reward", "held", ...d.layerNorm.map((_, l) => `wnorm${l}`), ...d.layerMax.map((_, l) => `wmax${l}`), ...d.saturated.map((_, l) => `sat${l}`), "gradNorm", "criticGradNorm", "clipActive", ...d.logStd.map((_, a) => `logStd${a}`), "kl", "klMax", "clipFrac", "explVar", "advMean", "advStd", "samples", "epochs", ...envList.map((e) => `held_${e.id}`)].join(","));
    csv.push([step.iter, ppo.episodesPlayed, point.seconds.toFixed(1), d.reward, point.held ?? "", ...d.layerNorm, ...d.layerMax, ...d.saturated, d.gradNorm, d.criticGradNorm, d.clipActive, ...d.logStd, d.kl, d.klMax, d.clipFrac, d.explainedVar, d.advMean, d.advStd, d.samples, d.epochs, ...(point.held === undefined ? envList.map(() => "") : perEnv)].map((v) => (typeof v === "number" ? Number(v.toPrecision(5)) : v)).join(","));
  }
}
const end = held();
if (values.state) {
  writeFileAtomic(values.state, JSON.stringify({ ...ppo.save(), settings, heldStart: start }));
}
if (values.diag && csv.length) {
  const more = resumed && existsSync(resolve(values.diag)); // a resumed chunk appends its rows to the earlier chunks, without a second header
  (more ? appendFileSync : writeFileSync)(resolve(values.diag), (more ? csv.slice(1) : csv).join("\n") + "\n");
}
console.log(`held-out ${start.toFixed(3)} -> ${end.toFixed(3)} after ${ppo.episodesPlayed} episodes, ${(busy / 1000).toFixed(0)} s`);
if (values.out) writeFileSync(resolve(values.out), JSON.stringify({ ...serialiseLearner({ plan: learner.plan, genome: ppo.theta }), env: envList.map((e) => e.id).join(","), from: values.from, heldStart: start, heldEnd: end, curve }) + "\n");
