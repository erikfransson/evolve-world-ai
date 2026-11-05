// @vitest-environment node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "../../server/src/config.ts";
import { KEEP_IN_BUDGET, SEED_FILE, StateStore, pruneLine, saveName } from "../../server/src/state.ts";

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
    const { gone } = store.prune(at(45).getTime());
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

  // Red before review 2: the whole newest reset folder went when the newest saves alone filled the budget.
  it("never deletes the newest reset folder or its newest save, and says the budget does not hold", () => {
    LIMITS.maxStateBytes = 51 * MB; // the sidecars and seed file take a few bytes
    const dir = mkdtempSync(join(tmpdir(), "evolve-budget-"));
    const f = folder(dir, 10, [10 * MB, 10 * MB]);
    put(dir, 20, 20 * MB);
    put(dir, 21, 20 * MB);
    const store = new StateStore(dir);
    expect(store.prune(at(22).getTime())).toMatchObject({ gone: [expect.stringContaining(f)], over: false }); // the folder's older save
    put(dir, 23, 25 * MB);
    put(dir, 24, 25 * MB);
    const p = store.prune(at(25).getTime());
    expect(p.over).toBe(true);
    expect(p.gone).not.toContain(f);
    expect(readdirSync(join(dir, f)).filter((n) => n.endsWith(".json.gz"))).toHaveLength(1);
    expect(store.list()).toHaveLength(KEEP_IN_BUDGET);
    expect(pruneLine(p)).toMatch(/still over budget/);
  });

  // Red before review 2: folders were taken by name, so one stamped in the future counted as the newest and the reset's own folder went.
  it("keeps future-stamped folders and the folder a reset just made", () => {
    LIMITS.maxStateBytes = 30 * MB;
    const dir = mkdtempSync(join(tmpdir(), "evolve-budget-"));
    const future = folder(dir, 24 * 400, [20 * MB]); // a year ahead
    const made = folder(dir, 5, [20 * MB]); // made now by a clock that was behind
    const older = folder(dir, 8, [20 * MB]);
    const p = new StateStore(dir).prune(at(9).getTime(), made);
    expect(p.gone).toEqual([older]);
    expect(existsSync(join(dir, future)) && existsSync(join(dir, made))).toBe(true);
  });

  // Red before review 2: a delete that failed part-way threw, and the folders already deleted were never logged.
  it("reports what it deleted when a delete fails part-way", () => {
    LIMITS.maxStateBytes = 10 * MB;
    const dir = mkdtempSync(join(tmpdir(), "evolve-budget-"));
    const a = folder(dir, 10, [20 * MB]);
    const b = folder(dir, 20, [20 * MB]);
    folder(dir, 30, [1 * MB]);
    mkdirSync(join(dir, b, "locked"));
    writeFileSync(join(dir, b, "locked", "x"), "x");
    chmodSync(join(dir, b, "locked"), 0o500);
    try {
      const p = new StateStore(dir).prune(at(31).getTime());
      expect(p.gone).toEqual([a]);
      expect(p.error).toBeTruthy();
      expect(pruneLine(p)).toMatch(new RegExp(`deleted ${a}.*stopped by an error`));
    } finally {
      chmodSync(join(dir, b, "locked"), 0o700);
    }
  });
});
