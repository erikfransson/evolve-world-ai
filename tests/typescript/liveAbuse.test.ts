// @vitest-environment node
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error the web tsconfig finds no types for the server's ws
import { WebSocket, WebSocketServer } from "../../server/node_modules/ws/wrapper.mjs";
import { loadOverrides, startAdmin } from "../../server/src/admin.ts";
import { dropReason } from "../../server/src/clients.ts";
import type { ClientState } from "../../server/src/clients.ts";
import { LIMITS } from "../../server/src/config.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { smallConfig } from "./liveHelpers.ts";
import { StateStore } from "../../server/src/state.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "evolve-abuse-"));

describe("admin overrides", () => {
  it("merges a new change into the ones saved before a restart", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "admin-overrides.json"), JSON.stringify({ "eco.hueDrift": 10 }));
    const world = new LiveWorld(smallConfig(), null);
    const saved = loadOverrides(dir, world);
    const admin = startAdmin("127.0.0.1", 43517, "tok", world, dir, dir, saved, { pause() {}, resume() {}, paused: () => false, saveNow: async () => "", listSaves: () => [], loadSave: async () => "", stop() {} });
    const ws = new WebSocket("ws://127.0.0.1:43517/");
    const replies: { t: string }[] = [];
    ws.on("message", (d: Buffer) => replies.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "auth", token: "tok" }));
    ws.send(JSON.stringify({ t: "set-config", changes: { "mutation.rate": 0.1 } }));
    await vi.waitFor(() => expect(replies.map((m) => m.t)).toEqual(["authed", "config"]));
    expect(JSON.parse(readFileSync(join(dir, "admin-overrides.json"), "utf8"))).toEqual({ "eco.hueDrift": 10, "mutation.rate": 0.1 });
    ws.close();
    admin.close();
  });
});

describe("slow readers", () => {
  const state = (): ClientState => ({ alive: true, lastMessageAt: 0, overSince: 0, windowAt: 0, windowCount: 0 });

  // A server socket whose peer never reads, filled with 256 kB frames until its queue passes `bytes`.
  async function slowClient(port: number, bytes: number) {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    const server = new Promise<{ bufferedAmount: number; send(d: Buffer): void }>((r) => wss.on("connection", r));
    await new Promise<void>((r) => http.listen(port, "127.0.0.1", r));
    const raw = net.connect(port, "127.0.0.1");
    raw.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    raw.pause();
    const ws = await server;
    for (let i = 0; i < 2000 && ws.bufferedAmount <= bytes; i++) ws.send(Buffer.alloc(256 * 1024));
    return { ws, done: () => { raw.destroy(); wss.close(); http.close(); } };
  }

  it("drops a client whose queue passes the hard cap", async () => {
    const { ws, done } = await slowClient(43518, LIMITS.hardBufferedBytes);
    expect(ws.bufferedAmount).toBeGreaterThan(LIMITS.hardBufferedBytes);
    expect(dropReason(ws.bufferedAmount, state(), 1000)).toMatch(/hard cap/);
    done();
  });

  it("drops a client held above the frame-skip level for more than 10 s, not before", async () => {
    const { ws, done } = await slowClient(43519, LIMITS.maxBufferedBytes);
    expect(ws.bufferedAmount).toBeGreaterThan(LIMITS.maxBufferedBytes);
    expect(ws.bufferedAmount).toBeLessThan(LIMITS.hardBufferedBytes);
    const c = state();
    c.lastMessageAt = 1000;
    expect(dropReason(ws.bufferedAmount, c, 1000)).toBeNull();
    expect(dropReason(ws.bufferedAmount, c, 1000 + LIMITS.slowDropMs - 1000)).toBeNull();
    expect(dropReason(ws.bufferedAmount, c, 1000 + LIMITS.slowDropMs + 1000)).toMatch(/too long/);
    done();
  });

  it("forgives a client that drains below the frame-skip level", () => {
    const c = state();
    c.lastMessageAt = 1000;
    dropReason(LIMITS.maxBufferedBytes + 1, c, 1000);
    expect(dropReason(0, c, 2000)).toBeNull();
    expect(c.overSince).toBe(0);
  });
});

describe("state directory", () => {
  it("is created with mode 700 when missing", () => {
    const dir = join(tmp(), "a", "state");
    new StateStore(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
