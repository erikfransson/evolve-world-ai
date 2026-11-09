// Renders the Live map for the landing page's Live World card with the page's own drawing code in headless Chrome and writes
// src/ui/landing/live-map.webp and liveMapGrid.ts. Run from src/typescript after the map or its drawing code changes:
//   node scripts/landing/buildLandingMap.ts            (MAP=<name> for another map, CHROME=/path/to/chrome to pick the browser)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { LIVE_MAP } from "../../src/live/mapTerrain.ts";

const NAME = process.env.MAP ?? LIVE_MAP;
const root = new URL("../..", import.meta.url).pathname;
const out = (f: string): string => join(root, "src/ui/landing", f);

const server = await createServer({ root, configFile: join(root, "vite.config.ts"), server: { port: 0, host: "127.0.0.1" }, logLevel: "warn" });
await server.listen();
const addr = server.httpServer!.address() as { port: number };
const profile = mkdtempSync(join(tmpdir(), "landingmap-"));
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
  const { result: t } = await send("Target.createTarget", { url: `http://127.0.0.1:${addr.port}/scripts/landing/mapshot.html?map=${NAME}` });
  const { result: s } = await send("Target.attachToTarget", { targetId: t!.targetId, flatten: true });
  let images: { webp: string; grid: string; GW: number; GH: number; title: string } | null = null;
  for (let i = 0; i < 600 && !images; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const r = await send("Runtime.evaluate", { expression: "window.__out ?? null", returnByValue: true }, s!.sessionId);
    images = (r.result?.result?.value as typeof images) ?? null;
  }
  if (!images) throw new Error("the page made no picture in 5 minutes");
  ws.close();
  writeFileSync(out("live-map.webp"), Buffer.from(images.webp.slice(images.webp.indexOf(",") + 1), "base64"));
  writeFileSync(
    out("liveMapGrid.ts"),
    `// The Live map (${images.title}) on a ${images.GW} x ${images.GH} grid for the Live World card, one byte a cell: rock (bit 7), poison 0-7 (bits 4-6), food 0-15 (bits 0-3).\n` +
      `// Sampled from the real map together with live-map.webp by scripts/landing/buildLandingMap.ts; run it again if the map changes.\n` +
      `export const GRID_W = ${images.GW};\nexport const GRID_H = ${images.GH};\nexport const GRID = "${images.grid}";\n`,
  );
  console.log(`${NAME}: wrote live-map.webp and liveMapGrid.ts`);
} finally {
  await stop();
}
