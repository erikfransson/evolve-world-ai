// The non-browser half of the replay renderer (replay.mjs): times, record selection and gaps, creature views and their interpolation, the camera, items and sidecar counts.
// Plain node, no dependencies; unit tested in tests/typescript/timelapseReplay.test.ts.
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, statfsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

// ---- times: an ISO wall time ("2026-11-15T03:00Z") or simulated seconds, plain or with a unit (400000, 111h, 30m, 2d)
const UNIT = { s: 1, m: 60, h: 3600, d: 86400 };
export function parseTime(s) {
  if (s === undefined || s === null || s === "") return null;
  const str = String(s).trim(), m = /^(-?\d+(?:\.\d+)?)([smhd]?)$/.exec(str);
  if (m) return { kind: "sim", v: Number(m[1]) * UNIT[m[2] || "s"] };
  const w = Date.parse(str);
  if (/^\d{4}-\d\d-\d\dT/.test(str) && Number.isFinite(w)) return { kind: "wall", v: w };
  throw new Error(`not a time: ${str.slice(0, 40)} (ISO wall time or simulated seconds such as 400000, 111h)`);
}
export const timeOf = (r, kind) => (kind === "wall" ? r.wallMs : r.simSeconds);
export const inRange = (r, from, to) => (!from || timeOf(r, from.kind) >= from.v) && (!to || timeOf(r, to.kind) <= to.v);
// step=N: every Nth record; step=Xs (or m, h): one frame per X simulated seconds
export function parseStep(s) {
  const str = String(s ?? "1").trim();
  if (/^\d+$/.test(str) && +str >= 1) return { every: +str };
  const m = /^(\d+(?:\.\d+)?)([smh])$/.exec(str);
  if (m && +m[1] > 0) return { sim: Number(m[1]) * UNIT[m[2]] };
  throw new Error(`step must be a whole number of records or a simulated time such as 5s, 0.1s, 2m (got ${str.slice(0, 20)})`);
}

// ---- seasons, as sim/ecoConfig.ts and the recorder
const SEASONS = ["Summer", "Autumn", "Winter", "Spring"];
export function season(simSeconds, yearMinutes) {
  if (!(yearMinutes > 0)) return { year: null, season: "", winterness: -1 };
  const y = yearMinutes * 60, p = (((simSeconds / y) % 1) + 1) % 1;
  return { year: Math.floor(simSeconds / y), season: SEASONS[Math.floor(((p + 0.125) % 1) * 4)], winterness: (1 - Math.cos((2 * Math.PI * simSeconds) / y)) / 2 };
}

// ---- creature views: a record (count x 19 bytes, wire layout, ascending id) decoded as live/protocol.ts decodeCreatures does
const TAU = 2 * Math.PI;
export function decodeViews(recs, count, world) {
  const v = newViews(count);
  for (let i = 0, o = 0; i < count; i++, o += 19) {
    v.ids[i] = recs.readInt32LE(o); // i32 like the page's views
    v.x[i] = (recs.readUInt16LE(o + 4) / 65535) * world.width; v.y[i] = (recs.readUInt16LE(o + 6) / 65535) * world.height;
    v.heading[i] = (recs.readUInt16LE(o + 8) / 65535) * TAU; v.energy[i] = recs[o + 11] / 255; v.age[i] = recs[o + 12];
    v.hue[i] = (recs.readUInt16LE(o + 13) / 65535) * 360; v.founder[i] = recs.readInt32LE(o + 15);
  }
  return v;
}
export function newViews(n) { return { count: n, ids: new Int32Array(n), x: new Float32Array(n), y: new Float32Array(n), heading: new Float32Array(n), energy: new Float32Array(n), hue: new Float32Array(n), age: new Float32Array(n), founder: new Int32Array(n) }; }
// The packet the page reads (replay/main.ts viewsOf): u32 count, then the 8 arrays.
export function packViews(v) {
  const n = v.count, b = Buffer.alloc(4 + 32 * n);
  b.writeUInt32LE(n, 0);
  [v.ids, v.x, v.y, v.heading, v.energy, v.hue, v.age, v.founder].forEach((a, k) => Buffer.from(a.buffer, a.byteOffset, 4 * n).copy(b, 4 + 4 * n * k));
  return b;
}
const turn = (a, b) => ((((b - a) % TAU) + 3 * Math.PI) % TAU) - Math.PI; // live/scene.ts: the shortest signed turn
const copy = (o, k, v, i) => { o.ids[k] = v.ids[i]; o.x[k] = v.x[i]; o.y[k] = v.y[i]; o.heading[k] = v.heading[i]; o.energy[k] = v.energy[i]; o.hue[k] = v.hue[i]; o.age[k] = v.age[i]; o.founder[k] = v.founder[i]; };
// The creatures at time t between record A (time tA) and B (tB), by id, as live/scene.ts does between frames: one in both moves on the straight line
// (unless it moved faster than maxSpeed world units per simulated second, then it jumps at the midpoint); one only in B shows from its birth (tB - age, so never early)
// at its B place; one only in A goes to its death place and leaves at its death time when deaths (matchDeaths) know it, else stays at its A place until tB.
// Nothing moves across the map at a birth or death.
export function interpolate(A, B, tA, tB, t, maxSpeed = Infinity, deaths = null) {
  const a = tB > tA ? Math.min(1, Math.max(0, (t - tA) / (tB - tA))) : 1, far = maxSpeed * Math.max(0, tB - tA), o = newViews(A.count + B.count);
  let i = 0, j = 0, k = 0;
  const id = (v, n) => v.ids[n] >>> 0;
  while (i < A.count || j < B.count) {
    if (j >= B.count || (i < A.count && id(A, i) < id(B, j))) { // died (or left) before B
      const d = deaths?.get(id(A, i));
      if (d ? t < d.t : t < tB) { copy(o, k, A, i); if (d && d.t > tA) { const u = Math.max(0, (t - tA) / (d.t - tA)); o.x[k] = A.x[i] + (d.x - A.x[i]) * u; o.y[k] = A.y[i] + (d.y - A.y[i]) * u; } k++; }
      i++; continue;
    }
    if (i >= A.count || id(B, j) < id(A, i)) { if (B.age[j] >= 255 || t >= tB - B.age[j]) copy(o, k++, B, j); j++; continue; } // born after A
    const dx = B.x[j] - A.x[i], dy = B.y[j] - A.y[i];
    if (dx * dx + dy * dy > far * far) copy(o, k++, a < 0.5 ? A : B, a < 0.5 ? i : j);
    else {
      copy(o, k, a < 0.5 ? A : B, a < 0.5 ? i : j);
      o.x[k] = A.x[i] + dx * a; o.y[k] = A.y[i] + dy * a; o.heading[k] = A.heading[i] + turn(A.heading[i], B.heading[j]) * a; k++;
    }
    i++; j++;
  }
  o.count = k;
  return o;
}
// The death events between A and B ({ t, x, y, hue } in simulated seconds, world units and the wire's hue in degrees) matched to the creatures that are in A but not in B:
// the same hue, and no farther from its A place than maxSpeed allows (plus 50 units). Death events carry no id, so this is a best guess; unmatched ones keep the default.
// At most `budget` death events are looked at per record pair; the creatures left over keep the default (they stay put until tB).
export function matchDeaths(A, B, tA, tB, deaths, maxSpeed = 400, budget = 2_000_000) {
  const out = new Map();
  if (!deaths?.length) return out;
  const byHue = new Map(); // hue -> events in the time window, unused ones first
  for (const d of deaths) { if (d.t < tA - 1e-6 || d.t > tB + 1e-6) continue; let l = byHue.get(d.hue); if (!l) byHue.set(d.hue, (l = [])); l.push(d); }
  if (!byHue.size) return out;
  const used = new Set();
  for (let i = 0, j = 0; i < A.count && budget > 0; i++) {
    const id = A.ids[i] >>> 0;
    while (j < B.count && B.ids[j] >>> 0 < id) j++;
    if (j < B.count && B.ids[j] >>> 0 === id) continue;
    const l = byHue.get(A.hue[i]);
    if (!l) continue;
    let best = null, bd = Infinity;
    for (let e = 0; e < l.length && budget > 0; e++, budget--) {
      const d = l[e];
      if (used.has(d)) continue;
      const q = Math.hypot(d.x - A.x[i], d.y - A.y[i]);
      if (q <= maxSpeed * (d.t - tA) + 50 && q < bd) { bd = q; best = d; }
    }
    if (best) { used.add(best); out.set(id, best); }
  }
  return out;
}
// Per pixel average of n RGBA frames accumulated in a Uint16Array (blend=N): sum, then divide with rounding.
export function accumulate(sum, px) { for (let i = 0; i < px.length; i++) sum[i] += px[i]; }
export function average(sum, n, out) { const h = n >> 1; for (let i = 0; i < sum.length; i++) out[i] = (sum[i] + h) / n; return out; }

// ---- a pool record's times as the log gives them (hostile): wall time a finite ms count before year 275760 (Date's range), simulated seconds in 0 to 1e10.
export const MAX_SIM_SECONDS = 1e10;
export const recordTimesOk = (r) => Number.isFinite(r?.wallMs) && r.wallMs >= 0 && r.wallMs < 8.64e15 && Number.isFinite(r.simSeconds) && r.simSeconds >= 0 && r.simSeconds <= MAX_SIM_SECONDS;
export const isoTime = (ms) => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null);

// ---- record selection and gaps. Feed pool records ({ wallMs, simSeconds, session, ... }) in log order; each push returns the frames due so far:
// { t (simulated seconds), wallMs, subs: [{ A, B, a }] (B null: A as it is; several for blend), fade (0 none, 1 black), gap (inside a held gap) }.
// records mode (step=N): every Nth record in range is a frame; time mode (step=Xs): one frame each X simulated seconds, from the records around it.
// A gap (wall time jump over gapS, another session, simulated time going back, or simulated time running over simPerWall times the wall clock) is never
// interpolated across: cut drops it, hold repeats the last frame (at most holdMax frames), fade fades out and in over fadeFrames frames each.
// One push plans at most maxPerPush sub-frames (frames x blend) and a run at most maxTotal frames; more throws (a step far too fine, or a log with absurd times).
// simPerWall: the real clock world runs at about 3 simulated seconds per wall second (2026-11-15 log: median 2.99, max 4.06 over 24,864 record pairs, bursts included).
export const MAX_BLEND = 32;
export class Planner {
  constructor({ step = { every: 1 }, from = null, to = null, gap = "cut", gapS = 30, fadeFrames = 15, holdMax = 60, interpolate = false, blend = 1, wallStepMs = 5000, simPerWall = 20, maxPerPush = 200_000, maxTotal = 20_000_000 } = {}) {
    if (!["cut", "hold", "fade"].includes(gap)) throw new Error("gap must be cut, hold or fade");
    if (!(blend >= 1 && blend <= MAX_BLEND)) throw new Error(`blend must be 1 to ${MAX_BLEND}`);
    Object.assign(this, { step, from, to, gapPolicy: gap, gapS, fadeFrames, holdMax, interp: interpolate, blend: Math.max(1, Math.floor(blend)), wallStepMs, simPerWall, maxPerPush, maxTotal });
    this.prev = null; this.n = 0; this.hist = []; this.t = null; this.gaps = 0; this.rewinds = 0; this.done = false; this.planned = 0;
  }
  isGap(A, B) {
    const ds = B.simSeconds - A.simSeconds, dw = (B.wallMs - A.wallMs) / 1000;
    return B.session !== A.session || !(dw <= this.gapS) || !(ds > 0) || !(ds <= this.simPerWall * Math.max(1, dw));
  }
  push(r) {
    if (!recordTimesOk(r)) { this.badTimes = (this.badTimes ?? 0) + 1; return []; }
    const out = this.plan(r), subs = out.reduce((n, f) => n + f.subs.length, 0);
    this.planned += out.length;
    if (subs > this.maxPerPush || this.planned > this.maxTotal) throw new Error(`the plan passed ${subs > this.maxPerPush ? this.maxPerPush + " sub-frames between two records" : this.maxTotal + " frames"} (simulated ${Math.round(r.simSeconds)} s): use a coarser step or a shorter range`);
    return out;
  }
  plan(r) {
    const out = [];
    if (this.done) return out;
    const A = this.prev, inside = (x) => !this.from || timeOf(x, this.from.kind) >= this.from.v;
    if (this.step.every) { // records mode: only the records in range
      if (this.to && timeOf(r, this.to.kind) > this.to.v) { this.done = true; return out; }
      if (!inside(r)) return out;
      if (A && this.isGap(A, r)) { this.gaps++; if (r.simSeconds <= A.simSeconds) this.rewinds++; }
      this.records(A, r, out);
    } else { // time mode: the records just outside the range anchor the frames at its ends
      if (A && inside(A) && this.isGap(A, r)) { this.gaps++; if (r.simSeconds <= A.simSeconds) this.rewinds++; }
      this.timed(A, r, out);
      if (this.to && timeOf(r, this.to.kind) > this.to.v) this.done = true;
    }
    this.prev = r;
    return out;
  }
  end() {
    const out = [], A = this.prev;
    if (!this.done && this.step.sim && A && this.t !== null && this.t <= A.simSeconds + 1e-9) this.emit(out, this.frame(this.t, A, null, 0));
    this.done = true;
    return out;
  }
  // Adds a time-mode frame unless it is past `to` (then the planner is done); false when done.
  emit(out, fr) {
    if (this.to && (this.to.kind === "sim" ? fr.t > this.to.v + 1e-9 : fr.wallMs > this.to.v)) { this.done = true; return false; }
    out.push(fr);
    return true;
  }
  fadeOut(A, out) { for (let f = 1; f <= this.fadeFrames; f++) out.push({ t: A.simSeconds, wallMs: A.wallMs, subs: [{ A, B: null, a: 0 }], fade: f / (this.fadeFrames + 1), gap: true }); }
  fadeIn(B, out) { for (let f = this.fadeFrames; f >= 1; f--) out.push({ t: B.simSeconds, wallMs: B.wallMs, subs: [{ A: B, B: null, a: 0 }], fade: f / (this.fadeFrames + 1), gap: true }); }
  records(A, r, out) {
    const hist = this.hist;
    hist.push(r); if (hist.length > this.blend) hist.shift();
    if (A && this.isGap(A, r)) {
      if (this.gapPolicy === "hold") { const miss = Math.min(this.holdMax, Math.max(0, Math.round((r.wallMs - A.wallMs) / (this.wallStepMs * this.step.every)) - 1)); for (let k = 0; k < miss; k++) out.push({ t: A.simSeconds, wallMs: A.wallMs, subs: [{ A, B: null, a: 0 }], fade: 0, gap: true }); }
      else if (this.gapPolicy === "fade") { this.fadeOut(A, out); this.fadeIn(r, out); }
      hist.length = 0; hist.push(r); // a blend never mixes the two sides of a gap
    }
    if (this.n++ % this.step.every === 0) out.push({ t: r.simSeconds, wallMs: r.wallMs, subs: hist.map((h) => ({ A: h, B: null, a: 0 })), fade: 0, gap: false });
  }
  timed(A, B, out) {
    const st = this.step.sim, hist = this.hist, f = this.from;
    hist.push(B);
    if (this.t === null) { // the first frame's time: from, else the first record
      if (!f) this.t = B.simSeconds;
      else if (f.kind === "sim") this.t = f.v;
      else if (B.wallMs < f.v) return;
      else this.t = A && A.wallMs < f.v && !this.isGap(A, B) ? A.simSeconds + ((B.simSeconds - A.simSeconds) * (f.v - A.wallMs)) / (B.wallMs - A.wallMs) : B.simSeconds;
    }
    if (!(this.t + st > this.t)) throw new Error(`step ${st} s is below the precision of simulated time ${this.t}`);
    while (hist.length > 2 && hist[1].simSeconds < this.t - st) hist.shift(); // records the next frame's sub-frames may still need
    if (hist.length > 256) hist.splice(0, hist.length - 256);
    if (!A) return;
    const gap = this.isGap(A, B);
    if (gap && B.simSeconds <= A.simSeconds) { hist.length = 0; hist.push(B); return; } // simulated time went back (an older save restored): frames resume once it passes the next frame's time
    if (gap && this.gapPolicy === "fade" && this.t < B.simSeconds && this.t >= A.simSeconds - 1e-9) {
      while (this.t <= A.simSeconds + 1e-9) { if (!this.emit(out, this.frame(this.t, A, null, 0))) return; this.t += st; }
      this.fadeOut(A, out); this.fadeIn(B, out);
    }
    let held = 0;
    const skipTo = (v) => { if (this.t < v) this.t += Math.ceil((v - this.t) / st) * st; }; // the first frame time on this step's grid at or after v, in one step
    skipTo(A.simSeconds - 1e-9); // the time before the first record
    while (this.t < B.simSeconds && !this.done) {
      if (out.length * this.blend > this.maxPerPush) return;
      const t = this.t;
      this.t += st;
      if (gap && t <= A.simSeconds + 1e-9) { this.emit(out, this.frame(t, A, null, 0)); continue; } // A's own moment, before the gap opens
      if (gap) {
        if (this.gapPolicy === "hold" && held++ < this.holdMax) { this.emit(out, { ...this.frame(t, A, null, 0), gap: true }); continue; }
        this.t = t; skipTo(B.simSeconds); break; // the rest of the gap
      }
      this.emit(out, this.frame(t, A, B, 0));
    }
    if (gap) { hist.length = 0; hist.push(B); }
  }
  // A frame at time t: its sub-frames spread over the step before t (blend), each from the records around its time.
  frame(t, A, B, fade) {
    const subs = [];
    for (let j = 0; j < this.blend; j++) {
      const s = t - (this.step.sim * j) / this.blend;
      let R = A, S = B;
      if (j > 0) { R = this.hist[0]; S = null; for (let k = 0; k < this.hist.length; k++) { if (this.hist[k].simSeconds <= s) { R = this.hist[k]; S = this.hist[k + 1] ?? null; } } if (S && this.isGap(R, S)) S = null; }
      const a = S ? (s - R.simSeconds) / (S.simSeconds - R.simSeconds) : 0;
      subs.push(this.interp && S ? { A: R, B: S, a, t: s } : { A: R, B: null, a: 0, t: s });
    }
    const wallMs = B ? A.wallMs + (B.wallMs - A.wallMs) * ((t - A.simSeconds) / (B.simSeconds - A.simSeconds)) : A.wallMs;
    return { t, wallMs, subs, fade, gap: false };
  }
}

// ---- camera: device px = world units x Z + (Tx, Ty), and dpr (device px per CSS px, which sizes the dots, outlines and chip as on the page)
// The PNG framing of world.json: PNG px = ((origin + world x zoom) - crop corner) x dsf.
export function pngBase(cam, crop) { return { Z: cam.zoom * cam.dsf, Tx: (cam.origin[0] - crop.x) * cam.dsf, Ty: (cam.origin[1] - crop.y) * cam.dsf, dpr: cam.dsf }; }
// The capture's camera and crop for framing a, for a world.json without them (timelapse.mjs camera() and computeCrop() without the chip, which gives the same crop).
export function captureFraming(width, height, { w = 1920, h = 1200, dsf = 2, margin = 8 } = {}) {
  const z = Math.min(w / width, h / height) * 0.96, ww = width * z, wh = height * z, x0 = (w - ww) / 2, y0 = (h - wh) / 2;
  const left = Math.max(0, Math.floor(x0 - margin)), top = Math.max(0, Math.floor(y0 - margin)), right = Math.min(w, Math.ceil(x0 + ww + margin)), bottom = Math.min(h, Math.ceil(y0 + wh + margin));
  const even = (v) => (Math.round(v * dsf) % 2 === 0 ? v : v + 1);
  const crop = { x: left, y: top, width: Math.min(even(right - left), w - left), height: Math.min(even(bottom - top), h - top) };
  return { camera: { zoom: z, origin: [x0, y0], dsf, viewport: [w, h] }, crop, size: [crop.width * dsf, crop.height * dsf] };
}
// A rectangle in PNG px (x, y, w, h) drawn natively at W x H: scaled to fit and widened to the output's shape around its centre (more map, never bars inside it).
// dpr scales with it, so the frame looks like that part of the PNG enlarged, drawn sharp.
export function cropCam(base, rect, W, H) {
  const s = Math.min(W / rect[2], H / rect[3]), cx = rect[0] + rect[2] / 2, cy = rect[1] + rect[3] / 2;
  return { Z: base.Z * s, Tx: (base.Tx - cx) * s + W / 2, Ty: (base.Ty - cy) * s + H / 2, dpr: base.dpr * s };
}
// A fixed close-up: centre in world units, zoom relative to the whole-PNG framing at this output size (1 = the whole map). dpr stays that of the whole-map
// framing, as on the page, where dots keep their screen size while zooming until creatures are drawn at their true size.
export function centerCam(base, pngSize, W, H, cx, cy, zoom) {
  const s = Math.min(W / pngSize[0], H / pngSize[1]), Z = base.Z * s * zoom;
  return { Z, Tx: W / 2 - cx * Z, Ty: H / 2 - cy * Z, dpr: base.dpr * s };
}
export const camCenter = (c, W, H) => ({ cx: (W / 2 - c.Tx) / c.Z, cy: (H / 2 - c.Ty) / c.Z });
// Keyframes: [{ t, center: [x, y], zoom } or { t, crop: [x, y, w, h] }], t as in from= (all keys in one kind). Between keys the zoom goes geometrically and the centre linearly,
// eased (smoothstep); before the first and after the last key the camera holds.
export function parseKeys(json, base, pngSize, W, H) {
  const list = typeof json === "string" ? JSON.parse(json) : json;
  if (!Array.isArray(list) || !list.length || list.length > 1000) throw new Error("keys must be a JSON list of 1 to 1000 keyframes");
  const keys = list.map((k) => {
    const t = parseTime(k?.t);
    if (!t) throw new Error("every keyframe needs t");
    const c = Array.isArray(k.crop) && k.crop.length === 4 && k.crop.every(Number.isFinite) ? cropCam(base, k.crop, W, H)
      : Array.isArray(k.center) && k.center.length === 2 && k.center.every(Number.isFinite) && (k.zoom === undefined || (Number.isFinite(k.zoom) && k.zoom > 0)) ? centerCam(base, pngSize, W, H, k.center[0], k.center[1], k.zoom ?? 1) : null;
    if (!c) throw new Error("a keyframe needs center: [x, y] (and zoom) or crop: [x, y, w, h]");
    return { t, ...camCenter(c, W, H), Z: c.Z, dpr: c.dpr };
  });
  if (keys.some((k) => k.t.kind !== keys[0].t.kind)) throw new Error("keyframe times must all be wall times or all simulated");
  keys.sort((a, b) => a.t.v - b.t.v);
  return keys;
}
export function keyCam(keys, frame, W, H) {
  const kind = keys[0].t.kind, v = kind === "wall" ? frame.wallMs : frame.t;
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t.v <= v) i++;
  const A = keys[i], B = keys[Math.min(i + 1, keys.length - 1)];
  const u = B === A || v <= A.t.v ? 0 : Math.min(1, (v - A.t.v) / (B.t.v - A.t.v)), e = u * u * (3 - 2 * u);
  const Z = A.Z * (B.Z / A.Z) ** e, cx = A.cx + (B.cx - A.cx) * e, cy = A.cy + (B.cy - A.cy) * e, dpr = A.dpr + (B.dpr - A.dpr) * e;
  return { Z, Tx: W / 2 - cx * Z, Ty: H / 2 - cy * Z, dpr };
}

// ---- items: the ITEMS wire message (live/protocol.ts) of an ItemState, for the page's own decoder
export function itemsMessage(st, tick = 0) {
  let n = 0;
  for (let i = 0; i < st.slots; i++) if (st.kinds[i]) n++;
  const bits = Math.ceil(st.slots / 4), b = Buffer.alloc(13 + bits + 4 * n);
  b[0] = 2; b.writeUInt32LE(tick >>> 0, 1); b.writeUInt32LE(st.slots, 5); b.writeUInt32LE(n, 9);
  for (let i = 0, p = 13 + bits; i < st.slots; i++) { const k = st.kinds[i]; if (!k) continue; b[13 + (i >> 2)] |= k << ((i & 3) * 2); b.writeUInt16LE(st.x[i], p); b.writeUInt16LE(st.y[i], p + 2); p += 4; }
  return b;
}

// ---- sidecar counts
// Lineage rows from a lineage record's JSON (the state log keeps names of starters only): founder -> row, and the rows.
export function lineageRows(json) {
  const rows = [], rowOf = new Map();
  for (const l of Array.isArray(json?.lineages) ? json.lineages.slice(0, 64) : []) {
    const founder = Number.isInteger(l?.founder) ? l.founder | 0 : null;
    if (founder === null) continue;
    const starter = l.starter === true, hue = Number.isFinite(l.hue) ? l.hue : null;
    rows.push({ founder, hue, starter, name: starter && typeof l.name === "string" ? l.name.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 24) : "" });
    rowOf.set(founder, founder);
    for (const f of Array.isArray(l.founders) ? l.founders.slice(0, 64) : []) if (Number.isInteger(f)) rowOf.set(f | 0, founder);
  }
  return { rows, rowOf };
}
export function lineageCounts(v, lin) {
  const counts = new Map(lin.rows.map((r) => [r.founder, 0]));
  let others = 0;
  for (let i = 0; i < v.count; i++) { const r = lin.rowOf.get(v.founder[i]); if (r === undefined) others++; else counts.set(r, counts.get(r) + 1); }
  return { rows: lin.rows.map((r) => ({ ...r, count: counts.get(r.founder) })), others };
}
// regions.jsonl's matrix (timelapse.mjs logRegions): rows the regions then elsewhere, columns the seeding hues' lineages then other.
export function regionMatrix(v, R, { radiusFactor = 2.5, hueMatchDeg = 25 } = {}) {
  const nr = R.ids.length, nh = R.hues.length, m = new Array((nr + 1) * (nh + 1)).fill(0);
  for (let i = 0; i < v.count; i++) {
    const x = v.x[i], y = v.y[i], hue = v.hue[i];
    let row = nr, best = Infinity;
    for (let k = 0; k < nr; k++) { const d = Math.hypot(x - R.x[k], y - R.y[k]) / R.r[k]; if (d <= radiusFactor && d < best) { best = d; row = k; } }
    let col = nh, bd = hueMatchDeg;
    for (let k = 0; k < nh; k++) { let d = Math.abs(hue - R.hues[k]) % 360; if (d > 180) d = 360 - d; if (d <= bd) { bd = d; col = k; } }
    m[row * (nh + 1) + col]++;
  }
  return m;
}
// Map regions from the map's source in this checkout (as timelapse.mjs loadRegions reads them).
export function regionsFromSource(src) {
  const a = src.indexOf('"regions": ['); if (a < 0) return null;
  const b = src.indexOf("\n ]", a), num = (v) => typeof v === "number" && Number.isFinite(v);
  const regs = JSON.parse(src.slice(a + 11, b + 3)).filter((g) => num(g?.x) && num(g?.y) && num(g?.r));
  if (!regs.length || regs.length > 16) return null;
  const homes = regs.filter((g) => num(g.hue)), id = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 16) || "x";
  return { ids: regs.map((g) => id(g.id)), x: regs.map((g) => g.x), y: regs.map((g) => g.y), r: regs.map((g) => g.r), hueIds: homes.map((g) => id(g.id)), hues: homes.map((g) => g.hue) };
}

// ---- ffmpeg: raw RGBA frames on stdin. h264 converts with the bt709 matrix (swscale's default is bt601, which would shift the colours) and tags bt709, limited range.
export function ffmpegArgs({ mode, codec, W, H, fps, crf, preset, pix, threads, out, inPix = "rgba", lookahead = -1 }) {
  const yin = inPix === "yuv420p"; // made in the page (replay/main.ts toYuv420): BT.709 limited range, chroma centre sited
  const input = ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", inPix, ...(yin ? ["-color_range", "tv", "-colorspace", "bt709", "-chroma_sample_location", "center"] : []), "-s", `${W}x${H}`, "-r", String(fps), "-i", "-", "-threads", String(threads)];
  if (mode === "frames") return [...input, "-pix_fmt", "rgb24", "-start_number", "0", "-f", "image2", join(out, "frame_%06d.png")];
  const tags = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
  const yuv = (p) => yin ? ["-pix_fmt", p, "-chroma_sample_location", "center"] : ["-vf", `scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int+bicubic,format=${p}`, "-pix_fmt", p];
  if (codec === "ffv1") return [...input, "-c:v", "ffv1", "-level", "3", "-g", "1", "-slices", "4", "-slicecrc", "1", "-pix_fmt", "bgr0", out];
  if (codec === "prores") return [...input, ...yuv("yuv444p10le"), "-c:v", "prores_ks", "-profile:v", "4", "-vendor", "apl0", ...tags, out];
  if (!["yuv420p", "yuv444p"].includes(pix)) throw new Error("pix must be yuv420p or yuv444p");
  const profile = crf === 0 ? [] : ["-profile:v", pix === "yuv444p" ? "high444" : "high"]; // lossless needs the High 4:4:4 Predictive profile, which x264 picks itself
  return [...input, ...yuv(pix), "-c:v", "libx264", ...profile, "-preset", preset, "-crf", String(crf), ...(lookahead >= 0 ? ["-x264-params", `rc-lookahead=${lookahead}`] : []), ...tags, "-movflags", "+faststart", out];
}

// ---- the pixel socket's receiving end: WebSocket frames from the page parsed straight into one frame buffer (the ws package's receiver costs about 0.5 s of CPU per 35 MB frame).
// Binary messages of exactly `size` bytes (fragments allowed, every frame masked, as a browser sends them); onFrame(buf, ack) per message, ack() answers "ok". Anything else closes the socket.
export function pixelSocket(sock, size, onFrame, onError) {
  let buf = Buffer.allocUnsafe(size), at = 0, hdr = Buffer.alloc(0), left = -1, mask = null, fin = false, pos = 0, first = true;
  const OK = Buffer.from([0x81, 2, 0x6f, 0x6b]);
  const fail = (why) => { sock.destroy(); onError(new Error(why)); };
  const done = () => {
    if (at !== size) return fail("short frame of pixels");
    const b = buf; buf = Buffer.allocUnsafe(size); at = 0; first = true;
    onFrame(b, () => { if (!sock.destroyed) sock.write(OK); });
  };
  sock.on("data", (chunk) => {
    let p = 0;
    while (p < chunk.length && !sock.destroyed) {
      if (left < 0) { // a frame header, at most 14 bytes, maybe split across chunks
        const old = hdr.length, take = Math.min(14 - old, chunk.length - p), h = Buffer.concat([hdr, chunk.subarray(p, p + take)]), r = frameHead(h);
        if (!r) { hdr = h; p += take; continue; }
        p += r.hlen - old; hdr = Buffer.alloc(0);
        if (r.op === 8) { sock.end(); return; }
        if (!r.masked || r.op !== (first ? 2 : 0) || at + r.len > size) return fail("not a frame of pixels");
        left = r.len; mask = r.mask; fin = r.fin; pos = 0; first = false;
      } else {
        const n = Math.min(left, chunk.length - p);
        chunk.copy(buf, at, p, p + n); unmask(buf, at, n, mask, pos);
        at += n; pos += n; p += n; left -= n;
      }
      if (left === 0) { left = -1; if (fin) done(); }
    }
  });
}
// A WebSocket frame header: { op, fin, masked, len, mask, hlen }, or null while incomplete.
export function frameHead(h) {
  if (h.length < 2) return null;
  let len = h[1] & 127, at = 2;
  if (len === 126) { if (h.length < 4) return null; len = h.readUInt16BE(2); at = 4; } else if (len === 127) { if (h.length < 10) return null; len = Number(h.readBigUInt64BE(2)); at = 10; }
  const masked = (h[1] & 128) !== 0;
  if (h.length < at + (masked ? 4 : 0)) return null;
  return { op: h[0] & 15, fin: (h[0] & 128) !== 0, masked, len, mask: masked ? Buffer.from(h.subarray(at, at + 4)) : null, hlen: at + (masked ? 4 : 0) };
}
// XORs n bytes at buf[start..] with the mask, the first being byte `phase` of its frame's payload; whole 32-bit words where aligned (little-endian, as x86 and arm64 run).
export function unmask(buf, start, n, mask, phase) {
  let i = 0;
  while (i < n && (buf.byteOffset + start + i) & 3) { buf[start + i] ^= mask[(phase + i) & 3]; i++; }
  const words = (n - i) >> 2;
  if (words) {
    const q = phase + i, m = mask[q & 3] | (mask[(q + 1) & 3] << 8) | (mask[(q + 2) & 3] << 16) | (mask[(q + 3) & 3] << 24), w = new Int32Array(buf.buffer, buf.byteOffset + start + i, words);
    for (let k = 0; k < words; k++) w[k] ^= m;
    i += 4 * words;
  }
  for (; i < n; i++) buf[start + i] ^= mask[(phase + i) & 3];
}

// ---- guards for replay.mjs (everything from the world folder is hostile)
const finite = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
// The state log header's world and creature sizes, or why they cannot be drawn.
export function headerProblem(h) {
  if (!h || typeof h !== "object") return "no header";
  if (!finite(h.world?.width, 1, 1e7) || !finite(h.world?.height, 1, 1e7)) return "world size outside 1 to 1e7";
  if (!finite(h.radius, 0.1, 100) || !finite(h.itemRadius, 0.1, 50) || !finite(h.fullEnergy, 1e-3, 1e9)) return "radius (0.1 to 100), itemRadius (0.1 to 50) or fullEnergy outside their range"; // the engine: radius 12, itemRadius 2 to 10
  if (typeof h.map !== "string" || !/^[a-z0-9-]{1,40}$/.test(h.map)) return "no map name this renderer can draw";
  return null;
}
// The first header of a log iterator, skipping (not keeping) at most maxSkip records before it: { header, record, skipped, skippedBytes }, or null.
export function findHeader(log, maxSkip = 1000) {
  let skipped = 0, skippedBytes = 0;
  for (let it = log.next(); !it.done; it = log.next()) { // next(), not for-of: a break would close the reader
    const r = it.value;
    if (r.type === 1 && r.json && typeof r.json === "object") return { header: r.json, record: r, skipped, skippedBytes };
    skipped++; skippedBytes += r.bytes ?? 0;
    if (skipped > maxSkip) return null;
  }
  return null;
}
// world.json's camera, crop and size when they are the capture's own (framing a or b: the camera as captureFraming makes it, the crop within CROP_SLACK CSS px of it,
// size = crop x dsf, at most MAX_PNG_PX: framing b is 7440 x 4672), else the capture's framing a, with the reason. A default output size is capped at DEFAULT_OUT_PX.
export const MAX_PNG_PX = 35_000_000, DEFAULT_OUT_PX = 16_000_000, CROP_SLACK = 64;
export function framingFrom(wj, width, height) {
  const c = wj?.camera, k = wj?.crop, s = wj?.size;
  const why = (() => {
    if (!c || !k || !Array.isArray(s)) return "world.json has no camera, crop and size";
    if (![2, 4].includes(c.dsf)) return "world.json's dsf is not the capture's 2 or 4";
    const ref = captureFraming(width, height, { dsf: c.dsf }), near = (a, b, tol) => typeof a === "number" && Math.abs(a - b) <= tol;
    if (!near(c.zoom, ref.camera.zoom, 1e-9 * ref.camera.zoom) || !Array.isArray(c.origin) || !near(c.origin[0], ref.camera.origin[0], 0.01) || !near(c.origin[1], ref.camera.origin[1], 0.01)) return "world.json's camera is not the capture's";
    if (!["x", "y", "width", "height"].every((q) => Number.isInteger(k[q]) && near(k[q], ref.crop[q], CROP_SLACK)) || k.x + k.width > 1920 || k.y + k.height > 1200) return "world.json's crop is not the capture's";
    if (s.length !== 2 || s[0] !== k.width * c.dsf || s[1] !== k.height * c.dsf || s[0] * s[1] > MAX_PNG_PX) return "world.json's size is not crop x dsf within 35 MP";
    return "";
  })();
  if (!why) return { camera: { zoom: c.zoom, origin: [c.origin[0], c.origin[1]], dsf: c.dsf }, crop: { x: k.x, y: k.y, width: k.width, height: k.height }, size: [s[0], s[1]], from: "world.json" };
  return { ...captureFraming(width, height), from: `the capture's framing a (${why})` };
}
// Free space (MB) on the file system holding dir, Infinity when unknown.
export function diskFreeMB(dir) { try { const f = statfsSync(dir); return Math.floor((f.bavail * f.bsize) / 1048576); } catch { return Infinity; } }
// A rough output size in MB for n frames (measured 2026-11-15: h264 crf 12 1080p 270 MB/min, ProRes 4444 0.68 bytes a px, PNG frames about 1.2).
export function sizeEstimateMB({ mode, codec, crf, pix, W, H }, n) {
  const px = W * H, perPx = mode === "frames" ? 1.2 : codec === "prores" ? 0.68 : codec === "ffv1" ? 1.5 : crf === 0 ? (pix === "yuv444p" ? 0.29 : 0.17) : 0.0725 * 1.09 ** (12 - crf);
  return Math.round((n * px * perPx) / 1048576);
}
// An output path (file, or folder with dir) for replay.mjs: its parent must exist and resolve outside the capture's output root, and the path itself must not be a link
// (nor, for a file, anything but a regular file). Returns the real path; throws with the reason.
export function outputPath(p, root, { dir = false } = {}) {
  const f = resolve(String(p).replace(/\/+$/, "") || "/"), rootReal = realpathSync(root);
  let parent; try { parent = realpathSync(dirname(f)); } catch { throw new Error(`no folder for ${f}`); }
  if (parent === rootReal || parent.startsWith(rootReal + sep)) throw new Error(`${f} is inside the capture's output folder ${rootReal}`);
  const real = join(parent, basename(f));
  let st = null; try { st = lstatSync(real); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (st && (st.isSymbolicLink() || (dir ? !st.isDirectory() : !st.isFile()))) throw new Error(`${real} exists and is ${st.isSymbolicLink() ? "a link" : dir ? "not a folder" : "not a regular file"}`);
  if (dir && !st) mkdirSync(real);
  return real;
}
// A fresh file next to `out` (hidden, random name, same extension), created exclusively so nothing planted there is written through; rename it to `out` when done.
export function freshTemp(out) {
  const tmp = join(dirname(out), `.${basename(out, extname(out))}.${randomBytes(6).toString("hex")}.part${extname(out)}`);
  closeSync(openSync(tmp, "wx", 0o644));
  return tmp;
}
// Writes to a child's stdin, honouring backpressure; the promise rejects when the child exits or its stdin fails, so a dead encoder never leaves a write waiting.
export function pipeWriter(child) {
  let gone = null;
  const dead = new Promise((_, rej) => {
    const fail = (why) => { gone ??= why; rej(new Error(gone)); };
    child.on("close", (code, sig) => fail(`the encoder exited (code ${code}${sig ? ", " + sig : ""})`));
    child.stdin.on("error", (e) => fail(`the encoder's input failed: ${e.code ?? e.message}`));
  });
  dead.catch(() => {});
  return (buf) => {
    if (gone || child.exitCode !== null || child.signalCode !== null) return Promise.reject(new Error(gone ?? "the encoder exited"));
    if (child.stdin.write(buf)) return Promise.resolve();
    return Promise.race([new Promise((res) => child.stdin.once("drain", res)), dead]);
  };
}
// The pixel socket's upgrade: the secret path, the page's own Origin, and only one connection per run.
export const upgradeOk = (req, origin, path, used) => !used && req.url === path && req.headers?.origin === origin && typeof req.headers?.["sec-websocket-key"] === "string" && req.headers["sec-websocket-key"].length <= 64;
