// Replay renderer: turns a world folder's state log back into PNG frames or a video, drawn by the Live page's own code (replay/, built by build-replay.sh).
// Chrome draws each frame on a canvas and posts its RGBA bytes to this script on loopback; they are piped straight into ffmpeg (no frame folder in between).
// Run: nice -n 19 ionice -c3 chrt --idle 0 node tools/timelapse/replay.mjs world=<world folder> out=<file.mp4 or folder> [key=value ...]   (README.md "Replay")
// The world folder is hostile (README.md "Handling the output folder"): the state log is read only through stateLog.mjs, world.json through readHostile, nothing else.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, openSync, writeSync, closeSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ItemState, NO_SEQ, T, readStateLog } from "./stateLog.mjs";
import { clean, num, readHostile } from "./hostile.mjs";
import { MAX_BLEND, DEFAULT_OUT_PX, diskFreeMB, sizeEstimateMB, Planner, accumulate, average, centerCam, cropCam, decodeViews, ffmpegArgs, interpolate, matchDeaths, itemsMessage, keyCam, lineageCounts, lineageRows, packViews, pixelSocket, parseKeys, parseStep, parseTime, pngBase, regionMatrix, regionsFromSource, season, recordTimesOk, isoTime, headerProblem, findHeader, framingFrom, outputPath, freshTemp, pipeWriter, upgradeOk } from "./replayCore.mjs";

// parameters
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const P = {
  world: "", // the world folder (state-NNNNN.evs, world.json)
  out: "", // mode=mp4: the video file; mode=frames: a folder for frame_NNNNNN.png; its parent folder must exist and lie outside captureRoot
  captureRoot: "", // the capture's output folder, where nothing is written; default the world folder's parent
  mode: "mp4", // mp4 (a video, codec below) or frames (PNG files)
  codec: "h264", // h264 (.mp4), ffv1 (lossless RGB, .mkv) or prores (ProRes 4444, .mov)
  crf: 12, // h264 quality, 0 = lossless; 12 keeps the dots and the ground grain visually lossless (README.md "Replay")
  preset: "slow", // x264 preset
  pix: "yuv420p", // h264 pixel format: yuv420p (plays everywhere) or yuv444p (full colour resolution, for masters)
  threads: 4, // ffmpeg threads
  lookahead: -1, // x264 rc-lookahead in frames; -1 = the preset's up to 1920x1080 and 10 above (README.md "Replay": memory)
  memStart: 3000, // MB of MemAvailable needed to start, 0 = no check
  memStop: 2000, // MB of MemAvailable below which the render stops early and finishes the video (exit 3), 0 = no check
  transfer: "auto", // pixels from Chrome as rgba, or yuv (BT.709 4:2:0 made in the page, 3/8 of the bytes: faster); auto = yuv for h264 yuv420p
  fps: 30,
  from: "", to: "", // ISO wall time or simulated seconds (400000, 111h)
  step: "1", // N: every Nth record; Xs (or m, h): one frame per X simulated seconds
  bursts: 0, // records mode: 1 also takes the 1 Hz burst records (uneven time steps); time mode always uses them
  interpolate: 0, // time mode: 1 moves creatures between records by id
  maxSpeed: 400, // world units per simulated second beyond which a creature jumps instead of gliding (the fastest in the clock world: 200), and the reach for matching a death event
  blend: 1, // sub-frames averaged per output frame (motion blur for fast time-lapses)
  gap: "cut", // a gap in the log (outage, restart, simulated time going back): cut, hold or fade
  gapS: 30, // wall seconds between records that count as a gap
  holdMax: 60, // gap=hold: at most this many held frames per gap
  fadeS: 0.5, // gap=fade: seconds of fade out and of fade in
  size: "", // WxH, default the PNG size of world.json (3720x2336)
  crop: "", // x,y,w,h in PNG px, drawn natively at size
  center: "", zoom: 1, // x,y in world units and zoom (1 = the whole map) for a fixed close-up
  keys: "", // keyframes: a JSON list or a file (README.md "Replay")
  dpr: 0, // device px per CSS px for dots and chip, 0 = from the framing
  chip: 1, // the clock and season chip
  items: 1, // food and poison
  itemsUnknown: "hold", // a record whose item set is unknown: hold (the last known set) or none
  wall: 1, // the world's border line
  clean: 0, // 1 = no chip and no border line (clean plates)
  ground: "cache", // cache: the map drawn once per still camera (fast); direct: every frame, as the page draws a view over 8 M px
  rings: 1, // birth rings (visible only when creatures are large on screen, as on the page)
  creatures: "fade", // fade: dots at true size, cross-fading to the page's bodies as creatures grow (no switch in one frame); live: the page's switch; dots: never bodies
  winterTint: 1, // strength of the page's winter tint: 1 as Live, 0 off, between scales it
  chipFixed: 1, // 1: the chip as wide as its widest text, so its left edge holds still; 0: as the page (for comparing with the capture's PNGs)
  sidecar: "", // file for one JSON line per output frame (time, season, lineage and region counts); 1 = <out>.jsonl
  positions: "", // sidecar: screen positions of all creatures (all) or of these ids (1,2,3)
  preview: 0, // 1 = quarter size, fast encode
  maxFrames: 0, // stop after this many output frames, 0 = all
  planMax: 400_000, // refuse a plan of more frames than this (ten days at every 5 s record is 172,800); raise it for longer films
  simPerWall: 20, // simulated seconds per wall second beyond which two records count as a gap (the clock world runs at about 3, at most 4.1)
  diskStart: 20_000, // MB free in the output's folder needed to start, 0 = no check
  diskStop: 10_000, // MB free below which the render stops early and finishes the video (exit 3), 0 = no check
  port: 18920, // first loopback port tried for the page (up to 18990)
  page: "", // the built replay page, default tools/timelapse/replay-page
  chrome: "/usr/bin/google-chrome",
  gpu: 0, // 1 lets Chrome use the GPU; 0 draws in software, as the capture unit (no GPU device) does
  log: 30, // seconds between progress lines
};
for (const a of process.argv.slice(2)) { const i = a.indexOf("="); if (i > 0 && a.slice(0, i) in P) P[a.slice(0, i)] = typeof P[a.slice(0, i)] === "number" ? Number(a.slice(i + 1)) : a.slice(i + 1); else { console.error("unknown argument", a); process.exit(2); } }
const die = (msg) => { console.error("replay:", msg); process.exit(2); };
if (!P.world || !P.out) die("needs world=<world folder> and out=<file or folder>");
if (P.clean) { P.chip = 0; P.wall = 0; }
if (!["mp4", "frames"].includes(P.mode)) die("mode must be mp4 or frames");
const memAvailMB = () => { try { const m = /MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8")); return m ? Math.round(Number(m[1]) / 1024) : Infinity; } catch { return Infinity; } };
if (P.memStart > 0 && memAvailMB() < P.memStart) die(`only ${memAvailMB()} MB of memory available, memStart=${P.memStart} needs more; try again later`);
if (!(Number.isInteger(P.blend) && P.blend >= 1 && P.blend <= MAX_BLEND)) die(`blend must be a whole number, 1 to ${MAX_BLEND}`);
const WORLD = resolve(P.world), PAGE_DIR = resolve(P.page || join(HERE, "replay-page"));
let isDir = false; try { isDir = lstatSync(WORLD).isDirectory(); } catch {}
if (!isDir) die("world must be a real folder (not a link)");
const ROOT = P.captureRoot ? resolve(P.captureRoot) : dirname(WORLD);
let OUT, SIDECAR = null; // real paths outside the capture's output folder
try {
  OUT = outputPath(P.out, ROOT, { dir: P.mode === "frames" });
  if (P.sidecar) SIDECAR = outputPath(P.sidecar === "1" ? OUT + ".jsonl" : P.sidecar, ROOT);
} catch (e) { die(`out and sidecar must be outside the capture's output folder, in an existing folder, and not links: ${clean(e.message, 300)}`); }
if (!existsSync(join(PAGE_DIR, "index.html"))) die(`no built page in ${PAGE_DIR}: run tools/timelapse/build-replay.sh`);
if (!["h264", "ffv1", "prores"].includes(P.codec)) die("codec must be h264, ffv1 or prores");
if (!["hold", "none"].includes(P.itemsUnknown)) die("itemsUnknown must be hold or none");
if (!["fade", "live", "dots"].includes(P.creatures)) die("creatures must be fade, live or dots");
if (!(P.winterTint >= 0 && P.winterTint <= 4)) die("winterTint must be 0 to 4");
const step = parseStep(P.step), from = parseTime(P.from), to = parseTime(P.to);
if (P.interpolate && !step.sim) die("interpolate=1 needs a time step (step=0.1s, 5s, ...)");

// ---- world.json (hostile): the capture's camera and crop when in range (replayCore framingFrom), else the capture's rule for framing a
const wj = (() => { try { const j = JSON.parse(readHostile(join(WORLD, "world.json"), 1e6)); return j && typeof j === "object" ? j : {}; } catch { return {}; } })();

// ---- the log: header first
const counts = { records: {}, badTimes: 0, preHeader: 0, skippedBytes: 0, baseLost: 0, itemsUnknownHeld: 0, itemsUnknownNone: 0, frames: 0, subFrames: 0, ms: { prep: 0, draw: 0, chip: 0, readback: 0, encode: 0, pageRead: 0, pagePost: 0, pageWarm: 0, pageDraw: 0 }, chipShots: 0, notSharp: 0, bigSkipped: 0, headers: 0 };
const log = readStateLog(WORLD);
const found = findHeader(log); // records before it are counted, not kept
if (!found) die("no state log header in this folder (no state-NNNNN.evs, unreadable, or over 1000 records before it)");
const header = found.header, early = [found.record];
counts.preHeader = found.skipped; counts.skippedBytes += found.skippedBytes;
const bad = headerProblem(header);
if (bad) die(`the state log header cannot be drawn: ${bad}`);
const hw = header.world, mapName = header.map, mapVer = typeof header.mapVersion === "string" ? header.mapVersion : "";
const world = { width: hw.width, height: hw.height }, dtSim = num(header.dt) > 0 && header.dt <= 10 ? header.dt : 1 / 30;
const F = framingFrom(wj, world.width, world.height), base = pngBase(F.camera, F.crop), pngSize = F.size;
const even = (v) => Math.max(2, 2 * Math.round(v / 2));
let [W, H] = P.size ? P.size.split("x").map(Number) : P.preview ? [even(pngSize[0] / 4), even(pngSize[1] / 4)] : pngSize;
if (!P.size && W * H > DEFAULT_OUT_PX) { const k = Math.sqrt(DEFAULT_OUT_PX / (W * H)); [W, H] = [even(W * k - 1), even(H * k - 1)]; console.error(`replay: default size capped at 16 MP: ${W}x${H} (pass size= for more)`); }
if (!(Number.isInteger(W) && Number.isInteger(H) && W >= 16 && H >= 16 && W <= 8192 && H <= 8192)) die("size must be WxH, 16 to 8192");
if (W % 2 || H % 2) { W = even(W); H = even(H); console.error(`replay: size made even: ${W}x${H}`); }
const crf = P.preview ? Math.max(P.crf, 23) : P.crf, preset = P.preview ? "veryfast" : P.preset;
const lookahead = P.lookahead >= 0 ? Math.round(P.lookahead) : W * H > 1920 * 1080 ? 10 : -1;
const keys = P.keys ? parseKeys(P.keys.trim().startsWith("[") ? P.keys : readFileSync(P.keys, "utf8"), base, pngSize, W, H) : null;
const fixedCam = P.center ? (() => { const [x, y] = P.center.split(",").map(Number); if (![x, y, P.zoom].every(Number.isFinite) || P.zoom <= 0) die("center=x,y needs numbers and zoom > 0"); return centerCam(base, pngSize, W, H, x, y, P.zoom); })()
  : P.crop ? (() => { const r = P.crop.split(",").map(Number); if (r.length !== 4 || !r.every(Number.isFinite) || r[2] <= 0 || r[3] <= 0) die("crop=x,y,w,h in PNG px"); return cropCam(base, r, W, H); })()
  : cropCam(base, [0, 0, pngSize[0], pngSize[1]], W, H);
const camAt = (fr) => { const c = keys ? keyCam(keys, fr, W, H) : fixedCam; return P.dpr > 0 ? { ...c, dpr: P.dpr } : c; };
const regions = (() => { try { return regionsFromSource(readFileSync(join(REPO, "src/typescript/src/sim/maps", mapName + ".ts"), "utf8")); } catch { return null; } })();
const wantIds = P.positions && P.positions !== "all" ? new Set(P.positions.split(",").map(Number).filter(Number.isInteger)) : null;

// ---- the plan, counted before anything is drawn: a pass over the log with the same planner (records are read twice; the pass stops past planMax)
const planOpts = { step, from, to, gap: P.gap, gapS: P.gapS, fadeFrames: Math.round(P.fadeS * P.fps), holdMax: P.holdMax, interpolate: !!P.interpolate, blend: P.blend, simPerWall: P.simPerWall };
const pool = (r) => r.type === T.CREATURES || (r.type === T.BURST && (step.sim || P.bursts));
const OUT_DIR = P.mode === "frames" ? OUT : dirname(OUT);
const plan = (() => {
  const t0 = Date.now(), pl = new Planner(planOpts), cap = P.maxFrames || Infinity;
  let n = 0, sess = "";
  try {
    for (const r of readStateLog(WORLD)) {
      if (r.type === T.HEADER) { sess = clean(r.json?.session, 64); continue; }
      if (!pool(r) || r.records === null || !recordTimesOk(r)) continue;
      r.session = sess;
      n += pl.push(r).length;
      if (n >= cap || n > P.planMax || pl.done) break;
    }
    if (n < cap && n <= P.planMax && !pl.done) n += pl.end().length;
  } catch (e) { die(clean(e.message, 300)); }
  return { frames: Math.min(n, cap), seconds: (Date.now() - t0) / 1000 };
})();
{
  const mb = sizeEstimateMB({ mode: P.mode, codec: P.codec, crf, pix: P.pix, W, H }, plan.frames), free = diskFreeMB(OUT_DIR);
  console.error(`replay: plan ${plan.frames}${plan.frames > P.planMax ? "+" : ""} frames, ${(plan.frames / P.fps / 60).toFixed(1)} min of video at ${P.fps} fps, about ${mb} MB (rough), ${free === Infinity ? "unknown" : free + " MB"} free (counted in ${plan.seconds.toFixed(0)} s)`);
  if (plan.frames > P.planMax) die(`the plan passes planMax=${P.planMax} frames: use a coarser step, a shorter range, maxFrames, or raise planMax`);
  if (!plan.frames) die("nothing to draw in this range");
  if (P.diskStart > 0 && free < P.diskStart) die(`only ${free} MB free in ${OUT_DIR}, diskStart=${P.diskStart} needs more`);
  if (P.diskStop > 0 && mb > free - P.diskStop) die(`the output (about ${mb} MB) would not fit above diskStop=${P.diskStop} MB (${free} MB free)`);
}

// ---- loopback server: the page, view packets (GET /b/<token>/<n>) and the pixel socket (/px/<token>); the token keeps other local processes out of both
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml", ".bin": "application/octet-stream", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const blobs = new Map(), TOKEN = randomBytes(16).toString("hex"), BLOB = `/b/${TOKEN}/`, PX = `/px/${TOKEN}`;
let waiting = null; // the frame whose pixels are expected next on the pixel socket: { resolve, reject }
const yuv = P.transfer === "yuv" || (P.transfer === "auto" && P.mode === "mp4" && P.codec === "h264" && P.pix === "yuv420p");
if (yuv && !(P.mode === "mp4" && P.codec === "h264" && P.pix === "yuv420p")) die("transfer=yuv needs mode=mp4 codec=h264 pix=yuv420p");
const frameBytes = yuv ? W * H * 1.5 : W * H * 4;
let pixels = null; // the latest frame from the page
const httpd = createServer((req, rsp) => {
  try {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && u.pathname.startsWith(BLOB)) { const b = blobs.get(u.pathname); blobs.delete(u.pathname); if (!b) { rsp.writeHead(404).end(); return; } rsp.writeHead(200, { "content-type": "application/octet-stream", "content-length": b.length }).end(b); return; }
    let p = normalize(decodeURIComponent(u.pathname)); if (p.endsWith("/")) p += "index.html";
    const f = join(PAGE_DIR, p);
    if (req.method !== "GET" || !f.startsWith(PAGE_DIR + sep) || !existsSync(f) || !statSync(f).isFile()) { rsp.writeHead(404).end(); return; }
    rsp.writeHead(200, { "content-type": MIME[extname(f)] ?? "application/octet-stream" });
    createReadStream(f).on("error", () => rsp.destroy()).pipe(rsp);
  } catch { try { rsp.writeHead(400).end(); } catch {} }
});
// The page's pixels: one binary message per frame on a WebSocket at /px (a fetch upload of 35 MB takes seconds), answered "ok" once taken.
let pixelSock = null, pixelUsed = false;
httpd.on("upgrade", (req, sock) => {
  sock.on("error", () => {});
  if (!upgradeOk(req, ORIGIN, PX, pixelUsed)) { sock.destroy(); return; }
  const key = req.headers["sec-websocket-key"];
  pixelSock = sock; pixelUsed = true; // one connection per run: a later one is refused
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")}\r\n\r\n`);
  sock.on("close", () => { pixelSock = null; waiting?.reject(new Error("the pixel socket closed")); });
  pixelSocket(sock, frameBytes, (data, ack) => { const w = waiting; waiting = null; if (!w) { sock.destroy(); return; } pixels = data; w.resolve(ack); }, (e) => waiting?.reject(e));
});
let port = 0;
for (let p = P.port; p <= 18990 && !port; p++) { if ([8787, 8788, 8793].includes(p)) continue; try { await new Promise((res, rej) => { httpd.once("error", rej); httpd.listen(p, "127.0.0.1", () => { httpd.off("error", rej); res(); }); }); port = p; } catch {} }
if (!port) die("no free loopback port in 18920 to 18990");
const ORIGIN = `http://127.0.0.1:${port}`;

// ---- Chrome: sandboxed, a fresh profile, no network but this loopback server
const puppeteer = createRequire(import.meta.url)("puppeteer-core");
const profile = mkdtempSync(join(tmpdir(), "replay-chrome-"));
let browser = null, enc = null, sidecarFd = null, encTmp = null, sideTmp = null, stopWhy = "";
const killChrome = () => { try { const pr = browser?.process(); if (pr?.pid && pr.exitCode === null) process.kill(-pr.pid, "SIGKILL"); } catch {} }; // puppeteer starts Chrome as its own process group
async function cleanup() {
  try { await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, 10_000))]); } catch {}
  killChrome();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  try { httpd.close(); httpd.closeAllConnections?.(); } catch {}
}
// A signal or a crash: everything synchronous (an exit handler cannot wait), Chrome and ffmpeg killed, the profile and unfinished files removed.
function hardExit(code, why) {
  console.error("replay:", clean(why, 300));
  try { enc?.kill("SIGKILL"); } catch {}
  killChrome();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  for (const f of [encTmp, sideTmp]) if (f) try { unlinkSync(f); } catch {}
  process.exit(code);
}
// The first Ctrl-C finishes the video up to the current frame (exit 130); a second one, SIGTERM or SIGHUP quit at once and keep nothing.
let interrupted = false;
process.on("SIGINT", () => {
  if (!enc || interrupted || stopWhy) return hardExit(130, "signal SIGINT");
  interrupted = true; stopWhy = "sigint";
  console.error("replay: Ctrl-C: finishing the video up to this frame; press Ctrl-C again to quit at once and keep nothing");
});
for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => hardExit(130, `signal ${sig}`));
process.on("uncaughtException", (e) => hardExit(1, `failed: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => hardExit(1, `failed: ${e?.stack ?? e}`));
const vdpr = P.dpr > 0 ? P.dpr : camAt({ t: 0, wallMs: 0 }).dpr; // the chip's scale and the page layout, fixed for the run
browser = await puppeteer.launch({ executablePath: P.chrome, headless: true, pipe: true, userDataDir: profile, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, args: ["--js-flags=--max-old-space-size=2048", "--proxy-server=http://127.0.0.1:9", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", ...(P.gpu ? [] : ["--disable-gpu"]), "--disable-background-networking", "--disable-component-update", "--no-first-run"] });
const page = await browser.newPage();
await page.setRequestInterception(true);
page.on("request", (rq) => (rq.url().startsWith(ORIGIN + "/") || rq.url() === `ws://127.0.0.1:${port}${PX}` || rq.url().startsWith("blob:") || rq.url().startsWith("data:") ? rq.continue() : rq.abort()));
page.on("pageerror", (e) => console.error("replay: page error", String(e?.message ?? e).slice(0, 300)));
if (!(vdpr >= 0.1 && vdpr <= 32)) { await cleanup(); die(`device pixel ratio ${vdpr} outside 0.1 to 32 (set dpr= or another size or crop)`); }
const vp = { width: Math.max(1000, Math.ceil(W / vdpr)), height: Math.ceil(H / vdpr) };
await page.setViewport({ ...vp, deviceScaleFactor: vdpr });
await page.goto(`${ORIGIN}/index.html`, { waitUntil: "load", timeout: 60_000 });
await page.waitForFunction(() => window.replay?.ready === true, { timeout: 60_000 });
const started = await page.evaluate((a) => window.replay.start(a), { map: mapName, worldW: world.width, worldH: world.height, radius: header.radius, itemRadius: header.itemRadius, fullEnergy: header.fullEnergy, W, H, dpr: vdpr });
if (!started.ok || started.mapVersion !== mapVer) { await cleanup(); die(`map mismatch: the state log was recorded with map ${clean(mapName)} version ${clean(mapVer)}, this checkout draws ${clean(started.mapVersion) || "no such map"}${started.error ? " (" + clean(started.error) + ")" : ""}; build the replay page from a checkout with that map version`); }

// ---- the encoder: a video goes to a fresh hidden file next to out (made exclusively), renamed into place at the end; frames go into the checked folder
if (P.mode === "mp4") encTmp = freshTemp(OUT);
const args = ffmpegArgs({ mode: P.mode, codec: P.codec, W, H, fps: P.fps, crf, preset, pix: P.pix, threads: P.threads, out: encTmp ?? OUT, inPix: yuv ? "yuv420p" : "rgba", lookahead });
enc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"], detached: true }); // its own process group, so a terminal's Ctrl-C reaches only this script, which finishes the file
let encErr = "";
enc.stderr.on("data", (d) => { encErr = (encErr + d).slice(-4000); });
const encDone = new Promise((res) => enc.on("close", (code) => res(code)));
const writeFrame = pipeWriter(enc);
if (SIDECAR) { sideTmp = freshTemp(SIDECAR); sidecarFd = openSync(sideTmp, "r+"); }

// ---- the loop: records -> planner -> frames
const planner = new Planner(planOpts);
const items = new ItemState();
let deaths = [], session = "", lin = { rows: [], rowOf: new Map() }, lastItems = null, lastItemsSeq = NO_SEQ, pageItems = null, seq = 0;
const sum = P.blend > 1 ? new Uint16Array(frameBytes) : null, avg = P.blend > 1 ? Buffer.alloc(frameBytes) : null;
const viewsOf = (r) => (r.views ??= decodeViews(r.records, r.count, world));
const t0 = Date.now();
let lastLog = t0, firstT = null, lastT = null, lastMem = 0, encPeakMB = 0;
const encPeak = () => { try { const m = /VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${enc.pid}/status`, "utf8")); if (m) encPeakMB = Math.max(encPeakMB, Math.round(Number(m[1]) / 1024)); } catch {} };
async function renderSub(sub, fr, cam) {
  const A = sub.A, B = sub.B;
  if (B && B.ghostsOf !== A) { B.ghosts = matchDeaths(viewsOf(A), viewsOf(B), A.simSeconds, B.simSeconds, B.deaths, P.maxSpeed); B.ghostsOf = A; }
  const v = B ? interpolate(viewsOf(A), viewsOf(B), A.simSeconds, B.simSeconds, sub.t ?? fr.t, P.maxSpeed, B.ghosts) : viewsOf(A);
  if (P.items && A.items !== pageItems) { const url = A.items ? `${BLOB}${++seq}` : null; if (url) blobs.set(url, A.items); await page.evaluate((u) => window.replay.setItems(u), url); pageItems = A.items; }
  const id = ++seq, blob = `${BLOB}${id}`;
  let tm = performance.now(); const lap = (k) => { const n = performance.now(); counts.ms[k] += n - tm; tm = n; };
  blobs.set(blob, packViews(v));
  const t = sub.t ?? fr.t;
  lap("prep");
  const res = await page.evaluate((f) => window.replay.frame(f), { blob, cam, simSeconds: t, yearMinutes: A.yearMinutes, winterFood: A.winterFood, chip: !!P.chip, wall: !!P.wall, items: !!P.items, fade: fr.fade, nowMs: (counts.frames * 1000) / P.fps, rings: !!P.rings, ground: P.ground, winterTint: P.winterTint, chipFixed: !!P.chipFixed, creatures: P.creatures });
  lap("draw");
  if (!res.sharp) counts.notSharp++;
  if (res.skipped) counts.bigSkipped++;
  counts.ms.pageWarm += res.tm[1] - res.tm[0]; counts.ms.pageDraw += res.tm[2] - res.tm[1];
  if (res.clip) { counts.chipShots++; const png = await page.screenshot({ clip: { ...res.clip, scale: 1 }, type: "png", encoding: "base64", optimizeForSpeed: true }); await page.evaluate((b) => window.replay.chip(b), png); }
  lap("chip");
  const got = new Promise((resolve, reject) => { waiting = { resolve, reject }; });
  const done = page.evaluate((f, o, y) => window.replay.finish(f, o, y), fr.fade, `ws://127.0.0.1:${port}${PX}`, yuv).then((m) => { counts.ms.pageRead += m.read; counts.ms.pagePost += m.post; });
  done.catch((e) => waiting?.reject(e));
  const ack = await got; // the pixels are in; the page's post returns once ack() is called
  lap("readback");
  counts.subFrames++;
  return { v, ack, done };
}
async function render(fr) {
  const cam = camAt(fr);
  let main = null;
  if (sum) sum.fill(0);
  for (let k = 0; k < fr.subs.length; k++) {
    const { v, ack, done } = await renderSub(fr.subs[k], fr, cam);
    if (k === 0) main = v;
    if (sum) { accumulate(sum, pixels); ack(); await done; }
    else { const buf = pixels; ack(); await done; const tw = performance.now(); await writeFrame(buf); counts.ms.encode += performance.now() - tw; } // the next frame fills a fresh buffer while ffmpeg reads this one
  }
  if (sum) await writeFrame(Buffer.from(average(sum, fr.subs.length, avg)));
  if (sidecarFd !== null) sidecar(fr, main, cam);
  counts.frames++;
  firstT ??= fr.t; lastT = fr.t;
  if (Date.now() - lastMem > 2000) { lastMem = Date.now(); encPeak(); const mb = memAvailMB(); if (P.memStop > 0 && mb < P.memStop && !stopWhy) { stopWhy = `low memory: ${mb} MB available, under memStop=${P.memStop}`; console.error("replay: stopping early,", stopWhy); }
    const free = diskFreeMB(OUT_DIR); if (P.diskStop > 0 && free < P.diskStop && !stopWhy) { stopWhy = `low disk: ${free} MB free, under diskStop=${P.diskStop}`; console.error("replay: stopping early,", stopWhy); } }
  if (Date.now() - lastLog > P.log * 1000) { lastLog = Date.now(); const s = (Date.now() - t0) / 1000; console.error(`replay: ${counts.frames} frames, ${(counts.frames / s).toFixed(2)} fps, sim ${Math.round(fr.t)} s, wall ${isoTime(fr.wallMs)}, rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`); }
}
function sidecar(fr, v, cam) {
  const s = season(fr.t, fr.subs[0].A.yearMinutes), lc = lineageCounts(v, lin);
  const line = { frame: counts.frames, simSeconds: +fr.t.toFixed(3), wall: isoTime(fr.wallMs), year: s.year, season: s.season, winterness: s.winterness >= 0 ? +s.winterness.toFixed(4) : null, population: v.count, fade: fr.fade || undefined, gap: fr.gap || undefined, lineages: lc.rows.map((r) => ({ founder: r.founder, hue: r.hue, starter: r.starter, name: r.name || undefined, count: r.count })), others: lc.others, regions: regions ? regionMatrix(v, regions) : undefined };
  if (P.positions) {
    const pos = [];
    for (let i = 0; i < v.count; i++) {
      if (wantIds && !wantIds.has(v.ids[i] >>> 0)) continue;
      const row = lin.rowOf.get(v.founder[i]) ?? v.founder[i], r = lin.rows.find((q) => q.founder === row);
      pos.push([v.ids[i] >>> 0, +(v.x[i] * cam.Z + cam.Tx).toFixed(1), +(v.y[i] * cam.Z + cam.Ty).toFixed(1), row, Math.round(v.hue[i]), r?.starter ? 0 : 1]);
    }
    line.positions = pos; line.positionsNote = "id, x, y (output px), founder row, hue, added (1 = a visitor's lineage)";
  }
  writeSync(sidecarFd, JSON.stringify(line) + "\n");
}
let stop = false, failure = null;
try {
  for (const r of (function* () { yield* early; yield* log; })()) {
    counts.records[r.type] = (counts.records[r.type] ?? 0) + 1;
    if (r.type === 0) { counts.skippedBytes += r.bytes; continue; }
    if (r.type === T.HEADER) {
      counts.headers++;
      if (r.json?.map !== mapName || r.json?.mapVersion !== mapVer) throw new Error(`a later header names map ${clean(r.json?.map)} ${clean(r.json?.mapVersion)}, the log started with ${mapName} ${clean(mapVer)}`);
      session = clean(r.json.session, 64);
    }
    items.apply(r);
    if (r.type === T.LINEAGES) { lin = lineageRows(r.json); continue; }
    if (r.type === T.DEATHS) { for (let k = 0; k < r.n && deaths.length < 20_000; k++) deaths.push({ tick: r.tick - r.back[k], x: (r.x[k] / 65535) * world.width, y: (r.y[k] / 65535) * world.height, hue: Math.fround((r.hue[k] / 65535) * 360) }); continue; }
    if (!pool(r)) continue;
    if (!recordTimesOk(r)) { counts.badTimes++; continue; } // a wall or simulated time out of range (replayCore recordTimesOk)
    if (r.records === null) { counts.baseLost++; continue; }
    if (r.itemSeq !== NO_SEQ && r.itemSeq === items.seq) { if (lastItemsSeq !== items.seq || !lastItems) { lastItems = itemsMessage(items, r.tick); lastItemsSeq = items.seq; } r.items = lastItems; }
    else if (P.itemsUnknown === "hold" && lastItems) { r.items = lastItems; counts.itemsUnknownHeld++; }
    else { r.items = null; counts.itemsUnknownNone++; }
    r.session = session;
    r.deaths = deaths.map((d) => ({ t: r.simSeconds - (r.tick - d.tick) * dtSim, x: d.x, y: d.y, hue: d.hue })); deaths = []; // since the pool record before: matched to the creatures that leave between the two
    for (const fr of planner.push(r)) { await render(fr); if (stopWhy || (P.maxFrames && counts.frames >= P.maxFrames)) { stop = true; break; } }
    if (stop || planner.done) break;
  }
  if (!stop) for (const fr of planner.end()) { await render(fr); if (stopWhy || (P.maxFrames && counts.frames >= P.maxFrames)) break; }
} catch (err) {
  failure = String(err?.message ?? err).slice(0, 300);
  console.error("replay: failed:", clean(String(err?.stack ?? err), 1000));
}
// The end, also after a failure: ffmpeg gets the end of its input and finishes the file (index included), then the files are renamed into place.
encPeak();
try { enc.stdin.end(); } catch {}
const LATE = Symbol("late");
let code = await Promise.race([encDone, new Promise((r) => setTimeout(() => r(LATE), 120_000).unref())]);
if (code === LATE) { console.error("replay: ffmpeg did not finish within 120 s, killed"); try { enc.kill("SIGKILL"); } catch {} code = await encDone; }
if (sidecarFd !== null) { closeSync(sidecarFd); try { renameSync(sideTmp, SIDECAR); sideTmp = null; } catch (e) { console.error("replay: sidecar not renamed:", e.message); } }
if (encTmp) { if (code === 0) { try { renameSync(encTmp, OUT); encTmp = null; } catch (e) { console.error("replay: video not renamed:", e.message); } } else { try { unlinkSync(encTmp); } catch {} encTmp = null; } }
await cleanup();
const secs = (Date.now() - t0) / 1000;
const summary = { out: OUT, mode: P.mode, codec: P.codec, transfer: yuv ? "yuv" : "rgba", size: `${W}x${H}`, fps: P.fps, crf, preset, pix: P.pix, framing: F.from, frames: counts.frames, subFrames: counts.subFrames, simSeconds: firstT === null ? null : [firstT, lastT], seconds: +secs.toFixed(1), renderFps: +(counts.subFrames / secs).toFixed(2), records: counts.records, skippedBytes: counts.skippedBytes, baseLostSkipped: counts.baseLost, itemsUnknownHeld: counts.itemsUnknownHeld, itemsUnknownNone: counts.itemsUnknownNone, gaps: planner.gaps, rewinds: planner.rewinds, gapPolicy: P.gap, chipScreenshots: counts.chipShots, msPerSubFrame: Object.fromEntries(Object.entries(counts.ms).map(([k, v]) => [k, Math.round(v / Math.max(1, counts.subFrames))])), framesNotSharp: counts.notSharp, framesCreaturesTooLarge: counts.bigSkipped, plannedFrames: plan.frames, planSeconds: +plan.seconds.toFixed(1), badTimesSkipped: counts.badTimes, preHeaderSkipped: counts.preHeader, failed: failure ?? undefined, ffmpegExit: code, stoppedEarly: stopWhy || undefined, lookahead: lookahead >= 0 ? lookahead : undefined, ffmpegPeakRssMB: encPeakMB, peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024) };
console.log(JSON.stringify(summary));
if (code !== 0) console.error("replay: ffmpeg failed:", clean(encErr.slice(-1500), 1500));
process.exit(failure || code !== 0 ? 1 : stopWhy === "sigint" ? 130 : stopWhy ? 3 : 0);
