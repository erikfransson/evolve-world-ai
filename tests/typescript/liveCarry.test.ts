// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryAsk } from "../../server/src/admin.ts";
import { CARRY_FILE, MAX_CARRY, MAX_CARRY_FILE_BYTES, NEXT_CARRY, REFUSED_CARRY, USED_CARRY, checkCarry, oldestInState, oldestInWorld } from "../../server/src/carry.ts";
import { MAX_ADD_GENOME } from "../../src/typescript/src/live/add.ts";
import { PLAN_LIMITS } from "../../src/typescript/src/sim/rl/validate.ts";
import { SCALARS } from "../../src/typescript/src/sim/ecoState.ts";
import type { CarryOrder } from "../../server/src/carry.ts";
import { loadFounders } from "../../server/src/founders.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { Saves, openWorld } from "../../server/src/saves.ts";
import { StateStore } from "../../server/src/state.ts";
import { STARTER_MARK } from "../../src/typescript/src/live/add.ts";

import { smallConfig } from "./liveHelpers.ts";

const FOUNDERS = loadFounders(new URL("../../src/typescript/public/live-founders.json", import.meta.url).pathname);
const tmp = (): string => mkdtempSync(join(tmpdir(), "evolve-carry-"));
const quiet = (): void => {};
const freshConfig = () => {
  const c = smallConfig();
  c.eco.initialPopulation = 0;
  return c;
};

// A running world of seeded founders that has aged a little, its oldest creature a few ticks older than the rest.
function aged(): LiveWorld {
  const live = new LiveWorld(freshConfig(), null);
  live.seedFounders(FOUNDERS, Math.random, 3);
  for (let i = 0; i < 20; i++) live.eco.step();
  return live;
}
const order = (live: LiveWorld, change: (o: Record<string, unknown>) => void = () => {}): unknown => {
  const o = JSON.parse(JSON.stringify({ version: 1, name: "Ancient", copies: 5, creature: oldestInWorld(live.eco) })) as Record<string, unknown>;
  change(o);
  return o;
};

describe("the creature a reset carries", () => {
  it("is the oldest living creature, the same from the running world and from its save", () => {
    const live = aged();
    const oldest = live.eco.members.reduce((a, b) => (b.ageTicks > a.ageTicks || (b.ageTicks === a.ageTicks && b.id < a.id) ? b : a));
    const w = oldestInWorld(live.eco)!;
    expect(w.id).toBe(oldest.id);
    expect(w.genome).toEqual(Array.from(oldest.creature.brain.genome));
    const s = oldestInState(JSON.parse(JSON.stringify(live.saveState())), "world-x.json.gz")!;
    expect({ ...s, from: "running world" }).toEqual(w);
    expect(w.family).toBe(FOUNDERS.find((f) => STARTER_MARK + f.name === live.eco.lineageName(oldest.founderId))!.name);
    expect(oldestInWorld(new LiveWorld(freshConfig(), null).eco)).toBeNull();
  });

  it("passes the upload checks with an admin name and a capped count, and is refused with the reason otherwise", () => {
    const live = aged();
    const rules = live.addRules();
    const ok = checkCarry(order(live), rules, 100);
    expect(typeof ok).toBe("object");
    const bad = (change: (o: Record<string, unknown>) => void, room = 100): string => {
      const r = checkCarry(order(live, change), rules, room);
      if (typeof r !== "string") throw new Error("accepted");
      return r;
    };
    const c = (o: Record<string, unknown>) => o.creature as Record<string, unknown>;
    expect(checkCarry(null, rules, 100)).toMatch(/not a carry order/);
    expect(bad((o) => (o.version = 2))).toMatch(/not a carry order/);
    for (const name of ["", "Old one", "A".repeat(17), "Ancient<b>", 5]) expect(bad((o) => (o.name = name))).toMatch(/name must be 1 to 16/);
    for (const copies of [0, -1, 1.5, MAX_CARRY + 1, "5"]) expect(bad((o) => (o.copies = copies))).toMatch(/whole number from 1 to/);
    expect(bad((o) => (o.copies = 30), 20)).toMatch(/from 1 to 20/); // the room below the birth reserve
    expect(bad((o) => ((c(o).genome as unknown[])[3] = null))).toMatch(/must be numbers/);
    expect(bad((o) => ((c(o).genome as unknown[])[3] = "0.5"))).toMatch(/must be numbers/);
    expect(bad((o) => ((c(o).genome as unknown[])[3] = 1e9))).toMatch(/would not pass as an upload/);
    expect(bad((o) => (c(o).genome as unknown[]).pop())).toMatch(/would not pass as an upload/);
    expect(bad((o) => ((c(o).plan as Record<string, unknown>).rayCount = 99))).toMatch(/would not pass as an upload/);
    expect((checkCarry(order(live, (o) => ((c(o).plan as Record<string, unknown>).extra = 1)), rules, 100) as CarryOrder).creature.plan).not.toHaveProperty("extra"); // only checked fields are kept
    expect(bad((o) => ((c(o).birth as Record<string, unknown>).energy = 1e6))).toMatch(/would not pass as an upload/);
    expect(bad((o) => (c(o).genome = "abc"))).toMatch(/no plan, genome or birth/);
    expect(bad((o) => (c(o).ageTicks = -1))).toMatch(/source fields/);
  });

  // At a deploy that changes the map the running world is a fresh one: the creature comes from the old world's last save.
  it("is read from a listed save of another world, which this server would not restore", async () => {
    const dir = tmp();
    const c = freshConfig();
    c.world.width = 2400; // another world than smallConfig's 2000 x 1300
    const old = new LiveWorld(c, null);
    old.seedFounders(FOUNDERS, Math.random, 3);
    for (let i = 0; i < 20; i++) old.eco.step();
    await new Saves(old, new StateStore(dir)).save();
    const store = new StateStore(dir);
    const name = store.list()[0]!.name;
    const here = new LiveWorld(freshConfig(), null);
    await expect(store.read(name, here.homeWorld())).rejects.toThrow(/2400 x 1300/);
    const carried = oldestInState(await store.read(name), name)!;
    expect(carried.id).toBe(oldestInWorld(old.eco)!.id);
    expect(carried.from).toBe(name);
    expect(typeof checkCarry({ version: 1, name: "Ancient", copies: 50, creature: carried }, here.addRules(), 1000)).toBe("object");
  });

  // Red without the carry-only read: the parse worker restored the save, and a save of an older map version would not restore.
  it("is read from a save of an older version of a named map without restoring it", async () => {
    const dir = tmp();
    const state = JSON.parse(JSON.stringify(aged().saveState()));
    state.config.world.map = "inland-sea";
    state.mapVersion = "deadbeef-1";
    const store = new StateStore(dir);
    const name = await store.write(JSON.stringify(state), { population: 1, tick: 1 }, new Date(), false);
    await expect(store.read(name)).rejects.toThrow(/inland-sea/); // the full restore refuses it (size or map version)
    const carried = (await store.readCarry(name))!;
    expect(carried.from).toBe(name);
    expect(carried.genome.length).toBeGreaterThan(0);
    await expect(store.readCarry("../world-x.json.gz")).rejects.toThrow(/not a save name/);
    writeFileSync(join(dir, name), "not gzip");
    await expect(store.readCarry(name)).rejects.toThrow();
  });

  // Red without the bound: a crafted save whose oldest creature claims a huge genome posted it to the main heap from the worker.
  it("reads no genome longer than an upload's from a save's columns", () => {
    const cols = (genome: number, hidden: number[] = [1]) => ({
      creatures: { count: 1, scalars: Buffer.from(new Float64Array(SCALARS.length).fill(1).buffer).toString("base64"), plans: [[1, 1, 10, 0, 0, genome, ...hidden]], genomes: Buffer.from(new Float32Array(genome).buffer).toString("base64") },
      lineages: { late: [] },
    });
    expect(oldestInState(cols(40) as never, "x")!.genome).toHaveLength(40);
    expect(() => oldestInState(cols(MAX_ADD_GENOME + 1) as never, "x")).toThrow(/broken/);
    expect(() => oldestInState(cols(40, [1, 1, 1, 1, 1, 1]) as never, "x")).toThrow(/broken/);
    expect(() => oldestInState({ creatures: { count: 5, scalars: "", plans: [], genomes: "" } } as never, "x")).toThrow(/broken/);
    expect(() => oldestInState(null as never, "x")).toThrow(/broken/);
  });

  it("refuses a starter founder's name, and fits the largest brain an upload allows in its file", () => {
    const live = aged();
    const founder = FOUNDERS[0]!.name;
    expect(checkCarry(order(live, (o) => (o.name = founder.toUpperCase())), live.addRules(), 100, FOUNDERS.map((f) => f.name))).toMatch(/must not be a starter founder's/);
    const L = PLAN_LIMITS;
    const plan = { rayCount: L.rayCount[1], raySpread: 1, rayLength: 100, hiddenLayers: Array<number>(L.layers[1]).fill(L.neurons[1]), memoryShort: L.memory[1], memoryLong: L.memory[1] };
    const big = order(live, (o) => {
      const c = o.creature as Record<string, unknown>;
      c.plan = plan;
      c.genome = Array.from({ length: MAX_ADD_GENOME }, () => Math.fround(-0.3)); // the longest form a float32 takes as JSON
    });
    const ok = checkCarry(big, live.addRules(), 100);
    if (typeof ok === "string") throw new Error(ok);
    expect(JSON.stringify(ok).length).toBeLessThanOrEqual(MAX_CARRY_FILE_BYTES);
  });

  it("is asked for in the admin message with checked fields", () => {
    expect(carryAsk(undefined)).toBeNull();
    expect(carryAsk({ copies: 50, name: "Ancient", from: "world-2026-10-22T07-00-00-000Z.json.gz" })).toEqual({ copies: 50, name: "Ancient", from: "world-2026-10-22T07-00-00-000Z.json.gz" });
    expect(carryAsk({ copies: 50, name: "Ancient" })).toEqual({ copies: 50, name: "Ancient" });
    for (const m of [null, [], "x", { copies: 0, name: "A" }, { copies: MAX_CARRY + 1, name: "A" }, { copies: 5, name: "a b" }, { copies: 5, name: "A", from: "../etc/passwd" }, { copies: 5, name: "A", from: 3 }]) expect(typeof carryAsk(m)).toBe("string");
  });
});

describe("a reset with a carried creature", () => {
  async function running(dir: string): Promise<{ live: LiveWorld; saves: Saves; store: StateStore }> {
    const store = new StateStore(dir);
    const live = new LiveWorld(freshConfig(), null);
    const saves = new Saves(live, store);
    await openWorld(saves, live, dir, FOUNDERS, quiet);
    for (let i = 0; i < 20; i++) live.eco.step();
    return { live, saves, store };
  }
  const start = async (dir: string): Promise<{ live: LiveWorld; lines: string[] }> => {
    const live = new LiveWorld(freshConfig(), null);
    const lines: string[] = [];
    await openWorld(new Saves(live, new StateStore(dir)), live, dir, FOUNDERS, (l) => lines.push(l));
    return { live, lines };
  };
  const named = (live: LiveWorld, name: string): number => live.eco.members.filter((m) => live.eco.lineageName(m.founderId) === STARTER_MARK + name).length;

  it("seeds the founders and K copies of it at the next start, says what it carried, and carries it once", async () => {
    const dir = tmp();
    const { live, saves } = await running(dir);
    const o = checkCarry(order(live, (x) => (x.copies = 7)), live.addRules(), 1000) as CarryOrder;
    const line = await saves.reset(20, FOUNDERS.length, new Date("2026-10-22T08:00:00.000Z"), o);
    expect(line).toMatch(new RegExp(`the next start seeds 20 of each founder and 7 copies named Ancient of creature #${o.creature.id} \\(family \\w+, \\d+ s old\\) from running world`));
    expect(existsSync(join(dir, CARRY_FILE))).toBe(true);
    const { live: next, lines } = await start(dir);
    expect(next.eco.population).toBe(20 * FOUNDERS.length + 7);
    expect(named(next, "Ancient")).toBe(7);
    const copy = next.eco.members.find((m) => next.eco.lineageName(m.founderId) === STARTER_MARK + "Ancient")!;
    expect(Array.from(copy.creature.brain.genome)).toEqual(o.creature.genome);
    expect(lines.some((l) => l.startsWith("carried 7 copies named Ancient"))).toBe(true);
    expect([existsSync(join(dir, CARRY_FILE)), existsSync(join(dir, USED_CARRY))]).toEqual([false, true]);
    // A later fresh start (the world died out and the saves were cleared) carries nothing.
    const later = await start(tmpCopy(dir));
    expect(named(later.live, "Ancient")).toBe(0);
  });

  it("refuses a carry that does not fit beside the founders, moving nothing", async () => {
    const dir = tmp();
    const { live, saves, store } = await running(dir);
    const o = checkCarry(order(live, (x) => (x.copies = 200)), live.addRules(), 1000) as CarryOrder;
    const most = Math.floor((3000 - 100) / FOUNDERS.length);
    await expect(saves.reset(most, FOUNDERS.length, new Date(), o)).rejects.toThrow(/carried copies do not fit/);
    expect(store.list().length).toBeGreaterThan(0);
    expect(existsSync(join(dir, CARRY_FILE))).toBe(false);
  });

  // Red without the second check at startup: a carry file changed on disk would seed whatever it held.
  it("starts without the carry, set aside, when the file is broken, tampered, oversized or not a regular file", async () => {
    const live = aged();
    const good = JSON.stringify(order(live));
    const tampered = good.replace(/"genome":\[([^,\]]+)/, '"genome":[1e30');
    for (const [what, put] of [
      ["not JSON", (f: string) => writeFileSync(f, "{oops")],
      ["tampered weight", (f: string) => writeFileSync(f, tampered)],
      ["oversized", (f: string) => writeFileSync(f, " ".repeat(10_000_000))],
      ["a symlink", (f: string) => symlinkSync(join(tmp(), "elsewhere.json"), f)],
      ["too many copies", (f: string) => writeFileSync(f, good.replace('"copies":5', '"copies":5000'))],
    ] as const) {
      const dir = tmp();
      put(join(dir, CARRY_FILE));
      const { live: next, lines } = await start(dir);
      expect(next.eco.population, what).toBe(10 * FOUNDERS.length);
      expect(lines.some((l) => l.startsWith(`${CARRY_FILE} refused, nothing carried`)), what).toBe(true);
      expect(existsSync(join(dir, CARRY_FILE)), what).toBe(false);
      expect(existsSync(join(dir, REFUSED_CARRY)) || what === "a symlink", what).toBe(true);
    }
  });

  it("keeps nothing to carry when the reset stops before the move is done", async () => {
    const dir = tmp();
    const { live, saves, store } = await running(dir);
    const o = checkCarry(order(live), live.addRules(), 1000) as CarryOrder;
    vi.spyOn(store, "moveAside").mockImplementation(() => {
      throw new Error("disk trouble");
    });
    await expect(saves.reset(20, FOUNDERS.length, new Date(), o)).rejects.toThrow(/disk trouble/);
    expect([existsSync(join(dir, NEXT_CARRY)), existsSync(join(dir, CARRY_FILE))]).toEqual([false, false]);
    vi.restoreAllMocks();
  });

  // Red without the fallback: a carry that would not go in stopped every start, and systemd gave up.
  it("starts without the carry, set aside, when seeding it fails", async () => {
    const dir = tmp();
    writeFileSync(join(dir, CARRY_FILE), JSON.stringify(order(aged())));
    const seed = LiveWorld.prototype.seedFounders;
    vi.spyOn(LiveWorld.prototype, "seedFounders").mockImplementation(function (this: LiveWorld, ...a: Parameters<LiveWorld["seedFounders"]>) {
      if (a[3]) throw new Error("no room to seed the founders");
      return seed.apply(this, a);
    });
    const { live, lines } = await start(dir);
    vi.restoreAllMocks();
    expect(live.eco.population).toBe(10 * FOUNDERS.length);
    expect(lines.some((l) => /refused, nothing carried: seeding with it failed/.test(l))).toBe(true);
    expect([existsSync(join(dir, CARRY_FILE)), existsSync(join(dir, REFUSED_CARRY))]).toEqual([false, true]);
  });

  it("lists each save with the world it is of", async () => {
    const dir = tmp();
    const { saves, store } = await running(dir);
    await saves.save();
    expect(store.list()[0]!.world).toMatch(/^random 2000x1300$/);
    const meta = store.list()[0]!.name.replace(/\.json\.gz$/, ".meta.json");
    expect(existsSync(join(dir, meta))).toBe(true);
    writeFileSync(join(dir, meta), JSON.stringify({ population: 1, tick: 1, world: "<script>" }));
    expect(store.list()[0]!.world).toBeUndefined(); // only the listing's own form is shown
  });
});

// A copy of a state directory's carry files only, so a start there finds no saves.
function tmpCopy(dir: string): string {
  const to = tmp();
  for (const f of [CARRY_FILE, USED_CARRY]) if (existsSync(join(dir, f))) writeFileSync(join(to, f), readFileSync(join(dir, f)));
  return to;
}
