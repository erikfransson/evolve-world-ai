// @vitest-environment node
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCarry, carryFounder, oldestInWorld, CARRY_FILE } from "../../server/src/carry.ts";
import type { CarryOrder } from "../../server/src/carry.ts";
import { mostCopies, seedRoom } from "../../server/src/config.ts";
import { loadFounders } from "../../server/src/founders.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { Saves, copiesProblem, openWorld } from "../../server/src/saves.ts";
import { StateStore } from "../../server/src/state.ts";
import { mapSpec } from "../../src/typescript/src/sim/maps/index.ts";
import { smallConfig } from "./liveHelpers.ts";

const FOUNDERS = loadFounders(new URL("../../src/typescript/public/live-founders.json", import.meta.url).pathname);
const spec = mapSpec("clock")!;
const homes = spec.regions!.filter((g) => g.id !== "commons");
const H = homes.length;
const seq = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
};
const quiet = (): void => {};
const clockWorld = (): LiveWorld => {
  const c = smallConfig();
  c.world.map = "clock";
  c.world.width = spec.width;
  c.world.height = spec.height;
  c.eco.initialPopulation = 0;
  return new LiveWorld(c, null);
};
const tmp = (): string => mkdtempSync(join(tmpdir(), "evolve-region-reset-"));
// A valid carry order: the oldest creature of a small seeded world, as the admin reset takes it.
const source = ((): unknown => {
  const c = smallConfig();
  c.eco.initialPopulation = 0;
  const w = new LiveWorld(c, null);
  w.seedFounders(FOUNDERS, seq(3), 2);
  for (let i = 0; i < 5; i++) w.eco.step();
  return JSON.parse(JSON.stringify(oldestInWorld(w.eco)));
})();
const oneCarry = (live: LiveWorld, copies: number, room: number): CarryOrder | string => checkCarry({ version: 1, name: "Ancient", copies, creature: source }, live.addRules(), room);

describe("clock reset bounds count home regions", () => {
  const live = clockWorld();
  const eco = live.freshEco;
  const most = Math.floor(seedRoom(eco) / H);

  it("allows floor(room/homes) copies, refuses one more, and names the groups, whatever the founder count", () => {
    expect(live.seedGroups(H)).toBe(H);
    expect(live.seedGroups(3)).toBe(H);
    expect(mostCopies(H, eco)).toBe(most);
    expect(copiesProblem(most, live.seedGroups(H), eco)).toBeNull();
    for (const f of [H, 3, 1]) {
      const bad = copiesProblem(most + 1, live.seedGroups(f), eco)!;
      expect(bad).toContain(`from 1 to ${most} (${H} founder groups`);
    }
  });

  it("Saves.reset takes the bound with 6 founders, refuses one more, and divides by 6 for a 3-founder file", async () => {
    const dir = tmp();
    const saves = new Saves(live, new StateStore(dir));
    await expect(saves.reset(most + 1, H)).rejects.toThrow(`copies must be a whole number from 1 to ${most} (${H} founder groups`);
    await expect(saves.reset(most + 1, 3)).rejects.toThrow(`copies must be a whole number from 1 to ${most} (${H} founder groups`);
    await expect(saves.reset(0, 3)).rejects.toThrow(/whole number from 1/);
    await expect(saves.reset(most, 3, new Date("2026-11-09T08:00:00.000Z"))).resolves.toMatch(/each founder/);
  });

  it("Saves.reset refuses a carry that does not fit beside the home founders", async () => {
    const dir = tmp();
    const saves = new Saves(live, new StateStore(dir));
    const room = seedRoom(eco) - most * H;
    const o = oneCarry(live, room + 1, 1000) as CarryOrder;
    expect(typeof o).toBe("object");
    await expect(saves.reset(most, H, new Date(), o)).rejects.toThrow(`${room + 1} carried copies do not fit: ${room} places are left`);
  });
});

describe("a fresh clock world at the copies bound with a carry", () => {
  it("seeds 6*copies + carry creatures and keeps the carried ones 3 radii clear of every home founder", () => {
    const live = clockWorld();
    const copies = Math.floor(seedRoom(live.freshEco) / H);
    const extra = Math.min(40, seedRoom(live.freshEco) - copies * H);
    expect(extra).toBeGreaterThan(0);
    const carried = carryFounder(oneCarry(live, extra, 1000) as CarryOrder);
    const n = live.seedFounders(FOUNDERS, seq(7), copies, { founder: carried, copies: extra });
    expect(n).toBe(H * copies + extra);
    const ms = live.eco.members;
    expect(ms.length).toBe(n);
    const r = live.config.creature.radius;
    const isCarry = (m: (typeof ms)[number]): boolean => live.eco.lineageName(m.founderId).endsWith("Ancient");
    const mine = ms.filter(isCarry), rest = ms.filter((m) => !isCarry(m));
    expect(mine.length).toBe(extra);
    for (const c of mine) for (const o of rest) expect(Math.hypot(c.creature.state.x - o.creature.state.x, c.creature.state.y - o.creature.state.y)).toBeGreaterThanOrEqual(3 * r);
  }, 120_000);
});

describe("openWorld on clock", () => {
  it("reads the seed file's copies against 6 homes and seeds 6*copies plus the carry", async () => {
    const dir = tmp();
    const live = clockWorld();
    const store = new StateStore(dir);
    writeFileSync(join(dir, "seed-copies"), "4\n");
    const probe = store.seedCopies();
    const o = oneCarry(live, 5, 1000) as CarryOrder;
    writeFileSync(join(dir, CARRY_FILE), JSON.stringify(o));
    const lines: string[] = [];
    await openWorld(new Saves(live, store), live, dir, FOUNDERS.slice(0, 3), (l) => lines.push(l));
    expect(probe).toBe(4);
    expect(live.seedCopies).toBe(4);
    expect(live.eco.population).toBe(H * 4 + 5);
    expect(lines.join("\n")).toMatch(/carried/);
  }, 60_000);

  it("refuses a carry that does not fit beside 6 homes' founders, by the carry check and not by a failed seeding", async () => {
    const dir = tmp();
    const live = clockWorld();
    const most = Math.floor(seedRoom(live.freshEco) / H);
    const room = seedRoom(live.freshEco) - most * H;
    writeFileSync(join(dir, "seed-copies"), `${most}\n`);
    writeFileSync(join(dir, CARRY_FILE), JSON.stringify(oneCarry(live, room + 1, 1000)));
    const lines: string[] = [];
    await openWorld(new Saves(live, new StateStore(dir)), live, dir, FOUNDERS.slice(0, 3), (l) => lines.push(l));
    expect(lines.join("\n")).toMatch(new RegExp(`${CARRY_FILE} refused, nothing carried: .*${room}`));
    expect(lines.join("\n")).not.toMatch(/seeding with it failed/);
    expect(live.eco.population).toBe(most * H);
  }, 120_000);

  it("ignores a seed file over the 6-home bound", async () => {
    const dir = tmp();
    const live = clockWorld();
    const most = Math.floor(seedRoom(live.freshEco) / H);
    writeFileSync(join(dir, "seed-copies"), `${most + 1}\n`);
    const lines: string[] = [];
    live.founders = FOUNDERS.slice(0, 3);
    await openWorld(new Saves(live, new StateStore(dir)), live, dir, FOUNDERS.slice(0, 3), (l) => lines.push(l));
    expect(lines.join("\n")).toMatch(/ignored: copies must be a whole number from 1 to/);
  }, 60_000);
});
