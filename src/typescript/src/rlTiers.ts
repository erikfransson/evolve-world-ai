// B1: trains a design with a Live-page protocol on a CPU budget instead of wall seconds, the way live/training.ts + the Arena worker would (ArenaRun with one in-process helper,
// keep-best on the held-out checks every 5 iterations, messages after the budget dropped as the browser's timer would). A tier's seconds become CPU seconds of this thread by BROWSER_CPU_PER_SECOND.
// Usage: node src/rlTiers.ts --tier light|medium|strong --protocol NAME --designs p1,p2 --seed 1 --out DIR      (writes DIR/<design id>.json and DIR/<design id>.meta.json)
//        node src/rlTiers.ts --calibrate [--design p3]                                                         (CPU per iteration and episodes per CPU second of the current protocol)
//          add --cpu-per-second X to replace BROWSER_CPU_PER_SECOND
//        node src/rlTiers.ts --tier T --protocol P --from SPEC --seed 1 --out DIR [--rescore 32]                (B2: trained starts, rlStarts.ts; DIR/<start name>.json, the meta has the re-score)
//          a protocol name ending in +rb is (d) inside the budget: the start is re-scored first, training gets the budget less twice that cost, then the kept brain is re-scored
//        node src/rlTiers.ts --list                                                                           (the protocol names)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { parsePool } from "./sim/seedPool.ts";
import { DESIGN_PANEL, designLearner } from "./sim/rl/designPanel.ts";
import { EXTRA_DESIGNS } from "./sim/rl/b1Bodies.ts";
import { RECOMMENDED_MIX, envById } from "./sim/rl/envs.ts";
import { parseLibrary, serialiseLearner } from "./sim/rl/library.ts";
import { TRAIN_TIERS } from "./sim/rl/trainTiers.ts";
import { loadStarts } from "./rlStarts.ts";
import type { Learner } from "./sim/rl/env.ts";
import type { TrainPhase } from "./sim/rl/trainTiers.ts";
import { ArenaRun } from "./worker/arenaRun.ts";
import type { Start } from "./worker/arenaRun.ts";
import { RlPool, inlineRlPort } from "./worker/rlPool.ts";
import type { RlOutMessage } from "./worker/rlProtocol.ts";

// parameters
// Browser helpers 3 (live/training.ts HELPERS), parallel efficiency 0.85, a mid laptop core at 0.7 of this machine's core (assumption, no browser measured): this thread's CPU seconds per browser second.
export const BROWSER_CPU_PER_SECOND = 3 * 0.85 * 0.7;
const ES_NOW = { pairs: 24, sigma: 0.05, lr: 0.02, decay: 0.005, episodes: 1 };
const PRE = ["far-food", "patch", "minefield"], FINE = ["crowd", "rivals"], LIVE = ["live-now", "live-patch", "live-famine"];
const es = (envs: readonly string[], share: number, o: Partial<typeof ES_NOW> = {}, seconds?: number): TrainPhase => ({ envs, share, method: "es", es: { ...ES_NOW, ...o }, ...(seconds ? { seconds } : {}) });
const bp = (envs: readonly string[], share: number, lr: number, seconds?: number, episodes = 16): TrainPhase => ({ envs, share, method: "backprop", backprop: { lr, episodes }, ...(seconds ? { seconds } : {}) });
const HYPER = { pairs: 12, sigma: 0.08, lr: 0.03 };
type Phase = TrainPhase & { held?: number }; // held: seeds per env of the keep-best checks (the worker's Start.held, Live sends none: 4)
const held = (p: TrainPhase, n: number): Phase => ({ ...p, held: n });
export const PROTOCOLS: Record<string, Phase[]> = {
  current: [es(PRE, 0.5), es(FINE, 0.5)],
  "pre-only": [es(PRE, 1)],
  hyperA: [es(PRE, 0.5, HYPER), es(FINE, 0.5, HYPER)],
  "live30-es": [es(LIVE, 1, {}, 30)],
  "hyperA-live": [es(PRE, 0.5, HYPER), es(LIVE, 0.5, HYPER, 30)],
  "ppo-mix": [bp(RECOMMENDED_MIX, 1, 0.003)],
  "ppo-mix1": [bp(RECOMMENDED_MIX, 1, 0.001)],
  "ppo-mix30": [bp(RECOMMENDED_MIX, 1, 0.001, 30)],
  "ppo-hi": [bp(RECOMMENDED_MIX, 1, 0.01, 30)],
  "ppo-hi8": [bp(RECOMMENDED_MIX, 1, 0.01, 30, 8)],
  "mix-es": [es(RECOMMENDED_MIX, 1)],
  "ppo-hi-h16": [held(bp(RECOMMENDED_MIX, 1, 0.01, 30), 16)],
  "ppo-mix-h16": [held(bp(RECOMMENDED_MIX, 1, 0.003), 16)],
  ppo05: [bp(RECOMMENDED_MIX, 1, 0.0005)],
  "es-s02": [es(PRE, 0.5, { sigma: 0.02 }), es(FINE, 0.5, { sigma: 0.02 })],
  "es-h16": [held(es(PRE, 0.5), 16), held(es(FINE, 0.5), 16)],
  "ppo05-h16": [held(bp(RECOMMENDED_MIX, 1, 0.0005), 16)],
};

const { values } = parseArgs({ options: { tier: { type: "string" }, protocol: { type: "string" }, designs: { type: "string" }, seed: { type: "string", default: "1" }, out: { type: "string" }, from: { type: "string" }, rescore: { type: "string", default: "32" }, calibrate: { type: "boolean" }, list: { type: "boolean" }, design: { type: "string", default: "p3" }, final: { type: "boolean" }, "cpu-per-second": { type: "string" } } });
if (values.list) { console.log(Object.keys(PROTOCOLS).join(" ")); process.exit(0); }
const pool = existsSync("public/pool.json") ? parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries : null;
const library = parseLibrary(existsSync("public/rl/library.json") ? JSON.parse(readFileSync("public/rl/library.json", "utf8")) : null);
const ALL = [...DESIGN_PANEL, ...EXTRA_DESIGNS];
const cpuPerSecond = values["cpu-per-second"] ? Number(values["cpu-per-second"]) : BROWSER_CPU_PER_SECOND; // B5: PPO gets about 1.3 in a real browser (B4)
const cpu = (): number => { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; };

interface PhaseResult { genome: Float32Array; iters: number; checks: number; kept: boolean; cpu: number; start: number | null; best: number | null; episodes: number }
// One phase as live/training.ts runs it: the best genome on the held-out checks (null change when none beat the start), until `deadline` (this process's CPU seconds).
async function runPhase(phase: Phase, plan: ReturnType<typeof designLearner>["plan"], genome: Float32Array, seed: number, deadline: number): Promise<PhaseResult> {
  const envs = phase.envs.map((id) => { const e = envById(id)!; return phase.seconds && e.seconds > phase.seconds ? { ...e, id: `${e.id}-${phase.seconds}`, seconds: phase.seconds } : e; });
  let best = -Infinity, start: number | null = null, score: number | null = null, latest: Float32Array | null = null, iters = 0, checks = 0, bestScore: number | null = null;
  const t0 = cpu();
  let expired = false;
  let run: ArenaRun | null = null;
  const post = (m: RlOutMessage): void => {
    if (expired) return;
    if (cpu() > deadline) { expired = true; run?.stop(); return; }
    if (m.type === "ready") start = best = score = m.held;
    else if (m.type === "iteration") { iters = m.it.iter; if (m.it.held !== null) { score = m.it.held; checks++; } }
    else if (m.type === "learner" && score !== null && score > best) { best = score; bestScore = score; latest = Float32Array.from(m.learner.genome); }
  };
  const msg: Start = {
    type: "start", envs, learner: serialiseLearner({ plan, genome }), method: phase.method,
    options: { iterations: 100_000, ...(phase.es ?? { pairs: 24, sigma: 0.05, lr: 0.02, decay: 0.005, episodes: 1 }), ...(phase.backprop ? { backprop: phase.backprop, episodes: 1 } : {}) } as Start["options"],
    tiles: 1, seed, poolUrl: "", libraryUrl: "", playback: false, gentle: false, helpers: 1, ...(phase.held ? { held: phase.held } : {}),
  };
  run = new ArenaRun(msg, { pool, library }, (setup) => new RlPool([inlineRlPort()], setup), post);
  try { await run.run(); } catch { /* a stopped pool ends the in-flight step */ }
  const out = latest as Float32Array | null;
  const perIter = phase.method === "es" ? 2 * phase.es!.pairs * envs.length * phase.es!.episodes : phase.backprop!.episodes;
  return { genome: out ?? genome, iters, checks, kept: out !== null, cpu: cpu() - t0, start, best: bestScore, episodes: iters * perIter + checks * 4 * envs.length };
}

if (values.calibrate) {
  const d = ALL.find((x) => x.id.startsWith(values.design!))!;
  const l = designLearner(d);
  for (const [name, phases] of Object.entries(PROTOCOLS)) {
    for (const ph of phases) {
      const t = cpu();
      const r = await runPhase({ ...ph, share: 1 }, l.plan, l.genome, 1, t + 12); // 12 CPU seconds each
      console.log(`${name} [${ph.envs.join(",")}] ${ph.method}: ${(r.cpu / Math.max(1, r.iters)).toFixed(2)} CPU s/iteration, ${r.iters} iterations in ${r.cpu.toFixed(1)} s, ${(r.episodes / r.cpu).toFixed(1)} episodes/CPU s, kept ${r.kept}`);
    }
  }
  process.exit(0);
}

const tier = TRAIN_TIERS.find((t) => t.id === values.tier);
// B2 (d): the start and the kept brain re-scored on `n` held seeds of the mix, as the worker's "ready" score (a run of 0 iterations).
async function heldScore(l: Learner, n: number): Promise<{ score: number; cpu: number }> {
  const t0 = cpu();
  let score = NaN;
  const msg: Start = {
    type: "start", envs: RECOMMENDED_MIX.map((id) => envById(id)!), learner: serialiseLearner(l), method: "es", options: { ...ES_NOW, iterations: 0 } as Start["options"],
    tiles: 1, seed: 1, poolUrl: "", libraryUrl: "", playback: false, gentle: false, helpers: 1, held: n,
  };
  const run = new ArenaRun(msg, { pool, library }, (setup) => new RlPool([inlineRlPort()], setup), (m) => { if (m.type === "ready") score = m.held; });
  await run.run();
  run.stop();
  return { score, cpu: cpu() - t0 };
}

const inBudget = values.protocol?.endsWith("+rb") === true, baseProtocol = inBudget ? values.protocol!.slice(0, -3) : values.protocol!;
if (values.from && tier && values.out && PROTOCOLS[baseProtocol]) {
  const phases = PROTOCOLS[baseProtocol]!;
  mkdirSync(values.out, { recursive: true });
  const n = Number(values.rescore);
  for (const s of loadStarts(values.from)) {
    if (existsSync(resolve(values.out, `${s.name}.json`))) continue;
    const first = inBudget ? await heldScore(s.learner, n) : null; // the start's re-score, paid before training (twice: the kept brain's costs about the same)
    const budget = Math.max(0, tier.seconds * cpuPerSecond - (first ? 2 * first.cpu : 0));
    let genome = s.learner.genome;
    const metas: PhaseResult[] = [];
    for (const [k, ph] of phases.entries()) {
      const t = cpu();
      const r = await runPhase(ph, s.learner.plan, genome, Number(values.seed) * 1000 + k, t + budget * ph.share);
      genome = r.genome;
      metas.push({ ...r, genome: new Float32Array(0) });
    }
    const out = { plan: s.learner.plan, genome };
    const a = first ?? await heldScore(s.learner, n), b = metas.some((m) => m.kept) ? await heldScore(out, n) : a;
    writeFileSync(resolve(values.out, `${s.name}.meta.json`), JSON.stringify({ tier: tier.id, protocol: values.protocol, budget, phases: metas, rescore: { seeds: n, start: a.score, kept: b.score, cpu: a.cpu + (b === a ? 0 : b.cpu) } }) + "\n");
    writeFileSync(resolve(values.out, `${s.name}.json`), JSON.stringify(serialiseLearner(out)) + "\n");
    console.log(s.name, metas.map((m) => `iters ${m.iters} checks ${m.checks} kept ${m.kept} cpu ${m.cpu.toFixed(0)}`).join(" | "), `rescore ${a.score.toFixed(2)} -> ${b.score.toFixed(2)} (${(a.cpu + b.cpu).toFixed(0)} s)`);
  }
  process.exit(0);
}
if (!tier || !values.out || !values.designs) { console.error("error: --tier, --designs and --out are needed"); process.exit(1); }
const phases = values.final ? tier.phases.slice() : PROTOCOLS[values.protocol!];
if (!phases) { console.error(`error: --protocol must be one of ${Object.keys(PROTOCOLS).join(" ")}`); process.exit(1); }
mkdirSync(values.out, { recursive: true });
for (const id of values.designs.split(",")) {
  const d = ALL.find((x) => x.id.startsWith(id + "-") || x.id === id)!;
  if (existsSync(resolve(values.out, `${d.id}.json`))) continue;
  const l = designLearner(d);
  const budget = tier.seconds * cpuPerSecond;
  let genome = l.genome;
  const metas: PhaseResult[] = [];
  for (const [k, ph] of phases.entries()) {
    const t = cpu();
    const r = await runPhase(ph, l.plan, genome, Number(values.seed) * 1000 + k, t + budget * ph.share);
    genome = r.genome;
    metas.push({ ...r, genome: new Float32Array(0) });
  }
  writeFileSync(resolve(values.out, `${d.id}.meta.json`), JSON.stringify({ tier: tier.id, protocol: values.protocol, budget, phases: metas }) + "\n");
  writeFileSync(resolve(values.out, `${d.id}.json`), JSON.stringify(serialiseLearner({ plan: l.plan, genome })) + "\n");
  console.log(d.id, metas.map((m) => `iters ${m.iters} checks ${m.checks} kept ${m.kept} cpu ${m.cpu.toFixed(0)}`).join(" | "));
}
