// @vitest-environment happy-dom
import { drawCreaturePreview, previewSight } from "../../src/typescript/src/ui/creaturePreview.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import { badCoordinateCalls, fakeCtx } from "./helpers.ts";

const plan = (over: Partial<BodyPlan> = {}): BodyPlan => ({ rayCount: 5, raySpread: (120 * Math.PI) / 180, rayLength: 180, hiddenLayers: [12], memoryShort: 2, memoryLong: 2, ...over });
// Each ray line starts at the edge of the body (radius 12 around the origin).
const rayMoves = (calls: { name: string; args: unknown[] }[]) => calls.filter((c) => c.name === "moveTo" && Math.abs(Math.hypot(c.args[0] as number, c.args[1] as number) - 12) < 1e-6);

describe("drawCreaturePreview", () => {
  it("draws every ray once from the body", () => {
    for (const n of [1, 5, 32]) {
      const { ctx, calls } = fakeCtx();
      drawCreaturePreview(ctx, plan({ rayCount: n }), 300, 300);
      expect(rayMoves(calls)).toHaveLength(n);
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


describe("previewSight", () => {
  const plan = (rayCount: number, spreadDeg: number) => ({ rayCount, raySpread: (spreadDeg * Math.PI) / 180, rayLength: 180, hiddenLayers: [8], memoryShort: 0, memoryLong: 0 });

  it("puts the food on the ray nearest straight ahead and the poison on another ray", () => {
    const hits = previewSight(plan(5, 120));
    expect(hits.filter((h) => h.kind === "food")).toHaveLength(1);
    expect(hits.filter((h) => h.kind === "poison")).toHaveLength(1);
    expect(hits[2]!.kind).toBe("food"); // the middle ray points straight ahead
    for (const h of hits) expect(h.distance).toBeLessThanOrEqual(180);
  });

  it("leaves an item unseen when no ray points near it", () => {
    const hits = previewSight(plan(1, 0));
    expect(hits.map((h) => h.kind)).toEqual(["food"]);
  });
});
