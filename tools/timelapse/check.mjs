// Sanity check of a running (or finished) time-lapse capture. Reads only the output folder (status.json, frames.jsonl, population.jsonl, the newest PNG header); changes nothing.
// Run: node tools/timelapse/check.mjs [out=<dir>] [world=<folder name>]   Exit 0 = healthy (capturing with a fresh frame, or stopped by the cap), else 1 with one plain line saying what is wrong.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";

const A = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf("="); return [a.slice(0, i), a.slice(i + 1)]; }));
const OUT = resolve(A.out ?? join(import.meta.dirname, "../../videos/timelapse"));
const bad = [];
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const tailLine = (f) => { try { const fd = openSync(f, "r"), n = statSync(f).size, len = Math.min(n, 16384), b = Buffer.alloc(len); readSync(fd, b, 0, len, n - len); closeSync(fd); return b.toString().trimEnd().split("\n").pop(); } catch { return null; } };
const age = (iso) => Math.round((Date.now() - Date.parse(iso)) / 1000);
const fmt = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(1) + " MB");
const say = (...a) => console.log(...a);

const status = readJson(join(OUT, "status.json"));
const interval = status?.interval ?? 20, cap = status?.capBytes ?? 30e9, floor = status?.freeFloorBytes ?? 20e9;
let dir = A.world ?? status?.world;
if (!dir) { try { dir = readdirSync(OUT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().pop(); } catch {} }
if (!status) bad.push("no status.json: the capture script has never run here");
else if (age(status.time) > 30) bad.push(`status.json is ${age(status.time)} s old: the capture script is not running`);
say("output folder:", OUT);
say("script:", status ? `${status.state}${status.message ? " (" + status.message + ")" : ""}, status ${age(status.time)} s old, Chrome ${status.chrome}` : "unknown");
if (!dir) { say("world folder: none"); bad.push("no world folder yet"); }
else {
  const w = join(OUT, dir), world = readJson(join(w, "world.json"));
  say("world folder:", dir, "started", world?.startedCapture ?? "?", world ? `(first tick ${world.firstTick})` : "");
  const frames = [];
  try { for (const l of readFileSync(join(w, "frames.jsonl"), "utf8").split("\n")) if (l) { try { frames.push(JSON.parse(l)); } catch {} } } catch {}
  const bytes = frames.reduce((a, f) => a + f.bytes, 0);
  say("frames written:", frames.length, "| folder", fmt(bytes), "of cap", fmt(cap), `(${((bytes / cap) * 100).toFixed(1)}%)`);
  let fresh = false;
  if (frames.length) {
    const last = frames.at(-1), a = age(last.time);
    fresh = a <= 2 * interval + 5;
    say("newest frame:", last.time, `age ${a} s, tick ${last.tick}, ${last.bytes} B`);
    const gaps = [];
    for (let i = 1; i < frames.length; i++) { const d = (Date.parse(frames[i].time) - Date.parse(frames[i - 1].time)) / 1000; if (d > 1.5 * interval) gaps.push(`${frames[i - 1].time.slice(5, 19)} to ${frames[i].time.slice(5, 19)} (${Math.round(d)} s, ${Math.round(d / interval) - 1} missing)`); }
    say("gaps (> 1.5 intervals):", gaps.length, ...(gaps.length ? ["\n  " + gaps.slice(0, 10).join("\n  ") + (gaps.length > 10 ? `\n  ... ${gaps.length - 10} more` : "")] : []));
    const sorted = frames.map((f) => f.bytes).sort((x, y) => x - y), med = sorted[sorted.length >> 1];
    say("frame bytes: min", sorted[0], "median", med, "max", sorted.at(-1), sorted[0] < med / 3 ? "<- the smallest is far under the median: blank or offline frame?" : "");
    if (sorted[0] < med / 3) bad.push("a frame is far smaller than the median (blank or offline page?), look at the smallest ones");
    try { const png = readdirSync(w).filter((n) => n.endsWith(".png")).sort().pop(), fd = openSync(join(w, png), "r"), b = Buffer.alloc(24); readSync(fd, b, 0, 24, 0); closeSync(fd); say("newest frame file:", png, `${b.readUInt32BE(16)} x ${b.readUInt32BE(20)} px`); } catch { say("newest frame file: unreadable"); bad.push("newest frame file cannot be read"); }
  } else say("newest frame: none yet");
  const pl = tailLine(join(w, "population.jsonl"));
  if (pl) { try { const p = JSON.parse(pl); say("newest population line:", p.time, `age ${age(p.time)} s, tick ${p.tick}, population ${p.population}`); if (age(p.time) > 60) bad.push(`population.jsonl newest line is ${age(p.time)} s old`); } catch { say("newest population line: unreadable"); } }
  else { say("newest population line: none"); bad.push("no population.jsonl line"); }
  let freeB = null; try { const f = statfsSync(OUT); freeB = f.bavail * f.bsize; } catch {}
  say("free disk:", freeB === null ? "?" : fmt(freeB), "floor", fmt(floor));
  const state = status?.state;
  if (state === "capped") say("capture: stopped by the size cap (healthy)");
  else if (state === "capturing" && fresh) say("capture: active");
  else if (state === "capturing" && !frames.length && world && age(world.startedCapture) < 150) say("capture: starting (no frame yet, folder is", age(world.startedCapture), "s old)");
  else if (state === "capturing") { say("capture: not producing frames"); bad.push(frames.length ? `capture says active but the newest frame is ${age(frames.at(-1).time)} s old` : "capture says active but no frame exists"); }
  else if (state) { say("capture: stopped,", state); bad.push(`capture stopped: ${state}${status.message ? " (" + status.message + ")" : ""}`); }
}
if (bad.length) { say("UNHEALTHY:", bad[0]); process.exit(1); }
say("HEALTHY");
