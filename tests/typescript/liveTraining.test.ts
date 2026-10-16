// @vitest-environment happy-dom
import { train } from "../../src/typescript/src/live/training.ts";

// A stand-in for the RL worker: records what the page sends, answers nothing.
class FakeWorker {
  static last: FakeWorker | null = null;
  sent: { type: string; helpers?: number }[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: { type: string; helpers?: number }): void {
    this.sent.push(m);
  }
  terminate(): void {
    this.terminated = true;
  }
}

const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("in-browser training", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    vi.stubGlobal("Worker", FakeWorker);
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("caps the helper threads and waits, clock and worker, while the tab is hidden", async () => {
    const plan = { rayCount: 3, raySpread: 1, rayLength: 100, hiddenLayers: [4], memoryShort: 0, memoryLong: 0 };
    let ended = false;
    const job = train("pretrain", plan, new Float32Array(10), () => {}, () => {}, 10);
    void job.done.then(() => (ended = true));
    const w = FakeWorker.last!;
    expect(w.sent[0]).toMatchObject({ type: "start", helpers: 3 });
    vi.advanceTimersByTime(4000);
    setHidden(true);
    expect(w.sent.at(-1)!.type).toBe("pause");
    vi.advanceTimersByTime(60_000); // hidden for a minute: the 10 s budget does not run out
    await Promise.resolve();
    expect(ended).toBe(false);
    setHidden(false);
    expect(w.sent.at(-1)!.type).toBe("resume");
    vi.advanceTimersByTime(5900);
    await Promise.resolve();
    expect(ended).toBe(false);
    vi.advanceTimersByTime(200); // 4 s + 6 s visible
    await Promise.resolve();
    expect(ended).toBe(true);
    expect(w.terminated).toBe(true);
  });

  it("ends a run hidden for more than ten minutes, freeing the worker", async () => {
    const plan = { rayCount: 3, raySpread: 1, rayLength: 100, hiddenLayers: [4], memoryShort: 0, memoryLong: 0 };
    let ended = false;
    const job = train("pretrain", plan, new Float32Array(10), () => {}, () => {}, 10);
    void job.done.then(() => (ended = true));
    setHidden(true);
    vi.advanceTimersByTime(9.9 * 60_000);
    await Promise.resolve();
    expect(ended).toBe(false);
    vi.advanceTimersByTime(0.2 * 60_000);
    await Promise.resolve();
    expect(ended).toBe(true);
    expect(FakeWorker.last!.terminated).toBe(true);
  });
});
