import { PLAN_LIMITS, checkGenome, checkPlan, plainText } from "../../src/typescript/src/sim/rl/validate.ts";

// The shared gate for outside data (creature files, library entries): the genome check, the plan check and the text cleaner.

describe("checkGenome", () => {
  it("returns a copy of exactly `length` finite weights", () => {
    const g = [0, -1.5, 999.9, -1000, 1000];
    const out = checkGenome(g, 5);
    expect(out).toEqual(g);
    expect(out).not.toBe(g);
  });

  it("refuses a wrong length, a non-array, and weights that are not finite numbers within +-1000", () => {
    expect(checkGenome([1, 2], 3)).toMatch(/must have 3 weights/);
    expect(checkGenome("abc", 3)).toMatch(/must have 3 weights/);
    expect(checkGenome(new Float32Array(3), 3)).toMatch(/must have 3 weights/); // only plain arrays come off the wire
    for (const bad of [NaN, Infinity, -Infinity, 1000.001, -1001, "1", null, undefined]) expect(checkGenome([0, bad, 0], 3), String(bad)).toMatch(/finite numbers/);
  });

  it("accepts an empty genome for length 0", () => {
    expect(checkGenome([], 0)).toEqual([]);
  });
});

describe("checkPlan", () => {
  const plan = { rayCount: 5, raySpread: 1, rayLength: 100, hiddenLayers: [8, 4], memoryShort: 1, memoryLong: 2 };
  it("rebuilds a good plan from its checked fields only", () => {
    const out = checkPlan({ ...plan, extra: "dropped" });
    expect(out).toEqual(plan);
    expect((out as { hiddenLayers: number[] }).hiddenLayers).not.toBe(plan.hiddenLayers);
  });

  it("clamps a spread a hair above a full turn and refuses the limits' other side", () => {
    expect((checkPlan({ ...plan, raySpread: 2 * Math.PI + 1e-7 }) as { raySpread: number }).raySpread).toBe(2 * Math.PI);
    expect(checkPlan({ ...plan, raySpread: 2 * Math.PI + 1e-3 })).toMatch(/raySpread/);
    expect(checkPlan({ ...plan, rayCount: PLAN_LIMITS.rayCount[1] + 1 })).toMatch(/rayCount/);
    expect(checkPlan({ ...plan, rayCount: 2.5 })).toMatch(/rayCount/);
    expect(checkPlan({ ...plan, hiddenLayers: [] })).toMatch(/hiddenLayers/);
    expect(checkPlan({ ...plan, hiddenLayers: [33] })).toMatch(/hiddenLayers/);
    expect(checkPlan({ ...plan, memoryLong: 9 })).toMatch(/memory/);
    expect(checkPlan(null)).toBe("plan missing");
    expect(checkPlan([])).toBe("plan missing");
  });
});

describe("plainText", () => {
  it("strips control and bidi-override characters, trims and cuts to max", () => {
    expect(plainText("  a\u0000b‮c⁦d\nE  ", 20)).toBe("abcdE");
    expect(plainText("abcdef", 3)).toBe("abc");
    expect(plainText(42, 5)).toBe("");
    expect(plainText(undefined, 5)).toBe("");
  });
});
