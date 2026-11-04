// T10 S1 probe: CPU ms per self-play episode and what the Grazer (or a pool founder) scores, per crowd size.
// Usage (from src/typescript): node ../../docs/rl-notes/probes/t10-s1-cost.ts [--crowds 5,10,25,50,100] [--seeds 12] [--learner founder:grazer|pool:0|random]
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { poolLearner, randomLearner } from "../../../src/typescript/src/sim/rl/env.ts";
import type { Learner } from "../../../src/typescript/src/sim/rl/env.ts";
import { parseFounders } from "../../../src/typescript/src/live/founders.ts";
import { PROC_DEFAULTS, runCrowdStats } from "../../../src/typescript/src/sim/rl/procEnv.ts";

// parameters
const { values } = parseArgs({ options: { crowds: { type: "string", default: "5,10,25,50,100" }, seeds: { type: "string", default: "12" }, learner: { type: "string", default: "founder:grazer" } } });
const seeds = Array.from({ length: Number(values.seeds) }, (_, k) => 7000 + k);
const [kind, arg] = values.learner!.split(":");
const pool = existsSync("public/pool.json") ? parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries : null;
let learner: Learner;
if (kind === "founder") { const f = parseFounders(JSON.parse(readFileSync("public/live-founders.json", "utf8"))).find((x) => x.id === arg)!; learner = { plan: f.plan, genome: f.genome }; }
else if (kind === "pool") learner = poolLearner({ world: "ecosystem" }, pool![Number(arg)]!);
else learner = randomLearner({ world: "ecosystem", role: 0 }, Number(arg ?? 1));

const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
console.log("crowd  ms/episode  ticks  life  bites  learners alive  league alive  reward  peak RSS MB");
for (const c of values.crowds!.split(",").map(Number)) {
  const spec = { ...PROC_DEFAULTS, crowd: [c, c] as const };
  runCrowdStats(spec, learner, 1); // warm-up
  const t0 = cpu();
  const r = seeds.map((s) => runCrowdStats(spec, learner, s));
  const ms = (cpu() - t0) / seeds.length;
  const m = (f: (x: (typeof r)[number]) => number) => r.reduce((a, x) => a + f(x), 0) / r.length;
  console.log(`${String(c).padStart(5)}  ${ms.toFixed(1).padStart(10)}  ${m((x) => x.ticks).toFixed(0).padStart(5)}  ${m((x) => x.life).toFixed(2)}  ${m((x) => x.bites).toFixed(2).padStart(5)}  ${m((x) => x.aliveShare).toFixed(2).padStart(14)}  ${m((x) => x.leagueAliveShare).toFixed(2).padStart(12)}  ${m((x) => x.reward).toFixed(2).padStart(6)}  ${(process.memoryUsage.rss() / 1e6).toFixed(0)}`);
}
