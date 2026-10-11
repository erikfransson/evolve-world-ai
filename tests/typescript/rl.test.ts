import { genomeLength, layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { castFor, envConfig, randomLearner, runEpisode } from "../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec } from "../../src/typescript/src/sim/rl/env.ts";
import { ENVS, envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { Es, centredRanks } from "../../src/typescript/src/sim/rl/es.ts";
import { parseLibrary, serialiseLearner } from "../../src/typescript/src/sim/rl/library.ts";
import { testRng } from "./helpers.ts";

describe("centredRanks", () => {
  it("maps ranks to [-0.5, 0.5] and shares ties", () => {
    expect(centredRanks([10, -3, 7])).toEqual([0.5, -0.5, 0]);
    expect(centredRanks([1, 1, 2, 0])).toEqual([0, 0, 0.5, -0.5]);
  });
});

describe("Es", () => {
  it("climbs a smooth reward towards its peak", () => {
    const target = Float32Array.from({ length: 20 }, (_, i) => Math.sin(i));
    const dist = (x: Float32Array): number => Math.hypot(...x.map((v, i) => v - target[i]!));
    const es = new Es(new Float32Array(20), { pairs: 12, sigma: 0.1, lr: 0.05, decay: 0 });
    const rng = testRng(3);
    const before = dist(es.theta);
    for (let k = 0; k < 150; k++) es.tell(es.ask(rng).map((g) => -dist(g)));
    expect(dist(es.theta)).toBeLessThan(0.3 * before);
  });

  it("rejects a reward list of the wrong length", () => {
    const es = new Es(new Float32Array(4), { pairs: 2 });
    es.ask(testRng(1));
    expect(() => es.tell([1, 2, 3])).toThrow(/expected 4/);
  });
});

describe("RL envs", () => {
  it("have unique ids, a learner species of their world and rivals of it", () => {
    expect(new Set(ENVS.map((e) => e.id)).size).toBe(ENVS.length);
    for (const env of ENVS) {
      const species = env.world === "hunt" ? 2 : 1;
      expect(env.role).toBeLessThan(species);
      for (const r of env.rivals) expect(r.species).toBeLessThan(species);
    }
  });

  it("build a birthless world with the env's items and creatures", () => {
    const env = envById("rivals")!;
    const config = envConfig(env, 5);
    const learner = randomLearner(env, 2);
    const eco = new Ecosystem(config, null, { cast: castFor(env, config, learner, 5, null, {}) });
    expect([eco.food, eco.poison, eco.population]).toEqual([env.food, env.poison, 7]);
    expect(Array.from(eco.get(0)!.creature.brain.genome)).toEqual(Array.from(learner.genome));
    for (let t = 0; t < 300; t++) eco.step();
    expect(eco.births).toBe(0);
  });

  it("plays the same episode for the same seed, and a hunter's genome fits the two-species layout", () => {
    const env = envById("hunt-wanderers")!;
    const learner = randomLearner(env, 4);
    expect(learner.genome.length).toBe(genomeLength(layerSizes(envConfig(env, 1), learner.plan)));
    const short: EnvSpec = { ...env, seconds: 5 };
    expect(runEpisode(short, learner, 9)).toEqual(runEpisode(short, learner, 9));
  });

  it("scores the reward from the learner's own food", () => {
    const env: EnvSpec = { ...envById("forage-box")!, food: 200, poison: 0, seconds: 20, size: [300, 300] };
    const r = runEpisode(env, randomLearner(env, 1), 3);
    expect(r.reward).toBe(r.food);
    expect(r.seconds).toBeGreaterThan(0);
  });
});

describe("library", () => {
  it("round-trips a learner at 3 decimals and skips malformed entries", () => {
    const l = randomLearner(envById("forage-box")!, 1);
    const lib = parseLibrary({ version: 1, envs: { a: [serialiseLearner(l), { plan: {}, genome: ["x"] }] } });
    expect(lib.a).toHaveLength(1);
    expect(lib.a![0]!.genome[0]).toBeCloseTo(l.genome[0]!, 3);
    expect(parseLibrary({ version: 2, envs: {} })).toEqual({});
  });
});
