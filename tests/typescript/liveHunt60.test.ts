// @vitest-environment happy-dom
import { LiveLink } from "../../src/typescript/src/live/connection.ts";
import type { LinkHandlers } from "../../src/typescript/src/live/connection.ts";
import { MSG_DELTA, MSG_ITEMS, PROTOCOL_VERSION, encodeDeltaChunk } from "../../src/typescript/src/live/protocol.ts";
import { LiveScene } from "../../src/typescript/src/live/scene.ts";
import { followsLive } from "../../src/typescript/src/live/detail.ts";

describe("live link failure modes", () => {
  class FakeSocket {
    static made = 0;
    static last: FakeSocket | null = null;
    readyState = 1;
    binaryType = "";
    closed = false;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      FakeSocket.made++;
      FakeSocket.last = this;
    }
    close(): void {
      this.closed = true;
      this.readyState = 3;
      this.onclose?.();
    }
    send(): void {}
  }
  const hello = JSON.stringify({ t: "hello", version: PROTOCOL_VERSION, world: { width: 1000, height: 600 }, radius: 10, dt: 1 / 30, fullEnergy: 100, itemSlots: 4 });
  const link = (over: Partial<LinkHandlers> = {}): LiveLink => new LiveLink("ws://x", { onState() {}, onHello() {}, onCreatures() {}, onItems() {}, onDelta() {}, onDetail() {}, onGenome() {}, onStats() {}, onHistory() {}, ...over }, null);
  const run = (body: () => void): void => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      body();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  };

  // Red without it: the socket stayed open with no world, dropping every frame for ever.
  it("closes the socket on a bad hello", () => {
    run(() => {
      link().start();
      FakeSocket.last!.onmessage!({ data: JSON.stringify({ t: "hello", version: PROTOCOL_VERSION }) });
      expect(FakeSocket.last!.closed).toBe(true);
    });
  });

  // Red without it: the page's item set stayed wrong until a reconnect nothing triggered.
  it("closes the socket when an item set fails to decode, and keeps it for a bad creature frame", () => {
    run(() => {
      link().start();
      const ws = FakeSocket.last!;
      ws.onmessage!({ data: hello });
      ws.onmessage!({ data: new Uint8Array([99, 1, 2]).buffer });
      expect(ws.closed).toBe(false);
      ws.onmessage!({ data: new Uint8Array([MSG_ITEMS, 1, 2]).buffer });
      expect(ws.closed).toBe(true);
    });
  });

  // Red without the split: a page handler that threw on a good delta closed the link, a reconnect loop for a page bug.
  it("keeps the socket when a page handler throws on a good delta", () => {
    run(() => {
      let calls = 0;
      link({ onDelta: () => { calls++; throw new Error("page bug"); } }).start();
      const ws = FakeSocket.last!;
      ws.onmessage!({ data: hello });
      const chunk = encodeDeltaChunk(5, [{ slot: 1, kind: 1, x: 10, y: 10, tick: 5 }], [], { width: 1000, height: 600 })!;
      ws.onmessage!({ data: new Uint8Array([MSG_DELTA, 1, ...chunk]).buffer }); // one chunk in a delta message
      expect(calls).toBe(1);
      expect(ws.closed).toBe(false);
    });
  });

  // Red without it: a server that said hello and dropped was retried every second for ever.
  it("backs off when the link drops soon after its hello, and resets after a stable one", () => {
    run(() => {
      link().start();
      FakeSocket.last!.onmessage!({ data: hello });
      FakeSocket.last!.close();
      vi.advanceTimersByTime(1300); // the first retry
      FakeSocket.last!.onmessage!({ data: hello });
      FakeSocket.last!.close();
      const made = FakeSocket.made;
      vi.advanceTimersByTime(1900); // the second retry waits at least 2 s
      expect(FakeSocket.made).toBe(made);
      vi.advanceTimersByTime(1000);
      expect(FakeSocket.made).toBe(made + 1);
      FakeSocket.last!.onmessage!({ data: hello });
      vi.advanceTimersByTime(11_000);
      FakeSocket.last!.close();
      vi.advanceTimersByTime(1300);
      expect(FakeSocket.made).toBe(made + 2);
    });
  });
});

describe("scene drain", () => {
  // Red without it: the entries before a throwing one ran again every frame.
  it("does not re-run entries after a throwing handler", () => {
    const s = new LiveScene();
    s.dt = 1 / 30;
    const seen: number[] = [];
    s.handlers = {
      onEvents() {},
      onDetail: (d) => {
        seen.push(d.tick);
        if (d.tick === 102) throw new Error("boom");
      },
    };
    const detail = (tick: number) => ({ id: 1, tick, alive: true }) as never;
    s.addDetail(detail(100));
    s.addDetail(detail(102));
    s.addDetail(detail(103));
    const drain = (s as unknown as { drain(t: number): void }).drain.bind(s);
    expect(() => drain(110)).toThrow("boom");
    drain(110);
    expect(seen).toEqual([100, 102, 103]);
  });
});

describe("followed creature that died", () => {
  it("is idle like no selection", () => {
    expect(followsLive(null)).toBe(false);
    expect(followsLive({ died: true })).toBe(false);
    expect(followsLive({ died: false })).toBe(true);
  });
});
