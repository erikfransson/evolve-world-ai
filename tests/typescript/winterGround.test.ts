// @vitest-environment node
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { capsOf, ItemEconomy } from "../../src/typescript/src/sim/itemEconomy.ts";
import { MAPS, builtHash, builtMap, mapVersion } from "../../src/typescript/src/sim/maps/index.ts";
import { buildMap } from "../../src/typescript/src/sim/maps/mapBuild.ts";
import type { MapSpec } from "../../src/typescript/src/sim/maps/mapBuild.ts";
import { packMap, unpackMap } from "../../src/typescript/src/sim/maps/mapParts.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { mapTerrain } from "../../src/typescript/src/sim/terrain.ts";
import { World } from "../../src/typescript/src/sim/world.ts";
import { decodeMapAsset, encodeMapAsset, terrainFromAsset } from "../../src/typescript/src/live/mapAsset.ts";

// A small map, its left half (x < 2000) winter ground with nothing left at mid-winter; the control is the same map without winter ground.
const W = 4000;
const H = 2000;
const patch = { id: "frost", shape: { type: "poly" as const, pts: [[-600, -600], [2000, -600], [2000, 2600], [-600, 2600]] as [number, number][] }, warp: 0, rough: 0, feather: 200 };
const spec = (name: string, winter?: number): MapSpec => ({ name, title: name, seed: 3, width: W, height: H, scale: 1, basePoison: 0, layers: [{ ...patch, ...(winter === undefined ? {} : { winter }) }], rock: [] });
const registry = MAPS as Record<string, MapSpec>;
registry["winter-test"] = spec("winter-test", 0);
registry["winter-control"] = spec("winter-control");
afterAll(() => {
  delete registry["winter-test"];
  delete registry["winter-control"];
});

const YEAR_TICKS = 40 * 60 * 30; // yearMinutes 40 at dt 1/30
const configOf = (map: string): EcoConfig => {
  const c = structuredClone(DEFAULT_ECO_CONFIG);
  c.world = { ...c.world, width: W, height: H, map };
  c.eco = { ...c.eco, wasm: false, seasons: true, yearMinutes: 40, winterFood: 0.3, foodRegrow: 37.5, poisonRegrow: 0, foodMaxDensity: 60 };
  return c;
};
// Food regrown over `ticks` calls of regrow at one tick of the year: how many land in the patch (x < 1500), the rest (x > 2500), and their positions.
function regrowAt(map: string, tick: number, ticks = 40): { patch: number; rest: number; xs: number[] } {
  const config = configOf(map);
  const world = new World(config, 60_000);
  const economy = new ItemEconomy(config, world, createRng(11), capsOf(config, config.eco));
  for (let k = 0; k < ticks; k++) economy.regrow(tick);
  const xs = Array.from(world.xs.subarray(0, economy.food));
  return { patch: xs.filter((x) => x < 1500).length, rest: xs.filter((x) => x > 2500).length, xs };
}

describe("winter ground", () => {
  it("is barren at mid-winter while the rest of the map keeps the global season, and gets its normal share at mid-summer", () => {
    const winter = regrowAt("winter-test", YEAR_TICKS / 2);
    const control = regrowAt("winter-control", YEAR_TICKS / 2);
    expect(control.patch).toBeGreaterThan(2000); // without winter ground the patch takes its share
    expect(winter.patch).toBe(0);
    expect(Math.abs(winter.rest / control.rest - 1)).toBeLessThan(0.05); // about 3000 items each: the count drops by the patch's lost weight only
    const loss = builtMap("winter-test").weights.winterLoss;
    expect(loss).toBeGreaterThan(0.5); // the left half and the patch's feathered edge
    expect(loss).toBeLessThan(0.65);
    // Mid-summer (winterness exactly 0): the very same draws as the map without winter ground.
    const summer = regrowAt("winter-test", 0, 4);
    expect(summer.xs).toEqual(regrowAt("winter-control", 0, 4).xs);
    expect(summer.patch).toBeGreaterThan(500);
  });

  it("refuses a winter share outside 0 to 1", () => {
    for (const v of [-0.1, 1.1, NaN]) expect(() => buildMap(spec("bad", v))).toThrow(new RegExp(`layer "frost": winter ${v} is outside \\[0, 1\\]`));
    expect(() => buildMap(spec("ok", 0.5))).not.toThrow();
  });

  // The clock map's pins live in clockPins.json (maps.test.ts), rewritten whenever its spec changes.
  it("leaves maps without it as they were: no winter grid, the same pins", () => {
    expect(builtMap("clock").weights.winter).toBeNull();
    expect(builtMap("inland-sea").weights.winter).toBeNull();
    expect(builtMap("clock").weights.winterLoss).toBe(0);
    expect(builtHash("inland-sea")).toBe("2b29312d"); // as maps.test.ts pins them
    expect(mapVersion("inland-sea")).toBe("57ab5ef0-2");
    expect(packMap(mapTerrain("clock", MAPS["clock"]!.width, MAPS["clock"]!.height))!.winter).toBeUndefined();
  }, 180_000);

  it("carries the winter grid through the arrays and the prebuilt file, and refuses a file where it is cut short, missing or corrupt", () => {
    const name = "winter-test";
    const b = builtMap(name);
    const parts = packMap(mapTerrain(name, W, H))!;
    expect(parts.winter).toBe(b.weights.winter);
    expect(unpackMap(W, H, parts).weights.winterLoss).toBe(b.weights.winterLoss);
    expect(() => unpackMap(W, H, { ...parts, winter: parts.winter!.subarray(1) })).toThrow(/winter ground does not fit/);
    const bytes = encodeMapAsset(name);
    const a = decodeMapAsset(bytes, name, W, H)!;
    const t = terrainFromAsset(name, W, H, a)!;
    expect(Buffer.from(t.weights!.winter!).equals(Buffer.from(b.weights.winter!))).toBe(true);
    expect(Buffer.from(t.weights!.food).equals(Buffer.from(b.weights.food))).toBe(true);
    expect(decodeMapAsset(bytes.subarray(0, bytes.length - 8), name, W, H)).toBeNull(); // winter section cut short
    const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(6, true);
    const head = new TextDecoder().decode(bytes.subarray(10, 10 + n));
    const size = (JSON.parse(head) as { winter: number }).winter;
    const swap = (to: string): Uint8Array => {
      const h = new TextEncoder().encode(head.replace(`"winter":${size}`, to));
      expect(h.length).toBe(n);
      const c = bytes.slice();
      c.set(h, 10);
      return c;
    };
    expect(decodeMapAsset(swap(`"winter":${size - 1}`.padEnd(`"winter":${size}`.length, " ")), name, W, H)).toBeNull(); // not one byte per node
    expect(decodeMapAsset(swap(`"wintex":${size}`), name, W, H)).toBeNull(); // missing on a map that has winter ground
    expect(decodeMapAsset(swap(`"winter":"${String(size).slice(2)}"`), name, W, H)).toBeNull(); // not a number
  });
});
