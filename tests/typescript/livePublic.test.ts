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

// Test ports sit above the Linux ephemeral range (32768-60999), so a test client's own socket can never hold a server's port (EADDRINUSE).
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
    const port = 62411;
    const { pub } = await serve(port, { maxViewers: 1000, maxSendBytesPerSecond: 1e9 });
    // A fixed number of attempts rather than a fixed time, so a loaded machine that connects slowly still makes far more attempts
    // than the bucket lets in (the allowance below grows with the time they took).
    const attempts = 150;
    let started = 0;
    let welcomed = 0;
    let refused = 0;
    const t0 = Date.now();
    // 20 clients in a loop: connect, wait for the first answer, cut the socket, again.
    const loop = async (): Promise<void> => {
      while (started < attempts) {
        started++;
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
    const allowance = LIMITS.acceptBurst + Math.ceil(LIMITS.acceptsPerSecond * elapsed) + 1;
    expect(welcomed + refused).toBe(attempts); // every attempt got a hello or a 503, nothing else
    expect(welcomed).toBeLessThanOrEqual(allowance);
    expect(attempts).toBeGreaterThan(allowance); // the loop outpaced the accept rate, so the refusals below are the bucket's
    expect(refused).toBeGreaterThanOrEqual(attempts - allowance);
    await vi.waitFor(() => expect(pub.viewers()).toBe(0));
  }, 60_000);

  it("tells a viewer past the cap it is busy and cuts it off, and counts only registered viewers", async () => {
    const port = 62412;
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
    const port = 62413;
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
    const port = 62414;
    const { world } = await serve(port, { maxBufferedBytes: -1 }); // every viewer counts as backed up
    const v = viewer(port);
    expect(await v.status).toBe("hello");
    world.onReseed!();
    await vi.waitFor(() => expect(v.texts.filter((m) => m.t === "hello").length).toBe(2));
  });
});

describe("public server: GET /stats", () => {
  it("answers two public numbers, small and cacheable, and every other request still gets a 426", async () => {
    const port = 62418;
    await serve(port);
    const r = await fetch(`http://127.0.0.1:${port}/stats`);
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("content-type")).toBe("application/json");
    const body = await r.text();
    expect(body.length).toBeLessThan(128);
    const j = JSON.parse(body);
    expect(Object.keys(j).sort()).toEqual(["creatures", "viewers"]);
    expect(Number.isInteger(j.creatures) && Number.isInteger(j.viewers)).toBe(true);
    for (const [path, method] of [["/stats", "POST"], ["/stats?x=1", "GET"], ["/", "GET"], ["/stats/", "GET"], ["/stats", "HEAD"]] as const) {
      expect((await fetch(`http://127.0.0.1:${port}${path}`, { method })).status, `${method} ${path}`).toBe(426);
    }
  });

  it("rebuilds the numbers at most once a statsEveryMs, so a flood of requests costs no work", async () => {
    const port = 62419;
    await serve(port, { statsEveryMs: 60_000 });
    const before = await (await fetch(`http://127.0.0.1:${port}/stats`)).text();
    const v = viewer(port);
    expect(await v.status).toBe("hello");
    expect(await (await fetch(`http://127.0.0.1:${port}/stats`)).text()).toBe(before); // the viewer is not counted until the next rebuild
  });

  it("answers a 503 and keeps serving when the numbers cannot be read", async () => {
    const port = 62422;
    const { world } = await serve(port);
    const eco = world.eco;
    Object.defineProperty(world, "eco", { configurable: true, get: () => { throw new Error("mid-swap"); } });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await fetch(`http://127.0.0.1:${port}/stats`)).status).toBe(503);
    quiet.mockRestore();
    Object.defineProperty(world, "eco", { configurable: true, value: eco, writable: true });
    expect((await fetch(`http://127.0.0.1:${port}/stats`)).status).toBe(200);
  });

  it("a request flood gets at most the burst plus the rate, the rest a 503", async () => {
    const port = 62420;
    await serve(port, { statsGetsPerSecond: 1, statsGetBurst: 3 });
    const t0 = Date.now();
    const codes = await Promise.all(Array.from({ length: 40 }, async () => (await fetch(`http://127.0.0.1:${port}/stats`)).status));
    const allowance = 3 + Math.ceil((Date.now() - t0) / 1000) + 1;
    const ok = codes.filter((c) => c === 200).length;
    expect(ok + codes.filter((c) => c === 503).length).toBe(40);
    expect(ok).toBeLessThanOrEqual(allowance);
  });

  it("does not read a request body: a huge upload to /stats is cut off", async () => {
    const port = 62421;
    await serve(port);
    const sock = net.connect(port, "127.0.0.1");
    sock.on("error", () => {});
    sock.resume();
    sock.write("GET /stats HTTP/1.1\r\nHost: x\r\nContent-Length: 1000000000\r\n\r\n");
    const chunk = Buffer.alloc(64 * 1024);
    let written = 0;
    const closed = new Promise((r) => sock.on("close", r));
    const pump = setInterval(() => {
      if (!sock.destroyed && written < 50e6) written += sock.write(chunk) ? chunk.length : 0;
    }, 1);
    await closed;
    clearInterval(pump);
    expect(written).toBeLessThan(50e6); // closed long before the body was in (the reply itself may be lost to the reset)
  }, 20_000);
});

describe("public server: upload budget", () => {
  it("all viewers together stay inside the budget, and viewers past it are refused", async () => {
    const port = 62415;
    const world = new LiveWorld(smallConfig(), null);
    for (let i = 0; i < 20; i++) world.eco.step();
    const frame = world.creatureFrame().length; // per frame; item changes in this small world are a few bytes
    // Budget for frames: room for 6 viewers at the slowest rate (every 5th frame), and a small connect allowance.
    const connect = 2 * frame;
    const text = 10;
    const maxViewers = 100;
    const budget = Math.floor(6.5 * frame);
    const limits = { maxViewers, maxSendBytesPerSecond: budget + connect + maxViewers * text, connectBurstBytes: 0, connectBytesPerSecond: connect, textBytesPerViewer: text, detailBytesPerViewer: 0, acceptBurst: 100 };
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
    const port = 62416;
    const world = new LiveWorld(smallConfig(), null);
    for (let i = 0; i < 20; i++) world.eco.step();
    const { pub } = await serve(port, { connectBurstBytes: 0, connectBytesPerSecond: 1, acceptBurst: 100 }, world);
    await wait(300);
    const v = viewer(port);
    expect(await v.status).toBe("hello");
    await wait(20);
    expect(v.binary).toBe(0); // only text so far, the frames come with the frame loop
    expect(pub.viewers()).toBe(1);
  });
});

describe("live world", () => {
  it("holds the population to 3000: the world, the admin limit, and a restored older save", () => {
    expect(liveConfig.eco.maxPopulation).toBe(MAX_POPULATION);
    expect(MAX_POPULATION).toBe(3000);
    const world = new LiveWorld(smallConfig(), null);
    expect(tunableLimits()["eco.maxPopulation"]!.max).toBe(3000);
    expect(applyTunables(world.eco, { "eco.maxPopulation": 3001 })).toMatch(/at most 3000/);
    expect(applyTunables(world.eco, { "eco.maxPopulation": 3000 })).toBeNull();
    const old = new LiveWorld(smallConfig(), null);
    old.eco.config.eco.maxPopulation = 10_000; // as saves made before the cap
    world.restoreState(JSON.parse(JSON.stringify(old.saveState())));
    expect(world.config.eco.maxPopulation).toBe(3000);
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
    const port = 62417;
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
