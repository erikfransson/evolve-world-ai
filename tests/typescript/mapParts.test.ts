import { MAPS } from "../../src/typescript/src/sim/maps/index.ts";
import { buildMap } from "../../src/typescript/src/sim/maps/mapBuild.ts";
import type { MapSpec } from "../../src/typescript/src/sim/maps/mapBuild.ts";
import { MAX_MAP_DISCS, packMap, unpackMap } from "../../src/typescript/src/sim/maps/mapParts.ts";
import { Terrain } from "../../src/typescript/src/sim/terrain.ts";

const SEA = MAPS["inland-sea"]!;
const small: MapSpec = { ...SEA, width: 12000, height: 8000, layers: SEA.layers.slice(0, 2), rock: SEA.rock.slice(0, 1) };

describe("the map codec", () => {
  const b = buildMap(small);
  const t = new Terrain(b.rock, b.ground, small.width, small.height, b.weights);

  it("gives a map back from its arrays", () => {
    const parts = packMap(t)!;
    expect(parts.rock.length).toBe(3 * b.rock.length);
    expect(parts.ground).toBe(b.ground.data);
    const m = unpackMap(small.width, small.height, parts);
    expect(m.rock).toEqual(b.rock);
    expect(m.ground.data).toEqual(b.ground.data);
    expect(m.weights.food).toEqual(b.weights.food);
    expect(m.weights.poison).toEqual(b.weights.poison);
  }, 60_000);

  it("has no parts for the random map", () => {
    expect(packMap(new Terrain([], null, 1000, 1000))).toBeNull();
  });

  it("refuses arrays that do not fit the world, are not typed arrays or hold rock that is not finite", () => {
    const parts = packMap(t)!;
    const bad = (change: object): void => expect(() => unpackMap(small.width, small.height, { ...parts, ...change })).toThrow();
    bad({ ground: parts.ground.subarray(1) });
    bad({ food: new Uint8Array(3) });
    bad({ poison: parts.poison.subarray(1) });
    bad({ rock: parts.rock.subarray(1) });
    bad({ rock: Float64Array.from([1, NaN, 3]) });
    bad({ rock: new Float64Array(3 * (MAX_MAP_DISCS + 1)) });
    bad({ food: Array.from(parts.food) });
    expect(() => unpackMap(small.width + 1000, small.height, parts)).toThrow();
  });
});
