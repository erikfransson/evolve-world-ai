import { layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { dropSpareKernels, layoutConfig, randomLearner, runEpisode } from "../../src/typescript/src/sim/rl/env.ts";
import type { Learner } from "../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { wasmAvailable } from "../../src/typescript/src/sim/wasm/loader.ts";

const BIG = { rayCount: 16, raySpread: Math.PI, rayLength: 250, hiddenLayers: [64, 64], memoryShort: 8, memoryLong: 8 };
const bigLearner = (): Learner => ({ plan: BIG, genome: randomGenome(layerSizes(layoutConfig("ecosystem"), BIG), createRng(7)) });

describe.skipIf(!wasmAvailable())("kernel reuse across episodes", () => {
  const cases: [string, string, (env: string) => Learner][] = [
    ["nibble", "crowd", (e) => randomLearner(envById(e)!, 3)],
    ["crowd", "islands", (e) => randomLearner(envById(e)!, 3)],
    ["islands", "lean-times", (e) => randomLearner(envById(e)!, 3)],
    ["nibble", "crowd", bigLearner],
    ["crowd", "nibble", bigLearner],
  ];
  for (const [before, env, learner] of cases) {
    it(`${env} after ${before} equals ${env} on fresh kernels`, () => {
      const l = learner(env);
      dropSpareKernels();
      const fresh = runEpisode(envById(env)!, l, 11);
      runEpisode(envById(before)!, l, 5); // leaves state behind (other world size, slots, regions)
      expect(runEpisode(envById(env)!, l, 11)).toEqual(fresh);
      expect(runEpisode(envById(env)!, l, 11)).toEqual(fresh); // and again, after itself
    });
  }
});
