import { checkEnv, randomLearner, runEpisode, varied, variantFor } from "../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec } from "../../src/typescript/src/sim/rl/env.ts";
import { envById, groupOf } from "../../src/typescript/src/sim/rl/envs.ts";
import { heldSeeds } from "../../src/typescript/src/sim/rl/trainer.ts";
import { serialiseLearner } from "../../src/typescript/src/sim/rl/library.ts";
import { ArenaRun } from "../../src/typescript/src/worker/arenaRun.ts";
import { RlPool, inlineRlPort } from "../../src/typescript/src/worker/rlPool.ts";

const TIME_PRESSURE = ["fading", "stings", "race"];

describe("time-pressure envs (#56)", () => {
  it("are filed under Time pressure, keep within the custom env limits and play an episode", () => {
    for (const id of TIME_PRESSURE) {
      const env = envById(id)!;
      expect(groupOf(env)).toBe("Time pressure");
      expect(typeof checkEnv(JSON.parse(JSON.stringify(env)), "ecosystem", 0)).not.toBe("string");
      const r = runEpisode({ ...env, seconds: 3 }, randomLearner(env, 1), 7);
      expect(Number.isFinite(r.reward)).toBe(true);
    }
  });

  it("early pays each bite by the share of the episode left, so it lies between 0 and the bites", () => {
    const base: EnvSpec = { ...envById("fading")!, size: [200, 200], food: 30, seconds: 8 };
    let checked = 0;
    for (let s = 1; s <= 30 && checked < 3; s++) {
      const learner = randomLearner(base, s);
      const food = runEpisode({ ...base, reward: { food: 1 } }, learner, s);
      if (food.food === 0) continue;
      const early = runEpisode({ ...base, reward: { early: 1 } }, learner, s);
      expect(early.food).toBe(food.food);
      expect(early.reward).toBeGreaterThan(0);
      expect(early.reward).toBeLessThan(food.reward);
      expect(runEpisode({ ...base, reward: { food: 1, early: 1 } }, learner, s).reward).toBeCloseTo(food.reward + early.reward, 9);
      checked++;
    }
    expect(checked).toBe(3); // a random brain in a box this full eats something on some seeds
  });

  it("checkEnv bounds the early weight", () => {
    const env = JSON.parse(JSON.stringify(envById("fading")!));
    expect(checkEnv({ ...env, reward: { early: 20 } }, "ecosystem", 0)).toMatch(/reward early/);
  });
});

describe("world variation (#54, rlTrain --vary)", () => {
  it("augments plain envs, leaves layout sizes, duels, own augments and zero alone", () => {
    const nibble = envById("nibble")!;
    expect(varied(nibble, 0)).toBe(nibble);
    expect(varied(nibble, 0.2).augment).toEqual({ energy: 0.2, count: 0.2, items: 0.2, size: 0.1 });
    expect(varied(envById("fence")!, 0.2).augment).toEqual({ energy: 0.2, count: 0.2, items: 0.2 });
    const own: EnvSpec = { ...nibble, augment: { items: 0.5 } };
    expect(varied(own, 0.2)).toBe(own);
    const sizes = new Set([1, 2, 3, 4, 5, 6].map((s) => variantFor(varied(nibble, 0.4), s).size[0]));
    expect(sizes.size).toBeGreaterThan(1); // each episode another version
  });
});

describe("held-out seeds (#54)", () => {
  const env = { ...envById("nibble")!, food: 40, seconds: 3 }; // full enough that a random brain eats on some seeds
  const learner = randomLearner(env, 2);
  const startWith = (seed: number, held?: number) => ({
    type: "start" as const,
    envs: [env],
    learner: serialiseLearner(learner),
    method: "es" as const,
    options: { pairs: 2, sigma: 0.08, lr: 0.02, decay: 0.005, episodes: 1, iterations: 1 },
    tiles: 1,
    ...(held === undefined ? {} : { held }),
    seed,
    poolUrl: "",
    libraryUrl: "",
    playback: false,
  });
  const ready = async (seed: number, held?: number): Promise<number> => {
    let out = NaN;
    await new ArenaRun(startWith(seed, held), { pool: null, library: {} }, (setup) => new RlPool([inlineRlPort()], setup), (m) => {
      if (m.type === "ready") out = m.held;
    }).run();
    return out;
  };
  const meanOn = (n: number): number => heldSeeds(n).reduce((a, s) => a + runEpisode(env, learner, s).reward, 0) / n;

  it("are a fixed set: the same genome scores the same whatever the run seed, 4 per env by default and 12 when asked", async () => {
    expect(meanOn(12)).toBeGreaterThan(0); // else every check below compares zeros
    expect(await ready(1)).toBe(await ready(99));
    expect(await ready(1)).toBeCloseTo(meanOn(4), 9);
    expect(await ready(5, 12)).toBeCloseTo(meanOn(12), 9);
  });
});
