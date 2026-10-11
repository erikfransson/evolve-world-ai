// @vitest-environment happy-dom
import { drawCreaturePreview } from "../../src/typescript/src/ui/creaturePreview.ts";
import { PreviewScene } from "../../src/typescript/src/ui/previewScene.ts";
import { layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { layoutConfig } from "../../src/typescript/src/sim/rl/env.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import { badCoordinateCalls, fakeCtx } from "./helpers.ts";

const config = layoutConfig("ecosystem");
const plan = (over: Partial<BodyPlan> = {}): BodyPlan => ({ rayCount: 5, raySpread: (120 * Math.PI) / 180, rayLength: 180, hiddenLayers: [12], memoryShort: 2, memoryLong: 2, ...over });
const scene = (p: BodyPlan) => new PreviewScene(config, p, randomGenome(layerSizes(config, p), createRng(5)));
// Ray lines start at the edge of the body, so they are the strokes whose moveTo is one radius from the creature centre.
const rayMoves = (s: PreviewScene, calls: { name: string; args: unknown[] }[]) => {
  const { x, y } = s.creature.state;
  return calls.filter((c) => c.name === "moveTo" && Math.abs(Math.hypot((c.args[0] as number) - x, (c.args[1] as number) - y) - 12) < 1e-6);
};

describe("drawCreaturePreview", () => {
  it("draws every ray once from the body, to finite coordinates", () => {
    for (const n of [1, 5, 32]) {
      const s = scene(plan({ rayCount: n }));
      for (const t of [0, 3.3, 9]) {
        s.t = 0;
        s.step(t);
        const { ctx, calls } = fakeCtx();
        drawCreaturePreview(ctx, s, 480, 330);
        expect(rayMoves(s, calls)).toHaveLength(n);
        expect(badCoordinateCalls(calls)).toEqual([]);
      }
    }
  });

  it("handles a full 360 degree spread and labels the sight length", () => {
    const s = scene(plan({ raySpread: 2 * Math.PI, rayCount: 8, rayLength: 140 }));
    s.step(1);
    const { ctx, calls } = fakeCtx();
    drawCreaturePreview(ctx, s, 300, 200);
    expect(badCoordinateCalls(calls)).toEqual([]);
    expect(calls.some((c) => c.name === "fillText" && String(c.args[0]).includes("140"))).toBe(true);
  });

  it("draws nothing on a zero-size canvas", () => {
    const { ctx, calls } = fakeCtx();
    drawCreaturePreview(ctx, scene(plan()), 0, 0);
    expect(calls.some((c) => c.name === "arc")).toBe(false);
    expect(badCoordinateCalls(calls)).toEqual([]);
  });
});
