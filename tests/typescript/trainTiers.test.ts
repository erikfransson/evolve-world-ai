import { readFileSync } from "node:fs";
import { RECOMMENDED_MIX, envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { TRAIN_TIERS } from "../../src/typescript/src/sim/rl/trainTiers.ts";

describe("TRAIN_TIERS", () => {
  it("has three tiers with growing totals", () => {
    expect(TRAIN_TIERS.map((t) => t.id)).toEqual(["light", "medium", "strong"]);
    expect(TRAIN_TIERS.map((t) => t.seconds)).toEqual([30, 75, 200]);
  });

  it("splits each tier's seconds over its phases by shares that add to 1", () => {
    for (const t of TRAIN_TIERS) {
      expect(t.phases.length).toBeGreaterThan(0);
      expect(t.phases.reduce((s, p) => s + p.share, 0)).toBeCloseTo(1, 9);
      for (const p of t.phases) expect(p.share).toBeGreaterThan(0);
    }
  });

  it("names only existing ecosystem envs and gives each phase the options of its method", () => {
    for (const t of TRAIN_TIERS) {
      for (const p of t.phases) {
        expect(p.envs.length).toBeGreaterThan(0);
        for (const id of p.envs) expect(envById(id)?.world, `${t.id}: ${id}`).toBe("ecosystem");
        if (p.method === "es") {
          expect(p.es).toBeDefined();
          expect(p.es!.pairs).toBeGreaterThanOrEqual(1);
          expect(p.es!.sigma).toBeGreaterThan(0);
          expect(p.es!.lr).toBeGreaterThan(0);
        } else {
          expect(p.backprop).toBeDefined();
          expect(p.backprop!.lr).toBeGreaterThanOrEqual(0.0005); // the Arena worker clamps lr to 0.0005 to 0.01 and episodes to 4 to 320
          expect(p.backprop!.lr).toBeLessThanOrEqual(0.01);
          expect(p.backprop!.episodes).toBeGreaterThanOrEqual(4);
          expect(p.backprop!.episodes).toBeLessThanOrEqual(320);
        }
        if (p.seconds !== undefined) expect(p.seconds).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it("trains on the Arena's recommended mix", () => {
    for (const t of TRAIN_TIERS) expect(t.phases[0]!.envs).toEqual(RECOMMENDED_MIX);
  });

  it("stays plain data: the module imports nothing", () => {
    const src = readFileSync(new URL("../../src/typescript/src/sim/rl/trainTiers.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^\s*import /m);
  });
});
