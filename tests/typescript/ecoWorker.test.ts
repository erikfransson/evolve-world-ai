// The eco worker's hand-off of snapshot buffers to the render worker: normal flow, renderGone, and a render worker that goes silent.
// Not covered: a real MessageChannel and the page's reaction to renderLost.
type Emit = (msg: unknown, transfer: Transferable[]) => void;
let emit: Emit;

vi.mock("../../src/typescript/src/worker/ecoRunner.ts", () => ({
  EcoRunner: class {
    gentle = null;
    seedPool = null;
    constructor(e: Emit) { emit = e; }
    handle(): void {}
    useHelpers(): void {}
    pumpAsync(): Promise<number> { return Promise.resolve(-1); }
  },
}));

const snap = () => ({ type: "snapshot", run: 1, count: 0, itemCount: 0, creatureCap: 1, itemCap: 1, buffer: new ArrayBuffer(8), events: undefined, selected: null });

describe("ecoWorker render hand-off", () => {
  let page: { type: string; buffer?: ArrayBuffer }[];
  let port: { posted: unknown[]; closed: boolean; onmessage: ((e: unknown) => void) | null; postMessage(m: unknown): void; close(): void };
  let self_: { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: { type: string; buffer?: ArrayBuffer }): void };

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    page = [];
    self_ = { onmessage: null, postMessage: (m) => void page.push(m) };
    port = { posted: [], closed: false, onmessage: null, postMessage(m) { port.posted.push(m); }, close() { port.closed = true; } };
    vi.stubGlobal("self", self_);
    vi.stubGlobal("navigator", { hardwareConcurrency: 2 });
    await import("../../src/typescript/src/worker/ecoWorker.ts");
    self_.onmessage!({ data: { type: "renderPort", port } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends snapshot buffers to the render port and a bufferless copy to the page", () => {
    emit(snap(), []);
    expect(port.posted).toHaveLength(1);
    expect(page[0]!.buffer!.byteLength).toBe(0);
  });

  it("keeps the port while buffers come back, however long the run", () => {
    for (let i = 0; i < 400; i++) {
      vi.advanceTimersByTime(100);
      emit(snap(), []);
      if (i > 0) port.onmessage!({ data: { buffer: new ArrayBuffer(8) } });
    }
    expect(port.closed).toBe(false);
    expect(port.posted).toHaveLength(400);
  });

  it("goes back to the page after renderGone, without telling it", () => {
    self_.onmessage!({ data: { type: "renderGone" } });
    expect(port.closed).toBe(true);
    const s = snap();
    emit(s, [s.buffer]);
    expect(port.posted).toHaveLength(0);
    expect(page[0]!.buffer!.byteLength).toBe(8);
    expect(page.some((m) => m.type === "renderLost")).toBe(false);
  });

  it("treats a render worker that returns no buffer for 20 s as gone", () => {
    emit(snap(), []);
    emit(snap(), []); // the clock starts here
    vi.advanceTimersByTime(19_000);
    emit(snap(), []);
    expect(port.closed).toBe(false);
    vi.advanceTimersByTime(1500);
    emit(snap(), []);
    expect(port.closed).toBe(true);
    expect(port.posted).toHaveLength(3);
    expect(page.filter((m) => m.type === "renderLost")).toHaveLength(1); // the page is told once
    expect(page.at(-1)!.buffer!.byteLength).toBe(8); // this one went to the page with its buffer
  });

  it("does not trip on a late start: the first buffer is held, pumps resume after 6 s, then buffers flow", () => {
    emit(snap(), []);
    vi.advanceTimersByTime(6000);
    emit(snap(), []);
    emit(snap(), []);
    port.onmessage!({ data: { buffer: new ArrayBuffer(8) } });
    for (let i = 0; i < 50; i++) {
      vi.advanceTimersByTime(100);
      emit(snap(), []);
      port.onmessage!({ data: { buffer: new ArrayBuffer(8) } });
    }
    expect(port.closed).toBe(false);
    expect(page.some((m) => m.type === "renderLost")).toBe(false);
  });
});
