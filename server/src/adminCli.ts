import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// Usage: npm run admin -- status | get | pause | resume | save | saves | load <name> | blank-name <name> | rename <from> <to> | stop | speed <x> | set key=value [key=value ...]
const port = Number(process.env.LIVE_ADMIN_PORT ?? 8788);
const stateDir = process.env.LIVE_STATE_DIR ?? fileURLToPath(new URL("../state", import.meta.url));
const TIMEOUT_MS = 60_000; // a save or load of a big world takes seconds

const [cmd, ...args] = process.argv.slice(2);
const parse = (v: string): number | boolean | number[] => (v === "true" ? true : v === "false" ? false : v.includes(",") ? v.split(",").map(Number) : Number(v)); // a,b for a range

function request(): object {
  if (cmd === "status" || cmd === "get") return { t: "get-config" };
  if (cmd === "pause" || cmd === "resume" || cmd === "stop") return { t: cmd };
  if (cmd === "save") return { t: "save-now" };
  if (cmd === "saves") return { t: "list-saves" };
  if (cmd === "load" && args.length === 1) return { t: "load-save", name: args[0] };
  if (cmd === "blank-name" && args.length === 1) return { t: "blank-name", name: args[0] };
  if (cmd === "rename" && args.length === 2) return { t: "rename", name: args[0], to: args[1] };
  if (cmd === "speed" && args.length === 1) return { t: "set-config", changes: { speed: parse(args[0]!) } };
  if (cmd === "set" && args.length > 0 && args.every((a) => a.includes("="))) {
    return { t: "set-config", changes: Object.fromEntries(args.map((a) => [a.slice(0, a.indexOf("=")), parse(a.slice(a.indexOf("=") + 1))])) };
  }
  console.error("usage: npm run admin -- status | get | pause | resume | save | saves | load <name> | blank-name <name> | rename <from> <to> | stop | speed <x> | set key=value [key=value ...]");
  return process.exit(2);
}

function show(msg: { t: string; [k: string]: unknown }): void {
  if (msg.t === "config") {
    const values = msg.values as Record<string, number | boolean>;
    console.log(msg.paused ? "paused" : "running");
    const limits = msg.limits as Record<string, { min: number; max: number }>;
    const shown = cmd === "get" ? Object.keys(values) : cmd === "set" ? args.map((a) => a.split("=")[0]!) : cmd === "speed" ? ["speed"] : [];
    for (const k of shown) console.log(`${k.padEnd(24)} ${String(values[k]).padEnd(8)} (${limits[k]!.min} to ${limits[k]!.max ?? "any"})`);
  } else if (msg.t === "saves") {
    const saves = msg.saves as { name: string; bytes: number; population?: number; tick?: number }[];
    if (saves.length === 0) console.log("no saves");
    for (const s of saves) console.log(`${s.name}  ${(s.bytes / 1e6).toFixed(2)} MB  ${s.population === undefined ? "?" : s.population} creatures  tick ${s.tick ?? "?"}`);
  } else console.log(String(msg.message ?? msg.t));
}

const body = request();
const token = readFileSync(`${stateDir}/admin-token`, "utf8").trim();
const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
const fail = (why: string): never => {
  console.error(why);
  return process.exit(1);
};
setTimeout(() => fail(`no answer from the admin port ${port}`), TIMEOUT_MS).unref();
ws.on("error", (e) => fail(`cannot reach the admin port ${port}: ${e.message}`));
ws.on("close", (code, reason) => fail(`closed by the server (${code} ${reason})`));
ws.on("open", () => ws.send(JSON.stringify({ t: "auth", token })));
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.t === "authed") return ws.send(JSON.stringify(body));
  if (msg.t === "error") return fail(`error: ${msg.message}`);
  show(msg);
  ws.removeAllListeners("close");
  ws.close();
  process.exit(0);
});
