// @vitest-environment happy-dom
import { Terrain } from "../../src/typescript/src/sim/terrain.ts";
import { paintTerrainLegend, terrainLegendHtml } from "../../src/typescript/src/ui/terrainLegend.ts";

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
