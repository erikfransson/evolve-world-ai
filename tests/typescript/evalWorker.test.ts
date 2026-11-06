vi.mock("../../src/typescript/src/worker/evalPool.ts", () => ({
  evalJob: (job: { boom?: boolean }) => {
    if (job.boom) throw new Error("boom");
    return { ok: true };
  },
  heartbeat: () => () => {}, // the worker wires a progress callback; this test checks only the job path
  transferList: () => [],
}));

vi.mock("../../src/typescript/src/worker/pacer.ts", async (orig) => {
  const real = await orig<typeof import("../../src/typescript/src/worker/pacer.ts")>();
  class FakePacer extends real.Pacer {
    override wait(): number { return (globalThis as { __paceWait?: number }).__paceWait ?? 0; }
  }
  return { ...real, Pacer: FakePacer };
});

describe("browser evaluation worker", () => {
  afterEach(() => vi.useRealTimers());

  it("reports a throwing job as a worker error and keeps running later jobs", async () => {
    vi.useFakeTimers();
    const posted: unknown[] = [];
    const scope = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: unknown) => posted.push(m) };
    (globalThis as { self?: unknown }).self = scope;
    await import("../../src/typescript/src/worker/evalWorker.ts");
    scope.onmessage!({ data: { boom: true } });
    scope.onmessage!({ data: {} });
    // the rethrow is a timer callback, which a real worker turns into its error event
    await expect(vi.runAllTimersAsync()).rejects.toThrow("boom");
    await vi.runAllTimersAsync();
    expect(posted.filter((m) => (m as { type?: string }).type !== "progress")).toEqual([{ ok: true }]);
  });

  it("posts progress at receipt and during the pacer wait, before the result", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    (globalThis as { __paceWait?: number }).__paceWait = 5000;
    const posted: { type?: string; job?: number }[] = [];
    const scope = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: { type?: string }) => posted.push(m) };
    (globalThis as { self?: unknown }).self = scope;
    await import("../../src/typescript/src/worker/evalWorker.ts");
    scope.onmessage!({ data: { job: 7 } });
    await vi.advanceTimersByTimeAsync(5000);
    delete (globalThis as { __paceWait?: number }).__paceWait;
    const progress = posted.filter((m) => m.type === "progress");
    expect(progress.length).toBeGreaterThanOrEqual(5);
    expect(progress.every((m) => m.job === 7)).toBe(true);
    expect(posted.at(-1)).toEqual({ ok: true });
  });
});
