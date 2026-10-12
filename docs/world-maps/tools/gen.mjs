// usage: node gen.mjs <specs.mjs> <outDir> [ids...] -> map-ID.json (spec + stats) and map-ID.data.js (render data)
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
const [specFile, outDir, ...only] = process.argv.slice(2);
const specs = (await import(pathToFileURL(specFile).href)).default;
const CS = 100, MC = 50, IC = 20, IM = 10; // field cell, massif cell, inset field cell, inset massif cell

const mulberry = (a) => () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hash = (i, j, s) => { let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 2147483647)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const sm = (x) => x * x * (3 - 2 * x);
const vnoise = (x, y, s) => { const i = Math.floor(x), j = Math.floor(y), fx = sm(x - i), fy = sm(y - j); const a = hash(i, j, s), b = hash(i + 1, j, s), c = hash(i, j + 1, s), d = hash(i + 1, j + 1, s); return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy; };
const fbm = (x, y, s) => vnoise(x, y, s) * 0.55 + vnoise(x * 2.1, y * 2.1, s + 7) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 13) * 0.15;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function catmull(pts, closed, per = 14) {
  const n = pts.length, out = [];
  const get = (i) => (closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  for (let i = 0; i < (closed ? n : n - 1); i++) for (let k = 0; k < per; k++) {
    const u = k / per, p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    out.push([0, 1].map((d) => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * u + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * u * u + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * u ** 3)));
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}
const pip = (poly, x, y) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };

// A layer's signed distance (negative inside) at (x, y), after domain warp, edge roughness and, for paths, width wobble.
function makeShape(L, seed) {
  const sh = L.shape, amp = L.warp ?? 900, rough = L.rough ?? 300;
  const warp = (x, y) => [x + amp * (fbm(x / 5200, y / 5200, seed + 1) - 0.5) * 2 + amp * 0.35 * (vnoise(x / 1800, y / 1800, seed + 3) - 0.5) * 2, y + amp * (fbm(x / 5200, y / 5200, seed + 2) - 0.5) * 2 + amp * 0.35 * (vnoise(x / 1800, y / 1800, seed + 4) - 0.5) * 2];
  let raw, pad;
  if (sh.type === "poly") {
    const poly = catmull(sh.pts, true);
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    pad = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    raw = (x, y) => { let m = 1e18; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [ax, ay] = poly[j], [bx, by] = poly[i]; const dx = bx - ax, dy = by - ay; const u = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1); const d = (x - ax - u * dx) ** 2 + (y - ay - u * dy) ** 2; if (d < m) m = d; } m = Math.sqrt(m); return pip(poly, x, y) ? -m : m; };
  } else {
    const path = catmull(sh.path, false, 12);
    const cum = [0]; for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
    const total = cum[cum.length - 1], w = sh.w;
    const wAt = (t) => { const f = t * (w.length - 1), i = Math.min(w.length - 2, Math.floor(f)); let v = w[i] + (w[i + 1] - w[i]) * (f - i); if (L.wobble) v *= 1 + L.wobble * (vnoise((t * total) / 1700, 0.5, seed + 8) - 0.5) * 2 + 0.5 * L.wobble * (vnoise((t * total) / 600, 1.5, seed + 9) - 0.5) * 2; if (L.taper) v *= 0.35 + 0.65 * sstep(0, 0.07, Math.min(t, 1 - t)); return v; };
    const xs = path.map((p) => p[0]), ys = path.map((p) => p[1]), wm = Math.max(...w) * 1.6;
    pad = { x0: Math.min(...xs) - wm, x1: Math.max(...xs) + wm, y0: Math.min(...ys) - wm, y1: Math.max(...ys) + wm };
    raw = (x, y) => { let m = 1e18, bt = 0; for (let i = 0; i < path.length - 1; i++) { const [ax, ay] = path[i], [bx, by] = path[i + 1]; const dx = bx - ax, dy = by - ay; const u = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1); const d = (x - ax - u * dx) ** 2 + (y - ay - u * dy) ** 2; if (d < m) { m = d; bt = (cum[i] + u * Math.hypot(dx, dy)) / total; } } return Math.sqrt(m) - wAt(bt) / 2; };
  }
  const margin = amp * 1.6 + rough * 1.5 + (L.feather ?? 800) + 400 + (L.band ?? 0);
  const sd = (x, y) => {
    if (x < pad.x0 - margin || x > pad.x1 + margin || y < pad.y0 - margin || y > pad.y1 + margin) return 1e9;
    const [qx, qy] = warp(x, y);
    let d = raw(qx, qy);
    if (L.band) d = Math.abs(d) - L.band;
    return d + rough * (fbm(x / 800, y / 800, seed + 5) - 0.5) * 2 + rough * 0.4 * (vnoise(x / 260, y / 260, seed + 6) - 0.5) * 2;
  };
  sd.pad = { x0: pad.x0 - margin, x1: pad.x1 + margin, y0: pad.y0 - margin, y1: pad.y1 + margin };
  return sd;
}

function build(spec) {
  const [W, H] = spec.world, seed = spec.seed, cols = Math.ceil(W / CS), rows = Math.ceil(H / CS);
  const layers = spec.layers.map((L, i) => ({ ...L, sd: makeShape(L, seed + 41 * i), i }));
  for (const L of layers) { const tx = L.mud ?? L.firm; if (!tx || tx.coverage === undefined || tx.coverage >= 1) { L.thr = -1; continue; } const arr = []; for (let k = 0; k < 4000; k++) arr.push(fbm((hash(k, 1, 9) * 60000) / tx.scale, (hash(k, 2, 9) * 60000) / tx.scale, seed + 100 + L.i)); arr.sort((a, b) => a - b); L.thr = arr[Math.floor((1 - tx.coverage) * 3999)]; }
  const field = (x, y) => {
    let food = spec.baseFood ?? 1, poison = spec.basePoison ?? 1, mud = 0, firm = 0, depth = 0;
    for (const L of layers) {
      const d = L.sd(x, y), fe = L.feather ?? 800; if (d > fe / 2) continue;
      const m = clamp(0.5 - d / fe, 0, 1), edge = L.edge ?? 380, ins = clamp(0.5 - d / edge, 0, 1);
      if (L.food !== undefined) food += (L.food - food) * m;
      if (L.poison !== undefined) poison += (L.poison - poison) * m;
      if (L.clearMud) mud *= 1 - ins;
      if (L.mud) { const tx = L.mud, n = tx.coverage >= 1 ? 1 : clamp(0.5 + (fbm(x / tx.scale, y / tx.scale, seed + 100 + L.i) - L.thr) * 10, 0, 1); mud = Math.max(mud, Math.min(ins, n)); depth = Math.max(depth, clamp(-d / (tx.deep ?? 800), 0, 1) * Math.min(1, ins * 2)); }
      if (L.firm) { const tx = L.firm, n = tx.coverage >= 1 ? 1 : clamp(0.5 + (fbm(x / tx.scale, y / tx.scale, seed + 100 + L.i) - L.thr) * 10, 0, 1); firm = Math.max(firm, Math.min(clamp(0.5 - (d + (tx.inset ?? 0)) / edge, 0, 1), n)); }
    }
    return { food, poison, mud, firm, depth };
  };
  const F = {}; for (const k of ["food", "poison", "mud", "firm", "depth"]) F[k] = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) { const f = field((cx + 0.5) * CS, (cy + 0.5) * CS), c = cy * cols + cx; F.food[c] = Math.round(clamp(f.food * 40, 0, 255)); F.poison[c] = Math.round(clamp(f.poison * 40, 0, 255)); F.mud[c] = Math.round(f.mud * 255); F.firm[c] = Math.round(f.firm * 255); F.depth[c] = Math.round(f.depth * 255); }
  const isMud = (c) => F.mud[c] > 127 && F.firm[c] <= 127;
  const cellAt = (x, y) => clamp(Math.floor(y / CS), 0, rows - 1) * cols + clamp(Math.floor(x / CS), 0, cols - 1);
  const mudAt = (x, y) => isMud(cellAt(x, y));
  // massifs: one merged mask each, rendered per pixel from the mask
  const massifs = (spec.rock ?? []).filter((R) => R.kind === "massif").map((R, i) => {
    const sd = makeShape(R, seed + 977 + 31 * i), fe = R.feather ?? 800, ps = R.passes ?? [];
    const v = (x, y) => { let q = clamp(0.5 - sd(x, y) / fe, 0, 1); if (q <= 0) return 0; for (const [px, py, pr] of ps) { const r = pr * (0.85 + 0.3 * vnoise(x / 500, y / 500, seed + 9 + i)); q = Math.min(q, clamp((Math.hypot(x - px, y - py) / r - 0.78) * 4, 0, 1)); } return q; };
    return { v, pad: sd.pad };
  });
  const mcols = Math.ceil(W / MC), mrows = Math.ceil(H / MC), M = new Uint8Array(mcols * mrows);
  for (const m of massifs) for (let cy = Math.max(0, Math.floor(m.pad.y0 / MC)); cy < Math.min(mrows, Math.ceil(m.pad.y1 / MC)); cy++) for (let cx = Math.max(0, Math.floor(m.pad.x0 / MC)); cx < Math.min(mcols, Math.ceil(m.pad.x1 / MC)); cx++) { const q = Math.round(m.v((cx + 0.5) * MC, (cy + 0.5) * MC) * 255); if (q > M[cy * mcols + cx]) M[cy * mcols + cx] = q; }
  const massAt = (x, y) => M[clamp(Math.floor(y / MC), 0, mrows - 1) * mcols + clamp(Math.floor(x / MC), 0, mcols - 1)] / 255;
  // stones, outcrops, drifts
  const rng = mulberry(seed * 7919 + 17);
  const stones = [];
  const grid = new Map(); const gk = (x, y) => Math.floor(x / 400) + "," + Math.floor(y / 400);
  const hit = (x, y, r, gap) => { for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (const [px, py, pr] of grid.get(Math.floor(x / 400) + a + "," + (Math.floor(y / 400) + b)) ?? []) if (Math.hypot(px - x, py - y) < r + pr + gap) return true; return false; };
  const hull = (pts) => { pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); const lo = [], up = []; for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); } for (const p of pts.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); } return lo.slice(0, -1).concat(up.slice(0, -1)); };
  const polyOf = (discs) => { const pts = []; if (discs.length === 1) { const [x, y, r] = discs[0], n = 5 + Math.floor(rng() * 4), a0 = rng() * 6.28; for (let k = 0; k < n; k++) { const a = a0 + (6.2832 * (k + 0.7 * (rng() - 0.5))) / n, rr = r * (0.62 + 0.55 * rng()); pts.push([x + rr * Math.cos(a) * 1.05, y + rr * Math.sin(a) * 0.9]); } return pts.map(([x, y]) => [Math.round(x), Math.round(y)]); } for (const [x, y, r] of discs) { const n = 6, a0 = rng() * 6.28; for (let k = 0; k < n; k++) { const a = a0 + (6.2832 * k) / n + (rng() - 0.5) * 0.5, rr = r * (0.7 + 0.45 * rng()); pts.push([x + rr * Math.cos(a), y + rr * Math.sin(a)]); } } return hull(pts).map(([x, y]) => [Math.round(x), Math.round(y)]); };
  const K = { talus: { g: 170, r: [60, 150], ex: [0, 2], gap: 70 }, outcrop: { g: 420, r: [170, 380], ex: [2, 5], gap: 140 } };
  const addStone = (discs, bound) => { const [px, py] = discs[0]; const k = gk(px, py); if (!grid.has(k)) grid.set(k, []); grid.get(k).push([px, py, bound]); stones.push({ d: discs.map((q) => q.map(Math.round)), p: polyOf(discs) }); };
  for (const [ri, R] of (spec.rock ?? []).entries()) {
    if (R.kind === "massif") continue;
    const sd = makeShape(R, seed + 1977 + 31 * ri), feather = R.feather ?? 1200, Kd = K[R.kind];
    const r0 = R.r ?? Kd.r, g = R.g ?? Kd.g, avgR = (r0[0] + r0[1]) / 2, avgA = 0.3 * Math.PI * avgR * avgR * (1 + ((Kd.ex[0] + Kd.ex[1]) / 2) * 0.45), pw = R.pow ?? 1.5, lo = R.clumpLo ?? 0.42, hi = R.clumpHi ?? 0.62;
    for (let y = sd.pad.y0 < 0 ? 0 : sd.pad.y0; y < Math.min(H, sd.pad.y1); y += g) for (let x = Math.max(0, sd.pad.x0); x < Math.min(W, sd.pad.x1); x += g) {
      const px = x + rng() * g, py = y + rng() * g;
      const d = sd(px, py); if (d > feather / 2) continue;
      const m = clamp(0.5 - d / feather, 0, 1) ** pw;
      if (R.passes && R.passes.some(([qx, qy, qr]) => Math.hypot(px - qx, py - qy) < qr)) continue;
      const fade = R.fadeX ? 1 - sstep(R.fadeX[0], R.fadeX[1], px) : 1;
      const clump = R.clump ? sstep(lo, hi, fbm(px / R.clump, py / R.clump, seed + 500 + ri)) * 2.6 : 1;
      const p = Math.min(1, ((R.cover * g * g) / avgA) * m * clump * fade);
      if (rng() > p) continue;
      const r = r0[0] + (r0[1] - r0[0]) * rng() ** 1.3, nEx = Kd.ex[0] + Math.floor(rng() * (Kd.ex[1] - Kd.ex[0] + 1));
      if (px < r + 60 || py < r + 60 || px > W - r - 60 || py > H - r - 60) continue;
      if (!R.onMud && mudAt(px, py)) continue;
      if (massAt(px, py) > 0.2) continue;
      const discs = [[px, py, r]], ang = rng() * 6.28;
      for (let k = 0; k < nEx; k++) { const t = ((k + 1) / (nEx + 1)) * 2 - 1, off = r * (1.0 * t + 0.4 * (rng() - 0.5)), side = r * 0.35 * (rng() - 0.5) * 2; discs.push([px + off * Math.cos(ang) - side * Math.sin(ang), py + off * Math.sin(ang) + side * Math.cos(ang), r * (0.5 + 0.35 * rng())]); }
      const bound = r * 1.5 + (nEx ? r * 0.8 : 0);
      if (hit(px, py, bound, Kd.gap)) continue;
      if (!R.onMud && discs.some(([dx, dy]) => mudAt(dx, dy))) continue;
      addStone(discs, bound);
    }
  }
  // stepping stones across fords: [cx, cy, angleDeg, length, count] in units
  for (const [cx, cy, ang, len, n] of spec.fords ?? []) for (let i = 0; i < n; i++) { const t = n > 1 ? i / (n - 1) - 0.5 : 0, a = (ang * Math.PI) / 180, r = 85 + 50 * rng(); addStone([[cx + Math.cos(a) * len * t + (rng() - 0.5) * 60, cy + Math.sin(a) * len * t + (rng() - 0.5) * 60, r]], r + 60); }
  // coverage and stats
  const cov = new Uint8Array(cols * rows);
  for (const s of stones) for (const [x, y, r] of s.d) for (let cy = Math.max(0, Math.floor((y - r) / CS)); cy <= Math.min(rows - 1, Math.floor((y + r) / CS)); cy++) for (let cx = Math.max(0, Math.floor((x - r) / CS)); cx <= Math.min(cols - 1, Math.floor((x + r) / CS)); cx++) if (Math.hypot((cx + 0.5) * CS - x, (cy + 0.5) * CS - y) < r + 40) cov[cy * cols + cx] = 1;
  let massCells = 0; const n = cols * rows;
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) { if (massAt((cx + 0.5) * CS, (cy + 0.5) * CS) > 0.5) { cov[cy * cols + cx] = 1; massCells++; } }
  let normal = 0, mud = 0, firm = 0, rk = 0, sf = 0, sp = 0, anyP = 0, rich = 0, poor = 0;
  for (let c = 0; c < n; c++) { if (cov[c]) rk++; else if (F.firm[c] > 127) firm++; else if (F.mud[c] > 127) mud++; else normal++; sf += F.food[c] / 40; sp += F.poison[c] / 40; if (F.poison[c] > 60) anyP++; if (F.food[c] > 64) rich++; if (F.food[c] < 26) poor++; }
  const massDiscs = Math.round((massCells * CS * CS) / (Math.PI * 210 * 210 * 0.55));
  const discCount = stones.reduce((s, q) => s + q.d.length, 0) + massDiscs;
  const stats = { normalGround: +(normal / n).toFixed(3), mud: +(mud / n).toFixed(3), firm: +(firm / n).toFixed(3), rockCover: +(rk / n).toFixed(3), rockDiscs: discCount, stoneClusters: stones.length, massifDiscsEst: massDiscs, meanFood: +(sf / n).toFixed(2), meanPoison: +(sp / n).toFixed(2), hasPoison: anyP > 40, hasRich: rich > 40, hasPoor: poor > 40 };
  // dots
  const fdots = [], pdots = [];
  for (let c = 0; c < n; c++) { if (cov[c]) continue; const xc = (c % cols) * CS, yc = Math.floor(c / cols) * CS; for (const [arr, m, k] of [[fdots, F.food[c] / 40, 0.08], [pdots, F.poison[c] / 40, 0.009]]) { let q = m * k; while (q > 0) { if (rng() < Math.min(1, q)) arr.push([Math.round(xc + rng() * CS), Math.round(yc + rng() * CS)]); q -= 1; } } }
  // inset at live-viewer zoom
  const [ix, iy] = spec.inset.at.map((v) => v * 1000), IW = 3000, IH = 2000, x0 = ix - IW / 2, y0 = iy - IH / 2, ic = IW / IC, ir = IH / IC;
  const ins = {}; for (const k of ["food", "poison", "mud", "firm", "depth"]) ins[k] = new Uint8Array(ic * ir);
  for (let cy = 0; cy < ir; cy++) for (let cx = 0; cx < ic; cx++) { const f = field(x0 + (cx + 0.5) * IC, y0 + (cy + 0.5) * IC), c = cy * ic + cx; ins.food[c] = Math.round(clamp(f.food * 40, 0, 255)); ins.poison[c] = Math.round(clamp(f.poison * 40, 0, 255)); ins.mud[c] = Math.round(f.mud * 255); ins.firm[c] = Math.round(f.firm * 255); ins.depth[c] = Math.round(f.depth * 255); }
  const imc = IW / IM, imr = IH / IM, IMk = new Uint8Array(imc * imr);
  for (let cy = 0; cy < imr; cy++) for (let cx = 0; cx < imc; cx++) { let q = 0; for (const m of massifs) q = Math.max(q, m.v(x0 + (cx + 0.5) * IM, y0 + (cy + 0.5) * IM)); IMk[cy * imc + cx] = Math.round(q * 255); }
  const inStones = stones.filter((s) => s.p.some(([x, y]) => x > x0 - 300 && x < x0 + IW + 300 && y > y0 - 300 && y < y0 + IH + 300)).map((s) => s.p);
  const inF = [], inP = [], crs = [];
  const insF = (x, y) => ins.food[Math.floor(y / IC) * ic + Math.floor(x / IC)] / 40, insP = (x, y) => ins.poison[Math.floor(y / IC) * ic + Math.floor(x / IC)] / 40;
  for (let cy = 0; cy < IH / CS; cy++) for (let cx = 0; cx < IW / CS; cx++) for (const [arr, m, k] of [[inF, insF(cx * CS, cy * CS), 0.4], [inP, insP(cx * CS, cy * CS), 0.045]]) { let q = m * k; while (q > 0) { if (rng() < Math.min(1, q)) arr.push([Math.round(cx * CS + rng() * CS), Math.round(cy * CS + rng() * CS)]); q -= 1; } }
  for (let t = 0, k = 0; k < 8 && t < 600; t++) { const x = 150 + rng() * (IW - 300), y = 150 + rng() * (IH - 300), f = field(x0 + x, y0 + y); if (f.mud > 0.45 || IMk[Math.floor(y / IM) * imc + Math.floor(x / IM)] > 90) continue; if (stones.some((s) => s.d.some(([sx, sy, sr]) => Math.hypot(sx - x0 - x, sy - y0 - y) < sr + 40))) continue; crs.push([Math.round(x), Math.round(y), +(rng() * 6.28).toFixed(2), Math.round(rng() * 360)]); k++; }
  const b64 = (u8) => Buffer.from(u8).toString("base64");
  const data = { cols, rows, CS, mcols, mrows, MC, ground: Object.fromEntries(Object.entries(F).map(([k, v]) => [k, b64(v)])), M: b64(M), stones: stones.map((s) => s.p), fdots, pdots, inset: { at: [x0, y0], w: IW, h: IH, ic, ir, imc, imr, ground: Object.fromEntries(Object.entries(ins).map(([k, v]) => [k, b64(v)])), M: b64(IMk), stones: inStones, f: inF, p: inP, cr: crs } };
  return { stats, data };
}

for (const spec of specs) {
  if (only.length && !only.includes(String(spec.n))) continue;
  const { stats, data } = build(spec);
  writeFileSync(`${outDir}/map-${spec.n}.json`, JSON.stringify({ ...spec, stats }, null, 1));
  writeFileSync(`${outDir}/map-${spec.n}.data.js`, "window.DATA=" + JSON.stringify({ spec, stats, ...data }) + ";");
  console.log(spec.n, spec.title, JSON.stringify(stats), "rss MB", Math.round(process.memoryUsage().rss / 1e6));
}
