// T10 S1 fallback battery (used when the rl-xfer M1 battery is not available): trained genomes on unseen Live-like worlds, every episode kept.
// Usage (from src/typescript): node ../../docs/rl-notes/probes/t10-s1-battery.ts --out battery.json [--seeds 48] name=path.json ... (path: rlTrain --out file, or founder:ID, pool:N, design:ID)
// Crowd worlds (live-*: seed pool crowds, bumps hurt, 300 energy, 90 s) give survival and food per minute among rivals.
// Solo worlds (the same without rivals, prefix solo-) give poison bites, time to first food and food per minute. Seeds HELD_BASE + 5000 + k, which no training run draws.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { poolLearner, runEpisode } from "../../../src/typescript/src/sim/rl/env.ts";
import type { Learner } from "../../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
import { DESIGN_PANEL, designLearner } from "../../../src/typescript/src/sim/rl/designPanel.ts";
import { HELD_BASE } from "../../../src/typescript/src/sim/rl/trainer.ts";
import { parseFounders } from "../../../src/typescript/src/live/founders.ts";

// parameters
const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" }, seeds: { type: "string", default: "48" }, envs: { type: "string", default: "live-now,live-patch,live-famine,live-poison,solo-live-now,solo-live-famine,solo-live-poison" } } });
const seeds = Array.from({ length: Number(values.seeds) }, (_, k) => HELD_BASE + 5000 + k);
const pool = parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries;
const founders = parseFounders(JSON.parse(readFileSync("public/live-founders.json", "utf8")));
const load = (src: string): Learner => {
  const [kind, arg] = src.split(/:(.*)/);
  if (kind === "founder") { const f = founders.find((x) => x.id === arg)!; return { plan: f.plan, genome: f.genome }; }
  if (kind === "design") return designLearner(DESIGN_PANEL.find((x) => x.id === arg)!);
  if (kind === "pool") return poolLearner({ world: "ecosystem" }, pool[Number(arg)]!);
  const j = JSON.parse(readFileSync(src, "utf8")) as { plan: Learner["plan"]; genome: number[] };
  return { plan: j.plan, genome: Float32Array.from(j.genome) };
};
const rows: { name: string; env: string; seed: number; seconds: number; food: number; poison: number; first: number; reward: number }[] = []; // first: seconds to the first food, the episode length if none
for (const arg of positionals) {
  const [name, src] = arg.split(/=(.*)/);
  if (!(src!.includes(":") || existsSync(src!))) throw new Error(`no file ${src}`);
  const learner = load(src!);
  for (const id of values.envs!.split(",")) {
    const solo = id.startsWith("solo-");
    const base = envById(solo ? id.slice(5) : id)!;
    const env = solo ? { ...base, rivals: [] } : base;
    for (const seed of seeds) {
      let first = base.seconds;
      let poison = 0;
      let t = 0;
      const r = runEpisode(env, learner, seed, pool, {}, solo ? (eco) => {
        t++;
        poison = eco.poisonEaten;
        if (first === base.seconds && (eco.get(0)?.eaten ?? 0) > 0) first = t / 30;
      } : undefined);
      rows.push({ name: name!, env: id, seed, seconds: r.seconds, food: r.food, poison: solo ? poison : NaN, first: solo ? first : NaN, reward: r.reward });
    }
  }
  const mine = rows.filter((r) => r.name === name);
  console.log(`${name}: survival ${(mine.reduce((a, r) => a + r.seconds, 0) / mine.length).toFixed(1)} s, food ${(mine.reduce((a, r) => a + r.food, 0) / mine.length).toFixed(2)} (${mine.length} episodes)`);
}
if (values.out) writeFileSync(values.out, JSON.stringify(rows) + "\n");
