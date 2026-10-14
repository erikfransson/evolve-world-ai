import { mapPartsOf, seedMapTerrain, terrainOf } from "../../src/typescript/src/sim/terrain.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { ECO_PRESETS } from "../../src/typescript/src/sim/presets.ts";

const world = ECO_PRESETS.find((p) => p.id === "inland-sea")!.world;
const settings = { seed: 1, world };

describe("seeding a map into another thread", () => {
  it("rebuilds the same terrain from the arrays, without building the map", async () => {
    const built = terrainOf(settings);
    const parts = mapPartsOf(settings)!;
    expect(parts.rock.length).toBe(3 * built.rockCount);
    vi.resetModules(); // a fresh module state, as in a helper thread, where building the map is an error
    vi.doMock("../../src/typescript/src/sim/maps/index.ts", async (orig) => ({ ...(await orig<object>()), builtMap: () => { throw new Error("built the map"); } }));
    const fresh = await import("../../src/typescript/src/sim/terrain.ts");
    fresh.seedMapTerrain("inland-sea", world.width, world.height, parts);
    const t = fresh.terrainOf(settings);
    vi.doUnmock("../../src/typescript/src/sim/maps/index.ts");
    expect(Array.from(t.rockX)).toEqual(Array.from(built.rockX));
    expect(Array.from(t.rockR)).toEqual(Array.from(built.rockR));
    expect(t.ground!.data).toEqual(built.ground!.data);
    expect({ ...t.weights }).toEqual({ ...built.weights }); // every MapWeights field
  }, 180_000);
  it("refuses arrays that do not fit, and has none for the random map", () => {
    const parts = mapPartsOf(settings)!;
    expect(() => seedMapTerrain("inland-sea", world.width, world.height, { ...parts, food: new Uint8Array(3) })).toThrow();
    expect(() => seedMapTerrain("nope", 10, 10, parts)).toThrow();
    expect(mapPartsOf({ seed: 1, world: DEFAULT_ECO_CONFIG.world })).toBeNull();
  }, 180_000);
  it("a helper's init with the map seeds its terrain and never builds the map", async () => {
    const parts = mapPartsOf(settings)!;
    vi.resetModules();
    vi.doMock("../../src/typescript/src/sim/maps/index.ts", async (orig) => ({ ...(await orig<object>()), builtMap: () => { throw new Error("built the map"); } }));
    const pool = await import("../../src/typescript/src/worker/ecoPool.ts");
    const fresh = await import("../../src/typescript/src/sim/terrain.ts");
    const replies: unknown[] = [];
    const handle = pool.serveHelper((m) => replies.push(m));
    const config = { ...DEFAULT_ECO_CONFIG, world: { ...DEFAULT_ECO_CONFIG.world, ...world } };
    handle({ type: "init", gen: 1, config, worldCapacity: 100, index: 0, wasm: false, map: parts });
    vi.doUnmock("../../src/typescript/src/sim/maps/index.ts");
    expect(replies).toEqual([{ type: "ready", gen: 1 }]);
    expect(fresh.terrainOf(config).rockCount).toBe(parts.rock.length / 3);
  }, 180_000);
});
