// F1 probe: scripted baselines for a ram env (passive, spin, wiggle, seek at half speed, seek with a run-up), on three random bodies.
// Run from src/typescript: node ../../docs/rl-notes/probes/f1-ram.ts --file ../../docs/rl-notes/probes/f1-stragglers.json --seeds 32 (or --env ID)
// The seekers cheat: they read the rivals' positions from the world. Medium = the last rival (highest id).

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createRng } from "../../../src/typescript/src/sim/rng.ts";
import { randomLearner, runEpisode } from "../../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec, Learner } from "../../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
import type { Creature } from "../../../src/typescript/src/sim/creature.ts";
import type { Ecosystem } from "../../../src/typescript/src/sim/ecosystem.ts";
import { OUT_THRUST, OUT_TURN } from "../../../src/typescript/src/sim/sensors.ts";

// parameters
const { values } = parseArgs({ options: { env: { type: "string", default: "corral" }, file: { type: "string" }, seeds: { type: "string", default: "32" }, bodies: { type: "string", default: "3" } } });
const env = values.file ? (JSON.parse(readFileSync(values.file, "utf8")) as EnvSpec) : envById(values.env!)!;
const SEEDS = Number(values.seeds);
const BODIES = Number(values.bodies);

type Policy = (me: Creature, eco: Ecosystem | null, rng: ReturnType<typeof createRng>) => [number, number]; // [turn, thrust]
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
function seek(speed: number): Policy {
  return (me, eco) => {
    if (!eco) return [0, 0];
    const s = me.state;
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (const m of eco.members) {
      if (m.id === 0 || !m.creature.state.alive) continue;
      const d = (m.creature.state.x - s.x) ** 2 + (m.creature.state.y - s.y) ** 2;
      if (d < bd) { bd = d; best = m.creature.state; }
    }
    if (!best) return [0, 0];
    const err = wrap(Math.atan2(best.y - s.y, best.x - s.x) - s.heading);
    return [Math.max(-1, Math.min(1, err * 3)), Math.abs(err) < 0.5 ? speed : 0];
  };
}
const POLICIES: Record<string, Policy> = {
  passive: () => [0, 0],
  spin: () => [1, 0],
  "spin+drive": () => [1, 0.5],
  wiggle: (_m, _e, rng) => [rng.range(-1, 1), 0.5],
  "seek half": seek(0.3),
  "seek full": seek(0.999),
};

const mean = (x: number[]): number => x.reduce((a, b) => a + b, 0) / x.length;
const rows: string[] = ["| policy | reward | alive s | rams | medium killed | died |", "| --- | --- | --- | --- | --- | --- |"];
for (const [name, policy] of Object.entries(POLICIES)) {
  const r: number[] = [], sec: number[] = [], rams: number[] = [], med: number[] = [], died: number[] = [];
  for (let b = 1; b <= BODIES; b++) {
    const learner: Learner = randomLearner(env, b);
    for (let seed = 1000; seed < 1000 + SEEDS; seed++) {
      const rng = createRng(seed);
      let eco: Ecosystem | null = null;
      let medId = -1;
      let medDead = 0;
      const res = runEpisode(env, learner, seed, null, {}, (e) => {
        eco = e;
        if (medId < 0) medId = Math.max(...e.members.map((m) => m.id));
        if (!e.members.some((m) => m.id === medId && m.creature.state.alive)) medDead = 1;
      }, (c) => {
        const [turn, thrust] = policy(c, eco, rng);
        c.outputs[OUT_TURN] = turn;
        c.outputs[OUT_THRUST] = thrust;
      });
      r.push(res.reward); sec.push(res.seconds); rams.push(res.rams); med.push(medDead); died.push(res.died);
    }
  }
  rows.push(`| ${name} | ${mean(r).toFixed(2)} | ${mean(sec).toFixed(1)} | ${mean(rams).toFixed(2)} | ${mean(med).toFixed(2)} | ${mean(died).toFixed(2)} |`);
}
console.log(rows.join("\n"));
