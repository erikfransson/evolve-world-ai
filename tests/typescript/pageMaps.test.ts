import "../../src/typescript/src/sim/maps/index.ts";
import { ECO_PRESETS } from "../../src/typescript/src/sim/presets.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { terrainOf } from "../../src/typescript/src/sim/terrain.ts";
import { PageMaps } from "../../src/typescript/src/ui/pageMaps.ts";
import { rockGeometry, useRockGeometry } from "../../src/typescript/src/ui/rockOutline.ts";

const world = ECO_PRESETS.find((p) => p.id === "inland-sea")!.world;
const settings = { seed: 1, world };
const config = { ...DEFAULT_ECO_CONFIG, world: { ...DEFAULT_ECO_CONFIG.world, ...world } };

describe("a named map built once for the Ecosystem page", () => {
  it("reaches a thread that cannot build it, which draws nothing for the map until then", async () => {
    const built = terrainOf(settings);
    useRockGeometry(built, rockGeometry(built));
    const maps = new PageMaps(async () => built);
    const m = (await maps.load("inland-sea", world.width, world.height))!;
    expect(m).not.toBeNull();
    expect(maps.partsOf("inland-sea", world.width, world.height)).toBe(m.parts); // a run starts with these
    expect(maps.partsOf("inland-sea", 1000, 1000)).toBeUndefined();
    expect(maps.partsOf(undefined, world.width, world.height)).toBeUndefined();

    vi.resetModules(); // a render worker: it never imports maps/index.ts, so it could not build the map
    const terrain = await import("../../src/typescript/src/sim/terrain.ts");
    const fresh = await import("../../src/typescript/src/ui/mapReady.ts");
    const idle = await import("../../src/typescript/src/ui/ecoIdle.ts");
    const texts: string[] = [];
    const ctx = new Proxy({}, { get: (_, name) => (name === "fillText" ? (text: string) => texts.push(text) : () => {}), set: () => true }) as unknown as CanvasRenderingContext2D;
    expect(terrain.readyTerrainOf(settings)).toBeNull();
    idle.drawIdleWorld(ctx, config, 800, 600, 1);
    expect(texts).toContain("Building the map");
    fresh.applyMap(m);
    const t = terrain.readyTerrainOf(settings)!;
    expect(t.rockCount).toBe(built.rockCount);
    texts.length = 0;
    idle.drawIdleWorld(ctx, config, 800, 600, 1);
    expect(texts).toContain("Press Start");
  }, 180_000);

  it("gives nothing when the map cannot be built", async () => {
    const maps = new PageMaps(async () => null);
    expect(await maps.load("inland-sea", world.width, world.height)).toBeNull();
    expect(maps.partsOf("inland-sea", world.width, world.height)).toBeUndefined();
  });
});
