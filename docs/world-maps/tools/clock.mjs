// usage: node clock.mjs > src/typescript/src/sim/maps/clock.ts
// The clock map: six biome realms around a common hub, apart by ashen volcanic badlands with lava flows, joined to the hub by worn trails.
// Each realm is drawn as its own material (paint textures from mapBuild: blobs, veins, plates), seated in a dark hollow with ragged ecotone fringes instead of rims.
// Written in world units at the final size, so no to-engine scaling.

// parameters
const W = 60000, H = 37500, CX = W / 2, CY = H / 2;
const HUB = { rx: 7500, ry: 6600, food: 1.2 };
const GROW = Math.sqrt(1.15); // realms 15% bigger in area than round 9
// per realm: radii, silhouette features [angle deg, amplitude, width deg] (lobes positive, bays negative)
const SIZE = {
  blight: { rx: 6500, ry: 3350, f: [[200, 0.2, 28], [320, -0.2, 22], [90, 0.12, 30]] },
  mire: { rx: 6600, ry: 3800, b: 0.96, f: [[20, 0.1, 24], [105, -0.14, 26], [190, 0.12, 28], [275, -0.12, 26]] },
  bloom: { rx: 6500, ry: 3350, b: 0.8, f: [[8, 0.3, 20], [60, 0.2, 18], [112, 0.32, 20], [165, 0.22, 18], [225, 0.12, 20], [285, 0.3, 20], [335, 0.2, 18]] },
  flats: { rx: 6500, ry: 3350, f: [[70, -0.22, 26], [180, 0.2, 32], [300, 0.03, 20], [240, 0.12, 25]] },
  steppe: { rx: 6600, ry: 3800, f: [[180, 0.22, 28], [75, -0.2, 20], [285, -0.2, 20], [125, 0.16, 20], [235, 0.18, 20], [0, 0.04, 30]] },
  crags: { rx: 6500, ry: 3350, f: [[250, 0.0, 26], [20, -0.2, 24], [140, 0.16, 28]] },
};
// where each realm lies, as found land rather than a dial: bearing from the hub (deg, 0 east, 90 south), trail length rim to rim, tilt of its shape (rad), size factor.
// Bearings and tilts are uneven on purpose; trail lengths stay close so every realm is about equally far from the hub (the Mire, invaded most, a little further).
const PLACE = process.env.PLACE ? JSON.parse(process.env.PLACE) : {
  blight: { ang: -41.3, len: 4782, rot: 0.18, k: 1.03 },
  mire: { ang: 10.0, len: 6000, rot: 0.02, k: 1.01 },
  bloom: { ang: 61.3, len: 5571, rot: -0.11, k: 1.0 },
  flats: { ang: 139.9, len: 5779, rot: -0.3, k: 0.98 },
  steppe: { ang: 187.7, len: 5445, rot: 0.29, k: 0.97 },
  crags: { ang: -124.4, len: 4795, rot: 0.26, k: 1.0 },
};
// Food weights are stored in steps of 1/64 (WEIGHT_UNIT): 0.0875 is stored as 6/64, twice the 3/64 that 0.05 gave (Erik 2026-11-12: more life between the realms).
const WASTE = { food: 0.0875, poison: 0.05 };
const TRAIL = { food: 0.25, w: 1000 };
// where each trail leaves the hub and enters its realm, turned off the line between their centres (deg: hub side, realm side), so the trails
// run slanted or offset instead of as spokes; small on the walled realms' side, so the trail meets the gate head on
const SKEW = { blight: [18, -10], mire: [-14, 6], bloom: [12, 8], flats: [-20, 14], steppe: [-8, -10], crags: [-22, 12] };
const OUTLINE_ROUGH = 0.05;
const EMBER = [176, 66, 30]; // the glow in the lava fissures, dimmed so orange and red creatures still stand out
// Erik's direction: the realms' colours a quarter of the way towards designer 2's saturated palette (their fill colour and opacity, before desaturation)
const BRIGHTER = 0.25;
const D2 = { blight: [[142, 70, 192], 0.82], mire: [[100, 106, 34], 0.82], bloom: [[44, 140, 78], 0.82], flats: [[150, 128, 84], 0.7], steppe: [[198, 152, 52], 0.8], crags: [[96, 128, 186], 0.8], commons: [[28, 140, 138], 0.86] };
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
const poly = (pts) => ({ type: "poly", pts });
const path = (pts, w) => ({ type: "path", path: pts.map(([x, y]) => [R(x), R(y)]), w });
const layer = (id, shape, o = {}) => ({ id, shape, warp: 900, rough: 220, feather: 1200, ...o });
const rock = (id, kind, shape, o = {}) => ({ id, kind, shape, warp: 900, rough: 220, feather: kind === "massif" ? 800 : 1500, cover: 0, ...o });
const paint = (rgb, alpha, tex, o = {}) => ({ paint: { rgb, alpha, ...(tex ? { tex } : {}), ...o } });
const tex = (pattern, scale, cover, rgb, alpha, o = {}) => ({ pattern, scale, cover, rgb, alpha, ...o });
// rough: amplitude of seeded higher harmonics (4 to 11 lobes per turn), so an outline wanders instead of reading as an ellipse
const lobed = (rx, ry, feats, b = 1, n = 56, rough = 0) => {
  const ph = rnd() * 6.28, hs = rough ? [4, 5, 6, 7, 9, 11].map((k) => [k, (rough * (0.4 + 0.6 * rnd()) * 4) / k, rnd() * 6.28]) : [];
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    let f = b + 0.03 * Math.sin(3 * a + ph);
    for (const [k, amp, p] of hs) f += amp * Math.sin(k * a + p);
    for (const [d, amp, w] of feats) { let dd = Math.abs(a - (d * Math.PI) / 180) % (2 * Math.PI); if (dd > Math.PI) dd = 2 * Math.PI - dd; f += amp * Math.exp(-((dd / ((w * Math.PI) / 180)) ** 2)); }
    return [R(rx * f * Math.cos(a)), R(ry * f * Math.sin(a))];
  });
};
const dsat = (c, k = 0.88) => { const l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; return c.map((v) => R(l + (v - l) * k)); };
// a paint (with its texture) moved BRIGHTER of the way from its average look towards designer 2's colour for that area
const warm = (id, p) => {
  const [d, da] = D2[id], dr = dsat(d), t = p.tex, c = t ? t.cover : 0, byte = (v) => Math.max(0, Math.min(255, R(v)));
  const mean = p.rgb.map((v, i) => v * (1 - c) + (t ? t.rgb[i] * c : 0)), ma = p.alpha * (1 - c) + (t ? t.alpha * c : 0);
  const dc = dr.map((v, i) => BRIGHTER * (v - mean[i])), dA = BRIGHTER * (da - ma);
  const out = { rgb: p.rgb.map((v, i) => byte(v + dc[i])), alpha: Math.min(1, p.alpha + dA) };
  if (t) out.tex = { ...t, rgb: t.rgb.map((v, i) => byte(v + dc[i])), alpha: Math.min(1, t.alpha + dA) };
  for (const k of ["crack", "patch", "fade"]) if (p[k] !== undefined) out[k] = p[k];
  return out;
};
const area = (pts) => Math.abs(pts.reduce((s, [x1, y1], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return s + x1 * y2 - x2 * y1; }, 0)) / 2;
const dense = (p, k = 4) => p.flatMap((q, i) => { const r = p[(i + 1) % p.length]; return Array.from({ length: k }, (_, j) => [q[0] + ((r[0] - q[0]) * j) / k, q[1] + ((r[1] - q[1]) * j) / k]); });
const inside = (p, x, y) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c; return c; };
const grow = (pts, cx, cy, k) => pts.map(([x, y]) => [R(cx + (x - cx) * k), R(cy + (y - cy) * k)]);
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
// a wandering track from a to b: midpoint displacement (kick relative to the segment, times decay per level), so it meanders at every scale without a repeating wave
const wander = (a, b, levels, kick, decay = 1) => {
  let pts = [a, b];
  for (let l = 0; l < levels; l++, kick *= decay) {
    const next = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1], [x2, y2] = pts[i], dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), off = (rnd() - 0.5) * 2 * kick * len;
      next.push([(x1 + x2) / 2 - (dy / len) * off, (y1 + y2) / 2 + (dx / len) * off], pts[i]);
    }
    pts = next;
  }
  return pts;
};

const layers = [], rocks = [], regions = [];
const tilted = new Set(); // extras already drawn from the tilted outline
const tilt1 = (L) => (tilted.add(L), L);
const HUES = { blight: 55, mire: 300, bloom: 0, flats: 230, steppe: 185, crags: 120 }; // founder colours, chosen by Erik (2026-11-09)

// the abyss: ashen badlands, a dark crust broken into large plates
layers.push(layer("waste", poly([[-2000, -2000], [W / 2, -2500], [W + 2000, -2000], [W + 2500, H / 2], [W + 2000, H + 2000], [W / 2, H + 2500], [-2000, H + 2000], [-2500, H / 2]]), { warp: 0, feather: 0, food: WASTE.food, poison: WASTE.poison, ...paint([46, 40, 38], 0.48, tex("blobs", 3200, 0.45, [28, 24, 25], 0.52, { soft: 0.5 })) }));
// designer 2's cinder fields and pale ash drifts, at about a quarter of their strength
const all = poly([[-2000, -2000], [W + 2000, -2000], [W + 2000, H + 2000], [-2000, H + 2000]]);
layers.push(layer("waste-cinder", all, { warp: 0, rough: 0, feather: 0, ...paint([82, 42, 30], 0.22, undefined, { patch: { scale: 3800, lo: 0.5, hi: 0.66 } }) }));
layers.push(layer("waste-ash", all, { warp: 0, rough: 0, feather: 0, ...paint([112, 106, 98], 0.12, undefined, { patch: { scale: 2600, lo: 0.56, hi: 0.72 } }) }));

// layout
const tilt = (pts, a) => pts.map(([x, y]) => [R(x * Math.cos(a) - y * Math.sin(a)), R(x * Math.sin(a) + y * Math.cos(a))]);
const hubPts = tilt(lobed(HUB.rx, HUB.ry, [[25, 0.2, 30], [105, -0.16, 26], [190, 0.14, 34], [250, -0.12, 20], [300, 0.1, 18], [345, 0.16, 22]], 0.95), 0.3).map(([x, y]) => [x + CX, y + CY]); // a lopsided basin, not a disc
const DEFS = [["blight", "The Blight"], ["mire", "The Mire"], ["bloom", "The Bloom"], ["flats", "The Flats"], ["steppe", "The Steppe"], ["crags", "The Crags"]];
const RM = {};
// the ends of a realm's trail, `inset` inside the hub rim and the realm rim, on the skewed bearings; ar is the realm side's bearing (its gate)
const trailEnds = (id, mx, my, pts, inset) => {
  const toHub = Math.atan2(CY - my, CX - mx), ah = toHub + Math.PI + (SKEW[id][0] * Math.PI) / 180, ar = toHub + (SKEW[id][1] * Math.PI) / 180;
  const th = exit(hubPts, CX, CY, Math.cos(ah), Math.sin(ah)) - inset, tr = exit(pts, mx, my, Math.cos(ar), Math.sin(ar)) - inset;
  return { hub: [CX + Math.cos(ah) * th, CY + Math.sin(ah) * th], realm: [mx + Math.cos(ar) * tr, my + Math.sin(ar) * tr], ar };
};
const SHAPES = Object.fromEntries(DEFS.map(([id]) => [id, tilt(lobed(SIZE[id].rx * GROW * PLACE[id].k, SIZE[id].ry * GROW * PLACE[id].k, SIZE[id].f, SIZE[id].b, 64, OUTLINE_ROUGH), PLACE[id].rot)]));
for (const [id, title] of DEFS) {
  const S = SIZE[id], P = PLACE[id], RX = S.rx * GROW * P.k, RY = S.ry * GROW * P.k, shape = SHAPES[id], ux = Math.cos((P.ang * Math.PI) / 180), uy = Math.sin((P.ang * Math.PI) / 180);
  // centre so the skewed rim-to-rim trail (see trailEnds) is P.len long
  let reach = exit(hubPts, CX, CY, ux, uy) + P.len + exit(shape, 0, 0, -ux, -uy);
  for (let it = 0; it < 6; it++) { const e = trailEnds(id, CX + ux * reach, CY + uy * reach, shape.map(([px, py]) => [CX + ux * reach + px, CY + uy * reach + py]), 0); reach += P.len - Math.hypot(e.hub[0] - e.realm[0], e.hub[1] - e.realm[1]); }
  const x = CX + ux * reach, y = CY + uy * reach, deg = P.ang;
  const pts = shape.map(([px, py]) => [R(x + px), R(y + py)]);
  RM[id] = { id, title, deg, x, y, rx: RX, ry: RY, pts };
  regions.push({ id, title, x: R(x), y: R(y), r: R(Math.min(RX, RY) * 0.86), hue: HUES[id] });
}
const areaReport = DEFS.map(([id]) => `${id} ${(area(RM[id].pts) / area(lobed(SIZE[id].rx, SIZE[id].ry, SIZE[id].f, SIZE[id].b))).toFixed(2)}`); // outline area against round 9's

if (process.env.LAYOUT_ONLY) { // for a layout search: rim-to-rim gaps between neighbours and room to the map edge, as JSON
  const ids = ["blight", "mire", "bloom", "flats", "steppe", "crags"], E = Object.fromEntries(ids.map((id) => [id, dense(RM[id].pts)]));
  const gaps = ids.map((id, i) => { const o = ids[(i + 1) % 6]; return Math.min(...E[id].map(([x, y]) => Math.min(...E[o].map(([u, v]) => Math.hypot(x - u, y - v))))); });
  const room = ids.map((id) => Math.min(...RM[id].pts.map(([x, y]) => Math.min(x, y, W - x, H - y))));
  console.log(JSON.stringify({ gaps, room }));
  process.exit(0);
}
// trails: worn wandering tracks, not firm, from inside the hub rim to inside the realm rim: a dusty verge and a pale worn bed,
// of uneven width, whose paint fades out towards both ends (the food runs the whole way)
const gate = {}, trailPts = [], report = [], trailPaint = []; // the trails' paint is laid after the realms, so the worn track runs on into the fringes and fades there
Object.keys(RM).forEach((id) => {
  const m = RM[id], rim = trailEnds(id, m.x, m.y, m.pts, 0), { hub: a, realm: b, ar } = trailEnds(id, m.x, m.y, m.pts, 900); // both ends 900 inside the rims
  report.push(`${id} deg ${m.deg.toFixed(1)} centre ${R(m.x)},${R(m.y)} trail rim-to-rim ${R(Math.hypot(rim.hub[0] - rim.realm[0], rim.hub[1] - rim.realm[1]))}`);
  const pts = wander(a, b, 4, 0.36, 0.55);
  trailPts.push(...dense(pts, 4).slice(0, -3));
  gate[id] = ar;
  const ws = pts.map(() => R(TRAIL.w * (0.7 + 0.6 * rnd())));
  layers.push(layer(`trail-${id}`, path(pts, ws.map((w) => R(w * 1.7))), { warp: 150, rough: 160, feather: 800, food: TRAIL.food, clearMud: true, wobble: 0.35 }));
  trailPaint.push(layer(`trail-${id}-verge`, path(pts, ws.map((w) => R(w * 1.7))), { warp: 150, rough: 160, feather: 800, wobble: 0.35, ...paint([104, 94, 74], 0.38, undefined, { fade: 0.05 }) }));
  trailPaint.push(layer(`trail-${id}-bed`, path(pts, ws.map((w) => R(w * 0.5))), { warp: 30, rough: 60, feather: 260, wobble: 0.3, ...paint([204, 188, 146], 0.62, tex("blobs", 260, 0.3, [156, 138, 102], 0.55, { soft: 0.3 }), { fade: 0.06 }) }));
});
const nearTrail = (x, y) => Math.min(...trailPts.map(([tx, ty]) => Math.hypot(tx - x, ty - y)));

// the badlands between neighbouring realms, unevenly: lava flows pour in towards the hub in the four western and northern gaps (each its own length, width and swing; one wells up from a vent),
// low broken spines stand in the other two, at different distances from the hub. Every flow is checked clear of the realms, their fringes, the hub and the trails.
const order = ["blight", "mire", "bloom", "flats", "steppe", "crags"];
const realmEdge = Object.fromEntries(order.map((id) => [id, dense(RM[id].pts)]));
const hubEdge = dense(hubPts);
const clearance = (x, y, edge, pts) => (inside(pts, x, y) ? -1 : 1) * Math.min(...edge.map(([u, v]) => Math.hypot(u - x, v - y)));
const FLOWS = { 2: { sw: -0.25, reach: 6800, wk: 0.75, out: 1.9 }, 3: { sw: 0.45, reach: 2200, wk: 1.15, out: 1.9 }, 4: { sw: -0.15, reach: 2600, wk: 0.95, out: 1.9 }, 5: { sw: 0.3, reach: 2600, wk: 0.8, out: 1.9 } }; // by gap index: swing off the radial line (rad), inner end beyond the hub rim, width, outer end (times the gap's distance; under about 1.6 it wells up from a vent inside the map)
const SPINES = { 0: [0.3, 3600], 1: [0.7, 4800] }; // the other gaps: where along the gap from the hub side (0) outwards, and length
order.forEach((id, gi) => {
  const A = RM[id], B = RM[order[(gi + 1) % 6]], gx = B.x - A.x, gy = B.y - A.y, gl = Math.hypot(gx, gy), ex = gx / gl, ey = gy / gl;
  const ta = exit(A.pts, A.x, A.y, ex, ey), tb = exit(B.pts, B.x, B.y, -ex, -ey);
  report.push(`gap ${id}-${order[(gi + 1) % 6]} rim-to-rim ${R(gl - ta - tb)} outline ${R(Math.min(...realmEdge[id].map(([x, y]) => Math.min(...realmEdge[B.id].map(([u, v]) => Math.hypot(x - u, y - v))))))}`);
  const mx = A.x + ex * (ta + (gl - ta - tb) / 2), my = A.y + ey * (ta + (gl - ta - tb) / 2), rl = Math.hypot(mx - CX, my - CY), rx = (mx - CX) / rl, ry = (my - CY) / rl;
  const F = FLOWS[gi];
  if (F) {
    // the flow's spine: from beyond the map edge, through the gap's middle, to its tip; trimmed back from the tip and thinned until it is clear of everything
    const th = exit(hubPts, CX, CY, rx, ry), outer = F.out > 1.6 ? Math.max(rl + 9000, rl * F.out) : rl * F.out;
    let reach = F.reach, wk = F.wk, sw = F.sw, spine, wid, worst;
    for (let tries = 0; ; tries++) {
      const oa = Math.atan2(ry, rx) + sw, ia = Math.atan2(ry, rx) - sw * 0.4;
      const tip = [CX + Math.cos(ia) * (th + reach), CY + Math.sin(ia) * (th + reach)];
      spine = [...wander([CX + Math.cos(oa) * outer, CY + Math.sin(oa) * outer], [mx, my], 3, 0.14, 0.8), ...wander([mx, my], tip, 3, 0.14, 0.8).slice(1)];
      const n = spine.length;
      wid = (k) => spine.map((_, i) => { const t = i / (n - 1); return R(wk * k * (3200 - 2500 * t ** 1.5)); }); // wide where it pours in from the edge, thin at the tip
      const half = wid(1).map((w) => w * 0.5 * 1.35 + 320); // with wobble and roughness
      worst = { realm: 1e9, hub: 1e9, trail: 1e9, at: -1, core: 1e9 };
      dense(spine, 3).slice(0, -2).forEach(([x, y], k) => {
        const i = Math.min(n - 1, Math.floor(k / 3)), hw = half[i];
        const c0 = Math.min(...order.map((o) => clearance(x, y, realmEdge[o], RM[o].pts))), cr = c0 - hw - 1200;
        const ch = clearance(x, y, hubEdge, hubPts) - hw - 900, ct = nearTrail(x, y) - hw - 700;
        worst.core = Math.min(worst.core, c0 - 1800);
        if (Math.min(cr, ch, ct) < Math.min(worst.realm, worst.hub, worst.trail)) worst.at = i;
        worst.realm = Math.min(worst.realm, cr); worst.hub = Math.min(worst.hub, ch); worst.trail = Math.min(worst.trail, ct);
      });
      if (Math.min(worst.realm, worst.hub, worst.trail) >= 0) break;
      if (tries > 40) throw new Error(`flow ${gi} cannot be kept clear: ${JSON.stringify(worst)}\n${report.join("\n")}`);
      if (worst.core < 0) sw *= 0.8; // the spine itself runs into a realm: swing less
      else if (worst.at > n * 0.6) reach += 500;
      else wk *= 0.92;
    }
    report.push(`flow ${gi} reach ${R(reach)} width x${wk.toFixed(2)} swing ${sw.toFixed(2)} spare: realm ${R(worst.realm)} hub ${R(worst.hub)} trail ${R(worst.trail)}`);
    layers.push(layer(`flow${gi}-heat`, path(spine, wid(1.3)), { warp: 0, rough: 200, feather: 1600, taper: true, ...paint([70, 26, 14], 0.14) }));
    layers.push(layer(`flow${gi}`, path(spine, wid(1)), { warp: 0, rough: 320, feather: 380, wobble: 0.35, taper: true, ...paint([14, 11, 11], 0.84, tex("veins", 900, 0.12, [40, 20, 14], 0.84, { keep: 0.35, soft: 0.25 })) }));
    // the fissure: a broken glowing seam wandering down the flow, fading at both ends
    const seam = wander(spine[0], spine[spine.length - 1], 4, 0.05, 0.9).map(([x, y], i, arr) => { const j = Math.round((i / (arr.length - 1)) * (spine.length - 1)); return [x * 0.4 + spine[j][0] * 0.6, y * 0.4 + spine[j][1] * 0.6]; });
    layers.push(layer(`flow${gi}-ember`, path(seam, seam.map((_, i) => R(wk * (420 - 260 * (i / (seam.length - 1))) * (0.7 + 0.6 * rnd())))), { warp: 120, rough: 90, feather: 220, wobble: 0.5, taper: true, ...paint(EMBER, 0.55, undefined, { patch: { scale: 560, lo: 0.42, hi: 0.52 }, fade: 0.08 }) }));
    // short side fissures branching off the seam, kept inside the flow
    const wf = wid(1);
    for (const f of [0.18 + 0.1 * rnd(), 0.45 + 0.1 * rnd(), 0.7 + 0.1 * rnd()]) {
      const i = Math.round(f * (spine.length - 1)), [px, py] = spine[i], [qx, qy] = spine[Math.min(spine.length - 1, i + 1)], d = Math.atan2(qy - py, qx - px) + (rnd() < 0.5 ? -1 : 1) * (0.5 + 0.4 * rnd()), L = wf[i] * 0.42;
      const br = wander([px, py], [px + Math.cos(d) * L, py + Math.sin(d) * L], 2, 0.2);
      layers.push(layer(`flow${gi}-branch${R(f * 100)}`, path(br, br.map((_, j) => R(wk * 220 * (1 - j / br.length)))), { warp: 80, rough: 60, feather: 200, wobble: 0.5, taper: true, ...paint(EMBER, 0.42, undefined, { patch: { scale: 480, lo: 0.4, hi: 0.52 } }) }));
    }
    // one broken ridge where the flow passes between the realms, not centred
    const near = spine.map(([x, y]) => Math.hypot(x - mx, y - my)), c = near.indexOf(Math.min(...near)) + (rnd() < 0.5 ? -1 : 1), seg = spine.slice(Math.max(0, c - 2), Math.min(spine.length, c + 3));
    rocks.push(rock(`ridge${gi}`, "massif", path(seg, seg.map((_, i) => R(420 + 260 * Math.sin((Math.PI * i) / (seg.length - 1)) * (0.7 + 0.6 * rnd())))), { warp: 300, rough: 140, feather: 420, wobble: 0.45, taper: true }));
  } else {
    // a low broken spine across the gap, at its own distance from the hub, with loose rubble
    const [f, L] = SPINES[gi], x = mx + rx * (f - 0.5) * 6000, y = my + ry * (f - 0.5) * 6000, r = Math.atan2(ry, rx) + (rnd() - 0.5) * 0.6, c = Math.cos(r), sn = Math.sin(r); // along the gap, radially
    const line = wander([x - 0.5 * L * c, y - 0.5 * L * sn], [x + 0.5 * L * c, y + 0.5 * L * sn], 3, 0.14);
    [[0, 0.4], [0.5, 1]].forEach(([u0, u1], j) => {
      const seg = line.slice(Math.round(u0 * (line.length - 1)), Math.round(u1 * (line.length - 1)) + 1);
      rocks.push(rock(`spur${gi}_${j}`, "massif", path(seg, seg.map((_, i) => R(480 * (0.6 + 0.6 * Math.sin((Math.PI * i) / (seg.length - 1))) * (0.8 + 0.4 * rnd())))), { warp: 300, rough: 110, feather: 500, wobble: 0.4, taper: true }));
    });
    rocks.push(rock(`rubble${gi}`, "talus", poly(blob(x, y, L * 0.5, 1500, 10, 0.3, r)), { warp: 600, rough: 200, feather: 1600, cover: 0.03, clump: 800, pow: 1.5, r: [90, 200] }));
    const sp = dense(line, 3).map(([u, v]) => Math.min(nearTrail(u, v), ...order.map((o) => clearance(u, v, realmEdge[o], RM[o].pts))));
    report.push(`spine ${gi} at ${R(Math.hypot(x - CX, y - CY))} from the hub centre, nearest realm or trail ${R(Math.min(...sp))}`);
  }
});
for (const id of Object.keys(RM)) { const xs = RM[id].pts.map((p) => p[0]), ys = RM[id].pts.map((p) => p[1]); report.push(`edge room ${id} ${R(Math.min(...xs))} ${R(W - Math.max(...xs))} ${R(Math.min(...ys))} ${R(H - Math.max(...ys))}`); } // distance of each outline to the map edges (left right top bottom)
for (const l of [...report, `area vs round 9: ${areaReport.join(", ")}`]) console.error(l);

// the commons: a lopsided basin of dark wet earth with a muted blue-green cast (dark enough for cyan and blue creatures to show), seated like the realms
// (dark hollow, faint wash, ragged fringe), with three clear pools on boggy ground, a spring and scattered boulder groups
{
  const fr = { rgb: [40, 74, 70], alpha: 0, tex: tex("blobs", 800, 0.35, [40, 74, 70], 0.32, { soft: 0.08 }) };
  layers.push(layer("commons-wash", poly(grow(hubPts, CX, CY, 1.25)), { warp: 900, rough: 300, feather: 3600, ...paint([40, 74, 70], 0.07) }));
  layers.push(layer("commons-seat", poly(grow(hubPts, CX, CY, 1.03)), { warp: 600, rough: 300, band: 650, feather: 1300, ...paint([9, 8, 8], 0.42, undefined, { patch: { scale: 1500, lo: 0.25, hi: 0.45 } }) }));
  layers.push(layer("commons-fringe", poly(grow(hubPts, CX, CY, 1.12)), { warp: 700, rough: 300, feather: 2600, paint: fr }));
}
layers.push(layer("commons", poly(hubPts), { warp: 600, rough: 450, feather: 450, food: HUB.food, poison: 0, clearMud: true, ...paint([38, 72, 70], 0.74, tex("blobs", 650, 0.4, [28, 50, 48], 0.72, { soft: 0.32 })) }));
layers.push(layer("commons-core", poly(blob(CX + 700, CY - 400, 4300, 3600, 16, 0.18, 0.4)), { warp: 600, rough: 300, feather: 2400, food: 1.3, clearMud: true, ...paint([56, 98, 90], 0.24, tex("blobs", 450, 0.4, [40, 76, 70], 0.24, { soft: 0.35 })) }));
for (const [i, [dx, dy, rx, ry, rot]] of [[-2600, -1900, 1100, 650, 0.4], [2400, 1700, 800, 520, -0.3], [-900, 2900, 600, 380, 1.1]].entries()) {
  layers.push(layer(`commons-wet${i}`, poly(blob(CX + dx, CY + dy, rx * 1.9, ry * 1.9, 12, 0.3, rot)), { warp: 400, rough: 250, feather: 600, ...paint([20, 34, 32], 0.55, undefined, { patch: { scale: 500, lo: 0.3, hi: 0.46 } }) })); // boggy ground round each pool
  layers.push(layer(`commons-shore${i}`, poly(blob(CX + dx, CY + dy, rx * 1.12, ry * 1.12, 11, 0.3, rot)), { warp: 260, rough: 160, band: 90, feather: 200, ...paint([120, 150, 140], 0.3, undefined, { patch: { scale: 400, lo: 0.3, hi: 0.45 } }) }));
  layers.push(layer(`commons-pool${i}`, poly(blob(CX + dx, CY + dy, rx, ry, 11, 0.35, rot)), { warp: 260, rough: 160, feather: 220, ...paint([30, 78, 94], 0.84) }));
}
layers.push(layer("commons-spring", poly(blob(CX + 1500, CY - 1500, 420, 300, 9, 0.3, 0.5)), { warp: 150, rough: 100, feather: 260, ...paint([84, 150, 160], 0.6) }));
regions.push({ id: "commons", title: "The Commons", x: CX, y: CY, r: R(0.6 * HUB.ry) });
for (const [g, [gx, gy]] of [[2900, -800], [-3400, 600], [600, -3300], [-200, 1200]].entries()) { // boulder groups, each a few rugged stones
  for (let k = 0; k < 3 + (g % 2); k++) {
    const x = CX + gx + (rnd() - 0.5) * 1300, y = CY + gy + (rnd() - 0.5) * 900, a = rnd() * 3, L = 250 + rnd() * 450;
    rocks.push(rock(`commons-stone${g}_${k}`, "massif", path([[x, y], [x + L * Math.cos(a), y + L * Math.sin(a)]], [R(200 + rnd() * 220), R(150 + rnd() * 200)]), { warp: 160, rough: 90, feather: 260, wobble: 0.4, taper: true }));
  }
}

// a realm: the material fill (base colour plus a pattern), a ragged ecotone fringe of the same material spilling into the wastes, extras, optional horseshoe wall
const realm = (id, mat, o, fringe, extra, wall) => {
  const m = RM[id], { x, y, pts } = m, fr = warm(id, { rgb: fringe[0], alpha: 0, tex: tex("blobs", 800, fringe[1], fringe[0], fringe[2], { soft: 0.08 }) });
  layers.push(layer(`${id}-wash`, poly(grow(pts, x, y, 1.28)), { warp: 900, rough: 300, feather: 3600, ...paint(fr.tex.rgb, 0.1) })); // the realm's colour bleeding faintly into the wastes
  layers.push(layer(`${id}-seat`, poly(grow(pts, x, y, 1.03)), { warp: 600, rough: 300, band: 650, feather: 1300, ...paint([9, 8, 8], 0.42, undefined, { patch: { scale: 1500, lo: 0.25, hi: 0.45 } }) })); // a dark hollow the realm sits in
  layers.push(layer(`${id}-fringe`, poly(grow(pts, x, y, 1.13)), { warp: 700, rough: 300, feather: 2600, paint: fr }));
  layers.push(layer(id, poly(pts), { clearMud: true, rough: 450, warp: 500, feather: 650, paint: warm(id, mat.paint), ...o }));
  const l0 = layers.length, r0 = rocks.length;
  extra(x, y, m);
  // the extras are laid out untilted: turn them with the realm
  const c = Math.cos(PLACE[id].rot), sn = Math.sin(PLACE[id].rot), turn = (q) => [R(x + (q[0] - x) * c - (q[1] - y) * sn), R(y + (q[0] - x) * sn + (q[1] - y) * c)];
  for (const L of [...layers.slice(l0), ...rocks.slice(r0)].filter((L) => !tilted.has(L))) {
    if (L.shape.type === "poly") L.shape.pts = L.shape.pts.map(turn);
    else L.shape.path = L.shape.path.map(turn);
    if (L.passes) L.passes = L.passes.map(([px, py, pr]) => [...turn([px, py]), pr]);
  }
  if (wall) {
    // a broken ridge round the far side: four pieces stepped in and out (en echelon), each overlapping the next by a few points behind its end, so the breaks
    // read as breaks but stay closed; lumpy width from thin necks to thick shoulders; scree spilling down the outside
    const g = gate[id], span = 2 * Math.PI * wall, hw = Math.PI - span / 2, n = 48, wp = [], sw = [], ph = [rnd() * 6, rnd() * 6];
    for (let i = 0; i <= n; i++) {
      const a = g + hw + (i / n) * span, ux = Math.cos(a), uy = Math.sin(a), t = exit(pts, x, y, ux, uy) * (0.96 + 0.025 * Math.sin(i * 0.7 + ph[0])), u = Math.min(i, n - i) / n / 0.1, e = u >= 1 ? 1 : u * u * (3 - 2 * u);
      const lump = 0.85 + 0.45 * Math.sin(i * 0.41 + ph[1]) + 0.3 * Math.sin(i * 1.23 + ph[0]) + 0.3 * (rnd() - 0.5);
      wp.push([x + ux * t, y + uy * t]); sw.push(R(260 + 480 * e * Math.max(0.3, lump))); // ends no thinner than 260, so the tips by the gate do not crumble
    }
    layers.push(layer(`${id}-wall-shade`, path(wp, sw.map((w) => w * 2.4)), { warp: 200, rough: 160, feather: 700, taper: true, ...paint([12, 10, 14], 0.3) }));
    // five pieces of uneven length, each a slanted arc (its own distance from the centre drifting along it) of its own thickness; a piece starts
    // within 0.03 of where the last one ended, so the overlaps join
    const P = 5, cuts = [0.17, 0.37, 0.6, 0.8].map((f) => R(n * (f + 0.08 * (rnd() - 0.5)))), ends = [0, ...cuts, n], OV = 3;
    let off = 0.97 + 0.06 * rnd();
    for (let k = 0; k < P; k++) {
      const o0 = k === 0 ? off : Math.min(1.035, Math.max(0.955, off + 0.06 * (rnd() - 0.5))), o1 = Math.min(1.035, Math.max(0.955, o0 + 0.07 * (rnd() - 0.5))), thick = 0.75 + 0.55 * rnd();
      off = o1;
      const i0 = Math.max(0, ends[k] - OV), i1 = Math.min(n, ends[k + 1] + OV);
      const seg = wp.slice(i0, i1 + 1).map(([px, py], j, all) => { const o = o0 + ((o1 - o0) * j) / (all.length - 1); return [x + (px - x) * o, y + (py - y) * o]; });
      const ws = sw.slice(i0, i1 + 1).map((w, j) => ((k > 0 && j <= 2 * OV) || (k < P - 1 && j >= i1 - i0 - 2 * OV) ? Math.max(w * thick, 480) : Math.max(260, R(w * thick)))); // thick where the pieces overlap, so they join
      rocks.push(rock(`${id}-wall${k}`, "massif", path(seg, ws), { warp: 240, rough: 70, feather: 260, wobble: 0.3, taper: false }));
    }
    rocks.push(rock(`${id}-wall-scree`, "talus", path(wp.map(([px, py]) => [x + (px - x) * 1.06, y + (py - y) * 1.06]), sw.map(() => 1300)), { warp: 300, rough: 160, feather: 700, cover: 0.14, clump: 650, pow: 1.4, r: [70, 160] }));
  }
};

// The Blight: a poisoned flat of fine bruised crust, cracked in places, a few long rifts, and oozing pockets
realm("blight", paint([74, 36, 86], 0.62, tex("plates", 400, 0.8, [132, 90, 146], 0.55, { keep: 0.7, soft: 0.16 })), { food: 2.3, poison: 3.0 }, [[110, 60, 130], 0.35, 0.3], (x, y) => {
  layers.push(tilt1(layer("blight-rifts", poly(grow(RM.blight.pts, x, y, 0.95)), { warp: 400, rough: 200, feather: 900, ...paint([52, 20, 60], 0, tex("veins", 1300, 0.07, [52, 20, 60], 0.5, { keep: 0.4, soft: 0.2 })) })));
  layers.push(layer("blight-heart", poly(blob(x, y, 1900, 1500, 10, 0.18)), { warp: 400, rough: 200, feather: 1000, food: 3.0, poison: 1.0, clearMud: true, ...paint([132, 118, 70], 0.4, tex("plates", 380, 0.78, [154, 142, 92], 0.48, { keep: 0.7, soft: 0.16 })) }));
  for (const [dx, dy, rx, ry, rot] of [[1500, 900, 1500, 900, -0.3], [-3300, -800, 750, 480, 0.7], [-1300, -1600, 600, 420, -0.2], [3500, -1000, 520, 360, 0.9], [-800, 1700, 480, 320, 0.1], [3200, 1600, 650, 400, 0.4], [-4400, 900, 420, 300, 1.2]]) {
    layers.push(layer(`blight-seep${dx}`, poly(blob(x + dx, y + dy, rx, ry, 10, 0.3, rot)), { warp: 250, rough: 140, feather: 300, ...paint([74, 16, 70], 0.7, tex("blobs", 220, 0.4, [168, 40, 150], 0.6, { soft: 0.25 })) }));
  }
}, 0.78);
// The Mire: a marsh of reed mats, three meandering channels that branch into a broken web of narrower leads, open pools, and three firmer hummocks
realm("mire", paint([88, 104, 44], 0.55, tex("blobs", 420, 0.45, [56, 72, 30], 0.6, { soft: 0.2 })), { food: 2.3, poison: 0, mud: { coverage: 0.45, scale: 1000, pattern: "veins", keep: 0.5 } }, [[80, 96, 44], 0.35, 0.35], (x, y) => {
  for (const [k, [a, b, w]] of [[[-5600, 700], [5200, -500], 520], [[-3400, -2700], [1600, 3000], 420], [[2400, -3100], [4600, 2200], 360]].entries()) {
    const ch = wander([x + a[0], y + a[1]], [x + b[0], y + b[1]], 4, 0.28, 0.7);
    layers.push(layer(`mire-channel${k}`, path(ch, ch.map(() => R(w * (0.6 + 0.8 * rnd())))), { warp: 200, rough: 100, feather: 300, wobble: 0.45, taper: true, mud: { coverage: 1, scale: 1300 } }));
  }
  for (const [dx, dy, rx, ry, rot] of [[400, -300, 1300, 850, 0.3], [-3600, -1300, 1000, 650, -0.4], [3900, 1300, 900, 700, 0.2], [-2600, 2300, 800, 500, 0.6]]) {
    layers.push(layer(`mire-pool${dx}`, poly(blob(x + dx, y + dy, rx, ry, 12, 0.3, rot)), { warp: 350, rough: 200, feather: 400, mud: { coverage: 1, scale: 1300 } }));
  }
  for (const [dx, dy, rx, ry, rot] of [[-1700, 900, 1900, 750, -0.5], [1800, -1700, 900, 1100, 0.4], [2500, 2000, 600, 480, 0]]) {
    layers.push(layer(`mire-isle${dx}`, poly(blob(x + dx, y + dy, rx, ry, 12, 0.22, rot)), { warp: 300, rough: 200, feather: 450, food: 3.0, clearMud: true, ...paint([100, 132, 70], 0.4, tex("blobs", 300, 0.4, [70, 100, 50], 0.5, { soft: 0.25 })) }));
  }
}, 0.82);
// The Bloom: dense dark canopy in clumps, broken by sunlit clearings and food-rich groves
realm("bloom", paint([20, 92, 56], 0.7, tex("blobs", 1100, 0.32, [146, 146, 96], 0.6, { soft: 0.1 })), { food: 2.4, poison: 0 }, [[30, 120, 74], 0.4, 0.4], (x, y) => {
  layers.push(tilt1(layer("bloom-canopy", poly(grow(RM.bloom.pts, x, y, 0.97)), { warp: 500, rough: 380, feather: 900, ...paint([8, 50, 30], 0, tex("blobs", 330, 0.4, [8, 50, 30], 0.55, { soft: 0.15 })) })));
  const pk = [[0, 0, 1700, 1400]];
  for (let i = 0; i < 6; i++) { const a = (i / 6) * 6.28 + 0.4, d = 2900 + (i % 2) * 300; pk.push([d * Math.cos(a), d * 0.82 * Math.sin(a), 800 + (i % 3) * 200, 650 + (i % 2) * 250]); }
  pk.forEach(([dx, dy, rx, ry], i) => layers.push(layer(`bloom-grove${i}`, poly(blob(x + dx, y + dy, rx, ry, 10, 0.25)), { warp: 300, rough: 200, feather: 700, food: 3.0, ...paint([60, 170, 90], 0.25, tex("blobs", 260, 0.45, [20, 90, 50], 0.4, { soft: 0.25 })) })));
});
// The Flats: a fine cracked clay pan, the cracks a dull brown close to the clay so creatures still read (cracks are ordinary ground)
realm("flats", paint([128, 118, 94], 0.9), { food: 1.1, poison: 0, firm: { coverage: 0.86, scale: 950, pattern: "plates" }, edge: 700 }, [[170, 150, 110], 0.3, 0.3], () => {});
// The Steppe: dry tussock grassland with bare patches and scattered oases of open water ringed by green
realm("steppe", paint([186, 156, 72], 0.5, tex("blobs", 450, 0.42, [128, 110, 56], 0.48, { soft: 0.35 })), { food: 0.95, poison: 0 }, [[170, 140, 66], 0.35, 0.35], (x, y) => {
  for (const [i, [dx, dy, sz]] of [[-2900, -900, 1.1], [-600, 1300, 0.8], [1700, -1500, 1.0], [3600, 900, 0.75], [600, -200, 0.6], [-4300, 1500, 0.7]].entries()) {
    const ox = x + dx, oy = y + dy; // scattered, not round a centre
    layers.push(layer(`oasis${i}`, poly(blob(ox, oy, 1000 * sz, 780 * sz, 10, 0.3)), { warp: 700, rough: 400, feather: 900, food: 3.6, ...paint([104, 132, 62], 0.42, tex("blobs", 340, 0.4, [62, 100, 46], 0.5, { soft: 0.25 }), { patch: { scale: 700, lo: 0.3, hi: 0.5 } }) }));
    layers.push(layer(`oasis${i}-water`, poly(blob(ox + (rnd() - 0.5) * 900, oy + (rnd() - 0.5) * 500, 380 * sz, 200 * sz, 9, 0.5, rnd() * 3)), { warp: 300, rough: 160, feather: 220, ...paint([34, 60, 64], 0.65) })); // a small pond off-centre in its green
  }
});
// The Crags: dark rock ground cut by gullies, rugged basalt outcrops in broken lines, scree aprons and loose boulders
realm("crags", paint([70, 78, 92], 0.6, tex("veins", 1100, 0.22, [40, 44, 54], 0.66, { keep: 0.6, soft: 0.25 })), { food: 1.5, poison: 0 }, [[90, 104, 124], 0.4, 0.35], (x, y) => {
  // two broken lines of outcrops: each a run of short rugged pieces, offset and of uneven size, not one smooth ridge
  const lines = [wander([x - 4300, y + 900], [x + 3900, y - 1300], 4, 0.12, 0.8), wander([x - 3100, y + 2600], [x + 3700, y + 1700], 4, 0.12, 0.8)];
  lines.forEach((ln, li) => {
    for (let i = 0; i < ln.length - 2; ) {
      const len = 2 + Math.floor(rnd() * 3), seg = ln.slice(i, Math.min(ln.length, i + len + 1)).map(([px, py]) => [px + (rnd() - 0.5) * 500, py + (rnd() - 0.5) * 500]);
      if (seg.length >= 2 && rnd() < 0.85) rocks.push(rock(`crags-out${li}_${i}`, "massif", path(seg, seg.map(() => R(380 + rnd() * 520))), { warp: 300, rough: 200, feather: 360, wobble: 0.55, taper: true }));
      i += len + (rnd() < 0.5 ? 1 : 0);
    }
  });
  for (const [i, [dx, dy]] of [[-2600, -1700], [1300, -2600], [2300, 3100], [-600, 400], [3700, 300]].entries()) { // tors: small clusters of blocks
    for (let k = 0; k < 2 + (i % 2); k++) { const px = x + dx + (rnd() - 0.5) * 700, py = y + dy + (rnd() - 0.5) * 600, a = rnd() * 3, L = 200 + rnd() * 380; rocks.push(rock(`crags-tor${i}_${k}`, "massif", path([[px, py], [px + L * Math.cos(a), py + L * Math.sin(a)]], [R(220 + rnd() * 220), R(160 + rnd() * 200)]), { warp: 160, rough: 100, feather: 260, wobble: 0.4, taper: true })); }
  }
  for (const [k, ln, wd] of [[1, lines[0], 2800], [2, lines[1], 2400]]) layers.push(layer(`crags-scree-paint${k}`, path(ln, ln.map(() => wd)), { warp: 500, rough: 300, feather: 1400, ...paint([140, 144, 150], 0, tex("blobs", 220, 0.36, [138, 142, 148], 0.45, { soft: 0.22 })) }));
  rocks.push(rock("crags-scree", "talus", path(lines[0], lines[0].map(() => 1800)), { warp: 300, rough: 160, feather: 800, cover: 0.45, clump: 600, clumpLo: 0.34, clumpHi: 0.6, pow: 1.3, r: [70, 170] }));
  rocks.push(rock("crags-scree2", "talus", path(lines[1], lines[1].map(() => 1600)), { warp: 300, rough: 160, feather: 800, cover: 0.4, clump: 600, clumpLo: 0.34, clumpHi: 0.6, pow: 1.3, r: [70, 160] }));
  rocks.push(tilt1(rock("crags-boulders", "outcrop", poly(grow(RM.crags.pts, x, y, 0.85)), { warp: 500, rough: 200, feather: 1200, cover: 0.012, clump: 1400, r: [160, 300] })));
});

layers.push(...trailPaint);
const ORDER = ["crags", "blight", "mire", "bloom", "flats", "steppe", "commons"];
regions.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
console.error(`layers ${layers.length}, rock layers ${rocks.length}`);
const spec = { name: "clock", title: "The Six Realms", look: { rock: { stone: "basalt" } }, solidRock: true, seed: SEED, width: W, height: H, scale: 1, baseFood: WASTE.food, basePoison: WASTE.poison, layers, rock: rocks, regions };
const body = JSON.stringify(spec, (k, v) => (Array.isArray(v) && v.every((e) => typeof e === "number") ? `\u0000${JSON.stringify(v)}\u0000` : v), 1).replace(/"\\u0000(.*?)\\u0000"/g, "$1");
console.log(`import type { MapSpec } from "./mapBuild.ts";\n\n// The Six Realms: six biome realms on a ring around a shared hub, apart by ashen badlands and joined to it by worn trails.\n// Generated by docs/world-maps/tools/clock.mjs; edit that and regenerate.\nexport const CLOCK: MapSpec = ${body};`);
