import { randomLearner } from "../../src/typescript/src/sim/rl/env.ts";
import { PROC_DEFAULTS, drawWorld, runCrowdStats } from "../../src/typescript/src/sim/rl/procEnv.ts";
import { placeLayout } from "../../src/typescript/src/sim/rl/layouts.ts";
import type { CastMember } from "../../src/typescript/src/sim/ecosystem.ts";

const seen = vi.hoisted(() => ({ casts: [] as unknown[][] }));
vi.mock("../../src/typescript/src/sim/ecosystem.ts", async (original) => {
  const mod = await original<typeof import("../../src/typescript/src/sim/ecosystem.ts")>();
  class Spy extends mod.Ecosystem {
    constructor(...args: ConstructorParameters<typeof mod.Ecosystem>) {
      super(...args);
      seen.casts.push((args[2] as { cast: unknown[] }).cast);
    }
  }
  return { ...mod, Ecosystem: Spy };
});

describe("self-play layout start (M20)", () => {
  it("puts the first learner body at the layout's start", () => {
    const learner = randomLearner({ world: "ecosystem", role: 0 } as never, 3);
    let checked = 0;
    for (let seed = 1; seed <= 40 && checked < 3; seed++) {
      const w = drawWorld(PROC_DEFAULTS, seed);
      if (!w.layout) continue;
      seen.casts.length = 0;
      runCrowdStats({ ...PROC_DEFAULTS, seconds: [1, 1] }, learner, seed);
      const placed = placeLayout(w.layout, w.size, w.food, w.poison, seed)!;
      const first = seen.casts[0]![0] as CastMember;
      expect([first.x, first.y]).toEqual([placed.start.x, placed.start.y]);
      checked++;
    }
    expect(checked).toBe(3);
  });
});
