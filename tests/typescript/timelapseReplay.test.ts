// The replay renderer's non-browser half (tools/timelapse/replayCore.mjs): times, record selection and gaps, views and interpolation, camera, items, sidecar counts.
import { DEFAULT_ECO_CONFIG, seasonName, winterness } from "../../src/typescript/src/sim/ecoConfig.ts";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCreatures, decodeItems, newCreatureFrame, putCreature } from "../../src/typescript/src/live/protocol.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const C: any = await import(new URL("../../tools/timelapse/replayCore.mjs", import.meta.url).href);
const WORLD = { width: 60000, height: 37500 };

// A record of creatures [id, x, y, age] (world units), sorted by id, in the state log's wire layout.
function recs(list: number[][]): Buffer {
  const f = newCreatureFrame(0, list.length);
  list.forEach(([id, x, y, age], i) => putCreature(f, 9 + 19 * i, id!, Math.round((x! / WORLD.width) * 65535), Math.round((y! / WORLD.height) * 65535), 1000, 48, 128, age!, 9000, 7));
  return Buffer.from(f.subarray(9));
}
const views = (list: number[][]) => C.decodeViews(recs(list), list.length, WORLD);
const rec = (wallMs: number, simSeconds: number, session = "s") => ({ wallMs, simSeconds, session });

describe("times and steps", () => {
  it("parses wall times, simulated seconds with units, and record or time steps", () => {
    expect(C.parseTime("2026-11-15T03:00:00Z")).toEqual({ kind: "wall", v: Date.parse("2026-11-15T03:00:00Z") });
    expect(C.parseTime("111h")).toEqual({ kind: "sim", v: 111 * 3600 });
    expect(C.parseTime("400000")).toEqual({ kind: "sim", v: 400000 });
    expect(C.parseTime("")).toBe(null);
    expect(() => C.parseTime("yesterday")).toThrow();
    expect(C.parseStep("3")).toEqual({ every: 3 });
    expect(C.parseStep("0.1s")).toEqual({ sim: 0.1 });
    expect(C.parseStep("2m")).toEqual({ sim: 120 });
    expect(() => C.parseStep("0")).toThrow();
  });
  it("names seasons and winterness as the engine does", () => {
    const eco = { ...DEFAULT_ECO_CONFIG.eco, seasons: true, yearMinutes: 60, winterFood: 0.3 };
    for (const t of [0, 450, 900, 1799, 1800, 2700, 3599, 3600 * 7 + 1234, 455700.37]) {
      const s = C.season(t, 60);
      expect(s.season).toBe(seasonName(eco, t));
      expect(s.winterness).toBeCloseTo(winterness(eco, t), 12);
    }
    expect(C.season(100, 0)).toEqual({ year: null, season: "", winterness: -1 });
  });
});

describe("creature views", () => {
  it("decode a record exactly as the page decodes the wire frame", () => {
    const list = [[3, 100, 200, 5], [9, 59999, 37000, 255], [2 ** 31 + 5, 30000, 18750, 0]];
    const v = views(list), f = decodeCreatures(Buffer.concat([Buffer.from(newCreatureFrame(0, 3).subarray(0, 9)), recs(list)]), WORLD);
    for (let i = 0; i < 3; i++) {
      expect(v.ids[i] >>> 0).toBe(f.ids[i]);
      expect([v.x[i], v.y[i], v.heading[i], v.energy[i], v.hue[i], v.age[i], v.founder[i]]).toEqual([f.x[i], f.y[i], f.heading[i], f.energyShare[i], f.hue[i], f.age[i], f.founder[i]].map((n) => Math.fround(n)));
    }
  });
  it("interpolate by id: movers glide, the newborn shows from its birth at its own place, the dead stay put until the next record", () => {
    const A = views([[1, 1000, 1000, 50], [2, 5000, 5000, 50]]);
    const B = views([[1, 2000, 1000, 55], [3, 40000, 30000, 2]]); // 2 died, 3 born 2 s before B
    const at = (t: number) => C.interpolate(A, B, 100, 105, t);
    const mid = at(102.5);
    expect(mid.count).toBe(2); // 1 and the ghost of 2; 3 not born yet (born at 103)
    expect(mid.x[0]).toBeCloseTo(1500, -1);
    expect([mid.ids[1], mid.x[1]]).toEqual([2, A.x[1]]);
    const late = at(104);
    expect(Array.from(late.ids.subarray(0, late.count))).toEqual([1, 2, 3]);
    expect(late.x[2]).toBe(B.x[1]); // at its B place, no glide from anywhere
    const end = at(105);
    expect(Array.from(end.ids.subarray(0, end.count))).toEqual([1, 3]);
    const guarded = C.interpolate(views([[1, 1000, 1000, 9]]), views([[1, 50000, 1000, 14]]), 0, 5, 1, 100); // 49000 units in 5 s: jumps, never sweeps across
    expect(guarded.x[0]).toBeCloseTo(1000, -1);
    expect(C.interpolate(views([[1, 1000, 1000, 9]]), views([[1, 50000, 1000, 14]]), 0, 5, 4, 100).x[0]).toBeCloseTo(50000, -1);
  });
  it("send a dying creature to its death place and remove it at its death time when a death event matches it", () => {
    const A = views([[1, 1000, 1000, 50], [2, 5000, 5000, 50], [3, 9000, 9000, 50]]), B = views([[1, 2000, 1000, 55]]);
    const hue = A.hue[1]!, deaths = [{ t: 102, x: 5200, y: 5000, hue }, { t: 101, x: 30000, y: 9000, hue }]; // the second is too far from 3 to be its death
    const m = C.matchDeaths(A, B, 100, 105, deaths, 400);
    expect([...m.keys()]).toEqual([2]);
    const at = (t: number) => C.interpolate(A, B, 100, 105, t, 400, m);
    const mid = at(101);
    expect(Array.from(mid.ids.subarray(0, mid.count))).toEqual([1, 2, 3]);
    expect(mid.x[1]).toBeCloseTo((A.x[1]! + 5200) / 2, 3); // half way to its death place
    const late = at(102.5);
    expect(Array.from(late.ids.subarray(0, late.count))).toEqual([1, 3]); // 2 died at 102, 3 (no event) stays until B
  });
  it("pack views in the layout the page reads", () => {
    const v = views([[4, 10, 20, 3], [8, 30, 40, 7]]), b: Buffer = C.packViews(v);
    expect(b.readUInt32LE(0)).toBe(2);
    expect(b.length).toBe(4 + 32 * 2);
    expect(b.readFloatLE(4 + 4 * 2 * 1 + 4)).toBe(v.x[1]);
    expect(b.readInt32LE(4 + 4 * 2 * 7 + 4)).toBe(v.founder[1]);
  });
  it("average blended frames with rounding", () => {
    const sum = new Uint16Array(3);
    C.accumulate(sum, Uint8Array.from([0, 255, 10]));
    C.accumulate(sum, Uint8Array.from([1, 255, 13]));
    expect(Array.from(C.average(sum, 2, new Uint8Array(3)))).toEqual([1, 255, 12]);
  });
});

describe("planner", () => {
  const run = (opts: object, list: object[]) => { const p = new C.Planner(opts); const out = list.flatMap((r) => p.push(r)); return { out: [...out, ...p.end()], p }; };
  const five = Array.from({ length: 10 }, (_, i) => rec(1e6 + 5000 * i, 1000 + 15 * i));
  it("records mode: every Nth record in range, blend takes the records before it", () => {
    const { out } = run({ step: { every: 3 }, from: { kind: "sim", v: 1015 }, to: { kind: "wall", v: 1e6 + 5000 * 8 } }, five);
    expect(out.map((f: { t: number }) => f.t)).toEqual([1015, 1060, 1105]);
    const b = run({ step: { every: 2 }, blend: 2 }, five.slice(0, 4)).out;
    expect(b.map((f: { subs: { A: { simSeconds: number } }[] }) => f.subs.map((s) => s.A.simSeconds))).toEqual([[1000], [1015, 1030]]);
  });
  it("records mode: a gap is cut, held or faded, never blended across", () => {
    const g = [rec(0, 0), rec(5000, 15), rec(65000, 60), rec(70000, 75)]; // a 60 s outage
    expect(run({ gap: "cut" }, g).out.length).toBe(4);
    const hold = run({ gap: "hold" }, g).out;
    expect(hold.length).toBe(4 + 11);
    expect(hold.filter((f: { gap: boolean }) => f.gap).every((f: { t: number }) => f.t === 15)).toBe(true);
    const fade = run({ gap: "fade", fadeFrames: 3 }, g).out;
    expect(fade.map((f: { fade: number }) => +f.fade.toFixed(2))).toEqual([0, 0, 0.25, 0.5, 0.75, 0.75, 0.5, 0.25, 0, 0]);
    expect(run({ blend: 2 }, g).out[2].subs.length).toBe(1);
    expect(run({}, [rec(0, 0, "a"), rec(5000, 15, "b")]).p.gaps).toBe(1);
  });
  it("time mode: frames every step, interpolated between the records around them", () => {
    const { out } = run({ step: { sim: 5 }, interpolate: true }, five.slice(0, 3));
    expect(out.map((f: { t: number }) => f.t)).toEqual([1000, 1005, 1010, 1015, 1020, 1025, 1030]);
    const f = out[4];
    expect([f.subs[0].A.simSeconds, f.subs[0].B.simSeconds, f.subs[0].a]).toEqual([1015, 1030, 1 / 3]);
    expect(f.wallMs).toBeCloseTo(1e6 + 5000 + 5000 / 3, 6);
    expect(run({ step: { sim: 5 } }, five.slice(0, 2)).out[1].subs[0].B).toBe(null); // without interpolate: the record before
  });
  it("time mode: a gap is cut or held, simulated time going back waits until it passes again, blend spreads sub-frames over the step", () => {
    const g = [rec(0, 0), rec(5000, 10), rec(65000, 40), rec(70000, 50)];
    expect(run({ step: { sim: 5 } }, g).out.map((f: { t: number }) => f.t)).toEqual([0, 5, 10, 40, 45, 50]);
    expect(run({ step: { sim: 5 }, gap: "hold" }, g).out.map((f: { t: number }) => f.t)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
    const back = [rec(0, 0), rec(5000, 10), rec(10000, 4), rec(15000, 12), rec(20000, 20)];
    const r = run({ step: { sim: 5 } }, back);
    expect(r.out.map((f: { t: number }) => f.t)).toEqual([0, 5, 10, 15, 20]);
    expect(r.p.rewinds).toBe(1);
    const bl = run({ step: { sim: 10 }, blend: 2, interpolate: true }, [rec(0, 0), rec(5000, 10), rec(10000, 20)]).out;
    expect(bl[2].subs.map((s: { t: number }) => s.t)).toEqual([20, 15]);
  });
});

describe("camera", () => {
  const real = { camera: { zoom: 0.03072, origin: [38.39999999999998, 24], dsf: 2 }, crop: { x: 30, y: 16, width: 1860, height: 1168 }, size: [3720, 2336] }; // world.json of the clock world, 2026-11-13
  it("reproduces the capture's framing a", () => {
    const f = C.captureFraming(60000, 37500);
    expect(f.camera.zoom).toBeCloseTo(real.camera.zoom, 12);
    expect(f.camera.origin[0]).toBeCloseTo(real.camera.origin[0], 9);
    expect(f.camera.origin[1]).toBeCloseTo(real.camera.origin[1], 9);
    expect(f.crop).toEqual(real.crop);
    expect(f.size).toEqual(real.size);
  });
  it("maps world units to PNG px with world.json's formula, and a whole-PNG crop at PNG size is that transform", () => {
    const b = C.pngBase(real.camera, real.crop), px = (wx: number, c: { Z: number; Tx: number }) => wx * c.Z + c.Tx;
    expect(px(0, b)).toBeCloseTo((real.camera.origin[0] + 0 - real.crop.x) * 2, 9);
    expect(px(60000, b)).toBeCloseTo((real.camera.origin[0] + 60000 * real.camera.zoom - real.crop.x) * 2, 9);
    const c = C.cropCam(b, [0, 0, 3720, 2336], 3720, 2336);
    for (const k of ["Z", "Tx", "Ty", "dpr"] as const) expect(c[k]).toBeCloseTo(b[k], 9);
  });
  it("draws a PNG crop natively at another size, corners on corners, dots scaled with it", () => {
    const b = C.pngBase(real.camera, real.crop), r = [1000, 500, 1900, 1068.75], c = C.cropCam(b, r, 2560, 1440);
    const wx = (pngX: number) => (pngX - b.Tx) / b.Z, wy = (pngY: number) => (pngY - b.Ty) / b.Z;
    expect(wx(r[0]!) * c.Z + c.Tx).toBeCloseTo(0, 6);
    expect(wx(r[0]! + r[2]!) * c.Z + c.Tx).toBeCloseTo(2560, 6);
    expect(wy(r[1]! + r[3]!) * c.Z + c.Ty).toBeCloseTo(1440, 6);
    expect(c.dpr).toBeCloseTo(2 * (2560 / 1900), 9);
    const z = C.centerCam(b, real.size, 1920, 1080, 30000, 18750, 4);
    expect(30000 * z.Z + z.Tx).toBeCloseTo(960, 9);
    expect(z.Z).toBeCloseTo(b.Z * (1080 / 2336) * 4, 12);
    expect(z.dpr).toBeCloseTo(2 * (1080 / 2336), 12);
  });
  it("moves between keyframes: holds outside them, eases, zooms geometrically", () => {
    const b = C.pngBase(real.camera, real.crop);
    const keys = C.parseKeys('[{"t":"100","center":[30000,18750],"zoom":1},{"t":"200","center":[40000,10000],"zoom":16}]', b, real.size, 1920, 1080);
    const at = (t: number) => C.keyCam(keys, { t, wallMs: 0 }, 1920, 1080);
    expect(at(50)).toEqual(at(100));
    expect(at(250).Z).toBeCloseTo(keys[1].Z, 9);
    expect(at(150).Z).toBeCloseTo(Math.sqrt(keys[0].Z * keys[1].Z), 9);
    expect(C.camCenter(at(150), 1920, 1080).cx).toBeCloseTo(35000, 6);
    expect(() => C.parseKeys('[{"t":"100","center":[1,2]},{"t":"2026-11-15T03:00:00Z","center":[1,2]}]', b, real.size, 1920, 1080)).toThrow();
  });
});

describe("items and sidecar", () => {
  it("write an item set as an ITEMS message the page decodes back", () => {
    const st = { slots: 9, kinds: Uint8Array.from([0, 1, 2, 0, 0, 1, 0, 0, 2]), x: new Uint16Array(9).map((_, i) => i * 1000), y: new Uint16Array(9).map((_, i) => 65535 - i) };
    const d = decodeItems(C.itemsMessage(st, 77), WORLD);
    expect(d.tick).toBe(77);
    expect(Array.from(d.kinds)).toEqual(Array.from(st.kinds));
    expect(d.x[8]).toBeCloseTo((8000 / 65535) * 60000, 3);
  });
  it("count lineages and regions as regions.jsonl does, and keep visitor names out", () => {
    const lin = C.lineageRows({ lineages: [{ founder: 7, hue: 120, starter: true, name: "grazer", founders: [8] }, { founder: 50, hue: 0, starter: false, name: "visitorname" }] });
    expect(lin.rows.map((r: { name: string }) => r.name)).toEqual(["grazer", ""]);
    const f = newCreatureFrame(0, 4);
    [[1, 7, 120], [2, 8, 121], [3, 50, 0], [4, 99, 250]].forEach(([id, founder, hue], i) => putCreature(f, 9 + 19 * i, id!, 32768, 32768, 0, 48, 1, 1, Math.round((hue! / 360) * 65535), founder!));
    const v = C.decodeViews(Buffer.from(f.subarray(9)), 4, WORLD);
    const lc = C.lineageCounts(v, lin);
    expect(lc.rows.map((r: { count: number }) => r.count)).toEqual([2, 1]);
    expect(lc.others).toBe(1);
    const R = { ids: ["mid", "far"], x: [30000, 1000], y: [18750, 1000], r: [1000, 1000], hueIds: ["mid"], hues: [120] };
    expect(C.regionMatrix(v, R)).toEqual([2, 2, 0, 0, 0, 0]); // all in "mid": two of hue 120, two other
  });
  it("encode h264 with the bt709 matrix and tags, lossless and masters as asked", () => {
    const a: string[] = C.ffmpegArgs({ mode: "mp4", codec: "h264", W: 1920, H: 1080, fps: 30, crf: 12, preset: "slow", pix: "yuv420p", threads: 4, out: "x.mp4" });
    expect(a.join(" ")).toMatch(/out_color_matrix=bt709.*-profile:v high -preset slow -crf 12 .*-colorspace bt709 .*-movflags \+faststart x\.mp4$/);
    expect(a).not.toContain("-x264-params");
    expect(C.ffmpegArgs({ mode: "mp4", codec: "h264", W: 3840, H: 2160, fps: 30, crf: 12, preset: "slow", pix: "yuv420p", threads: 4, out: "x.mp4", lookahead: 20 }).join(" ")).toContain("-crf 12 -x264-params rc-lookahead=20 ");
    expect(C.ffmpegArgs({ mode: "mp4", codec: "h264", W: 2, H: 2, fps: 30, crf: 0, preset: "slow", pix: "yuv444p", threads: 4, out: "x.mp4" })).not.toContain("-profile:v");
    expect(C.ffmpegArgs({ mode: "mp4", codec: "ffv1", W: 2, H: 2, fps: 30, crf: 0, preset: "slow", pix: "", threads: 4, out: "x.mkv" })).toContain("bgr0");
    expect(C.ffmpegArgs({ mode: "frames", codec: "h264", W: 2, H: 2, fps: 30, crf: 0, preset: "", pix: "", threads: 4, out: "/f" }).at(-1)).toBe("/f/frame_%06d.png");
  });
});

describe("pixel socket", () => {
  // A browser's binary message as WebSocket frames: masked, split into fragments of these sizes.
  function frames(data: Buffer, parts: number[]): Buffer {
    const out: Buffer[] = [];
    let at = 0;
    parts.forEach((n, k) => {
      const mask = Buffer.from([17 + k, 99, 200, 3 + k]), last = k === parts.length - 1, len = n < 126 ? [n] : n < 65536 ? [126, n >> 8, n & 255] : [127, 0, 0, 0, 0, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
      const head = Buffer.from([(last ? 128 : 0) | (k === 0 ? 2 : 0), 128 | len[0]!, ...len.slice(1), ...mask]);
      const body = Buffer.from(data.subarray(at, at + n)).map((b, i) => b ^ mask[i & 3]!);
      out.push(head, Buffer.from(body)); at += n;
    });
    return Buffer.concat(out);
  }
  const sock = () => Object.assign(new EventEmitter(), { destroyed: false, wrote: [] as Buffer[], destroy() { this.destroyed = true; }, write(b: Buffer) { this.wrote.push(b); }, end() {} });
  it("reassembles fragmented, masked frames split anywhere into the frame bytes, and answers ok", () => {
    const size = 70001, data = Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + (i >> 8)) & 255));
    const wire = Buffer.concat([frames(data, [5, 65530, 4466]), frames(data, [size])]);
    const s = sock(), got: Buffer[] = [];
    C.pixelSocket(s, size, (b: Buffer, ack: () => void) => { got.push(Buffer.from(b)); ack(); }, (e: Error) => { throw e; });
    for (let at = 0, k = 1; at < wire.length; k = (k * 7919) % 6007 + 1) { s.emit("data", wire.subarray(at, at + k)); at += k; }
    expect(got.length).toBe(2);
    expect(got.every((b) => b.equals(data))).toBe(true);
    expect(s.wrote.length).toBe(2);
    const bad = sock(); let err = "";
    C.pixelSocket(bad, 4, () => undefined, (e: Error) => (err = e.message));
    bad.emit("data", frames(Buffer.alloc(8), [8]));
    expect([bad.destroyed, err]).toEqual([true, "not a frame of pixels"]);
  });
});

describe("hostile logs, paths and processes", () => {
  const W5 = 5000;
  it("a simulated time jump inside one session is a gap, not millions of frames", () => {
    const p = new C.Planner({ step: C.parseStep("1s") });
    p.push(rec(0, 0));
    const t0 = Date.now(), out = p.push(rec(W5, 2e6));
    expect(out.length).toBeLessThanOrEqual(2);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(p.gaps).toBe(1);
  });
  it("records with wall or simulated times out of range are skipped, also in the planner", () => {
    for (const r of [rec(NaN, 10), rec(0, NaN), rec(9e15, 10), rec(-1, 10), rec(0, 1e16), rec(0, -5), rec(Infinity, 1)]) expect(C.recordTimesOk(r)).toBe(false);
    expect(C.recordTimesOk(rec(Date.parse("2026-11-15T00:00:00Z"), 4e5))).toBe(true);
    const p = new C.Planner({ step: C.parseStep("0.1s"), gap: "hold" });
    expect([p.push(rec(0, 1e16)), p.push(rec(600_000, 2e16)), p.push(rec(NaN, 5))]).toEqual([[], [], []]);
    expect(p.badTimes).toBe(3);
    expect([C.isoTime(NaN), C.isoTime(9e15), C.isoTime(0)]).toEqual([null, null, "1970-01-01T00:00:00.000Z"]);
  });
  it("a step below the precision of simulated time throws instead of looping", () => {
    const p = new C.Planner({ step: { sim: 1e-7 } });
    expect(() => { p.push(rec(0, 1e10 - 10)); p.push(rec(W5, 1e10)); }).toThrow(/precision/);
  });
  it("a held gap at a huge simulated time holds at most holdMax frames and skips the rest in one step", () => {
    const p = new C.Planner({ step: C.parseStep("0.1s"), gap: "hold", holdMax: 60 });
    p.push(rec(0, 9e9));
    const t0 = Date.now(), out = p.push(rec(86_400_000, 9e9 + 5e7));
    expect(out.filter((f: { gap: boolean }) => f.gap).length).toBe(60);
    expect(out.length).toBeLessThanOrEqual(62);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(p.t).toBeGreaterThanOrEqual(9e9 + 5e7);
  });
  it("planning more frames than the caps allow throws a clear error", () => {
    const p = new C.Planner({ step: C.parseStep("0.001s"), maxPerPush: 1000 });
    p.push(rec(0, 100));
    expect(() => p.push(rec(W5, 115))).toThrow(/coarser step/);
    const q = new C.Planner({ step: C.parseStep("1s"), maxTotal: 20 });
    q.push(rec(0, 100));
    expect(() => q.push(rec(W5, 130))).toThrow(/frames/);
  });
  it("death matching stays bounded in the worst case (every vanished creature against every same-hue death)", () => {
    const n = 20000, A = C.newViews(n), B = C.newViews(0);
    for (let i = 0; i < n; i++) { A.ids[i] = i; A.hue[i] = 120; }
    const deaths = Array.from({ length: 20000 }, () => ({ t: 5, x: 1e6, y: 1e6, hue: 120 }));
    const t0 = Date.now(), m = C.matchDeaths(A, B, 0, 5, deaths, 400);
    expect(m.size).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it("the header is found without keeping the records before it", () => {
    const big = { type: 4, bytes: 1_300_000, slots: new Uint8Array(1 << 18) };
    const gen = function* (k: number) { for (let i = 0; i < k; i++) yield big; yield { type: 1, bytes: 100, json: { map: "clock" } }; };
    const f = C.findHeader(gen(200));
    expect([f.header.map, f.skipped, f.skippedBytes, Object.keys(f).sort()]).toEqual(["clock", 200, 260_000_000, ["header", "record", "skipped", "skippedBytes"]]);
    expect(C.findHeader(gen(1001))).toBe(null);
  });
  it("a header with sizes out of range is refused", () => {
    const h = { world: { width: 60000, height: 37500 }, radius: 12, itemRadius: 4, fullEnergy: 223, map: "clock" };
    expect(C.headerProblem(h)).toBe(null);
    for (const bad of [{ radius: 1e300 }, { radius: 1e4 }, { radius: 101 }, { itemRadius: 60 }, { fullEnergy: 0 }, { world: { width: 1e300, height: 1 } }, { map: "../x" }, { itemRadius: NaN }]) expect(C.headerProblem({ ...h, ...bad })).not.toBe(null);
  });
  it("world.json's framing is used only when it is the capture's own, else framing a with the reason", () => {
    const good = { camera: { zoom: 0.03072, origin: [38.39999999999998, 24], dsf: 2, viewport: [1920, 1200] }, crop: { x: 30, y: 16, width: 1860, height: 1168 }, size: [3720, 2336] }; // the real 2026-11-13 world.json
    expect(C.framingFrom(good, 60000, 37500).from).toBe("world.json");
    expect(C.framingFrom({ camera: { ...good.camera, dsf: 4 }, crop: good.crop, size: [7440, 4672] }, 60000, 37500).from).toBe("world.json"); // framing b
    for (const bad of [{ camera: { ...good.camera, zoom: 100, dsf: 8 } }, { camera: { ...good.camera, zoom: 1e300 } }, { camera: { ...good.camera, dsf: 1e-9 } }, { camera: { ...good.camera, origin: [NaN, 0] } },
      { size: [8192, 8192] }, { size: [3720] }, { size: [3722, 2336] }, { crop: { ...good.crop, width: 0 } }, { crop: { ...good.crop, x: 200 } }])
      expect(C.framingFrom({ ...good, ...bad }, 60000, 37500).from).toMatch(/^the capture's framing a \(world\.json/);
    expect(C.framingFrom(good, 1, 1).from).not.toBe("world.json"); // another world size: not this camera
  });
  it("outputs inside the capture's folder or through a link are refused", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "replay-out-"))), root = join(tmp, "root"), mine = join(tmp, "mine");
    try {
      mkdirSync(join(root, "world"), { recursive: true }); mkdirSync(mine);
      expect(() => C.outputPath(join(root, "x.mp4"), root)).toThrow(/inside the capture/);
      expect(() => C.outputPath(join(root, "world", "x.mp4"), root)).toThrow(/inside the capture/);
      symlinkSync(root, join(mine, "into")); // a planted link to a folder inside the capture's
      expect(() => C.outputPath(join(mine, "into", "x.mp4"), root)).toThrow(/inside the capture/);
      symlinkSync("/etc/passwd", join(mine, "link.mp4"));
      expect(() => C.outputPath(join(mine, "link.mp4"), root)).toThrow(/a link/);
      expect(() => C.outputPath(join(mine, "none", "x.mp4"), root)).toThrow(/no folder/);
      expect(C.outputPath(join(mine, "ok.mp4"), root)).toBe(join(mine, "ok.mp4"));
      expect(C.outputPath(join(mine, "frames"), root, { dir: true })).toBe(join(mine, "frames"));
      writeFileSync(join(mine, "file"), "");
      expect(() => C.outputPath(join(mine, "file"), root, { dir: true })).toThrow(/not a folder/);
      const t = C.freshTemp(join(mine, "ok.mp4"));
      expect(t).toMatch(/\/\.ok\.[0-9a-f]{12}\.part\.mp4$/);
      expect(readdirSync(mine)).toContain(t.split("/").pop());
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  it("a write to an encoder that exits mid-run rejects instead of waiting forever", async () => {
    const child = spawn("sh", ["-c", "head -c 1000000 >/dev/null"], { stdio: ["pipe", "ignore", "ignore"] });
    const write = C.pipeWriter(child);
    let err = "";
    const t0 = Date.now();
    try { for (let i = 0; i < 10; i++) await write(Buffer.alloc(8 << 20)); } catch (e) { err = (e as Error).message; }
    expect(err).toMatch(/encoder/);
    expect(Date.now() - t0).toBeLessThan(5000);
    await expect(write(Buffer.alloc(1))).rejects.toThrow(/encoder/);
  });
  it("the pixel socket takes one upgrade, on the secret path, from the page's own origin", () => {
    const req = (url: string, origin: string) => ({ url, headers: { origin, "sec-websocket-key": "abc" } });
    const O = "http://127.0.0.1:18920", PX = "/px/0123";
    expect(C.upgradeOk(req(PX, O), O, PX, false)).toBe(true);
    expect(C.upgradeOk(req(PX, O), O, PX, true)).toBe(false);
    expect(C.upgradeOk(req("/px", O), O, PX, false)).toBe(false);
    expect(C.upgradeOk(req(PX, "http://evil"), O, PX, false)).toBe(false);
    expect(C.upgradeOk({ url: PX, headers: { "sec-websocket-key": "abc" } }, O, PX, false)).toBe(false);
  });
});

describe("plan size, disk and heading", () => {
  it("simulated time far faster than the real world's 3 to 4 per wall second is a gap", () => {
    const p = new C.Planner({ step: C.parseStep("1s") });
    p.push(rec(0, 1000));
    expect(p.push(rec(5000, 1015)).length).toBe(15);
    expect(p.gaps).toBe(0);
    expect(p.push(rec(10000, 1215)).length).toBeLessThanOrEqual(1); // 40 per wall second
    expect(p.gaps).toBe(1);
  });
  it("the per-push cap counts sub-frames, and blend has an upper limit", () => {
    const mk = (blend: number) => { const p = new C.Planner({ step: C.parseStep("0.1s"), blend, maxPerPush: 1000 }); p.push(rec(0, 100)); return () => p.push(rec(5000, 115)); };
    expect(mk(1)().length).toBe(151); // the first record's own frame and 150 steps
    expect(mk(16)).toThrow(/sub-frames/);
    expect(() => new C.Planner({ blend: 33 })).toThrow(/blend/);
  });
  it("estimates output size and reads free disk space", () => {
    expect(C.sizeEstimateMB({ mode: "mp4", codec: "h264", crf: 12, pix: "yuv420p", W: 1920, H: 1080 }, 1800)).toBeGreaterThan(250);
    expect(C.sizeEstimateMB({ mode: "mp4", codec: "h264", crf: 12, pix: "yuv420p", W: 1920, H: 1080 }, 1800)).toBeLessThan(300);
    expect(C.diskFreeMB(tmpdir())).toBeGreaterThan(0);
    expect(C.diskFreeMB("/no/such/folder")).toBe(Infinity);
  });
  it("heading turns the short way across the wrap", () => {
    const a = views([[1, 1000, 1000, 50]]), b = views([[1, 1010, 1000, 50]]);
    a.heading[0] = (350 / 360) * 2 * Math.PI; b.heading[0] = (10 / 360) * 2 * Math.PI;
    const mid = C.interpolate(a, b, 0, 1, 0.5).heading[0], deg = (((mid * 180) / Math.PI) % 360 + 360) % 360;
    expect(Math.min(deg, 360 - deg)).toBeLessThan(0.01); // through 0, not through 180
    b.heading[0] = (200 / 360) * 2 * Math.PI; // 210 degrees one way is 150 the other
    const m2 = (((C.interpolate(a, b, 0, 1, 0.5).heading[0] * 180) / Math.PI) % 360 + 360) % 360;
    expect(m2).toBeCloseTo(275, 3);
  });
});
