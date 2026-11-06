import { clampThreads } from "../../src/typescript/src/worker/browserPool.ts";

describe("clampThreads", () => {
  it("holds a requested thread count to the cores, at most 16", () => {
    const cores = Math.min(navigator.hardwareConcurrency || 2, 16);
    expect(clampThreads(Infinity)).toBe(cores);
    expect(clampThreads(100000)).toBe(cores);
    expect(clampThreads(-3)).toBe(0);
    expect(clampThreads(NaN)).toBe(0);
    expect(clampThreads(1)).toBe(Math.min(1, cores));
  });
});
