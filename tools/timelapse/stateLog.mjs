// State log of a Live world: what the light client receives (creature frames, the item set, deaths, lineages), compact and append-only, so a renderer can redraw the map later at any size.
// Format: README.md "State log". Plain node, no dependencies. The writer runs in the capture (every byte from the server is hostile), the reader on the host (the folder is hostile there).
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, statfsSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export const FORMAT = 1;
export const PROTOCOL = 6; // the Live protocol (protocol.ts PROTOCOL_VERSION) whose frames this format stores; a server with another version is not recorded
export const MAGIC = Buffer.from("EVOSTATE"); // the first 8 bytes of every file
export const SYNC = Buffer.from([0xa5, 0x5e, 0x7a, 0x1e]); // starts every record, so a reader finds the next record after a corrupt or torn one
export const REC_HEAD = 14; // sync | u32 body bytes | u8 type | u8 flags | u32 crc32 of type, flags and stored body
export const T = { HEADER: 1, CREATURES: 2, BURST: 3, ITEMS_KEY: 4, ITEMS_DIFF: 5, DEATHS: 6, LINEAGES: 7 };
const DEFLATE = 1; // flags bit 0: the body is raw deflate
export const MAX_BODY = 4 << 20; // stored and inflated body bytes (the largest real one, a full item set of 2^18 slots, is 1.1 MB)
export const CREATURE_RECORD = 19;
export const MAX_CREATURES = 20_000; // per frame, protocol.ts MAX_FRAME_CREATURES (the server caps at 12000)
export const MAX_ITEM_SLOTS = 1 << 18; // protocol.ts MAX_ITEM_SLOTS
const MAX_DELTAS = 64, MAX_DELTA_OPS = 4096, MAX_DELTA_EVENTS = 32; // protocol.ts, per DELTA message and per server frame
export const NO_SEQ = 0xffffffff; // a creature record's item set is unknown, or a creature record has no base
// Sequence numbers start at a random u32 per session (so a record of another session never matches a base by chance) and go up by one per record written, wrapping and skipping NO_SEQ.
const nextSeq = (s) => { const n = (s + 1) >>> 0; return n === NO_SEQ ? 0 : n; };
const randomSeq = () => { const s = randomBytes(4).readUInt32LE(0); return s === NO_SEQ ? 0 : s; };
const U32 = 0xffffffff;
export const FILE_RE = /^state-(\d{5})\.evs$/;
const META = 52; // creature record: f64 wallMs | f64 simSeconds | u32 tick | u32 population | u32 itemSeq | f32 winterness | f32 yearMinutes | f32 winterFood | u32 count | u32 seq | u32 baseSeq
const KEY_HEAD = 24, DIFF_HEAD = 28, DEATH_HEAD = 20;

// ---- encoding
export function encodeRecord(type, raw, deflate = true) {
  const body = deflate ? deflateRawSync(raw) : raw;
  const out = Buffer.allocUnsafe(REC_HEAD + body.length);
  SYNC.copy(out, 0); out.writeUInt32LE(body.length, 4); out[8] = type; out[9] = deflate ? DEFLATE : 0;
  body.copy(out, REC_HEAD);
  out.writeUInt32LE(crc32(body, crc32(out.subarray(8, 10))), 10);
  return out;
}
// The creature count of a CREATURES wire message, or -1 unless its length is exactly 9 + 19 x count with count at most MAX_CREATURES.
export function creatureCount(buf) {
  if (buf.length < 9 || buf[0] !== 1) return -1;
  const c = buf.readUInt32LE(5);
  return c <= MAX_CREATURES && buf.length === 9 + c * CREATURE_RECORD ? c : -1;
}
// Creatures are stored sorted by id, as byte planes (byte j of every record together), with the id as the gap to the one before and, for an id the base record has,
// every other field as the zigzag difference to it (founder as u32 difference). Measured on a 3,000-creature world: 12.9 bytes a creature as plain planes, 11.0 sorted with id gaps, 8.1 against a record 5 s older.
const zz = (d, bits) => { const h = 1 << (bits - 1), e = ((d + h) & (2 * h - 1)) - h; return ((e << 1) ^ (e >> 31)) & (2 * h - 1); };
const unzz = (z, prev, bits) => (prev + ((z >>> 1) ^ -(z & 1))) & ((1 << bits) - 1);
const FIELDS = [[4, 16], [6, 16], [8, 16], [10, 8], [11, 8], [12, 8], [13, 16]]; // offset and bits of x, y, heading, radius, energy, age, hue; founder (15) is a u32 difference
const rd = (b, o, bits) => (bits === 16 ? b[o] | (b[o + 1] << 8) : b[o]);
// Encodes `sorted` (n records of 19 bytes, ascending id) against `base` (its ids and records, or null) into planes at out[at..].
function encodeCreatures(sorted, n, base, out, at) {
  let prevId = 0, a = 0;
  for (let k = 0; k < n; k++) {
    const o = 19 * k, id = sorted.readUInt32LE(o), put = (j, v) => { out[at + j * n + k] = v; };
    const g = (id - prevId) >>> 0; prevId = id;
    put(0, g & 255); put(1, (g >>> 8) & 255); put(2, (g >>> 16) & 255); put(3, g >>> 24);
    if (base) while (a < base.n && base.ids[a] < id) a++;
    const po = base && a < base.n && base.ids[a] === id ? 19 * a : -1;
    for (const [f, bits] of FIELDS) { const v = rd(sorted, o + f, bits), z = po < 0 ? v : zz(v - rd(base.recs, po + f, bits), bits); put(f, z & 255); if (bits === 16) put(f + 1, z >>> 8); }
    const fo = po < 0 ? sorted.readUInt32LE(o + 15) : (sorted.readUInt32LE(o + 15) - base.recs.readUInt32LE(po + 15)) >>> 0;
    put(15, fo & 255); put(16, (fo >>> 8) & 255); put(17, (fo >>> 16) & 255); put(18, fo >>> 24);
  }
}
function decodeCreatures(planes, at, n, base) {
  const out = Buffer.allocUnsafe(19 * n), ids = new Uint32Array(n), get = (j, k) => planes[at + j * n + k];
  let prevId = 0, a = 0;
  for (let k = 0; k < n; k++) {
    const o = 19 * k, id = (prevId + (get(0, k) | (get(1, k) << 8) | (get(2, k) << 16) | (get(3, k) << 24))) >>> 0; prevId = id;
    out.writeUInt32LE(id, o); ids[k] = id;
    if (base) while (a < base.n && base.ids[a] < id) a++;
    const po = base && a < base.n && base.ids[a] === id ? 19 * a : -1;
    for (const [f, bits] of FIELDS) { const z = bits === 16 ? get(f, k) | (get(f + 1, k) << 8) : get(f, k), v = po < 0 ? z : unzz(z, rd(base.recs, po + f, bits), bits); out[o + f] = v & 255; if (bits === 16) out[o + f + 1] = v >>> 8; }
    const fo = (get(15, k) | (get(16, k) << 8) | (get(17, k) << 16) | (get(18, k) << 24)) >>> 0;
    out.writeUInt32LE(po < 0 ? fo : (fo + base.recs.readUInt32LE(po + 15)) >>> 0, o + 15);
  }
  return { n, ids, recs: out };
}
// The records of a CREATURES message sorted by id (a stable order, so writer and reader walk the same base), with their ids.
function sortCreatures(src, n) {
  const key = new Float64Array(n);
  for (let i = 0; i < n; i++) key[i] = src.readUInt32LE(19 * i) * 32768 + i; // n <= MAX_CREATURES < 32768
  key.sort();
  const recs = Buffer.allocUnsafe(19 * n), ids = new Uint32Array(n);
  for (let k = 0; k < n; k++) { const i = key[k] % 32768; src.copy(recs, 19 * k, 19 * i, 19 * i + 19); ids[k] = recs.readUInt32LE(19 * k); }
  return { n, ids, recs };
}

// ---- the item set the light client tracks: a full ITEMS set, then DELTA ops applied in order. Bounded: at most MAX_ITEM_SLOTS slots, 5 bytes each, twice (the copy is the state last written).
export class ItemTracker {
  constructor(maxDeaths = 4096) {
    this.valid = false; this.slots = 0; this.tick = 0; this.error = ""; this.invalidSince = Date.now();
    this.maxDeaths = maxDeaths; this.dTick = new Uint32Array(maxDeaths); this.dXyh = new Uint16Array(3 * maxDeaths); this.nDeaths = 0; this.dropped = 0;
  }
  reset() { this.invalid(); this.clearDeaths(); } // a new hello (a reconnect or a new world): the server sends a full set again, and deaths kept so far may be another world's
  clearDeaths() { this.nDeaths = 0; this.dropped = 0; }
  invalid() { if (this.valid || !this.invalidSince) this.invalidSince = Date.now(); this.valid = false; }
  bad(why) { this.invalid(); this.error = why; return false; }
  full(buf) { // an ITEMS message: u8 type | u32 tick | u32 slots | u32 n | ceil(slots / 4) bytes of 2-bit kinds | n x (u16 x, u16 y)
    if (buf.length < 13) return this.bad("short items");
    const slots = buf.readUInt32LE(5), n = buf.readUInt32LE(9), base = 13 + Math.ceil(slots / 4);
    if (slots > MAX_ITEM_SLOTS || n > slots || buf.length !== base + 4 * n) return this.bad("bad items size");
    if (this.slots !== slots || !this.kinds) { this.kinds = new Uint8Array(slots); this.x = new Uint16Array(slots); this.y = new Uint16Array(slots); this.rk = new Uint8Array(slots); this.rx = new Uint16Array(slots); this.ry = new Uint16Array(slots); this.slots = slots; }
    let p = base, seen = 0;
    for (let i = 0; i < slots; i++) {
      const k = (buf[13 + (i >> 2)] >> ((i & 3) * 2)) & 3;
      this.kinds[i] = k;
      if (!k) continue;
      if (k === 3 || ++seen > n) return this.bad("bad items kinds");
      this.x[i] = buf.readUInt16LE(p); this.y[i] = buf.readUInt16LE(p + 2); p += 4;
    }
    if (seen !== n) return this.bad("bad items count");
    this.tick = buf.readUInt32LE(1); this.valid = true; this.needKey = true; this.invalidSince = 0;
    return true;
  }
  // A DELTA message: u8 type | u8 n | n x (u32 tick | u16 ops | u8 events | ops | events). Ops change the set (only while it is valid), death events are kept for the next record.
  // A malformed message invalidates the set until the next full one (its ops may be half applied).
  delta(buf) {
    if (buf.length < 2 || buf[1] > MAX_DELTAS) return this.bad("bad delta head");
    const n = buf[1], len = buf.length;
    let p = 2;
    for (let d = 0; d < n; d++) {
      if (p + 7 > len) return this.bad("truncated delta");
      const tick = buf.readUInt32LE(p), nOps = buf.readUInt16LE(p + 4), nEv = buf[p + 6];
      if (nOps > MAX_DELTA_OPS || nEv > MAX_DELTA_EVENTS) return this.bad("delta too big");
      p += 7;
      for (let i = 0; i < nOps; i++) {
        if (p + 4 > len) return this.bad("truncated delta");
        const w = buf.readUInt32LE(p), slot = w & (MAX_ITEM_SLOTS - 1), kind = (w >>> 18) & 3; p += 4;
        if (kind === 3) return this.bad("bad delta op");
        if (kind) { if (p + 4 > len) return this.bad("truncated delta"); }
        if (this.valid) {
          if (slot >= this.slots) return this.bad("delta slot out of range");
          this.kinds[slot] = kind;
          if (kind) { this.x[slot] = buf.readUInt16LE(p); this.y[slot] = buf.readUInt16LE(p + 2); }
        }
        if (kind) p += 4;
      }
      if (p + 7 * nEv > len) return this.bad("truncated delta");
      for (let i = 0; i < nEv; i++, p += 7) {
        if (buf[p] !== 1) continue; // 0 impact, 1 death
        if (this.nDeaths >= this.maxDeaths) { if (this.dropped < U32) this.dropped++; continue; }
        const k = this.nDeaths++;
        this.dTick[k] = tick; this.dXyh[3 * k] = buf.readUInt16LE(p + 1); this.dXyh[3 * k + 1] = buf.readUInt16LE(p + 3); this.dXyh[3 * k + 2] = buf.readUInt16LE(p + 5);
      }
    }
    if (p !== len) return this.bad("bad delta size");
    return true;
  }
}

// ---- the writer: appends records to <dir>/state-NNNNN.evs, a new file past fileBytes, nothing past capBytes or while the disk has less than freeFloorBytes free.
// One write() per record on an O_APPEND file, so a crash leaves at most one torn record at the end, which the reader skips.
export class StateWriter {
  constructor(dir, { capBytes, fileBytes, freeFloorBytes, header }) {
    Object.assign(this, { dir, capBytes, fileBytes, freeFloorBytes });
    this.session = randomBytes(6).toString("hex");
    let bytes = 0, last = -1, lastSize = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) { // resume: the bytes already there count against the cap, and appends go on in the newest file
      const m = FILE_RE.exec(e.name); if (!m || !e.isFile()) continue;
      const s = lstatSync(join(dir, e.name)).size; bytes += s;
      if (+m[1] > last) { last = +m[1]; lastSize = s; }
    }
    this.bytes = bytes; this.resumed = last >= 0; this.index = Math.max(0, last); this.fileSize = lastSize;
    this.header = { format: FORMAT, protocol: PROTOCOL, creatureRecord: CREATURE_RECORD, ...header, session: this.session };
    this.fd = null; this.state = "writing"; this.records = 0; this.lastAt = 0; this.freeAt = 0; this.freeOk = true; this.error = ""; this.headers = 0;
  }
  // (Re)opens the current file, or the next one when the record would not fit; every open writes a header record (the first of a session says whether it resumed a log).
  open(recLen) {
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
    if (this.fileSize > 0 && this.fileSize + recLen + 4096 > this.fileBytes) { this.index++; this.fileSize = 0; }
    if (this.index > 99999) throw new Error("too many state files");
    this.fd = openSync(join(this.dir, `state-${String(this.index).padStart(5, "0")}.evs`), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644); // a planted FIFO fails (ENXIO) instead of blocking
    const st = fstatSync(this.fd);
    if (!st.isFile()) { closeSync(this.fd); this.fd = null; throw new Error("not a regular file"); }
    this.fileSize = st.size;
    const head = encodeRecord(T.HEADER, Buffer.from(JSON.stringify({ ...this.header, resumed: this.headers++ === 0 && this.resumed, part: this.index, openedAt: new Date().toISOString() })), false);
    this.put(this.fileSize ? head : Buffer.concat([MAGIC, head]));
  }
  put(b) { for (let o = 0; o < b.length; ) o += writeSync(this.fd, b, o, b.length - o); this.fileSize += b.length; this.bytes += b.length; }
  // false when nothing was written (capped, disk floor, an error): the caller then writes the next item record as a full set
  write(type, raw, deflate = true) {
    if (this.state === "capped") return false;
    const t = Date.now();
    if (t - this.freeAt >= 5000) { this.freeAt = t; try { const f = statfsSync(this.dir); this.freeOk = f.bavail * f.bsize >= this.freeFloorBytes; } catch { this.freeOk = false; } }
    if (!this.freeOk) { this.state = "disk-floor"; return false; }
    const rec = encodeRecord(type, raw, deflate);
    if (this.bytes + rec.length + 4096 > this.capBytes) { this.state = "capped"; this.close(); return false; } // 4096: room for a roll-over's header
    try {
      if (this.fd === null || this.fileSize + rec.length > this.fileBytes) this.open(rec.length);
      this.put(rec);
    } catch (err) { this.state = "error"; this.error = String(err?.message ?? err).slice(0, 100); this.close(); return false; }
    this.records++; this.lastAt = t; this.state = "writing";
    return true;
  }
  close() { if (this.fd !== null) { try { closeSync(this.fd); } catch {} this.fd = null; } }
}

// ---- the recorder: picks the frames to keep and writes them with the item set, deaths and lineages that go with them
export class StateRecorder {
  constructor(writer, items, { every = 5, itemsEvery = 30, burstEvery = 0, burstSeconds = 0, keyEvery = 600, resetTickDrop = 100 } = {}) {
    Object.assign(this, { writer, items, every, itemsEvery, burstEvery, burstSeconds, keyEvery, resetTickDrop });
    this.slot = -1; this.bslot = -1; this.islot = -1; this.lastTick = -1; this.seq = randomSeq(); this.lastKeyAt = -Infinity; this.lineSig = "";
    this.cSeq = randomSeq(); this.cBase = null; this.cKeyAt = -Infinity; // the last creature record written (sorted), the base of the next one
    this.startedAt = Date.now(); this.paused = ""; this.error = "";
    items.clearDeaths(); // deaths kept before this world folder are not its own
  }
  // A CREATURES wire message at wall time wallMs, with what the stats say: { simSeconds, population, season: { yearMinutes, winterFood } | null }.
  // Returns the record type written, 0 for none, -1 for a refused frame, -2 when writing it threw (logged by the caller; the next slot tries again with full records).
  creatures(buf, wallMs, info) {
    try { return this.record(buf, wallMs, info); } catch (err) { this.error = String(err?.message ?? err).slice(0, 100); this.cBase = null; this.items.needKey = true; return -2; }
  }
  record(buf, wallMs, info) {
    const count = creatureCount(buf);
    if (count < 0) return -1;
    const tick = buf.readUInt32LE(1);
    if (this.lastTick >= 0 && tick + this.resetTickDrop < this.lastTick) return 0; // a reset: the next world folder records it
    let type = 0;
    const s = this.every > 0 ? Math.floor(wallMs / (this.every * 1000)) : -1, b = Math.floor(wallMs / 1000);
    if (this.every > 0 && s !== this.slot) type = T.CREATURES;
    else if (this.burstEvery > 0 && wallMs % (this.burstEvery * 1000) < this.burstSeconds * 1000 && b !== this.bslot) type = T.BURST;
    if (!type) return 0;
    this.slot = s; this.bslot = b; this.lastTick = tick;
    if (info.lineages) this.lineages(wallMs, tick, info.lineages);
    const is = Math.floor(wallMs / (Math.max(this.itemsEvery, 0.001) * 1000)), itemsDue = is !== this.islot || this.items.needKey;
    if (itemsDue) this.islot = is;
    const itemSeq = !this.items.valid ? NO_SEQ : itemsDue ? this.itemsRecord(wallMs, tick) : this.seq; // items change more slowly: a record every itemsEvery s, the set as of then in between
    this.deathsRecord(wallMs, tick);
    const raw = Buffer.alloc(META + count * CREATURE_RECORD);
    const sorted = sortCreatures(buf.subarray(9), count), base = wallMs - this.cKeyAt < this.keyEvery * 1000 ? this.cBase : null; // a full record every keyEvery s
    const season = info.season, year = season ? season.yearMinutes * 60 : 0;
    const winter = year > 0 ? (1 - Math.cos((2 * Math.PI * info.simSeconds) / year)) / 2 : -1; // sim/ecoConfig.ts winterness; the page uses tick x dt, the same as simSeconds to the second
    raw.writeDoubleLE(wallMs, 0); raw.writeDoubleLE(info.simSeconds, 8); raw.writeUInt32LE(tick, 16); raw.writeUInt32LE(clampU32(info.population), 20); raw.writeUInt32LE(itemSeq, 24);
    raw.writeFloatLE(winter, 28); raw.writeFloatLE(season ? season.yearMinutes : 0, 32); raw.writeFloatLE(season ? season.winterFood : 0, 36); raw.writeUInt32LE(count, 40);
    raw.writeUInt32LE(nextSeq(this.cSeq), 44); raw.writeUInt32LE(base ? this.cSeq : NO_SEQ, 48);
    encodeCreatures(sorted.recs, count, base, raw, META);
    if (!this.writer.write(type, raw)) { this.cBase = null; return 0; }
    this.cSeq = nextSeq(this.cSeq); this.cBase = sorted; if (!base) this.cKeyAt = wallMs;
    return type;
  }
  // The item set at this record: a full set (first, after a gap in the chain, every keyEvery s), else the slots changed since the last items record. Returns its sequence number, NO_SEQ while unknown.
  itemsRecord(wallMs, tick) {
    const it = this.items;
    if (!it.valid) return NO_SEQ;
    const { slots, kinds, x, y, rk, rx, ry } = it;
    let n = 0, m = 0, live = 0;
    for (let i = 0; i < slots; i++) { if (kinds[i]) live++; if (kinds[i] !== rk[i] || (kinds[i] && (x[i] !== rx[i] || y[i] !== ry[i]))) { n++; if (kinds[i]) m++; } }
    if (it.needKey || wallMs - this.lastKeyAt >= this.keyEvery * 1000 || (n && 4 * (n + m) >= Math.ceil(slots / 4) + 4 * live)) { // a full set also when the changes would be larger
      n = live;
      const raw = Buffer.alloc(KEY_HEAD + Math.ceil(slots / 4) + 4 * n), bits = KEY_HEAD, px = bits + Math.ceil(slots / 4), py = px + 2 * n;
      raw.writeDoubleLE(wallMs, 0); raw.writeUInt32LE(tick, 8); raw.writeUInt32LE(nextSeq(this.seq), 12); raw.writeUInt32LE(slots, 16); raw.writeUInt32LE(n, 20);
      for (let i = 0, j = 0; i < slots; i++) {
        const k = kinds[i]; rk[i] = k;
        if (!k) continue;
        raw[bits + (i >> 2)] |= k << ((i & 3) * 2); raw.writeUInt16LE(x[i], px + 2 * j); raw.writeUInt16LE(y[i], py + 2 * j); rx[i] = x[i]; ry[i] = y[i]; j++;
      }
      if (!this.writer.write(T.ITEMS_KEY, raw)) { it.needKey = true; return NO_SEQ; }
      it.needKey = false; this.lastKeyAt = wallMs;
      return (this.seq = nextSeq(this.seq));
    }
    if (!n) return this.seq;
    const raw = Buffer.alloc(DIFF_HEAD + 4 * n + 4 * m), px = DIFF_HEAD + 4 * n, py = px + 2 * m;
    raw.writeDoubleLE(wallMs, 0); raw.writeUInt32LE(tick, 8); raw.writeUInt32LE(nextSeq(this.seq), 12); raw.writeUInt32LE(this.seq, 16); raw.writeUInt32LE(n, 20); raw.writeUInt32LE(m, 24);
    for (let i = 0, a = 0, b = 0, prev = 0; i < slots; i++) {
      const k = kinds[i];
      if (k === rk[i] && (!k || (x[i] === rx[i] && y[i] === ry[i]))) continue;
      const w = ((i - prev) | (k << 18)) >>> 0; prev = i; rk[i] = k; // the slot as the gap to the one before, in 4 byte planes
      for (let q = 0; q < 4; q++) raw[DIFF_HEAD + q * n + a] = (w >>> (8 * q)) & 255;
      a++;
      if (k) { raw.writeUInt16LE(x[i], px + 2 * b); raw.writeUInt16LE(y[i], py + 2 * b); rx[i] = x[i]; ry[i] = y[i]; b++; }
    }
    if (!this.writer.write(T.ITEMS_DIFF, raw)) { it.needKey = true; return NO_SEQ; }
    return (this.seq = nextSeq(this.seq));
  }
  // Deaths since the last record, 0 to 65535 ticks before this one; others (another world's, or kept while nothing was recorded) are counted as dropped.
  deathsRecord(wallMs, tick) {
    const it = this.items, back = (k) => tick - it.dTick[k], fits = (k) => back(k) >= 0 && back(k) <= 65535;
    let n = 0;
    for (let k = 0; k < it.nDeaths; k++) if (fits(k)) n++;
    const dropped = Math.min(U32, it.dropped + it.nDeaths - n);
    if (!n && !dropped) return;
    const raw = Buffer.alloc(DEATH_HEAD + 8 * n);
    raw.writeDoubleLE(wallMs, 0); raw.writeUInt32LE(tick, 8); raw.writeUInt32LE(n, 12); raw.writeUInt32LE(dropped, 16);
    for (let k = 0, j = 0; k < it.nDeaths; k++) {
      if (!fits(k)) continue;
      raw.writeUInt16LE(back(k), DEATH_HEAD + 2 * j);
      for (let f = 0; f < 3; f++) raw.writeUInt16LE(it.dXyh[3 * k + f], DEATH_HEAD + 2 * (n * (f + 1) + j));
      j++;
    }
    it.clearDeaths();
    this.writer.write(T.DEATHS, raw);
  }
  // The lineage table when its make-up (not its counts) changes; lineages from cleaned stats: { founder, hue, starter, count, name, founders }. Names only for starters.
  lineages(wallMs, tick, lineages) {
    const rows = lineages.map((l) => ({ founder: l.founder, hue: l.hue, starter: l.starter, count: l.count, name: l.starter ? l.name : "", founders: l.founders ?? [] }));
    const sig = JSON.stringify(rows.map((r) => [r.founder, r.hue, r.starter, r.name, r.founders]));
    if (sig === this.lineSig) return false;
    if (!this.writer.write(T.LINEAGES, Buffer.from(JSON.stringify({ wallMs, tick, lineages: rows })))) return false;
    this.lineSig = sig;
    return true;
  }
  status() {
    const w = this.writer;
    const it = this.items;
    return { state: this.paused ? "paused" : w.state, error: this.paused || this.error || w.error, startedAt: new Date(this.startedAt).toISOString(), itemsValid: it.valid, itemsInvalidS: it.valid ? 0 : Math.round((Date.now() - it.invalidSince) / 1000), bytes: w.bytes, capBytes: w.capBytes, records: w.records, lastRecordAt: w.lastAt ? new Date(w.lastAt).toISOString() : null, file: w.index, every: this.every, itemsEvery: this.itemsEvery, burstEvery: this.burstEvery, burstSeconds: this.burstSeconds };
  }
}
const clampU32 = (v) => (Number.isFinite(v) ? Math.min(0xffffffff, Math.max(0, Math.round(v))) : 0);

// ---- the reader: every record of a world folder's state log, oldest file first. The folder is hostile: regular files only (no link followed, no FIFO blocks),
// bounded reads (a window of two records), every length checked before use, inflation capped. Yields { file, offset, type, ... } per record, and
// { file, offset, type: 0, bytes } for bytes skipped (a torn tail, a corrupt record, junk) up to the next record start.
export function* readStateLog(dir, { maxFiles = 100_000, maxFileBytes = 2 ** 32 } = {}) {
  let names = [];
  try { names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && FILE_RE.test(e.name)).map((e) => e.name).sort().slice(0, maxFiles); } catch {}
  const chain = new CreatureChain();
  for (const name of names) for (const r of readStateFile(join(dir, name), maxFileBytes)) yield chain.apply(r);
}
// Decodes creature records along their chain: `records` (count x 19 bytes in the wire layout, ascending id) or null when its base record was lost (until the next full one).
export class CreatureChain {
  constructor() { this.base = null; this.session = ""; }
  apply(r) {
    if (r.type === T.HEADER) { if (r.json.session !== this.session) { this.session = r.json.session; this.base = null; } }
    else if (r.type === T.CREATURES || r.type === T.BURST) {
      const full = r.baseSeq === NO_SEQ;
      if (!full && this.base?.seq !== r.baseSeq) { this.base = null; r.records = null; }
      else { const d = decodeCreatures(r.planes, META, r.count, full ? null : this.base); d.seq = r.seq; this.base = d; r.records = d.recs; }
      delete r.planes;
    }
    return r;
  }
}
export function* readStateFile(path, maxFileBytes = 2 ** 32) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return; }
  try {
    const st = fstatSync(fd), file = path.split("/").pop();
    if (!st.isFile() || st.size > maxFileBytes) { yield { file, offset: 0, type: 0, bytes: st.size }; return; }
    let size = st.size, crcBytes = 0; // size shrinks when a read comes back short (the file was cut meanwhile)
    const buf = Buffer.alloc(Math.min(size, 2 * (MAX_BODY + REC_HEAD))), crcBudget = 2 * size + 2 * MAX_BODY; // real records check about size bytes in all; a run of fake heads would cost size x MAX_BODY
    let start = 0, have = 0; // buf holds file bytes start .. start + have
    const ensure = (off, len) => { // bytes off .. off + len in buf, as far as the file has them
      if (off >= start && off + len <= start + have) return true;
      const want = Math.max(0, Math.min(buf.length, size - off));
      start = off; have = want ? readSync(fd, buf, 0, want, off) : 0;
      if (have < want) size = start + have;
      return len <= have;
    };
    const next = (from) => { // the offset of the next sync at or after from, or size
      for (let p = from; p < size; ) {
        ensure(p, Math.min(buf.length, size - p));
        const i = buf.subarray(0, have).indexOf(SYNC, p - start);
        if (i >= 0) return start + i;
        if (start + have >= size) return size;
        p = start + have - SYNC.length + 1;
      }
      return size;
    };
    let pos = 0;
    if (!ensure(0, MAGIC.length) || !buf.subarray(0, MAGIC.length).equals(MAGIC)) { const n = next(0); yield { file, offset: 0, type: 0, bytes: n }; pos = n; } else pos = MAGIC.length;
    while (pos < size) {
      let ok = ensure(pos, REC_HEAD) && buf.subarray(pos - start, pos - start + 4).equals(SYNC);
      let len = 0, type = 0, flags = 0;
      if (ok) { const o = pos - start; len = buf.readUInt32LE(o + 4); type = buf[o + 8]; flags = buf[o + 9]; ok = len <= MAX_BODY && pos + REC_HEAD + len <= size && ensure(pos, REC_HEAD + len); }
      let rec = null;
      if (ok) {
        const o = pos - start, body = buf.subarray(o + REC_HEAD, o + REC_HEAD + len);
        if ((crcBytes += len) > crcBudget) { yield { file, offset: pos, type: 0, bytes: size - pos, budget: true }; return; } // stop reading this file
        if (crc32(body, crc32(buf.subarray(o + 8, o + 10))) === buf.readUInt32LE(o + 10)) { try { rec = decodeRecord(type, flags, body); } catch { rec = null; } }
      }
      if (!rec) { const n = next(pos + 1); yield { file, offset: pos, type: 0, bytes: n - pos }; pos = n; continue; }
      yield { file, offset: pos, ...rec };
      pos += REC_HEAD + len;
    }
  } finally { try { closeSync(fd); } catch {} }
}
const need = (cond) => { if (!cond) throw new Error("bad record"); };
export function decodeRecord(type, flags, stored) {
  const b = flags & DEFLATE ? inflateRawSync(stored, { maxOutputLength: MAX_BODY }) : Buffer.from(stored); // a copy: the reader's window is reused
  if (type === T.HEADER || type === T.LINEAGES) {
    const j = JSON.parse(b.toString("utf8"));
    need(j && typeof j === "object" && !Array.isArray(j));
    return { type, json: j };
  }
  if (type === T.CREATURES || type === T.BURST) {
    need(b.length >= META);
    const count = b.readUInt32LE(40);
    need(count <= MAX_CREATURES && b.length === META + count * CREATURE_RECORD);
    return { type, wallMs: b.readDoubleLE(0), simSeconds: b.readDoubleLE(8), tick: b.readUInt32LE(16), population: b.readUInt32LE(20), itemSeq: b.readUInt32LE(24), winterness: b.readFloatLE(28), yearMinutes: b.readFloatLE(32), winterFood: b.readFloatLE(36), count, seq: b.readUInt32LE(44), baseSeq: b.readUInt32LE(48), planes: b };
  }
  if (type === T.ITEMS_KEY) {
    need(b.length >= KEY_HEAD);
    const slots = b.readUInt32LE(16), n = b.readUInt32LE(20), bits = Math.ceil(slots / 4);
    need(slots <= MAX_ITEM_SLOTS && n <= slots && b.length === KEY_HEAD + bits + 4 * n);
    const kinds = new Uint8Array(slots), x = new Uint16Array(slots), y = new Uint16Array(slots), px = KEY_HEAD + bits, py = px + 2 * n;
    let j = 0;
    for (let i = 0; i < slots; i++) {
      const k = (b[KEY_HEAD + (i >> 2)] >> ((i & 3) * 2)) & 3;
      if (!k) continue;
      need(k !== 3 && j < n);
      kinds[i] = k; x[i] = b.readUInt16LE(px + 2 * j); y[i] = b.readUInt16LE(py + 2 * j); j++;
    }
    need(j === n);
    return { type, wallMs: b.readDoubleLE(0), tick: b.readUInt32LE(8), seq: b.readUInt32LE(12), slots, n, kinds, x, y };
  }
  if (type === T.ITEMS_DIFF) {
    need(b.length >= DIFF_HEAD);
    const n = b.readUInt32LE(20), m = b.readUInt32LE(24);
    need(n <= MAX_ITEM_SLOTS && m <= n && b.length === DIFF_HEAD + 4 * n + 4 * m);
    const slot = new Uint32Array(n), kind = new Uint8Array(n), x = new Uint16Array(n), y = new Uint16Array(n), px = DIFF_HEAD + 4 * n, py = px + 2 * m;
    let j = 0, prev = 0;
    for (let i = 0; i < n; i++) {
      const w = (b[DIFF_HEAD + i] | (b[DIFF_HEAD + n + i] << 8) | (b[DIFF_HEAD + 2 * n + i] << 16) | (b[DIFF_HEAD + 3 * n + i] << 24)) >>> 0, k = (w >>> 18) & 3, s = prev + (w & (MAX_ITEM_SLOTS - 1));
      need(w >>> 20 === 0 && k !== 3 && s < MAX_ITEM_SLOTS && (i === 0 || s > prev));
      slot[i] = s; kind[i] = k; prev = s;
      if (k) { need(j < m); x[i] = b.readUInt16LE(px + 2 * j); y[i] = b.readUInt16LE(py + 2 * j); j++; }
    }
    need(j === m);
    return { type, wallMs: b.readDoubleLE(0), tick: b.readUInt32LE(8), seq: b.readUInt32LE(12), baseSeq: b.readUInt32LE(16), n, slot, kind, x, y };
  }
  if (type === T.DEATHS) {
    need(b.length >= DEATH_HEAD);
    const n = b.readUInt32LE(12);
    need(b.length === DEATH_HEAD + 8 * n);
    const col = (f) => { const a = new Uint16Array(n); for (let k = 0; k < n; k++) a[k] = b.readUInt16LE(DEATH_HEAD + 2 * (f * n + k)); return a; };
    return { type, wallMs: b.readDoubleLE(0), tick: b.readUInt32LE(8), n, dropped: b.readUInt32LE(16), back: col(0), x: col(1), y: col(2), hue: col(3) };
  }
  return { type, unknown: true, bytes: b.length }; // a later format's record: skip it
}

// The item set as a reader rebuilds it: a full set replaces it, a diff applies only on top of the set it was made from (baseSeq), and a header of another session clears it.
// Valid for a creature record when seq === its itemSeq.
export class ItemState {
  constructor() { this.seq = NO_SEQ; this.session = ""; this.slots = 0; }
  apply(r) {
    if (r.type === T.HEADER) { if (r.json.session !== this.session) { this.session = r.json.session; this.seq = NO_SEQ; } }
    else if (r.type === T.ITEMS_KEY) { this.kinds = r.kinds; this.x = r.x; this.y = r.y; this.slots = r.slots; this.seq = r.seq; }
    else if (r.type === T.ITEMS_DIFF) {
      if (this.seq === NO_SEQ || r.baseSeq !== this.seq) { this.seq = NO_SEQ; return; }
      for (let i = 0; i < r.n; i++) { const s = r.slot[i]; if (s >= this.slots) { this.seq = NO_SEQ; return; } this.kinds[s] = r.kind[i]; if (r.kind[i]) { this.x[s] = r.x[i]; this.y[s] = r.y[i]; } }
      this.seq = r.seq;
    }
  }
}

// check.mjs's verdict on a world folder's state log. sl: the cleaned stateLog of status.json (null: none, or a script without a state log);
// files: { count, newestMs } of the state files; nowMs. Returns { ok, reason }.
export function stateLogHealth(sl, files, nowMs) {
  if (!sl || !(sl.every > 0 || sl.burstEvery > 0)) return { ok: true, reason: "" };
  if (sl.state === "capped") return { ok: true, reason: "" };
  if (sl.opened === false) return { ok: false, reason: `state log not opened${sl.error ? ": " + sl.error : ""}` };
  if (sl.state === "disk-floor") return { ok: false, reason: "state log stopped: free disk under the floor" };
  if (sl.state === "paused") return { ok: false, reason: `state log paused${sl.error ? ": " + sl.error : ""}` };
  const maxAge = sl.every > 0 ? Math.max(30, 3 * sl.every) : sl.burstEvery + 90, age = files.count ? (nowMs - files.newestMs) / 1000 : null;
  if (age === null) { const since = (nowMs - Date.parse(sl.startedAt)) / 1000; if (!(since >= -60 && since < 60)) return { ok: false, reason: `no state log files (${sl.state})` }; } // a minute for the first record after the state log started
  else if (!(age >= -60 && age <= maxAge)) return { ok: false, reason: `state log newest write is ${Math.round(age)} s old (${sl.state}${sl.error ? ": " + sl.error : ""})` };
  if (sl.itemsValid === false && sl.itemsInvalidS > 90) return { ok: false, reason: `state log item set unknown for ${sl.itemsInvalidS} s` };
  return { ok: true, reason: "" };
}
