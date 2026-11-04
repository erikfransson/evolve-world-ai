// Renders the Live map's ground pictures with the page's own drawing code in headless Chrome and writes them to src/live/maps/:
// <name>-ground-<scale>.webp per BACKDROP_SCALES, <name>-ground-preview.webp, <name>-ground-winter.png, and <name>-ground.json with the hashes mapImage.test.ts checks, so
// a change to the map or to the drawing code fails the tests until this is run again. Run from src/typescript, after scripts/buildMapAsset.ts:
//   node scripts/buildMapImage.ts            (CHROME=/path/to/chrome to pick the browser)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { groundImageHashes } from "./mapImageHash.ts";

const NAME = "inland-sea";
const root = new URL("..", import.meta.url).pathname;
const out = (f: string): string => join(root, "src/live/maps", f);

const server = await createServer({ root, configFile: join(root, "vite.config.ts"), server: { port: 0, host: "127.0.0.1" }, logLevel: "warn" });
await server.listen();
const addr = server.httpServer!.address() as { port: number };
const profile = mkdtempSync(join(tmpdir(), "mapimage-"));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(process.env.CHROME ?? "google-chrome", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore", detached: true });
const stop = async (): Promise<void> => {
  try {
    process.kill(-chrome.pid!, "SIGKILL");
  } catch {
    // gone already
  }
  await server.close();
  rmSync(profile, { recursive: true, force: true });
};

try {
  let ver: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 100 && !ver; i++) {
    try {
      ver = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!ver) throw new Error("Chrome did not start");
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map<number, (m: { result?: { targetId?: string; sessionId?: string; result?: { value?: unknown } } }) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<{ result?: { targetId?: string; sessionId?: string; result?: { value?: unknown } } }>((r) => {
      pending.set(++id, r);
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const { result: t } = await send("Target.createTarget", { url: `http://127.0.0.1:${addr.port}/scripts/mapImage.html?map=${NAME}&q=${process.env.Q ?? 0.85}` });
  const { result: s } = await send("Target.attachToTarget", { targetId: t!.targetId, flatten: true });
  let images: Record<string, string> | null = null;
  for (let i = 0; i < 600 && !images; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const r = await send("Runtime.evaluate", { expression: "window.__out ?? null", returnByValue: true }, s!.sessionId);
    images = (r.result?.result?.value as Record<string, string> | null) ?? null;
  }
  if (!images) throw new Error("the page made no pictures in 5 minutes");
  ws.close();
  for (const [key, url] of Object.entries(images)) {
    const file = out(`${NAME}-ground-${key}.${key === "winter" ? "png" : "webp"}`);
    const bytes = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
    writeFileSync(file, bytes);
    console.log(`${file}: ${bytes.length} bytes`);
  }
  writeFileSync(out(`${NAME}-ground.json`), JSON.stringify(groundImageHashes(NAME), null, 1) + "\n");
} finally {
  await stop();
}
