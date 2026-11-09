// @vitest-environment node
import { LIMITS, liveConfig } from "../../server/src/config.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { packSave, parseSave } from "../../server/src/saveParse.ts";
import { decodeState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import { packedMap } from "../../src/typescript/src/sim/maps/index.ts";
import { unpackMap, packMap } from "../../src/typescript/src/sim/maps/mapParts.ts";
import { Terrain } from "../../src/typescript/src/sim/terrain.ts";

// The world the Live server runs must pass the restore checks of its own saves (a 60000 wide map once failed "world size is out of bounds").
describe("the Live world's saves", () => {
  const live = new LiveWorld(structuredClone(liveConfig), null);

  it("decode at the configured map size", () => {
    expect(() => decodeState(saveState(live.eco))).not.toThrow();
  }, 60_000);

  it("verify on a save worker that gets the map built", async () => {
    const { gz } = await packSave(live.saveSnapshot(), LIMITS.maxSaveJsonBytes);
    await expect(parseSave(gz, LIMITS.maxSaveJsonBytes, true, live.homeWorld(), 120_000)).resolves.toBeUndefined();
  }, 180_000);

  it("hand the map over unchanged", () => {
    const name = liveConfig.world.map!;
    const { parts } = packedMap(name);
    const { width, height } = liveConfig.world;
    const m = unpackMap(width, height, parts);
    const again = packMap(new Terrain(m.rock, m.ground, width, height, m.weights))!;
    for (const k of ["rock", "ground", "food", "poison", "paint"] as const) expect(again[k]).toEqual(parts[k]);
  }, 90_000);
});
