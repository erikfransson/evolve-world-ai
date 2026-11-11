// @vitest-environment node
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCarry, carryFounder, oldestInWorld, CARRY_FILE } from "../../server/src/carry.ts";
import type { CarryOrder } from "../../server/src/carry.ts";
import { SEED_COPIES, mostCopies, seedRoom } from "../../server/src/config.ts";
import { loadFounders } from "../../server/src/founders.ts";
import { LiveWorld, NoRoom } from "../../server/src/liveWorld.ts";
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
// cap: the population cap the world starts from; 5000 (the cap before 12000) where a test needs the copies bound to fit the home discs.
const clockWorld = (cap?: number): LiveWorld => {
  const c = smallConfig();
  c.world.map = "clock";
  c.world.width = spec.width;
  c.world.height = spec.height;
  c.eco.initialPopulation = 0;
  if (cap) c.eco.maxPopulation = cap;
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
  const live = clockWorld(5000);
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
    const live = clockWorld(5000);
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
    const live = clockWorld(5000);
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

// At a raised cap of 18000 the copies bound (2983 a home) passes what the smallest home disc holds (about 2200 to 2400 spots, rock in them).
// At the 12000 cap (1983 a home) every Six Realms home fits, so this path needs the higher cap.
const BIG_CAP = 18000;
describe("a clock seed at a raised cap that does not fit", () => {
  const live = clockWorld(BIG_CAP);
  const most = Math.floor(seedRoom(live.freshEco) / H);

  // Red without the check in Saves.reset: the count was written, and every next start failed with "no room to seed the founders".
  it("is refused cleanly by the seed, the fit check and a reset, in bounded time, moving nothing", async () => {
    expect(most).toBe(2983);
    let t = performance.now();
    expect(() => live.seedFounders(FOUNDERS, seq(5), most)).toThrow(NoRoom);
    expect(performance.now() - t).toBeLessThan(15_000); // about 1 s on a quiet host
    expect(live.eco.population).toBe(0);
    expect(live.seedFits(H, most, 0, seq(5))).toBe(false);
    expect(live.seedFits(H, 800, 0, seq(5))).toBe(true);
    const dir = tmp();
    const store = new StateStore(dir);
    const saves = new Saves(live, store);
    live.founders = FOUNDERS;
    t = performance.now();
    await expect(saves.reset(most, H)).rejects.toThrow(`${most} of each founder do not fit in the home regions`);
    expect(performance.now() - t).toBeLessThan(15_000);
    expect(readdirSync(dir).some((f) => f.startsWith("before-reset-"))).toBe(false);
    expect(store.seedCopies()).toBeNull();
  }, 120_000);

  // Red without the cut in openWorld: a seed file the map has no room for made every start throw (systemd restarts it in a loop).
  it("seeds the default count at a fresh start when the seed file's count has no room", async () => {
    const dir = tmp();
    const fresh = clockWorld(BIG_CAP);
    writeFileSync(join(dir, "seed-copies"), `${most}\n`);
    const lines: string[] = [];
    await openWorld(new Saves(fresh, new StateStore(dir)), fresh, dir, FOUNDERS, (l) => lines.push(l));
    expect(lines.join("\n")).toMatch(new RegExp(`SEED CUT: no room for ${most}`));
    expect(fresh.seedCopies).toBe(SEED_COPIES);
    expect(fresh.eco.population).toBe(H * SEED_COPIES);
  }, 120_000);
});
