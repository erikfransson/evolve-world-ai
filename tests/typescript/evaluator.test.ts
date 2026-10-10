import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";
import type { SimConfig } from "../../src/typescript/src/sim/config.ts";
import { SerialEvaluator } from "../../src/typescript/src/sim/evaluator.ts";
import { Evolution } from "../../src/typescript/src/sim/evolution.ts";
import { createBrowserEvaluator } from "../../src/typescript/src/worker/browserPool.ts";
import { PoolEvaluator, defaultThreads, evalJob } from "../../src/typescript/src/worker/evalPool.ts";
import type { EvalDone, EvalJob, PoolWorker } from "../../src/typescript/src/worker/evalPool.ts";
import { createNodeEvaluator } from "../../src/typescript/src/worker/nodePool.ts";

const cfg: SimConfig = {
  ...DEFAULT_CONFIG,
  creature: { ...DEFAULT_CONFIG.creature, maxLifeSeconds: 10 },
  population: { size: 37 },
};

describe("parallel evaluation", () => {
  it("picks one fewer thread than cores, between 1 and 8", () => {
    expect(defaultThreads(1)).toBe(1);
    expect(defaultThreads(4)).toBe(3);
    expect(defaultThreads(64)).toBe(8);
  });

  it("gives bit-identical generations to the serial run", async () => {
    const serial = new Evolution(cfg);
    const parallel = new Evolution(cfg);
    const pool = createNodeEvaluator(cfg, 3);
    try {
      for (let g = 0; g < 2; g++) {
        const a = await serial.runGeneration();
        const b = await parallel.runGeneration(pool);
        expect(Array.from(b.result.fitness)).toEqual(Array.from(a.result.fitness));
        expect(b.result.bestIndex).toBe(a.result.bestIndex);
        expect(b.result.meanFitness).toBe(a.result.meanFitness);
        expect(Array.from(parallel.population.data)).toEqual(Array.from(serial.population.data));
      }
    } finally {
      pool.close();
    }
  }, 60_000);
});

class FakeWorker implements PoolWorker {
  posted: EvalJob[] = [];
  terminated = false;
  private messageCallback: (msg: EvalDone) => void = () => {};
  private errorCallback: (error: unknown) => void = () => {};

  private readonly autoReply: boolean;

  constructor(autoReply: boolean) {
    this.autoReply = autoReply;
  }


  post(msg: EvalJob): void {
    this.posted.push(msg);
    if (this.autoReply) queueMicrotask(() => this.messageCallback(evalJob(msg)));
  }
  onMessage(callback: (msg: EvalDone) => void): void { this.messageCallback = callback; }
  onError(callback: (error: unknown) => void): void { this.errorCallback = callback; }
  terminate(): void { this.terminated = true; }
  fail(error: unknown): void { this.errorCallback(error); }
}

describe("PoolEvaluator error state", () => {
  const population = new Evolution(cfg).population;

  it("evaluates through workers when nothing goes wrong", async () => {
    const pool = new PoolEvaluator(cfg, [new FakeWorker(true), new FakeWorker(true)]);
    const fitness = await pool.evaluate(population, 5);
    expect(Array.from(fitness)).toEqual(Array.from(await new SerialEvaluator(cfg).evaluate(population, 5)));
  });

  it("close() rejects the pending call, later calls and terminates the workers", async () => {
    const workers = [new FakeWorker(false), new FakeWorker(false)];
    const pool = new PoolEvaluator(cfg, workers);
    const pending = pool.evaluate(population, 5);
    pool.close();
    await expect(pending).rejects.toThrow("evaluator closed");
    await expect(pool.evaluate(population, 5)).rejects.toThrow("evaluator closed");
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  it("a worker error rejects the pending call and every later one", async () => {
    const workers = [new FakeWorker(false), new FakeWorker(false)];
    const pool = new PoolEvaluator(cfg, workers);
    const pending = pool.evaluate(population, 5);
    workers[1]!.fail(new Error("boom"));
    await expect(pending).rejects.toThrow("boom");
    await expect(pool.evaluate(population, 5)).rejects.toThrow("boom");
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  it("a worker error while idle breaks the pool", async () => {
    const workers = [new FakeWorker(true)];
    const pool = new PoolEvaluator(cfg, workers);
    workers[0]!.fail(new Error("exited"));
    await expect(pool.evaluate(population, 5)).rejects.toThrow("exited");
    expect(workers[0]!.terminated).toBe(true);
  });
});

describe("browser evaluator", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to serial when a worker fails to start", async () => {
    class BrokenWorker {
      onmessage: unknown = null;
      onerror: ((e: { message: string }) => void) | null = null;
      postMessage(): void { queueMicrotask(() => this.onerror?.({ message: "no nested workers" })); }
      terminate(): void {}
    }
    vi.stubGlobal("Worker", BrokenWorker);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const population = new Evolution(cfg).population;
    const evaluator = createBrowserEvaluator(cfg, 2);
    const expected = await new SerialEvaluator(cfg).evaluate(population, 5);
    expect(Array.from(await evaluator.evaluate(population, 5))).toEqual(Array.from(expected));
    expect(Array.from(await evaluator.evaluate(population, 5))).toEqual(Array.from(expected));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
