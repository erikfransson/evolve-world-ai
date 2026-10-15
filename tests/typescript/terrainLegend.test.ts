import { ECO_PRESETS } from "../../src/typescript/src/sim/presets.ts";
import { terrainKinds } from "../../src/typescript/src/ui/terrainLegend.ts";

const world = (id: string) => ECO_PRESETS.find((p) => p.id === id)!.world;

describe("terrain legend rows", () => {
  it("shows rock, mud and firm ground for The Inland Sea although its densities are 0", () => {
    const w = world("inland-sea");
    expect(w.stoneDensity + w.ridgeDensity + w.slowDensity + w.fastDensity).toBe(0);
    expect(terrainKinds(w).slice(0, 3)).toEqual([true, true, true]);
    expect(terrainKinds(w)[3]).toBe(true); // the Ashfall shore is poisoned
    expect(terrainKinds(w)[4]).toBe(true); // the sea is rich in food
  });
  it("follows the densities on the random map", () => {
    expect(terrainKinds(world("crowded"))).toEqual([false, false, false, false, false]);
    expect(terrainKinds(world("highlands")).slice(0, 3)).toEqual([true, true, true]);
  });
});
