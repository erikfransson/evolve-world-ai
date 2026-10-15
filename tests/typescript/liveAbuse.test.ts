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
import { loadFounders } from "../../server/src/founders.ts";
import { wireName } from "../../src/typescript/src/live/add.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "evolve-abuse-"));

describe("admin overrides", () => {
  it("merges a new change into the ones saved before a restart", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "admin-overrides.json"), JSON.stringify({ "eco.hueDrift": 10 }));
    const world = new LiveWorld(smallConfig(), null);
    const saved = loadOverrides(dir, world);
    const admin = startAdmin("127.0.0.1", 62517, "tok", world, dir, dir, saved, { pause() {}, resume() {}, paused: () => false, saveNow: async () => "", listSaves: () => [], loadSave: async () => "", stop() {}, blankName: async () => 0 });
    const ws = new WebSocket("ws://127.0.0.1:62517/");
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

describe("admin blank-name", () => {
  it("clears a visitor's name from every family that carries it, starters and other names untouched; a bad name is refused", async () => {
    const dir = tmp();
    const world = new LiveWorld(smallConfig(), null);
    const add = (name: string, copies: number): number[] => {
      const f = loadFounders(new URL("../../src/typescript/public/live-founders.json", import.meta.url).pathname)[0]!;
      const r = world.addCreatures({ plan: f.plan, genome: f.genome, birth: { energy: 150, cost: 70, cooldown: 10 }, name, hue: 10, copies });
      if (!("ids" in r)) throw new Error(r.reason);
      return r.ids;
    };
    const rude = [...add("Rude", 2), ...add("Rude", 1)];
    const kind = add("Kind", 1);
    const admin = startAdmin("127.0.0.1", 62521, "tok", world, dir, dir, {}, { pause() {}, resume() {}, paused: () => false, saveNow: async () => "", listSaves: () => [], loadSave: async () => "", stop() {}, blankName: async (n) => world.blankName(n) });
    const ws = new WebSocket("ws://127.0.0.1:62521/");
    const replies: { t: string; message?: string }[] = [];
    ws.on("message", (d: Buffer) => replies.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "auth", token: "tok" }));
    ws.send(JSON.stringify({ t: "blank-name", name: "not ok!" }));
    ws.send(JSON.stringify({ t: "blank-name", name: "Rude" }));
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(replies[1]).toMatchObject({ t: "error", message: expect.stringMatching(/letters or digits/) });
    expect(replies[2]).toEqual({ t: "blanked", message: "cleared the name from 3 families" });
    for (const id of rude) expect(wireName(world.eco.lineageName(id))).toEqual({ name: "", starter: false });
    expect(world.eco.lineageName(kind[0]!)).toBe("Kind");
    const restored = new LiveWorld(smallConfig(), null);
    restored.restoreState(JSON.parse(JSON.stringify(world.saveState())));
    expect(wireName(restored.eco.lineageName(rude[0]!)).name).toBe(""); // a save keeps it blank
    expect(restored.aliveAdded()).toBe(world.aliveAdded()); // and the families still count as visitor adds
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
    const { ws, done } = await slowClient(62518, LIMITS.hardBufferedBytes);
    expect(ws.bufferedAmount).toBeGreaterThan(LIMITS.hardBufferedBytes);
    expect(dropReason(ws.bufferedAmount, state(), 1000)).toMatch(/hard cap/);
    done();
  });

  it("drops a client held above the frame-skip level for more than 10 s, not before", async () => {
    const { ws, done } = await slowClient(62519, LIMITS.maxBufferedBytes);
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
