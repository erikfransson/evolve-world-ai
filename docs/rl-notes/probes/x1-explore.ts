// X1 probe: scripted baselines for the Explore envs (and any other), per policy: reward, food, alive share, grid cells covered (side = the learner's ray length) per episode.
// Run from src/typescript: node ../../docs/rl-notes/probes/x1-explore.ts --envs horizon,moving-on,explorer --seeds 32 --rays 60,150,250 --out runs/x1-baselines.json
// Spin turns on the spot, wiggle thrusts with slowly changing random turns, straight goes ahead and turns back at a wall, all blind (the brain is overwritten).
// Seek variants add 12 rays all round: steer at the nearest food seen, else go straight (seek-straight) or wiggle (seek-wiggle), the fair test of directed travel against a random walk.
// Founders (pool and Live) and untrained random and panel designs act with their own brains and rays.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { genomeLength, layerSizes } from "../../../src/typescript/src/sim/brain.ts";
import { createRng } from "../../../src/typescript/src/sim/rng.ts";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { OUT_THRUST, OUT_TURN } from "../../../src/typescript/src/sim/sensors.ts";
import type { PlanView } from "../../../src/typescript/src/sim/sensors.ts";
import type { Ecosystem } from "../../../src/typescript/src/sim/ecosystem.ts";
import type { Creature } from "../../../src/typescript/src/sim/creature.ts";
import { genomeLengthIn, layoutConfig, poolLearner, randomLearner, runEpisode } from "../../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec, EpisodeResult, Learner } from "../../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
import { DESIGN_PANEL, designLearner } from "../../../src/typescript/src/sim/rl/designPanel.ts";
import { HIT_FOOD } from "../../../src/typescript/src/sim/types.ts";
import { heldSeeds } from "../../../src/typescript/src/sim/rl/trainer.ts";

// parameters
const { values } = parseArgs({
  options: {
    envs: { type: "string", default: "horizon,moving-on,explorer" },
    seeds: { type: "string", default: "32" },
    rays: { type: "string", default: "60,150,250" }, // ray lengths of the scripted bodies
    pools: { type: "string", default: "8" },
    randoms: { type: "string", default: "8" },
    out: { type: "string" },
    reach: { type: "string", default: "3" },
  },
});
const seeds = heldSeeds(Number(values.seeds));
const pool = parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries;
const founders = JSON.parse(readFileSync("public/live-founders.json", "utf8")).founders as { id: string; plan: PlanView; genome: number[] }[];
const REACH = Number(values.reach); // bites that only the far patch can add up to (pasture: 3 near bites)
const mean = (x: number[]): number => x.reduce((a, b) => a + b, 0) / x.length;

const body = (rayLength: number): PlanView => ({ rayCount: 1, raySpread: 0, rayLength, hiddenLayers: [1], memoryShort: 0, memoryLong: 0 });
const blank = (plan: PlanView): Learner => ({ plan, genome: new Float32Array(genomeLength(layerSizes(layoutConfig("ecosystem"), plan))) });
const sighted = (rayLength: number): PlanView => ({ rayCount: 12, raySpread: Math.PI, rayLength, hiddenLayers: [1], memoryShort: 0, memoryLong: 0 });
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
type Act = (c: Creature) => void;

function spin(): Act {
  return (c) => { c.outputs[OUT_TURN] = 1; c.outputs[OUT_THRUST] = 0; };
}
function wiggle(seed: number): Act {
  const rng = createRng(seed * 7919 + 13);
  let turn = 0;
  let t = 0;
  return (c) => {
    if (t++ % 15 === 0) turn = rng.range(-1, 1); // a new turn every half second
    c.outputs[OUT_TURN] = turn;
    c.outputs[OUT_THRUST] = 1;
  };
}
function straight(w: number, h: number): Act {
  let away = false; // turning back from a wall until facing the middle
  return (c) => {
    const s = c.state;
    const m = 60;
    const nearWall = s.x < m || s.x > w - m || s.y < m || s.y > h - m;
    const err = wrap(Math.atan2(h / 2 - s.y, w / 2 - s.x) - s.heading);
    if (nearWall) away = true;
    if (away && Math.abs(err) < 0.6) away = false;
    c.outputs[OUT_THRUST] = 1;
    c.outputs[OUT_TURN] = away ? Math.sign(err) : 0;
  };
}

// Steers at the strongest food ray; with none in view calls the fallback, which sets thrust and turn itself.
function seek(fallback: Act): Act {
  return (c) => {
    let best = -1;
    let at = 0;
    c.rays.forEach((r, i) => { if (r.kind === HIT_FOOD && r.closeness > best) { best = r.closeness; at = i; } });
    if (best > 0) { c.outputs[OUT_THRUST] = 1; c.outputs[OUT_TURN] = Math.max(-1, Math.min(1, 3 * c.rayOffsets[at]!)); }
    else fallback(c);
  };
}

interface Row { policy: string; group: string; reward: number; food: number; late: number; reach: number; gap: number; alive: number; cells: number; zero: number }
function run(env: EnvSpec, name: string, group: string, learner: Learner, act?: (seed: number) => Act): Row {
  const eps: EpisodeResult[] = [];
  const gaps: number[] = []; // trail layout: path walked between consecutive bites after the first, over the gap between singles
  const R = Math.max(50, Math.min(learner.plan.rayLength, 250));
  for (const sd of seeds) {
    let last: { x: number; y: number } | null = null;
    let path = 0;
    let eaten = 0;
    const hook = env.layout?.kind === "trail" ? (eco: Ecosystem): void => {
      const me = eco.get(0);
      if (!me) return;
      const st = me.creature.state;
      if (last) path += Math.hypot(st.x - last.x, st.y - last.y);
      last = { x: st.x, y: st.y };
      if (me.eaten > eaten) {
        if (eaten >= 1 && eaten <= 2) gaps.push(path / (1.8 * R + 10));
        eaten = me.eaten;
        path = 0;
      }
    } : undefined;
    eps.push(runEpisode(env, learner, sd, pool, {}, hook, act?.(sd)));
  }
  return { policy: name, group, reward: mean(eps.map((e) => e.reward)), food: mean(eps.map((e) => e.food)), late: mean(eps.map((e) => e.late)), reach: eps.filter((e) => e.food > REACH).length / eps.length, gap: gaps.length ? mean(gaps) : NaN, alive: mean(eps.map((e) => e.seconds)) / env.seconds, cells: mean(eps.map((e) => e.cells)), zero: eps.filter((e) => e.food === 0).length / eps.length };
}

const all: Record<string, Row[]> = {};
for (const id of values.envs!.split(",")) {
  const env = envById(id)!;
  const rows: Row[] = [];
  for (const R of values.rays!.split(",").map(Number)) {
    const l = blank(body(R));
    rows.push(run(env, `spin R${R}`, "scripted", l, () => spin()));
    rows.push(run(env, `wiggle R${R}`, "scripted", l, (s) => wiggle(s)));
    rows.push(run(env, `straight R${R}`, "scripted", l, () => straight(env.size[0], env.size[1])));
    const sl = blank(sighted(R));
    rows.push(run(env, `seek-wiggle R${R}`, "seeker", sl, (s) => seek(wiggle(s))));
    rows.push(run(env, `seek-straight R${R}`, "seeker", sl, () => seek(straight(env.size[0], env.size[1]))));
  }
  for (let k = 0; k < Number(values.pools); k++) rows.push(run(env, `pool:${k}`, "founder", poolLearner(env, pool[k]!)));
  for (const f of founders) if (f.genome.length === genomeLengthIn("ecosystem", f.plan)) rows.push(run(env, f.id, "founder", { plan: f.plan, genome: Float32Array.from(f.genome) }));
  for (let k = 1; k <= Number(values.randoms); k++) rows.push(run(env, `random:${k}`, "random", randomLearner(env, k)));
  for (const d of DESIGN_PANEL) rows.push(run(env, `${d.id} (R${d.plan.rayLength})`, "panel", designLearner(d)));
  all[id] = rows;
  console.log(`\n${id} (${seeds.length} seeds): reward food late reach gap alive cells noFood`);
  for (const r of rows) console.log(`  ${r.policy.padEnd(26)} ${r.group.padEnd(9)} ${r.reward.toFixed(2).padStart(6)} ${r.food.toFixed(2).padStart(5)} ${r.late.toFixed(2).padStart(5)} ${r.reach.toFixed(2)} ${r.gap.toFixed(2)} ${r.alive.toFixed(2).padStart(5)} ${r.cells.toFixed(1).padStart(6)} ${r.zero.toFixed(2)}`);
}
if (values.out) writeFileSync(values.out, JSON.stringify(all, null, 1) + "\n");
process.exit(0);
