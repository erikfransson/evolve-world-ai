// Backprop RL (PPO) speed: CPU seconds per update in typical setups, plus a checksum of the weights.
// Usage: node src/rlBenchPpo.ts [--only small,big,lean,many,bigmany] [--iters 5] [--episodes 16]
import { parseArgs } from "node:util";
import { layerSizes, randomGenome } from "./sim/brain.ts";
import { createRng } from "./sim/rng.ts";
import { layoutConfig } from "./sim/rl/env.ts";
import { envById } from "./sim/rl/envs.ts";
import { Ppo } from "./sim/rl/ppo.ts";

const { values } = parseArgs({ options: { only: { type: "string" }, iters: { type: "string", default: "5" }, episodes: { type: "string", default: "16" } } });
const SMALL = { rayCount: 5, raySpread: (120 * Math.PI) / 180, rayLength: 180, hiddenLayers: [12], memoryShort: 2, memoryLong: 2 };
const BIG = { rayCount: 16, raySpread: Math.PI, rayLength: 250, hiddenLayers: [64, 64], memoryShort: 8, memoryLong: 8 };
const TEN = ["nibble", "corridor", "far-food", "patch", "minefield", "fence", "maze", "rooms", "islands", "lean-times"];
const SETUPS = {
  small: { envs: ["nibble"], plan: SMALL },
  big: { envs: ["nibble"], plan: BIG },
  lean: { envs: ["lean-times"], plan: SMALL },
  many: { envs: TEN, plan: SMALL },
  bigmany: { envs: TEN, plan: BIG },
} as const;
const only = values.only ? values.only.split(",") : Object.keys(SETUPS);
const checksum = (t: Float32Array): string => {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + Math.round(t[i]! * 1e6)) | 0;
  return (h >>> 0).toString(16);
};
for (const name of only) {
  const s = SETUPS[name as keyof typeof SETUPS];
  const envs = s.envs.map((id) => envById(id)!);
  const genome = randomGenome(layerSizes(layoutConfig("ecosystem"), s.plan), createRng(7));
  const sizes = layerSizes(layoutConfig(envs[0]!.world), s.plan);
  const ppo = new Ppo(envs, { plan: s.plan, genome }, sizes, { lr: 0.003, episodes: Number(values.episodes) }, 1);
  ppo.step();
  const t0 = process.cpuUsage();
  for (let i = 0; i < Number(values.iters); i++) ppo.step();
  const u = process.cpuUsage(t0);
  const per = (u.user + u.system) / 1e6 / Number(values.iters);
  console.log(`${name.padEnd(8)} cpu s/iter ${per.toFixed(3)}  eps/s ${(Number(values.episodes) / per).toFixed(1)}  checksum ${checksum(ppo.theta)}`);
}
