// @vitest-environment happy-dom
import { ECO_PRESETS } from "../../src/typescript/src/sim/presets.ts";
import { Terrain } from "../../src/typescript/src/sim/terrain.ts";
import { paintTerrainLegend, syncTerrainLegend, terrainKinds, terrainLegendHtml } from "../../src/typescript/src/ui/terrainLegend.ts";

const world = (id: string) => ECO_PRESETS.find((p) => p.id === id)!.world;

describe("terrain legend rows", () => {
  it("shows rock, mud and firm ground for The Inland Sea although its densities are 0", () => {
    const w = world("inland-sea");
    expect(w.stoneDensity + w.ridgeDensity + w.slowDensity + w.fastDensity).toBe(0);
    expect(terrainKinds(w).slice(0, 3)).toEqual([true, true, true]);
    expect(terrainKinds(w)[3]).toBe(true); // the Ashfall shore is poisoned
    expect(terrainKinds(w)[4]).toBe(true); // the sea is rich in food
    expect(terrainKinds(w)[5]).toBe(false); // no winter ground
  });
  it("shows winter ground only for a map that has it (the Six Realms hub)", () => {
    expect(terrainKinds({ stoneDensity: 0, ridgeDensity: 0, slowDensity: 0, fastDensity: 0, map: "clock" })[5]).toBe(true);
  });
  it("shows the winter ground row only with seasons on", () => {
    document.body.innerHTML = `<ul>${terrainLegendHtml()}</ul>`;
    const world = { stoneDensity: 0, ridgeDensity: 0, slowDensity: 0, fastDensity: 0, map: "clock" } as Parameters<typeof syncTerrainLegend>[0]["world"];
    const row = () => document.getElementById("legendWinter")!;
    syncTerrainLegend({ world, eco: { seasons: true } });
    expect(row().hidden).toBe(false);
    syncTerrainLegend({ world, eco: { seasons: false } });
    expect(row().hidden).toBe(true);
    syncTerrainLegend({ world });
    expect(row().hidden).toBe(true);
    syncTerrainLegend({ world: { ...world, map: "inland-sea" }, eco: { seasons: true } });
    expect(row().hidden).toBe(true);
  });
  it("follows the densities on the random map", () => {
    expect(terrainKinds(world("crowded"))).toEqual([false, false, false, false, false, false]);
    expect(terrainKinds(world("highlands")).slice(0, 3)).toEqual([true, true, true]);
  });
});

describe("terrain legend swatches", () => {
  it("puts a swatch cut from the world in a row, and the drawn icon back for a world without that kind", () => {
    document.body.innerHTML = `<ul>${terrainLegendHtml()}</ul>`;
    const tile = () => document.querySelector("#legendRock .lg-tile")!;
    expect(tile().querySelector("svg")).not.toBeNull();
    paintTerrainLegend(new Terrain([{ x: 500, y: 300, r: 60 }], null, 1000, 600));
    expect(tile().querySelector("canvas")).not.toBeNull(); // the world's own rock
    paintTerrainLegend(new Terrain([], null, 1000, 600));
    expect(tile().querySelector("canvas")).toBeNull(); // no rock in this world: not the last world's swatch
    expect(tile().querySelector("svg")).not.toBeNull();
  });
});
