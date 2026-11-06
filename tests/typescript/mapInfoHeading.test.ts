// @vitest-environment happy-dom
import { renderMapInfo } from "../../src/typescript/src/live/mapInfo.ts";
import type { Hello } from "../../src/typescript/src/live/protocol.ts";

describe("renderMapInfo", () => {
  it("hides the Regions heading while every region row is still hidden", () => {
    document.body.innerHTML = '<div id="info"><ul id="infoLegend"></ul><p id="infoLegendNote"></p><div id="infoShares"></div><div id="infoBar"></div><div id="infoRegions"></div><dl id="infoWorld"></dl></div>';
    const hello = {
      world: { width: 100, height: 100 },
      summary: { initialPopulation: 1, maxPopulation: 2, collisionDamage: false, seasons: false },
      map: { ground: { normal: 1, mud: 0, firm: 0, rock: 0 }, regions: [] },
    } as unknown as Hello;
    renderMapInfo(document.getElementById("info")!, hello);
    const heads = [...document.querySelectorAll<HTMLElement>("#infoLegend .lg-head")];
    expect(heads.map((h) => h.textContent)).toContain("Regions");
    expect(heads.find((h) => h.textContent === "Regions")!.hidden).toBe(true);
    expect(heads.find((h) => h.textContent === "Creatures")!.hidden).toBe(false);
  });
});
