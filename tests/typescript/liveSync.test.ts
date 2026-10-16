// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error the web tsconfig finds no types for the server's ws
import { WebSocket } from "../../server/node_modules/ws/wrapper.mjs";
import { startAdmin } from "../../server/src/admin.ts";
import { SLOWEST_STRIDE, frameBudget, sendStride } from "../../server/src/budget.ts";
import { LIMITS } from "../../server/src/config.ts";
import { LiveWorld, runTicks } from "../../server/src/liveWorld.ts";
import { startPublic } from "../../server/src/public.ts";
import type { PublicServer } from "../../server/src/public.ts";
import { Saves } from "../../server/src/saves.ts";
import { StateStore } from "../../server/src/state.ts";
import { ItemMirror } from "../../src/typescript/src/live/items.ts";
import { MSG_DELTA, MSG_DETAIL, MSG_ITEMS, decodeCreatures, decodeDelta, decodeItems, deltaMessage, encodeCreatures, encodeDeltaChunk } from "../../src/typescript/src/live/protocol.ts";
import type { Stats } from "../../src/typescript/src/live/protocol.ts";
import { decodeDetail, encodeDetail } from "../../src/typescript/src/live/detail.ts";
import { HIDDEN_CLOSE_MS, LiveLink, cleanStats, historyAxis } from "../../src/typescript/src/live/connection.ts";
import { LiveScene } from "../../src/typescript/src/live/scene.ts";
import type { ThinkPool } from "../../src/typescript/src/worker/ecoPool.ts";
import { smallConfig } from "./liveHelpers.ts";

// Findings of the v2 review: message order, full item sets, frame numbering, stalled and failing ticks, selection under the rate limit.
type Limits = typeof LIMITS;
const servers: PublicServer[] = [];
async function serve(port: number, change: Partial<Limits> = {}, world = grown()): Promise<{ pub: PublicServer; world: LiveWorld }> {
  const pub = startPublic("127.0.0.1", port, world, { ...LIMITS, ...change });
  servers.push(pub);
  await new Promise<void>((r) => (pub.http.listening ? r() : pub.http.once("listening", () => r())));
  return { pub, world };
}
function grown(): LiveWorld {
  const world = new LiveWorld(smallConfig(), null);
  for (let i = 0; i < 30; i++) world.step();
  return world;
}
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const s of servers.splice(0)) s.close();
  vi.restoreAllMocks();
});
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A viewer that logs what it gets ("hello", "stats", "bin1" for creatures, "bin2" items...) and mirrors the items.
interface Client {
  ws: WebSocket;
  log: string[];
  mirror: ItemMirror;
  open: Promise<void>;
}
function client(port: number, world: LiveWorld): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  sockets.push(ws);
  const c: Client = { ws, log: [], mirror: new ItemMirror(), open: new Promise((r) => ws.on("open", () => r())) };
  ws.on("message", (d: Buffer, bin: boolean) => {
    c.log.push(bin ? `bin${d[0]}` : JSON.parse(d.toString()).t);
    if (!bin) return;
    const slots = world.eco.world.count;
    if (d[0] === MSG_ITEMS) c.mirror.reset(decodeItems(d, world.world, slots));
    else if (d[0] === MSG_DELTA) for (const delta of decodeDelta(d, world.world, slots)) for (const op of delta.ops) c.mirror.apply(op.slot, op.kind, op.x, op.y);
  });
  ws.on("error", () => {});
  return c;
}
const inFlight = (world: LiveWorld, on: boolean): void => void ((world as unknown as { inFlight: boolean }).inFlight = on);
const pending = (world: LiveWorld): number => (world as unknown as { pending: unknown[] }).pending.length;

function sameItems(mirror: ItemMirror, world: LiveWorld): boolean {
  const w = world.eco.world;
  let n = 0;
  for (let s = 0; s < w.count; s++) {
    if (w.kinds[s]) n++;
    if (mirror.kindAt(s) !== (w.kinds[s] ? w.kinds[s] : 0)) return false;
  }
  return n === mirror.count;
}

describe("public server: order and item sets", () => {
  // Red without the ready flag: frame jobs queued during a tick ran before the hello job, sent the items the client then dropped,
  // and used up the connect allowance, so the viewer never got a full set.
  it("sends nothing before a viewer's hello, even when its hello waits behind a tick", async () => {
    const port = 62450;
    const world = grown();
    const one = world.itemsSize() + world.creatureFrame().length;
    await serve(port, { connectBurstBytes: 0, connectBytesPerSecond: Math.round(one * 1.05) }, world);
    await wait(600);
    inFlight(world, true); // a tick waits for the helpers: the frame loop queues its work
    await wait(250);
    const c = client(port, world);
    await c.open;
    await wait(100);
    inFlight(world, false);
    await world.tick();
    for (let i = 0; i < 10; i++) {
      world.step();
      await wait(200);
    }
    expect(c.log[0]).toBe("hello");
    expect(c.log).toContain("bin2");
    expect(sameItems(c.mirror, world)).toBe(true);
  });

  // Red without full sets from the frame budget: 40 viewers waited ~20 s for the connect allowance, with no creature frames meanwhile.
  it("after a reload, 40 viewers get their item sets within seconds and creature frames while they wait", async () => {
    const port = 62451;
    const world = grown();
    const full = world.itemsSize();
    const perViewer = world.creatureFrame().length * 5;
    const budget = Math.round((40 * perViewer) / 2);
    const connect = 2 * full;
    const { pub } = await serve(port, { maxViewers: 100, acceptBurst: 100, acceptsPerSecond: 100, connectBurstBytes: 0, connectBytesPerSecond: connect, textBytesPerViewer: 10, detailBytesPerViewer: 0, maxSendBytesPerSecond: budget + connect + 100 * 10 }, world);
    await wait(300);
    const cs = Array.from({ length: 40 }, () => client(port, world));
    await Promise.all(cs.map((c) => c.open));
    await vi.waitFor(() => expect(pub.viewers()).toBe(40));
    await vi.waitFor(() => expect(cs.every((c) => c.log.includes("bin2"))).toBe(true), { timeout: 6000, interval: 100 });
    for (const c of cs) c.log.length = 0;
    const t0 = Date.now();
    world.onReseed!();
    await vi.waitFor(() => expect(cs.every((c) => c.log.includes("bin2"))).toBe(true), { timeout: 6000, interval: 100 });
    expect(Date.now() - t0).toBeLessThan(5000);
    const framesFirst = cs.filter((c) => { const i = c.log.indexOf("bin1"); return i >= 0 && i < c.log.indexOf("bin2"); }).length;
    expect(framesFirst).toBeGreaterThan(0);
    world.step();
    await wait(1200);
    expect(cs.every((c) => sameItems(c.mirror, world))).toBe(true);
  }, 30_000);

  it("sizes the full item set without encoding it", () => {
    const world = grown();
    for (let i = 0; i < 60; i++) {
      world.step();
      expect(world.itemsSize()).toBe(world.itemsFrame().length);
    }
  });

  // Red without frames++ in a finally: a frame that failed after sending kept its number, the next frame's changes replaced it in
  // the feed, and the viewer that had it never got those changes.
  it("a frame that fails half way never reuses its number, so the items stay in sync", async () => {
    const port = 62452;
    const { world } = await serve(port);
    vi.spyOn(console, "error").mockImplementation(() => {});
    world.refreshWatched = () => {
      throw new Error("boom"); // after the frames went out
    };
    const c = client(port, world);
    await vi.waitFor(() => expect(c.log).toContain("bin2"));
    for (let i = 0; i < 8; i++) {
      for (let k = 0; k < 5; k++) world.step();
      await wait(250);
    }
    await wait(300);
    expect(c.log.filter((m) => m === "bin5").length).toBeGreaterThan(3);
    expect(sameItems(c.mirror, world)).toBe(true);
  });

  // Red without one pending job per loop: each 200 ms the frame loop queued another job behind the stalled tick.
  it("keeps at most one frame job and one stats job waiting during a stalled tick", async () => {
    const port = 62453;
    const { world } = await serve(port, { statsEveryMs: 200 });
    await wait(300);
    inFlight(world, true);
    await wait(1500);
    expect(pending(world)).toBeLessThanOrEqual(2);
    inFlight(world, false);
    await world.tick();
  });
});

describe("upload budget", () => {
  // Red without it: the detail allowance of every viewer slot came on top of the budget.
  it("sets aside every viewer's detail allowance", () => {
    const limits = { maxSendBytesPerSecond: 3_000_000, connectBytesPerSecond: 300_000, maxViewers: 100, textBytesPerViewer: 2000, detailBytesPerViewer: 3000 };
    expect(frameBudget(limits)).toBe(3_000_000 - 300_000 - 100 * 5000);
    expect(frameBudget(LIMITS) + LIMITS.connectBytesPerSecond + LIMITS.maxViewers * (LIMITS.textBytesPerViewer + LIMITS.detailBytesPerViewer)).toBe(LIMITS.maxSendBytesPerSecond);
  });

  // Red without the cap: huge item changes gave an infinite stride, and no viewer got another frame.
  it("never stops frames when item changes pass the budget, it slows them to at most SLOWEST_STRIDE", () => {
    expect(sendStride(100, 100_000, 30_000, 3_000_000, 300_000)).toBe(14); // changes share like frames, at most a full set per frame
    expect(sendStride(100, 100_000, 1e9, 3_000_000, 1e9)).toBe(SLOWEST_STRIDE);
    expect(sendStride(100, 100_000, 0, 0)).toBe(SLOWEST_STRIDE);
    expect(sendStride(100, 100_000, 0, -5)).toBe(SLOWEST_STRIDE);
    expect(sendStride(1000, 100_000, 0, 3_000_000)).toBe(SLOWEST_STRIDE);
  });
});

describe("failing ticks", () => {
  // Red without the finally: work queued during a tick that then threw waited forever.
  it("runs the work queued during a tick even when the tick throws, and counts the failures", async () => {
    const world = grown();
    inFlight(world, true);
    let ran = false;
    const job = world.whenIdle(() => (ran = true));
    inFlight(world, false);
    world.eco.step = () => {
      throw new Error("engine bug");
    };
    await expect(world.tick()).rejects.toThrow("engine bug");
    await job;
    expect(ran).toBe(true);
    expect(world.failedTicks).toBe(1);
    await expect(world.tick()).rejects.toThrow();
    expect(world.failedTicks).toBe(2);
  });

  // Red without the check: a world whose ticks fail was written over the last good save.
  it("does not save a world whose ticks are failing", async () => {
    const world = grown();
    const store = new StateStore(mkdtempSync(join(tmpdir(), "evolve-sync-")));
    const saves = new Saves(world, store);
    world.failedTicks = 3;
    await expect(saves.save()).rejects.toThrow(/failing/);
    expect(store.list()).toEqual([]);
    world.failedTicks = 0;
    await expect(saves.save()).resolves.toMatch(/saved/);
  });

  it("the tick loop gives up after maxTickFailures failures in a row", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fake = { failedTicks: 0, advance: async (): Promise<number> => { fake.failedTicks++; throw new Error("bad"); } };
      const fatal = vi.fn();
      runTicks(fake, 50, fatal);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fatal).toHaveBeenCalledTimes(1);
      expect(fake.failedTicks).toBe(50);
    } finally {
      vi.useRealTimers();
    }
  });

  // Red without the check: the tick that awaited the first start cleared the start of a world restored meanwhile, and the next tick
  // stepped the helpers before they were ready.
  it("keeps the helpers' start of a world restored while a tick waited for the previous start", async () => {
    const starts: { resolve: () => void; done: boolean }[] = [];
    const stepsBeforeReady: boolean[] = [];
    const pool = {
      helpers: 1,
      start(): Promise<void> {
        let resolve!: () => void;
        const p = new Promise<void>((r) => (resolve = r));
        const s = { resolve: () => { s.done = true; resolve(); }, done: false };
        starts.push(s);
        return p;
      },
      async step(eco: LiveWorld["eco"]): Promise<void> {
        stepsBeforeReady.push(!starts.at(-1)!.done);
        eco.step();
      },
      close(): void {},
    } as unknown as ThinkPool;
    const world = new LiveWorld(smallConfig(), null, pool);
    const saved = JSON.parse(JSON.stringify(grown().saveState()));
    const first = world.tick();
    world.restoreState(saved); // between ticks: the restore starts the helpers again
    starts[0]!.resolve();
    await first;
    const second = world.tick();
    await wait(20);
    expect(stepsBeforeReady).toEqual([]); // still waiting for the second start
    starts[1]!.resolve();
    await second;
    expect(stepsBeforeReady).toEqual([false]);
  });
});

describe("admin load", () => {
  // Red without the handler: the rejection went unhandled (with main.ts's handler, the server would exit).
  it("answers with an error when the saved settings cannot be applied after a load", async () => {
    const world = grown();
    const dir = mkdtempSync(join(tmpdir(), "evolve-sync-"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const flaky = { eco: world.eco, whenIdle: <T>(_fn: () => T): Promise<T> => Promise.reject(new Error("idle failed")) };
    const admin = startAdmin("127.0.0.1", 62520, "tok", flaky, dir, dir, {}, { pause() {}, resume() {}, paused: () => false, saveNow: async () => "", listSaves: () => [], loadSave: async () => "loaded x", stop() {}, blankName: async () => 0, renameName: async () => 0, reset: async () => "" });
    try {
      const ws = new WebSocket("ws://127.0.0.1:62520/");
      sockets.push(ws);
      const replies: { t: string; message?: string }[] = [];
      ws.on("message", (d: Buffer) => replies.push(JSON.parse(d.toString())));
      await new Promise((r) => ws.on("open", r));
      ws.send(JSON.stringify({ t: "auth", token: "tok" }));
      ws.send(JSON.stringify({ t: "load-save", name: "x" }));
      await vi.waitFor(() => expect(replies.map((m) => m.t)).toEqual(["authed", "error"]));
      expect(replies[1]!.message).toMatch(/idle failed/);
      await wait(50);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      admin.close();
    }
  });
});

describe("selection under the rate limit", () => {
  // Red without v.want: clicks past the select rate were dropped, and the viewer stayed on an older creature ("Loading" on the page).
  it("follows the last creature asked for, even when it was asked for past the select rate", async () => {
    const port = 62454;
    const { world } = await serve(port);
    const c = client(port, world);
    const details: number[] = [];
    c.ws.on("message", (d: Buffer, bin: boolean) => { if (bin && d[0] === MSG_DETAIL) details.push(decodeDetail(d).id); });
    await vi.waitFor(() => expect(c.log).toContain("hello"));
    const ids = world.eco.members.slice(0, 7).map((m) => m.id);
    for (const id of ids) c.ws.send(JSON.stringify({ t: "select", id })); // a burst of 4, then 3 past the rate
    await wait(1500);
    expect(details.at(-1)).toBe(ids.at(-1));
    expect(world.watchedCount).toBe(1);
  });
});

describe("page timeline", () => {
  const frame = (tick: number, ids: number[], xs: number[]) => ({
    tick, count: ids.length, ids: Uint32Array.from(ids), x: Float32Array.from(xs), y: new Float32Array(ids.length), heading: new Float32Array(ids.length),
    radius: new Float32Array(ids.length).fill(12), energyShare: new Float32Array(ids.length).fill(0.5), age: new Float32Array(ids.length).fill(100), hue: new Float32Array(ids.length), founder: new Int32Array(ids.length),
  });
  const snapshot = (tick: number, slots: number) => ({ tick, slots, kinds: new Uint8Array(slots).fill(1), x: new Float32Array(slots), y: new Float32Array(slots) });
  const detail = (tick: number) => decodeDetail(encodeDetail(tick, 1, null));

  // Red without ordered insertion: following at stride > 1, the details of later ticks arrived first and the item changes waited behind them.
  it("applies item changes at their tick even when details of later ticks came first", () => {
    const s = new LiveScene();
    s.dt = 1;
    s.push(frame(100, [1], [0]), 0);
    s.setItems(snapshot(100, 30));
    s.addDetail(detail(110));
    s.addDetail(detail(124));
    s.addDeltas([{ tick: 124, ops: Array.from({ length: 24 }, (_, k) => ({ slot: k + 1, kind: 0, x: 0, y: 0, tick: 101 + k })), events: [] }]);
    s.push(frame(124, [1], [10]), 1000); // a gap of 1000 ms: 24 ticks spread over 1200 ms (SPAN_SLACK, held to MAX_SPAN_MS)
    s.sample(1000 + 252); // tick 105
    expect(s.displayTick).toBeCloseTo(105.04, 2);
    for (let slot = 1; slot <= 5; slot++) expect(s.items.kindAt(slot)).toBe(0);
    expect(s.items.kindAt(6)).toBe(1);
  });

  // Red with the span set by the last gap alone: a frame 200 ms late after steady ones left the creature standing still while it waited.
  it("keeps creatures moving through a late frame: the motion spans a little more than the usual gap", () => {
    const s = new LiveScene();
    s.dt = 1;
    for (let k = 0; k <= 10; k++) s.push(frame(100 + k, [1], [10 * k]), 200 * k); // steady, 200 ms apart
    const x = (t: number): number => (s.sample(t), s.views.x[0]!);
    expect(x(2000 + 150)).toBeLessThan(x(2000 + 200)); // the usual gap: still moving
    expect(x(2000 + 200)).toBeLessThan(x(2000 + 250)); // the next frame is late: still moving
    expect(x(2000 + 250)).toBeLessThan(100);
    s.push(frame(111, [1], [110]), 2400); // arrives 200 ms late
    expect(x(2400)).toBeGreaterThan(99); // picks up from where it is drawn, no jump back
  });

  // Red without the guard: an entry far past the timeline held everything after it.
  it("does not let an entry far ahead of the timeline hold the others back", () => {
    const s = new LiveScene();
    s.dt = 1 / 30;
    const got: number[] = [];
    s.handlers = { onEvents() {}, onDetail: (d) => got.push(d.tick) };
    s.push(frame(100, [1], [0]), 0);
    s.addDetail(detail(100 + 30 * 3600));
    s.addDetail(detail(101));
    s.push(frame(101, [1], [0]), 200);
    s.sample(1000);
    expect(got).toEqual([100 + 30 * 3600, 101]);
  });

  // Red without unsigned ticks: the frame after 2^32 - 1 counted as going back, and its entries applied at once.
  it("keeps the timeline going forward when the u32 tick wraps", () => {
    const top = 2 ** 32;
    const s = new LiveScene();
    s.dt = 1;
    const got: number[] = [];
    s.handlers = { onEvents() {}, onDetail: (d) => got.push(d.tick) };
    s.push(frame(top - 10, [1], [0]), 0);
    s.addDetail(detail(4)); // tick 2^32 + 4 on the wire
    s.push(frame(14, [1], [10]), 1000);
    s.sample(1000 + 480); // tick 2^32 - 0.4 (24 ticks over 1200 ms)
    expect(s.displayTick).toBeGreaterThan(top - 10);
    expect(got).toEqual([]);
    s.sample(1000 + 780); // past 2^32 + 4
    expect(got).toEqual([4]);
    const world = { width: 2000, height: 1300 };
    const [d] = decodeDelta(deltaMessage([encodeDeltaChunk(top + 5, [{ slot: 1, kind: 0, x: 0, y: 0, tick: top - 5 }], [], world)!]), world);
    expect(d!.ops[0]!.tick).toBe(top - 5);
  });

  // Red with i32 ids: an id past 2^31 decoded negative, so it could not be found or selected.
  it("decodes creature ids as u32 and finds them in the views", () => {
    const big = 0x90000000;
    const world = { width: 2000, height: 1300 };
    const src = { count: 1, ids: [big], x: [5], y: [5], heading: [0], energy: [1], hue: [1], founder: [1], age: [1], radius: 12 };
    const f = decodeCreatures(encodeCreatures(7, src, world, 150), world);
    expect(f.ids[0]).toBe(big);
    const s = new LiveScene();
    s.push(f, 0);
    s.push({ ...f, tick: 8 }, 200);
    s.sample(400);
    expect(s.views.count).toBe(1); // matched, not a death and a birth
    expect(s.slotOf(big)).toBe(0);
  });
});

describe("page stats and history", () => {
  // Red without the clamps: a server could put -1 births, 10^12 deaths and -500% lineage shares on the page.
  it("clamps stats to sane ranges", () => {
    const s = cleanStats({
      t: "stats", tick: -3, simSeconds: 1e300, speed: -2, population: 10, births: -1, deaths: 1e12, food: 1.5, poison: 0, viewers: 1, uptimeS: -5, depth: 2,
      season: { yearMinutes: 1e300, winterFood: 7 }, best: { age: -1, children: 2 ** 40 },
      lineages: [{ founder: 0, hue: 0, pool: false, count: -5 }, { founder: 1, hue: 0, pool: false, count: 8 }, { founder: 2, hue: 0, pool: false, count: 8 }],
    } as Stats);
    expect([s.tick, s.speed, s.births, s.deaths, s.food, s.uptimeS]).toEqual([0, 0, 0, 1e9, 2, 0]);
    expect(s.simSeconds).toBeLessThanOrEqual(1e10);
    expect(s.season).toEqual({ yearMinutes: 1e6, winterFood: 1 });
    expect(s.best).toEqual({ age: 0, children: 0xffffffff });
    expect(s.lineages!.map((l) => l.count)).toEqual([0, 8, 2]);
  });

  // Red without it: after a restart in mid-year the axis began at the year's start, most of it empty.
  it("starts the population axis at the first sample when whole years would leave it mostly empty", () => {
    const year = 2400;
    expect(historyAxis(3 * year + 1200, 3 * year + 1500, year)).toEqual({ shift: 3 * year + 1200, aligned: false });
    expect(historyAxis(3 * year + 100, 5 * year, year)).toEqual({ shift: 3 * year, aligned: true });
    expect(historyAxis(500, 900, 0)).toEqual({ shift: 500, aligned: true });
  });
});

describe("page link", () => {
  class FakeSocket {
    static OPEN = 1;
    static made = 0;
    static last: FakeSocket | null = null;
    readyState = 0; // connecting: the stale-link check leaves it alone
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

  // Red without it: a tab left hidden kept its viewer slot for as long as it stayed open.
  it("closes the socket after 3 minutes hidden and connects again when shown", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    try {
      let onChange = (): void => {};
      const vis = { hidden: false, addEventListener: (_t: "visibilitychange", fn: () => void) => void (onChange = fn) };
      const link = new LiveLink("ws://x", { onState() {}, onHello() {}, onCreatures() {}, onItems() {}, onDelta() {}, onDetail() {}, onGenome() {}, onStats() {}, onHistory() {} }, vis);
      link.start();
      const first = FakeSocket.last!;
      FakeSocket.made = 0;
      vis.hidden = true;
      onChange();
      vi.advanceTimersByTime(HIDDEN_CLOSE_MS - 1000);
      expect(first.closed).toBe(false);
      vi.advanceTimersByTime(2000);
      expect(first.closed).toBe(true);
      vi.advanceTimersByTime(10 * 60_000);
      expect(FakeSocket.made).toBe(0); // no reconnect while hidden
      vis.hidden = false;
      onChange();
      expect(FakeSocket.made).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
