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
import { GROUND_PAD as P } from "../../src/typescript/src/sim/groundField.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { mapRegions } from "../../src/typescript/src/live/mapRegions.ts";
import { decodeMapAsset, encodeMapAsset, terrainFromAsset } from "../../src/typescript/src/live/mapAsset.ts";

// A small map, its left half (x < 2000) winter ground with nothing left at mid-winter; the control is the same map without winter ground.
const W = 4000;
const H = 2000;
const patch = { id: "frost", shape: { type: "poly" as const, pts: [[-600, -600], [2000, -600], [2000, 2600], [-600, 2600]] as [number, number][] }, warp: 0, rough: 0, feather: 200 };
const spec = (name: string, winter?: number): MapSpec => ({ name, title: name, seed: 3, width: W, height: H, scale: 1, basePoison: 0, layers: [{ ...patch, ...(winter === undefined ? {} : { winterFood: winter }) }], rock: [] });
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

  // Red without ItemEconomy.season in importCore: a world restored in mid-winter kept winterness 0 until its first regrow, so founder and
  // add spots in that tick took summer weights in the barren ground.
  it("knows its season right after a restore, before the first tick, and then takes no spot in barren ground", () => {
    const config = configOf("winter-test");
    config.eco.initialPopulation = 4;
    const eco = new Ecosystem(config);
    const inner = eco as unknown as { items: World; economy: ItemEconomy };
    expect(inner.items.winterness).toBe(0);
    eco.importCore({ ...eco.exportCore(), tick: YEAR_TICKS / 2 });
    expect(inner.items.winterness).toBeCloseTo(1, 9);
    expect(Array.from({ length: 300 }, () => inner.economy.startOk(500, 1000, 10)).some(Boolean)).toBe(false);
    inner.economy.season(0);
    expect(Array.from({ length: 300 }, () => inner.economy.startOk(500, 1000, 10)).some(Boolean)).toBe(true);
  });

  // Red with the share blended apart from the food (food x share made a ring richer than either side across a feathered edge).
  it("fades monotonically across a feathered edge: the winter food weight (food x share) blends like food", () => {
    const edge: MapSpec = { ...spec("winter-edge"), baseFood: 0.5, layers: [{ ...patch, feather: 1600, food: 2, winterFood: 0.05 }] };
    const w = buildMap(edge).weights;
    const j = Math.round(H / 2 / w.cell) + P; // a row through the middle
    const row = Array.from({ length: w.cols - 2 * P }, (_, i) => w.food[j * w.cols + i + P]! * (w.winter![j * w.cols + i + P]! / 255));
    const across = row.slice(0, Math.round(3200 / w.cell)); // from inside the patch out past its edge at x = 2000
    for (let i = 1; i < across.length; i++) expect(across[i]!).toBeGreaterThanOrEqual(across[i - 1]! - 0.6); // rounding of two bytes
    expect(across[0]!).toBeCloseTo(2 * 64 * 0.05, 0); // inside: 5% of its food
    expect(across.at(-1)!).toBeCloseTo(0.5 * 64, 0); // outside: all of its food
  });

  it("weights the winter loss by food and leaves out ground under rock", () => {
    const rich: MapSpec = { ...spec("winter-rich"), baseFood: 1, layers: [{ ...patch, feather: 0, food: 3, winterFood: 0 }] };
    const rw = buildMap(rich).weights;
    let inPatch = 0, open = 0; // the patch's share of the area, by its winter nodes
    for (let j = P; j < rw.rows - P; j++) for (let i = P; i < rw.cols - P; i++) if ((i - P) * rw.cell < W && (j - P) * rw.cell < H) { open++; if (rw.winter![j * rw.cols + i] === 0) inPatch++; }
    const A = inPatch / open;
    expect(A).toBeGreaterThan(0.3);
    expect(rw.winterLoss).toBeCloseTo((3 * A) / (3 * A + (1 - A)), 2); // weighted by food: the patch at three times the food counts three times, not as its area A
    const rocky: MapSpec = { ...rich, name: "winter-rocky", rock: [{ id: "slab", kind: "massif", cover: 1, shape: { type: "poly", pts: [[300, 300], [1700, 300], [1700, 1700], [300, 1700]] }, warp: 0, rough: 0, feather: 100 }] };
    const b = buildMap(rocky);
    const wt = b.weights;
    let all = 0, lost = 0; // the loss counted here independently: open nodes only
    for (let j = P; j < wt.rows - P; j++) for (let i = P; i < wt.cols - P; i++) {
      const x = (i - P) * wt.cell, y = (j - P) * wt.cell;
      if (x >= W || y >= H || b.rock.some((d) => Math.hypot(x - d.x, y - d.y) < d.r)) continue;
      const n = j * wt.cols + i;
      all += wt.food[n]!;
      lost += wt.food[n]! * (1 - wt.winter![n]! / 255);
    }
    expect(b.rock.length).toBeGreaterThan(10);
    expect(wt.winterLoss).toBeCloseTo(lost / all, 9);
    expect(wt.winterLoss).toBeLessThan(buildMap(rich).weights.winterLoss - 0.05); // the slab covers much of the patch
  });

  it("takes the share between the season's ends, and a later layer without the field keeps the share below it", () => {
    const half: MapSpec = { ...spec("winter-half"), baseFood: 1, layers: [{ ...patch, feather: 0, winterFood: 0.5 }, { id: "later", shape: { type: "poly", pts: [[1000, -600], [4600, -600], [4600, 2600], [1000, 2600]] }, warp: 0, rough: 0, feather: 0, food: 2 }] };
    const w = buildMap(half).weights;
    const node = (x: number, y: number) => (Math.round(y / w.cell) + P) * w.cols + Math.round(x / w.cell) + P;
    expect(w.winter![node(500, 1000)]).toBe(128); // the winter layer alone: half
    expect(w.winter![node(1500, 1000)]).toBe(128); // the later food layer over it keeps that half
    expect(w.winter![node(3500, 1000)]).toBe(255); // the later layer alone: no winter ground
    // winterness 0.5 and share 0.5: accepted at 1 - 0.5 x 0.5 = 0.75 of the weight, by an even sweep of draws
    const N = 4000;
    let k = 0;
    const sweep = { next: () => (k++ + 0.5) / N } as unknown as Parameters<typeof w.accepts>[3];
    let yes = 0;
    for (let i = 0; i < N; i++) if (w.accepts(0, 500, 1000, sweep, 0.5)) yes++;
    expect(Math.abs(yes / N - (0.75 * w.food[node(500, 1000)]!) / w.maxFood)).toBeLessThanOrEqual(3 / N);
  });

  // Red with the share taken as 1 wherever food is 0: a food-0 layer inside winter ground, then a food layer on top, grew summer food in winter.
  it("keeps the share through ground without food, so a food layer laid over it later is still winter ground", () => {
    const whole = { type: "poly" as const, pts: [[-600, -600], [W + 600, -600], [W + 600, H + 600], [-600, H + 600]] as [number, number][] };
    const holed: MapSpec = { ...spec("winter-holed"), baseFood: 1, layers: [{ ...patch, feather: 0, winterFood: 0.05 }, { id: "bare", shape: whole, warp: 0, rough: 0, feather: 0, food: 0 }, { id: "regrown", shape: whole, warp: 0, rough: 0, feather: 0, food: 2 }] };
    const w = buildMap(holed).weights;
    const node = (x: number, y: number) => (Math.round(y / w.cell) + P) * w.cols + Math.round(x / w.cell) + P;
    expect(w.winter![node(500, 1000)]).toBe(Math.round(0.05 * 255)); // the patch: still 5% at mid-winter
    expect(w.winter![node(3500, 1000)]).toBe(255); // outside it
  });

  it("refuses a winter share outside 0 to 1", () => {
    for (const v of [-0.1, 1.1, NaN]) expect(() => buildMap(spec("bad", v))).toThrow(new RegExp(`layer "frost": winterFood ${v} is outside \\[0, 1\\]`));
    expect(() => buildMap(spec("ok", 0.5))).not.toThrow();
  });

  // The clock map's pins live in clockPins.json (maps.test.ts), rewritten whenever its spec changes.
  it("leaves maps without it as they were (no winter grid, the same pins) and gives the Six Realms hub its grid", () => {
    expect(builtMap("inland-sea").weights.winter).toBeNull();
    expect(builtMap("inland-sea").weights.winterLoss).toBe(0);
    // The Six Realms hub is winter ground (0.05): about 15% of the open food weight fades at mid-winter (0.1518). A number stored when the map is
    // made once when a world's ItemEconomy is built (not in a tick), which regrow only reads.
    expect(builtMap("clock").weights.winter).not.toBeNull();
    expect(builtMap("clock").weights.winterLoss).toBeCloseTo(0.1518, 3);
    expect(builtHash("inland-sea")).toBe("2b29312d"); // as maps.test.ts pins them
    expect(mapVersion("inland-sea")).toBe("57ab5ef0-2");
    expect(packMap(mapTerrain("inland-sea", MAPS["inland-sea"]!.width, MAPS["inland-sea"]!.height))!.winter).toBeUndefined();
    expect(packMap(mapTerrain("clock", MAPS["clock"]!.width, MAPS["clock"]!.height))!.winter).toBeDefined();
    // The region table (server text, no wire change) says so for the Commons only.
    const rows = mapRegions("clock");
    expect(rows.filter((r) => r.role.endsWith("bare in winter")).map((r) => r.name)).toEqual([rows.find((r) => /commons/i.test(r.name))!.name]);
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
    const size = (JSON.parse(head) as { winterFood: number }).winterFood;
    const swap = (to: string): Uint8Array => {
      const h = new TextEncoder().encode(head.replace(`"winterFood":${size}`, to));
      expect(h.length).toBe(n);
      const c = bytes.slice();
      c.set(h, 10);
      return c;
    };
    expect(decodeMapAsset(swap(`"winterFood":${size - 1}`.padEnd(`"winterFood":${size}`.length, " ")), name, W, H)).toBeNull(); // not one byte per node
    expect(decodeMapAsset(swap(`"winterFoox":${size}`), name, W, H)).toBeNull(); // missing on a map that has winter ground
    expect(decodeMapAsset(swap(`"winterFood":"${String(size).slice(2)}"`), name, W, H)).toBeNull(); // not a number
    // A winter section and header key on a map without winter ground: refused, though every size fits.
    const plain = encodeMapAsset("winter-control");
    const pn = new DataView(plain.buffer, plain.byteOffset).getUint32(6, true);
    const ph = JSON.parse(new TextDecoder().decode(plain.subarray(10, 10 + pn))) as { sizes: number[] };
    const food = ph.sizes[2]!;
    const head2 = new TextEncoder().encode(JSON.stringify({ ...ph, winterFood: food }));
    const pad8 = (v: number) => Math.ceil(v / 8) * 8;
    const start = pad8(10 + pn), start2 = pad8(10 + head2.length);
    const forged = new Uint8Array(start2 + (plain.length - start) + pad8(food));
    forged.set(plain.subarray(0, 6), 0);
    new DataView(forged.buffer).setUint32(6, head2.length, true);
    forged.set(head2, 10);
    forged.set(plain.subarray(start), start2);
    expect(decodeMapAsset(plain, "winter-control", W, H)).not.toBeNull();
    expect(decodeMapAsset(forged, "winter-control", W, H)).toBeNull();
  });
});
