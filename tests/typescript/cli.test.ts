import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CONFIG, overrideConfig, withOverrides } from "../../src/typescript/src/sim/config.ts";
import { Evolution } from "../../src/typescript/src/sim/evolution.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { serialise } from "../../src/typescript/src/ui/settingsIO.ts";
import { parsePool } from "../../src/typescript/src/sim/seedPool.ts";
import { createNodeEvaluator, parseThreads } from "../../src/typescript/src/worker/nodePool.ts";

// Vitest runs from src/typescript, where `node src/bench.ts` and `node src/headless.ts` run as the npm scripts do.
vi.setConfig({ testTimeout: 20_000 }); // each case starts node processes, slow on a busy machine
const root = process.cwd();
const cache = resolve(root, "node_modules/.cache/cli-test");
const made: string[] = [];
// A fresh directory per test, so concurrent tests and test files never share files.
const scratchDir = () => { mkdirSync(cache, { recursive: true }); const dir = mkdtempSync(resolve(cache, "t-")); made.push(dir); return dir; };
const tiny = withOverrides(DEFAULT_CONFIG, { population: { size: 4 }, creature: { maxLifeSeconds: 5 } });

const run = (script: string, ...args: string[]) =>
  new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile(process.execPath, [`src/${script}.ts`, ...args], { cwd: root, encoding: "utf8" }, (error, out, err) =>
      done({ code: error ? Number(error.code) : 0, out, err }));
  });

afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

describe("parseThreads", () => {
  it("defaults when absent and accepts positive integers", () => {
    expect(parseThreads(undefined)).toBeGreaterThanOrEqual(1);
    expect(parseThreads("3")).toBe(3);
  });
  it.each(["0", "-1", "1.5", "abc", ""])("rejects %j", (v) => {
    expect(() => parseThreads(v)).toThrow("--threads");
  });
});

describe("node evaluator", () => {
  it("gives the same fitness on worker threads as in one thread", async () => {
    const fitness: Float64Array[] = [];
    for (const threads of [1, 2]) {
      const evaluator = createNodeEvaluator(tiny, threads);
      const { result } = await new Evolution(tiny).runGeneration(evaluator);
      evaluator.close();
      fitness.push(result.fitness);
    }
    expect(fitness[1]).toEqual(fitness[0]);
  });
});

describe.concurrent("bench.ts", () => {
  it("prints a JSON summary whose fingerprint does not depend on the thread count", async () => {
    const [a, b] = await Promise.all([run("bench", "--pop", "4", "--gens", "1", "--threads", "1"), run("bench", "--pop", "4", "--gens", "1", "--threads", "2")]);
    expect([a.code, b.code]).toEqual([0, 0]);
    const [sa, sb] = [JSON.parse(a.out), JSON.parse(b.out)];
    expect(sa).toMatchObject({ pop: 4, gens: 1, seed: 1, threads: 1 });
    expect(sa.fingerprint).toBeGreaterThan(0);
    expect(sb.fingerprint).toBe(sa.fingerprint);
  });

  it.each([["--pop", "0"], ["--threads", "0"]])("exits with an error for %s %s", async (flag, value) => {
    const r = await run("bench", flag, value);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^error: /);
  });
});

describe.concurrent("headless.ts", () => {
  it("writes the config and one line per generation, honouring --seed and --config", async () => {
    const scratch = scratchDir();
    const configPath = resolve(scratch, "config.json");
    const outPath = resolve(scratch, "nested/run.jsonl");
    writeFileSync(configPath, JSON.stringify({ population: { size: 4 }, creature: { maxLifeSeconds: 5 } }));
    const r = await run("headless", "--generations", "2", "--out", outPath, "--config", configPath, "--seed", "7", "--threads", "1");
    expect(r.code).toBe(0);
    const lines = readFileSync(outPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0].type).toBe("config");
    expect(lines[0].config.seed).toBe(7);
    expect(lines[0].config.population.size).toBe(4);
    expect(lines.slice(1).map((l) => l.generation)).toEqual([0, 1]);
    for (const l of lines.slice(1)) expect(Number.isFinite(l.bestFitness) && Number.isFinite(l.meanFitness)).toBe(true);
    expect(lines[2].bestEver).toBeGreaterThanOrEqual(lines[1].bestEver);
  });

  it("rejects missing or bad arguments and bad config files with exit code 1", async () => {
    const scratch = scratchDir();
    const badConfig = resolve(scratch, "bad.json");
    writeFileSync(badConfig, JSON.stringify({ nonsense: 1 }));
    const out = resolve(scratch, "unused.jsonl");
    const argSets = [[], ["--generations", "1", "--out", out, "--seed", "x"], ["--generations", "1", "--out", out, "--config", badConfig]];
    const results = await Promise.all(argSets.map((args) => run("headless", ...args)));
    for (const r of results) {
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/^error: /);
    }
  });
});

describe.concurrent("buildPool.ts and ecoBench.ts", () => {
  it("buildPool writes a valid pool file", async () => {
    const outPath = resolve(scratchDir(), "pool.json");
    const r = await run("buildPool", "--runs", "2", "--generations", "12", "--pop", "24", "--size", "2", "--threads", "2", "--out", outPath);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/wrote .*pool\.json/);
    const file = JSON.parse(readFileSync(outPath, "utf8"));
    expect(file.command).toContain("--runs 2");
    expect(parsePool(file).rejected).toEqual([]);
  }, 60_000);

  it("ecoBench seeds poolFraction of the founders from --pool, none with --pool none", async () => {
    const args = ["--seconds", "1", "--pop", "20", "--set", "eco.poolFraction=0.5"];
    const [a, b] = await Promise.all([run("ecoBench", ...args), run("ecoBench", ...args, "--pool", "none")]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(JSON.parse(a.out).poolFounders).toBe(10);
    expect(JSON.parse(b.out).poolFounders).toBe(0);
  });

  it("ecoBench reads a Copy-format --config, applies --set over it and adds a --series", async () => {
    const file = resolve(scratchDir(), "settings.json");
    writeFileSync(file, serialise("ecosystem", overrideConfig(DEFAULT_ECO_CONFIG, { eco: { initialPopulation: 30, poolFraction: 0 } })));
    const [a, b] = await Promise.all([
      run("ecoBench", "--config", file, "--seconds", "2", "--series", "1", "--pool", "none"),
      run("ecoBench", "--config", file, "--seconds", "1", "--pool", "none", "--set", "eco.initialPopulation=12", "--set", "species.0.speed=2"),
    ]);
    expect(a.code).toBe(0);
    const sa = JSON.parse(a.out);
    expect(sa.population[0]).toBe(30);
    expect(sa.series.map((r: { t: number }) => r.t)).toEqual([1, 2]);
    expect(b.code).not.toBe(0); // the Ecosystem config has no species list
    expect(b.err).toContain("no species list");
  });

  it("ecoBench rejects an unknown or mistyped --set", async () => {
    const [a, b] = await Promise.all([run("ecoBench", "--seconds", "1", "--set", "eco.nope=1"), run("ecoBench", "--seconds", "1", "--set", "eco.foodRegrow=x")]);
    expect(a.err).toContain('unknown config key "eco.nope"');
    expect(b.err).toContain("must be a number");
  });
});
