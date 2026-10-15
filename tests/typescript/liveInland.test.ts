// @vitest-environment node
import { spawnSync } from "node:child_process";
// @ts-expect-error the web tsconfig finds no types for the server's ws
import { WebSocket } from "../../server/node_modules/ws/wrapper.mjs";
import { startPublic } from "../../server/src/public.ts";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAP_LIMITS, ITEM_HEADROOM, LIMITS, LIVE, MAX_POPULATION, ITEM_SLOT_SHARE, MAX_FOUNDERS_FILE_BYTES, MAX_SEED_FOUNDERS, SEED_COPIES, itemHeadroom, liveConfig } from "../../server/src/config.ts";
import { lineageName, loadFounders, parseFounders } from "../../server/src/founders.ts";
import { parseFounders as parsePageFounders } from "../../src/typescript/src/live/founders.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { namedTop } from "../../server/src/chronicle.ts";
import { OtherWorld } from "../../server/src/saveParse.ts";
import { Saves, openWorld } from "../../server/src/saves.ts";
import { PREVIOUS_OVERRIDES } from "../../server/src/admin.ts";
import { StateStore } from "../../server/src/state.ts";
import { applyTunables } from "../../server/src/tunables.ts";
import { MAX_ITEM_SLOTS } from "../../src/typescript/src/live/protocol.ts";
import { cleanMap } from "../../src/typescript/src/live/mapInfo.ts";
import { STARTER_MARK, encodeAdd, parseAdd, wireName } from "../../src/typescript/src/live/add.ts";
import { decodeDetail } from "../../src/typescript/src/live/detail.ts";
import { cleanStats } from "../../src/typescript/src/live/connection.ts";
import { lineageRows } from "../../src/typescript/src/ui/lineagePanel.ts";
import { genomeLengthFor } from "../../src/typescript/src/sim/rl/creatureFile.ts";
import { MAP_TIMEOUT_MS, MAX_OUTLINE_LOOPS, MAX_OUTLINE_POINTS, MapCache, checkOutlines, loadMapTerrain, terrainFromParts } from "../../src/typescript/src/live/mapTerrain.ts";
import { rockBodies, rockGeometry } from "../../src/typescript/src/ui/rockOutline.ts";
import type { RockGeometry } from "../../src/typescript/src/ui/rockOutline.ts";
import { builtMap, mapVersion } from "../../src/typescript/src/sim/maps/index.ts";
import { terrainOf } from "../../src/typescript/src/sim/terrain.ts";
import type { Terrain } from "../../src/typescript/src/sim/terrain.ts";
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
    expect(itemHeadroom(liveConfig.world, liveConfig.eco)).toEqual(ITEM_HEADROOM); // the Inland Sea (56 250 items per density unit) fits the fixed headroom
    expect(CAP_LIMITS).toEqual(ITEM_HEADROOM);
    const big = { width: 40000, height: 25000 }; // 100 000 items per density unit: the headroom is scaled down to the wire
    const room = itemHeadroom(big, liveConfig.eco);
    expect(room).toEqual({ foodMaxDensity: 2.3, poisonMaxDensity: 0.05 });
    // Never below the caps in force, and never past the slot budget.
    for (const caps of [{ foodMaxDensity: 2.25, poisonMaxDensity: 0.06 }, { foodMaxDensity: 0.1, poisonMaxDensity: 2 }, { foodMaxDensity: 2.35, poisonMaxDensity: 0 }]) {
      const r = itemHeadroom(big, caps);
      expect(r.foodMaxDensity).toBeGreaterThanOrEqual(caps.foodMaxDensity);
      expect(r.poisonMaxDensity).toBeGreaterThanOrEqual(caps.poisonMaxDensity);
      expect((r.foodMaxDensity + r.poisonMaxDensity) * 100_000).toBeLessThanOrEqual(ITEM_SLOT_SHARE * MAX_ITEM_SLOTS);
    }
    expect(() => itemHeadroom(big, { foodMaxDensity: 2.5, poisonMaxDensity: 0 })).toThrow(/item slots/);
  });

  it("builds the Inland Sea world inside the wire's item slots, with the caps in force and admin held to the slots", () => {
    const live = new LiveWorld(structuredClone(liveConfig), null);
    const slots = live.hello(1).itemSlots;
    expect(slots).toBe(225_000); // (3 + 1) x 56 250
    expect(slots).toBeLessThanOrEqual(ITEM_SLOT_SHARE * MAX_ITEM_SLOTS);
    expect([live.config.eco.foodMaxDensity, live.config.eco.poisonMaxDensity]).toEqual([1.5, 0.01]);
    expect(live.eco.food).toBe(28_125);
    expect(live.eco.poison).toBe(563);
    expect(applyTunables(live.eco, { "eco.foodMaxDensity": CAP_LIMITS.foodMaxDensity, "eco.poisonMaxDensity": CAP_LIMITS.poisonMaxDensity })).toBeNull();
    expect(applyTunables(live.eco, { "eco.foodMaxDensity": CAP_LIMITS.foodMaxDensity + 0.1 })).toMatch(/at most 3/);
    expect(applyTunables(live.eco, { "eco.poisonMaxDensity": 1.1 })).toMatch(/at most 1/);
    expect(live.eco.retune({ eco: { foodMaxDensity: 4 } })).toMatchObject({ ok: false, reason: expect.stringMatching(/item slots/) }); // the engine's own guard
    // A save made on other data of the same map counts as another world (startup starts fresh), not as a failure to retry.
    expect(() => live.restoreState({ ...live.saveState(), mapVersion: "00000000" })).toThrow(OtherWorld);
    // The page gets the map's name and its regions.
    const map = live.hello(1).map;
    expect(map.name).toBe("inland-sea");
    expect(map.ground.rock).toBeGreaterThan(0.02);
    expect(map.ground.mud).toBeGreaterThan(0.02);
    expect(map.regions.map((r) => [r.name, r.food, r.poison])).toEqual([
      ["The Shallows", 1.6, 0], ["Isles", 1.5, 0], ["Ashfall Shore", 1.8, 3.5], ["Dune Coast", 0.65, 0.15], ["Drowned Town", 1.2, 0.15], ["Cliff Coast", 1, 0.15], ["Open plain", 1, 0.15],
    ]);
    expect(cleanMap(JSON.parse(JSON.stringify(map)))).toEqual(map);
    // The page compares it with its own bundle's mapVersion; the wire form survives cleanMap, so server and page agree.
    expect(map.version).toBe(mapVersion("inland-sea"));
    expect(map.version).toMatch(/^[0-9a-f]{8}-[0-9]+$/);
    expect(cleanMap(JSON.parse(JSON.stringify(live.hello(1).map))).version).toBe(mapVersion("inland-sea"));
    expect(cleanMap({ ...map, version: "<b>" }).version).toBeUndefined();
    expect(cleanMap({ ...map, name: undefined, version: map.version }).version).toBeUndefined();
    expect(live.hello(1).summary).toMatchObject({ initialPopulation: 0, seedCopies: SEED_COPIES });
  }, 120_000);

  it("the page puts the map together from the worker's arrays only when they fit the map", () => {
    const b = builtMap("inland-sea");
    const rock = Float64Array.from(b.rock.flatMap((d) => [d.x, d.y, d.r]));
    const outlines = rockGeometry(terrainOf({ seed: 1, world: { ...liveConfig.world } }));
    const parts = { ok: true as const, rock, ground: b.ground.data.slice(), food: b.weights.food.slice(), poison: b.weights.poison.slice(), outlines, ms: 0 };
    const t = terrainFromParts("inland-sea", liveConfig.world.width, liveConfig.world.height, parts)!;
    expect(t.rockCount).toBe(b.rock.length);
    // A body whose outline simplified away (no loops) is allowed: a cumulative step of 0.
    const n = outlines.bodyLoops.length;
    const zero = { ...outlines, bodyLoops: Uint32Array.from([...outlines.bodyLoops, outlines.bodyLoops[n - 1]!]) };
    expect(checkOutlines(zero, liveConfig.world.width, liveConfig.world.height)).toBe(true);
    const bodies = rockBodies(t); // the worker's outlines, not traced again
    expect(bodies).toHaveLength(outlines.bodyLoops.length);
    expect(bodies[0]!.loops[0]!.slice(0, 4)).toEqual(Array.from(outlines.points.subarray(0, 4)));
    expect(terrainFromParts("inland-sea", liveConfig.world.width, liveConfig.world.height, { ...parts, rock: rock.subarray(0, 30) })).toBeNull(); // outlines of other rock
    expect(terrainFromParts("inland-sea", liveConfig.world.width, liveConfig.world.height, { ...parts, outlines: { ...outlines, points: Float64Array.from(outlines.points, (v, i) => (i === 5 ? NaN : v)) } })).toBeNull();
    expect(t.valueAt(20000, 12500)).toBe(terrainOf({ seed: 1, world: { ...liveConfig.world } }).valueAt(20000, 12500));
    expect(terrainFromParts("inland-sea", 17000, 10600, parts)).toBeNull();
    expect(terrainFromParts("nowhere", liveConfig.world.width, liveConfig.world.height, parts)).toBeNull();
    expect(terrainFromParts("inland-sea", liveConfig.world.width, liveConfig.world.height, { ...parts, ground: parts.ground.subarray(1) })).toBeNull();
    expect(terrainFromParts("inland-sea", liveConfig.world.width, liveConfig.world.height, { ...parts, food: new Uint8Array(3) })).toBeNull();
    expect(terrainFromParts("inland-sea", liveConfig.world.width, liveConfig.world.height, { ...parts, rock: Float64Array.from([1, 2]) })).toBeNull();
    expect(terrainFromParts("inland-sea", liveConfig.world.width, liveConfig.world.height, { ...parts, rock: Float64Array.from([1, NaN, 3]) })).toBeNull();
    expect(terrainFromParts("inland-sea", liveConfig.world.width, liveConfig.world.height, { ...parts, rock: new Float64Array(3 * 8001) })).toBeNull();
    expect(terrainFromParts("inland-sea", liveConfig.world.width, liveConfig.world.height, { ok: false, message: "x" })).toBeNull();
  }, 60_000);

  it("the page takes rock outlines only when their counts add up and every value is bounded and finite", () => {
    const g = rockGeometry(terrainOf({ seed: 1, world: { ...liveConfig.world } }));
    const W = liveConfig.world.width;
    const H = liveConfig.world.height;
    expect(checkOutlines(g, W, H)).toBe(true);
    const bad = (change: Partial<RockGeometry>): boolean => checkOutlines({ ...g, ...change }, W, H);
    const pts = (f: (p: Float64Array) => void): Float64Array => { const p = g.points.slice(); f(p); return p; };
    const u32 = (a: Uint32Array, f: (p: Uint32Array) => void): Uint32Array => { const p = a.slice(); f(p); return p; };
    expect(bad({ points: pts((p) => (p[7] = NaN)) })).toBe(false);
    expect(bad({ points: pts((p) => (p[7] = 1e9)) })).toBe(false);
    expect(bad({ points: pts((p) => (p[7] = -5000)) })).toBe(false);
    expect(bad({ points: g.points.subarray(2) })).toBe(false); // the loops no longer add up to the points
    expect(bad({ points: g.points.subarray(1) })).toBe(false); // half a point
    expect(bad({ loopPoints: u32(g.loopPoints, (p) => (p[3] = p[2]! + 1)) })).toBe(false); // a loop of 1 point, or falling
    expect(bad({ loopPoints: u32(g.loopPoints, (p) => (p[3] = p[4]! + 10)) })).toBe(false);
    expect(bad({ bodyLoops: u32(g.bodyLoops, (p) => (p[1] = p[0]!)) })).toBe(true); // a body without loops (its outline simplified away) is allowed
    expect(bad({ bodyLoops: u32(g.bodyLoops, (p) => (p[p.length - 1] = p[p.length - 1]! + 1)) })).toBe(false);
    expect(bad({ points: Array.from(g.points) as unknown as Float64Array })).toBe(false); // not typed arrays
    expect(checkOutlines(null, W, H)).toBe(false);
    // Totals are capped before anything is read: a huge set is refused by its size.
    const loops = MAX_OUTLINE_LOOPS + 1;
    expect(checkOutlines({ bodyLoops: Uint32Array.of(loops), loopPoints: Uint32Array.from({ length: loops }, (_, i) => 3 * (i + 1)), points: new Float64Array(6 * loops) }, W, H)).toBe(false);
    expect(checkOutlines({ bodyLoops: Uint32Array.of(1), loopPoints: Uint32Array.of(MAX_OUTLINE_POINTS + 1), points: new Float64Array(2 * (MAX_OUTLINE_POINTS + 1)) }, W, H)).toBe(false);
    expect(checkOutlines({ bodyLoops: Uint32Array.of(1), loopPoints: Uint32Array.of(MAX_OUTLINE_POINTS), points: new Float64Array(2 * MAX_OUTLINE_POINTS) }, W, H)).toBe(true);
  }, 60_000);

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
    // The pages read the same file with the same parser, so a visitor's copy of a starter carries the starter's lineage name.
    const page = parsePageFounders(JSON.parse(readFileSync(FOUNDERS, "utf8")));
    expect(page.map((x) => x.lineage)).toEqual(f.map((x) => x.name));
    expect(page.find((x) => x.name === "Grazer")?.lineage).toBe("Grazer");
    // Each founder would also pass as a visitor's add.
    const rules = freshSmall().addRules();
    for (const x of f) expect(typeof parseAdd(encodeAdd({ plan: x.plan, genome: x.genome, birth: { energy: 150, cost: 70, cooldown: 10 }, name: x.name, hue: 0, copies: 1 }), rules)).toBe("object");
  });

  it("lists the seeded copies of a starter as one family, and a rename keeps it a starter", () => {
    const live = freshSmall();
    const founders = loadFounders(FOUNDERS.pathname);
    live.seedFounders(founders, seq(4));
    const top = namedTop(live.eco, 8);
    expect(top).toHaveLength(founders.length);
    for (const g of top) {
      expect(g.count).toBe(SEED_COPIES);
      expect(g.others).toHaveLength(SEED_COPIES - 1);
      expect(g.starter).toBe(true);
    }
    expect(live.renameName(founders[0]!.name, "Scout")).toBe(SEED_COPIES);
    const renamed = namedTop(live.eco, 8).find((g) => g.name === "Scout");
    expect([renamed?.count, renamed?.starter]).toEqual([SEED_COPIES, true]);
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
    // A founder's own birth traits: optional, numbers, and inside the live world's ranges on the server.
    expect(parseFounders(with_({ ...one, birth: { energy: 160, cost: "70" } }))).toMatch(/founder 2: birth/);
    expect(parseFounders(with_({ ...one, birth: { energy: 160 } }))).toMatch(/founder 2: birth/);
    expect(parseFounders(with_({ ...one, birth: { energy: 160, cost: 70, cooldown: -1 } }))).toMatch(/founder 2: birth/);
    expect(parseFounders(with_({ ...one, birth: { energy: 99, cost: 70 } }))).toMatch(/founder 2: birth must lie in the world's ranges/);
    expect(parseFounders(with_({ ...one, birth: { energy: 160, cost: 70, cooldown: 50 } }))).toMatch(/world's ranges/);
    const ok = parseFounders(with_({ ...one, name: "Second", birth: { energy: 160, cost: 70, cooldown: 8 } }));
    if (typeof ok === "string") throw new Error(ok);
    expect([ok[0]!.birth, ok[1]!.birth]).toEqual([undefined, { energy: 160, cost: 70, cooldown: 8 }]);
    // Seeded starters carry them.
    const live = freshSmall();
    live.seedFounders(ok, seq(3));
    const traits = (m: { birth: { energy: number; cost: number; cooldown: number } }) => [m.birth.energy, m.birth.cost, m.birth.cooldown];
    const second = live.eco.members.filter((m) => live.eco.lineageName(m.founderId) === STARTER_MARK + ok[1]!.name);
    expect(second.length).toBe(SEED_COPIES);
    for (const m of second) expect(traits(m)).toEqual([160, 70, 8]);
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
      const name = wireName(e.lineageName(m.founderId)).name;
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

  it("labels the seeds as starters, not added, in the stats, the details and the lineage list, also after a save and restore", () => {
    const live = freshSmall();
    live.seedFounders(founders.slice(0, 1), seq(3));
    const seeds = new Set(live.eco.members.map((m) => m.id));
    live.step();
    const r = live.addCreatures({ plan: founders[0]!.plan, genome: founders[0]!.genome, birth: { energy: 150, cost: 70, cooldown: 10 }, name: "Kiwi", hue: 10, copies: 1 }, seq(9));
    if (!("ids" in r)) throw new Error(r.reason);
    const seed = [...seeds][0]!;
    const check = (w: LiveWorld): void => {
      const lineages = cleanStats(JSON.parse(JSON.stringify(w.stats(0)))).lineages!;
      expect(lineages.length).toBeGreaterThan(0);
      for (const l of lineages) expect([l.name, l.starter === true]).toEqual(seeds.has(l.founder) ? [founders[0]!.name, true] : ["Kiwi", false]);
      const kiwi = { founder: r.ids[0]!, hue: 10, pool: false, count: 1, species: 0 };
      const rows = lineageRows([{ founder: seed, hue: 0, pool: false, count: 1, species: 0 }, kiwi], 2, new Map([[seed, "A"], [kiwi.founder, "Kiwi"]]), new Set(lineages.filter((l) => l.starter).map((l) => l.founder)).add(seed));
      expect(rows.map((x) => x.origin)).toEqual(["starter", "added"]);
      for (const [id, starter, name] of [[seed, true, founders[0]!.name], [r.ids[0]!, false, "Kiwi"]] as const) {
        w.watch(id);
        w.refreshWatched();
        const d = decodeDetail(w.detail(id)!);
        expect([d.founderName, d.founderStarter, d.details.founderPool]).toEqual([name, starter, false]);
        w.unwatch(id);
      }
    };
    check(live);
    const b = freshSmall();
    b.restoreState(JSON.parse(JSON.stringify(live.saveState())));
    check(b);
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
  it("skips a save of another world size or map, keeps it on disk, restores this world's older save, and starts fresh only without one", async () => {
    const old = smallConfig();
    old.world.width = 2100;
    const a = new LiveWorld(old, null);
    for (let i = 0; i < 5; i++) a.step();
    const same = freshSmall();
    same.step();
    const dir = tmp();
    const store = new StateStore(dir);
    const now = Date.now();
    await store.write(JSON.stringify(same.saveState()), { population: 0, tick: 1 }, new Date(now - 60_000)); // older, of this world
    await store.write(JSON.stringify(a.saveState()), { population: a.eco.population, tick: a.eco.tick }, new Date(now));
    const live = freshSmall();
    expect(() => live.restoreState(a.saveState())).toThrow(/2100 x 1300 world without a map, this server runs 2000 x 1300 world without a map/);
    const lines: string[] = [];
    // The newest is another world's (a run on a test map, then a revert): it is skipped and this world's older save restores.
    expect(await new Saves(live, store).restoreNewest((l) => lines.push(l))).toBe("restored");
    expect(lines[0]).toMatch(/cannot restore world-.*this server runs 2000 x 1300/);
    expect(lines[1]).toMatch(new RegExp(`^restored ${store.list()[1]!.name}`)); // the older one, of this world
    // Only other worlds' saves: a fresh world, and they stay on disk.
    const others = new StateStore(tmp());
    await others.write(JSON.stringify(a.saveState()), { population: a.eco.population, tick: a.eco.tick }, new Date(now));
    const fresh = freshSmall();
    const out: string[] = [];
    expect(await new Saves(fresh, others).restoreNewest((l) => out.push(l))).toBe("fresh");
    expect(out.slice(-2)).toEqual(["1 saves of other worlds are kept on disk", "no usable save, starting a fresh world"]);
    expect(others.list()).toHaveLength(1);
    expect(fresh.eco.tick).toBe(0);
    expect(store.list()).toHaveLength(2);
  });
});

describe("restoring Inland Sea saves of another size or map data", () => {
  it("counts them as other worlds at startup (the parse worker checks before the engine), so the server starts fresh", async () => {
    const live = new LiveWorld(structuredClone(liveConfig), null);
    const state = live.saveState();
    const bigger = structuredClone(state);
    bigger.config.world.width = 40000;
    bigger.config.world.height = 25000;
    const older = { ...structuredClone(state), mapVersion: "00000000" };
    const crafted = structuredClone(state) as unknown as { config: { world: Record<string, unknown> }; mapVersion: unknown };
    crafted.config.world.width = { toString: 0 }; // String() of this throws; the reason must not
    const craftedVersion = { ...structuredClone(state), mapVersion: { toString: 0 } };
    for (const [save, why] of [[bigger, /40000 x 25000 world \(inland-sea\), this server runs 30000 x 18750 world \(inland-sea\)/], [older, /another version of the map inland-sea/], [crafted, /it is a object x 18750 world/], [craftedVersion, /another version of the map inland-sea \(object,/]] as const) {
      const store = new StateStore(tmp());
      await store.write(JSON.stringify(save), { population: 0, tick: 0 }, new Date());
      const lines: string[] = [];
      expect(await new Saves(live, store).restoreNewest((l) => lines.push(l))).toBe("fresh");
      expect(lines[0]).toMatch(why);
      expect(store.list()).toHaveLength(1);
    }
  }, 120_000);
});

describe("admin overrides across a move to a new world", () => {
  it("a fresh world sets the earlier world's overrides aside, so a restart that restores does not apply them", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const old = { speed: 4, "eco.seasons": true, "eco.yearMinutes": 40, "eco.winterFood": 0.4 };
    writeFileSync(join(dir, "admin-overrides.json"), JSON.stringify(old));
    writeFileSync(join(dir, PREVIOUS_OVERRIDES), "{}"); // an older copy is replaced, so only one is kept
    const speed = LIVE.speed;
    const founders = loadFounders(FOUNDERS.pathname);
    try {
      const lines: string[] = [];
      const fresh = freshSmall();
      expect(await openWorld(new Saves(fresh, store), fresh, dir, founders, (l) => lines.push(l))).toEqual({});
      fresh.step();
      await new Saves(fresh, store).save();
      // The restart restores the fresh world's save: the old values must not come back.
      const again = freshSmall();
      expect(await openWorld(new Saves(again, store), again, dir, founders, () => {})).toEqual({});
      expect(again.eco.tick).toBe(1);
      expect([LIVE.speed, again.config.eco.yearMinutes]).toEqual([speed, liveConfig.eco.yearMinutes]);
      expect(lines).toContain("fresh world: admin-overrides.json of the world before moved to admin-overrides.previous-world.json, not applied");
      expect(existsSync(join(dir, "admin-overrides.json"))).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, PREVIOUS_OVERRIDES), "utf8"))).toEqual(old);
    } finally {
      LIVE.speed = speed;
    }
  });
});

const smallFounder = loadFounders(FOUNDERS.pathname)[0]!;

describe("room held back for visitors", () => {
  it("births stop at the cap less the reserve, and a visitor's add still goes in, up to maxPopulation and no further", () => {
    expect(liveConfig.eco.birthReserve).toBe(100);
    const world = (reserve: number): LiveWorld => {
      const c = smallConfig();
      c.eco.initialPopulation = 50;
      c.eco.maxPopulation = 60;
      c.eco.birthReserve = reserve;
      c.creature.startEnergy = 1000; // everyone may give birth as soon as the cooldown allows
      return new LiveWorld(c, null);
    };
    const open = world(0);
    let grew = 0;
    for (let i = 0; i < 400; i++) {
      open.step();
      grew = Math.max(grew, open.eco.population);
    }
    expect(grew).toBe(60); // without a reserve births fill the world
    const live = world(10);
    let most = 0;
    for (let i = 0; i < 400; i++) {
      live.step();
      most = Math.max(most, live.eco.population);
    }
    expect(most).toBe(50);
    expect(live.eco.population).toBe(50); // held at the cap less the reserve
    let k = 0;
    const add = (copies: number) => live.addCreatures({ plan: smallFounder.plan, genome: smallFounder.genome, birth: { energy: 150, cost: 70, cooldown: 10 }, name: `Kiwi${++k}`, hue: 10, copies }, seq(copies));
    for (let i = 0; i < 3; i++) expect("ids" in add(3)).toBe(true); // 59
    expect("ids" in add(1)).toBe(true); // 60, the cap
    expect(live.eco.population).toBe(60);
    expect(add(1)).toEqual({ reason: "the world is full, try again later" });
    // The admin may move the reserve, but never to the whole population.
    expect(applyTunables(live.eco, { "eco.birthReserve": 59 })).toBeNull();
    expect(applyTunables(live.eco, { "eco.birthReserve": 60 })).toMatch(/birthReserve must be below/);
    expect(applyTunables(live.eco, { "eco.birthReserve": 1001 })).toMatch(/birthReserve/);
  });
});

describe("catch-up of a new viewer", () => {
  it("gets a full item set over 300 kB from the connect allowance, before any creature frame", async () => {
    const c = smallConfig();
    c.world.width = 12000;
    c.world.height = 7500;
    c.world.foodDensity = 10; // 90 000 items
    c.eco.initialPopulation = 20;
    const world = new LiveWorld(c, null);
    expect(world.itemsSize()).toBeGreaterThan(300_000);
    expect(LIMITS.connectBurstBytes).toBeGreaterThan(world.itemsSize() + 3000 * 19);
    const port = 62460;
    const pub = startPublic("127.0.0.1", port, world);
    try {
      await new Promise<void>((r) => (pub.http.listening ? r() : pub.http.once("listening", () => r())));
      await new Promise((r) => setTimeout(r, 700)); // a creature frame to go with the set
      const first = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
        ws.on("message", (d: Buffer, isBinary: boolean) => {
          if (!isBinary) return;
          ws.close();
          resolve(d[0]!); // the first binary message: 2 is the item set, from the connect allowance; 1 a creature frame while the set waits
        });
        ws.on("error", reject);
      });
      expect(first).toBe(2);
    } finally {
      pub.close();
    }
  }, 60_000);
});

describe("the first save of a fresh world", () => {
  it("is written right after the seeding, so a crash before the 4-hourly save restores the seeded world", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const founders = loadFounders(FOUNDERS.pathname);
    const fresh = freshSmall();
    const lines: string[] = [];
    await openWorld(new Saves(fresh, store), fresh, dir, founders, (l) => lines.push(l));
    expect(store.list()).toHaveLength(1);
    expect(lines.at(-1)).toMatch(/^saved world-/);
    // The crash: a new process restores that save rather than seeding another world.
    const again = freshSmall();
    const later: string[] = [];
    await openWorld(new Saves(again, store), again, dir, founders, (l) => later.push(l));
    expect(later[0]).toMatch(/^restored world-/);
    expect(again.eco.population).toBe(fresh.eco.population);
  });

  it("that fails is logged, and the world runs on", async () => {
    class NoDisk extends Saves {
      override save(): Promise<string> {
        return Promise.reject(new Error("not saved: disk full"));
      }
    }
    const fresh = freshSmall();
    const lines: string[] = [];
    const dir = tmp();
    await openWorld(new NoDisk(fresh, new StateStore(dir)), fresh, dir, loadFounders(FOUNDERS.pathname), (l) => lines.push(l));
    expect(lines.at(-1)).toBe("not saved: disk full");
    expect(fresh.eco.population).toBeGreaterThan(0);
    fresh.step();
  });
});

describe("the page's map worker", () => {
  // A worker that never answers, and counts its ends.
  const silent = () => {
    const w = { terminated: 0, postMessage() {}, terminate() { w.terminated++; }, onmessage: null, onerror: null };
    return w;
  };

  it("is given up after the timeout: terminated, and null", async () => {
    expect(MAP_TIMEOUT_MS).toBe(60_000);
    const w = silent();
    const t0 = Date.now();
    expect(await loadMapTerrain("inland-sea", liveConfig.world.width, liveConfig.world.height, 50, () => w as never)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(w.terminated).toBe(1);
  });

  it("a failed build is forgotten, so the next hello builds again; a good one is kept", async () => {
    let calls = 0;
    let answer: Terrain | null = null;
    const cache = new MapCache(async () => {
      calls++;
      return answer;
    });
    expect(await cache.get("inland-sea", liveConfig.world.width, liveConfig.world.height)).toBeNull();
    await Promise.resolve();
    answer = { width: liveConfig.world.width } as Terrain;
    expect(await cache.get("inland-sea", liveConfig.world.width, liveConfig.world.height)).toBe(answer);
    expect(await cache.get("inland-sea", liveConfig.world.width, liveConfig.world.height)).toBe(answer);
    expect(calls).toBe(2);
  });
});
