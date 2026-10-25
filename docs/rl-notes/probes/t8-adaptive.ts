// T8 probe: fixed ES episode counts against successive halving on antithetic pairs, scored as held-out gain per training CPU second.
// fixed: Trainer as rlTrain runs it (pairs x episodes). sh: pairs1 pairs play eps1 shared seeds, the keep pairs with the largest
// |r+ - r-| play eps2 more shared seeds, and only they move theta (the dropped pairs get equal rewards, so zero weight).
// The start and final genomes are scored on the same fresh seeds (HELD_BASE + 40000 + k), so runs pair up seed by seed.
// Usage (from src/typescript): node ../../docs/rl-notes/probes/t8-adaptive.ts --env far-food --scheme sh --seed 1 [--out f.json]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { poolLearner } from "../../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
import { Es } from "../../../src/typescript/src/sim/rl/es.ts";
import { HELD_BASE, Trainer, scoreGenomes } from "../../../src/typescript/src/sim/rl/trainer.ts";
import { createRng, deriveSeed } from "../../../src/typescript/src/sim/rng.ts";
import { createNodeRlPool } from "../../../src/typescript/src/worker/nodePool.ts";

// parameters
const { values } = parseArgs({
  options: {
    env: { type: "string", default: "far-food" }, from: { type: "string", default: "pool:0" }, seed: { type: "string", default: "1" }, iters: { type: "string", default: "60" },
    scheme: { type: "string", default: "fixed" }, pairs: { type: "string", default: "10" }, episodes: { type: "string", default: "5" },
    pairs1: { type: "string", default: "20" }, eps1: { type: "string", default: "1" }, keep: { type: "string", default: "10" }, eps2: { type: "string", default: "3" },
    fresh: { type: "string", default: "128" }, threads: { type: "string", default: "2" }, out: { type: "string" },
  },
});
const n = (k: keyof typeof values) => Number(values[k]);
const env = envById(values.env!)!;
const pool = existsSync("public/pool.json") ? parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries : null;
const start = poolLearner(env, pool![Number(values.from!.split(":")[1])]!);
const helpers = createNodeRlPool({ envs: [env], plan: start.plan, pool, library: {} }, n("threads"));
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; }; // whole process, helper threads included
const fresh = Array.from({ length: n("fresh") }, (_, k) => HELD_BASE + 40000 + k);
const mean = (a: readonly number[]) => a.reduce((x, y) => x + y, 0) / a.length;

await scoreGenomes(helpers, 1, [start.genome], [HELD_BASE + 39999]); // helper start-up and JIT outside the timed part
let episodes = 0;
const t0 = cpu();
let theta: Float32Array;
if (values.scheme === "fixed") {
  const trainer = new Trainer(Float32Array.from(start.genome), { pairs: n("pairs") }, helpers, 1, n("episodes"), n("seed"));
  for (let i = 0; i < n("iters"); i++) await trainer.step();
  episodes = n("iters") * 2 * n("pairs") * n("episodes");
  theta = trainer.theta;
} else {
  const [p1, e1, keep, e2] = [n("pairs1"), n("eps1"), n("keep"), n("eps2")];
  const es = new Es(start.genome, { pairs: p1 });
  const rng = createRng(deriveSeed(n("seed"), 0xe5));
  const draw = (k: number) => Array.from({ length: k }, () => rng.int(HELD_BASE));
  for (let i = 0; i < n("iters"); i++) {
    const seeds1 = draw(e1);
    const cands = es.ask(rng);
    const r1 = (await scoreGenomes(helpers, 1, cands, seeds1)).map((s) => s.mean);
    const order = Array.from({ length: p1 }, (_, k) => k).sort((a, b) => Math.abs(r1[2 * b]! - r1[2 * b + 1]!) - Math.abs(r1[2 * a]! - r1[2 * a + 1]!));
    const kept = order.slice(0, keep);
    const seeds2 = draw(e2);
    const r2 = (await scoreGenomes(helpers, 1, kept.flatMap((k) => [cands[2 * k]!, cands[2 * k + 1]!]), seeds2)).map((s) => s.mean);
    const rewards = new Array<number>(2 * p1);
    kept.forEach((k, j) => { for (const s of [0, 1]) rewards[2 * k + s] = (e1 * r1[2 * k + s]! + e2 * r2[2 * j + s]!) / (e1 + e2); });
    const m = mean(rewards.filter((x) => x !== undefined));
    for (let k = 0; k < 2 * p1; k++) rewards[k] ??= m;
    es.tell(rewards);
    episodes += 2 * p1 * e1 + 2 * keep * e2;
  }
  theta = es.theta;
}
const trainCpu = cpu() - t0;
const [s0, s1] = (await scoreGenomes(helpers, 1, [start.genome, theta], fresh)).map((s) => s.mean);
helpers.close();
const label = values.scheme === "fixed" ? `fixed ${n("pairs")}x${n("episodes")}` : `sh ${n("pairs1")}x${n("eps1")} keep ${n("keep")}x+${n("eps2")}`;
const gain = s1! - s0!;
console.log(`${env.id} s${n("seed")} ${label}: fresh ${s0!.toFixed(3)} -> ${s1!.toFixed(3)} (gain ${gain.toFixed(3)}), train ${trainCpu.toFixed(1)} CPU s, ${episodes} episodes, ${(1000 * trainCpu / episodes).toFixed(2)} ms/episode, gain per CPU s ${(gain / trainCpu).toFixed(4)}`);
if (values.out) writeFileSync(values.out, JSON.stringify({ env: env.id, seed: n("seed"), label, start: s0, end: s1, gain, trainCpu, episodes }) + "\n");
