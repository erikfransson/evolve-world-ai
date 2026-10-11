import { HIT_FOOD, HIT_WALL } from "../../src/typescript/src/sim/types.ts";
import { Camera } from "../../src/typescript/src/ui/camera.ts";
import { EcoRenderer, creatureBucket, creatureStyle } from "../../src/typescript/src/ui/ecoScene.ts";
import type { EcoDrawConfig } from "../../src/typescript/src/ui/ecoScene.ts";
import { planOf } from "../../src/typescript/src/sim/sensors.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { SelectedDetails } from "../../src/typescript/src/worker/ecoProtocol.ts";
import { snapshotBytes, snapshotViews } from "../../src/typescript/src/worker/ecoProtocol.ts";
import { badCoordinateCalls, fakeCtx } from "./helpers.ts";

const cfg: EcoDrawConfig = { worldW: 4000, worldH: 2500, radius: 12, itemRadius: 4, fullEnergy: 150 };

function views(n: number, items = 50) {
  const buffer = new ArrayBuffer(snapshotBytes(n, items));
  const v = snapshotViews(buffer, n, items, n, items);
  for (let i = 0; i < n; i++) {
    v.ids[i] = i;
    v.x[i] = 100 + ((i * 37) % 3800);
    v.y[i] = 100 + ((i * 91) % 2300);
    v.heading[i] = i;
    v.energy[i] = (i * 13) % 200;
    v.hue[i] = (i * 7) % 360;
    v.age[i] = i % 400;
    v.founder[i] = i % 5;
  }
  for (let i = 0; i < items; i++) {
    v.itemX[i] = 50 + i * 70;
    v.itemY[i] = 50 + i * 40;
    v.itemKind[i] = 1 + (i % 2);
  }
  return v;
}

const selected: SelectedDetails = {
  id: 3, alive: true, x: 211, y: 373, heading: 1, energy: 80, age: 20, children: 0, eaten: 0, depth: 0, parentId: -1, hue: 10, founderId: 3, founderPool: false, founderHue: 10, plan: { ...planOf(DEFAULT_ECO_CONFIG), rayCount: 3, rayLength: 100 }, upkeep: 0.3,
  rayKinds: Uint8Array.of(HIT_FOOD, 0, HIT_WALL), rayCloseness: Float32Array.of(0.5, 0, 0.2), rayEnergy: new Float32Array(3),
  rayOffsets: Float32Array.of(-0.3, 0, 0.3), inputs: new Float32Array(0), genome: null,
};

describe("creature colour", () => {
  it("is bright when young, more muted with age, and saturates", () => {
    const light = (age: number) => Number(/(\d+)%\)$/.exec(creatureStyle(120, age))![1]);
    expect(light(0)).toBeGreaterThan(light(60));
    expect(light(60)).toBeGreaterThan(light(170));
    expect(light(300)).toBe(light(3000));
    expect(light(3000)).toBeGreaterThan(30); // still readable on the floor
    expect(creatureBucket(360, 0)).toBe(creatureBucket(0, 0)); // hue wraps
  });
});

describe("EcoRenderer", () => {
  const draw = (zoom: number | null, n: number) => {
    const { ctx, calls } = fakeCtx(1000, 700);
    const cam = new Camera(cfg.worldW, cfg.worldH, 1000, 700, 20);
    if (zoom !== null) cam.setView(200, 350, zoom);
    new EcoRenderer().draw(ctx, cam, cfg, views(n), selected, true, 1);
    return calls;
  };

  it("draws the whole world as flat dots without bad coordinates", () => {
    const calls = draw(null, 3000);
    expect(badCoordinateCalls(calls)).toEqual([]);
    expect(calls.filter((c) => c.name === "stroke").length).toBeLessThan(20); // no per-creature rings, only the selection
  });

  it("draws creatures with rings, fill and a selection ring when zoomed in", () => {
    const calls = draw(5, 3000);
    expect(badCoordinateCalls(calls)).toEqual([]);
    expect(calls.filter((c) => c.name === "arc").length).toBeGreaterThan(3);
  });

  it("dims everyone outside the highlighted lineage", () => {
    const run = (zoom: number | null, highlight: number) => {
      const { ctx, calls } = fakeCtx(1000, 700);
      const cam = new Camera(cfg.worldW, cfg.worldH, 1000, 700, 20);
      if (zoom !== null) cam.setView(200, 350, zoom);
      new EcoRenderer().draw(ctx, cam, cfg, views(3000), selected, true, 1, highlight);
      expect(badCoordinateCalls(calls)).toEqual([]);
      return calls.filter((c) => c.name === "arc").length;
    };
    // Flat dots: dimmed creatures get no outline pass, so fewer arcs than with no highlight.
    expect(run(null, 2)).toBeLessThan(run(null, -1));
    run(5, 2);
  });

  it("culls creatures and items outside the view", () => {
    const wide = draw(null, 3000).filter((c) => c.name === "rect" || c.name === "arc").length;
    const near = draw(20, 3000).filter((c) => c.name === "rect" || c.name === "arc").length;
    expect(wide).toBeGreaterThan(1000);
    expect(near).toBeLessThan(40);
  });
});
