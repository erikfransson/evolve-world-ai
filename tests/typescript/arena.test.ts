// @vitest-environment happy-dom
import { drawArena, frameAt, learnerAlive, loopSeconds } from "../../src/typescript/src/ui/arenaScene.ts";
import { drawRewardGraph, drawSpark, niceTicks, smooth, spreadLabels, thin, thinMinMax, tickLabel } from "../../src/typescript/src/ui/rewardGraph.ts";
import { ARENA_KIND, bestFounder, change, customEnv, envsForKind, kindRejection, planSummary } from "../../src/typescript/src/ui/arenaPick.ts";
import type { CustomEnvForm } from "../../src/typescript/src/ui/arenaPick.ts";
import { DEFAULT_SPEED, FAVOURITES_KEY, MAX_FAVOURITES, SPEED_KEY, addFavourite, loadFavourites, loadSpeed, removeFavourite, saveSpeed } from "../../src/typescript/src/ui/arenaStore.ts";
import { DEFAULT_DESIGN, DEFAULT_RUN, designPlan, planDesign, startOptions, trainingRecord } from "../../src/typescript/src/ui/arenaForm.ts";
import { TileGrid, resultLine, tileSub, tileTitle } from "../../src/typescript/src/ui/arenaTiles.ts";
import { displayOrder, gridColumns, layoutsPerEnv, pageOf, phaseOf, unshownEnvs } from "../../src/typescript/src/ui/arenaLayout.ts";
import { BLANK_ENV, envConfig } from "../../src/typescript/src/sim/rl/env.ts";
import { ENVS, RECOMMENDED_MIX } from "../../src/typescript/src/sim/rl/envs.ts";
import { mixPick } from "../../src/typescript/src/ui/envSelect.ts";
import { creatureFile, genomeLengthFor, parseCreatureFile } from "../../src/typescript/src/sim/rl/creatureFile.ts";
import type { Recording } from "../../src/typescript/src/sim/rl/recording.ts";
import { planOf } from "../../src/typescript/src/sim/sensors.ts";
import { badCoordinateCalls, fakeCtx } from "./helpers.ts";

// Two frames: frame 0 has 2 food and 1 poison, three creatures (learner, prey, predator); frame 1 has one food and the learner.
function recording(): Recording {
  return {
    width: 600,
    creatureRadius: 12,
    itemRadius: 4,
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
    result: { reward: 1, food: 1, kills: 0, rams: 0, seconds: 5, energy: 10, poison: 0, poisonEnergy: 0, firstFood: -1, elapsed: 5, clearTime: -1, late: 0, cells: 1, died: 0 },
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

  it("labels the start, the lines, the axes and the gain since the start", () => {
    const { ctx, calls } = fakeCtx(400, 200);
    drawRewardGraph(ctx, [step(1, 2, null), step(5, 3, 4)], 1, 400, 200);
    const text = calls.filter((c) => c.name === "fillText").map((c) => c.args[0]);
    for (const t of ["+3.0", "since start", "start 1.0", "on new worlds", "average try", "training step", "reward per episode"]) expect(text).toContain(t);
  });

  it("draws a flat glow-free plot: no shadow blur", () => {
    const { ctx, calls } = fakeCtx(400, 200);
    drawRewardGraph(ctx, [step(1, 2, null), step(5, 3, 4)], 1, 400, 200);
    expect(typeof (ctx as unknown as Record<string, unknown>).shadowBlur).toBe("function"); // never assigned
    expect(named(calls, "fill")).toBeGreaterThan(0);
  });

  it("shows a loss since the start with a minus sign", () => {
    const { ctx, calls } = fakeCtx(400, 200);
    drawRewardGraph(ctx, [step(5, 3, 0.5)], 2, 400, 200);
    expect(calls.filter((c) => c.name === "fillText").map((c) => c.args[0])).toContain("−1.5");
  });

  it("gives round ticks that snap the range outward", () => {
    expect(niceTicks(-0.1, 6.5, 6)).toMatchObject({ ticks: [-2, 0, 2, 4, 6, 8], lo: -2, hi: 8, step: 2 });
    expect(niceTicks(0, 6079, 6).ticks).toEqual([0, 2000, 4000, 6000, 8000]);
    expect(niceTicks(0, 1, 5).step).toBe(0.5);
    expect(niceTicks(3, 3, 5).hi).toBeGreaterThan(niceTicks(3, 3, 5).lo);
    expect(niceTicks(NaN, 1, 5).ticks).toEqual([0, 1]);
    for (const [lo, hi, n] of [[0, 1, 2], [-57, 913, 7], [0.001, 0.0034, 5], [-4.9, 120, 3]] as const) {
      const t = niceTicks(lo, hi, n);
      expect(t.ticks.length).toBeLessThanOrEqual(n + 1);
      expect(t.lo).toBeLessThanOrEqual(lo);
      expect(t.hi).toBeGreaterThanOrEqual(hi);
      expect([1, 2, 5]).toContain(Math.round(t.step / 10 ** Math.floor(Math.log10(t.step) + 1e-9)));
    }
  });

  it("keeps x ticks fixed while a run grows inside one step", () => {
    const a = niceTicks(0, 3100, 5).ticks.filter((t) => t <= 3100);
    const b = niceTicks(0, 3900, 5).ticks.filter((t) => t <= 3100);
    expect(a).toEqual(b);
  });

  it("writes tick values without a trailing .0 or a minus zero", () => {
    expect(tickLabel(5, 1)).toBe("5");
    expect(tickLabel(2.5, 0.5)).toBe("2.5");
    expect(tickLabel(-0, 2)).toBe("0");
    expect(tickLabel(-0.00001, 0.5)).toBe("0");
    expect(tickLabel(-2, 2)).toBe("−2");
    expect(tickLabel(0.25, 0.05)).toBe("0.25");
  });

  it("thins noisy data to a min/max envelope that keeps the spikes", () => {
    const pts = Array.from({ length: 3000 }, (_, i) => ({ iter: i, v: i === 1500 ? 99 : (i % 7) / 10 }));
    const t = thinMinMax(pts, 400);
    expect(t.length).toBeLessThanOrEqual(400);
    expect(Math.max(...t.map((p) => p.v))).toBe(99);
    expect(t.every((p, k) => k === 0 || p.iter >= t[k - 1]!.iter)).toBe(true);
    expect(thinMinMax(pts.slice(0, 10), 400)).toHaveLength(10);
  });

  it("draws the best-try sparkline, and nothing for a run too short", () => {
    const its = Array.from({ length: 50 }, (_, i) => ({ iter: i + 1, train: 1, best: 5 + i / 5, held: null, perEnv: null, seconds: i }));
    const { ctx, calls } = fakeCtx(60, 20);
    drawSpark(ctx, its, 60, 20);
    expect(named(calls, "lineTo")).toBeGreaterThan(10);
    expect(badCoordinateCalls(calls)).toEqual([]);
    const short = fakeCtx(60, 20);
    drawSpark(short.ctx, its.slice(0, 1), 60, 20);
    expect(named(short.calls, "lineTo")).toBe(0);
  });

  it("smooths a noisy curve into a trailing trend that starts at the first value", () => {
    const pts = Array.from({ length: 200 }, (_, i) => ({ iter: i, v: i / 10 + (i % 2 ? 1 : -1) }));
    const t = smooth(pts);
    expect(t).toHaveLength(200);
    expect(t[0]!.v).toBe(pts[0]!.v); // nothing invented before the first sample
    expect(Math.abs(t[100]!.v - (10 - 0.5))).toBeLessThan(0.5); // lags the rise by about half a window, no more
    expect(t.map((p) => p.iter)).toEqual(pts.map((p) => p.iter));
    expect(smooth([])).toEqual([]);
    expect(smooth([{ iter: 0, v: 3 }, { iter: 5, v: -9 }, { iter: 10, v: 6 }]).map((p) => p.v)).toEqual([3, -3, 0]);
    const rising = smooth(Array.from({ length: 50 }, (_, i) => ({ iter: i, v: i })));
    expect(rising.every((p, i) => p.v <= i && (i === 0 || p.v >= rising[i - 1]!.v))).toBe(true);
  });

  it("spreads labels apart inside the plot, keeping their order", () => {
    const ys = spreadLabels([{ y: 50, h: 14 }, { y: 52, h: 14 }, { y: 51, h: 30 }], 0, 200);
    const sorted = [...ys].sort((a, b) => a - b);
    expect(sorted[1]! - sorted[0]!).toBeGreaterThanOrEqual(14 - 1e-9);
    expect(sorted[2]! - sorted[1]!).toBeGreaterThanOrEqual(22 - 1e-9);
    expect(spreadLabels([{ y: 1, h: 10 }], 0, 100)[0]).toBe(5);
    expect(spreadLabels([{ y: 99, h: 10 }, { y: 100, h: 10 }], 0, 100).every((y) => y <= 95)).toBe(true);
    expect(spreadLabels([], 0, 10)).toEqual([]);
  });

  it("draws a short run raw with dots and no trend, and a long run as a trend", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ iter: i * 5 + 5, train: 1, best: 2, held: i + 0.5, perEnv: null, seconds: i }));
    const short = fakeCtx(600, 300);
    drawRewardGraph(short.ctx, mk(10), 0, 600, 300);
    expect(named(short.calls, "arc")).toBe(11 + 1); // every check and the start, plus the ring on the latest
    const long = fakeCtx(600, 300);
    drawRewardGraph(long.ctx, mk(40), 0, 600, 300);
    expect(named(long.calls, "arc")).toBe(1); // only the ring: the trend has no dots
  });

  it("ends the gain bracket on the ringed latest check, matching the headline", () => {
    const { ctx, calls } = fakeCtx(600, 300);
    const its = [10, 20, 30].map((i, k) => ({ iter: i, train: 1, best: 2, held: [1, 4, 2.5][k]!, perEnv: null, seconds: i }));
    drawRewardGraph(ctx, its, 0, 600, 300);
    const ring = calls.filter((c) => c.name === "arc").pop()!;
    const lines = calls.filter((c) => c.name === "lineTo");
    const bracketEnd = lines[lines.length - 2]!; // gutter bracket: up from the start to the latest, then back
    expect(Math.abs((bracketEnd.args[1] as number) - (ring.args[1] as number))).toBeLessThan(1e-6);
    expect(calls.filter((c) => c.name === "fillText").map((c) => c.args[0])).toContain("+2.5");
  });

  it("keeps raw held-out values on the scale and marks a lone outlier as off the scale", () => {
    const mk = (spike: number) => Array.from({ length: 200 }, (_, i) => ({ iter: i * 5 + 5, train: 1, best: 2, held: i === 100 ? spike : 1 + (i % 3) * 0.1, perEnv: null, seconds: i }));
    const text = (spike: number) => {
      const { ctx, calls } = fakeCtx(600, 300);
      drawRewardGraph(ctx, mk(spike), 1, 600, 300);
      return calls.filter((c) => c.name === "fillText").map((c) => c.args[0] as string);
    };
    expect(text(1.3)).not.toContain("some raw checks are off the scale");
    expect(text(50000)).toContain("some raw checks are off the scale");
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
    removeFavourite(file("b"), store);
    expect(loadFavourites(store).map((f) => f.name)).toEqual(["a"]);
  });

  it("removes the creature that was picked even after another tab saved one", () => {
    const store = memory();
    addFavourite(file("a"), store);
    const picked = loadFavourites(store)[0]!;
    addFavourite(file("b"), store); // index of "a" shifts from 0 to 1
    removeFavourite(picked, store);
    expect(loadFavourites(store).map((f) => f.name)).toEqual(["b"]);
    removeFavourite(picked, store); // already gone: nothing else is dropped
    expect(loadFavourites(store).map((f) => f.name)).toEqual(["b"]);
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
    expect(tileTitle("Nibble", 7, 0, 1, true)).toBe("Nibble · policy at update 7 · layout 1");
  });
  it("shows kills only when there were any", () => {
    expect(resultLine({ food: 4, kills: 0, seconds: 44.6 })).toBe("food 4, alive 45 s");
    expect(resultLine({ food: 4, kills: 2, seconds: 10 })).toBe("food 4, kills 2, alive 10 s");
  });
  it("says which learner a tile plays, and its layout only when an env has several", () => {
    expect(tileSub({ iter: 42, envCount: 4 }, 2, 4)).toBe("best of iteration 42");
    expect(tileSub({ iter: 42, envCount: 1 }, 2, 4)).toBe("best of iteration 42 · layout 3");
    expect(tileSub({ iter: 0, envCount: 2 }, 1, 2)).toBe("starting creature");
    expect(tileSub({ iter: 0, envCount: 2, preview: true }, 1, 2)).toBe("sample clip");
  });
});

describe("tiles follow the environments in use", () => {
  it("gives a few envs extra layouts and many envs one tile each", () => {
    expect([1, 2, 3, 4, 12, 40].map((n) => layoutsPerEnv("auto", n))).toEqual([4, 2, 2, 1, 1, 1]);
    expect(layoutsPerEnv("2", 12)).toBe(2);
    expect(layoutsPerEnv("12", 1)).toBe(4); // an old saved count is capped
    expect(layoutsPerEnv("junk", 5)).toBe(1);
  });
  it("puts each env's layouts side by side", () => {
    expect(displayOrder(6, 3)).toEqual([0, 3, 1, 4, 2, 5]); // recording k plays env k % 3
    expect(displayOrder(4, 4)).toEqual([0, 1, 2, 3]);
    expect(displayOrder(0, 0)).toEqual([]);
  });
  it("shows every env up to the show cap, and counts the rest", () => {
    expect(unshownEnvs(46)).toBe(0);
    expect(unshownEnvs(50)).toBe(2);
  });
  it("balances the columns over the rows the width needs", () => {
    expect(gridColumns(1, 1000)).toBe(1);
    expect(gridColumns(4, 1000)).toBe(4);
    expect(gridColumns(12, 1000)).toBe(4); // 5 fit, 3 rows of 4
    expect(gridColumns(5, 1000)).toBe(5);
    expect(gridColumns(6, 600)).toBe(3);
    expect(gridColumns(12, 350)).toBe(1);
  });
  it("pages many tiles and clamps the page", () => {
    expect(pageOf(4, 0)).toEqual({ from: 0, to: 4, page: 0, pages: 1 });
    expect(pageOf(30, 2)).toEqual({ from: 24, to: 30, page: 2, pages: 3 });
    expect(pageOf(30, 9).page).toBe(2);
    expect(pageOf(0, 1)).toEqual({ from: 0, to: 0, page: 0, pages: 1 });
  });
  it("names the phase for the status pill", () => {
    expect(phaseOf("idle", false)).toBe("ready");
    expect(phaseOf("running", true)).toBe("training");
    expect(phaseOf("paused", true)).toBe("paused");
    expect(phaseOf("idle", true)).toBe("done");
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
    saveSpeed(0, s);
    expect(loadSpeed(s)).toBe(0); // Max
    expect(loadSpeed(store("1"))).toBe(1); // old stored values still load
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
    expect(named(calls, "lineTo")).toBeLessThan(6 * 800 + 60); // train trend, held-out envelope and trend, and the two fills
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

describe("poison cost and the recommended mix", () => {
  it("Mix picks each recommended env once, skipping unknown ids", () => {
    const picked = mixPick(RECOMMENDED_MIX, ENVS);
    expect([...picked].sort()).toEqual([...new Set(RECOMMENDED_MIX)].sort());
    expect(picked.size).toBe(7);
    expect([...mixPick(["nibble", "no-such-env"], ENVS)]).toEqual(["nibble"]);
  });

  it("start options carry the poison cost for ES only", () => {
    expect(startOptions({ ...DEFAULT_RUN, method: "es" }, 0.005).poisonCost).toBe(1);
    expect(startOptions({ ...DEFAULT_RUN, method: "es", poisonCost: 3.5 }, 0.005).poisonCost).toBe(3.5);
    expect("poisonCost" in startOptions({ ...DEFAULT_RUN, method: "backprop" }, 0.005)).toBe(false);
  });

  it("the saved file names the poison cost of ES runs, and old files still load", () => {
    const base = { envs: ["nibble"], iterations: 5, from: "designed", heldStart: 1, heldEnd: 2 };
    expect(trainingRecord({ ...base, poisonCost: 2 }, "2026-11-04").poisonCost).toBe(2);
    expect("poisonCost" in trainingRecord({ ...base, poisonCost: null }, "2026-11-04")).toBe(false);
    const plan = planOf(envConfig({ ...BLANK_ENV, world: "ecosystem" }, 1));
    const f = creatureFile("forager", "x", { plan, genome: new Float32Array(genomeLengthFor("forager", plan)) }, trainingRecord({ ...base, poisonCost: 2 }, "2026-11-04"));
    expect(JSON.parse(JSON.stringify(f)).training.poisonCost).toBe(2);
    expect(typeof parseCreatureFile(JSON.stringify(f))).toBe("object");
  });
});

describe("TileGrid repaints only when the picture changes", () => {
  const setup = () => {
    const root = document.createElement("div");
    const grid = new TileGrid(root);
    grid.setSlots([0]);
    const canvas = root.querySelector("canvas")!;
    Object.defineProperty(canvas, "clientWidth", { value: 100, configurable: true });
    Object.defineProperty(canvas, "clientHeight", { value: 50, configurable: true });
    let paints = 0;
    const ctx = new Proxy({}, { get: (_t, k) => (k === "setTransform" ? () => void paints++ : () => {}), set: () => true });
    (canvas as { getContext: unknown }).getContext = () => ctx;
    grid.show({ iter: 1, genome: new Float32Array(1), recordings: [recording()], names: ["a"], envCount: 1 }, 0);
    return { grid, canvas, paints: () => paints };
  };
  it("skips a paused clock and repaints on resize", () => {
    const { grid, canvas, paints } = setup();
    grid.draw(0);
    grid.paused = true;
    grid.draw(1000);
    grid.draw(2000);
    expect(paints()).toBe(1);
    Object.defineProperty(canvas, "clientWidth", { value: 120, configurable: true });
    grid.draw(3000);
    expect(paints()).toBe(2);
  });
});
