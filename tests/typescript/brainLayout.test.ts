import { Brain, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { inputLayout } from "../../src/typescript/src/sim/sensors.ts";
import { BrainView, buildLayout, rayLabelColor } from "../../src/typescript/src/ui/brainView.ts";
import { SPECIES_COLORS } from "../../src/typescript/src/ui/speciesStyle.ts";
import { badCoordinateCalls, fakeCanvas, fakeCtx, testRng } from "./helpers.ts";

beforeEach(() => {
  vi.stubGlobal("window", { devicePixelRatio: 1 });
});
afterEach(() => vi.unstubAllGlobals());

const GRID_X = 38; // first feature column
const FEAT_DX = 12;

describe("BrainView layout", () => {
  it("keeps the four feature columns and the extras under them for Trials", () => {
    const sizes = layerSizes(DEFAULT_CONFIG);
    const layout = buildLayout(fakeCtx().ctx, sizes, 4, 300, 200);
    expect(layout.rays).toBe(DEFAULT_CONFIG.creature.rayCount);
    expect(layout.features).toBe(4);
    const xIn = layout.xs[0]!;
    expect(Array.from(xIn.subarray(0, 8))).toEqual([0, 1, 2, 3, 0, 1, 2, 3].map((f) => GRID_X + f * FEAT_DX));
    const extras = layout.rays * 4;
    expect(Array.from(xIn.subarray(extras, extras + 5))).toEqual([0, 1, 2, 3, 4].map((k) => GRID_X + k * FEAT_DX));
    expect(layout.ys[0]![extras]).toBeGreaterThan(layout.ys[0]![extras - 1]!);
  });

  it("gives Ecosystem six feature columns per ray and the extras in the last five", () => {
    const sizes = layerSizes(DEFAULT_ECO_CONFIG);
    const layout = buildLayout(fakeCtx().ctx, sizes, 6, 300, 200);
    expect(layout.rays).toBe(DEFAULT_ECO_CONFIG.creature.rayCount);
    expect(layout.xs[0]!.length).toBe(sizes[0]);
    const xIn = layout.xs[0]!;
    expect(Array.from(xIn.subarray(0, 6))).toEqual([0, 1, 2, 3, 4, 5].map((f) => GRID_X + f * FEAT_DX));
    const extras = layout.rays * 6;
    expect(Array.from(xIn.subarray(extras, extras + 5))).toEqual([1, 2, 3, 4, 5].map((f) => GRID_X + f * FEAT_DX));
    expect(layout.xs[1]![0]).toBeGreaterThan(GRID_X + 5 * FEAT_DX); // hidden layer right of the grid
  });

  function drawn(config: typeof DEFAULT_CONFIG | typeof DEFAULT_ECO_CONFIG, layout?: ReturnType<typeof inputLayout>) {
    const { canvas, calls } = fakeCanvas(300, 200);
    const sizes = layerSizes(config);
    const brain = new Brain(sizes, randomGenome(sizes, testRng(3)));
    brain.forward(new Float32Array(sizes[0]!), new Float32Array(2));
    new BrainView(canvas).draw(brain, true, layout);
    return calls;
  }

  it("labels the feature columns by their ray features", () => {
    const trials = drawn(DEFAULT_CONFIG);
    expect(badCoordinateCalls(trials)).toEqual([]);
    const header = (calls: typeof trials) => calls.filter((c) => c.name === "fillText").map((c) => c.args[0]).filter((t) => typeof t === "string" && /^[a-z]$/.test(t));
    expect(header(trials)).toEqual(["c", "f", "p", "w"]);
    const eco = drawn(DEFAULT_ECO_CONFIG, inputLayout(DEFAULT_ECO_CONFIG));
    expect(badCoordinateCalls(eco)).toEqual([]);
    expect(header(eco)).toEqual(["c", "f", "p", "w", "o", "e"]);
  });

  it("places short and long memory inputs in rows under the extras and their targets under thrust", () => {
    const config = { ...DEFAULT_CONFIG, brain: { ...DEFAULT_CONFIG.brain, memory: 1 } }; // 8 short + 8 long
    const sizes = layerSizes(config);
    const layout = buildLayout(fakeCtx().ctx, sizes, 4, 375, 220, 8);
    expect(layout.rays).toBe(DEFAULT_CONFIG.creature.rayCount);
    const yIn = layout.ys[0]!;
    const extras = layout.rays * 4;
    const mem = Array.from(yIn.subarray(layout.memoryAt));
    expect(mem.every((y) => y > layout.extraLabelY && y < 220)).toBe(true);
    expect(layout.memoryRows.map((r) => r.long)).toEqual([false, false, true, true]);
    expect(Math.min(...mem.slice(8))).toBeGreaterThan(Math.max(...mem.slice(0, 8))); // long rows below short ones
    expect(layout.memoryAt).toBe(extras + 5);
    const yOut = layout.ys.at(-1)!;
    const xOut = layout.xs.at(-1)!;
    expect(Math.min(...yOut.subarray(2))).toBeGreaterThan(yOut[1]!);
    expect(Math.max(...yOut)).toBeLessThan(220);
    expect(xOut[2]).toBeLessThan(xOut[0]!); // short column left, long right
    expect(xOut[10]).toBeGreaterThan(xOut[0]!);

    const { canvas, calls } = fakeCanvas(375, 220);
    const brain = new Brain(sizes, randomGenome(sizes, testRng(4)));
    brain.forward(new Float32Array(sizes[0]!).fill(0.3), new Float32Array(sizes.at(-1)!));
    new BrainView(canvas).draw(brain, true, inputLayout(config));
    expect(badCoordinateCalls(calls)).toEqual([]);
    const texts = calls.filter((c) => c.name === "fillText").map((c) => c.args[0]);
    expect(texts).toEqual(expect.arrayContaining(["S", "L", "memory", "turn", "thrust"]));
  });
});

describe("rayLabelColor", () => {
  // Ray inputs of one ray: closeness, food, poison, wall, then the creature flags and the seen energy.
  const ray = (...v: number[]) => Float32Array.from(v);
  it("lights a ray seeing any species in that species' colour, not only the first", () => {
    expect(rayLabelColor(ray(0.5, 0, 0, 0, 0, 1, 0.4), 0, 7)).toBe(SPECIES_COLORS[1]);
    expect(rayLabelColor(ray(0.5, 0, 0, 0, 1, 0, 0.4), 0, 7)).toBe(SPECIES_COLORS[0]);
    expect(rayLabelColor(ray(0.5, 1, 0, 0, 0, 0, 0), 0, 7)).toBe(rayLabelColor(ray(0.5, 1, 0, 0), 0, 4)); // food, as in Trials
    expect(rayLabelColor(ray(0, 0, 0, 0, 0, 0, 0), 0, 7)).toBe(rayLabelColor(ray(0, 0, 0, 0), 0, 4)); // nothing seen
    expect(rayLabelColor(ray(0.5, 0, 0, 0, 1, 0.3), 0, 6)).not.toBe(rayLabelColor(ray(0, 0, 0, 0, 0, 0), 0, 6)); // one-species flag
  });
});
