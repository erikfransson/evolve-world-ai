// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAP_LIMITS, ITEM_HEADROOM, ITEM_SLOT_SHARE, MAX_FOUNDERS_FILE_BYTES, MAX_SEED_FOUNDERS, SEED_COPIES, itemHeadroom, liveConfig } from "../../server/src/config.ts";
import { lineageName, loadFounders, parseFounders } from "../../server/src/founders.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { Saves } from "../../server/src/saves.ts";
import { StateStore } from "../../server/src/state.ts";
import { applyTunables } from "../../server/src/tunables.ts";
import { MAX_ITEM_SLOTS } from "../../src/typescript/src/live/protocol.ts";
import { cleanMap } from "../../src/typescript/src/live/mapInfo.ts";
import { encodeAdd, parseAdd } from "../../src/typescript/src/live/add.ts";
import { genomeLengthFor } from "../../src/typescript/src/sim/rl/creatureFile.ts";
import { smallConfig } from "./liveHelpers.ts";

const FOUNDERS = new URL("../../src/typescript/public/live-founders.json", import.meta.url);
const foundersJson = (): { founders: Record<string, unknown>[] } => JSON.parse(readFileSync(FOUNDERS, "utf8"));
const tmp = (): string => mkdtempSync(join(tmpdir(), "evolve-inland-"));
// Deterministic draws in [0, 1).
const seq = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
};
const freshSmall = (): LiveWorld => {
  const c = smallConfig();
  c.eco.initialPopulation = 0;
  return new LiveWorld(c, null);
};

describe("item slots of the live world", () => {
  it("keeps the fixed headroom where it fits, and scales it down to the wire on a big world", () => {
    expect(itemHeadroom({ width: 2000, height: 1300 }, { foodMaxDensity: 0.7, poisonMaxDensity: 0.1 })).toEqual(ITEM_HEADROOM);
    expect(itemHeadroom({ width: 17000, height: 10600 }, { foodMaxDensity: 0.7, poisonMaxDensity: 0.1 })).toEqual(ITEM_HEADROOM);
    const room = itemHeadroom(liveConfig.world, liveConfig.eco);
    expect(room).toEqual({ foodMaxDensity: 2.3, poisonMaxDensity: 0.05 });
    expect(CAP_LIMITS).toEqual(room);
    // Never below the caps in force, and never past the slot budget.
    for (const caps of [{ foodMaxDensity: 2.25, poisonMaxDensity: 0.06 }, { foodMaxDensity: 0.1, poisonMaxDensity: 2 }, { foodMaxDensity: 2.35, poisonMaxDensity: 0 }]) {
      const r = itemHeadroom(liveConfig.world, caps);
      expect(r.foodMaxDensity).toBeGreaterThanOrEqual(caps.foodMaxDensity);
      expect(r.poisonMaxDensity).toBeGreaterThanOrEqual(caps.poisonMaxDensity);
      expect((r.foodMaxDensity + r.poisonMaxDensity) * 100_000).toBeLessThanOrEqual(ITEM_SLOT_SHARE * MAX_ITEM_SLOTS);
    }
    expect(() => itemHeadroom(liveConfig.world, { foodMaxDensity: 2.5, poisonMaxDensity: 0 })).toThrow(/item slots/);
  });

  it("builds the Inland Sea world inside the wire's item slots, with the caps in force and admin held to the slots", () => {
    const live = new LiveWorld(structuredClone(liveConfig), null); // with a fixed 3 and 1 headroom this throws: 400 000 slots
    const slots = live.hello(1).itemSlots;
    expect(slots).toBe(235_000);
    expect(slots).toBeLessThanOrEqual(ITEM_SLOT_SHARE * MAX_ITEM_SLOTS);
    expect([live.config.eco.foodMaxDensity, live.config.eco.poisonMaxDensity]).toEqual([1.5, 0.01]);
    expect(live.eco.food).toBe(50_000);
    expect(live.eco.poison).toBe(1000);
    expect(applyTunables(live.eco, { "eco.foodMaxDensity": CAP_LIMITS.foodMaxDensity, "eco.poisonMaxDensity": CAP_LIMITS.poisonMaxDensity })).toBeNull();
    expect(applyTunables(live.eco, { "eco.foodMaxDensity": CAP_LIMITS.foodMaxDensity + 0.1 })).toMatch(/at most 2.3/);
    expect(applyTunables(live.eco, { "eco.poisonMaxDensity": 1 })).toMatch(/at most 0.05/);
    expect(live.eco.retune({ eco: { foodMaxDensity: 2.4 } })).toMatchObject({ ok: false, reason: expect.stringMatching(/item slots/) }); // the engine's own guard
    // The page gets the map's name and its regions.
    const map = live.hello(1).map;
    expect(map.name).toBe("inland-sea");
    expect(map.ground.rock).toBeGreaterThan(0.02);
    expect(map.ground.mud).toBeGreaterThan(0.02);
    expect(map.regions.map((r) => [r.name, r.food, r.poison])).toEqual([
      ["The Shallows", 1.6, 0], ["Isles", 1.5, 0], ["Ashfall Shore", 1.8, 3.5], ["Dune Coast", 0.65, 0.15], ["Drowned Town", 1.2, 0.15], ["Cliff Coast", 1, 0.15], ["Open plain", 1, 0.15],
    ]);
    expect(cleanMap(JSON.parse(JSON.stringify(map)))).toEqual(map);
    expect(live.hello(1).summary).toMatchObject({ initialPopulation: 0, seedCopies: SEED_COPIES });
  }, 120_000);

  it("the page keeps only a known map name", () => {
    expect(cleanMap({ name: "inland-sea" }).name).toBe("inland-sea");
    for (const name of ["", "nowhere", "__proto__", 5, "inland-sea ".repeat(100)]) expect(cleanMap({ name }).name).toBeUndefined();
  });
});

describe("founders file", () => {
  it("the shipped file passes, with lineage names a visitor's add could have", () => {
    const f = loadFounders(FOUNDERS.pathname);
    expect(f.length).toBeGreaterThanOrEqual(1);
    expect(f.length).toBeLessThanOrEqual(MAX_SEED_FOUNDERS);
    for (const x of f) expect(x.name).toMatch(/^[A-Za-z0-9]{1,16}$/);
    expect(lineageName("Slow and steady")).toBe("SlowAndSteady");
    expect(lineageName("Hunter-ish")).toBe("HunterIsh");
    expect(lineageName(" -- ")).toBe("");
    // Each founder would also pass as a visitor's add.
    const rules = freshSmall().addRules();
    for (const x of f) expect(typeof parseAdd(encodeAdd({ plan: x.plan, genome: x.genome, birth: { energy: 150, cost: 70, cooldown: 10 }, name: x.name, hue: 0, copies: 1 }), rules)).toBe("object");
  });

  it("refuses a file with a bad founder, too many founders, or none, and skips nothing", () => {
    const good = foundersJson();
    const one = good.founders[0]!;
    const n = genomeLengthFor("forager", one.plan as never);
    const with_ = (f: Record<string, unknown>): unknown => ({ founders: [one, f] });
    expect(parseFounders(with_({ ...one, genome: [...(one.genome as number[]).slice(0, n - 1), 1e9] }))).toMatch(/founder 2/);
    expect(parseFounders(with_({ ...one, genome: (one.genome as number[]).slice(1) }))).toMatch(/founder 2/);
    expect(parseFounders(with_({ ...one, genome: [...(one.genome as number[]).slice(0, n - 1), "NaN"] }))).toMatch(/founder 2/);
    expect(parseFounders(with_({ ...one, plan: { ...(one.plan as object), rayCount: 999 } }))).toMatch(/founder 2/);
    expect(parseFounders(with_({ ...one, plan: { ...(one.plan as object), raySpread: 0 } }))).toMatch(/founder 2/);
    expect(parseFounders(with_({ ...one, name: "!!" }))).toMatch(/founder 2: the name/);
    expect(parseFounders(with_({ ...one, name: undefined }))).toMatch(/founder 2 has no name/);
    expect(parseFounders({ founders: Array(MAX_SEED_FOUNDERS + 1).fill(one) })).toMatch(/1 to 8/);
    expect(parseFounders({ founders: [] })).toMatch(/1 to 8/);
    expect(parseFounders(null)).toMatch(/no founders/);
    expect(parseFounders({ founders: {} })).toMatch(/no founders/);
  });

  it("reads only a regular file within its size cap", () => {
    const dir = tmp();
    const big = join(dir, "big.json");
    writeFileSync(big, JSON.stringify({ founders: foundersJson().founders, pad: "x".repeat(MAX_FOUNDERS_FILE_BYTES) }));
    expect(() => loadFounders(big)).toThrow(/too big/);
    const link = join(dir, "link.json");
    symlinkSync(FOUNDERS.pathname, link);
    expect(() => loadFounders(link)).toThrow(/not a regular file/);
    writeFileSync(join(dir, "bad.json"), "{");
    expect(() => loadFounders(join(dir, "bad.json"))).toThrow(/founders file/);
  });

  it("the server refuses to start on a bad founders file, with the reason", () => {
    const dir = tmp();
    const bad = join(dir, "founders.json");
    writeFileSync(bad, JSON.stringify({ founders: [{ ...foundersJson().founders[0], genome: [1] }] }));
    const r = spawnSync(process.execPath, [new URL("../../server/src/main.ts", import.meta.url).pathname], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, LIVE_FOUNDERS_FILE: bad, LIVE_STATE_DIR: join(dir, "state"), LIVE_PORT: "61691", LIVE_ADMIN_PORT: "61692" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/STARTUP FAILED, founders file checked: founders file .*founder 1/);
  });
});

describe("seeding a fresh world", () => {
  const founders = loadFounders(FOUNDERS.pathname);

  it("puts 10 named copies of each founder on open ground, none of them a visitor's add", () => {
    const live = freshSmall();
    expect(live.seedFounders(founders, seq(3))).toBe(SEED_COPIES * founders.length);
    const e = live.eco;
    expect(e.population).toBe(SEED_COPIES * founders.length);
    const names = new Map<string, number>();
    for (const m of e.members) {
      const name = e.lineageName(m.founderId);
      names.set(name, (names.get(name) ?? 0) + 1);
      expect(m.founderId).toBe(m.id); // each copy founds its own lineage
      expect((e.world as unknown as { terrain: { touchesRock(x: number, y: number, r: number): boolean } }).terrain.touchesRock(m.creature.state.x, m.creature.state.y, live.config.creature.radius)).toBe(false);
    }
    expect([...names]).toEqual(founders.map((f) => [f.name, SEED_COPIES]));
    expect(live.aliveAdded()).toBe(0);
    // After a save and restore the seeds still are no adds; a visitor's add still is one.
    live.step();
    const r = live.addCreatures({ plan: founders[0]!.plan, genome: founders[0]!.genome, birth: { energy: 150, cost: 70, cooldown: 10 }, name: "Kiwi", hue: 10, copies: 2 }, seq(9));
    expect("ids" in r).toBe(true);
    expect(live.aliveAdded()).toBe(2);
    const b = freshSmall();
    b.restoreState(JSON.parse(JSON.stringify(live.saveState())));
    expect(b.aliveAdded()).toBe(2); // without the seed rule in attach this is 2 + all the seeds
  });

  it("draws the spots from the given numbers only, and seeds only a fresh empty world", () => {
    const [a, b] = [freshSmall(), freshSmall()];
    a.seedFounders(founders, seq(5));
    b.seedFounders(founders, seq(5));
    expect(JSON.stringify(a.saveState())).toBe(JSON.stringify(b.saveState()));
    expect(() => a.seedFounders(founders, seq(6))).toThrow(/fresh/);
    const c = freshSmall();
    c.step();
    c.addCreatures({ plan: founders[0]!.plan, genome: founders[0]!.genome, birth: { energy: 150, cost: 70, cooldown: 10 }, name: "Kiwi", hue: 10, copies: 1 }, seq(1));
    expect(() => c.seedFounders(founders, seq(6))).toThrow(/fresh/);
    expect(() => freshSmall().seedFounders([], seq(6))).toThrow(/1 to 8/);
  });

  it("fails without inserting a partial set when there is no room", () => {
    const c = smallConfig();
    c.eco.initialPopulation = 0;
    c.world.width = c.world.height = 200;
    const live = new LiveWorld(c, null);
    expect(() => live.seedFounders(founders, seq(2))).toThrow(/no room/);
    expect(live.eco.population).toBe(0);
  });
});

describe("restoring at a new world", () => {
  it("refuses a save of another world size or map, keeps it on disk, and the server starts fresh", async () => {
    const old = smallConfig();
    old.world.width = 2100;
    const a = new LiveWorld(old, null);
    for (let i = 0; i < 5; i++) a.step();
    const dir = tmp();
    const store = new StateStore(dir);
    await store.write(JSON.stringify(a.saveState()), { population: a.eco.population, tick: a.eco.tick });
    const live = freshSmall();
    expect(() => live.restoreState(a.saveState())).toThrow(/2100 x 1300 world without a map, this server runs 2000 x 1300 without a map/);
    const lines: string[] = [];
    expect(await new Saves(live, store).restoreNewest((l) => lines.push(l))).toBe(false);
    expect(lines[0]).toMatch(/cannot restore world-.*this server runs 2000 x 1300/);
    expect(lines.at(-1)).toBe("no usable save, starting a fresh world");
    expect(store.list()).toHaveLength(1);
    expect(live.eco.tick).toBe(0);
  });
});
