import { checkEnv, envConfig, randomLearner, runEpisode, varied, variantFor } from "../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec } from "../../src/typescript/src/sim/rl/env.ts";
import { envById, groupOf } from "../../src/typescript/src/sim/rl/envs.ts";
import { recordEpisode } from "../../src/typescript/src/sim/rl/recording.ts";
import { terrainOf } from "../../src/typescript/src/sim/terrain.ts";
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

  it("an env with slow and fast ground plays on it, and its recordings carry the ground to draw", () => {
    const env: EnvSpec = { ...envById("fading")!, size: [400, 400], slow: 0.3, fast: 0.2, patchSize: 0.4 };
    const config = envConfig(env, 3);
    expect([config.world.slowDensity, config.world.fastDensity, config.world.slowSize]).toEqual([0.3, 0.2, 0.4]);
    const rec = recordEpisode({ ...env, seconds: 1 }, randomLearner(env, 1), 3, null, {});
    expect(rec.terrain).toMatchObject({ seed: 3, world: { width: 400, slowDensity: 0.3, fastDensity: 0.2, slowSize: 0.4 } });
    expect(terrainOf(rec.terrain!).empty).toBe(false);
    expect(recordEpisode({ ...envById("nibble")!, seconds: 1 }, randomLearner(env, 1), 3, null, {}).terrain).toBeNull();
  });

  it("checkEnv bounds the ground and the early weight", () => {
    const env = JSON.parse(JSON.stringify(envById("fading")!));
    expect(checkEnv({ ...env, slow: 0.5 }, "ecosystem", 0)).toMatch(/slow patches/);
    expect(checkEnv({ ...env, patchSize: 3 }, "ecosystem", 0)).toMatch(/patch size/);
    expect(checkEnv({ ...env, reward: { early: 20 } }, "ecosystem", 0)).toMatch(/reward early/);
  });
});

describe("world variation (#54)", () => {
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

  it("ArenaRun trains on the varied envs when the start asks for variation", async () => {
    const env = { ...envById("nibble")!, seconds: 2 };
    const seen: EnvSpec[][] = [];
    const start = {
      type: "start" as const,
      envs: [env],
      learner: serialiseLearner(randomLearner(env, 2)),
      method: "es" as const,
      options: { pairs: 2, sigma: 0.08, lr: 0.02, decay: 0.005, episodes: 1, iterations: 1, vary: 0.3 },
      tiles: 1,
      seed: 1,
      poolUrl: "",
      libraryUrl: "",
      playback: false,
    };
    await new ArenaRun(start, { pool: null, library: {} }, (setup) => (seen.push(setup.envs), new RlPool([inlineRlPort()], setup)), () => {}).run();
    expect(seen[0]![0]!.augment).toEqual({ energy: 0.3, count: 0.3, items: 0.3, size: 0.15 });
  });
});
