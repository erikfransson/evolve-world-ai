import { GROUND_HALF } from "../../src/typescript/src/sim/groundField.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { MAPS, builtMap } from "../../src/typescript/src/sim/maps/index.ts";
import { buildMap, CAP_CELL, WEIGHT_UNIT } from "../../src/typescript/src/sim/maps/mapBuild.ts";
import type { MapSpec } from "../../src/typescript/src/sim/maps/mapBuild.ts";
import { withEcoPreset } from "../../src/typescript/src/sim/presets.ts";
import { terrainOf } from "../../src/typescript/src/sim/terrain.ts";
import { TERRAIN_FAST, TERRAIN_SLOW } from "../../src/typescript/src/sim/terrain.ts";
import { HIT_FOOD, HIT_POISON } from "../../src/typescript/src/sim/types.ts";
import { World } from "../../src/typescript/src/sim/world.ts";
import { fineOf, groundBodies } from "../../src/typescript/src/ui/groundOutline.ts";

const SEA = MAPS["inland-sea"]!;
const seaConfig = (): EcoConfig => {
  const c = withEcoPreset(structuredClone(DEFAULT_ECO_CONFIG), "inland-sea");
  c.eco = { ...c.eco, wasm: false, initialPopulation: 12, poolFraction: 0 };
  c.world = { ...c.world, foodDensity: 0.002, poisonDensity: 0.0002 };
  return c;
};

describe("The Inland Sea map", () => {
  const map = builtMap("inland-sea");
  const w = map.weights;

  it("is built once per name and fits the world and the bounds", () => {
    expect(builtMap("inland-sea")).toBe(map);
    expect([SEA.width, SEA.height]).toEqual([40000, 25000]);
    expect(map.rock.length).toBeGreaterThan(500);
    expect(map.rock.length).toBeLessThanOrEqual(8000);
    for (const d of map.rock) {
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x).toBeLessThanOrEqual(SEA.width);
      expect(d.y).toBeGreaterThanOrEqual(0);
      expect(d.y).toBeLessThanOrEqual(SEA.height);
      expect(d.r).toBeLessThanOrEqual(380);
    }
    expect(map.stats.mud).toBeGreaterThan(0.05);
    expect(map.stats.firm).toBeGreaterThan(0.02);
    expect(map.ground.bytes + w.bytes).toBeLessThan(1_100_000);
  });

  it("has the regions: no poison in the sea, more on the north shore, poor food on the dunes, rich food in the shallows", () => {
    const sea = terrainOf(seaConfig());
    let mud = 0;
    let mudFood = 0;
    let mudPoison = 0;
    for (let x = 1000; x < 39000; x += 250) {
      for (let y = 1000; y < 24000; y += 250) {
        if (sea.valueAt(x, y) !== TERRAIN_SLOW) continue;
        mud++;
        mudFood += w.byteAt(0, x, y) / WEIGHT_UNIT;
        mudPoison += w.byteAt(1, x, y);
      }
    }
    expect(mud).toBeGreaterThan(1000);
    expect(mudFood / mud).toBeGreaterThan(1.3);
    expect(mudPoison / mud / WEIGHT_UNIT).toBeLessThan(0.15); // almost none: only the fringe where the sea's edge fades
    expect(w.byteAt(1, 22000, 6500) / WEIGHT_UNIT).toBeGreaterThan(1.7); // the ash shore
    expect(w.byteAt(0, 22000, 6500) / WEIGHT_UNIT).toBeGreaterThan(1.5);
    let firm = 0;
    let firmFood = 0;
    for (let x = 1000; x < 39000; x += 250) for (let y = 1000; y < 24000; y += 250) if (sea.valueAt(x, y) === TERRAIN_FAST) { firm++; firmFood += w.byteAt(0, x, y) / WEIGHT_UNIT; }
    expect(firm).toBeGreaterThan(300);
    expect(firmFood / firm).toBeLessThan(0.8);
    expect(w.maxFood / WEIGHT_UNIT).toBeLessThan(3.9);
    expect(w.maxPoison / WEIGHT_UNIT).toBeLessThan(3.9);
  });

  it("keeps the cliff passes open to a creature", () => {
    const sea = terrainOf(seaConfig());
    const cliffs = SEA.rock.find((r) => r.id === "cliffs")!;
    expect(cliffs.passes!.length).toBeGreaterThanOrEqual(2);
    for (const [x, y] of cliffs.passes!) expect(sea.touchesRock(x, y, 12)).toBe(false);
  });

  it("senses what is drawn: the value of a point is the kind of the ground outline around it", () => {
    const sea = terrainOf(seaConfig());
    const field = sea.ground!;
    const bodies = groundBodies(sea, fineOf(sea));
    expect(new Set(bodies.map((b) => b.kind))).toEqual(new Set([TERRAIN_SLOW, TERRAIN_FAST]));
    const inside = (loop: readonly number[], x: number, y: number): boolean => {
      let c = false;
      for (let i = 0, j = loop.length - 2; i < loop.length; j = i, i += 2) {
        const [xi, yi, xj, yj] = [loop[i]!, loop[i + 1]!, loop[j]!, loop[j + 1]!];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const drawnKind = (x: number, y: number): number => {
      for (const b of bodies) {
        if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
        let odd = false;
        for (const loop of b.loops) if (inside(loop, x, y)) odd = !odd;
        if (odd) return b.kind;
      }
      return 0;
    };
    const rng = createRng(3);
    let checked = 0;
    for (let k = 0; k < 6000; k++) {
      const x = rng.range(0, SEA.width);
      const y = rng.range(0, SEA.height);
      const slack = Math.min(...[0, 1].map((l) => Math.abs(field.blend(l, x, y) - GROUND_HALF)));
      if (slack < 6) continue; // within a few units of the contour the outline is a polygon
      checked++;
      expect(sea.valueAt(x, y)).toBe(drawnKind(x, y));
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it("is the same map on a second build", () => {
    const small: MapSpec = { ...SEA, width: 12000, height: 8000, layers: SEA.layers.slice(0, 2), rock: SEA.rock.slice(0, 1) };
    const a = buildMap(small);
    const b = buildMap(small);
    expect(a.ground.data).toEqual(b.ground.data);
    expect(a.weights.food).toEqual(b.weights.food);
    expect(a.rock).toEqual(b.rock);
  }, 60000);
});

describe("weighted items and local caps", () => {
  it("scatters food by the food weight and poison only where its weight is above 0", () => {
    const config = seaConfig();
    const world = new World(config, 9000);
    world.scatter(6000, 3000, createRng(7));
    const w = world.terrain.weights!;
    let rich = 0;
    let poor = 0;
    for (let i = 0; i < 6000; i++) {
      const weight = w.byteAt(0, world.xs[i]!, world.ys[i]!) / WEIGHT_UNIT;
      if (weight > 1.5) rich++;
      if (weight < 0.7) poor++;
    }
    let area = 0;
    let richArea = 0;
    let poorArea = 0;
    for (let x = 100; x < 40000; x += 200) for (let y = 100; y < 25000; y += 200) { const weight = w.byteAt(0, x, y) / WEIGHT_UNIT; area++; if (weight > 1.5) richArea++; if (weight < 0.7) poorArea++; }
    expect(rich / 6000).toBeGreaterThan(1.4 * (richArea / area)); // rich places hold well over their area share of the food
    expect(poor / 6000).toBeLessThan(0.7 * (poorArea / area));
    for (let i = 6000; i < 9000; i++) expect(w.byteAt(1, world.xs[i]!, world.ys[i]!)).toBeGreaterThan(0);
  });

  it("limits sum to the rounded total and give a cell of weight 0 nothing", () => {
    const w = builtMap("inland-sea").weights;
    const per = (SEA.width * SEA.height) / 100 ** 2;
    const poison = w.limits(1, 0.01, per);
    const mean = poison.reduce((a, b) => a + b, 0);
    const expected = w.capArea.reduce((s, a, c) => s + 0.01 * per * (a / (SEA.width * SEA.height)) * w.meanPoison[c]!, 0);
    expect(Math.abs(mean - expected)).toBeLessThan(1);
    poison.forEach((n, c) => { if (w.meanPoison[c]! === 0) expect(n).toBe(0); });
    expect(poison.some((n) => n === 0)).toBe(true);
    expect(w.limits(0, 1.5, per).every((n) => n >= 0)).toBe(true);
    expect(w.capCols).toBe(SEA.width / CAP_CELL);
  });

  it("declines a spot in a full cap cell, counts removals and recounts after load", () => {
    const world = new World(seaConfig(), 400);
    const w = world.terrain.weights!;
    const cells = w.capCols * w.capRows;
    const open = w.capIndex(22500, 6500); // on the ash shore, where poison is likely to be drawn
    const poisonLimit = new Int32Array(cells);
    poisonLimit[open] = 1; // one poison fits in that cell and none anywhere else
    world.setCapLimits(new Int32Array(cells), poisonLimit);
    const tries = (target: World): number[] => Array.from({ length: 1500 }, (_, t) => target.addRandomly(HIT_POISON, createRng(100 + t)));
    const added = tries(world).filter((s) => s >= 0);
    expect(added.length).toBe(1); // the first fills the cell, every other spot is declined
    expect(world.addRandomly(HIT_FOOD, createRng(1))).toBe(-2);
    const copy = new World(seaConfig(), 400);
    copy.setCapLimits(new Int32Array(cells), poisonLimit);
    copy.load(world.snapshot());
    expect(tries(copy).filter((s) => s >= 0)).toEqual([]); // the loaded world counted its poison
    world.removeItem(added[0]!);
    expect(tries(world).filter((s) => s >= 0).length).toBe(1); // room again after the removal
  });

  it("an ecosystem never holds more than a cap cell allows of regrown items, and food stays inside the limits", () => {
    const config = seaConfig();
    config.eco = { ...config.eco, foodRegrow: 0.3, foodMaxDensity: 0.5 };
    config.world = { ...config.world, foodDensity: 0 };
    const eco = new Ecosystem(config);
    for (let t = 0; t < 200; t++) eco.step();
    const items = eco.world as World;
    const w = items.terrain.weights!;
    const limits = w.limits(0, 0.5, (SEA.width * SEA.height) / 100 ** 2);
    const counts = new Int32Array(limits.length);
    for (let i = 0; i < items.count; i++) if (items.kinds[i] === HIT_FOOD) counts[w.capIndex(items.xs[i]!, items.ys[i]!)]!++;
    expect(counts.some((n) => n > 0)).toBe(true);
    counts.forEach((n, c) => expect(n).toBeLessThanOrEqual(limits[c]!));
    expect(eco.food).toBe(counts.reduce((a, b) => a + b, 0));
  });
});

describe("a world with a named map", () => {
  it("restores from its name and continues bit-identically", () => {
    const eco = new Ecosystem(seaConfig());
    for (let t = 0; t < 60; t++) eco.step();
    const state = JSON.parse(JSON.stringify(saveState(eco))) as EcoState;
    expect(state.config.world.map).toBe("inland-sea");
    expect(JSON.stringify(state).length).toBeLessThan(5_000_000); // the map itself is not stored
    const copy = restoreState(state);
    for (let t = 0; t < 120; t++) {
      eco.step();
      copy.step();
    }
    expect(copy.fingerprint()).toBe(eco.fingerprint());
    expect(copy.food).toBe(eco.food);
  });

  it("refuses an unknown map and a map in a world of the wrong size", () => {
    const state = JSON.parse(JSON.stringify(saveState(new Ecosystem(seaConfig())))) as EcoState;
    const bad = (edit: (w: Record<string, unknown>) => void): EcoState => {
      const s = structuredClone(state);
      edit(s.config.world as unknown as Record<string, unknown>);
      return s;
    };
    expect(() => restoreState(bad((w) => { w.map = "atlantis"; }))).toThrow(/world\.map/);
    expect(() => restoreState(bad((w) => { w.map = 5; }))).toThrow(/world\.map/);
    expect(() => restoreState(bad((w) => { w.width = 30000; }))).toThrow(/needs a world of 40000 x 25000/);
    expect(() => terrainOf({ seed: 1, world: { ...seaConfig().world, map: "atlantis" } })).toThrow(/unknown map/);
  });

  it("founders start where the food weight accepts them and the random map is untouched", () => {
    const eco = new Ecosystem({ ...seaConfig(), eco: { ...seaConfig().eco, initialPopulation: 60 } });
    expect(eco.members.length).toBe(60);
    const plain = new Ecosystem({ ...DEFAULT_ECO_CONFIG, eco: { ...DEFAULT_ECO_CONFIG.eco, wasm: false, initialPopulation: 5 }, world: { ...DEFAULT_ECO_CONFIG.world, width: 1200, height: 900 } });
    expect((plain.world as World).terrain.weights).toBeNull();
  });
});
