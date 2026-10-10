import { Brain, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { inputSize } from "../../src/typescript/src/sim/sensors.ts";
import { HIT_FOOD, HIT_POISON, HIT_WALL } from "../../src/typescript/src/sim/types.ts";
import type { EpisodeView, HitKind, PlaybackState } from "../../src/typescript/src/sim/types.ts";
import { BrainView } from "../../src/typescript/src/ui/brainView.ts";
import { FitnessGraph } from "../../src/typescript/src/ui/fitnessGraph.ts";
import { drawScene } from "../../src/typescript/src/ui/scene.ts";
import type { ViewOptions } from "../../src/typescript/src/ui/scene.ts";
import { badCoordinateCalls, fakeCanvas, fakeCtx, testRng } from "./helpers.ts";

beforeEach(() => {
  vi.stubGlobal("window", { devicePixelRatio: 2 });
  vi.stubGlobal("ResizeObserver", class { observe() {} });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { fn(); return 0; }); // draw at once
});
afterEach(() => vi.unstubAllGlobals());

function episodeView(config: SimConfig, alive = true): EpisodeView {
  const n = config.creature.rayCount;
  const kinds: HitKind[] = [HIT_FOOD, HIT_POISON, HIT_WALL, 0];
  return {
    state: { x: 400, y: 300, heading: 1, vx: 0, vy: 0, turnRate: 0, energy: 80, alive, ticksAlive: 10 },
    rays: Array.from({ length: n }, (_, i) => ({ closeness: (i % 4) / 4, kind: kinds[i % 4]!, energy: 0 })),
    rayOffsets: new Float32Array(n),
    world: { count: 3, xs: Float32Array.of(10, 20, 30), ys: Float32Array.of(10, 20, 30), kinds: Uint8Array.of(HIT_FOOD, HIT_POISON, 0) },
  };
}

const others: PlaybackState[] = [
  { x: 100, y: 100, heading: 0, energy: 10, alive: true },
  { x: 200, y: 150, heading: 2, energy: 300, alive: true },
  { x: 300, y: 250, heading: 4, energy: 0, alive: false },
];

describe("drawScene", () => {
  const views: ViewOptions[] = [];
  for (const showAll of [false, true]) for (const showRays of [false, true]) for (const pov of [false, true]) views.push({ showAll, showRays, pov });

  it.each(views)("draws without bad coordinates for %o", (view) => {
    const { ctx, calls } = fakeCtx(1000, 700);
    drawScene(ctx, DEFAULT_CONFIG, episodeView(DEFAULT_CONFIG), others, view, "Generation 3", 2);
    expect(calls.length).toBeGreaterThan(10);
    expect(badCoordinateCalls(calls)).toEqual([]);
  });

  it("draws only the label and background without a best creature", () => {
    const { ctx, calls } = fakeCtx();
    drawScene(ctx, DEFAULT_CONFIG, null, others, { showAll: true, showRays: true, pov: true }, "Waiting");
    expect(calls.filter((c) => c.name === "fillText").map((c) => c.args[0])).toEqual(["Waiting"]);
    expect(calls.some((c) => c.name === "arc")).toBe(false);
    expect(badCoordinateCalls(calls)).toEqual([]);
  });

  it("draws no label when none is given and draws the label top right", () => {
    const a = fakeCtx(1000, 700);
    drawScene(a.ctx, DEFAULT_CONFIG, episodeView(DEFAULT_CONFIG), [], { showAll: false, showRays: false, pov: false });
    expect(a.calls.some((c) => c.name === "fillText")).toBe(false);
    const b = fakeCtx(1000, 700);
    drawScene(b.ctx, DEFAULT_CONFIG, null, [], { showAll: false, showRays: false, pov: false }, "Gen 1", 2);
    const text = b.calls.find((c) => c.name === "fillText")!;
    expect(text.args[1]).toBe(1000 - 24);
    expect(b.props.textAlign).toBe("left"); // restored for later drawing
  });

  it("draws one ray per ray and only living others", () => {
    const withRays = fakeCtx();
    drawScene(withRays.ctx, DEFAULT_CONFIG, episodeView(DEFAULT_CONFIG), others, { showAll: false, showRays: true, pov: false });
    const without = fakeCtx();
    drawScene(without.ctx, DEFAULT_CONFIG, episodeView(DEFAULT_CONFIG), others, { showAll: false, showRays: false, pov: false });
    const lines = (c: { name: string }[]) => c.filter((x) => x.name === "lineTo").length;
    expect(lines(withRays.calls) - lines(without.calls)).toBe(DEFAULT_CONFIG.creature.rayCount);
    const showAll = fakeCtx();
    drawScene(showAll.ctx, DEFAULT_CONFIG, episodeView(DEFAULT_CONFIG), others, { showAll: true, showRays: false, pov: false });
    const fills = (c: { name: string }[]) => c.filter((x) => x.name === "fill").length;
    expect(fills(showAll.calls) - fills(without.calls)).toBe(2); // two living others
  });

  it("copes with a dead best creature, zero energy, a tiny canvas and a huge world", () => {
    const config: SimConfig = { ...DEFAULT_CONFIG, world: { ...DEFAULT_CONFIG.world, width: 4000, height: 3000 }, creature: { ...DEFAULT_CONFIG.creature, rayCount: 1 } };
    const view = episodeView(config, false);
    view.state.energy = 0;
    for (const [w, h] of [[10, 10], [1, 1], [3000, 200]] as const) {
      const { ctx, calls } = fakeCtx(w, h);
      drawScene(ctx, config, view, others, { showAll: true, showRays: true, pov: true }, "x");
      expect(badCoordinateCalls(calls)).toEqual([]);
    }
  });
});

function brainFor(config: SimConfig): Brain {
  const sizes = layerSizes(config);
  const brain = new Brain(sizes, randomGenome(sizes, testRng(3)));
  const input = new Float32Array(inputSize(config));
  const rng = testRng(9);
  for (let i = 0; i < input.length; i++) input[i] = rng.next() < 0.3 ? rng.next() : 0;
  brain.forward(input, new Float32Array(2));
  return brain;
}

describe("BrainView", () => {
  const withBrain = (rayCount: number, hiddenLayers: number[]): SimConfig => ({
    ...DEFAULT_CONFIG,
    creature: { ...DEFAULT_CONFIG.creature, rayCount },
    brain: { ...DEFAULT_CONFIG.brain, hiddenLayers },
  });

  it("draws nodes, labels and output names with finite coordinates", () => {
    const { canvas, calls } = fakeCanvas(320, 240);
    new BrainView(canvas).draw(brainFor(DEFAULT_CONFIG));
    const texts = calls.filter((c) => c.name === "fillText").map((c) => c.args[0]);
    expect(texts).toContain("R1");
    expect(texts).toContain("turn");
    expect(texts).toContain("thrust");
    expect(texts).not.toContain("dead");
    expect(badCoordinateCalls(calls)).toEqual([]);
  });

  it("marks a dead creature and fades the network", () => {
    const { canvas, calls, props } = fakeCanvas(320, 240);
    new BrainView(canvas).draw(brainFor(DEFAULT_CONFIG), false);
    expect(calls.filter((c) => c.name === "fillText").map((c) => c.args[0])).toContain("dead");
    expect(props.globalAlpha).toBe(1);
  });

  it("redraws the same brain repeatedly and after a size change", () => {
    const { canvas, calls } = fakeCanvas(320, 240);
    const view = new BrainView(canvas);
    for (let i = 0; i < 3; i++) view.draw(brainFor(DEFAULT_CONFIG));
    view.draw(brainFor(withBrain(16, [32, 32, 32, 32])));
    view.draw(brainFor(withBrain(1, [4])));
    expect(badCoordinateCalls(calls)).toEqual([]);
  });

  it("draws nothing on a canvas without size", () => {
    const { canvas, calls } = fakeCanvas(0, 0);
    new BrainView(canvas).draw(brainFor(DEFAULT_CONFIG));
    expect(calls).toEqual([]);
  });
});

describe("FitnessGraph", () => {
  const stats = Array.from({ length: 11 }, (_, g) => ({ generation: g, best: 10 + g * 5, mean: 5 + g }));
  // Plot spans x = 34 .. 292 on a 300 px canvas, so generation g sits at 34 + 25.8 g.
  const xOf = (g: number) => 34 + (258 * g) / 10;

  function setup(onPick = vi.fn()) {
    const f = fakeCanvas(300, 100);
    const graph = new FitnessGraph(f.canvas, onPick);
    return { ...f, graph, onPick };
  }

  it("draws axes, both lines and tick marks for kept generations", () => {
    const { graph, calls } = setup();
    calls.length = 0;
    graph.setData(stats, [0, 5, 10]);
    expect(calls.filter((c) => c.name === "stroke").length).toBe(3); // axes, mean, best
    expect(calls.filter((c) => c.name === "fillRect").length).toBe(3);
    const texts = calls.filter((c) => c.name === "fillText").map((c) => c.args[0]);
    expect(texts).toEqual(["60 s", "0", "gen 0", "10"]);
    expect(badCoordinateCalls(calls)).toEqual([]);
  });

  it("marks the watched generation and ignores one beyond the data", () => {
    const { graph, calls } = setup();
    graph.setData(stats, []);
    calls.length = 0;
    graph.setWatched(4);
    const arc = calls.find((c) => c.name === "arc")!;
    expect(arc.args[0]).toBeCloseTo(xOf(4));
    calls.length = 0;
    graph.setWatched(99);
    expect(calls.some((c) => c.name === "arc")).toBe(false);
  });

  it("draws only axes for empty data and does not report clicks", () => {
    const { graph, calls, click, onPick } = setup();
    graph.setData([], []);
    expect(calls.filter((c) => c.name === "stroke").length).toBe(1);
    click(100);
    expect(onPick).not.toHaveBeenCalled();
    expect(badCoordinateCalls(calls)).toEqual([]);
  });

  it("draws a single generation", () => {
    const { graph, calls } = setup();
    graph.setData([stats[0]!], [0]);
    expect(badCoordinateCalls(calls)).toEqual([]);
  });

  it("maps a click to the nearest generation and clamps outside the plot", () => {
    const { graph, click, onPick } = setup();
    graph.setData(stats, [0, 10]);
    click(xOf(3) + 5);
    click(xOf(7) - 2);
    click(0);
    click(299);
    expect(onPick.mock.calls.map((c) => c[0])).toEqual([3, 7, 0, 10]);
  });
});
