// The time-lapse state log (tools/timelapse/stateLog.mjs): writer and reader round trip, item tracking against the real wire encoders, and every bound.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FRAME_CREATURES, MAX_ITEM_SLOTS, PROTOCOL_VERSION, decodeItems, deltaMessage, encodeDeltaChunk, encodeItems, newCreatureFrame, putCreature, type ItemOp } from "../../src/typescript/src/live/protocol.ts";

const MOD: string = new URL("../../tools/timelapse/stateLog.mjs", import.meta.url).href;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const S: any = await import(MOD);
const WORLD = { width: 60000, height: 37500 };
const dirs: string[] = [];
const fresh = (): string => { const d = mkdtempSync(join(tmpdir(), "statelog-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let tick = 1000;
function frame(n: number, salt = 0): Buffer {
  const f = newCreatureFrame(tick, n);
  for (let i = 0; i < n; i++) putCreature(f, 9 + 19 * i, i * 3 + salt, (i * 977 + salt) & 65535, (i * 131) & 65535, i & 65535, 4, 200, i & 255, (i * 5) & 65535, 7 + (i % 3));
  return Buffer.from(f);
}
const INFO = { simSeconds: 100, population: 50, season: { yearMinutes: 40, winterFood: 0.3 }, lineages: [{ founder: 7, hue: 10, starter: true, count: 40, name: "grazer", founders: [7, 8] }, { founder: 9, hue: 50, starter: false, count: 10, name: "visitorname", founders: [] }] };
function rig(dir: string, opts: Record<string, number> = {}, w: Record<string, number> = {}) {
  const items = new S.ItemTracker(opts.maxDeaths ?? 4096);
  const writer = new S.StateWriter(dir, { capBytes: 1e9, fileBytes: 256e6, freeFloorBytes: 0, header: { world: WORLD }, ...w });
  return { items, writer, rec: new S.StateRecorder(writer, items, { every: 5, keyEvery: 600, ...opts }) };
}
const records = (dir: string) => [...S.readStateLog(dir)];

// A model item world driven through the real encoders: the server's side of ITEMS and DELTA.
class Model {
  slots: number; kinds: Uint8Array; xs: Float64Array; ys: Float64Array;
  constructor(slots: number, n: number) {
    this.slots = slots; this.kinds = new Uint8Array(slots); this.xs = new Float64Array(slots); this.ys = new Float64Array(slots);
    for (let i = 0; i < n; i++) this.place(i * 3 % slots, 1 + (i % 2));
  }
  place(s: number, k: number): void { this.kinds[s] = k; this.xs[s] = Math.random() * WORLD.width; this.ys[s] = Math.random() * WORLD.height; }
  full(): Buffer { return Buffer.from(encodeItems(tick, { xs: this.xs, ys: this.ys, kinds: this.kinds, slots: this.slots }, WORLD)); }
  step(nOps: number, deaths = 0): Buffer {
    const ops: ItemOp[] = [];
    for (let j = 0; j < nOps; j++) {
      const s = Math.floor(Math.random() * this.slots), k = Math.random() < 0.5 ? 0 : 1 + (j % 2);
      if (k) this.place(s, k); else this.kinds[s] = 0;
      ops.push({ slot: s, kind: k, x: this.xs[s]!, y: this.ys[s]!, tick });
    }
    const events = Array.from({ length: deaths }, (_, i) => ({ kind: 1, x: 100 * i, y: 50, value: 90 }));
    return Buffer.from(deltaMessage([encodeDeltaChunk(tick, ops, [...events, { kind: 0, x: 1, y: 2, value: 3 }], WORLD)!]));
  }
}
const sameItems = (full: Buffer, st: { kinds: Uint8Array; x: Uint16Array; y: Uint16Array }): boolean => {
  const truth = decodeItems(full, WORLD);
  for (let i = 0; i < truth.slots; i++) {
    if (truth.kinds[i] !== st.kinds[i]) return false;
    if (truth.kinds[i] && (Math.abs((st.x[i]! / 65535) * WORLD.width - truth.x[i]!) > 0.01 || Math.abs((st.y[i]! / 65535) * WORLD.height - truth.y[i]!) > 0.01)) return false;
  }
  return true;
};

describe("time-lapse state log", () => {
  it("keeps the constants of the wire it stores", () => {
    expect(S.PROTOCOL).toBe(PROTOCOL_VERSION);
    expect(S.MAX_ITEM_SLOTS).toBe(MAX_ITEM_SLOTS);
    expect(S.MAX_CREATURES).toBe(MAX_FRAME_CREATURES);
  });

  it("writes and reads back creatures, items, deaths and lineages, one creature record per slot", () => {
    const dir = fresh(), { items, writer, rec } = rig(dir, { keyEvery: 30, itemsEvery: 5 });
    const m = new Model(2000, 900);
    expect(items.full(m.full())).toBe(true);
    let t = 1_800_000_000_000;
    const kinds: Record<number, number> = {};
    let atLast = m.full();
    for (let k = 0; k < 600; k++, t += 200, tick += 6) { // 120 s at 5 Hz
      expect(items.delta(m.step(6, k % 50 === 0 ? 2 : 0))).toBe(true);
      const r = rec.creatures(frame(50, k), t, INFO);
      kinds[r] = (kinds[r] ?? 0) + 1;
      if (r === S.T.CREATURES) atLast = m.full();
    }
    expect(kinds[S.T.CREATURES]).toBe(24);
    expect(writer.state).toBe("writing");
    const st = new S.ItemState();
    const got: Record<number, number> = {};
    let last: any = null, deaths = 0, lineages: any = null;
    for (const r of records(dir)) {
      got[r.type] = (got[r.type] ?? 0) + 1;
      st.apply(r);
      if (r.type === S.T.CREATURES) { expect(r.itemSeq).toBe(st.seq); last = r; }
      if (r.type === S.T.DEATHS) deaths += r.n;
      if (r.type === S.T.LINEAGES) lineages = r.json;
    }
    expect(got[0]).toBeUndefined();
    expect(got[S.T.HEADER]).toBe(1);
    expect(got[S.T.ITEMS_KEY]).toBe(4); // keyEvery 30 s over 120 s
    expect(got[S.T.LINEAGES]).toBe(1); // only when the make-up changes
    expect(lineages.lineages.map((l: any) => l.name)).toEqual(["grazer", ""]); // a visitor's name is never written
    expect(deaths).toBeGreaterThan(0);
    expect(last.count).toBe(50);
    expect(last.winterness).toBeCloseTo((1 - Math.cos((2 * Math.PI * 100) / 2400)) / 2, 5);
    expect(sameItems(atLast, st)).toBe(true); // the item set as of the last record
  });

  it("refuses creature frames of the wrong length or over the creature cap", () => {
    const dir = fresh(), { rec, writer } = rig(dir);
    const ok = frame(10);
    expect(rec.creatures(Buffer.concat([ok, Buffer.alloc(1)]), 1e12, INFO)).toBe(-1);
    expect(rec.creatures(ok.subarray(0, ok.length - 1), 1e12, INFO)).toBe(-1);
    const big = Buffer.alloc(9 + 19 * (MAX_FRAME_CREATURES + 1)); big[0] = 1; big.writeUInt32LE(MAX_FRAME_CREATURES + 1, 5);
    expect(rec.creatures(big, 1e12, INFO)).toBe(-1);
    const huge = Buffer.alloc(9); huge[0] = 1; huge.writeUInt32LE(0xffffffff, 5);
    expect(rec.creatures(huge, 1e12, INFO)).toBe(-1);
    expect(writer.records).toBe(0);
    expect(rec.creatures(ok, 1e12, INFO)).toBe(S.T.CREATURES);
  });

  it("keeps bursts at 1 Hz inside their window and regular records outside it", () => {
    const dir = fresh(), { rec } = rig(dir, { every: 5, burstEvery: 60, burstSeconds: 10 });
    const n: Record<number, number> = {};
    for (let t = 60_000 * 1000; t < 60_000 * 1000 + 60_000; t += 200) { const r = rec.creatures(frame(5), t, INFO); n[r] = (n[r] ?? 0) + 1; }
    expect(n[S.T.CREATURES]).toBe(12);
    expect(n[S.T.BURST]).toBe(8); // 10 one-second slots, two of them taken by regular records
  });

  it("skips a torn tail and a corrupt record, and a restart appends with a header that says resumed", () => {
    const dir = fresh();
    let { items, rec } = rig(dir);
    const m = new Model(500, 200);
    items.full(m.full());
    for (let k = 0; k < 5; k++) rec.creatures(frame(20, k), 1e12 + k * 5000, INFO);
    const f = join(dir, "state-00000.evs"), recs = records(dir), creatures = recs.filter((r: any) => r.type === S.T.CREATURES);
    expect(creatures.length).toBe(5);
    const b = readFileSync(f);
    const mid = creatures[2], end = creatures[4];
    b[mid.offset + S.REC_HEAD + 5] ^= 0xff; // one flipped byte in the third creature record
    writeFileSync(f, b);
    truncateSync(f, end.offset + 30); // power loss in the middle of the last one
    ({ items, rec } = rig(dir));
    items.full(m.full());
    rec.creatures(frame(20, 9), 1e12 + 60_000, INFO);
    const again = records(dir);
    expect(again.filter((r: any) => r.type === 0).length).toBe(2);
    expect(again.filter((r: any) => r.type === S.T.CREATURES).map((r: any) => r.wallMs)).toEqual([1e12, 1e12 + 5000, 1e12 + 15000, 1e12 + 60_000]);
    const heads = again.filter((r: any) => r.type === S.T.HEADER).map((r: any) => r.json);
    expect(heads.map((h: any) => h.resumed)).toEqual([false, true]);
    expect(heads[0].session).not.toBe(heads[1].session);
    const st = new S.ItemState();
    for (const r of again) { st.apply(r); if (r.type === S.T.CREATURES && r.wallMs === 1e12 + 15000) expect(st.seq).not.toBe(r.itemSeq); } // items after a skipped record are unknown until a full set
    expect(st.seq).toBe(again.at(-1).itemSeq);
  });

  it("stops at its byte cap and rolls files over at their size", () => {
    const dir = fresh(), { rec, writer } = rig(dir, {}, { capBytes: 60_000, fileBytes: 20_000 });
    let written = 0;
    for (let k = 0; k < 100; k++) if (rec.creatures(frame(400, k), 1e12 + k * 5000, INFO) > 0) written++;
    expect(writer.state).toBe("capped");
    expect(written).toBeGreaterThan(2);
    expect(written).toBeLessThan(100);
    const files = readdirSync(dir).sort();
    let total = 0;
    for (const f of files) { const n = statSync(join(dir, f)).size; total += n; expect(n).toBeLessThanOrEqual(20_000); expect(readFileSync(join(dir, f)).subarray(0, 8).toString()).toBe("EVOSTATE"); }
    expect(files.length).toBeGreaterThan(1);
    expect(total).toBeLessThanOrEqual(60_000);
    expect(records(dir).filter((r: any) => r.type === S.T.CREATURES).length).toBe(written);
    const heads = records(dir).filter((r: any) => r.type === S.T.HEADER).map((r: any) => r.json);
    expect(heads.length).toBe(files.length);
    expect(heads.map((h: any) => h.part)).toEqual(files.map((_, i) => i));
    expect(new Set(heads.map((h: any) => h.session)).size).toBe(1);
  });

  it("writes nothing under the free-disk floor", () => {
    const dir = fresh(), { rec, writer } = rig(dir, {}, { freeFloorBytes: Number.MAX_VALUE });
    expect(rec.creatures(frame(10), 1e12, INFO)).toBe(0);
    expect(writer.state).toBe("disk-floor");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("tracks the item set from the real ITEMS and DELTA encoders, and refuses what breaks the bounds", () => {
    const items = new S.ItemTracker(8), m = new Model(4096, 1500);
    expect(items.full(m.full())).toBe(true);
    for (let k = 0; k < 200; k++) { tick += 6; expect(items.delta(m.step(20, 3))).toBe(true); }
    expect(sameItems(m.full(), items)).toBe(true);
    expect(items.nDeaths).toBe(8); // capped, the rest counted
    expect(items.dropped).toBe(200 * 3 - 8);
    const over = Buffer.alloc(13 + Math.ceil((MAX_ITEM_SLOTS + 1) / 4)); over[0] = 2; over.writeUInt32LE(MAX_ITEM_SLOTS + 1, 5); // a well-formed empty set, one slot too many
    expect(items.full(over)).toBe(false); // refused before anything is allocated
    expect(items.slots).toBe(4096);
    expect(items.full(m.full())).toBe(true);
    const out = Buffer.from(deltaMessage([encodeDeltaChunk(tick, [{ slot: 5000, kind: 1, x: 1, y: 1, tick }], [], WORLD)!]));
    expect(items.delta(out)).toBe(false); // a slot past the set
    expect(items.valid).toBe(false);
    expect(items.full(m.full())).toBe(true);
    const good = m.step(3);
    expect(items.delta(good.subarray(0, good.length - 2))).toBe(false); // truncated
    expect(items.delta(Buffer.from([5, 65]))).toBe(false); // over MAX_DELTAS
  });

  it("reads a hostile folder: no links, no FIFOs, no huge bodies, no inflation bombs", () => {
    const dir = fresh(), { rec } = rig(dir);
    rec.creatures(frame(10), 1e12, INFO);
    const outside = fresh();
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(join(outside, "secret"), join(dir, "state-00001.evs"));
    execFileSync("mkfifo", [join(dir, "state-00002.evs")]);
    const head = (len: number, type: number, flags: number) => { const h = Buffer.alloc(S.REC_HEAD); S.SYNC.copy(h, 0); h.writeUInt32LE(len, 4); h[8] = type; h[9] = flags; return h; };
    const bomb = S.encodeRecord(S.T.LINEAGES, Buffer.from(JSON.stringify({ pad: "x".repeat(S.MAX_BODY) }))); // valid JSON with a valid crc that inflates past MAX_BODY
    writeFileSync(join(dir, "state-00003.evs"), Buffer.concat([S.MAGIC, head(0xfffffff0, 2, 0), bomb, S.encodeRecord(S.T.LINEAGES, Buffer.from("{\"ok\":1}"), false)]));
    const got = records(dir);
    expect(got.filter((r: any) => r.type === S.T.CREATURES).length).toBe(1);
    expect(got.some((r: any) => r.file === "state-00001.evs" || r.file === "state-00002.evs")).toBe(false);
    expect(got.filter((r: any) => r.file === "state-00003.evs").map((r: any) => r.type)).toEqual([0, 0, S.T.LINEAGES]); // the huge length, then the bomb
    expect(bomb.length).toBeLessThan(S.MAX_BODY); // the bomb really fits the stored limit
  });
});
