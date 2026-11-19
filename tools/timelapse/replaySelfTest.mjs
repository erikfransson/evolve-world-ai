// End-to-end check of the replay renderer: writes a tiny state log with the capture's own StateWriter and StateRecorder, renders it with replay.mjs
// (Chrome, the built replay page) and checks frame count, interpolation, births, deaths and a creature's colour at its place. Manual: needs Chrome and build-replay.sh,
// which the vitest suite has neither of. Run: nice -n 19 ionice -c3 chrt --idle 0 node tools/timelapse/replaySelfTest.mjs   Exit 0 = pass.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ItemTracker, StateRecorder, StateWriter } from "./stateLog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), SRC = resolve(HERE, "../../src/typescript/src");
const P = await import(join(SRC, "live/protocol.ts")), M = await import(join(SRC, "sim/maps/index.ts")), Ty = await import(join(SRC, "sim/types.ts"));
const root = mkdtempSync(join(tmpdir(), "replay-selftest-")), dir = join(root, "world"), outDir = mkdtempSync(join(tmpdir(), "replay-selftest-out-")); // output outside the capture's folder (root), as replay.mjs demands
mkdirSync(dir);
const world = { width: 60000, height: 37500 }, fails = [];
const check = (ok, what) => { console.log(ok ? "ok  " : "FAIL", what); if (!ok) fails.push(what); };
try {
  const header = { worldId: "selftest", map: "clock", mapVersion: M.mapVersion("clock"), world, dt: 1 / 30, radius: 12, itemRadius: 4, fullEnergy: 223.6 };
  const writer = new StateWriter(dir, { capBytes: 1e9, fileBytes: 256e6, freeFloorBytes: 0, header }), items = new ItemTracker();
  const rec = new StateRecorder(writer, items, { every: 5, itemsEvery: 30, keyEvery: 600 });
  const slots = 64, kinds = Array.from({ length: slots }, (_, i) => (i % 8 === 7 ? Ty.HIT_POISON : Ty.HIT_FOOD));
  items.full(Buffer.from(P.encodeItems(30000, { xs: kinds.map((_, i) => 2000 + 900 * i), ys: kinds.map(() => 34000), kinds, slots }, world)));
  const q = (v, span) => Math.round((v / span) * 65535), base = Math.ceil(Date.now() / 5000) * 5000 - 100_000;
  for (let k = 0; k < 7; k++) {
    const sim = 1000 + 15 * k, list = [[10, 10000 + 5000 * k, 18750, 50 + 15 * k, 0]]; // id, x, y, age, hue: 10 moves right
    if (k <= 3) list.push([20, 30000, 30000, 200, 120]); // dies between records 3 and 4
    if (k >= 4) list.push([30, 20000, 8000, 2 + 15 * (k - 4), 240]); // born 2 s before record 4
    const f = P.newCreatureFrame(Math.round(sim * 30), list.length);
    list.forEach(([id, x, y, age, hue], i) => P.putCreature(f, 9 + 19 * i, id, q(x, world.width), q(y, world.height), 0, 48, 200, Math.min(255, age), q(hue, 360), 7));
    rec.creatures(Buffer.from(f), base + 5000 * k, { simSeconds: sim, population: list.length, season: { yearMinutes: 60, winterFood: 0.3 }, lineages: [{ founder: 7, hue: 0, starter: true, count: list.length, name: "selftest", founders: [] }] });
  }
  writer.close();
  const out = join(outDir, "frames"), r = spawnSync(process.execPath, [join(HERE, "replay.mjs"), `world=${dir}`, `out=${out}`, "mode=frames", "size=930x584", "step=5s", "interpolate=1", "sidecar=1", "positions=all", "port=18960"], { encoding: "utf8", timeout: 600_000 });
  check(r.status === 0, `replay.mjs exits 0 (${(r.stderr || "").trim().split("\n").pop()})`);
  const sum = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
  check(sum.frames === 19, `19 frames for 90 simulated seconds at 5 s (got ${sum.frames})`);
  check(sum.itemsUnknownNone === 0 && sum.itemsUnknownHeld === 0 && sum.baseLostSkipped === 0 && sum.framesNotSharp === 0, "items known, no base lost, the map drawn sharp");
  const lines = readFileSync(out + ".jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const pos = (l, id) => l.positions.find((p) => p[0] === id);
  const xs = lines.map((l) => pos(l, 10)?.[1]), steps = xs.slice(1).map((x, i) => x - xs[i]);
  check(steps.every((s) => Math.abs(s - steps[0]) < 0.2) && steps[0] > 0, `creature 10 glides at a steady ${steps[0]?.toFixed(2)} px a frame`);
  const at = (t) => lines.find((l) => Math.abs(l.simSeconds - t) < 1e-6);
  check(!!pos(at(1055), 20) && !pos(at(1060), 20), "creature 20 stays in place until the record without it");
  check(!pos(at(1055), 30) && !!pos(at(1060), 30) && pos(at(1060), 30)[1] === pos(at(1090), 30)[1], "creature 30 shows from its birth, at its own place");
  check(at(1060).lineages[0].name === "selftest" && at(1060).season !== "", "sidecar lineages and season");
  const l = lines[6], p = pos(l, 10), png = spawnSync("ffmpeg", ["-loglevel", "error", "-i", join(out, `frame_${String(l.frame).padStart(6, "0")}.png`), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 26 }).stdout;
  const o = 3 * (Math.round(p[2]) * 930 + Math.round(p[1])), [R, G, B] = [png[o], png[o + 1], png[o + 2]];
  check(R > G + 60 && R > B + 60, `creature 10 is drawn red at its place (rgb ${R} ${G} ${B})`);
  const bad = join(dir, "other-map"); // a log recorded with another design of the map is refused
  mkdirSync(bad);
  const w2 = new StateWriter(bad, { capBytes: 1e9, fileBytes: 256e6, freeFloorBytes: 0, header: { ...header, mapVersion: "00000000-0" } });
  const f2 = P.newCreatureFrame(30000, 1); P.putCreature(f2, 9, 10, 1000, 1000, 0, 48, 200, 50, 0, 7); // one creature record, so there is something to draw
  new StateRecorder(w2, new ItemTracker(), { every: 5, itemsEvery: 30, keyEvery: 600 }).creatures(Buffer.from(f2), base, { simSeconds: 1000, population: 1, season: { yearMinutes: 60, winterFood: 0.3 }, lineages: [] });
  w2.close();
  const r2 = spawnSync(process.execPath, [join(HERE, "replay.mjs"), `world=${bad}`, `out=${join(outDir, "x.mp4")}`, "port=18960"], { encoding: "utf8", timeout: 300_000 });
  check(r2.status === 2 && /map mismatch/.test(r2.stderr), `another map version is refused (${(r2.stderr || "").trim().slice(0, 160)})`);
  const r3 = spawnSync(process.execPath, [join(HERE, "replay.mjs"), `world=${dir}`, `out=${join(root, "inside.mp4")}`, "port=18960"], { encoding: "utf8", timeout: 60_000 });
  check(r3.status === 2 && /outside the capture/.test(r3.stderr), "an output inside the capture's folder is refused");
} finally { rmSync(root, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true }); }
console.log(fails.length ? `FAILED: ${fails.length}` : "PASS");
process.exit(fails.length ? 1 : 0);
