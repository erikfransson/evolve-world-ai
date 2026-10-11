// @vitest-environment happy-dom
import { MAX_DOTS, drawBrainSketch, drawCreaturePreview } from "../../src/typescript/src/ui/creaturePreview.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import { badCoordinateCalls, fakeCtx } from "./helpers.ts";

const plan = (over: Partial<BodyPlan> = {}): BodyPlan => ({ rayCount: 5, raySpread: (120 * Math.PI) / 180, rayLength: 180, hiddenLayers: [12], memoryShort: 2, memoryLong: 2, ...over });
// Ray lines start at the creature (the origin) and are drawn twice, the whole fan and the part inside the room.
const rayMoves = (calls: { name: string; args: unknown[] }[]) => calls.filter((c) => c.name === "moveTo" && c.args[0] === 0 && c.args[1] === 0);

describe("drawCreaturePreview", () => {
  it("draws every ray, twice (fan and in-room part)", () => {
    for (const n of [1, 5, 32]) {
      const { ctx, calls } = fakeCtx();
      drawCreaturePreview(ctx, plan({ rayCount: n }), 300, 300);
      expect(rayMoves(calls)).toHaveLength(2 * n + 1); // plus the heading line
      expect(badCoordinateCalls(calls)).toEqual([]);
    }
  });

  it("handles a full 360 degree spread and a single ray without bad coordinates", () => {
    for (const p of [plan({ raySpread: 2 * Math.PI, rayCount: 8 }), plan({ rayCount: 1, raySpread: 0.1 })]) {
      const { ctx, calls } = fakeCtx();
      drawCreaturePreview(ctx, p, 300, 300);
      expect(badCoordinateCalls(calls)).toEqual([]);
    }
  });

  it("labels the sight length and ends the rays at that length", () => {
    const { ctx, calls } = fakeCtx();
    drawCreaturePreview(ctx, plan({ rayCount: 1, rayLength: 140 }), 300, 300);
    expect(calls.some((c) => c.name === "fillText" && String(c.args[0]).includes("140"))).toBe(true);
    expect(calls.some((c) => c.name === "lineTo" && Math.abs((c.args[0] as number) - 140) < 1e-6 && Math.abs(c.args[1] as number) < 1e-6)).toBe(true);
  });

  it("draws nothing on a zero-size canvas", () => {
    const { ctx, calls } = fakeCtx();
    drawCreaturePreview(ctx, plan(), 0, 0);
    expect(calls.some((c) => c.name === "arc")).toBe(false);
    expect(badCoordinateCalls(calls)).toEqual([]);
  });
});

describe("drawBrainSketch", () => {
  it("draws one dot per neuron and caps big layers", () => {
    const { ctx, calls } = fakeCtx();
    drawBrainSketch(ctx, [3, 4, 2], 300, 200);
    expect(calls.filter((c) => c.name === "arc")).toHaveLength(9);
    const big = fakeCtx();
    drawBrainSketch(big.ctx, [200, 32, 20], 300, 200);
    expect(big.calls.filter((c) => c.name === "arc")).toHaveLength(2 * MAX_DOTS + 20);
    expect(badCoordinateCalls(big.calls)).toEqual([]);
  });

  it("copes with no layers and a tiny canvas", () => {
    const a = fakeCtx();
    drawBrainSketch(a.ctx, [], 300, 200);
    const b = fakeCtx();
    drawBrainSketch(b.ctx, [1, 1], 10, 10);
    expect(badCoordinateCalls([...a.calls, ...b.calls])).toEqual([]);
  });
});
