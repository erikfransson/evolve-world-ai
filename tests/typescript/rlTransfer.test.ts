import { readFileSync } from "node:fs";
import { envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { checkLearner } from "../../src/typescript/src/sim/rl/library.ts";
import type { Learner } from "../../src/typescript/src/sim/rl/env.ts";
import { BLANK_ENV, randomLearner, runEpisode } from "../../src/typescript/src/sim/rl/env.ts";
import { HELD_BASE } from "../../src/typescript/src/sim/rl/trainer.ts";
import { GROUPS, METRICS, TRANSFER_BASE, batteryEnvs, pairedDifference, t975, tInterval, transferEpisode, transferSeeds } from "../../src/typescript/src/sim/rl/transfer.ts";
import type { GenomeResult, PerSeed } from "../../src/typescript/src/sim/rl/transfer.ts";

const POISON_ENV = { ...BLANK_ENV, id: "t-poison", size: [200, 200] as [number, number], food: 0, poison: 40, seconds: 10, poisonDamage: 10 };

describe("transfer battery", () => {
  it("counts the learner's poison bites and the energy they took", () => {
    let bites = 0;
    for (let s = 1; s <= 6; s++) {
      const r = runEpisode(POISON_ENV, randomLearner(POISON_ENV, s), s);
      bites += r.poison;
      expect(r.poisonEnergy).toBeLessThanOrEqual(r.poison * 10);
      expect(r.died).toBe(r.seconds < 10 ? 1 : 0);
    }
    expect(bites).toBeGreaterThan(0);
  });

  it("is deterministic and keeps its seeds apart from training and the existing held-out seeds", () => {
    const { env } = batteryEnvs()[0]!;
    const l = randomLearner(env, 3);
    const a = transferEpisode({ ...env, seconds: 4 }, l, TRANSFER_BASE, null, {});
    expect(transferEpisode({ ...env, seconds: 4 }, l, TRANSFER_BASE, null, {})).toEqual(a);
    expect(transferSeeds(64)[0]).toBeGreaterThan(HELD_BASE + 10000);
    expect(batteryEnvs().map((e) => e.group)).toEqual(expect.arrayContaining([...GROUPS]));
  });

  it("t quantile and paired intervals", () => {
    expect(t975(9)).toBeCloseTo(2.262, 2);
    expect(t975(63)).toBeCloseTo(1.998, 2);
    const ci = tInterval([1, 2, 3, 4]);
    expect(ci.mean).toBe(2.5);
    expect(ci.lo).toBeLessThan(2.5);
    const per = (v: number): PerSeed => Object.fromEntries(METRICS.map((m) => [m, [v, v + 1, v + 2]])) as PerSeed;
    const a: GenomeResult = { name: "a", source: "", envs: { x: per(1), y: per(3) } };
    const b: GenomeResult = { name: "b", source: "", envs: { x: per(0), y: per(3) } };
    const d = pairedDifference(a, b, { x: "small", y: "bigger" });
    expect(d.all.survival.mean).toBeCloseTo(0.5);
    expect(d.byEnv.y!.survival.mean).toBe(0);
    expect(d.byGroup.small!.survival.mean).toBe(1);
  });
});

import { DESIGN_PANEL, designLearner } from "../../src/typescript/src/sim/rl/designPanel.ts";
import { checkPlan } from "../../src/typescript/src/sim/rl/validate.ts";
import { genomeLengthIn } from "../../src/typescript/src/sim/rl/env.ts";

describe("design panel", () => {
  it("holds valid designs with fixed weights", () => {
    expect(DESIGN_PANEL.length).toBe(8);
    for (const p of DESIGN_PANEL) {
      expect(typeof checkPlan(p.plan)).not.toBe("string");
      const a = designLearner(p), b = designLearner(p);
      expect(a.genome.length).toBe(genomeLengthIn("ecosystem", p.plan));
      expect(Array.from(a.genome)).toEqual(Array.from(b.genome));
    }
  });
});

describe("cleared episodes", () => {
  it("keep the real elapsed time and the clear time, and count as survived", () => {
    const env = envById("nibble")!; // 3 food, speed-scored, no regrowth
    const trained = checkLearner(JSON.parse(readFileSync(new URL("../../docs/rl-notes/t10-m1-panel/es/p2-narrow-long.json", import.meta.url), "utf8")), "ecosystem") as Learner;
    let cleared = 0;
    for (let s = 1; s <= 20; s++) {
      const r = runEpisode(env, trained, s);
      if (r.clearTime >= 0) {
        cleared++;
        expect(r.seconds).toBe(env.seconds);
        expect(r.elapsed).toBe(r.clearTime);
        expect(r.elapsed).toBeLessThan(env.seconds);
      }
    }
    expect(cleared).toBeGreaterThan(0);
  });
});
