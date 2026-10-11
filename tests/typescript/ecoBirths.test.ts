import { BirthRings, ringVisibility } from "../../src/typescript/src/ui/ecoBirths.ts";
import { snapshotBytes, snapshotViews } from "../../src/typescript/src/worker/ecoProtocol.ts";
import { fakeCtx } from "./helpers.ts";

function views(ids: number[]) {
  const n = ids.length;
  const v = snapshotViews(new ArrayBuffer(snapshotBytes(n, 1)), n, 1, n, 1);
  ids.forEach((id, i) => { v.ids[i] = id; v.x[i] = 10 * id; v.y[i] = 5; v.hue[i] = 120; });
  return v;
}

const arcs = (calls: { name: string }[]) => calls.filter((c) => c.name === "arc").length;

describe("BirthRings", () => {
  it("ignores the first snapshot and rings only creatures with new ids", () => {
    const r = new BirthRings();
    r.observe(views([0, 1, 2]), 0);
    expect(r.size).toBe(0);
    r.observe(views([1, 2, 3, 4]), 100);
    expect(r.size).toBe(2);
    r.observe(views([1, 2, 3, 4]), 200);
    expect(r.size).toBe(2);
  });

  it("keeps at most 64 rings", () => {
    const r = new BirthRings();
    r.observe(views([0]), 0);
    r.observe(views(Array.from({ length: 200 }, (_, i) => i + 1)), 10);
    expect(r.size).toBe(64);
  });

  it("expires rings by real time and resets for a new run", () => {
    const r = new BirthRings();
    r.observe(views([0]), 0);
    r.observe(views([0, 1]), 0);
    const { ctx, calls } = fakeCtx();
    r.draw(ctx, 400, 12, 1, 2);
    expect(arcs(calls)).toBe(1);
    r.draw(ctx, 1000, 12, 1, 2);
    expect(r.size).toBe(0);
    r.observe(views([0, 1, 2]), 1000);
    r.reset();
    r.observe(views([0]), 1000);
    expect(r.size).toBe(0);
  });

  it("draws nothing when zoomed out and fades in with zoom", () => {
    const r = new BirthRings();
    r.observe(views([0]), 0);
    r.observe(views([0, 1]), 0);
    const far = fakeCtx();
    r.draw(far.ctx, 100, 12, 1, 0.3); // radius 3.6 px
    expect(arcs(far.calls)).toBe(0);
    expect(ringVisibility(3)).toBe(0);
    expect(ringVisibility(7)).toBeCloseTo(0.5);
    expect(ringVisibility(20)).toBe(1);
  });
});
