// @vitest-environment happy-dom
import { cleanMap, renderMapInfo } from "../../src/typescript/src/live/mapInfo.ts";
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

  it("lists winter ground only for a map whose spec has it, with seasons on", () => {
    const html = '<div id="info"><ul id="infoLegend"></ul><p id="infoLegendNote"></p><div id="infoShares"></div><div id="infoBar"></div><div id="infoRegions"></div><dl id="infoWorld"></dl></div>';
    const hello = (name?: string, seasons = true) => ({ world: { width: 100, height: 100 }, summary: { initialPopulation: 1, maxPopulation: 2, collisionDamage: false, seasons }, map: { ...(name ? { name } : {}), ground: { normal: 1, mud: 0, firm: 0, rock: 0 }, regions: [] } }) as unknown as Hello;
    const rows = (h: Hello) => {
      document.body.innerHTML = html;
      renderMapInfo(document.getElementById("info")!, h);
      return [...document.querySelectorAll<HTMLElement>("#infoLegend .lg-row b")].map((b) => b.textContent);
    };
    expect(rows(hello("clock"))).toContain("Winter ground");
    expect(rows(hello("inland-sea"))).not.toContain("Winter ground");
    expect(rows(hello())).not.toContain("Winter ground");
    expect(rows(hello("clock", false))).not.toContain("Winter ground"); // the hub grows all year with seasons off
  });

  it("names the regions that are winter ground in its note, flagged by the server and cleaned as a plain true", () => {
    document.body.innerHTML = '<div id="info"><ul id="infoLegend"></ul><p id="infoLegendNote"></p><div id="infoShares"></div><div id="infoBar"></div><div id="infoRegions"></div><dl id="infoWorld"></dl></div>';
    const region = (name: string, winter: unknown) => ({ name, food: 1, poison: 0, ground: "plain", role: "moderate", winter });
    const map = cleanMap({ name: "clock", ground: { normal: 1, mud: 0, firm: 0, rock: 0 }, regions: [region("The Commons", true), region("The Mire", "yes"), region("The Flats", 1)] });
    expect(map.regions.map((r) => r.winter)).toEqual([true, undefined, undefined]);
    const hello = { world: { width: 100, height: 100 }, summary: { initialPopulation: 1, maxPopulation: 2, collisionDamage: false, seasons: true }, map } as unknown as Hello;
    renderMapInfo(document.getElementById("info")!, hello);
    const row = [...document.querySelectorAll<HTMLElement>("#infoLegend .lg-row")].find((li) => li.querySelector("b")!.textContent === "Winter ground")!;
    expect(row.textContent).toContain("the Commons: almost no food grows here in winter");
  });
});
