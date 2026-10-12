(() => {
const D = window.DATA, SP = D.spec, ST = D.stats, [WW, HH] = SP.world;
const CW = 2400, CH = 2210, MX = 60, MY = 178, MW = 2280, S = MW / WW, MH = Math.round(HH * S);
const cv = document.getElementById("c"); cv.width = CW; cv.height = CH;
const ctx = cv.getContext("2d");
const SANS = '"Noto Sans CJK JP","DejaVu Sans",sans-serif', SERIF = '"Noto Serif CJK JP","DejaVu Serif",serif';
const dec = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
let seed = 777; const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const hash = (i, j, s = 0) => { let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 2147483647)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const sm = (x) => x * x * (3 - 2 * x);
const vn = (x, y, s = 0) => { const i = Math.floor(x), j = Math.floor(y), fx = sm(x - i), fy = sm(y - j); const a = hash(i, j, s), b = hash(i + 1, j, s), c = hash(i, j + 1, s), d = hash(i + 1, j + 1, s); return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy; };
function worley(x, y, cs, s) { const gx = Math.floor(x / cs), gy = Math.floor(y / cs); let f1 = 9, f2 = 9, id = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const cx = gx + i, cy = gy + j, px = (cx + hash(cx, cy, s)) * cs, py = (cy + hash(cx, cy, s + 5)) * cs, d = Math.hypot(px - x, py - y) / cs; if (d < f1) { f2 = f1; f1 = d; id = hash(cx, cy, s + 9); } else if (d < f2) f2 = d; } return [f1, f2, id]; }
function bl(a, cols, rows, fx, fy) { const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0; const xa = clamp(x0, 0, cols - 1), xb = clamp(x0 + 1, 0, cols - 1), ya = clamp(y0, 0, rows - 1), yb = clamp(y0 + 1, 0, rows - 1); return (a[ya * cols + xa] * (1 - tx) + a[ya * cols + xb] * tx) * (1 - ty) + (a[yb * cols + xa] * (1 - tx) + a[yb * cols + xb] * tx) * ty; }

const NORMAL = [24, 58, 44], LUSH = [32, 100, 62], OLIVE = [80, 84, 42], SAGE = [74, 106, 92], TOX = [126, 52, 118], WET = [20, 42, 32];
// Renders the ground of a window: unit origin (ox, oy), ppu pixels per unit, field grids g (food, poison, mud, firm, depth at cell size cs) and the massif mask grid.
function pixels(W, H, ox, oy, ppu, g, cols, rows, cs, M, mcols, mrows, mcs, cliffU) {
  const food = dec(g.food), pz = dec(g.poison), mud = dec(g.mud), firm = dec(g.firm), dep = dec(g.depth), Mk = dec(M);
  const cvs = document.createElement("canvas"); cvs.width = W; cvs.height = H; const c2 = cvs.getContext("2d"), img = c2.createImageData(W, H), d = img.data;
  const cliffPx = cliffU * ppu;
  const Mat = (wx, wy) => bl(Mk, mcols, mrows, wx / mcs - 0.5, wy / mcs - 0.5) / 255;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const wx = ox + (x + 0.5) / ppu, wy = oy + (y + 0.5) / ppu, fx = wx / cs - 0.5, fy = wy / cs - 0.5;
    const f = bl(food, cols, rows, fx, fy) / 40, p = bl(pz, cols, rows, fx, fy) / 40, mu = bl(mud, cols, rows, fx, fy) / 255, fi = bl(firm, cols, rows, fx, fy) / 255, dp = bl(dep, cols, rows, fx, fy) / 255;
    let col = NORMAL;
    if (f > 1) col = mix(col, LUSH, clamp((f - 1) / 1.2, 0, 1) * 0.95);
    col = SP.showPoor ? mix(col, OLIVE, clamp((1.3 - f) / 0.45, 0, 1) * 0.85) : (f < 1 ? mix(col, OLIVE, clamp((1 - f) / 0.35, 0, 1) * 0.3) : col);
    const fA = sstep(0.44, 0.56, fi), mA = sstep(0.44, 0.56, mu) * (1 - fA), wet = sstep(0.1, 0.44, mu) * (1 - mA) * (1 - fA);
    col = mix(col, WET, wet * 0.4);
    if (mA > 0) { let mc = mix([94, 88, 58], [70, 60, 40], clamp(dp / 0.6, 0, 1)); mc = mix(mc, [60, 82, 46], clamp((f - 1) / 3, 0, 0.3)); const rip = vn(wx / 110, wy / 26, 3) > 0.68 ? 0.86 : 1; col = mix(col, [mc[0] * rip, mc[1] * rip, mc[2] * rip], mA); }
    if (fA > 0) { const st = vn((wx + 0.3 * wy) / 230, wy / 24, 7) > 0.66 ? 14 : 0; const sg = mix(col, SAGE, 0.62); col = mix(col, [sg[0] + st, sg[1] + st, sg[2] + st], fA); }
    col = mix(col, TOX, clamp((p - 1.2) / 1.2, 0, 0.42));
    const n = 0.93 + 0.14 * (vn(wx / 340, wy / 340, 1) * 0.6 + vn(wx / 90, wy / 90, 2) * 0.4) + (hash(x, y) - 0.5) * 0.04;
    let r = col[0] * n, gg = col[1] * n, b = col[2] * n;
    const Mv = Mat(wx, wy);
    if (Mv > 0.01 || (cliffPx > 0 && Mat(wx, wy - cliffU * 2.4) > 0.5)) {
      const top = sstep(0.46, 0.54, Mv), Mc = Mat(wx, wy - cliffU);
      const cl = sstep(0.46, 0.54, Mc) * (1 - top), sh = sstep(0.46, 0.54, Mat(wx, wy - cliffU * 2.4)) * (1 - top) * (1 - cl);
      if (sh > 0) { r *= 1 - 0.3 * sh; gg *= 1 - 0.3 * sh; b *= 1 - 0.3 * sh; }
      if (cl > 0) { const v = 0.8 + 0.4 * vn(wx / 40, wy / 260, 4); r = r * (1 - cl) + 40 * v * cl; gg = gg * (1 - cl) + 52 * v * cl; b = b * (1 - cl) + 47 * v * cl; }
      if (top > 0) {
        const inn = clamp((Mv - 0.5) * 3, 0, 1), lit = Mat(wx - 60, wy - 60) - Mat(wx + 60, wy + 60);
        const [a1, a2, ida] = worley(wx, wy, 260, 11), [b1, b2, idb] = worley(wx, wy, 640, 21);
        const edge = (1 - inn) * (1 - sstep(0.02, 0.1, a2 - a1)) + inn * (1 - sstep(0.015, 0.06, b2 - b1));
        const idv = ida * (1 - inn) + idb * inn, base = 94 + 34 * (idv - 0.5) + 36 * clamp(lit * 3.2, -0.6, 0.8) - 14 * (wy > oy ? 0 : 0);
        const hi = 8 * (vn(wx / 80, wy / 80, 6) - 0.5), k = clamp(base + hi - 38 * edge * 0.3, 38, 190);
        r = r * (1 - top) + k * 1.0 * top; gg = gg * (1 - top) + k * 1.07 * top; b = b * (1 - top) + k * 1.02 * top;
      }
    }
    const o = (y * W + x) * 4; d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255;
  }
  c2.putImageData(img, 0, 0); return cvs;
}
function drawStones(g, list, ox, oy, sc, grow) {
  g.lineJoin = "round";
  const poly = (p, dx, dy, gr) => { let cx = 0, cy = 0; for (const [x, y] of p) { cx += x; cy += y; } cx /= p.length; cy /= p.length; g.beginPath(); p.forEach(([x, y], i) => { const px = ox + (cx + (x - cx) * gr) * sc + dx, py = oy + (cy + (y - cy) * gr) * sc + dy; if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.closePath(); };
  const area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; } return Math.abs(a) / 2; };
  g.fillStyle = "rgba(0,0,0,.32)"; for (const p of list) { poly(p, 1.3, 1.9, Math.max(grow, 3 / Math.max(1, Math.sqrt(area(p)) * sc))); g.fill(); }
  for (const p of list) {
    const gr = Math.max(grow, 3 / Math.max(1, Math.sqrt(area(p)) * sc)); poly(p, 0, 0, gr);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const [x, y] of p) { x0 = Math.min(x0, ox + x * sc); x1 = Math.max(x1, ox + x * sc); y0 = Math.min(y0, oy + y * sc); y1 = Math.max(y1, oy + y * sc); }
    const k = 0.86 + 0.28 * hash(Math.round(x0 * 7), Math.round(y0 * 7)), lg = g.createLinearGradient(x0, y0, x1, y1);
    lg.addColorStop(0, `rgb(${Math.min(255, 118 * k + 42)},${Math.min(255, 128 * k + 42)},${Math.min(255, 120 * k + 40)})`); lg.addColorStop(1, `rgb(${118 * k * 0.66},${128 * k * 0.66},${120 * k * 0.68})`);
    g.fillStyle = lg; g.fill(); g.strokeStyle = "rgba(14,24,20,.6)"; g.lineWidth = 0.9; g.stroke();
  }
}
function halo(g, t, x, y, w, fill) { g.lineJoin = "round"; g.lineWidth = w; g.strokeStyle = "rgba(4,16,10,.9)"; g.strokeText(t, x, y); g.fillStyle = fill; g.fillText(t, x, y); }

ctx.fillStyle = "#08150f"; ctx.fillRect(0, 0, CW, CH);
const bg = ctx.createRadialGradient(CW / 2, CH / 2, 200, CW / 2, CH / 2, 1600); bg.addColorStop(0, "#0d2219"); bg.addColorStop(1, "#050e0a"); ctx.fillStyle = bg; ctx.fillRect(0, 0, CW, CH);

const X = (x) => MX + x * S, Y = (y) => MY + y * S;
const mapC = pixels(MW, MH, 0, 0, S, D.ground, D.cols, D.rows, D.CS, D.M, D.mcols, D.mrows, D.MC, 150);
ctx.save(); ctx.beginPath(); ctx.roundRect(MX, MY, MW, MH, 14); ctx.clip();
ctx.drawImage(mapC, MX, MY);
ctx.strokeStyle = "rgba(200,255,225,.04)"; ctx.lineWidth = 1;
for (let g = 5000; g < WW; g += 5000) { ctx.beginPath(); ctx.moveTo(X(g), MY); ctx.lineTo(X(g), MY + MH); ctx.stroke(); }
for (let g = 5000; g < HH; g += 5000) { ctx.beginPath(); ctx.moveTo(MX, Y(g)); ctx.lineTo(MX + MW, Y(g)); ctx.stroke(); }
ctx.fillStyle = "rgba(160,255,195,.68)"; for (const [x, y] of D.fdots) ctx.fillRect(X(x), Y(y), 1.8, 1.8);
ctx.fillStyle = "rgba(205,100,160,.75)"; for (const [x, y] of D.pdots) ctx.fillRect(X(x) - 0.3, Y(y) - 0.3, 2.1, 2.1);
drawStones(ctx, D.stones, MX, MY, S, 1.12);
const I = D.inset; ctx.strokeStyle = "rgba(255,255,255,.92)"; ctx.lineWidth = 1.5; ctx.strokeRect(X(I.at[0]), Y(I.at[1]), I.w * S, I.h * S);
ctx.restore();
const vg = ctx.createRadialGradient(CW / 2, MY + MH / 2, MH * 0.5, CW / 2, MY + MH / 2, MW * 0.62); vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,.24)");
ctx.save(); ctx.beginPath(); ctx.roundRect(MX, MY, MW, MH, 14); ctx.clip(); ctx.fillStyle = vg; ctx.fillRect(MX, MY, MW, MH); ctx.restore();
ctx.strokeStyle = "#2c5744"; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(MX, MY, MW, MH, 14); ctx.stroke();
ctx.fillStyle = "#7fa592"; ctx.font = `13px ${SANS}`; ctx.textAlign = "center";
for (let g = 0; g <= WW; g += 5000) ctx.fillText(g / 1000 + "k", X(g), MY - 9);
ctx.textAlign = "right"; for (let g = 5000; g <= HH; g += 5000) ctx.fillText(g / 1000 + "k", MX - 8, Y(g) + 4);
ctx.textAlign = "center";
for (const L of SP.labels) {
  const x = X(L.at[0]), y = Y(L.at[1]);
  ctx.font = `700 ${Math.round(21 * L.size)}px ${SANS}`; ctx.letterSpacing = `${(2 * L.size).toFixed(1)}px`; halo(ctx, L.t.toUpperCase(), x, y, 6, "#f2fff7");
  if (L.sub) { ctx.letterSpacing = "0.3px"; ctx.font = `500 ${Math.round(15 * L.size)}px ${SANS}`; halo(ctx, L.sub, x, y + 21 * L.size, 5, "#d6f1e2"); }
  ctx.letterSpacing = "0px";
}
ctx.textAlign = "left"; ctx.fillStyle = "#3ddc97"; ctx.font = `600 17px ${SANS}`; ctx.letterSpacing = "3px"; ctx.fillText(`LIVE WORLD · MAP ${SP.n}`, MX, 50); ctx.letterSpacing = "0px";
ctx.fillStyle = "#e6f4ea"; ctx.font = `700 50px ${SERIF}`; ctx.fillText(SP.title, MX, 100);
ctx.fillStyle = "#8fae9f"; ctx.font = `400 20px ${SANS}`; ctx.fillText(SP.tagline, MX, 132);
{ const cx = MX + MW - 40, cy = 62; ctx.strokeStyle = "#8fae9f"; ctx.fillStyle = "#8fae9f"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx, cy + 22); ctx.lineTo(cx, cy - 18); ctx.stroke(); ctx.beginPath(); ctx.moveTo(cx, cy - 22); ctx.lineTo(cx - 7, cy - 6); ctx.lineTo(cx + 7, cy - 6); ctx.closePath(); ctx.fill(); ctx.textAlign = "center"; ctx.font = `600 14px ${SANS}`; ctx.fillText("N", cx, cy + 40); }
{ const bx = MX + 6, by = MY + MH + 26, L = 5000 * S; ctx.strokeStyle = "#e6f4ea"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(bx, by + 6); ctx.lineTo(bx, by - 2); ctx.lineTo(bx + L, by - 2); ctx.lineTo(bx + L, by + 6); ctx.moveTo(bx + L / 2, by - 2); ctx.lineTo(bx + L / 2, by + 3); ctx.stroke(); ctx.fillStyle = "#e6f4ea"; ctx.font = `500 14px ${SANS}`; ctx.textAlign = "left"; ctx.fillText("5 000 units", bx + L + 12, by + 4); ctx.fillStyle = "#8fae9f"; ctx.font = `400 13px ${SANS}`; ctx.fillText(`Map 54 000 × 33 600 units, 10.3× today's Live World (17 000 × 10 600). White box = inset area. Rock drawn slightly enlarged.`, bx + L + 140, by + 4); }

const FY = MY + MH + 80;
const items = [["Open ground", (g) => { g.fillStyle = "#183a2c"; g.fillRect(0, 0, 36, 24); }]];
if (ST.hasRich) items.push(["Rich food", (g) => { g.fillStyle = "#20623e"; g.fillRect(0, 0, 36, 24); g.fillStyle = "rgba(150,245,185,.8)"; for (let i = 0; i < 9; i++) g.fillRect(4 + (i * 11) % 30, 4 + ((i * 7) % 16), 2, 2); }]);
if (SP.showPoor) items.push(["Dry ground, poor food", (g) => { g.fillStyle = "#4a5030"; g.fillRect(0, 0, 36, 24); }]);
if (ST.hasPoison) items.push(["Poison", (g) => { g.fillStyle = "#3f2c3d"; g.fillRect(0, 0, 36, 24); g.fillStyle = "rgba(205,100,160,.9)"; for (let i = 0; i < 9; i++) g.fillRect(4 + (i * 13) % 30, 4 + ((i * 5) % 16), 2.5, 2.5); }]);
if (ST.mud > 0) items.push(["Mud, half speed (shallows lighter)", (g) => { const gr = g.createLinearGradient(0, 0, 36, 0); gr.addColorStop(0, "#5e583a"); gr.addColorStop(1, "#463c28"); g.fillStyle = gr; g.fillRect(0, 0, 36, 24); }]);
if (ST.firm > 0) items.push(["Firm ground, 1.75× speed", (g) => { g.fillStyle = "#3f6252"; g.fillRect(0, 0, 36, 24); g.strokeStyle = "rgba(215,235,215,.45)"; for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(4, 5 + i * 5); g.lineTo(26, 3 + i * 5); g.stroke(); } }]);
items.push(["Rock", (g) => { g.fillStyle = "#183a2c"; g.fillRect(0, 0, 36, 24); g.fillStyle = "#7e8a82"; g.beginPath(); g.moveTo(6, 16); g.lineTo(11, 6); g.lineTo(22, 4); g.lineTo(30, 12); g.lineTo(24, 20); g.lineTo(11, 21); g.closePath(); g.fill(); }]);
ctx.fillStyle = "#3ddc97"; ctx.font = `600 14px ${SANS}`; ctx.letterSpacing = "2px"; ctx.textAlign = "left"; ctx.fillText("LEGEND", MX, FY); ctx.letterSpacing = "0px";
items.forEach(([name, draw], i) => { const x = MX, y = FY + 18 + i * 40; ctx.save(); ctx.translate(x, y); ctx.beginPath(); ctx.roundRect(0, 0, 36, 24, 5); ctx.clip(); draw(ctx); ctx.restore(); ctx.strokeStyle = "#2c5744"; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x, y, 36, 24, 5); ctx.stroke(); ctx.fillStyle = "#cfe6d9"; ctx.font = `500 15px ${SANS}`; ctx.fillText(name, x + 48, y + 17); });
const TX = 620; let ty = FY;
ctx.fillStyle = "#3ddc97"; ctx.font = `600 14px ${SANS}`; ctx.letterSpacing = "2px"; ctx.fillText("REGIONS (food and poison relative to a plain 1.0)", TX, ty); ctx.letterSpacing = "0px";
const cols = [0, 205, 295, 385, 625], hdr = ["Region", "Food", "Poison", "Ground", "Role"];
ty += 30; ctx.fillStyle = "#8fae9f"; ctx.font = `600 14px ${SANS}`; hdr.forEach((h, i) => ctx.fillText(h, TX + cols[i], ty));
ctx.strokeStyle = "#1d3d30"; ctx.beginPath(); ctx.moveTo(TX, ty + 8); ctx.lineTo(TX + 880, ty + 8); ctx.stroke();
SP.table.forEach((r, k) => { const y = ty + 34 + k * 34; ctx.font = `600 15px ${SANS}`; ctx.fillStyle = "#e6f4ea"; ctx.fillText(r[0], TX + cols[0], y); ctx.font = `400 15px ${SANS}`; ctx.fillStyle = "#cfe6d9"; r.slice(1).forEach((v, i) => ctx.fillText(v === "none" ? "no poison" : v, TX + cols[i + 1], y)); });
const ty2 = ty + 34 + SP.table.length * 34 + 22, pct = (v) => Math.round(v * 100) + "%";
ctx.fillStyle = "#3ddc97"; ctx.font = `600 14px ${SANS}`; ctx.letterSpacing = "2px"; ctx.fillText("GROUND SHARES", TX, ty2); ctx.letterSpacing = "0px";
[["Normal", ST.normalGround], ["Mud", ST.mud], ["Firm", ST.firm], ["Rock", ST.rockCover]].forEach(([n, v], i) => { const x = TX + i * 110; ctx.fillStyle = "#e6f4ea"; ctx.font = `700 26px ${SANS}`; ctx.fillText(pct(v), x, ty2 + 34); ctx.fillStyle = "#8fae9f"; ctx.font = `400 13px ${SANS}`; ctx.fillText(n, x, ty2 + 54); });
ctx.fillStyle = "#8fae9f"; ctx.font = `400 13px ${SANS}`; ctx.fillText(`${ST.rockDiscs.toLocaleString("en")} rock discs (massifs estimated) · mean food ×${ST.meanFood.toFixed(2)} · mean poison ×${ST.meanPoison.toFixed(2)}`, TX + 470, ty2 + 22); ctx.fillText("Food and poison dots on the map are illustrative.", TX + 470, ty2 + 42);

{ const IX = 1620, IY = FY - 8, IWp = 720, IHp = 480, sc = IWp / I.w;
  ctx.fillStyle = "#3ddc97"; ctx.font = `600 14px ${SANS}`; ctx.letterSpacing = "2px"; ctx.textAlign = "left"; ctx.fillText("INSET AT VIEWER ZOOM", IX, IY - 6); ctx.letterSpacing = "0px";
  ctx.fillStyle = "#8fae9f"; ctx.font = `400 13px ${SANS}`; ctx.textAlign = "right"; ctx.fillText("3 000 × 2 000 units, creatures 12 units in radius", IX + IWp, IY - 6); ctx.textAlign = "left";
  const ic = pixels(IWp, IHp, 0, 0, sc, I.ground, I.ic, I.ir, 20, I.M, I.imc, I.imr, 10, 150);
  ctx.save(); ctx.beginPath(); ctx.roundRect(IX, IY, IWp, IHp, 10); ctx.clip(); ctx.drawImage(ic, IX, IY);
  ctx.fillStyle = "rgba(150,245,185,.95)"; for (const [x, y] of I.f) { ctx.beginPath(); ctx.arc(IX + x * sc, IY + y * sc, 1.7, 0, 7); ctx.fill(); }
  ctx.fillStyle = "rgba(215,105,170,.95)"; for (const [x, y] of I.p) { ctx.beginPath(); ctx.arc(IX + x * sc, IY + y * sc, 2.1, 0, 7); ctx.fill(); }
  drawStones(ctx, I.stones.map((p) => p.map(([x, y]) => [x - I.at[0], y - I.at[1]])), IX, IY, sc, 1.0);
  I.cr.forEach(([x, y, a, hue], k) => { const cx = IX + x * sc, cy = IY + y * sc, r = Math.max(12 * sc, 3.6);
    if (k === 0) { ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1; for (let j = 0; j < 8; j++) { const aa = a - (125 * Math.PI) / 360 + ((125 * Math.PI) / 180) * (j / 7); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(aa) * 150 * sc, cy + Math.sin(aa) * 150 * sc); ctx.stroke(); } }
    ctx.fillStyle = `hsl(${hue} 70% 62%)`; ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill(); ctx.stroke(); ctx.strokeStyle = "#fff"; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * r * 1.5, cy + Math.sin(a) * r * 1.5); ctx.stroke(); });
  ctx.restore(); ctx.strokeStyle = "#ffffffcc"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.roundRect(IX, IY, IWp, IHp, 10); ctx.stroke();
  const bl2 = 500 * sc; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(IX + 16, IY + IHp - 16); ctx.lineTo(IX + 16 + bl2, IY + IHp - 16); ctx.stroke(); ctx.textAlign = "left"; ctx.font = `600 13px ${SANS}`; halo(ctx, "500 units", IX + 16, IY + IHp - 24, 4, "#fff");
}
document.title = "done";
})();
