import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { withFileLock } from "../../src/typescript/src/cliArgs.ts";
import { ENVS } from "../../src/typescript/src/sim/rl/envs.ts";
import { parseLibrary } from "../../src/typescript/src/sim/rl/library.ts";

vi.setConfig({ testTimeout: 60_000 }); // each case starts a node process
const root = process.cwd(); // vitest runs from src/typescript
const cache = resolve(root, "node_modules/.cache/cli-args-test");
const made: string[] = [];
const scratchDir = () => { mkdirSync(cache, { recursive: true }); const dir = mkdtempSync(resolve(cache, "t-")); made.push(dir); return dir; };
const run = (script: string, ...args: string[]) =>
  new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile(process.execPath, [`src/${script}.ts`, ...args], { cwd: root, encoding: "utf8" }, (error, out, err) => done({ code: error ? Number(error.code) : 0, out, err }));
  });
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

const libraryFile = JSON.parse(readFileSync(resolve(root, "public/rl/library.json"), "utf8"));

describe("the shipped RL library", () => {
  it("has trained entries for every library rival source of the built-in envs", () => {
    const sources = new Set(ENVS.flatMap((e) => (e.rivals ?? []).map((r) => r.source)).filter((s) => s.startsWith("library:")).map((s) => s.slice(8)));
    expect(sources.size).toBeGreaterThan(0);
    const library = parseLibrary(libraryFile);
    for (const id of sources) expect(library[id]?.length, `library entry ${id}`).toBeGreaterThan(0);
  });
});

describe("rlGrad", () => {
  it("scores against the library rivals, as rlTrain does", async () => {
    const dir = scratchDir();
    const empty = resolve(dir, "empty.json");
    writeFileSync(empty, JSON.stringify({ version: 1, envs: {} }));
    const args = ["--env", "escape", "--seconds", "0", "--eval", "2"];
    const withLibrary = await run("rlGrad", ...args);
    const without = await run("rlGrad", ...args, "--library", empty);
    expect(withLibrary.code).toBe(0);
    expect(without.code).toBe(0);
    const start = (r: { out: string }) => /held-out (-?[\d.]+) on 2 seeds/.exec(r.out)![1];
    expect(start(withLibrary)).not.toBe(start(without)); // escape plays library:aggressor, or random rivals when there is none
  });

  it("creates the folder of --out and refuses a bad number or a missing pool", async () => {
    const dir = scratchDir();
    const out = resolve(dir, "a/b/learner.json");
    const ok = await run("rlGrad", "--env", "nibble", "--seconds", "0", "--eval", "1", "--out", out);
    expect(ok.code).toBe(0);
    expect(existsSync(out)).toBe(true);
    const nan = await run("rlGrad", "--seconds", "abc");
    expect(nan.code).toBe(1);
    expect(nan.err).toContain("--seconds");
    const pool = await run("rlGrad", "--pool", resolve(dir, "nope.json"));
    expect(pool.code).toBe(1);
    expect(pool.err).toContain("--pool");
    const env = await run("rlGrad", "--env", "typo");
    expect(env.code).toBe(1);
  });
});

describe("other tools", () => {
  it("rlTrain refuses NaN flags and a missing explicit library", async () => {
    const dir = scratchDir();
    const budget = await run("rlTrain", "--budget", "3600s");
    expect(budget.code).toBe(1);
    expect(budget.err).toContain("--budget");
    const library = await run("rlTrain", "--library", resolve(dir, "nope.json"));
    expect(library.code).toBe(1);
    expect(library.err).toContain("--library");
  });

  it("rlBench and ecoBench refuse a typo env and a NaN number", async () => {
    const env = await run("rlBench", "--env", "typo", "--reps", "1");
    expect(env.code).toBe(1);
    expect(env.err).toContain("typo");
    const seconds = await run("ecoBench", "--seconds", "abc");
    expect(seconds.code).toBe(1);
    expect(seconds.err).toContain("--seconds");
  });

  it("rlTrain --save writes a new library atomically, with no lock or temp file left", async () => {
    const dir = scratchDir();
    const library = resolve(dir, "new/library.json");
    const r = await run("rlTrain", "--env", "nibble", "--from", "random:1", "--iters", "1", "--pairs", "1", "--episodes", "1", "--eval", "1", "--every", "1", "--threads", "1", "--save", "--library", library);
    expect(r.code).toBe(0);
    expect(parseLibrary(JSON.parse(readFileSync(library, "utf8")))["nibble"]).toHaveLength(1);
    expect(existsSync(`${library}.lock`)).toBe(false);
    expect(existsSync(`${library}.tmp`)).toBe(false);
  });
});

describe("withFileLock", () => {
  it("runs the function, releases the lock, and refuses a second holder", () => {
    const file = resolve(scratchDir(), "shared.json");
    expect(withFileLock(file, () => {
      expect(existsSync(`${file}.lock`)).toBe(true);
      expect(() => withFileLock(file, () => 0, 60_000, 100)).toThrow("locked");
      return 7;
    })).toBe(7);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("takes over the lock of a crashed holder and releases it when the function throws", () => {
    const file = resolve(scratchDir(), "shared.json");
    writeFileSync(`${file}.lock`, "");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(`${file}.lock`, old, old);
    expect(() => withFileLock(file, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
});
