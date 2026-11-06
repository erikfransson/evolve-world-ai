vi.mock("../../src/typescript/src/worker/evalPool.ts", () => ({
  evalJob: (job: { boom?: boolean }) => {
    if (job.boom) throw new Error("boom");
    return { ok: true };
  },
  transferList: () => [],
}));

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
    expect(posted).toEqual([{ ok: true }]);
  });
});
