// Time-lapse capture of the Live world: one PNG every INTERVAL_S seconds into one folder per world (per reset), plus population.jsonl every POP_EVERY_S.
// Always on: a light websocket viewer (no browser) that reads hello and stats, detects resets and writes the population log.
// Chrome (one more viewer) runs only while frames are wanted: it is closed when a folder reaches its cap or the disk gets low, and started again for a new world.
// Run: nice -n 19 ionice -c3 chrt --idle 0 node tools/timelapse/timelapse.mjs [key=value ...]   (any parameter below can be overridden, e.g. framing=b interval=20 out=/path)
import { createRequire } from "node:module";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// parameters
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const P = {
  out: "/home/erik/progs/evolve-world-ai/videos/timelapse", // output folder, one subfolder per world (inside a git checkout, so it gets a .gitignore with *)
  server: "ws://127.0.0.1:8787", // the Live server (public port, loopback)
  pageServer: "", // server address the page connects to, default the same as `server` (a test hook)
  page: "", // folder of the built Live page (build-page.sh); default <REPO>/tools/timelapse/page
  pagePort: 8793, // loopback port of the tiny static server for the built page
  framing: "a", // a = whole map 3840x2400 before crop, b = 7680x4800, c = closer view
  interval: 20, // seconds between frames, aligned to the wall clock
  popEvery: 5, // seconds between population.jsonl lines, a divisor of interval
  capBytes: 30e9, // PNG bytes per world folder, then frames stop and Chrome closes ("first hours only")
  popCapBytes: 500e6, // population.jsonl bytes per world folder
  regionsCapBytes: 100e6, // regions.jsonl bytes per world folder
  regionRadiusFactor: 2, // a creature belongs to the nearest map region within this many times its seeding radius (the realms are drawn about twice as wide as the home discs), else "elsewhere"
  hueMatchDeg: 25, // a creature hue within this many degrees of a region hue counts for that hue's lineage, else "other"
  freeFloorBytes: 20e9, // frames stop when the disk has less free
  staleCaptures: 3, // same tick this many frame slots in a row = frozen, reload
  statsMaxAgeS: 15, // no stats for this long = link dead
  resetTickDrop: 100, // a tick this far below the last one = new world
  cropMarginCss: 8, // CSS px around the world rectangle
  chipInsetCss: 14, // the clock chip sits this many CSS px inside the top-right corner of the world rectangle (capture-only restyle)
  maxRunS: 0, // stop after this many seconds, 0 = run until killed
  chrome: "/usr/bin/google-chrome",
  extraCss: "", // file with CSS injected into the page after the hiding rules (a test hook)
  lna: 0, // 1 adds the Chrome flags that allow a public page to reach a local server (not needed for the local page)
};
for (const a of process.argv.slice(2)) { const i = a.indexOf("="); if (i > 0 && a.slice(0, i) in P) P[a.slice(0, i)] = typeof P[a.slice(0, i)] === "number" ? Number(a.slice(i + 1)) : a.slice(i + 1); else { console.error("unknown argument", a); process.exit(2); } }
const FRAMINGS = {
  // CSS viewport 1920 x 1200 at deviceScaleFactor dsf; the PNG is cropped to the world rectangle plus margin (and the clock chip)
  a: { w: 1920, h: 1200, dsf: 2, zoomIns: 0 },
  b: { w: 1920, h: 1200, dsf: 4, zoomIns: 0 },
  c: { w: 1920, h: 1200, dsf: 2, zoomIns: 3 }, // closer, centred on the hub (zoom step 1.6 each), not cropped
};
const F = FRAMINGS[P.framing];
if (!F) { console.error("framing must be a, b or c"); process.exit(2); }
const PAGE_DIR = resolve(P.page || join(HERE, "page"));
const OUT = resolve(P.out);
const MAX_TEXT = 512 * 1024; // the largest text message the light client parses
const MAX_BINARY = 4 * 1024 * 1024; // the largest message it accepts at all
const MAX_LINEAGES = 32; // per population line (the server sends at most 8)
const PING_EVERY_MS = 20_000; // the page's keep-alive text
const CHROME_ARGS = ["--no-sandbox", "--js-flags=--max-old-space-size=2048", ...(P.lna ? ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,BlockInsecurePrivateNetworkRequests"] : [])];
const HIDE_CSS = `.banner,.panel,.ov-stack,.zoom,#emptyNote,#entry,#worldLoading,.entry-live,.info{display:none!important}
html,body{overflow:hidden!important;height:100%!important;margin:0!important}
.layout.live{position:fixed!important;inset:0!important;padding:0!important;margin:0!important;height:100vh!important;min-height:0!important}
.stage{position:fixed!important;inset:0!important}
.stage>canvas{border:0!important;border-radius:0!important}`;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".wasm": "application/wasm", ".ico": "image/x-icon" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s, n = 40) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n) || "x";
const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
const log = (...a) => console.log(new Date().toISOString(), ...a);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
mkdirSync(OUT, { recursive: true });
if (!existsSync(join(OUT, ".gitignore"))) writeFileSync(join(OUT, ".gitignore"), "*\n"); // the output folder may sit inside a git checkout: keep frames out of git status

// what the built page was built for (build-page.sh writes it)
let stampInfo = null;
try { stampInfo = JSON.parse(readFileSync(join(PAGE_DIR, "timelapse-build.json"), "utf8")); } catch {}
log("start", { framing: P.framing, interval: P.interval, popEvery: P.popEvery, out: OUT, server: P.server, page: PAGE_DIR, build: stampInfo });

// ---- light client: read-only viewer, no browser. Sends only the page's "ping" text, never a select or an add.
const { WebSocket } = createRequire(import.meta.url)("ws"); // from tools/timelapse/node_modules (npm ci)
let hello = null; // { version, serverVersion, mapName, mapVersion, width, height }
let stats = null, statsAt = 0; // latest stats, reduced to what is logged
let wantCreatures = false, lastCreatures = null; // the latest creature frame (binary type 1), only while Chrome runs
let link = null, failures = 0, linkTimer = null, pingTimer = null, lastMessage = 0, lastLinkLog = 0;
const retryDelayS = (n) => Math.min(30, 2 ** n) * (1 + 0.25 * Math.random()); // 1 s doubling to 30 s with jitter, like the page

function cleanHello(m) {
  const w = m?.world, mp = m?.map ?? {};
  if (num(m?.version) === null || num(w?.width) === null || num(w?.height) === null) return null;
  return { version: m.version, serverVersion: typeof m.serverVersion === "string" ? m.serverVersion.slice(0, 16) : "", mapName: typeof mp.name === "string" ? mp.name.slice(0, 40) : "", mapVersion: typeof mp.version === "string" ? mp.version.slice(0, 40) : "", width: w.width, height: w.height };
}
function cleanStats(m) {
  const tick = num(m?.tick), population = num(m?.population);
  if (tick === null || population === null) return null;
  const lineages = Array.isArray(m.lineages) ? m.lineages.slice(0, MAX_LINEAGES).map((l) => ({ founder: num(l?.founder) ?? -1, name: typeof l?.name === "string" ? safe(l.name, 24) : "", count: num(l?.count) ?? 0, hue: num(l?.hue) ?? -1, starter: l?.starter === true })) : [];
  return { tick, simSeconds: num(m.simSeconds) ?? 0, population, lineages };
}
function onLinkMessage(data, isBinary) {
  lastMessage = Date.now();
  if (isBinary) { if (wantCreatures && data.length > 9 && data[0] === 1) lastCreatures = data; return; } // item sets and deltas are never parsed; the latest creature frame is kept only while frames are captured (regions.jsonl)
  try {
    if (data.length > MAX_TEXT) return;
    const m = JSON.parse(data.toString());
    if (m?.t === "hello") {
      const h = cleanHello(m);
      if (h) { hello = h; failures = 0; log("hello", h); }
    } else if (m?.t === "stats") {
      const s = cleanStats(m);
      if (s) { stats = s; statsAt = Date.now(); }
    } else if (m?.t === "busy") log("server says busy (viewer limit)");
  } catch (err) { log("bad message", String(err?.message ?? err).slice(0, 100)); }
}
function connectLink() {
  clearTimeout(linkTimer);
  let ws;
  try { ws = new WebSocket(P.server, { maxPayload: MAX_BINARY, perMessageDeflate: false, handshakeTimeout: 10_000 }); } catch (err) { return scheduleLink(String(err?.message ?? err)); }
  link = ws; lastMessage = Date.now();
  ws.on("message", onLinkMessage);
  ws.on("error", (err) => { if (Date.now() - lastLinkLog > 30_000) { lastLinkLog = Date.now(); log("link error", String(err?.message ?? err).slice(0, 100)); } });
  ws.on("close", () => { if (link === ws) { link = null; scheduleLink("closed"); } });
}
function scheduleLink(why) {
  if (linkTimer) return;
  const wait = retryDelayS(failures++);
  if (failures <= 3 || failures % 10 === 0) log("link down", why, "retry in", wait.toFixed(1), "s");
  linkTimer = setTimeout(() => { linkTimer = null; connectLink(); }, wait * 1000);
}
pingTimer = setInterval(() => {
  try {
    if (link?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastMessage > 15_000) { const ws = link; link = null; ws.terminate(); scheduleLink("stale"); return; }
    link.send("ping");
  } catch {}
}, PING_EVERY_MS);
connectLink();

// ---- world folders
let world = null; // { id, dir, bytes, frames, popBytes, lastTick, capped, staleN, lastCapturedTick, size }
function worldId() { return [safe(hello?.mapName, 20), `${Math.round(hello?.width ?? 0)}x${Math.round(hello?.height ?? 0)}`, safe(hello?.mapVersion, 20)].join("-"); }
function startWorld(now) {
  const id = worldId();
  let dir = null;
  for (const d of readdirSync(OUT).sort().reverse()) if (d.startsWith(id + "_")) { dir = d; break; } // the newest folder of this world, so a script restart resumes it
  let bytes = 0, frames = 0, lastTick = -1, popBytes = 0, regionsBytes = 0, size = null;
  const recent = []; // bytes of the last frames, for the suspicious-frame check
  if (dir) {
    try { for (const l of readFileSync(join(OUT, dir, "frames.jsonl"), "utf8").split("\n")) if (l) { const r = JSON.parse(l); bytes += r.bytes; frames++; lastTick = r.tick; recent.push(r.bytes); if (recent.length > 21) recent.shift(); } } catch {}
    try { popBytes = statSync(join(OUT, dir, "population.jsonl")).size; } catch {}
    try { regionsBytes = statSync(join(OUT, dir, "regions.jsonl")).size; } catch {}
    try { size = JSON.parse(readFileSync(join(OUT, dir, "world.json"), "utf8")).size ?? null; } catch {}
    try { // the last logged population tick, when no frame was saved yet
      const pl = readFileSync(join(OUT, dir, "population.jsonl"), "utf8").trimEnd().split("\n").pop();
      if (pl) lastTick = Math.max(lastTick, JSON.parse(pl).tick);
    } catch {}
    if (lastTick > stats.tick + P.resetTickDrop) { dir = null; bytes = frames = popBytes = regionsBytes = 0; size = null; } // the tick is behind the saved folder: it was reset meanwhile
  }
  if (!dir) {
    dir = `${id}_${stamp(now).slice(0, 15)}z`;
    mkdirSync(join(OUT, dir), { recursive: true });
    writeFileSync(join(OUT, dir, "world.json"), JSON.stringify({ id, startedCapture: now.toISOString(), firstTick: stats.tick, simSeconds: stats.simSeconds, framing: P.framing, map: hello.mapName, mapVersion: hello.mapVersion, world: { width: hello.width, height: hello.height } }) + "\n");
  }
  world = { recent, id, dir, bytes, frames, popBytes, regionsBytes, lastTick: stats.tick, capped: false, staleN: 0, lastCapturedTick: -1, size };
  loadRegions();
  if (regionInfo) { const f = join(OUT, dir, "world.json"); try { const j = JSON.parse(readFileSync(f, "utf8")); j.regions = regionInfo; j.regionsNote = "regions.jsonl m = flat matrix, rows: regions then elsewhere, columns: lineages of hues then other"; writeFileSync(f, JSON.stringify(j) + "\n"); } catch {} }
  log("world folder", dir, { resumedBytes: bytes, resumedFrames: frames });
}
function logPopulation(now) {
  if (world.popBytes >= P.popCapBytes) return;
  const lin = stats.lineages;
  const line = JSON.stringify({ time: now.toISOString(), tick: stats.tick, simSeconds: stats.simSeconds, population: stats.population, others: Math.max(0, stats.population - lin.reduce((a, l) => a + l.count, 0)), lineages: lin }) + "\n";
  appendFileSync(join(OUT, world.dir, "population.jsonl"), line);
  world.popBytes += line.length;
}


// ---- regions.jsonl: creatures per map region and hue bucket, one line per frame, from the viewer's creature frame (the page keeps its creature data in module scope, out of a script's reach)
let regionInfo = null; // { ids, x, y, r, hueIds, hues } from the map spec of the repo (regions with centre, radius and seeding hue)
function loadRegions() {
  regionInfo = null;
  try {
    const src = readFileSync(join(REPO, "src/typescript/src/sim/maps", safe(hello.mapName, 20) + ".ts"), "utf8");
    const a = src.indexOf('"regions": ['); if (a < 0) return;
    const b = src.indexOf("\n ]", a);
    const regs = JSON.parse(src.slice(a + 11, b + 3)).filter((g) => num(g?.x) !== null && num(g?.y) !== null && num(g?.r) !== null);
    if (!regs.length || regs.length > 16) return;
    const homes = regs.filter((g) => num(g.hue) !== null);
    regionInfo = { ids: regs.map((g) => safe(g.id, 16)), x: regs.map((g) => g.x), y: regs.map((g) => g.y), r: regs.map((g) => g.r), hueIds: homes.map((g) => safe(g.id, 16)), hues: homes.map((g) => g.hue) };
  } catch (err) { log("regions not read", String(err?.message ?? err).slice(0, 100)); }
}
// rows: the regions then "elsewhere"; columns: the seeding hues' lineages then "other"
function logRegions(now, tick) {
  if (!regionInfo || !lastCreatures || world.regionsBytes >= P.regionsCapBytes) return;
  const buf = lastCreatures, dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = dv.getUint32(5, true);
  if (count > 20_000 || buf.length !== 9 + count * 19) return;
  const R = regionInfo, nr = R.ids.length, nh = R.hues.length, m = new Array((nr + 1) * (nh + 1)).fill(0);
  for (let i = 0, o = 9; i < count; i++, o += 19) {
    const x = (dv.getUint16(o + 4, true) / 65535) * hello.width, y = (dv.getUint16(o + 6, true) / 65535) * hello.height, hue = (dv.getUint16(o + 13, true) / 65535) * 360;
    let row = nr, best = Infinity;
    for (let k = 0; k < nr; k++) { const d = Math.hypot(x - R.x[k], y - R.y[k]) / R.r[k]; if (d <= P.regionRadiusFactor && d < best) { best = d; row = k; } }
    let col = nh, bd = P.hueMatchDeg;
    for (let k = 0; k < nh; k++) { let d = Math.abs(hue - R.hues[k]) % 360; if (d > 180) d = 360 - d; if (d <= bd) { bd = d; col = k; } }
    m[row * (nh + 1) + col]++;
  }
  const line = JSON.stringify({ time: now.toISOString(), tick, creatureTick: dv.getUint32(1, true), n: count, m }) + "\n";
  appendFileSync(join(OUT, world.dir, "regions.jsonl"), line);
  world.regionsBytes += line.length;
}

// ---- Chrome: only while frames are wanted; serves the built page on loopback and views it as one more viewer
let puppeteer = null; // loaded when Chrome is first needed, so the always-on part stays small
let browser = null, page = null, httpd = null, chromeState = "off"; // off | starting | ready | closing
let crop = null, pageUrl = "";
function serveStatic() {
  return new Promise((res, rej) => {
    const s = createServer((req, rsp) => {
      try {
        const u = new URL(req.url ?? "/", "http://x");
        let p = normalize(decodeURIComponent(u.pathname)); if (p.endsWith(sep) || p.endsWith("/")) p += "index.html";
        const f = join(PAGE_DIR, p);
        if (req.method !== "GET" || !f.startsWith(PAGE_DIR + sep) || !existsSync(f) || !statSync(f).isFile()) { rsp.writeHead(404).end(); return; }
        rsp.writeHead(200, { "content-type": MIME[extname(f)] ?? "application/octet-stream" });
        createReadStream(f).on("error", () => rsp.destroy()).pipe(rsp);
      } catch { try { rsp.writeHead(400).end(); } catch {} }
    });
    s.once("error", rej);
    s.listen(P.pagePort, "127.0.0.1", () => res(s));
  });
}
async function launchChrome() {
  if (chromeState !== "off") return;
  chromeState = "starting";
  try {
    puppeteer ??= createRequire(import.meta.url)("puppeteer-core"); // from tools/timelapse/node_modules
    httpd = await serveStatic();
    pageUrl = `http://127.0.0.1:${P.pagePort}/live/index.html?server=${P.pageServer || P.server}`;
    browser = await puppeteer.launch({ executablePath: P.chrome, headless: true, args: CHROME_ARGS });
    browser.on("disconnected", () => { if (chromeState !== "closing") { log("chrome disconnected"); browser = page = null; chromeState = "off"; wantCreatures = false; lastCreatures = null; closeServer(); } });
    await loadPage();
    chromeState = "ready"; wantCreatures = true;
    log("chrome ready", { pid: browser.process()?.pid });
  } catch (err) { log("chrome start failed", String(err?.message ?? err).slice(0, 200)); await closeChrome(); }
}
function closeServer() { try { httpd?.close(); httpd?.closeAllConnections?.(); } catch {} httpd = null; }
async function closeChrome() {
  if (chromeState === "off" && !browser && !httpd) return;
  chromeState = "closing"; wantCreatures = false; lastCreatures = null;
  const b = browser; browser = page = null; crop = null;
  try { await b?.close(); } catch { try { b?.process()?.kill("SIGKILL"); } catch {} }
  closeServer();
  chromeState = "off";
  log("chrome closed");
}
async function loadPage() {
  if (!page || page.isClosed()) {
    page = await browser.newPage();
    await page.setViewport({ width: F.w, height: F.h, deviceScaleFactor: F.dsf });
    await page.evaluateOnNewDocument(() => { try { sessionStorage.setItem("evolve.live.entry", "1"); } catch {} });
  }
  await page.goto(pageUrl, { waitUntil: "load", timeout: 60000 });
  await page.addStyleTag({ content: HIDE_CSS + (P.extraCss ? readFileSync(P.extraCss, "utf8") : "") });
  await page.waitForFunction(() => document.getElementById("chipText")?.textContent === "Live", { timeout: 60000 });
  await sleep(3000); // map picture and first reveal
  await page.evaluate((n) => { const $ = (i) => document.getElementById(i); $("zoomFit").click(); for (let i = 0; i < n; i++) $("zoomIn").click(); }, F.zoomIns);
  await sleep(2500); // camera animation
  if (P.framing !== "c") { // the chip moves inside the world rectangle's top-right corner, an even inset from the top and right border lines
    const z = Math.min(F.w / hello.width, F.h / hello.height) * 0.96, ww = hello.width * z, wh = hello.height * z;
    const top = (F.h - wh) / 2 + P.chipInsetCss, right = (F.w - ww) / 2 + P.chipInsetCss;
    await page.addStyleTag({ content: `#timer{top:${top.toFixed(2)}px!important;right:${right.toFixed(2)}px!important;left:auto!important}` });
  }
  crop = await computeCrop();
  log("page loaded", { crop });
}
// The world rectangle as the fitted camera puts it (camera.ts fitWorld: zoom = min(cw/W, ch/H) * 0.96, world centred) plus a margin, with the clock chip kept inside; whole CSS px, even device px.
async function computeCrop() {
  if (P.framing === "c") return { x: 0, y: 0, width: F.w, height: F.h };
  const chip = await page.evaluate(() => { const e = document.getElementById("timer"); const r = e && !e.hidden ? e.getBoundingClientRect() : null; return r ? { top: r.top, right: r.right, left: r.left } : null; });
  const z = Math.min(F.w / hello.width, F.h / hello.height) * 0.96;
  const ww = hello.width * z, wh = hello.height * z, x0 = (F.w - ww) / 2, y0 = (F.h - wh) / 2, m = P.cropMarginCss;
  let left = x0 - m, top = y0 - m, right = x0 + ww + m, bottom = y0 + wh + m;
  const c = chip ?? { top: 10, right: F.w - 55, left: F.w - 250 }; // chip not shown yet: its CSS place (ecosystem.css .timer)
  top = Math.min(top, c.top - 4); right = Math.max(right, c.right + 4); left = Math.min(left, c.left - 4);
  left = Math.max(0, Math.floor(left)); top = Math.max(0, Math.floor(top)); right = Math.min(F.w, Math.ceil(right)); bottom = Math.min(F.h, Math.ceil(bottom));
  let width = right - left, height = bottom - top;
  const even = (v) => (Math.round(v * F.dsf) % 2 === 0 ? v : v + 1);
  width = Math.min(even(width), F.w - left); height = Math.min(even(height), F.h - top);
  return { x: left, y: top, width, height };
}
const pageShowsWorld = () => page.evaluate(() => document.getElementById("chipText")?.textContent === "Live" && document.getElementById("worldLoading")?.hidden === true).catch(() => false);
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
async function takeFrame(now, tick) {
  const png = Buffer.from(await page.screenshot({ type: "png", optimizeForSpeed: true, clip: crop }));
  const size = [crop.width * F.dsf, crop.height * F.dsf];
  if (world.recent.length >= 5 && png.length < median(world.recent) / 3) return { png, path: null, suspicious: true }; // a blank or offline page compresses far smaller
  if (world.size && (world.size[0] !== size[0] || world.size[1] !== size[1])) throw new Error(`frame size ${size} differs from this world's ${world.size}`);
  if (!world.size) { world.size = size; const f = join(OUT, world.dir, "world.json"); const j = JSON.parse(readFileSync(f, "utf8")); j.size = size; j.crop = crop; writeFileSync(f, JSON.stringify(j) + "\n"); }
  const path = join(OUT, world.dir, `${stamp(now)}_t${String(tick).padStart(9, "0")}.png`);
  writeFileSync(path + ".tmp", png); renameSync(path + ".tmp", path);
  return { png, path };
}

// ---- status.json in the output folder: what the check script reads (it changes nothing)
let statusState = "starting", statusMsg = "";
function setStatus(state, msg = "") { statusState = state; statusMsg = msg; }
function writeStatus() {
  try {
    const f = join(OUT, "status.json");
    writeFileSync(f + ".tmp", JSON.stringify({ time: new Date().toISOString(), state: statusState, message: statusMsg, world: world?.dir ?? null, interval: P.interval, popEvery: P.popEvery, capBytes: P.capBytes, freeFloorBytes: P.freeFloorBytes, chrome: chromeState, pid: process.pid }) + "\n");
    renameSync(f + ".tmp", f);
  } catch {}
}
setInterval(writeStatus, 5000).unref();

// ---- the slot loop
let errorsInRow = 0;
async function step(now, withFrame) {
  const age = Date.now() - statsAt;
  if (!hello || !stats || age > P.statsMaxAgeS * 1000) { setStatus("error", hello ? "no stats from the server for " + Math.round(age / 1000) + " s" : "no hello from the server yet"); if (Date.now() - lastLinkLog > 30_000) { lastLinkLog = Date.now(); log("no fresh stats", hello ? Math.round(age / 1000) + " s" : "no hello yet"); } return; }
  const tick = stats.tick, id = worldId();
  if (!world || id !== world.id || tick < world.lastTick - P.resetTickDrop) {
    log("new world", { id, tick, was: world?.id, lastTick: world?.lastTick });
    await closeChrome(); // a reset restarts Chrome for a clean page
    startWorld(now);
  }
  world.lastTick = tick;
  logPopulation(now);
  const versionOk = !stampInfo || stampInfo.protocol === hello.version;
  if (!versionOk) { setStatus("error", "version mismatch: server protocol " + hello.version + ", built page " + stampInfo.protocol); if (Date.now() - lastLinkLog > 60_000) { lastLinkLog = Date.now(); log("VERSION MISMATCH: server protocol", hello.version, "built page", stampInfo.protocol, "(commit " + stampInfo.commit + "), no frames until the page is rebuilt with build-page.sh"); } await closeChrome(); return; }
  if (!existsSync(join(PAGE_DIR, "live/index.html"))) { if (Date.now() - lastLinkLog > 60_000) { lastLinkLog = Date.now(); log("built page missing in", PAGE_DIR, "run build-page.sh"); } return; }
  const free = statfsSync(OUT); const freeBytes = free.bavail * free.bsize;
  if (!world.capped && freeBytes < P.freeFloorBytes) { log("free disk", Math.round(freeBytes / 1e6), "MB under the floor, frames stopped for", world.dir); world.capped = true; world.why = "disk-floor"; }
  if (!world.capped && world.bytes >= P.capBytes) { log("folder at cap", world.bytes, "B, frames stopped for", world.dir); world.capped = true; world.why = "cap"; }
  if (world.capped) { setStatus(world.why === "cap" ? "capped" : "disk-floor", world.why === "cap" ? "folder reached the size cap" : "free disk under the floor"); await closeChrome(); return; }
  if (chromeState === "off") { setStatus("capturing", "starting Chrome"); void launchChrome(); return; }
  setStatus("capturing");
  if (chromeState !== "ready" || !withFrame) return;
  if (!(await pageShowsWorld())) { log("WARNING page shows offline or loading at capture time, no frame, reloading"); setStatus("capturing", "page was offline or loading, reloaded"); await loadPage(); return; }
  if (tick === world.lastCapturedTick) {
    if (++world.staleN >= P.staleCaptures) { log("frozen at tick", tick, "reloading"); world.staleN = 0; await loadPage(); try { link?.terminate(); } catch {} }
    return;
  }
  world.staleN = 0;
  const t0 = Date.now();
  const { png, path, suspicious } = await takeFrame(now, tick);
  if (suspicious) { log("WARNING suspicious frame", png.length, "B vs median", median(world.recent), "B, not saved, reloading"); await loadPage(); return; }
  world.recent.push(png.length); if (world.recent.length > 21) world.recent.shift();
  world.bytes += png.length; world.frames++; world.lastCapturedTick = tick;
  const ms = Date.now() - t0;
  try { logRegions(now, tick); } catch (err) { log("regions error", String(err?.message ?? err).slice(0, 100)); }
  appendFileSync(join(OUT, world.dir, "frames.jsonl"), JSON.stringify({ time: now.toISOString(), tick, population: stats.population, bytes: png.length, ms }) + "\n");
  log("frame", path.split("/").pop(), png.length, "B", ms, "ms", "pop", stats.population, "folder", Math.round(world.bytes / 1e6), "MB");
}

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => { log("signal", sig, "closing Chrome and exiting"); writeStatus(); await closeChrome(); process.exit(0); });
const startedAt = Date.now();
for (;;) {
  try {
    const next = Math.ceil((Date.now() + 1) / (P.popEvery * 1000)) * P.popEvery * 1000;
    if (P.maxRunS && next - startedAt > P.maxRunS * 1000) break;
    await sleep(Math.max(0, next - Date.now()));
    await step(new Date(next), next % (P.interval * 1000) === 0);
    errorsInRow = 0;
  } catch (err) {
    errorsInRow++;
    log("error", String(err?.message ?? err).slice(0, 300), "in a row", errorsInRow); setStatus("error", String(err?.message ?? err).slice(0, 120));
    try { if (errorsInRow >= 2) { errorsInRow = 0; await closeChrome(); } } catch (e2) { log("recover failed", String(e2?.message ?? e2).slice(0, 200)); }
  }
}
writeStatus(); // keeps the last state (capped, disk-floor); a stale status.json tells the check the script is not running
clearInterval(pingTimer); clearTimeout(linkTimer);
try { link?.close(); } catch {}
await closeChrome();
log("done", { frames: world?.frames, bytes: world?.bytes });
process.exit(0);
