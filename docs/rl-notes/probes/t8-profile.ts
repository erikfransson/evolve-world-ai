// T8 probe: CPU ms per RL episode and its split into fixed setup and the tick phases (Ecosystem's own PhaseTimer laps).
// Usage (from src/typescript): node ../../docs/rl-notes/probes/t8-profile.ts [--envs nibble,far-food] [--seeds 24] [--learner pool:0|random] [--plain]
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { poolLearner, randomLearner, runEpisode } from "../../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
import { Ecosystem } from "../../../src/typescript/src/sim/ecosystem.ts";
import { PhaseTimer } from "../../../src/typescript/src/sim/profile.ts";

// parameters
const { values } = parseArgs({ options: { envs: { type: "string", default: "nibble,far-food,fading,race,duel,live-patch,live-famine" }, seeds: { type: "string", default: "24" }, learner: { type: "string", default: "pool:0" }, reps: { type: "string", default: "3" }, plain: { type: "boolean", default: false } } });
const seeds = Array.from({ length: Number(values.seeds) }, (_, k) => 5000 + k);

const pool = existsSync("public/pool.json") ? parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries : null;
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const timer = new PhaseTimer();
let profiling = false;
let ticks = 0;
let members = 0;
let gone = 0; // ticks played with no food left in the world
const step = Ecosystem.prototype.step;
Ecosystem.prototype.step = function (this: Ecosystem) {
  ticks++;
  members += this.members.length;
  if ((this as unknown as { economy: { food: number } }).economy.food === 0) gone++;
  if (!profiling) return step.call(this);
  this.profile = timer;
  step.call(this);
  timer.lap("shared rest");
};

for (const id of values.envs.split(",")) {
  const env = envById(id)!;
  const learner = values.learner === "random" ? randomLearner(env, 7) : poolLearner(env, pool![Number(values.learner.split(":")[1])]!);
  const play = (e = env) => seeds.map((s) => runEpisode(e, learner, s, pool));
  play(); // JIT warm-up
  const plain: number[] = [];
  for (let r = 0; r < Number(values.reps); r++) { const t0 = cpu(); play(); plain.push((cpu() - t0) / seeds.length); }
  plain.sort((a, b) => a - b);
  const one = { ...env, seconds: 1 / 30 }; // one tick: the fixed cost of building the episode
  play(one);
  const t1 = cpu(); play(one); const fixed = (cpu() - t1) / seeds.length;
  ticks = members = gone = 0;
  const results = play();
  const tickCount = ticks / seeds.length;
  const crowd = members / ticks;
  const full = env.seconds * 30;
  if (values.plain) { console.log(`${id.padEnd(12)} ms/ep ${plain[plain.length >> 1]!.toFixed(2)} ticks ${tickCount.toFixed(0)}/${full.toFixed(0)} food-gone ticks ${(gone / seeds.length).toFixed(0)}`); continue; }
  profiling = true;
  timer.reset();
  const t2 = cpu(); play(); const profiled = (cpu() - t2) / seeds.length;
  profiling = false;
  const split = [...timer.ms].map(([k, v]) => `${k} ${(v / seeds.length).toFixed(2)}`).join(", ");
  const died = results.filter((r) => r.seconds < env.seconds - 1e-9).length;
  console.log(`${id.padEnd(12)} ms/ep ${plain[plain.length >> 1]!.toFixed(2)} (fixed ${fixed.toFixed(2)}, profiled ${profiled.toFixed(2)}) ticks ${tickCount.toFixed(0)}/${full.toFixed(0)} members ${crowd.toFixed(1)} ended early ${died}/${seeds.length} food-gone ticks ${(gone / seeds.length).toFixed(0)} us/tick ${((1000 * (plain[plain.length >> 1]! - fixed)) / tickCount).toFixed(1)} | ${split}`);
}
