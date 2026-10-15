// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { LIMITS } from "../../server/src/config.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { Saves, openWorld } from "../../server/src/saves.ts";
import { loadFounders } from "../../server/src/founders.ts";
import { loadOverrides } from "../../server/src/admin.ts";
import { StateStore, readRegularFile, saveName } from "../../server/src/state.ts";
import { smallConfig } from "./liveHelpers.ts";

const FOUNDERS = new URL("../../src/typescript/public/live-founders.json", import.meta.url);

const tmp = (): string => mkdtempSync(join(tmpdir(), "evolve-saves-"));
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const at = (daysAgo: number): Date => new Date(NOW - daysAgo * DAY);
const world = (ticks = 20): LiveWorld => {
  const w = new LiveWorld(smallConfig(), null);
  for (let i = 0; i < ticks; i++) w.eco.step();
  return w;
};
const json = (w: LiveWorld): string => JSON.stringify(w.saveState());
const meta = (w: LiveWorld) => ({ population: w.eco.population, tick: w.eco.tick });

describe("saves", () => {
  it("round trips a world through a gzip file", async () => {
    const store = new StateStore(tmp());
    const a = world();
    const m = meta(a);
    const name = await store.write(json(a), m, at(0));
    expect(name).toBe(saveName(at(0)));
    const b = new LiveWorld(smallConfig(), null);
    b.restoreState(await store.read(name));
    expect(b.eco.fingerprint()).toBe(a.eco.fingerprint());
    for (let i = 0; i < 10; i++) {
      a.eco.step();
      b.eco.step();
    }
    expect(b.eco.fingerprint()).toBe(a.eco.fingerprint()); // continues in step
    expect(store.list()[0]).toMatchObject({ name, population: m.population, tick: m.tick, time: "2026-10-11T12:00:00.000Z" });
  });

  it("lists newest first with size and population from the sidecar, without reading the saves", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const w = world();
    await store.write(json(w), meta(w), at(1));
    await store.write(json(w), { population: 7, tick: 9 }, at(0));
    const list = store.list();
    expect(list.map((s) => s.name)).toEqual([saveName(at(0)), saveName(at(1))]);
    expect(list[0]).toMatchObject({ population: 7, tick: 9 });
    expect(list[0]!.bytes).toBeGreaterThan(100);
  });

  it("rotation deletes old matching saves beyond the newest six, and touches nothing else", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const days = [30, 9, 8, 7, 6, 5, 4.5, 3, 1];
    for (const d of days) await store.write("{}", { population: 1, tick: 1 }, at(d)); // each write rotates against its own time
    writeFileSync(join(dir, "admin-token"), "x");
    writeFileSync(join(dir, "world-old.json.gz"), "x"); // not the generated pattern
    writeFileSync(join(dir, "world-2020-01-01T00-00-00-000Z.json.gz.bak"), "x");
    store.rotate(NOW);
    const left = readdirSync(dir).sort();
    for (const d of [7, 6, 5, 4.5, 3, 1]) expect(left).toContain(saveName(at(d))); // the newest six, some older than 4 days
    for (const d of [30, 9, 8]) expect(left).not.toContain(saveName(at(d)));
    expect(left).toEqual(expect.arrayContaining(["admin-token", "world-old.json.gz", "world-2020-01-01T00-00-00-000Z.json.gz.bak"]));
    expect(left.filter((n) => n.endsWith(".meta.json")).length).toBe(6); // sidecars follow their saves
  });

  it("keeps the six newest saves after the host was off for more than four days", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const days = [40, 30, 20, 19, 18, 17, 16, 15];
    for (const d of days) await store.write("{}", { population: 1, tick: 1 }, at(d));
    store.rotate(NOW);
    expect(store.list().map((s) => s.name)).toEqual([15, 16, 17, 18, 19, 20].map((d) => saveName(at(d))));
  });

  it("ignores a save stamped in the future: not listed, not restored, not counted or deleted by rotation", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const w = world(5);
    await store.write(json(w), meta(w), at(1));
    const future = saveName(new Date(Date.now() + 3600_000));
    writeFileSync(join(dir, future), gzipSync(json(world(9))));
    expect(store.list().map((s) => s.name)).toEqual([saveName(at(1))]);
    await expect(store.read(future)).rejects.toThrow(/no such save/);
    const live = new LiveWorld(smallConfig(), null);
    await new Saves(live, store).restoreNewest(() => {});
    expect(live.eco.tick).toBe(w.eco.tick);
    store.rotate(Date.now());
    expect(existsSync(join(dir, future))).toBe(true);
    expect(existsSync(join(dir, saveName(at(1))))).toBe(true);
  });

  it("refuses a save that is a symlink or a FIFO", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const w = world(5);
    const real = join(tmp(), "real.json.gz");
    writeFileSync(real, gzipSync(json(w)));
    symlinkSync(real, join(dir, saveName(at(1))));
    execFileSync("mkfifo", [join(dir, saveName(at(2)))]);
    expect(store.list()).toEqual([]);
    await expect(store.read(saveName(at(1)))).rejects.toThrow(/no such save/);
    await expect(store.read(saveName(at(2)))).rejects.toThrow(/no such save/);
    expect(() => readRegularFile(join(dir, saveName(at(1))), 1e6)).toThrow(/regular file/);
    expect(() => readRegularFile(join(dir, saveName(at(2))), 1e6)).toThrow(/regular file/); // returns at once, no blocking open
  });

  it("refuses to write a save larger than it may read back, and says so loudly", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const cap = LIMITS.maxSaveJsonBytes;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    LIMITS.maxSaveJsonBytes = 1000;
    try {
      await expect(new Saves(world(5), store).save()).rejects.toThrow(/not saved.*over the/);
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/^SAVE REFUSED/));
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      LIMITS.maxSaveJsonBytes = cap;
      err.mockRestore();
    }
  });

  it("a 10 kB gzip of millions of empty objects is refused in the parser, the server stays up", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const bomb = gzipSync('{"version":1,"lineages":[' + "{},".repeat(3_333_332) + "{}]}");
    expect(bomb.length).toBeLessThan(12_000);
    writeFileSync(join(dir, saveName(at(1))), bomb);
    const rss = process.memoryUsage().rss;
    await expect(store.read(saveName(at(1)))).rejects.toThrow(/too many JSON values/);
    expect(process.memoryUsage().rss - rss).toBeLessThan(300e6);
  });

  it("refuses names that are not a generated save in the listing", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const w = world();
    const live = new LiveWorld(smallConfig(), null);
    const saves = new Saves(live, store);
    await store.write(json(w), meta(w), at(2));
    writeFileSync(join(dir, "secret.json.gz"), gzipSync("{}"));
    const missing = saveName(at(9));
    for (const bad of ["../x", "../../etc/passwd", join(dir, saveName(at(2))), "secret.json.gz", missing, `${saveName(at(2))}/../${saveName(at(2))}`, "", 5, null, { toString: () => saveName(at(2)) }]) {
      await expect(saves.load(bad), String(bad)).rejects.toThrow(/no such save/);
      await expect(store.read(bad)).rejects.toThrow();
    }
    expect(existsSync(join(dir, saveName(at(2))))).toBe(true);
  });

  it("load saves the running world first, then restores the named one", async () => {
    const store = new StateStore(tmp());
    const old = world(10);
    await store.write(json(old), meta(old), at(1));
    const live = world(50);
    const tickBefore = live.eco.tick;
    let hellos = 0;
    live.onReseed = () => hellos++;
    const line = await new Saves(live, store).load(saveName(at(1)));
    expect(line).toMatch(/^loaded /);
    expect(live.eco.tick).toBe(old.eco.tick);
    expect(hellos).toBe(1);
    expect(store.list().some((s) => s.tick === tickBefore)).toBe(true); // the world it replaced was saved
  });

  it("a failed load keeps the running world", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    writeFileSync(join(dir, saveName(at(1))), "not gzip");
    const live = world(30);
    const fp = live.eco.fingerprint();
    await expect(new Saves(live, store).load(saveName(at(1)))).rejects.toThrow();
    expect(live.eco.fingerprint()).toBe(fp);
  });

  it("startup falls back past a corrupted or truncated save to an older one, and never starts over on top of unreadable saves", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const good = world(15);
    await store.write(json(good), meta(good), at(3));
    await store.write(json(good), meta(good), at(2));
    await store.write(json(good), meta(good), at(1));
    truncateSync(join(dir, saveName(at(1))), 40); // cut short
    writeFileSync(join(dir, saveName(at(2))), "garbage"); // not gzip
    const lines: string[] = [];
    const live = new LiveWorld(smallConfig(), null);
    await new Saves(live, store).restoreNewest((l) => lines.push(l));
    expect(live.eco.tick).toBe(good.eco.tick);
    expect(lines.filter((l) => l.startsWith("cannot restore")).length).toBe(2);
    expect(lines.at(-1)).toContain(`restored ${saveName(at(3))}`);

    truncateSync(join(dir, saveName(at(3))), 40);
    const fresh = new LiveWorld(smallConfig(), null);
    const out: string[] = [];
    expect(await new Saves(fresh, store).restoreNewest((l) => out.push(l))).toBe("unreadable");
    expect(fresh.eco.tick).toBe(0);
    expect(out.some((l) => /fresh world/.test(l))).toBe(false);
  });

  it("startup tries at most 3 saves of this world, and never takes saves the listing hides for an empty store", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const good = world(5);
    for (let d = 1; d <= 4; d++) await store.write(json(good), meta(good), at(d));
    for (let d = 1; d <= 4; d++) writeFileSync(join(dir, saveName(at(d))), "garbage");
    const lines: string[] = [];
    expect(await new Saves(new LiveWorld(smallConfig(), null), store).restoreNewest((l) => lines.push(l))).toBe("unreadable");
    expect(lines.filter((l) => l.startsWith("cannot restore"))).toHaveLength(3);

    const ahead = tmp(); // a clock an hour behind at boot: every real save looks stamped in the future
    const later = new StateStore(ahead);
    await later.write(json(good), meta(good), new Date(Date.now() + 3_600_000));
    expect(later.list()).toEqual([]);
    const out: string[] = [];
    expect(await new Saves(new LiveWorld(smallConfig(), null), later).restoreNewest((l) => out.push(l))).toBe("unreadable");
    expect(out.at(-1)).toMatch(/not listed/);

    // The newest listed save is of an earlier world (a recent move to a new map) while this world's saves are hidden: still no fresh world.
    const other = new LiveWorld(smallConfig(), null);
    other.config.world.width = 2100;
    other.eco.config.world.width = 2100;
    await later.write(JSON.stringify(other.saveState()), meta(good), at(5));
    expect(later.list()).toHaveLength(1);
    expect(await new Saves(new LiveWorld(smallConfig(), null), later).restoreNewest(() => {})).toBe("unreadable");

    // A save of this world that fails, then one of an earlier world: the failed one may be the running world's.
    const mixed = tmp();
    const both = new StateStore(mixed);
    await both.write(JSON.stringify(other.saveState()), meta(good), at(2));
    await both.write(json(good), meta(good), at(1));
    writeFileSync(join(mixed, saveName(at(1))), "garbage");
    expect(await new Saves(new LiveWorld(smallConfig(), null), both).restoreNewest(() => {})).toBe("unreadable");
  }, 120_000); // a dozen parse workers

  it("a restore keeps a birth reserve below the population cap, so births can go on", () => {
    const w = world(5);
    const state = w.saveState();
    state.config.eco.maxPopulation = 50;
    state.config.eco.birthReserve = 50;
    const live = new LiveWorld(smallConfig(), null);
    live.restoreState(JSON.parse(JSON.stringify(state)));
    expect([live.eco.config.eco.maxPopulation, live.eco.config.eco.birthReserve]).toEqual([50, 49]);
  });

  it("admin overrides that no longer apply are ignored loudly and kept aside, not lost", () => {
    const dir = tmp();
    const bad = { "eco.maxPopulation": 50, "eco.birthReserve": 50 };
    writeFileSync(join(dir, "admin-overrides.json"), JSON.stringify(bad));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(loadOverrides(dir, new LiveWorld(smallConfig(), null))).toEqual({});
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/^OVERRIDES IGNORED/));
    } finally {
      err.mockRestore();
    }
    expect(JSON.parse(readFileSync(join(dir, "admin-overrides.ignored.json"), "utf8"))).toEqual(bad);
  });

  it("a save of this world that fails to restore (a worker out of memory, a timeout) seeds, saves and retires nothing: startup throws", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const good = world(15);
    await store.write(json(good), meta(good), at(1));
    writeFileSync(join(dir, "admin-overrides.json"), JSON.stringify({ speed: 2 }));
    const names = store.list().map((s) => s.name);
    const live = new LiveWorld(smallConfig(), null);
    vi.spyOn(store, "read").mockRejectedValue(new Error("save parse worker ran out of memory"));
    try {
      await expect(openWorld(new Saves(live, store), live, dir, loadFounders(FOUNDERS.pathname), () => {})).rejects.toThrow(/none restores/);
    } finally {
      vi.restoreAllMocks();
    }
    expect(store.list().map((s) => s.name)).toEqual(names);
    expect(existsSync(join(dir, "admin-overrides.json"))).toBe(true);
    expect(live.eco.tick).toBe(0);
  });

  it("rejects a gzip bomb by the unzipped size cap", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const cap = LIMITS.maxSaveJsonBytes;
    LIMITS.maxSaveJsonBytes = 1_000_000;
    try {
      const bomb = gzipSync(Buffer.alloc(20_000_000, 0x20)); // 20 MB of spaces, a few kB zipped
      expect(bomb.length).toBeLessThan(100_000);
      writeFileSync(join(dir, saveName(at(1))), bomb);
      await expect(store.read(saveName(at(1)))).rejects.toThrow(/larger than|too big|maxOutputLength|Cannot create/i);
    } finally {
      LIMITS.maxSaveJsonBytes = cap;
    }
  });

  it("refuses to write when the state directory is over the disk cap", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const cap = LIMITS.maxStateDirBytes;
    LIMITS.maxStateDirBytes = 1000;
    try {
      writeFileSync(join(dir, "filler"), Buffer.alloc(2000));
      await expect(store.write("{}", { population: 1, tick: 1 }, at(0))).rejects.toThrow(/cap/);
      expect(readdirSync(dir)).toEqual(["filler"]);
      const live = world(5);
      await expect(new Saves(live, store).save()).rejects.toThrow(/not saved.*cap/);
    } finally {
      LIMITS.maxStateDirBytes = cap;
    }
  });

  it("saves the same with synchronous and asynchronous gzip", async () => {
    const store = new StateStore(tmp());
    const w = world(5);
    await store.write(json(w), meta(w), at(0), false);
    const a = await store.read(saveName(at(0)));
    await store.write(json(w), meta(w), at(1), true);
    expect(await store.read(saveName(at(1)))).toEqual(a);
  });
});

describe("save parsing", () => {
  it("returns the state rebuilt from the checked world, without extra keys from the file", async () => {
    const { parseSave } = await import("../../server/src/saveParse.ts");
    const w = new LiveWorld(smallConfig(), null);
    for (let i = 0; i < 5; i++) w.eco.step();
    const crafted = { ...JSON.parse(json(w)), junk: Array.from({ length: 1000 }, (_, i) => i) };
    const state = (await parseSave(gzipSync(JSON.stringify(crafted)), LIMITS.maxSaveJsonBytes)) as unknown as Record<string, unknown>;
    expect(state.junk).toBeUndefined();
    expect(Object.keys(state).sort()).toEqual(Object.keys(JSON.parse(json(w))).sort());
  });

  it("in verify-only mode checks the same and sends no state back", async () => {
    const { parseSave } = await import("../../server/src/saveParse.ts");
    const good = json(world(5));
    await expect(parseSave(gzipSync(good), LIMITS.maxSaveJsonBytes, true)).resolves.toBeUndefined();
    const bad = { ...JSON.parse(good), lineages: null };
    await expect(parseSave(gzipSync(JSON.stringify(bad)), LIMITS.maxSaveJsonBytes, true)).rejects.toThrow();
  });
});
