// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "../../server/src/config.ts";
import { KEEP_IN_BUDGET, SEED_FILE, StateStore, saveName } from "../../server/src/state.ts";

// The state budget: saves and before-reset folders together stay under LIMITS.maxStateBytes, whatever size a save grows to.
const MB = 1e6;
const at = (h: number): Date => new Date(Date.UTC(2026, 10, 1, h));
const put = (dir: string, h: number, bytes: number): string => {
  const name = saveName(at(h));
  writeFileSync(join(dir, name), Buffer.alloc(bytes));
  writeFileSync(join(dir, name.replace(".json.gz", ".meta.json")), "{}");
  return name;
};
const folder = (dir: string, h: number, saves: number[]): string => {
  const name = `before-reset-${at(h).toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(join(dir, name));
  saves.forEach((b, i) => put(join(dir, name), h - saves.length + i, b));
  writeFileSync(join(dir, name, SEED_FILE), "10\n");
  return name;
};
const used = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((t, e) => t + (e.isDirectory() ? used(join(dir, e.name)) : /^world-/.test(e.name) ? statSync(join(dir, e.name)).size : 0), 0);

describe("state byte budget", () => {
  const cap = LIMITS.maxStateBytes;
  afterEach(() => void (LIMITS.maxStateBytes = cap));

  // Red without prune: rotation keeps four days of saves and every reset folder, whatever their size (1.2 GB on the host, 2026-11-05).
  it("deletes the oldest reset folders, then the oldest saves, keeps the newest saves and leaves other files alone", async () => {
    LIMITS.maxStateBytes = 100 * MB;
    const dir = mkdtempSync(join(tmpdir(), "evolve-budget-"));
    const old1 = folder(dir, 10, [20 * MB, 20 * MB]);
    const old2 = folder(dir, 20, [20 * MB]);
    const newest = folder(dir, 30, [15 * MB, 15 * MB]);
    const saves = [40, 41, 42, 43, 44].map((h) => put(dir, h, 20 * MB));
    for (const f of ["admin-token", SEED_FILE, "carry.json", "overrides.json"]) writeFileSync(join(dir, f), "x");
    const store = new StateStore(dir);
    const gone = store.prune(at(45).getTime());
    expect(gone.slice(0, 2)).toEqual([old1, old2]);
    expect(existsSync(join(dir, old1)) || existsSync(join(dir, old2))).toBe(false);
    expect(used(dir)).toBeLessThanOrEqual(100 * MB);
    for (const s of saves.slice(-KEEP_IN_BUDGET)) expect(existsSync(join(dir, s))).toBe(true);
    expect(existsSync(join(dir, newest, SEED_FILE))).toBe(true); // the newest reset folder, with at least its newest save
    expect(readdirSync(join(dir, newest)).filter((n) => n.endsWith(".json.gz")).length).toBeGreaterThanOrEqual(1);
    for (const f of ["admin-token", SEED_FILE, "carry.json", "overrides.json"]) expect(existsSync(join(dir, f))).toBe(true);
    expect(gone.every((n) => !n.includes("token") && !n.includes("carry"))).toBe(true);
  });

  it("prunes after every save, and keeps the newest saves even when they alone pass the budget", async () => {
    LIMITS.maxStateBytes = 30 * MB;
    const dir = mkdtempSync(join(tmpdir(), "evolve-budget-"));
    const store = new StateStore(dir);
    const names: string[] = [];
    for (let h = 0; h < 6; h++) names.push(await store.writeGzipped(new Uint8Array(20 * MB), { population: 1, tick: h }, at(h)));
    expect(store.list().map((s) => s.name).sort()).toEqual(names.slice(-KEEP_IN_BUDGET));
  });

  it("deletes the newest reset folder only when the newest saves leave it no room", () => {
    LIMITS.maxStateBytes = 51 * MB; // the sidecars and seed file take a few bytes
    const dir = mkdtempSync(join(tmpdir(), "evolve-budget-"));
    const f = folder(dir, 10, [10 * MB, 10 * MB]);
    put(dir, 20, 20 * MB);
    put(dir, 21, 20 * MB);
    const store = new StateStore(dir);
    expect(store.prune(at(22).getTime())).toHaveLength(1); // the folder's older save
    expect(existsSync(join(dir, f))).toBe(true);
    put(dir, 23, 25 * MB);
    put(dir, 24, 25 * MB);
    const gone = store.prune(at(25).getTime());
    expect(gone).toContain(f);
    expect(store.list()).toHaveLength(KEEP_IN_BUDGET);
  });
});
