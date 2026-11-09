// @vitest-environment node
import { fileURLToPath } from "node:url";
import { liveConfig } from "../../server/src/config.ts";
import { loadFounders } from "../../server/src/founders.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { mapSpec } from "../../src/typescript/src/sim/maps/index.ts";
import { smallConfig } from "./liveHelpers.ts";

const FOUNDERS = fileURLToPath(new URL("../../src/typescript/public/live-founders.json", import.meta.url));
const seq = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
};

describe("seeding by region", () => {
  const spec = mapSpec("clock")!;
  const homes = spec.regions!.filter((g) => g.id !== "commons");
  const clockWorld = (): LiveWorld => {
    const c = smallConfig();
    c.world.map = "clock";
    c.world.width = spec.width;
    c.world.height = spec.height;
    c.eco.initialPopulation = 0;
    c.eco.foodMaxDensity = 1.0;
    return new LiveWorld(c, null);
  };

  it("puts each home's copies of its founder inside 0.6 of the home's radius, none in the hub", () => {
    const founders = loadFounders(FOUNDERS).slice(0, 2);
    const live = clockWorld();
    expect(live.seedFounders(founders, seq(5), 3)).toBe(homes.length * 3);
    const ms = live.eco.members;
    expect(ms.length).toBe(homes.length * 3);
    for (const g of homes) {
      const here = ms.filter((m) => Math.hypot(m.creature.state.x - g.x, m.creature.state.y - g.y) <= 0.6 * g.r);
      expect(here.length).toBe(3);
    }
  });

  const atHome = (live: LiveWorld, g: { x: number; y: number; r: number }) => live.eco.members.filter((m) => Math.hypot(m.creature.state.x - g.x, m.creature.state.y - g.y) <= 0.6 * g.r);

  it("gives home h founder h % F", () => {
    const founders = loadFounders(FOUNDERS).slice(0, 2);
    const live = clockWorld();
    live.seedFounders(founders, seq(5), 1);
    const ids = homes.map((g) => atHome(live, g).map((m) => live.eco.lineageName(m.founderId)));
    expect(ids.every((a) => a.length === 1)).toBe(true);
    expect(new Set(ids.flat()).size).toBe(2); // two founders alternate over the homes
    ids.forEach((a, h) => expect(a[0]).toBe(ids[h % 2]![0]));
  });

  it("gives every creature of a home the region's hue when the map sets one", () => {
    expect(homes.every((g) => typeof g.hue === "number")).toBe(true);
    const live = clockWorld();
    live.seedFounders(loadFounders(FOUNDERS), seq(5), 3);
    for (const g of homes) {
      const here = atHome(live, g);
      expect(here.length).toBe(3);
      for (const m of here) expect(m.hue).toBeCloseTo(g.hue!, 6);
    }
  });

  it("refuses more founders than homes, and counts seed groups by homes", () => {
    const fs = loadFounders(FOUNDERS);
    const live = clockWorld();
    expect(live.seedGroups(2)).toBe(homes.length);
    expect(() => live.seedFounders([...fs, fs[0]!], seq(5), 1)).toThrow(/home regions/);
    expect(live.eco.population).toBe(0);
  });

  it("ships no more founders than the Live map has homes", () => {
    const live = mapSpec(liveConfig.world.map!)!.regions!.filter((g) => g.id !== "commons");
    expect(loadFounders(FOUNDERS).length).toBeLessThanOrEqual(live.length);
  });

  it("leaves a map without regions seeding anywhere as before", () => {
    expect(mapSpec("inland-sea")!.regions).toBeUndefined();
    const cfg = structuredClone(liveConfig);
    Object.assign(cfg.world, { map: "inland-sea", width: 50000, height: 31250 });
    const live = new LiveWorld(cfg, null);
    expect(live.seedFounders(loadFounders(FOUNDERS), seq(4), 2)).toBe(loadFounders(FOUNDERS).length * 2);
  });
});
