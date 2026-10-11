// @vitest-environment happy-dom
import { drawArena, frameAt, loopSeconds } from "../../src/typescript/src/ui/arenaScene.ts";
import { drawRewardGraph } from "../../src/typescript/src/ui/rewardGraph.ts";
import { change, planSummary, roleGroup } from "../../src/typescript/src/ui/arenaPick.ts";
import { ENVS } from "../../src/typescript/src/sim/rl/envs.ts";
import type { Recording } from "../../src/typescript/src/sim/rl/recording.ts";
import { badCoordinateCalls, fakeCtx } from "./helpers.ts";

// Two frames: frame 0 has 2 food and 1 poison, three creatures (learner, prey, predator); frame 1 has one food and the learner.
function recording(): Recording {
  return {
    width: 600,
    height: 400,
    dt: 0.1,
    frames: 2,
    itemStart: Int32Array.from([0, 3, 4]),
    itemData: Float32Array.from([10, 10, 1, 50, 60, 1, 90, 90, 2, 10, 10, 1]),
    creatureStart: Int32Array.from([0, 3, 4]),
    creatureData: Float32Array.from([100, 100, 0.5, 0, 1, 50, 200, 200, 1, 0, 0, 40, 300, 300, 2, 1, 0, 60, 100, 100, 0.6, 0, 1, 49]),
    rayCount: 2,
    rayLength: 180,
    rayOffsets: Float32Array.from([-0.3, 0.3]),
    rays: Float32Array.from([0.5, 1, 0, 0, 0, 0, 1, 3]),
    result: { reward: 1, food: 1, kills: 0, seconds: 5, energy: 10 },
  };
}

const named = (calls: { name: string }[], n: string): number => calls.filter((c) => c.name === n).length;

describe("drawArena", () => {
  it("draws every creature of the frame with finite coordinates", () => {
    const { ctx, calls } = fakeCtx(800, 500);
    drawArena(ctx, recording(), 0, 800, 500);
    expect(badCoordinateCalls(calls)).toEqual([]);
    // 2 food circles + 1 poison circle + prey + predator body (one arc each) + learner
    expect(named(calls, "arc")).toBe(2 + 1 + 1 + 1 + 1);
  });

  it("draws the learner's rays only when asked", () => {
    const withRays = fakeCtx();
    drawArena(withRays.ctx, recording(), 0, 800, 500, true);
    const without = fakeCtx();
    drawArena(without.ctx, recording(), 0, 800, 500, false);
    expect(named(withRays.calls, "lineTo") - named(without.calls, "lineTo")).toBe(2);
  });

  it("clamps the frame and survives an empty recording or zero-size canvas", () => {
    const { ctx, calls } = fakeCtx();
    drawArena(ctx, recording(), 99, 800, 500);
    drawArena(ctx, { ...recording(), frames: 0 }, 0, 800, 500);
    drawArena(ctx, recording(), 0, 0, 0);
    expect(badCoordinateCalls(calls)).toEqual([]);
  });

  it("loops frames by time", () => {
    const rec = recording();
    expect(loopSeconds(rec)).toBeCloseTo(0.2);
    expect([0, 0.05, 0.1, 0.19, 0.2, 0.31].map((t) => frameAt(rec, t))).toEqual([0, 0, 1, 1, 0, 1]);
  });
});

describe("drawRewardGraph", () => {
  const step = (iter: number, train: number, held: number | null) => ({ iter, train, held, seconds: iter });

  it("handles no data, one point and many points", () => {
    for (const [its, start] of [[[], null], [[], 3], [[step(1, 2, null)], null], [[step(1, 2, 4)], 1], [[step(1, 2, null), step(2, 3, null), step(5, 4, 6)], 1]] as const) {
      const { ctx, calls } = fakeCtx(400, 170);
      drawRewardGraph(ctx, its, start, 400, 170);
      expect(badCoordinateCalls(calls)).toEqual([]);
    }
  });

  it("draws a held-out dot per check including the start", () => {
    const { ctx, calls } = fakeCtx(400, 170);
    drawRewardGraph(ctx, [step(1, 2, null), step(5, 3, 4)], 1, 400, 170);
    expect(named(calls, "arc")).toBe(2);
  });

  it("does nothing when the canvas is too small", () => {
    const { ctx, calls } = fakeCtx();
    drawRewardGraph(ctx, [step(1, 2, 3)], 1, 20, 10);
    expect(named(calls, "lineTo")).toBe(0);
  });
});

describe("arena picker helpers", () => {
  it("puts every env in a group", () => {
    expect(new Set(ENVS.map(roleGroup))).toEqual(new Set(["Foragers", "Hunters", "Prey"]));
  });

  it("summarises a plan", () => {
    const s = planSummary({ rayCount: 4, raySpread: Math.PI / 4, rayLength: 180, hiddenLayers: [12], memoryShort: 2, memoryLong: 2 });
    expect(s).toBe("4 rays over 45°, sight 180, hidden 12, 4 memory units");
  });

  it("reports the change with a direction", () => {
    expect(change(5, 2)).toEqual({ text: "+3.0", dir: "up" });
    expect(change(1, 2.5)).toEqual({ text: "−1.5", dir: "down" });
    expect(change(2, 2).dir).toBe("flat");
  });
});
