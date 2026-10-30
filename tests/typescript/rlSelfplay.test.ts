import { randomLearner, runEpisode, SELF } from "../../src/typescript/src/sim/rl/env.ts";
import { PROC_DEFAULTS, crowdReward, drawWorld, procEnv, runCrowdStats } from "../../src/typescript/src/sim/rl/procEnv.ts";
import { ENVS } from "../../src/typescript/src/sim/rl/envs.ts";

const spec = { ...PROC_DEFAULTS, crowd: [6, 8] as const, seconds: [30, 40] as const, energy: [25, 40] as const }; // low energy so bodies die and the league matters
const learner = randomLearner({ world: "ecosystem", role: 0 }, 3);

describe("procedural self-play world (S1)", () => {
  it("draws the same world from a seed, another from another, inside the ranges", () => {
    expect(drawWorld(PROC_DEFAULTS, 5)).toEqual(drawWorld(PROC_DEFAULTS, 5));
    const worlds = Array.from({ length: 60 }, (_, k) => drawWorld(PROC_DEFAULTS, k));
    expect(new Set(worlds.map((w) => w.size.join("x"))).size).toBeGreaterThan(50);
    const kinds = new Set(worlds.map((w) => w.layout?.kind ?? "open"));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    for (const w of worlds) {
      expect(w.crowd).toBeGreaterThanOrEqual(5);
      expect(w.crowd).toBeLessThanOrEqual(50);
      expect(w.learners).toBeGreaterThanOrEqual(1);
      expect(w.learners).toBeLessThan(w.crowd);
      for (const s of w.size) expect(s >= 200 && s <= 3000).toBe(true);
      expect(w.seconds >= 40 && w.seconds <= 90).toBe(true);
      expect(w.food).toBeGreaterThan(0);
      expect(w.regrow).toBeGreaterThan(0);
    }
  });

  it("plays deterministically per seed and finishes with finite stats", () => {
    const a = runCrowdStats(spec, learner, 11);
    expect(runCrowdStats(spec, learner, 11)).toEqual(a);
    expect(Number.isFinite(a.reward) && a.life >= 0 && a.life <= 1 && a.aliveShare >= 0 && a.aliveShare <= 1).toBe(true);
    expect(runCrowdStats(spec, learner, 12).reward).not.toBe(a.reward);
  });

  it("is reached through runEpisode and uses the league in library[SELF]", () => {
    const env = procEnv(spec);
    const alone = runEpisode(env, learner, 21);
    expect(alone.reward).toBe(runCrowdStats(spec, learner, 21).reward);
    const other = randomLearner({ world: "ecosystem", role: 0 }, 9);
    const withLeague = runEpisode(env, learner, 21, null, { [SELF]: [other] });
    expect(withLeague.reward).not.toBe(alone.reward);
    expect(() => runEpisode(env, learner, 21, null, {}, () => {})).toThrow();
  });

  it("rewards life plus the food share, and leaves the built-in envs alone", () => {
    expect(crowdReward(0.5, 4, 2, 0.25)).toBeCloseTo(1);
    expect(ENVS.some((e) => e.proc)).toBe(false);
    const lineage = runCrowdStats({ ...spec, lineageWeight: 1 }, learner, 11);
    expect(lineage.reward).toBeGreaterThanOrEqual(runCrowdStats(spec, learner, 11).reward);
  });
});
