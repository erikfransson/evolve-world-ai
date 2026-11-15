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
    for (const r of again) {
      st.apply(r);
      if (r.type !== S.T.CREATURES) continue;
      expect(st.seq).toBe(r.itemSeq); // the lost records held no item changes, so the set stays known
      expect(r.records === null).toBe(r.wallMs === 1e12 + 15000); // its base was the corrupt record; the restart begins with a full one
    }
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
    expect(got.filter((r: any) => r.file === "state-00003.evs").map((r: any) => r.type)).toEqual([0, S.T.LINEAGES]); // the huge length and the bomb, skipped as one run
    expect(bomb.length).toBeLessThan(S.MAX_BODY); // the bomb really fits the stored limit
  });
});

// ---- review round: fidelity, deaths, items, recovery, and the bounds that had no test
const sortedRecs = (f: Buffer): Buffer => { // the wire records of a frame as the log keeps them: by id, ties in frame order
  const n = f.readUInt32LE(5), idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => f.readUInt32LE(9 + 19 * a) - f.readUInt32LE(9 + 19 * b) || a - b);
  return Buffer.concat(idx.map((i) => f.subarray(9 + 19 * i, 28 + 19 * i)));
};
function rawFrame(t: number, recs: Buffer[]): Buffer {
  const head = Buffer.alloc(9); head[0] = 1; head.writeUInt32LE(t, 1); head.writeUInt32LE(recs.length, 5);
  return Buffer.concat([head, ...recs]);
}
const rec19 = (id: number, r: () => number): Buffer => { const b = Buffer.alloc(19); b.writeUInt32LE(id >>> 0, 0); for (let j = 4; j < 19; j++) b[j] = Math.floor(r() * 256); return b; };
function lcg(seed: number): () => number { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const deltaWith = (t: number, deaths: { tick: number; x: number; y: number; hue: number }[]): Buffer => { // DELTA chunks of no ops with death events, built by hand (exact u16 values)
  const parts: Buffer[] = [Buffer.from([5, deaths.length])];
  for (const d of deaths) { const c = Buffer.alloc(14); c.writeUInt32LE(d.tick, 0); c.writeUInt16LE(0, 4); c[6] = 1; c[7] = 1; c.writeUInt16LE(d.x, 8); c.writeUInt16LE(d.y, 10); c.writeUInt16LE(d.hue, 12); parts.push(c); }
  return Buffer.concat(parts);
};
const childOk = (code: string): boolean => { try { execFileSync(process.execPath, ["--input-type=module", "-e", code], { timeout: 10_000, stdio: "pipe" }); return true; } catch { return false; } };

describe("time-lapse state log, review round", () => {
  it("gives back every creature record byte for byte across births, deaths, odd ids, bursts, roll-over, a restart and a lost base", () => {
    const dir = fresh(), r = lcg(7);
    let { rec } = rig(dir, { every: 5, burstEvery: 60, burstSeconds: 20, keyEvery: 40 }, { fileBytes: 40_000 });
    let live: Buffer[] = Array.from({ length: 300 }, (_, i) => rec19(i * 7, r)), nextId = 4000;
    const wrote = new Map<number, Buffer>();
    let t = 60_000 * 1000;
    for (let k = 0; k < 900; k++, t += 200) { // 180 s at 5 Hz
      live = live.filter(() => r() > 0.01).map((b) => { const c = Buffer.from(b); if (r() < 0.5) c[4 + Math.floor(r() * 15)] = Math.floor(r() * 256); return c; });
      for (let j = 0; j < 3; j++) live.push(rec19(r() < 0.1 ? 0xfffffff0 + j : nextId++, r)); // ids near 2^32 too
      if (k % 50 === 7) live.push(Buffer.from(live[0]!)); // a duplicate id
      const order = [...live].sort(() => r() - 0.5), f = rawFrame(10_000 + k, k % 300 === 150 ? [] : order); // unsorted, and now and then empty
      if (k === 450) ({ rec } = rig(dir, { every: 5, burstEvery: 60, burstSeconds: 20, keyEvery: 40 }, { fileBytes: 40_000 })); // a restart mid-chain
      const ty = rec.creatures(f, t, INFO);
      if (ty > 0) wrote.set(t, sortedRecs(f));
    }
    expect(readdirSync(dir).length).toBeGreaterThan(3);
    let n = 0, burst = 0, nul = 0;
    const victim = records(dir).filter((x: any) => x.type === S.T.CREATURES && x.baseSeq !== S.NO_SEQ)[20]; // lose one creature record whose follower is a difference
    const f = join(dir, victim.file), b = readFileSync(f); b[victim.offset + S.REC_HEAD + 3] ^= 0x55; writeFileSync(f, b);
    let lost = false, afterFull = false;
    for (const x of records(dir)) {
      if (x.type !== S.T.CREATURES && x.type !== S.T.BURST) continue;
      if (x.wallMs === victim.wallMs) throw new Error("the corrupt record was read");
      if (x.records === null) { nul++; lost = true; expect(x.baseSeq).not.toBe(S.NO_SEQ); expect(afterFull).toBe(false); continue; }
      if (lost && x.baseSeq === S.NO_SEQ) afterFull = true; // recovery at the next full record
      expect(Buffer.compare(x.records, wrote.get(x.wallMs)!)).toBe(0);
      n++; if (x.type === S.T.BURST) burst++;
    }
    expect(nul).toBeGreaterThan(0);
    expect(afterFull).toBe(true);
    expect(burst).toBeGreaterThan(10);
    expect(n + nul + 1).toBe(wrote.size);
  });

  it("writes death records with the right content, drops deaths of another world or too old, and clamps the drop count", () => {
    const dir = fresh(), items = new S.ItemTracker();
    items.delta(deltaWith(500, [{ tick: 999_000, x: 1, y: 2, hue: 3 }])); // an old world's death, kept from before this folder
    const r2 = { items, rec: new S.StateRecorder(new S.StateWriter(dir, { capBytes: 1e9, fileBytes: 256e6, freeFloorBytes: 0, header: {} }), items, { every: 5 }) }; // a new recorder clears it
    const f0 = frame(5); f0.writeUInt32LE(50, 1);
    expect(r2.rec.creatures(f0, 1e12 - 5000, INFO)).toBe(S.T.CREATURES);
    expect(records(dir).filter((x: any) => x.type === S.T.DEATHS).length).toBe(0); // not even counted as dropped
    r2.items.delta(deltaWith(500, [{ tick: 999_000, x: 1, y: 2, hue: 3 }])); // another world's death, kept across a hello, then dropped by its tick
    r2.items.reset();
    r2.items.delta(deltaWith(500, [{ tick: 99_990, x: 100, y: 200, hue: 300 }, { tick: 100_000, x: 400, y: 500, hue: 600 }, { tick: 100_001, x: 7, y: 7, hue: 7 }]));
    r2.items.delta(deltaWith(500, [{ tick: 30_000, x: 9, y: 9, hue: 9 }]));
    const f = frame(5); f.writeUInt32LE(100_000, 1);
    expect(r2.rec.creatures(f, 1e12, INFO)).toBe(S.T.CREATURES);
    const d = records(dir).filter((x: any) => x.type === S.T.DEATHS);
    expect(d.length).toBe(1);
    expect([...d[0].back]).toEqual([10, 0]); expect([...d[0].x]).toEqual([100, 400]); expect([...d[0].y]).toEqual([200, 500]); expect([...d[0].hue]).toEqual([300, 600]);
    expect(d[0].dropped).toBe(3); // one after the record's tick, one more than 65535 ticks before, one of another world
    const d3 = fresh(), r3 = rig(d3), g3 = frame(5); g3.writeUInt32LE(100_000, 1);
    r3.items.delta(deltaWith(500, [{ tick: 99_995, x: 11, y: 12, hue: 13 }]));
    r3.items.reset(); // a reconnect to the same world keeps the deaths received before it
    r3.rec.creatures(g3, 1e12, INFO);
    expect([...records(d3).find((x: any) => x.type === S.T.DEATHS).back]).toEqual([5]);
    const t = new S.ItemTracker(1);
    t.dropped = 0xffffffff - 1;
    t.delta(deltaWith(500, [{ tick: 1, x: 0, y: 0, hue: 0 }, { tick: 1, x: 0, y: 0, hue: 0 }, { tick: 1, x: 0, y: 0, hue: 0 }, { tick: 1, x: 0, y: 0, hue: 0 }]));
    expect(t.dropped).toBe(0xffffffff);
    const dir2 = fresh(), w2 = new S.StateWriter(dir2, { capBytes: 1e9, fileBytes: 256e6, freeFloorBytes: 0, header: {} }), rec2 = new S.StateRecorder(w2, t, { every: 5 });
    t.nDeaths = 1; t.dropped = 0xffffffff; t.dTick[0] = 5; // one more drop past the clamp: a death after the record's tick
    const g = frame(5); g.writeUInt32LE(1, 1);
    expect(rec2.creatures(g, 1e12, INFO)).toBe(S.T.CREATURES);
    expect(records(dir2).find((x: any) => x.type === S.T.DEATHS).dropped).toBe(0xffffffff);
  });

  it("marks items unknown after a refused message and known again after a full set, and says so in its status", () => {
    const dir = fresh(), { items, rec } = rig(dir, { itemsEvery: 5 }), m = new Model(500, 100);
    items.full(m.full());
    rec.creatures(frame(5), 1e12, INFO);
    expect(items.delta(Buffer.from([5, 1, 0]))).toBe(false); // truncated
    expect(rec.status().itemsValid).toBe(false);
    rec.creatures(frame(5), 1e12 + 5000, INFO);
    items.full(m.full());
    expect(rec.status()).toMatchObject({ itemsValid: true, itemsInvalidS: 0 });
    rec.creatures(frame(5), 1e12 + 10_000, INFO);
    const st = new S.ItemState(), seqs: boolean[] = [];
    for (const x of records(dir)) { st.apply(x); if (x.type === S.T.CREATURES) seqs.push(x.itemSeq !== S.NO_SEQ && x.itemSeq === st.seq); }
    expect(seqs).toEqual([true, false, true]);
    expect(records(dir).filter((x: any) => x.type === S.T.ITEMS_KEY).length).toBe(2);
  });

  it("recovers from a failed write and from a throw inside a record", () => {
    const dir = fresh(), { rec, writer } = rig(dir, {}, { fileBytes: 3000 });
    expect(rec.creatures(frame(100, 1), 1e12, INFO)).toBe(S.T.CREATURES);
    execFileSync("chmod", ["a-w", dir]); // the roll-over to a new file fails
    try { for (let k = 1; writer.state !== "error" && k < 20; k++) rec.creatures(frame(100, k), 1e12 + k * 5000, INFO); } finally { execFileSync("chmod", ["u+w", dir]); }
    expect(writer.state).toBe("error");
    expect(rec.creatures(frame(100, 50), 1e12 + 500_000, INFO)).toBe(S.T.CREATURES);
    const c = records(dir).filter((x: any) => x.type === S.T.CREATURES);
    expect(c.at(-1).baseSeq).toBe(S.NO_SEQ); // a full record after the failure
    expect(c.every((x: any) => x.records !== null)).toBe(true);
    const real = writer.write.bind(writer);
    writer.write = () => { throw new Error("boom"); };
    expect(rec.creatures(frame(10), 1e12 + 600_000, INFO)).toBe(-2);
    expect(rec.status().error).toBe("boom");
    writer.write = real;
    expect(rec.creatures(frame(10), 1e12 + 605_000, INFO)).toBe(S.T.CREATURES);
    expect(rec.status().error).toBe(""); // cleared by the record written after it
    expect(Date.now() - Date.parse(rec.status().lastCreatureAt)).toBeLessThan(5000);
  });

  it("loses only the corrupt record: a flipped byte in a death record keeps the creature chain and the item set", () => {
    const dir = fresh(), { items, rec } = rig(dir, { itemsEvery: 5 }), m = new Model(500, 100);
    items.full(m.full());
    for (let k = 0; k < 6; k++) { tick += 10; items.delta(m.step(4, 1)); rec.creatures(frame(30, k), 1e12 + k * 5000, INFO); }
    const deaths = records(dir).filter((x: any) => x.type === S.T.DEATHS);
    const f = join(dir, "state-00000.evs"), b = readFileSync(f); b[deaths[2].offset + S.REC_HEAD + 2] ^= 1; writeFileSync(f, b);
    const st = new S.ItemState(), got = records(dir);
    expect(got.filter((x: any) => x.type === 0).length).toBe(1);
    for (const x of got) { st.apply(x); if (x.type === S.T.CREATURES) { expect(x.records).not.toBeNull(); expect(st.seq).toBe(x.itemSeq); } }
  });

  it("starts sequence numbers at a random value per session", () => {
    const firsts = [0, 1, 2].map(() => { const dir = fresh(), { rec } = rig(dir); rec.creatures(frame(3), 1e12, INFO); return records(dir).find((x: any) => x.type === S.T.CREATURES).seq; });
    expect(new Set(firsts).size).toBe(3);
  });

  it("stops checking a file of fake record heads after its CRC budget", () => {
    const dir = fresh(), unit = Buffer.concat([S.SYNC, Buffer.from([0, 0, 0x40, 0])]); // a head claiming MAX_BODY bytes, repeated
    writeFileSync(join(dir, "state-00000.evs"), Buffer.concat([S.MAGIC, Buffer.alloc(0), ...Array.from({ length: S.MAX_BODY / 8 + 2000 }, () => unit)]));
    const t0 = performance.now(), got = records(dir);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(got.at(-1)).toMatchObject({ type: 0, budget: true });
  });

  it("does not hang on a planted FIFO, nor on a file cut while it is read", () => {
    const dir = fresh();
    execFileSync("mkfifo", [join(dir, "state-00000.evs")]);
    expect(childOk(`const S = await import(${JSON.stringify(MOD)}); const w = new S.StateWriter(${JSON.stringify(dir)}, { capBytes: 1e9, fileBytes: 1e6, freeFloorBytes: 0, header: {} }); if (w.write(2, Buffer.alloc(10)) !== false || w.state !== "error") process.exit(1);`)).toBe(true);
    const d2 = fresh(), big = join(d2, "state-00000.evs"); // larger than the reader's window, then cut while it reads
    writeFileSync(big, Buffer.concat([S.MAGIC, S.encodeRecord(S.T.LINEAGES, Buffer.from("{}"), false), Buffer.alloc(9 << 20), S.encodeRecord(S.T.LINEAGES, Buffer.from("{}"), false)]));
    expect(childOk(`import { truncateSync } from "node:fs"; const S = await import(${JSON.stringify(MOD)}); const it = S.readStateFile(${JSON.stringify(big)}); it.next(); truncateSync(${JSON.stringify(big)}, 5000); let n = 0; for (const r of it) if (++n > 1e5) process.exit(1);`)).toBe(true);
  });

  it("refuses wire messages past each bound", () => {
    const t = new S.ItemTracker();
    const items = (slots: number, n: number, kinds: number[], extra = 0): Buffer => { const b = Buffer.alloc(13 + Math.ceil(slots / 4) + 4 * n + extra); b[0] = 2; b.writeUInt32LE(slots, 5); b.writeUInt32LE(n, 9); kinds.forEach((k, i) => { b[13 + (i >> 2)] |= k << ((i & 3) * 2); }); return b; };
    expect(t.full(items(4, 1, [1]))).toBe(true);
    expect(t.full(items(4, 5, [1, 1, 1, 1]))).toBe(false); // n > slots
    expect(t.full(items(4, 1, [3]))).toBe(false); // kind 3
    expect(t.full(items(4, 2, [1]))).toBe(false); // fewer kinds than n
    expect(t.full(items(4, 1, [1, 1]))).toBe(false); // more kinds than n
    t.full(items(4, 1, [1]));
    const head = (ops: number, evs: number): Buffer => { const b = Buffer.alloc(9); b[0] = 5; b[1] = 1; b.writeUInt16LE(ops, 6); b[8] = evs; return b; };
    expect(t.delta(head(0, 0))).toBe(true);
    expect(t.delta(Buffer.concat([head(4097, 0), Buffer.alloc(4 * 4097)]))).toBe(false); // MAX_DELTA_OPS
    expect(t.delta(Buffer.concat([head(0, 33), Buffer.alloc(7 * 33)]))).toBe(false); // MAX_DELTA_EVENTS
    t.full(items(4, 1, [1]));
    const op = Buffer.alloc(4); op.writeUInt32LE((1 | (3 << 18)) >>> 0, 0);
    expect(t.delta(Buffer.concat([head(1, 0), op, Buffer.alloc(4)]))).toBe(false); // kind 3, with room for a position
    t.full(items(4, 1, [1]));
    expect(t.delta(Buffer.concat([head(0, 0), Buffer.alloc(1)]))).toBe(false); // trailing bytes
  });

  it("keeps the writer to regular files, its file limit, its cap with resumed bytes, and the reset tick", () => {
    const outside = fresh(), target = join(outside, "x");
    writeFileSync(target, "keep");
    const d1 = fresh(); symlinkSync(target, join(d1, "state-00000.evs"));
    const w1 = new S.StateWriter(d1, { capBytes: 1e9, fileBytes: 1e6, freeFloorBytes: 0, header: {} });
    expect(w1.write(2, Buffer.alloc(10))).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("keep");
    const d2 = fresh(); writeFileSync(join(d2, "state-99999.evs"), Buffer.alloc(2000));
    const w2 = new S.StateWriter(d2, { capBytes: 1e9, fileBytes: 2000, freeFloorBytes: 0, header: {} });
    expect(w2.write(2, Buffer.alloc(10))).toBe(false);
    expect(w2.error).toMatch(/too many/);
    const d3 = fresh(); writeFileSync(join(d3, "state-00000.evs"), Buffer.alloc(50_000));
    const w3 = new S.StateWriter(d3, { capBytes: 54_000, fileBytes: 1e6, freeFloorBytes: 0, header: {} });
    expect(w3.write(2, Buffer.alloc(10))).toBe(false); // the 50 kB already there count
    expect(w3.state).toBe("capped");
    const d4 = fresh(), { rec } = rig(d4), f = frame(5);
    f.writeUInt32LE(5000, 1); expect(rec.creatures(f, 1e12, INFO)).toBe(S.T.CREATURES);
    f.writeUInt32LE(4800, 1); expect(rec.creatures(f, 1e12 + 5000, INFO)).toBe(0); // a reset's ticks wait for the new folder
  });

  it("skips records with a valid CRC but wrong lengths, and files over maxFileBytes", () => {
    const dir = fresh(), bad = (type: number, b: Buffer) => S.encodeRecord(type, b);
    const cre = Buffer.alloc(52 + 19); cre.writeUInt32LE(2, 40); // says 2 creatures, holds 1
    const key = Buffer.alloc(24 + 1 + 8); key.writeUInt32LE(4, 16); key.writeUInt32LE(1, 20); key[24] = 1; // says 1 item, holds room for 2
    const dif = Buffer.alloc(28 + 8); dif.writeUInt32LE(1, 20); // says 1 change, holds 2
    const dea = Buffer.alloc(20 + 16); dea.writeUInt32LE(1, 12); // says 1 death, holds 2
    const ok = S.encodeRecord(S.T.LINEAGES, Buffer.from("{}"), false);
    writeFileSync(join(dir, "state-00000.evs"), Buffer.concat([S.MAGIC, bad(S.T.CREATURES, cre), bad(S.T.ITEMS_KEY, key), bad(S.T.ITEMS_DIFF, dif), bad(S.T.DEATHS, dea), ok]));
    expect(records(dir).map((x: any) => x.type)).toEqual([0, S.T.LINEAGES]); // the four skipped as one run
    expect([...S.readStateLog(dir, { maxFileBytes: 100 })].map((x: any) => x.type)).toEqual([0]);
  });

  it("judges a state log for check.mjs", () => {
    const now = 1e12, sl = (o: Record<string, unknown>) => ({ state: "writing", error: "", opened: true, startedAt: new Date(now - 3600e3).toISOString(), every: 5, burstEvery: 1200, itemsValid: true, itemsInvalidS: 0, ...o });
    const h = (o: Record<string, unknown> | null, age: number | null) => S.stateLogHealth(o && sl({ lastCreatureAt: age === null ? null : new Date(now - age * 1000).toISOString(), ...o }), { count: 1 }, now).ok; // age: of the last creature record
    expect(h(null, null)).toBe(true); // a script without a state log
    expect(h({}, 3)).toBe(true);
    expect(h({}, 100)).toBe(false);
    expect(h({}, -120)).toBe(false); // a write from the future
    expect(h({ state: "capped" }, 1e6)).toBe(true);
    expect(h({ state: "disk-floor" }, 3)).toBe(false);
    expect(h({ state: "paused", error: "server protocol 7" }, 3)).toBe(false);
    expect(h({ state: "error", opened: false }, 3)).toBe(false);
    expect(h({ state: "error" }, 3)).toBe(true); // one failed write, written again since
    expect(h({ startedAt: new Date(now - 10e3).toISOString() }, null)).toBe(true); // started 10 s ago, first record not yet due
    expect(h({}, null)).toBe(false); // started an hour ago and no file
    expect(h({ itemsValid: false, itemsInvalidS: 30 }, 3)).toBe(true);
    expect(h({ itemsValid: false, itemsInvalidS: 120 }, 3)).toBe(false);
    expect(h({ every: 0, burstEvery: 0 }, null)).toBe(true); // switched off
    expect(S.stateLogHealth(sl({ lastCreatureAt: new Date(now - 300e3).toISOString() }), { count: 1, newestMs: now }, now).ok).toBe(false); // fresh files without creature records are not enough
  });
  it("reconnects for an item set only when it is due", () => {
    const now = 1e12, base = { on: true, open: true, valid: false, invalidSince: now - 120e3, lastResyncAt: now - 120e3, helloAt: now - 120e3, refused: false };
    const due = (o: Record<string, unknown>) => S.itemsResyncDue({ ...base, ...o }, now);
    expect(due({})).toBe(true); // no set for two minutes
    expect(due({ refused: true, invalidSince: now, helloAt: now - 1000 })).toBe(true); // a refusal reconnects at once
    expect(due({ valid: true })).toBe(false);
    expect(due({ on: false })).toBe(false); // state log off or paused for protocol
    expect(due({ on: false, refused: true })).toBe(false);
    expect(due({ open: false })).toBe(false);
    expect(due({ lastResyncAt: now - 30e3, refused: true })).toBe(false); // at most once a minute
    expect(due({ helloAt: now - 2000 })).toBe(false); // a fresh connection gets a minute for its first set
    expect(due({ invalidSince: now - 30e3 })).toBe(false);
  });

  it("reads a file of repeated record starts in about a second", () => {
    const dir = fresh();
    writeFileSync(join(dir, "state-00000.evs"), Buffer.concat([S.MAGIC, Buffer.alloc(12 << 20, S.SYNC)])); // every head's length is past MAX_BODY
    const t0 = performance.now(); // in a child with a time limit: the slow way takes hours and would block the test worker
    expect(childOk(`const S = await import(${JSON.stringify(MOD)}); const got = [...S.readStateLog(${JSON.stringify(dir)})]; if (got.length !== 1 || got[0].type !== 0) process.exit(1);`)).toBe(true); // one skipped run, not 3 million
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});
