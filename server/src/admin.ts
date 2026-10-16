import { randomBytes, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { validName } from "../../src/typescript/src/live/add.ts";
import type { SaveInfo } from "./state.ts";
import { SEED_COPIES } from "./config.ts";
import { applyTunables, readTunables, tunableLimits } from "./tunables.ts";
import type { Value } from "./tunables.ts";

const AUTH_TIMEOUT_MS = 5000;
const MAX_ADMINS = 2;
const MAX_MESSAGE_BYTES = 4096;

// Creates the token file (mode 600) on first start and returns the token. It is never logged.
export function loadAdminToken(stateDir: string): string {
  const file = join(stateDir, "admin-token");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

export const OVERRIDES = "admin-overrides.json";
export const PREVIOUS_OVERRIDES = "admin-overrides.previous-world.json";
export const IGNORED_OVERRIDES = "admin-overrides.ignored.json";
const DROPPED = ["add.aliveShare", "add.aliveFloor"]; // settings an older version had; skipped in a saved overrides file, the rest still applies

// A fresh world starts from liveConfig: the overrides of the world before are moved aside (one copy kept, an older one replaced),
// so a later restart that restores the fresh world's save does not apply them. Returns the line to log, or null when there were none.
export function retireOverrides(stateDir: string): string | null {
  const file = join(stateDir, OVERRIDES);
  if (!existsSync(file)) return null;
  renameSync(file, join(stateDir, PREVIOUS_OVERRIDES));
  return `fresh world: ${OVERRIDES} of the world before moved to ${PREVIOUS_OVERRIDES}, not applied`;
}

// Re-applies the settings the admin changed before the last restart and returns those applied, so later changes are merged into them.
// Never all or nothing: a key this version does not know (a rollback past the version that added it) is skipped with a log line, the
// known ones are applied together, and if they are refused together each is tried alone, a refused one skipped with its reason. So a
// rollback never silently drops standing settings such as add.aliveMax. When anything is skipped the file is copied to IGNORED_OVERRIDES.
export function loadOverrides(stateDir: string, world: { eco: Ecosystem }): Record<string, Value> {
  const file = join(stateDir, OVERRIDES);
  if (!existsSync(file)) return {};
  const skipped: string[] = [];
  let applied: Record<string, Value> = {};
  try {
    const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("not an object of settings");
    const all = saved as Record<string, Value>;
    // 0.2.0 turned adding off with both alive keys at 0; keep it off rather than reopen it with the new aliveMax default.
    if (all["add.aliveShare"] === 0 && all["add.aliveFloor"] === 0 && !Object.hasOwn(all, "add.aliveMax")) all["add.aliveMax"] = 0;
    const known = tunableLimits();
    const kept: Record<string, Value> = {};
    for (const [k, v] of Object.entries(all)) {
      if (Object.hasOwn(known, k)) kept[k] = v;
      else if (DROPPED.includes(k)) console.log(`${OVERRIDES}: ${k} is no longer a setting (0.2.1: add.aliveMax), skipped`);
      else skipped.push(`${k} is not a setting of this version, skipped`);
    }
    if (!applyTunables(world.eco, kept)) applied = kept;
    else {
      for (const [k, v] of Object.entries(kept)) {
        const err = applyTunables(world.eco, { [k]: v });
        if (err) skipped.push(`${k} skipped: ${err}`);
        else applied[k] = v;
      }
    }
  } catch (e) {
    skipped.push(`not read: ${e instanceof Error ? e.message : e}`);
  }
  if (!skipped.length) return applied;
  for (const line of skipped) console.error(`OVERRIDES: ${OVERRIDES}: ${line}`);
  try {
    copyFileSync(file, join(stateDir, IGNORED_OVERRIDES)); // kept aside, as the next admin change writes the file anew
    console.error(`OVERRIDES: a copy of ${OVERRIDES} is in ${IGNORED_OVERRIDES}`);
  } catch (e) {
    console.error(`OVERRIDES: could not keep a copy: ${e instanceof Error ? e.message : e}`);
  }
  return applied;
}

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The running world; whenIdle (LiveWorld) runs a change between ticks, so none lands while helper threads are mid-tick.
export interface AdminWorld {
  eco: Ecosystem;
  whenIdle?<T>(fn: () => T): Promise<T>;
}

export interface AdminCommands {
  pause(): void;
  resume(): void;
  paused(): boolean;
  saveNow(): Promise<string>; // a short human line: what was saved, or why not
  listSaves(): SaveInfo[];
  loadSave(name: string): Promise<string>; // saves the running world, then restores; rejects with the reason and keeps the running world
  stop(): void | Promise<void>; // save, then exit with code 0
  blankName(name: string): Promise<number>; // families whose visitor name was cleared
  renameName(from: string, to: string, force: boolean): Promise<number | string>; // families renamed, or why not
  reset(copies: number): Promise<string>; // saves, moves the saves and settings aside, then exits 75, on which the unit starts it again with a fresh world (0, staying down, when a stop came meanwhile); rejects with the reason and keeps the world
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".ico": "image/x-icon" };

// Plain http file server for the built page, so the owner can open http://127.0.0.1:<admin port>/live/?admin. GET only, stays inside root.
function serveStatic(root: string): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    let file: string;
    try {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      file = normalize(join(root, path.endsWith("/") ? path + "index.html" : path));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (req.method !== "GET" || !file.startsWith(root + sep)) {
      res.writeHead(404).end();
      return;
    }
    try {
      if (statSync(file).isDirectory()) file = join(file, "index.html");
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
}

// Admin channel on its own port, bound to loopback and never put behind the tunnel. The first message must be {t:"auth", token}.
// Then: {t:"get-config"} -> {t:"config", values, limits, paused}; {t:"set-config", changes:{key:value}} -> {t:"config", ...} or {t:"error", message};
// {t:"pause"} / {t:"resume"} -> {t:"config", ...}; {t:"save-now"} -> {t:"saved", message}; {t:"list-saves"} -> {t:"saves", saves}; {t:"load-save", name} -> {t:"loaded", message} or {t:"error", message}; {t:"stop"} -> {t:"stopping"}, then the server saves and exits 0;
// {t:"blank-name", name} -> {t:"blanked", message}: the name is cleared from every family that carries it;
// {t:"rename", name, to, force?} -> {t:"renamed", message}: every family named exactly `name` is named `to` (starters stay starters);
// a `to` another living family carries is refused unless force;
// {t:"reset", copies?} -> {t:"resetting", message}, then the server exits 75, the unit starts it again, and that start seeds a fresh world with `copies` (default
// SEED_COPIES) of each founder; the world before is kept in before-reset-<time>/ in the state directory.
// The same port serves the built page (webRoot) over http.
export function startAdmin(host: string, port: number, token: string, world: AdminWorld, stateDir: string, webRoot: string, saved: Record<string, Value>, commands: AdminCommands): { wss: WebSocketServer; close(): void } {
  const http = serveStatic(webRoot);
  // Browsers only from the page this port serves, so another site open in the owner's browser cannot reach admin; non-browser clients send no Origin.
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const verifyClient = ({ origin }: { origin?: string }): boolean => origin === undefined || allowed.has(origin);
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false, verifyClient });
  const limits = tunableLimits();
  const idle = <T>(fn: () => T): Promise<T> => (world.whenIdle ? world.whenIdle(fn) : Promise.resolve().then(fn));
  const overrides = { ...saved };
  const reply = (ws: WebSocket, msg: object): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const config_ = (ws: WebSocket): void => reply(ws, { t: "config", values: readTunables(world.eco), limits, paused: commands.paused() });

  wss.on("error", (e) => console.warn("admin websocket server error:", e.message));
  wss.on("connection", (ws) => {
    ws.on("error", () => ws.terminate()); // e.g. a frame over the size limit
    if (wss.clients.size > MAX_ADMINS) return void ws.close(1013);
    let authed = false;
    const timer = setTimeout(() => !authed && ws.close(1008, "auth timeout"), AUTH_TIMEOUT_MS);
    ws.on("close", () => clearTimeout(timer));
    ws.on("message", (data, isBinary) => {
      try {
        handle(data, isBinary);
      } catch (e) {
        reply(ws, { t: "error", message: why(e) });
      }
    });
    const handle = (data: import("ws").RawData, isBinary: boolean): void => {
      let msg: { t?: unknown; token?: unknown; changes?: unknown; name?: unknown; to?: unknown; force?: unknown; copies?: unknown };
      try {
        if (isBinary) throw new Error("binary");
        msg = JSON.parse(data.toString());
      } catch {
        return void ws.close(1008, "bad message");
      }
      if (!authed) {
        if (msg.t !== "auth" || !sameToken(msg.token, token)) return void ws.close(1008, "unauthorised");
        authed = true;
        return void reply(ws, { t: "authed" });
      }
      if (msg.t === "get-config") return config_(ws);
      if (msg.t === "set-config") {
        const changes = msg.changes;
        return void idle(() => applyTunables(world.eco, changes)).then((err) => {
          if (err) return reply(ws, { t: "error", message: err });
          Object.assign(overrides, changes);
          try {
            const file = join(stateDir, OVERRIDES);
            writeFileSync(file + ".tmp", JSON.stringify(overrides, null, 2), { mode: 0o600 });
            renameSync(file + ".tmp", file);
          } catch (e) {
            return reply(ws, { t: "error", message: `applied, but could not save: ${e instanceof Error ? e.message : e}` });
          }
          config_(ws);
        }, (e) => reply(ws, { t: "error", message: why(e) }));
      }
      if (msg.t === "pause" || msg.t === "resume") {
        if (msg.t === "pause") commands.pause();
        else commands.resume();
        return config_(ws);
      }
      if (msg.t === "save-now") return void commands.saveNow().then((message) => reply(ws, { t: "saved", message }), (e) => reply(ws, { t: "error", message: why(e) }));
      if (msg.t === "list-saves") return reply(ws, { t: "saves", saves: commands.listSaves() });
      if (msg.t === "load-save") {
        if (typeof msg.name !== "string") return reply(ws, { t: "error", message: "name must be a string" });
        return void commands.loadSave(msg.name).then(
          (message) => void idle(() => applyTunables(world.eco, overrides)).then(
            // the admin's standing settings apply to whatever world is running
            (err) => reply(ws, err ? { t: "error", message: `loaded, but the saved settings were not applied: ${err}` } : { t: "loaded", message }),
            (e) => reply(ws, { t: "error", message: `loaded, but the saved settings were not applied: ${why(e)}` }),
          ),
          (e) => reply(ws, { t: "error", message: why(e) }),
        );
      }
      if (msg.t === "blank-name") {
        if (!validName(msg.name)) return reply(ws, { t: "error", message: "name must be 1 to 16 letters or digits, as viewers see it" });
        return void commands.blankName(msg.name).then((n) => reply(ws, { t: "blanked", message: `cleared the name from ${n} ${n === 1 ? "family" : "families"}` }), (e) => reply(ws, { t: "error", message: why(e) }));
      }
      if (msg.t === "rename") {
        if (!validName(msg.name) || !validName(msg.to)) return reply(ws, { t: "error", message: "both names must be 1 to 16 letters or digits" });
        return void commands.renameName(msg.name, msg.to, msg.force === true).then((n) => reply(ws, typeof n === "string" ? { t: "error", message: n } : { t: "renamed", message: `renamed ${n} ${n === 1 ? "family" : "families"}` }), (e) => reply(ws, { t: "error", message: why(e) }));
      }
      if (msg.t === "reset") {
        const copies = msg.copies === undefined ? SEED_COPIES : msg.copies; // absent: the default; null and anything else not whole is refused
        if (typeof copies !== "number" || !Number.isInteger(copies)) return reply(ws, { t: "error", message: "copies must be a whole number" });
        return void commands.reset(copies).then((message) => reply(ws, { t: "resetting", message }), (e) => reply(ws, { t: "error", message: why(e) }));
      }
      if (msg.t === "stop") {
        reply(ws, { t: "stopping" });
        return void commands.stop();
      }
      reply(ws, { t: "error", message: "unknown message" });
    };
  });
  // Without its own admin port the server must not run: another local process could take the port and catch the CLI's token.
  http.on("error", (e) => {
    console.error(`admin port ${port}: ${e.message}`);
    process.exit(1);
  });
  http.listen(port, host);
  return { wss, close: () => { wss.close(); http.close(); } };
}
