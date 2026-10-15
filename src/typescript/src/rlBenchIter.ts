// RL training speed benchmark: seconds per ES iteration in a few typical Arena setups, plus a checksum of the trained weights,
// so a speedup that should not change results can be checked for identical output.
// Usage: node src/rlBenchIter.ts [--only small,big,...] [--iters 6] [--threads 2] [--episodes]
//   --episodes also times single-thread episodes per second for each setup (no pool).
import { parseArgs } from "node:util";
import { layerSizes, randomGenome } from "./sim/brain.ts";
import { createRng } from "./sim/rng.ts";
import { layoutConfig, runEpisode } from "./sim/rl/env.ts";
import { envById } from "./sim/rl/envs.ts";
import { Trainer } from "./sim/rl/trainer.ts";
import { createNodeRlPool } from "./worker/nodePool.ts";

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    iters: { type: "string", default: "6" },
    threads: { type: "string", default: "2" },
    episodes: { type: "boolean", default: false },
  },
});

const SMALL = { rayCount: 5, raySpread: (120 * Math.PI) / 180, rayLength: 180, hiddenLayers: [12], memoryShort: 2, memoryLong: 2 };
const BIG = { rayCount: 16, raySpread: (180 * Math.PI) / 180, rayLength: 250, hiddenLayers: [64, 64], memoryShort: 8, memoryLong: 8 };
const TEN = ["nibble", "corridor", "far-food", "patch", "minefield", "fence", "rooms", "islands", "sprint", "lean-times"];

const SETUPS = {
  small: { envs: ["nibble"], plan: SMALL, pop: 100 }, // the Arena default
  big: { envs: ["nibble"], plan: BIG, pop: 100 }, // a big brain
  many: { envs: TEN, plan: SMALL, pop: 100 }, // many envs chosen
  crowd: { envs: ["crowd"], plan: SMALL, pop: 100 }, // many creatures per episode
  pop500: { envs: ["nibble"], plan: SMALL, pop: 500 }, // a big population
  bigmany: { envs: TEN, plan: BIG, pop: 100 },
} as const;

const only = values.only ? values.only.split(",") : Object.keys(SETUPS);
const iters = Number(values.iters);
const threads = Number(values.threads);

function checksum(theta: Float32Array): string {
  let h = 0;
  for (let i = 0; i < theta.length; i++) h = (h * 31 + Math.round(theta[i]! * 1e6)) | 0;
  return (h >>> 0).toString(16);
}

for (const name of only) {
  const s = SETUPS[name as keyof typeof SETUPS];
  if (!s) throw new Error(`unknown setup ${name}`);
  const envs = s.envs.map((id) => envById(id)!);
  const genome = randomGenome(layerSizes(layoutConfig("ecosystem"), s.plan), createRng(7));
  if (values.episodes) {
    const learner = { plan: s.plan, genome };
    let n = 0;
    let ticks = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 3000) {
      const r = runEpisode(envs[n % envs.length]!, learner, n);
      ticks += Math.round(r.seconds * 30);
      n++;
    }
    const sec = (performance.now() - t0) / 1000;
    console.log(`${name.padEnd(8)} episodes/s ${(n / sec).toFixed(1).padStart(7)}  learner-ticks/s ${(ticks / sec).toFixed(0).padStart(7)}`);
  }
  const pool = createNodeRlPool({ envs, plan: s.plan, pool: null, library: {} }, threads);
  const trainer = new Trainer(genome, { pairs: s.pop / 2 }, pool, envs.length, 1, 1);
  await trainer.step(); // warm-up: JIT and helper start
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) await trainer.step();
  const per = (performance.now() - t0) / 1000 / iters;
  pool.close();
  console.log(`${name.padEnd(8)} s/iter ${per.toFixed(3).padStart(7)}  (${s.envs.length} env, pop ${s.pop}, ${threads} threads)  checksum ${checksum(trainer.theta)}`);
}
