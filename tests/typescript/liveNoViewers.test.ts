// @vitest-environment node
// Idle skip: with no viewer connected the frame loop encodes no creature frame and the stats pass skips the per-creature offers.
// Nothing a later viewer or a save reads may differ, and a viewer who joins after an empty period gets a full set on the next tick.
// @ts-expect-error the web tsconfig finds no types for the server's ws
import { WebSocket } from "../../server/node_modules/ws/wrapper.mjs";
import { LIMITS } from "../../server/src/config.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { startPublic } from "../../server/src/public.ts";
import type { PublicServer } from "../../server/src/public.ts";
import type { AddressInfo } from "node:net";
import { MSG_CREATURES, MSG_ITEMS } from "../../src/typescript/src/live/protocol.ts";
import { smallConfig } from "./liveHelpers.ts";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const servers: PublicServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.restoreAllMocks();
});

// Port 0: the OS picks a free port, so parallel test files cannot collide (CI saw EADDRINUSE on a fixed port).
async function listen(pub: PublicServer): Promise<number> {
  servers.push(pub);
  await new Promise<void>((r) => (pub.http.listening ? r() : pub.http.once("listening", () => r())));
  return (pub.http.address() as AddressInfo).port;
}
async function serve(world: LiveWorld, limits = { ...LIMITS, acceptBurst: 100 }): Promise<{ pub: PublicServer; port: number }> {
  const pub = startPublic("127.0.0.1", 0, world, limits);
  return { pub, port: await listen(pub) };
}

// A viewer that records the first byte of each binary frame and the text types.
function watcher(port: number): { ws: WebSocket; kinds: number[]; texts: string[] } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const w = { ws, kinds: [] as number[], texts: [] as string[] };
  ws.on("message", (d: Buffer, isBinary: boolean) => (isBinary ? w.kinds.push(d[0]!) : w.texts.push(JSON.parse(d.toString()).t)));
  ws.on("error", () => {});
  return w;
}
const gotFullSet = (w: { kinds: number[] }): boolean => w.kinds.includes(MSG_ITEMS) && w.kinds.includes(MSG_CREATURES);

describe("no viewers: the frame loop", () => {
  it("encodes no creature frame while nobody is connected, and a viewer joining after the empty period gets the full set on the next tick", async () => {
    const world = new LiveWorld(smallConfig(), null);
    for (let i = 0; i < 20; i++) world.eco.step();
    const frames = vi.spyOn(world, "creatureFrame");
    const { pub, port } = await serve(world);
    await wait(700); // 3 frame ticks with nobody there
    expect(frames).not.toHaveBeenCalled();
    const w = watcher(port);
    await vi.waitFor(() => expect(gotFullSet(w)).toBe(true), { timeout: 1500 });
    expect(w.texts).toContain("hello");
    expect(w.texts).toContain("history");
    expect(frames).toHaveBeenCalled();
    expect(pub.viewers()).toBe(1);
  });

  it("join, leave and join again within a frame interval: the second viewer still gets the full set, and encoding stops after the last leaves", async () => {
    const world = new LiveWorld(smallConfig(), null);
    for (let i = 0; i < 20; i++) world.eco.step();
    const frames = vi.spyOn(world, "creatureFrame");
    const { pub, port } = await serve(world);
    await wait(300);
    const a = watcher(port);
    await vi.waitFor(() => expect(a.texts).toContain("hello"));
    a.ws.terminate();
    const b = watcher(port); // within the same 200 ms interval
    await vi.waitFor(() => expect(gotFullSet(b)).toBe(true), { timeout: 1500 });
    b.ws.terminate();
    await vi.waitFor(() => expect(pub.viewers()).toBe(0));
    await wait(450); // a frame tick that may have been pending when the viewer left
    const calls = frames.mock.calls.length;
    await wait(700);
    expect(frames.mock.calls.length).toBe(calls);
    const c = watcher(port);
    await vi.waitFor(() => expect(gotFullSet(c)).toBe(true), { timeout: 1500 });
  });

  it("a connect burst after an empty period is held to the upload budget as before (room() knows the frame size without encoding it)", async () => {
    const world = new LiveWorld(smallConfig(), null);
    for (let i = 0; i < 20; i++) world.eco.step();
    const frame = world.creatureFrame().length;
    const connect = 2 * frame;
    const text = 10;
    const maxViewers = 100;
    const budget = Math.floor(3.5 * frame); // room for 3 viewers at the slowest rate (every 5th frame)
    const limits = { ...LIMITS, acceptBurst: 100, maxViewers, maxSendBytesPerSecond: budget + connect + maxViewers * text, connectBurstBytes: 0, connectBytesPerSecond: connect, textBytesPerViewer: text, detailBytesPerViewer: 0 };
    const { pub, port } = await serve(world, limits);
    await wait(500); // empty period: the frame loop has skipped encoding
    const ws = Array.from({ length: 40 }, () => watcher(port)); // all within about one frame interval
    await wait(800);
    const hellos = ws.filter((w) => w.texts.includes("hello")).length;
    expect(hellos).toBeGreaterThan(0);
    expect(hellos).toBeLessThanOrEqual(3);
    expect(pub.viewers()).toBeLessThanOrEqual(3);
  });
});

describe("no viewers: the stats pass", () => {
  const history = (live: LiveWorld): string => live.chronicle.history();
  for (const seed of [1, 2, 3]) {
    it(`history and lineage samples are the same with and without viewers, and the viewed records catch up, seed ${seed}`, () => {
      const c = smallConfig();
      c.seed = seed;
      const idle = new LiveWorld(structuredClone(c), null);
      const seen = new LiveWorld(structuredClone(c), null);
      for (let t = 0; t < 4000; t++) {
        idle.step();
        seen.step();
        if (t % 30 === 0) {
          const a = idle.stats(0, t % 150 === 0);
          const b = seen.stats(1, t % 150 === 0);
          expect(a.sample).toEqual(b.sample);
          expect(a.lineageSample).toEqual(b.lineageSample);
          expect(a.lineages).toBeUndefined(); // nobody reads them
          expect(a.population).toBe(b.population);
          expect(a.records).toBeUndefined(); // nobody reads them
        }
      }
      expect(history(idle)).toBe(history(seen));
      expect(JSON.parse(history(idle)).samples.length).toBeGreaterThan(0);
      // The first viewed pass after the idle period brings depth, best and the records up to date.
      const a = idle.stats(1, true);
      const b = seen.stats(1, true);
      expect(a.lineages).toEqual(b.lineages);
      expect(a.depth).toBe(b.depth);
      expect(a.best).toEqual(b.best);
      const board = (s: typeof a, name: string) => s.records!.find((r) => r.board === name)?.entries.map((e) => [e.id, e.value, e.alive]);
      expect(board(a, "age")).toEqual(board(b, "age"));
    });
  }

  it("the idle pass leaves no state a viewer can grow: no per-creature work and the same ring sizes", () => {
    const live = new LiveWorld(smallConfig(), null);
    for (let t = 0; t < 600; t++) live.step();
    const s = live.stats(0, true);
    expect(s.depth).toBe(0);
    expect(s.best).toBeNull();
    expect(s.records).toBeUndefined();
    expect(s.lineages).toBeUndefined();
    expect(live.stats(1).lineages!.length).toBeGreaterThan(0);
  });
});
