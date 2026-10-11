import { EVENT_DEATH, EVENT_IMPACT } from "../../src/typescript/src/sim/ecosystem.ts";
import { ImpactEffects } from "../../src/typescript/src/ui/ecoImpacts.ts";
import { fakeCtx } from "./helpers.ts";

const events = (...e: [number, number, number, number][]) => Float32Array.from(e.flat());
const painted = (calls: { name: string }[]) => calls.filter((c) => c.name === "fill" || c.name === "stroke").length;

describe("ImpactEffects", () => {
  it("keeps at most 64 effects", () => {
    const f = new ImpactEffects();
    f.add(events(...Array.from({ length: 100 }, (_, i): [number, number, number, number] => [EVENT_IMPACT, i, 0, 20])), 0);
    expect(f.size).toBe(64);
  });

  it("expires sparks sooner than deaths and clears on reset", () => {
    const f = new ImpactEffects();
    f.add(events([EVENT_DEATH, 5, 5, 120], [EVENT_IMPACT, 9, 9, 20]), 0);
    const { ctx, calls } = fakeCtx();
    f.draw(ctx, 200, 12, 1, 2);
    expect(painted(calls)).toBe(3); // ring and specks, then rays
    calls.length = 0;
    f.draw(ctx, 500, 12, 1, 2); // spark over, death still fading
    expect(painted(calls)).toBe(2);
    f.draw(ctx, 900, 12, 1, 2);
    expect(f.size).toBe(0);
    f.add(events([EVENT_IMPACT, 0, 0, 20]), 900);
    f.reset();
    expect(f.size).toBe(0);
  });

  it("draws nothing when zoomed out", () => {
    const f = new ImpactEffects();
    f.add(events([EVENT_DEATH, 5, 5, 120]), 0);
    const { ctx, calls } = fakeCtx();
    f.draw(ctx, 100, 12, 1, 0.3);
    expect(painted(calls)).toBe(0);
  });
});
