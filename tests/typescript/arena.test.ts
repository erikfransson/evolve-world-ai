// @vitest-environment happy-dom
import { drawArena, frameAt, learnerAlive, loopSeconds } from "../../src/typescript/src/ui/arenaScene.ts";
import { drawRewardGraph, thin } from "../../src/typescript/src/ui/rewardGraph.ts";
import { ARENA_KIND, bestFounder, change, customEnv, envGroups, envsForKind, kindRejection, planSummary } from "../../src/typescript/src/ui/arenaPick.ts";
import type { CustomEnvForm } from "../../src/typescript/src/ui/arenaPick.ts";
import { DEFAULT_SPEED, FAVOURITES_KEY, MAX_FAVOURITES, SPEED_KEY, addFavourite, loadFavourites, loadSpeed, removeFavourite, saveSpeed } from "../../src/typescript/src/ui/arenaStore.ts";
import { DEFAULT_DESIGN, designPlan, planDesign } from "../../src/typescript/src/ui/arenaForm.ts";
import { TILE_COUNTS, resultLine, tileColumns, tileTitle } from "../../src/typescript/src/ui/arenaTiles.ts";
import { BLANK_ENV, envConfig } from "../../src/typescript/src/sim/rl/env.ts";
import { ENVS } from "../../src/typescript/src/sim/rl/envs.ts";
import { creatureFile, genomeLengthFor } from "../../src/typescript/src/sim/rl/creatureFile.ts";
import type { Recording } from "../../src/typescript/src/sim/rl/recording.ts";
import { planOf } from "../../src/typescript/src/sim/sensors.ts";
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
    inputSize: 0,
    inputs: new Float32Array(0),
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

  it("knows whether the learner is alive in a frame", () => {
    const rec = recording();
    expect(learnerAlive(rec, 0)).toBe(true);
    rec.creatureData[4] = 0;
    expect(learnerAlive(rec, 0)).toBe(false);
  });
});

describe("drawRewardGraph", () => {
  const step = (iter: number, train: number, held: number | null) => ({ iter, train, best: train + 1, held, perEnv: null, seconds: iter });

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
  it("offers each kind only its own envs, and every env to some kind", () => {
    const forager = envsForKind(ENVS, "forager");
    expect(forager.length).toBeGreaterThan(0);
    expect(forager.every((e) => e.world === "ecosystem" && e.role === 0)).toBe(true);
    const all = new Set([...envsForKind(ENVS, "forager"), ...envsForKind(ENVS, "prey"), ...envsForKind(ENVS, "predator")]);
    expect(all.size).toBe(ENVS.length);
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

describe("customEnv", () => {
  const form = (over: Partial<CustomEnvForm> = {}): CustomEnvForm => ({
    name: "",
    width: 800,
    height: 600,
    food: 15,
    poison: 5,
    regrow: 0,
    seconds: 45,
    rivals: [],
    reward: { food: 1, kill: null, survive: null, energy: null },
    ...over,
  });

  it("builds a checked env of the kind's world with the given id", () => {
    const e = customEnv(form(), "custom-3", "predator");
    expect(typeof e).toBe("object");
    if (typeof e === "string") return;
    expect(e).toMatchObject({ id: "custom-3", name: "Custom 3", world: "hunt", role: 1, size: [800, 600], reward: { food: 1 } });
  });

  it("rejects out-of-range values, bad rivals and an empty reward with a reason", () => {
    expect(customEnv(form({ width: 50 }), "custom-1", "forager")).toMatch(/sides/);
    expect(customEnv(form({ rivals: [{ species: 1, count: 2, source: "random" }] }), "custom-1", "forager")).toMatch(/species/);
    expect(customEnv(form({ reward: { food: null, kill: null, survive: 0, energy: null } }), "custom-1", "forager")).toMatch(/reward/);
  });
});

describe("favourites", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };
  const learner = () => {
    const plan = planOf(envConfig({ ...BLANK_ENV, world: "ecosystem" }, 1));
    return { plan, genome: new Float32Array(genomeLengthFor("forager", plan)) };
  };
  const file = (name: string) => creatureFile("forager", name, learner(), { envs: ["forage-box"], iterations: 5, from: "designed", heldStart: 1, heldEnd: 2, date: "2026-01-01" });

  it("round-trips, newest first, and removes by index", () => {
    const store = memory();
    expect(addFavourite(file("a"), store)).toBe(true);
    addFavourite(file("b"), store);
    expect(loadFavourites(store).map((f) => f.name)).toEqual(["b", "a"]);
    removeFavourite(0, store);
    expect(loadFavourites(store).map((f) => f.name)).toEqual(["a"]);
  });

  it("keeps at most 20 and survives garbage and a refusing store", () => {
    const store = memory();
    for (let i = 0; i < MAX_FAVOURITES + 3; i++) addFavourite(file(`c${i}`), store);
    expect(loadFavourites(store)).toHaveLength(MAX_FAVOURITES);
    store.setItem(FAVOURITES_KEY, "not json");
    expect(loadFavourites(store)).toEqual([]);
    store.setItem(FAVOURITES_KEY, JSON.stringify([{ format: "x" }]));
    expect(loadFavourites(store)).toEqual([]);
    expect(addFavourite(file("z"), { getItem: () => null, setItem: () => { throw new Error("full"); } })).toBe(false);
    expect(loadFavourites(null)).toEqual([]);
  });
});

describe("tile captions and layout", () => {
  it("names the scenario, the learner and the layout of the tile within its env", () => {
    expect(tileTitle("Forage box", 42, 2, 1)).toBe("Forage box · best of iteration 42 · layout 3");
    expect(tileTitle("Forage box", 0, 0, 2)).toBe("Forage box · starting creature · layout 1");
    expect(tileTitle("Poison field", 5, 3, 2)).toBe("Poison field · best of iteration 5 · layout 2");
  });
  it("shows kills only when there were any", () => {
    expect(resultLine({ food: 4, kills: 0, seconds: 44.6 })).toBe("food 4, alive 45 s");
    expect(resultLine({ food: 4, kills: 2, seconds: 10 })).toBe("food 4, kills 2, alive 10 s");
  });
  it("lays 12 tiles out 4 x 3", () => {
    expect(TILE_COUNTS).toEqual([1, 4, 6, 12]);
    expect(TILE_COUNTS.map(tileColumns)).toEqual([1, 2, 3, 4]);
  });
});

describe("forager-only page helpers", () => {
  it("rejects other kinds with a clear message", () => {
    expect(ARENA_KIND).toBe("forager");
    expect(kindRejection("forager")).toBeNull();
    expect(kindRejection("prey")).toMatch(/only foragers can train here for now/);
  });
  it("preselects the fittest founder, the first on ties", () => {
    expect(bestFounder([{ fitness: 3 }, { fitness: 9 }, { fitness: 9 }, { fitness: 1 }])).toBe(1);
    expect(bestFounder([])).toBe(0);
  });
});

describe("replay speed", () => {
  const store = (init: string | null) => {
    const m = new Map<string, string>(init === null ? [] : [[SPEED_KEY, init]]);
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it("defaults to 4x and remembers a valid choice", () => {
    expect(loadSpeed(store(null))).toBe(DEFAULT_SPEED);
    expect(loadSpeed(store("3"))).toBe(DEFAULT_SPEED);
    const s = store(null);
    saveSpeed(8, s);
    expect(loadSpeed(s)).toBe(8);
  });
  it("survives storage that throws", () => {
    const bad = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
    expect(loadSpeed(bad)).toBe(DEFAULT_SPEED);
    expect(() => saveSpeed(2, bad)).not.toThrow();
  });
});

describe("reward graph at 5000 iterations", () => {
  it("thin keeps few points near the means and short series whole", () => {
    const pts = Array.from({ length: 5000 }, (_, i) => ({ iter: i, v: i }));
    const t = thin(pts, 400);
    expect(t).toHaveLength(400);
    expect(t[0]!.v).toBeLessThan(t[399]!.v);
    expect(t[399]!.iter).toBeGreaterThan(4900);
    expect(thin(pts.slice(0, 10), 400)).toHaveLength(10);
  });

  it("draws 5000 iterations in a bounded number of segments", () => {
    const its = Array.from({ length: 5000 }, (_, i) => ({ iter: i + 1, train: i / 10, best: i / 8, held: i % 5 === 0 ? i / 9 : null, perEnv: null, seconds: i }));
    const { ctx, calls } = fakeCtx(800, 300);
    drawRewardGraph(ctx, its, 0, 800, 300);
    expect(badCoordinateCalls(calls)).toEqual([]);
    expect(named(calls, "lineTo")).toBeLessThan(3 * 800 + 20);
  });
});

describe("envGroups", () => {
  it("puts the small and custom worlds first and the advanced ones apart", () => {
    const { quick, advanced } = envGroups(envsForKind(ENVS, "forager"));
    expect(quick.every((e) => e.tags.includes("small"))).toBe(true);
    expect(quick.some((e) => e.id === "nibble")).toBe(true);
    expect(advanced.length).toBeGreaterThan(0);
    expect(advanced.every((e) => e.tags.includes("advanced"))).toBe(true);
  });
});

describe("arena design form", () => {
  it("maps a design to a plan inside the limits and back", () => {
    const plan = designPlan(DEFAULT_DESIGN);
    expect(plan.hiddenLayers).toEqual([12]);
    expect(plan.memoryShort + plan.memoryLong).toBe(4);
    expect(designPlan(planDesign(plan))).toEqual(plan);
  });
});
