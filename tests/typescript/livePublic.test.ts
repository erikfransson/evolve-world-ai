// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import net from "node:net";
// @ts-expect-error the web tsconfig finds no types for the server's ws
import { WebSocket } from "../../server/node_modules/ws/wrapper.mjs";
import { LIMITS, MAX_POPULATION, liveConfig } from "../../server/src/config.ts";
import { applyTunables, tunableLimits } from "../../server/src/tunables.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { startPublic } from "../../server/src/public.ts";
import type { PublicServer } from "../../server/src/public.ts";
import { smallConfig } from "./liveHelpers.ts";

// The public server in this process on a small world, with test limits.
type Limits = typeof LIMITS;
const servers: PublicServer[] = [];
async function serve(port: number, change: Partial<Limits> = {}, world = new LiveWorld(smallConfig(), null)): Promise<{ pub: PublicServer; world: LiveWorld }> {
  const pub = startPublic("127.0.0.1", port, world, { ...LIMITS, ...change });
  servers.push(pub);
  await new Promise<void>((r) => (pub.http.listening ? r() : pub.http.once("listening", () => r())));
  return { pub, world };
}
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

interface Viewer {
  ws: WebSocket;
  texts: { t: string }[];
  binary: number; // bytes of binary frames
  status: Promise<"hello" | "busy" | number>; // what the server did first: hello, busy, or refused the upgrade with an http status
  closed: Promise<number>; // the close code
}
function viewer(port: number): Viewer {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const v: Viewer = { ws, texts: [], binary: 0, status: null!, closed: null! };
  v.status = new Promise((resolve) => {
    ws.on("unexpected-response", (_req: unknown, res: { statusCode: number }) => resolve(res.statusCode));
    ws.on("message", (d: Buffer, isBinary: boolean) => {
      if (isBinary) return void (v.binary += d.length);
      const m = JSON.parse(d.toString());
      v.texts.push(m);
      if (m.t === "hello" || m.t === "busy") resolve(m.t);
    });
  });
  v.closed = new Promise((resolve) => ws.on("close", (code: number) => resolve(code)));
  ws.on("error", () => {});
  return v;
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("public server: connections", () => {
  it("a reconnect loop gets at most the burst plus 10 new viewers a second, the rest refused before the upgrade", async () => {
    const port = 50411;
    const { pub } = await serve(port, { maxViewers: 1000, maxSendBytesPerSecond: 1e9 });
    const seconds = 3;
    let welcomed = 0;
    let refused = 0;
    const t0 = Date.now();
    // 20 clients in a loop: connect, wait for the first answer, cut the socket, again.
    const loop = async (): Promise<void> => {
      while (Date.now() - t0 < seconds * 1000) {
        const v = viewer(port);
        const s = await v.status;
        if (s === "hello") welcomed++;
        else if (s === 503) refused++;
        v.ws.terminate();
        await v.closed;
      }
    };
    await Promise.all(Array.from({ length: 20 }, loop));
    const elapsed = (Date.now() - t0) / 1000;
    expect(welcomed).toBeLessThanOrEqual(LIMITS.acceptBurst + Math.ceil(LIMITS.acceptsPerSecond * elapsed) + 1);
    expect(refused).toBeGreaterThan(welcomed);
    await vi.waitFor(() => expect(pub.viewers()).toBe(0));
  });

  it("tells a viewer past the cap it is busy and cuts it off, and counts only registered viewers", async () => {
    const port = 50412;
    const { pub } = await serve(port, { maxViewers: 3 });
    const vs = [viewer(port), viewer(port), viewer(port)];
    expect(await Promise.all(vs.map((v) => v.status))).toEqual(["hello", "hello", "hello"]);
    const extra = viewer(port);
    expect(await extra.status).toBe("busy");
    expect(await extra.closed).toBe(1006); // terminate, not a close handshake
    expect(pub.viewers()).toBe(3);
    vs[0]!.ws.close();
    await vi.waitFor(() => expect(pub.viewers()).toBe(2));
    expect(await viewer(port).status).toBe("hello");
  });

  it("closes a socket that never finishes its request headers", async () => {
    const port = 50413;
    await serve(port, { headersTimeoutMs: 1000 });
    const sock = net.connect(port, "127.0.0.1");
    sock.on("error", () => {});
    sock.resume(); // read, so the server's close arrives
    sock.write("GET / HTTP/1.1\r\nHost: x\r\n"); // and never the blank line
    const t0 = Date.now();
    await new Promise((r) => sock.on("close", r));
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it("sends the hello of a new world to every viewer, even one held back from frames", async () => {
    const port = 50414;
    const { world } = await serve(port, { maxBufferedBytes: -1 }); // every viewer counts as backed up
    const v = viewer(port);
    expect(await v.status).toBe("hello");
    world.onReseed!();
    await vi.waitFor(() => expect(v.texts.filter((m) => m.t === "hello").length).toBe(2));
  });
});

describe("public server: upload budget", () => {
  it("all viewers together stay inside the budget, and viewers past it are refused", async () => {
    const port = 50415;
    const world = new LiveWorld(smallConfig(), null);
    for (let i = 0; i < 20; i++) world.eco.step();
    const frame = world.creatureFrame().length; // per frame; item changes in this small world are a few bytes
    // Budget for frames: room for 6 viewers at the slowest rate (every 5th frame), and a small connect allowance.
    const connect = 2 * frame;
    const text = 10;
    const maxViewers = 100;
    const budget = Math.floor(6.5 * frame);
    const limits = { maxViewers, maxSendBytesPerSecond: budget + connect + maxViewers * text, connectBytesPerSecond: connect, textBytesPerViewer: text, detailBytesPerViewer: 0, acceptBurst: 100 };
    const { pub } = await serve(port, limits, world);
    await wait(300); // the first frame sets the per-viewer size
    const vs: Viewer[] = [];
    for (let i = 0; i < 12; i++) {
      vs.push(viewer(port));
      await vs.at(-1)!.status;
    }
    const outcome = await Promise.all(vs.map((v) => v.status));
    expect(outcome.filter((s) => s === "hello").length).toBe(6);
    expect(outcome.filter((s) => s !== "hello").every((s) => s === "busy")).toBe(true);
    expect(pub.viewers()).toBe(6);
    const before = vs.reduce((a, v) => a + v.binary, 0);
    const seconds = 3;
    await wait(seconds * 1000);
    const sent = vs.reduce((a, v) => a + v.binary, 0) - before;
    expect(sent).toBeLessThanOrEqual(seconds * budget * 1.15); // a frame boundary of slack
  });

  it("does not send the catch-up frames on connect past the connect allowance", async () => {
    const port = 50416;
    const world = new LiveWorld(smallConfig(), null);
    for (let i = 0; i < 20; i++) world.eco.step();
    const { pub } = await serve(port, { connectBytesPerSecond: 1, acceptBurst: 100 }, world);
    await wait(300);
    const v = viewer(port);
    expect(await v.status).toBe("hello");
    await wait(20);
    expect(v.binary).toBe(0); // only text so far, the frames come with the frame loop
    expect(pub.viewers()).toBe(1);
  });
});

describe("live world", () => {
  it("holds the population to 2500: the world, the admin limit, and a restored older save", () => {
    expect(liveConfig.eco.maxPopulation).toBe(MAX_POPULATION);
    expect(MAX_POPULATION).toBe(2500);
    const world = new LiveWorld(smallConfig(), null);
    expect(tunableLimits()["eco.maxPopulation"]!.max).toBe(2500);
    expect(applyTunables(world.eco, { "eco.maxPopulation": 2501 })).toMatch(/at most 2500/);
    expect(applyTunables(world.eco, { "eco.maxPopulation": 2500 })).toBeNull();
    const old = new LiveWorld(smallConfig(), null);
    old.eco.config.eco.maxPopulation = 10_000; // as saves made before the cap
    world.restoreState(JSON.parse(JSON.stringify(old.saveState())));
    expect(world.config.eco.maxPopulation).toBe(2500);
  });

  it("reports speed 0 while paused", async () => {
    const world = new LiveWorld(smallConfig(), null);
    for (let t = Date.now(); Date.now() - t < 1200; ) {
      world.advance();
      await wait(5);
    }
    expect(world.speed).toBeGreaterThan(0);
    world.paused = true;
    world.advance();
    expect(world.speed).toBe(0);
  });
});

describe("admin port", () => {
  it("the server exits with code 1 when the admin port is taken", async () => {
    const port = 50417;
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", r));
    try {
      const script = `import { startAdmin } from ${JSON.stringify(new URL("../../server/src/admin.ts", import.meta.url).href)};
        startAdmin("127.0.0.1", ${port}, "t", { eco: null }, "/nonexistent", "/nonexistent", {}, {});
        setTimeout(() => process.exit(0), 3000);`;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/admin port .*EADDRINUSE/);
    } finally {
      blocker.close();
    }
  });
});
