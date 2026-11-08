// One B4 measurement: node run.mjs DIST TIER BODY MODE OUT.jsonl   (MODE fresh = PPO tier recipe, es = pretrain + fine-tune; BODY p3, p6 or grazer)
// Serves DIST on 127.0.0.1 only, starts one headless Chrome, runs the harness page once, appends one JSON line to OUT. Needs puppeteer-core on NODE_PATH-style resolution (scratch install).
import { createServer } from "node:http";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { loadavg, freemem } from "node:os";
import puppeteer from "puppeteer-core";

const [dist, tier, body, mode, out] = process.argv.slice(2);
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const f = join(dist, p.endsWith("/") ? p + "index.html" : p);
  if (!f.startsWith(dist) || !existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const load0 = loadavg()[0];
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, protocolTimeout: 0, args: ["--no-sandbox", "--disable-gpu"] });
const pid = browser.process()?.pid;
let code = 0;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await page.waitForFunction("typeof window.runB4 === 'function'");
  const spec = { tier, body, fresh: mode === "fresh" };
  const result = await page.evaluate((s) => window.runB4(s), spec); // no timeout: the page ends the run itself
  const load1 = loadavg()[0];
  const line = { ...result, load0, load1, freeGb: +(freemem() / 2 ** 30).toFixed(1), ua: await browser.version(), total: (Date.now() - t0) / 1000, at: new Date().toISOString() };
  appendFileSync(out, JSON.stringify(line) + "\n");
  console.log(tier, body, mode, "wall", result.wall.toFixed(1), result.phases.map((p) => `iters ${p.iters} eps ${p.episodes} ready ${p.readyAt.toFixed(1)}`).join(" | "), "load", load0, "->", load1);
} catch (e) {
  console.error("failed:", e.message);
  code = 1;
} finally {
  await browser.close().catch(() => {});
  try { if (pid) process.kill(pid, 0), process.kill(pid); } catch { /* already gone */ }
  server.close();
}
process.exit(code);
