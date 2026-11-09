// Saves one PNG of the Live world every INTERVAL_S seconds, one folder per world (per reset). Plain read-only viewer of the public page.
// Run: nice -n 19 ionice -c3 chrt --idle 0 node tools/timelapse/timelapse.mjs [framing=a|b|c] [base=<dir>] [maxRunS=<seconds>]
import { createRequire } from "node:module";
import { appendFileSync, statSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// parameters
const PUPPETEER = process.env.PUPPETEER ?? "/tmp/claude-1000/-home-erik-progs-evolve-world-ai/9b5abbad-4dc2-4d80-9b43-9341a2efeec2/scratchpad/tools/node_modules/puppeteer-core";
const CHROME = "/usr/bin/google-chrome";
const PAGE_URL = process.env.PAGE_URL ?? "https://erikfransson.github.io/evolve-world-ai/live/"; // a locally served page may add ?server=ws://127.0.0.1:8787
const FRAMINGS = {
  // CSS viewport 1920 x 1200 at deviceScaleFactor dsf: the canvas gets 1920*dsf x 1200*dsf pixels and the page's UI (time chip) keeps the same share of the frame
  a: { w: 1920, h: 1200, dsf: 2, zoomIns: 0 }, // whole map, 3840 x 2400
  b: { w: 1920, h: 1200, dsf: 4, zoomIns: 0 }, // whole map, 7680 x 4800
  c: { w: 1920, h: 1200, dsf: 2, zoomIns: 3 }, // closer, centred on the hub, 3840 x 2400 (zoom step 1.6 each)
};
const FRAMING = process.argv[2] ?? "a";
const BASE = process.argv[3] ?? "./timelapse-frames";
const MAX_RUN_S = Number(process.argv[4] ?? 0); // 0 = run until killed
const INTERVAL_S = 20; // frames, aligned to the wall clock
const POP_EVERY_S = 5; // population.jsonl lines, a divisor of INTERVAL_S
const POP_CAP_BYTES = 500e6; // per world folder
const MAX_LINEAGES = 32; // per population line (the server sends at most 8)
const CAP_BYTES = 10e9; // per world folder
const FREE_FLOOR_BYTES = 20e9; // stop capturing when the disk has less free
const STALE_CAPTURES = 3; // same tick this many captures in a row = frozen, reload
const STATS_MAX_AGE_S = 15; // stats arrive about each second; older = link is dead
const RESET_TICK_DROP = 100; // a tick this far below the last one = new world
const SHOW_TIMER = true; // keep the simulated-time and season badge in the picture
const METHOD = process.env.METHOD ?? "shot"; // "shot" = page.screenshot (includes the time chip, a DOM overlay), "canvas" = canvas.toDataURL (canvas only, faster, no chip)
const CHROME_ARGS = ["--no-sandbox", "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,BlockInsecurePrivateNetworkRequests", "--js-flags=--max-old-space-size=2048"]; // 1st: the public page is on the internet, the server resolves to this machine
const HIDE_CSS = `.banner,.panel,.ov-stack,.zoom,#emptyNote,#entry,#worldLoading,.entry-live,${SHOW_TIMER ? "" : "#timer,"}.info{display:none!important}
html,body{overflow:hidden!important;height:100%!important;margin:0!important}
.layout.live{position:fixed!important;inset:0!important;padding:0!important;margin:0!important;height:100vh!important;min-height:0!important}
.stage{position:fixed!important;inset:0!important}
.stage>canvas{border:0!important;border-radius:0!important}`;

const puppeteer = createRequire(import.meta.url)(PUPPETEER);
const F = FRAMINGS[FRAMING];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s, n = 40) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n) || "x";
const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
const log = (...a) => console.log(new Date().toISOString(), ...a);
mkdirSync(BASE, { recursive: true });

// state fed by the page's websocket frames (CDP), so the page itself is untouched
let hello = null, stats = null, statsAt = 0;
let world = null; // { id, dir, bytes, frames, lastTick, capped, staleN }
let browser = null, page = null, loads = 0, errorsInRow = 0;

function worldId() {
  const m = hello?.map ?? {};
  return [safe(m.name, 20), `${Math.round(hello?.world?.width ?? 0)}x${Math.round(hello?.world?.height ?? 0)}`, safe(m.version, 20)].join("-");
}
function onFrame(e) {
  if (e.response.opcode !== 1) return;
  let m;
  try { m = JSON.parse(e.response.payloadData); } catch { return; }
  if (m?.t === "hello") hello = m;
  else if (m?.t === "stats" && Number.isFinite(m.tick)) { stats = m; statsAt = Date.now(); }
}

async function openPage() {
  try { await browser?.close(); } catch {}
  hello = stats = null; statsAt = 0;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
  browser.on("disconnected", () => { log("browser disconnected"); browser = null; });
  await loadPage();
}
async function loadPage() {
  loads++;
  hello = stats = null; statsAt = 0;
  if (!page || page.isClosed()) {
    page = await browser.newPage();
    await page.setViewport({ width: F.w, height: F.h, deviceScaleFactor: F.dsf });
    await page.evaluateOnNewDocument(() => { try { sessionStorage.setItem("evolve.live.entry", "1"); } catch {} });
    const c = await page.createCDPSession();
    await c.send("Network.enable");
    c.on("Network.webSocketFrameReceived", onFrame);
  }
  await page.goto(PAGE_URL, { waitUntil: "load", timeout: 60000 });
  await page.addStyleTag({ content: HIDE_CSS });
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) { // live link, hello and first stats in
    if (hello && stats) break;
    await sleep(500);
  }
  await sleep(3000); // map picture and first reveal
  await page.evaluate((n) => { const $ = (i) => document.getElementById(i); $("zoomFit").click(); for (let i = 0; i < n; i++) $("zoomIn").click(); }, F.zoomIns);
  await sleep(2500); // camera animation
  log("page loaded", { world: hello ? worldId() : null, tick: stats?.tick, load: loads });
}

function startWorld(now) {
  const id = worldId();
  let dir = null;
  for (const d of readdirSync(BASE).sort().reverse()) if (d.startsWith(id + "_")) { dir = d; break; } // resume the newest folder of this world after a script restart
  let bytes = 0, frames = 0, lastTick = -1;
  if (dir) {
    try {
      for (const l of readFileSync(join(BASE, dir, "frames.jsonl"), "utf8").split("\n")) if (l) { const r = JSON.parse(l); bytes += r.bytes; frames++; lastTick = r.tick; }
    } catch {}
    if (lastTick > (stats?.tick ?? 0) + RESET_TICK_DROP) { dir = null; bytes = frames = 0; } // the tick is behind the saved frames: it was reset meanwhile
  }
  if (!dir) {
    dir = `${id}_${stamp(now).slice(0, 15)}z`;
    mkdirSync(join(BASE, dir), { recursive: true });
    writeFileSync(join(BASE, dir, "world.json"), JSON.stringify({ id, startedCapture: now.toISOString(), firstTick: stats?.tick, simSeconds: stats?.simSeconds, framing: FRAMING, width: F.w * F.dsf, height: F.h * F.dsf, map: hello?.map?.name, mapVersion: hello?.map?.version, world: hello?.world }) + "\n");
  }
  let popBytes = 0;
  try { popBytes = statSync(join(BASE, dir, "population.jsonl")).size; } catch {}
  world = { id, dir, bytes, frames, lastTick: stats?.tick ?? 0, capped: false, popBytes, staleN: 0, lastCapturedTick: -1 };
  log("world folder", dir, { resumedBytes: bytes });
}

async function pngBytes() {
  if (METHOD === "shot") return Buffer.from(await page.screenshot({ type: "png", captureBeyondViewport: false, optimizeForSpeed: true }));
  const b64 = await page.evaluate(() => document.getElementById("view").toDataURL("image/png").slice(22));
  return Buffer.from(b64, "base64");
}

// Every POP_EVERY_S: keeps page and world folder in order, logs the population, and every INTERVAL_S also saves a frame.
async function step(now, withFrame) {
  if (!browser || !page || page.isClosed()) { await openPage(); return; }
  if (Date.now() - statsAt > STATS_MAX_AGE_S * 1000) { log("no stats for", Math.round((Date.now() - statsAt) / 1000), "s, reloading"); await loadPage(); return; }
  const tick = stats.tick, id = worldId();
  if (!world || id !== world.id || tick < world.lastTick - RESET_TICK_DROP) { log("new world", { id, tick, was: world?.id, lastTick: world?.lastTick }); startWorld(now); }
  world.lastTick = tick;
  logPopulation(now);
  if (withFrame) await capture(now, tick);
}
// Counts per lineage as the page gets them (stats.lineages: the top 8 families by count, same-named ones summed, so the 6 founders plus up to 2 other families; the rest is "others").
function logPopulation(now) {
  if (world.popBytes >= POP_CAP_BYTES) return;
  const lin = Array.isArray(stats.lineages) ? stats.lineages.slice(0, MAX_LINEAGES).map((l) => ({ founder: Number(l.founder) | 0, name: l.name ? safe(l.name, 24) : "", count: Number(l.count) | 0, starter: l.starter === true })) : [];
  const line = JSON.stringify({ time: now.toISOString(), tick: stats.tick, population: stats.population, others: Math.max(0, stats.population - lin.reduce((a, l) => a + l.count, 0)), lineages: lin }) + "\n";
  appendFileSync(join(BASE, world.dir, "population.jsonl"), line);
  world.popBytes += line.length;
}

async function capture(now, tick) {
  if (world.capped) return;
  if (tick === world.lastCapturedTick) { if (++world.staleN >= STALE_CAPTURES) { log("frozen at tick", tick, "reloading"); world.staleN = 0; await loadPage(); } return; }
  world.staleN = 0;
  const free = statfsSync(BASE); const freeBytes = free.bavail * free.bsize;
  if (freeBytes < FREE_FLOOR_BYTES) { log("free disk", Math.round(freeBytes / 1e9), "GB under floor, capture stopped for", world.dir); world.capped = true; return; }
  if (world.bytes >= CAP_BYTES) { log("folder at cap", world.bytes, "capture stopped for", world.dir); world.capped = true; return; }
  const t0 = Date.now();
  const png = await pngBytes();
  const name = `${stamp(now)}_t${String(tick).padStart(9, "0")}.png`;
  const path = join(BASE, world.dir, name);
  writeFileSync(path + ".tmp", png); renameSync(path + ".tmp", path);
  world.bytes += png.length; world.frames++; world.lastCapturedTick = tick;
  const ms = Date.now() - t0;
  appendFileSync(join(BASE, world.dir, "frames.jsonl"), JSON.stringify({ time: now.toISOString(), tick, population: stats.population, bytes: png.length, ms }) + "\n");
  log("frame", name, png.length, "B", ms, "ms", "pop", stats.population, "folder", Math.round(world.bytes / 1e6), "MB");
}

const startedAt = Date.now();
log("start", { FRAMING, F, METHOD, BASE, INTERVAL_S });
let first = true;
for (;;) {
  try {
    if (!browser) await openPage();
    const next = Math.ceil((Date.now() + 1) / (POP_EVERY_S * 1000)) * POP_EVERY_S * 1000;
    if (MAX_RUN_S && next - startedAt > MAX_RUN_S * 1000) break;
    if (first) { first = false; } 
    await sleep(Math.max(0, next - Date.now()));
    await step(new Date(next), next % (INTERVAL_S * 1000) === 0);
    errorsInRow = 0;
  } catch (err) {
    errorsInRow++;
    log("error", String(err?.message ?? err).slice(0, 300), "in a row", errorsInRow);
    try { if (errorsInRow >= 2) { errorsInRow = 0; if (browser && !page?.isClosed()) await loadPage(); else await openPage(); } } catch (e2) { log("recover failed", String(e2?.message ?? e2).slice(0, 200)); await sleep(5000); }
  }
}
try { await browser?.close(); } catch {}
log("done", { frames: world?.frames, bytes: world?.bytes });
process.exit(0);
