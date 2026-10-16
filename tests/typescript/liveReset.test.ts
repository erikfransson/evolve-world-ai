// @vitest-environment node
// @ts-expect-error the web tsconfig finds no types for the server's ws
import { WebSocket } from "../../server/node_modules/ws/wrapper.mjs";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAdmin } from "../../server/src/admin.ts";
import { loadFounders } from "../../server/src/founders.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { MAX_KEPT_RESETS, SEED_FILE, Saves, openWorld } from "../../server/src/saves.ts";
import { StateStore } from "../../server/src/state.ts";
import { smallConfig } from "./liveHelpers.ts";

const FOUNDERS = loadFounders(new URL("../../src/typescript/public/live-founders.json", import.meta.url).pathname);
const tmp = (): string => mkdtempSync(join(tmpdir(), "evolve-reset-"));
const freshConfig = () => {
  const c = smallConfig();
  c.eco.initialPopulation = 0; // as liveConfig: a fresh world is seeded with the founders
  return c;
};
const quiet = (): void => {};

// A running world with saves and admin settings on disk, as on the server.
async function running(dir: string): Promise<{ live: LiveWorld; saves: Saves; store: StateStore }> {
  const store = new StateStore(dir);
  const live = new LiveWorld(freshConfig(), null);
  const saves = new Saves(live, store);
  await openWorld(saves, live, dir, FOUNDERS, quiet);
  for (let i = 0; i < 5; i++) live.eco.step();
  await saves.save();
  writeFileSync(join(dir, "admin-overrides.json"), JSON.stringify({ "eco.hueDrift": 10 }));
  return { live, saves, store };
}

describe("admin reset", () => {
  it("keeps the old world's saves and settings in a folder that is never restored, and the next start seeds N copies of each founder", async () => {
    const dir = tmp();
    const { live, saves, store } = await running(dir);
    const before = store.list().map((s) => s.name);
    expect(before.length).toBe(2); // the fresh world's first save and one more
    const line = await saves.reset(dir, 25, FOUNDERS.length, new Date("2026-10-16T08:00:00.000Z"));
    expect(line).toMatch(/3 saves and the admin settings moved to before-reset-2026-10-16T08-00-00-000Z; the next start seeds 25 of each founder/);
    const kept = join(dir, "before-reset-2026-10-16T08-00-00-000Z");
    expect(readdirSync(kept).filter((n) => n.endsWith(".json.gz")).length).toBe(3); // the two before, and the one the reset saved
    for (const n of before) expect(existsSync(join(kept, n))).toBe(true);
    expect(existsSync(join(kept, "admin-overrides.json"))).toBe(true);
    expect(store.list()).toEqual([]);
    expect(readFileSync(join(dir, SEED_FILE), "utf8").trim()).toBe("25");
    await expect(saves.save()).rejects.toThrow(/being reset/); // nothing lands next to the kept world before the exit
    expect(store.list()).toEqual([]);
    expect(live.eco.tick).toBeGreaterThan(0);

    // The next start: no save of this world is listed, so a fresh world with 25 of each founder, and no old settings applied.
    const next = new LiveWorld(freshConfig(), null);
    const lines: string[] = [];
    const overrides = await openWorld(new Saves(next, new StateStore(dir)), next, dir, FOUNDERS, (l) => lines.push(l));
    expect(overrides).toEqual({});
    expect(next.eco.tick).toBe(0);
    expect(next.eco.population).toBe(25 * FOUNDERS.length);
    expect(next.seedCopies).toBe(25);
    expect(lines.some((l) => /fresh world seeded with \d+ creatures, 25 of each/.test(l))).toBe(true);
    expect(readdirSync(kept).filter((n) => n.endsWith(".json.gz")).length).toBe(3); // untouched

    // A restart later restores the fresh world, never one from the kept folder, and still reports its seed.
    for (let i = 0; i < 3; i++) next.eco.step();
    await new Saves(next, new StateStore(dir)).save();
    const again = new LiveWorld(freshConfig(), null);
    await openWorld(new Saves(again, new StateStore(dir)), again, dir, FOUNDERS, quiet);
    expect(again.eco.tick).toBe(next.eco.tick);
    expect(again.seedCopies).toBe(25);
    expect(again.hello(100).summary.seedCopies).toBe(25);
  });

  it("refuses copies that are not whole, below 1, or past the room below the birth reserve, moving nothing and saving on", async () => {
    const dir = tmp();
    const { saves, store } = await running(dir);
    const n = FOUNDERS.length;
    const most = Math.floor((3000 - 100) / n);
    for (const bad of [0, -1, 1.5, Number.NaN, most + 1, 1e9]) await expect(saves.reset(dir, bad, n), String(bad)).rejects.toThrow(`copies must be a whole number from 1 to ${most}`);
    expect(store.list().length).toBe(2);
    expect(readdirSync(dir).some((f) => f.startsWith("before-reset-"))).toBe(false);
    await expect(saves.save()).resolves.toMatch(/^saved /);
  });

  it("a reset that fails after some saves moved saves the running world again at once, so a restart restores it and not a fresh world", async () => {
    const dir = tmp();
    const { live, saves, store } = await running(dir);
    vi.spyOn(store, "moveAside").mockImplementation((sub) => {
      for (const s of store.list()) renameSync(join(dir, s.name), join(dir, `moved-${s.name}`)); // out of the listing, as a part-way move leaves them
      throw new Error(`disk trouble in ${sub}`);
    });
    await expect(saves.reset(dir, 25, FOUNDERS.length)).rejects.toThrow(/reset stopped part-way, the world runs on, saved world-.*disk trouble/);
    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.tick).toBe(live.eco.tick);
    await expect(saves.save()).resolves.toMatch(/^saved /); // saving goes on
  });

  it("an extinct world's reseed seeds the reset's count, cut to the room the admin left below the birth reserve", () => {
    const c = freshConfig();
    c.eco.maxPopulation = 300;
    c.eco.birthReserve = 100; // room for 200
    const live = new LiveWorld(c, null);
    live.founders = FOUNDERS;
    live.seedCopies = 200;
    (live as unknown as { reseed(): void }).reseed();
    expect(live.eco.population).toBe(Math.floor(200 / FOUNDERS.length) * FOUNDERS.length);
  });

  it("seedFounders itself keeps the founders below the birth reserve, whatever the caller checked", () => {
    const live = new LiveWorld(freshConfig(), null);
    const room = live.eco.config.eco.maxPopulation - live.eco.config.eco.birthReserve;
    expect(() => live.seedFounders(FOUNDERS, Math.random, Math.floor(room / FOUNDERS.length) + 1)).toThrow(/do not fit below the birth reserve/);
    expect(live.eco.population).toBe(0);
  });

  it(`refuses a reset while ${MAX_KEPT_RESETS} reset folders are kept, so resets cannot fill the disk`, async () => {
    const dir = tmp();
    const { saves } = await running(dir);
    for (let k = 0; k < MAX_KEPT_RESETS; k++) await saves.reset(dir, 10, FOUNDERS.length, new Date(Date.UTC(2026, 9, 16, 8, k))).then(() => (saves as unknown as { resetting: boolean }).resetting = false);
    await expect(saves.reset(dir, 10, FOUNDERS.length, new Date(Date.UTC(2026, 9, 16, 9)))).rejects.toThrow(/before-reset folders are kept/);
  });

  it("a seed file that is not a valid count is ignored at the next fresh start: the default copies, with a log line", async () => {
    const dir = tmp();
    writeFileSync(join(dir, SEED_FILE), "5000\n");
    const live = new LiveWorld(freshConfig(), null);
    const lines: string[] = [];
    await openWorld(new Saves(live, new StateStore(dir)), live, dir, FOUNDERS, (l) => lines.push(l));
    expect(live.eco.population).toBe(10 * FOUNDERS.length);
    expect(lines.some((l) => /seed-copies ignored/.test(l))).toBe(true);
  });

  it("over the admin channel: needs the token, takes only whole copies, and passes them on", async () => {
    const dir = tmp();
    const world = new LiveWorld(smallConfig(), null);
    const asked: number[] = [];
    const admin = startAdmin("127.0.0.1", 62531, "tok", world, dir, dir, {}, { pause() {}, resume() {}, paused: () => false, saveNow: async () => "", listSaves: () => [], loadSave: async () => "", stop() {}, blankName: async () => 0, renameName: async () => 0, reset: async (c) => (asked.push(c), `reset to ${c}`) });
    try {
      const open = async (): Promise<{ ws: WebSocket; replies: { t: string; message?: string }[]; closed: Promise<number> }> => {
        const ws = new WebSocket("ws://127.0.0.1:62531/");
        const replies: { t: string; message?: string }[] = [];
        ws.on("message", (d: Buffer) => replies.push(JSON.parse(d.toString())));
        const closed = new Promise<number>((r) => ws.on("close", (code: number) => r(code)));
        await new Promise((r) => ws.on("open", r));
        return { ws, replies, closed };
      };
      const stranger = await open();
      stranger.ws.send(JSON.stringify({ t: "reset", copies: 200 }));
      expect(await stranger.closed).toBe(1008);
      const owner = await open();
      owner.ws.send(JSON.stringify({ t: "auth", token: "tok" }));
      for (const copies of ["200", 1.5, null, [200], { n: 1 }]) owner.ws.send(JSON.stringify({ t: "reset", copies }));
      owner.ws.send(JSON.stringify({ t: "reset" }));
      owner.ws.send(JSON.stringify({ t: "reset", copies: 200 }));
      await vi.waitFor(() => expect(owner.replies).toHaveLength(8));
      expect(owner.replies.slice(1, 6).every((r) => r.t === "error" && r.message === "copies must be a whole number")).toBe(true);
      expect(owner.replies.slice(6)).toEqual([{ t: "resetting", message: "reset to 10" }, { t: "resetting", message: "reset to 200" }]);
      expect(asked).toEqual([10, 200]);
      owner.ws.close();
    } finally {
      admin.close();
    }
  });
});
