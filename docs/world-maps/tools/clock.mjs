// usage: node clock.mjs > src/typescript/src/sim/maps/clock.ts
// The clock map: six biome realms on a ring around a common hub, apart by ashen badlands, joined to the hub by thin trails.
// Written in world units at the final size, so no to-engine scaling.

// parameters
const W = 60000, H = 37500, CX = W / 2, CY = H / 2;
const HUB = { rx: 7500, ry: 6600, food: 1.5 };
// per realm: radii, silhouette features [angle deg, amplitude, width deg] (lobes positive, bays negative)
const SIZE = {
  blight: { rx: 6500, ry: 3350, f: [[200, 0.2, 28], [320, -0.2, 22], [90, 0.12, 30]] },
  mire: { rx: 6600, ry: 3800, b: 0.96, f: [[20, 0.1, 24], [105, -0.14, 26], [190, 0.12, 28], [275, -0.12, 26]] }, // calm marsh: four broad swells
  bloom: { rx: 6500, ry: 3350, b: 0.8, f: [[8, 0.3, 20], [60, 0.2, 18], [112, 0.32, 20], [165, 0.22, 18], [225, 0.12, 20], [285, 0.3, 20], [335, 0.2, 18]] }, // fuller meadow: broad lobes, no bays
  flats: { rx: 6500, ry: 3350, f: [[70, -0.22, 26], [180, 0.2, 32], [300, 0.03, 20], [240, 0.12, 25]] },
  steppe: { rx: 6600, ry: 3800, f: [[180, 0.22, 28], [75, -0.2, 20], [285, -0.2, 20], [125, 0.16, 20], [235, 0.18, 20], [0, 0.04, 30]] },
  crags: { rx: 6500, ry: 3350, f: [[250, 0.0, 26], [20, -0.2, 24], [140, 0.16, 28]] },
};
const POS = { dx: 10600, dy: 11600, sx: 20270, sxWest: 19200 }; // realm centres from the hub centre: diagonals at (+-dx, +-dy), sides at (sx, 0) and (-sxWest, 0); the Mire sits further out for a longer trail (it was invaded most)
const DIAL = { rx: 28990, ry: 17900 }; // faint dial ring with twelve hour marks, inside the map edge, framing the realms
const WASTE = { food: 0.05, poison: 0.05 }; // base food and poison of the wastes
const TRAIL = { food: 0.5, w: 1000 };
const SEED = 2026;

let rs = SEED;
const rnd = () => ((rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296);
const R = Math.round;
const blob = (cx, cy, rx, ry, n = 12, irr = 0.22, rot = 0) => {
  const pts = [], a0 = rnd() * 6.28, c = Math.cos(rot), s = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const a = a0 + (2 * Math.PI * i) / n + (rnd() - 0.5) * 0.3, f = 1 + (rnd() - 0.5) * 2 * irr;
    const x = rx * f * Math.cos(a), y = ry * f * Math.sin(a);
    pts.push([R(cx + x * c - y * s), R(cy + x * s + y * c)]);
  }
  return pts;
};
// smooth organic outline: a few low harmonics, no kinks
const smooth = (cx, cy, rx, ry, amp, n = 48) => {
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n, f = 1 + amp * (0.5 * Math.sin(2 * a + ph[0]) + 0.35 * Math.sin(3 * a + ph[1]) + 0.25 * Math.sin(5 * a + ph[2]));
    return [R(cx + rx * f * Math.cos(a)), R(cy + ry * f * Math.sin(a))];
  });
};
const poly = (pts) => ({ type: "poly", pts });
const path = (pts, w) => ({ type: "path", path: pts.map(([x, y]) => [R(x), R(y)]), w });
const layer = (id, shape, o = {}) => ({ id, shape, warp: 900, rough: 220, feather: 1200, ...o });
const rock = (id, kind, shape, o = {}) => ({ id, kind, shape, warp: 900, rough: 220, feather: kind === "massif" ? 800 : 1500, cover: 0, ...o });
const paint = (rgb, alpha) => ({ paint: { rgb, alpha } });
const dsat = (c, k = 0.88) => { const l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; return c.map((v) => R(l + (v - l) * k)); }; // less saturated, one abyssal world
// organic silhouette: an ellipse with a few Gaussian lobes and bays, star-shaped around the centre
const lobed = (rx, ry, feats, b = 1, n = 56) => {
  const ph = rnd() * 6.28;
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    let f = b + 0.03 * Math.sin(3 * a + ph);
    for (const [d, amp, w] of feats) { let dd = Math.abs(a - (d * Math.PI) / 180) % (2 * Math.PI); if (dd > Math.PI) dd = 2 * Math.PI - dd; f += amp * Math.exp(-((dd / ((w * Math.PI) / 180)) ** 2)); }
    return [R(rx * f * Math.cos(a)), R(ry * f * Math.sin(a))];
  });
};
const grow = (pts, cx, cy, k) => pts.map(([x, y]) => [R(cx + (x - cx) * k), R(cy + (y - cy) * k)]);
// distance from (cx, cy) along the unit direction (ux, uy) to the far crossing of a star-shaped polygon
const exit = (pts, cx, cy, ux, uy) => {
  let best = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length], ex = x2 - x1, ey = y2 - y1;
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((x1 - cx) * ey - (y1 - cy) * ex) / den, s = ((x1 - cx) * uy - (y1 - cy) * ux) / den;
    if (s >= 0 && s <= 1 && t > best) best = t;
  }
  return best;
};

const layers = [], rocks = [], regions = [];
// Founder colours: six hues about 60 degrees apart, each picked to stand out on its own realm's paint (Erik: very distinct groups).
const HUES = { blight: 55, mire: 320, bloom: 0, flats: 240, steppe: 185, crags: 120 }; // founder colours; clear of food green (142) and poison magenta (291)

// the abyss: ashen badlands floor
layers.push(layer("waste", poly([[-2000, -2000], [W / 2, -2500], [W + 2000, -2000], [W + 2500, H / 2], [W + 2000, H + 2000], [W / 2, H + 2500], [-2000, H + 2000], [-2500, H / 2]]), { warp: 0, feather: 0, food: WASTE.food, poison: WASTE.poison, ...paint([52, 45, 42], 0.46) }));

// the dial: a faint paint-only ring outside the realms with twelve hour marks (short paint ticks, a cairn pair at 12, 3, 6, 9), so the map reads as a clock without text
{
  const el = (a, k = 1) => [CX + DIAL.rx * k * Math.cos(a), CY + DIAL.ry * k * Math.sin(a)];
  layers.push(layer("dial-ring", poly(Array.from({ length: 64 }, (_, i) => el((2 * Math.PI * i) / 64).map(R))), { warp: 0, rough: 0, band: 170, feather: 260, ...paint([170, 185, 175], 0.17) }));
  for (let h = 0; h < 12; h++) {
    const a = -Math.PI / 2 + (h * Math.PI) / 6, major = h % 3 === 0, k0 = major ? 0.952 : 0.972, k1 = major ? 1.014 : 1.012;
    layers.push(layer(`dial-tick${h}`, path([el(a, k0), el(a, k1)], [major ? 440 : 340, major ? 440 : 340]), { warp: 0, rough: 0, feather: 60, ...paint([190, 205, 195], major ? 0.42 : 0.32) }));
  }
}

// layout: every trail LEN long from the hub rim to the realm rim. Centre = hub + direction x (hub radius + LEN + realm radius back along the trail).
const hubPts = smooth(CX, CY, HUB.rx, HUB.ry, 0.05);
const DEFS = [["blight", "The Blight", -1, 1], ["mire", "The Mire", 0, 1], ["bloom", "The Bloom", 1, 1], ["flats", "The Flats", 1, -1], ["steppe", "The Steppe", 0, -1], ["crags", "The Crags", -1, -1]];
const RM = {};
const SHAPES = Object.fromEntries(DEFS.map(([id]) => [id, lobed(SIZE[id].rx, SIZE[id].ry, SIZE[id].f, SIZE[id].b)]));
for (const [id, title, sy, sx] of DEFS) {
  const S = SIZE[id], RX = S.rx, RY = S.ry, shape = SHAPES[id];
  const x = sy === 0 ? CX + sx * (sx > 0 ? POS.sx : POS.sxWest) : CX + sx * POS.dx, y = CY + sy * (sy === 0 ? 0 : POS.dy), deg = (Math.atan2(y - CY, x - CX) * 180) / Math.PI;
  const pts = shape.map(([px, py]) => [R(x + px), R(y + py)]);
  RM[id] = { id, title, deg, x, y, rx: RX, ry: RY, pts };
  regions.push({ id, title, x: R(x), y: R(y), r: R(Math.min(RX, RY) * 0.86), hue: HUES[id] }); // r: the realm's core, classifies a creature and (scaled down) seeds founders
}

// trails: thin winding tracks, not firm, from inside the hub rim to inside the realm rim; ends follow the real outlines. Drawn first so realms and hub keep their own food
const gate = {}, trailPts = [], report = [];
for (const id of Object.keys(RM)) {
  const m = RM[id], dx = CX - m.x, dy = CY - m.y, dl = Math.hypot(dx, dy), ux = dx / dl, uy = dy / dl;
  const tr = exit(m.pts, m.x, m.y, ux, uy), th = exit(hubPts, CX, CY, -ux, -uy);
  report.push(`${id} deg ${m.deg.toFixed(1)} centre ${R(m.x)},${R(m.y)} trail rim-to-rim ${R(dl - tr - th)}`);
  const a = [CX - ux * (th + 420), CY - uy * (th + 420)], b = [m.x + ux * (tr + 420), m.y + uy * (tr + 420)];
  const n = 9, ddx = b[0] - a[0], ddy = b[1] - a[1], len = Math.hypot(ddx, ddy), px = -ddy / len, py = ddx / len;
  const bend = m.deg > 90 || m.deg < -90 ? -1 : 1, pts = [];
  for (let i = 0; i < n; i++) { const t = i / (n - 1), off = bend * 310 * Math.sin(t * Math.PI * 2.6) * Math.sin(t * Math.PI); pts.push([a[0] + ddx * t + px * off, a[1] + ddy * t + py * off]); }
  trailPts.push(...pts);
  gate[id] = Math.atan2(a[1] - m.y, a[0] - m.x);
  const ws = pts.map((_, i) => R(TRAIL.w - (i / (n - 1)) * 250)); // 1000 at the hub down to 750 at the realm
  layers.push(layer(`trail-${id}`, path(pts, ws), { warp: 0, rough: 90, feather: 450, food: TRAIL.food, clearMud: true, wobble: 0.125, ...paint([190, 176, 132], 0.32) }));
  layers.push(layer(`trail-${id}-line`, path(pts, ws.map((w) => R(w * 0.6))), { warp: 0, rough: 40, feather: 200, ...paint([240, 224, 176], 0.68) }));
}
// distance from a point to the trails (sampled), so badland features keep clear of them
const nearTrail = (x, y) => Math.min(...trailPts.map(([tx, ty]) => Math.hypot(tx - x, ty - y)));

// badland features per gap between neighbouring realms: a large spur and a short one inside stone fields, a stone cluster and scorch hazes, denser near the realms
const order = ["blight", "mire", "bloom", "flats", "steppe", "crags"];
order.forEach((id, gi) => {
  const A = RM[id], B = RM[order[(gi + 1) % 6]], gx = B.x - A.x, gy = B.y - A.y, gl = Math.hypot(gx, gy), ex = gx / gl, ey = gy / gl;
  // t runs 0..1 over the clear ground between the two rims
  const ta = exit(A.pts, A.x, A.y, ex, ey), tb = exit(B.pts, B.x, B.y, -ex, -ey), t0 = ta / gl, t1 = 1 - tb / gl;
  const along = (t, off = 0) => [A.x + gx * (t0 + (t1 - t0) * t) - ey * off, A.y + gy * (t0 + (t1 - t0) * t) + ex * off];
  const dense = (p) => p.flatMap((q, i) => { const r = p[(i + 1) % p.length]; return [0, 1, 2, 3].map((k) => [q[0] + ((r[0] - q[0]) * k) / 4, q[1] + ((r[1] - q[1]) * k) / 4]); });
  const da = dense(A.pts), db = dense(B.pts);
  report.push(`gap ${id}-${order[(gi + 1) % 6]} rim-to-rim ${R(gl - ta - tb)} outline ${R(Math.min(...da.map(([x, y]) => Math.min(...db.map(([u, v]) => Math.hypot(x - u, y - v))))))}`);
  const rot = Math.atan2(ex, -ey) + (rnd() - 0.5) * 0.5;
  // few, larger, varied features per gap, fading into the scorch haze: even gaps one long low ridge plus a small companion, odd gaps a broken arc
  const kk = Math.min(1, (gl - ta - tb) / 6500);
  // low slender weathered spines: each ridge is a few short segments with small gaps, blunt ends
  const ridge = (t, off, tilt, L, sw, bowAmt, tag, cuts) => {
    const [x, y] = along(t, off * kk), r = rot + tilt, c = Math.cos(r), s = Math.sin(r);
    const prof = (u) => 1 - (2 * u) ** 2, wAt = (u) => Math.max(0.55, 1 - (2 * u) ** 4) * sw[2];
    cuts.forEach(([u0, u1], j) => {
      const us = [0, 1, 2, 3].map((i) => u0 + ((u1 - u0) * i) / 3);
      const sp = us.map((u) => [x + u * L * kk * c - prof(u) * bowAmt * s, y + u * L * kk * s + prof(u) * bowAmt * c]);
      rocks.push(rock(`spur${gi}_${tag}${j}`, "massif", path(sp, us.map(wAt)), { warp: 250, rough: 40, feather: 500, wobble: 0.15, cover: 0 }));
    });
  };
  if (gi % 2 === 0) {
    ridge(0.5, (rnd() - 0.5) * 500, (rnd() - 0.5) * 0.3, 5800, [0, 0, 560], 900 * (gi % 4 ? 1 : -1) * 0.5, "a", [[-0.5, -0.2], [-0.13, 0.17], [0.25, 0.5]]);
    ridge(0.5, (gi % 4 ? -1 : 1) * (1900 + rnd() * 200), 0.35, 2800, [0, 0, 420], -150, "b", [[-0.5, -0.08], [0.06, 0.5]]);
  } else {
    const [ax, ay] = along(0.5, 0), cr = 3300 * kk, bend = gi % 4 === 1 ? 1 : -1;
    for (const [a0, a1, tag] of [[-1.0, -0.62, "a"], [-0.5, -0.12, "b"], [0.2, 0.52, "c"], [0.62, 0.95, "d"]]) {
      const pts2 = Array.from({ length: 4 }, (_, i) => { const q = a0 + ((a1 - a0) * i) / 3, px2 = -ey, py2 = ex; return [ax - ex * bend * cr * (1 - Math.cos(q)) + px2 * cr * Math.sin(q) * 1.2, ay - ey * bend * cr * (1 - Math.cos(q)) + py2 * cr * Math.sin(q) * 1.2]; });
      rocks.push(rock(`spur${gi}_arc${tag}`, "massif", path(pts2, [380, 520, 520, 380]), { warp: 250, rough: 40, feather: 500, wobble: 0.15, cover: 0 }));
    }
  }
  for (const [t, off] of [[0.3, 1700], [0.7, -1700], [0.5, 0]]) {
    const [px, py] = along(t, off);
    layers.push(layer(`scorch${gi}_${t}`, poly(blob(px, py, 2400 + rnd() * 700, 1600 + rnd() * 600, 10, 0.3, rnd() * 3)), { warp: 700, feather: 1500, ...paint([14, 11, 13], 0.4) }));
  }
});
{ // clearance of every realm outline to the dial ring
  for (const id of Object.keys(RM)) { let mn = 1e9; for (const [x, y] of RM[id].pts) for (let i = 0; i < 720; i++) { const a = (i / 720) * 2 * Math.PI; mn = Math.min(mn, Math.hypot(CX + DIAL.rx * Math.cos(a) - x, CY + DIAL.ry * Math.sin(a) - y)); } report.push(`dial clearance ${id} ${R(mn)}`); }
}
for (const l of report) console.error(l);

// the commons: a bright lit plain with an organic pale rim and a ring of eight standing blocks
layers.push(layer("commons-glow", poly(grow(hubPts, CX, CY, 1.04)), { warp: 0, rough: 0, band: 800, feather: 1500, ...paint([40, 170, 170], 0.22) }));
layers.push(layer("commons", poly(hubPts), { warp: 0, rough: 0, feather: 2600, food: HUB.food, poison: 0, clearMud: true, ...paint([31, 148, 146], 0.62) }));
layers.push(layer("commons-core", poly(blob(CX, CY, 4300, 3900, 16, 0.05)), { warp: 0, rough: 0, feather: 3000, food: 1.6, clearMud: true, ...paint([80, 210, 198], 0.5) }));
layers.push(layer("commons-core2", poly(blob(CX, CY, 2300, 2100, 16, 0.04)), { warp: 0, rough: 0, feather: 2200, ...paint([150, 245, 225], 0.34) }));
layers.push(layer("commons-rim", poly(grow(hubPts, CX, CY, 0.99)), { warp: 0, rough: 0, band: 190, feather: 380, ...paint([200, 240, 232], 0.42) }));
regions.push({ id: "commons", title: "The Commons", x: CX, y: CY, r: R(0.6 * HUB.ry) });
{
  const N = 8, hx = 3300, hy = 3000, hp = [], cum = [0];
  for (let i = 0; i <= 120; i++) { const a = (i / 120) * 2 * Math.PI; hp.push([CX + hx * Math.cos(a), CY + hy * Math.sin(a)]); if (i) cum.push(cum[i - 1] + Math.hypot(hp[i][0] - hp[i - 1][0], hp[i][1] - hp[i - 1][1])); }
  const at2 = (len) => { const i = cum.findIndex((c) => c >= len); return hp[Math.max(i, 0)]; }; // equal arc length gaps, so all blocks are the same length
  const passes = Array.from({ length: N }, (_, k) => { const [px, py] = at2(((k + 0.5) / N) * cum[120]); return [R(px), R(py), 520]; });
  rocks.push(rock("commons-henge", "massif", path(hp.filter((_, i) => i % 3 === 0 || i === 120).map((p) => p), hp.filter((_, i) => i % 3 === 0 || i === 120).map(() => 620)), { warp: 100, rough: 50, feather: 200, wobble: 0.1, passes }));
}

// a realm: fill, one consistent rim (thin light edge, soft outer glow in its own colour), optional partial wall with a gate towards the hub
const realm = (id, fill, o, glow, edge, extra, wall) => {
  const m = RM[id], { x, y, pts } = m, sh = { warp: 0, rough: 0 };
  layers.push(layer(`${id}-glow`, poly(pts), { ...sh, band: 800, feather: 1700, ...paint(dsat(glow[0]), glow[1] * 0.5) }));
  layers.push(layer(id, poly(pts), { clearMud: true, rough: 160, warp: 0, feather: 1000, ...paint(dsat(fill[0]), fill[1]), ...o }));
  layers.push(layer(`${id}-rim`, poly(pts), { ...sh, band: 150, feather: 300, ...paint(dsat(edge, 0.8), 0.25) }));
  extra(x, y);
  if (wall) {
    const g = gate[id], span = 2 * Math.PI * (wall === true ? 0.78 : wall), hw = Math.PI - span / 2, n = 32, wp = [], sw = [];
    for (let i = wall === true ? 2 : 0; i <= (wall === true ? n - 2 : n); i++) {
      const a = g + hw + (i / n) * span, ux = Math.cos(a), uy = Math.sin(a), t = exit(pts, x, y, ux, uy) * 0.97, u = Math.min(i, n - i) / n / 0.2, e = u >= 1 ? 1 : u * u * (3 - 2 * u); // inset from the rim glow; swells over the first and last 20% of the arc
      wp.push([x + ux * t, y + uy * t]); sw.push(R(30 + 330 * e + 15 * e * Math.sin(i * 1.7)));
    }
    layers.push(layer(`${id}-wall-shade`, path(wp, sw.map((w) => w * 2.2)), { warp: 0, rough: 0, feather: 500, taper: true, ...paint([14, 12, 16], 0.26) }));
    rocks.push(rock(`${id}-wall`, "massif", path(wp, sw), { warp: 40, rough: 20, feather: 200, wobble: 0.05, taper: true }));
  }
};

realm("blight", [[142, 70, 192], 0.45], { food: 2.0, poison: 3.8 }, [[120, 60, 175], 0.22], [210, 160, 245], (x, y) => {
  layers.push(layer("blight-heart", poly(blob(x, y, 1900, 1500, 10, 0.18)), { warp: 0, rough: 0, feather: 1000, food: 3.0, poison: 1.0, clearMud: true, ...paint([175, 105, 215], 0.2) }));
  for (const [dx, dy, rx, ry, rot] of [[1500, 900, 1700, 950, -0.3], [-3200, -700, 650, 420, 0.7], [-1300, -1500, 500, 380, -0.2], [3300, -900, 420, 300, 0.9], [-700, 1600, 380, 280, 0.1], [3000, 1500, 550, 350, 0.4]]) layers.push(layer(`blight-ash${dx}`, poly(blob(x + dx, y + dy, rx, ry, 10, 0.25, rot)), { warp: 0, rough: 60, feather: 120, ...paint([28, 8, 44], 0.46) }));
  // rocks.push(rock("blight-ash", "talus", poly(blob(x, y, 4500, 4000, 14, 0.1)), { cover: 0.012, clump: 1700, clumpLo: 0.5, clumpHi: 0.8, pow: 3, r: [70, 150] }));
}, true);
realm("mire", [[104, 108, 34], 0.48], { food: 2.3, poison: 0, mud: { coverage: 0.68, scale: 1300, deep: 2200 } }, [[100, 104, 36], 0.24], [190, 188, 104], (x, y) => {
  // three islets of different shapes, off-centre and not in a row
  for (const [dx, dy, rx, ry, rot] of [[-1500, 900, 1900, 750, -0.5], [1700, -1500, 900, 1100, 0.4], [2300, 1700, 600, 480, 0]]) {
    layers.push(layer(`mire-isle${dx}`, poly(blob(x + dx, y + dy, rx, ry, 12, 0.22, rot)), { warp: 300, rough: 150, feather: 450, food: 3.0, clearMud: true, ...paint([70, 150, 120], 0.34) }));
  }
}, 0.82);
realm("bloom", [[44, 190, 150], 0.38], { food: 3.2, poison: 0 }, [[47, 180, 145], 0.17], [160, 250, 210], (x, y) => {
  // petal pockets round a bright heart, joined by faint veins
  const pk = [[0, 0, 1700, 1400]];
  for (let i = 0; i < 6; i++) { const a = (i / 6) * 6.28 + 0.4, d = 2750 + (i % 2) * 300; pk.push([d * Math.cos(a), d * 0.82 * Math.sin(a), 800 + (i % 3) * 200, 650 + (i % 2) * 250]); }
  pk.forEach(([dx, dy, rx, ry], i) => {
    if (i) layers.push(layer(`bloom-vein${i}`, path([[x, y], [x + dx * 0.5 + dy * 0.08, y + dy * 0.5 - dx * 0.08], [x + dx, y + dy]], [230, 190, 150]), { warp: 0, rough: 0, feather: 300, taper: true, ...paint([170, 255, 210], 0.09) }));
    layers.push(layer(`bloom-bud${i}`, poly(blob(x + dx, y + dy, rx, ry, 10, 0.18)), { warp: 0, rough: 0, feather: 700, food: 3.98, ...paint([130, 245, 180], i ? 0.3 : 0.36) }));
  });
});
realm("flats", [[138, 118, 78], 0.2], { food: 1.1, poison: 0, firm: { coverage: 1, scale: 2600 }, edge: 700 }, [[175, 155, 105], 0.17], [225, 208, 160], (x, y) => {
  // soft dune bands: broad low-contrast paint gradient across the flats
  for (let i = 0; i < 5; i++) { const t = i - 2; layers.push(layer(`flats-dune${i}`, path([[x - 4800, y + t * 950 + 700], [x - 1500, y + t * 950 - 300], [x + 1800, y + t * 950 + 400], [x + 4800, y + t * 950 - 500]], [1000, 1500, 1400, 1000]), { warp: 300, rough: 100, feather: 900, taper: true, ...paint(i % 2 ? [205, 185, 130] : [110, 95, 60], i % 2 ? 0.16 : 0.14) })); }
  // landmark: three large standing blocks on a ring, drawn like the hub henge
  const rr = 1700, g = gate.flats, rp = Array.from({ length: 49 }, (_, i) => [x + rr * Math.cos((i / 48) * 2 * Math.PI), y + rr * Math.sin((i / 48) * 2 * Math.PI)]);
  const passes = [0, 1, 2].map((k) => [R(x + rr * Math.cos(g + (k * 2 * Math.PI) / 3)), R(y + rr * Math.sin(g + (k * 2 * Math.PI) / 3)), 700]);
  rocks.push(rock("flats-ring", "massif", path(rp, rp.map(() => 760)), { warp: 60, rough: 40, feather: 160, wobble: 0.1, passes }));
}); 
realm("steppe", [[208, 160, 50], 0.47], { food: 0.95, poison: 0 }, [[196, 156, 60], 0.24], [245, 215, 125], (x, y) => {
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 6.28 + rnd() * 0.5, d = i === 0 ? 0 : 2600 + rnd() * 400;
    layers.push(layer(`oasis${i}`, poly(blob(x + d * Math.cos(a), y + d * 0.75 * Math.sin(a), 900 + rnd() * 300, 700 + rnd() * 200, 10, 0.25)), { warp: 0, rough: 0, feather: 1300, food: 3.6, ...paint([60, 170, 130], 0.34) }));
  }
});
realm("crags", [[104, 135, 185], 0.42], { food: 1.5, poison: 0 }, [[95, 120, 165], 0.24], [185, 205, 235], (x, y) => {
  const r1 = [[x - 3500, y + 900], [x - 1200, y - 500], [x + 1000, y - 1700], [x + 3300, y - 1000]];
  const r2 = [[x - 2700, y + 2400], [x - 300, y + 1900], [x + 1900, y + 1200], [x + 3300, y + 1700]];
  rocks.push(rock("crags-ridge", "massif", path(r1, [600, 880, 840, 560]), { wobble: 0.3, taper: true, passes: [[x - 1200, y - 500, 600], [x + 2200, y - 1400, 500]] }));
  rocks.push(rock("crags-ridge2", "massif", path(r2, [560, 740, 700, 520]), { wobble: 0.3, taper: true, passes: [[x + 400, y + 1700, 500]] }));
  for (const [i, p, w] of [[0, [[x - 2500, y + 1100], [x - 1700, y + 700]], [620, 700]], [1, [[x + 700, y - 1300], [x + 1800, y - 1900]], [560, 680]], [2, [[x + 1600, y + 1100], [x + 2700, y + 1500]], [600, 520]], [3, [[x - 800, y + 2500], [x + 400, y + 2300]], [540, 600]]]) rocks.push(rock(`crags-lump${i}`, "massif", path(p, w), { warp: 120, rough: 80, feather: 300, wobble: 0.3, taper: true, cover: 0 }));
});

// Region order is the seeding order (home h gets founder h of public/live-founders.json); Crags first keeps the Juggernaut as founder 0,
// whose plan a visitor's fresh brain starts from. Sorting here leaves every shape (and the random draws behind them) unchanged.
const ORDER = ["crags", "blight", "mire", "bloom", "flats", "steppe", "commons"];
regions.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
const spec = { name: "clock", title: "The Six Realms", seed: SEED, width: W, height: H, scale: 1, baseFood: WASTE.food, basePoison: WASTE.poison, layers, rock: rocks, regions };
const body = JSON.stringify(spec, (k, v) => (Array.isArray(v) && v.every((e) => typeof e === "number") ? `\u0000${JSON.stringify(v)}\u0000` : v), 1).replace(/"\\u0000(.*?)\\u0000"/g, "$1");
console.log(`import type { MapSpec } from "./mapBuild.ts";\n\n// The Six Realms: six biome realms on a ring around a shared hub, apart by ashen badlands and joined to it by thin trails.\n// Generated by docs/world-maps/tools/clock.mjs; edit that and regenerate.\nexport const CLOCK: MapSpec = ${body};`);
