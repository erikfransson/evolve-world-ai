// Final specs. Written in thousands of world units (k); the helpers scale to units.
const W = 54, H = 33.6;
const K = (a) => (Array.isArray(a) ? a.map(K) : a * 1000);
let rs = 1;
const rnd = () => ((rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296);
const blob = (cx, cy, rx, ry, n = 11, irr = 0.28, rot = 0) => {
  const pts = [], a0 = rnd() * 6.28, c = Math.cos(rot), s = Math.sin(rot);
  for (let i = 0; i < n; i++) { const a = a0 + (6.2832 * i) / n + (rnd() - 0.5) * 0.35, f = 1 + (rnd() - 0.5) * 2 * irr, x = rx * f * Math.cos(a), y = ry * f * Math.sin(a); pts.push([cx + x * c - y * s, cy + x * s + y * c]); }
  return pts;
};
const tex = (t) => (t ? { ...t, scale: (t.scale ?? 2) * 1000, deep: t.deep !== undefined ? t.deep * 1000 : undefined, inset: t.inset !== undefined ? t.inset * 1000 : undefined } : undefined);
const shapeOf = (o) => (o.poly ? { type: "poly", pts: K(o.poly) } : { type: "path", path: K(o.path), w: K(o.w) });
const layer = (id, o) => {
  const L = { id, shape: shapeOf(o), warp: (o.warp ?? 1.1) * 1000, rough: (o.rough ?? 0.3) * 1000, feather: (o.feather ?? 0.8) * 1000 };
  if (o.edge) L.edge = o.edge * 1000;
  for (const k of ["food", "poison", "clearMud"]) if (o[k] !== undefined) L[k] = o[k];
  if (o.mud) L.mud = tex(o.mud);
  if (o.firm) L.firm = tex(o.firm);
  return L;
};
const rock = (id, kind, o) => {
  const R = { id, kind, shape: shapeOf(o), warp: (o.warp ?? 1.0) * 1000, rough: (o.rough ?? 0.3) * 1000, feather: (o.feather ?? (kind === "massif" ? 0.9 : 1.2)) * 1000, cover: o.cover ?? 0.05 };
  if (o.band) R.band = o.band * 1000;
  if (o.clump) R.clump = o.clump * 1000;
  if (o.clumpLo) R.clumpLo = o.clumpLo;
  if (o.clumpHi) R.clumpHi = o.clumpHi;
  if (o.pow) R.pow = o.pow;
  if (o.r) R.r = o.r;
  if (o.onMud) R.onMud = true;
  if (o.passes) R.passes = K(o.passes);
  if (o.wobble) R.wobble = o.wobble;
  if (o.taper) R.taper = true;
  return R;
};
const lab = (t, at, size = 1, sub = "") => ({ t, at: K(at), size, sub });
// oasis with its mud ring: ring "full", "side" (one-sided arc towards dirDeg) or "none"
const oasis = (id, x, y, rx, ry, ring, dirDeg = 0) => {
  const out = [], a = (dirDeg * Math.PI) / 180;
  if (ring === "full") out.push(layer("ring" + id, { poly: blob(x, y, rx * 1.55, ry * 1.6, 11, 0.3), mud: { coverage: 0.55, scale: 1.3, deep: 1.0 }, food: 1.4, feather: 1.2, warp: 0.7 }));
  if (ring === "side") out.push(layer("ring" + id, { poly: blob(x + Math.cos(a) * rx * 0.95, y + Math.sin(a) * ry * 0.95, rx * 0.95, ry * 1.25, 10, 0.3, a), mud: { coverage: 0.72, scale: 1.3, deep: 1.0 }, food: 1.4, feather: 1.0, warp: 0.6 }));
  out.push(layer("core" + id, { poly: blob(x, y, rx, ry, 10, 0.3), clearMud: true, food: 2.0, poison: 0, feather: 1.0, warp: 0.7 }));
  return out;
};

// ---------------------------------------------------------------- F1 Realms
rs = 44;
const nwS = blob(9, 7.2, 6.8, 5.0, 12, 0.25), nS = blob(27, 5.5, 7.6, 3.7, 12, 0.25), neS = blob(46, 7.5, 6.6, 4.9, 12, 0.25), swS = blob(8.5, 26.4, 6.4, 4.6, 12, 0.25), sS = blob(27, 27.2, 7.4, 3.4, 12, 0.22), seS = blob(46, 25.4, 6.8, 4.8, 12, 0.25);
const beltOf = (id, p) => rock(id + "-belt", "talus", { poly: p, band: 1.0, cover: 0.3, clump: 2.2, clumpLo: 0.5, clumpHi: 0.6, pow: 1, feather: 1.0, warp: 1.1 });
const F1 = {
  n: "F1", title: "Realms", seed: 404, world: [W * 1000, H * 1000], baseFood: 1.0,
  tagline: "A plain Commons ringed by six realms, edged by drifts of boulders with wide gaps instead of walls",
  layers: [
    layer("karst", { poly: nwS, food: 1.3, feather: 2.2 }),
    layer("boulder", { poly: nS, food: 1.4, feather: 2.2 }),
    layer("marsh", { poly: neS, mud: { coverage: 0.55, scale: 2.4, deep: 1.2 }, food: 1.7, poison: 0, feather: 2.0 }),
    layer("ash", { poly: swS, poison: 2, food: 2.0, feather: 2.0 }),
    layer("steppe", { poly: sS, firm: { coverage: 0.65, scale: 4.2 }, food: 0.55, feather: 2.0 }),
    layer("dune2", { poly: blob(15.8, 29.6, 2.4, 1.5, 9, 0.3), firm: { coverage: 0.8, scale: 2 }, food: 0.6, feather: 1.2, warp: 0.7 }),
    layer("basin", { poly: seS, food: 0.6, feather: 2.2 }),
    ...oasis("a", 42.5, 22.2, 2.7, 2.2, "full"),
    ...oasis("b", 49.5, 28.4, 2.3, 1.9, "side", 200),
  ],
  rock: [
    ...[[5.2, 5.0, 1.7, 1.1], [9.6, 4.3, 1.3, 0.9], [13.2, 7.0, 1.6, 1.2], [7.0, 9.4, 1.9, 1.2], [11.2, 10.8, 1.2, 0.9], [4.2, 12.3, 1.3, 0.9], [14.2, 11.8, 1.0, 0.8]].map(([x, y, rx, ry], i) => rock("karst" + i, "massif", { poly: blob(x, y, rx, ry, 9, 0.35), warp: 0.4, rough: 0.5, feather: 0.7 })),
    rock("karst-tal", "talus", { poly: nwS, cover: 0.06, clump: 1.4, feather: 3.2, pow: 2 }),
    
    rock("boulder-tal", "talus", { poly: nS, r: [110, 260], cover: 0.3, clump: 1.6, feather: 2.6, pow: 1.4 }),
  ],
  inset: { at: [15.2, 8.2] },
  labels: [lab("Karst Hills", [8.5, 7.4], 1.05, "outcrops and clearings"), lab("Boulder Reach", [27, 5.4], 1.05, "dense boulders, rich"), lab("Silt Marsh", [46, 7.5], 1.05, "mud, rich food"), lab("Ashlands", [8.5, 26.4], 1.05, "poison, rich food"), lab("Speed Steppe", [27, 27.4], 1.05, "fast, poor food"), lab("Dry Basin", [47, 22.8], 1.0, "poor, two oases"), lab("The Commons", [27, 16.6], 1.2, "plain ground"), lab("Oasis", [42.5, 22.2], 0.7), lab("Oasis", [49.5, 28.4], 0.7)],
  table: [["Commons", "1.0", "1.0", "plain", "open, mixing"], ["Karst Hills", "1.3", "1.0", "rock outcrops", "tight steering"], ["Boulder Reach", "1.4", "1.0", "boulders", "steering"], ["Silt Marsh", "1.7", "none", "patchy mud", "slow, rich"], ["Ashlands", "2.0", "2.0", "plain", "poison, rich"], ["Speed Steppe", "0.55", "1.0", "firm 65%", "fast, poor"], ["Dry Basin", "0.6", "1.0", "plain, oasis 2.0 with mud fringes", "far apart"]],
};

// ---------------------------------------------------------------- F2 Three Rivers
rs = 55;
const ridgePath = [[1.5, 3.7], [8, 4.5], [16, 3.5], [24, 4.6], [32, 3.4], [40, 4.4], [48, 3.3]];
const plateau = blob(36.5, 18, 4.2, 8.3, 11, 0.2);
const fords = [[9.5, 16.2], [11.3, 27.6], [26.2, 18], [26.9, 24.2], [44.7, 16.2], [44.4, 22.2]];
const F2 = {
  n: "F2", title: "Three Rivers", seed: 505, world: [W * 1000, H * 1000],
  tagline: "Rivers rise below a northern ridge, run through meadows past a steppe plateau, and reach an ash coast. Stepping stones mark the fords",
  layers: [
    layer("ridge-ground", { path: ridgePath, w: [5, 5.5, 5, 5.5, 5, 5, 5], food: 0.9, feather: 2.0 }),
    layer("meadow", { poly: blob(17.5, 20, 3.9, 8.0, 11, 0.22), food: 1.2, feather: 2.2 }),
    layer("plateau", { poly: plateau, firm: { coverage: 0.5, scale: 4.0 }, food: 0.7, feather: 2.0 }),
    layer("coast", { poly: [[51.4, -3], [46.8, 3], [50.6, 8], [46.2, 13], [50.4, 17.5], [47.0, 22], [51.6, 26], [46.8, 31], [50.0, 37], [57, 37], [57, -3]], poison: 2, food: 1.9, feather: 2.0, warp: 2.0, rough: 0.6 }),
    layer("tarn", { poly: blob(25, 9.2, 2.3, 1.5, 10, 0.3), mud: { coverage: 1, deep: 1.0 }, food: 1.9, poison: 0, feather: 0.7, warp: 0.6 }),
    layer("r1", { path: [[7.5, 8], [10.5, 13], [8.5, 19], [12, 25], [10.5, 30], [14, 34.5]], w: [0.3, 0.9, 1.4, 1.9, 2.3, 2.7], mud: { coverage: 0.92, scale: 1.6, deep: 0.7 }, food: 1.9, poison: 0, feather: 0.7, warp: 0.6, rough: 0.25 }),
    layer("r2", { path: [[25, 10], [27.5, 15], [24.5, 21], [29, 27], [27.5, 34.5]], w: [1.2, 1.5, 2.0, 2.4, 2.8], mud: { coverage: 0.92, scale: 1.6, deep: 0.7 }, food: 1.9, poison: 0, feather: 0.7, warp: 0.6, rough: 0.25 }),
    layer("r3", { path: [[44, 8], [46.5, 13.5], [42.5, 19], [46, 25], [49, 30], [51, 34.5]], w: [0.3, 1.0, 1.5, 2.0, 2.3, 2.8], mud: { coverage: 0.92, scale: 1.6, deep: 0.7 }, food: 1.9, poison: 0, feather: 0.7, warp: 0.6, rough: 0.25 }),
  ],
  fords: fords.map(([x, y]) => [x * 1000, y * 1000, 0, 1500, 4]),
  rock: [
    { ...rock("ridge", "massif", { path: ridgePath, w: [2.3, 2.7, 2.5, 2.8, 2.5, 2.6, 2.1], warp: 0.9, rough: 0.5, feather: 0.9, wobble: 0.3, taper: true, passes: [[16.8, 3.9, 2.0], [36.4, 3.9, 1.9]] }) },
    rock("ridge-talus", "talus", { path: ridgePath, w: [5.5, 6, 5, 6, 5.5, 5, 5.5], cover: 0.03, clump: 1.5, feather: 2.0, pow: 2 }),
    rock("coast-rocks", "outcrop", { poly: [[49.8, 4], [47.6, 9], [49.4, 14], [47.6, 20], [50.2, 25], [48.4, 30], [51, 34], [53, 20]], cover: 0.05, clump: 2.5, feather: 1.6 }),
  ],
  inset: { at: [10.2, 16.9] },
  labels: [lab("Northern Ridge", [20.5, 3.5], 1.05, "two wide passes"), lab("Brightwater", [10.6, 21.6], 0.95, "river, slow and rich"), lab("Greymere Tarn", [25, 7.6], 0.8), lab("Greymere", [29.6, 22.6], 0.95, "river, slow and rich"), lab("Slowflow", [47.8, 20.8], 0.95, "river, slow and rich"), lab("Green Meadows", [18.5, 22.5], 1.0, "slightly richer"), lab("Steppe Plateau", [36.5, 17], 1.05, "fast patches, poor food"), lab("Ash Coast", [51.8, 15.5], 0.9, "poison, rich food"), lab("Ford", [9.2, 14.9], 0.62), lab("Ford", [26.0, 16.7], 0.62), lab("Ford", [45.4, 14.9], 0.62)],
  table: [["Northern Ridge", "0.9", "1.0", "rock massif, 2 passes", "barrier"], ["Rivers and tarn", "1.9", "none", "mud, widening", "slow, rich"], ["Fords", "1.9", "none", "stepping stones", "crossing"], ["Green Meadows", "1.2", "1.0", "plain", "slightly rich"], ["Steppe plateau", "0.7", "1.0", "firm 50%", "fast, poor"], ["Ash coast", "1.9", "2.0", "plain", "poison, rich"], ["Elsewhere", "1.0", "1.0", "plain", "open"]],
};

// ---------------------------------------------------------------- F3 Oases in the Dry
rs = 22;
const oa = [["A", 7.5, 6.8, 3.8, 2.9, "full"], ["B", 26, 23.5, 4.1, 3.0, "side", 20], ["C", 46, 9.5, 3.8, 2.9, "full"], ["D", 19, 12.5, 3.0, 2.3, "none"], ["E", 40, 19.8, 3.0, 2.3, "side", 200], ["F", 10.5, 22, 3.0, 2.3, "full"], ["G", 32, 6, 2.0, 1.6, "none"], ["H", 15, 30, 2.0, 1.6, "side", 90], ["I", 37.5, 29.5, 2.0, 1.6, "none"]];
const F3 = {
  n: "F3", title: "Oases in the Dry", seed: 202, world: [W * 1000, H * 1000], baseFood: 0.85, showPoor: true,
  tagline: "A dry olive plain with nine oases of three sizes, wadis, dune seas, two mesas and a salt pan",
  layers: [
    layer("dune1", { poly: blob(31, 15.8, 5.4, 3.0, 11, 0.25), firm: { coverage: 0.6, scale: 3.4 }, food: 0.6, feather: 1.8 }),
    layer("dune2", { poly: blob(4.8, 14.8, 3.4, 3.2, 10, 0.25), firm: { coverage: 0.6, scale: 3.4 }, food: 0.6, feather: 1.8 }),
    layer("dune3", { poly: blob(49.5, 22, 3.6, 3.3, 10, 0.25), firm: { coverage: 0.6, scale: 3.4 }, food: 0.6, feather: 1.8 }),
    layer("pan", { poly: blob(46.5, 30.6, 3.8, 1.9, 10, 0.25), poison: 2, food: 2.0, feather: 1.4, warp: 0.9 }),
    layer("mesa1ground", { path: [[34, 12.2], [37.5, 12.8], [41, 12.2]], w: [4, 4.6, 4], food: 1.1, feather: 1.6 }),
    layer("mesa2ground", { path: [[2.5, 27.5], [5.5, 28.2], [8.5, 27.3]], w: [3.8, 4.4, 3.6], food: 1.1, feather: 1.6 }),
    layer("wadi1", { path: [[19, 12.5], [21, 17], [22.5, 20.5], [26, 23.5]], w: [0.8, 1.3, 1.2, 1.1], food: 1.5, feather: 1.0, warp: 0.6 }),
    layer("wadi2", { path: [[46, 9.5], [44.5, 14], [41.5, 17], [40, 19.8]], w: [0.9, 1.1, 1.0, 0.9], food: 1.5, feather: 1.0, warp: 0.6 }),
    layer("wadi3", { path: [[7.5, 6.8], [7, 13], [9, 18], [10.5, 22]], w: [0.9, 1.2, 1.2, 1.0], food: 1.5, feather: 1.0, warp: 0.6 }),
    ...oa.flatMap(([id, x, y, rx, ry, ring, dir]) => oasis(id, x, y, rx, ry, ring, dir)),
  ],
  rock: [
    { ...rock("mesa1", "massif", { path: [[34, 12.2], [37.5, 12.8], [41, 12.2]], w: [1.7, 2.4, 1.6], warp: 0.5, rough: 0.5, feather: 0.8, wobble: 0.3, taper: true }) },
    { ...rock("mesa2", "massif", { path: [[2.5, 27.5], [5.5, 28.2], [8.5, 27.3]], w: [1.5, 2.1, 1.4], warp: 0.5, rough: 0.5, feather: 0.8, wobble: 0.3, taper: true }) },
    rock("mesa-tal1", "talus", { poly: blob(37.5, 12.6, 5.2, 2.8, 10, 0.25), cover: 0.07, clump: 1.4, feather: 2.0, pow: 2 }),
    rock("mesa-tal2", "talus", { poly: blob(5.5, 27.8, 5.2, 2.8, 10, 0.25), cover: 0.07, clump: 1.4, feather: 2.0, pow: 2 }),
    rock("oasis-stones", "talus", { poly: blob(29.8, 24.6, 1.8, 1.4, 9, 0.3), r: [110, 230], cover: 0.5, feather: 1.2, pow: 1, warp: 0.4 }),
    rock("outcrops", "outcrop", { poly: blob(21, 3.5, 4, 2.2, 10, 0.3), cover: 0.12, clump: 2.5, feather: 1.8 }),
    rock("outcrops2", "outcrop", { poly: blob(31.5, 29.2, 3.5, 2.2, 10, 0.3), cover: 0.12, clump: 2.5, feather: 1.8 }),
  ],
  inset: { at: [29.6, 23.7] },
  labels: [lab("Oasis", [7.5, 6.8], 0.85), lab("Oasis", [19, 12.5], 0.7), lab("Oasis", [32, 6], 0.65), lab("Oasis", [46, 9.5], 0.85), lab("Oasis", [10.5, 22], 0.7), lab("Great Oasis", [25.3, 20.2], 0.95), lab("Oasis", [40, 19.8], 0.7), lab("Oasis", [15, 30], 0.65), lab("Oasis", [37.5, 29.5], 0.65), lab("Sand Sea", [31, 15.9], 0.95, "fast, poor food"), lab("Mesa", [37.5, 12.5], 0.8), lab("Mesa", [5.5, 27.8], 0.8), lab("Salt Pan", [46.5, 30.6], 0.85, "poison, rich food"), lab("Dry Plain", [20.5, 5.6], 1.0, "thin food, open"), lab("Wadi", [22.2, 16.9], 0.6)],
  table: [["Dry plain", "0.85", "1.0", "plain, olive", "thin, far apart"], ["Oasis core", "2.0", "none", "plain", "rich, crowded"], ["Mud ring", "1.4", "none", "patchy, some sides only", "slow, rich edge"], ["Wadi", "1.5", "none", "plain", "green route"], ["Sand sea", "0.6", "1.0", "firm 60%", "fast, poor"], ["Mesa", "1.1", "1.0", "rock massif", "shelter"], ["Salt pan", "2.0", "2.0", "plain", "poison, rich"]],
};

// ---------------------------------------------------------------- F4 Inland Sea
rs = 11;
const seaShape = blob(27, 15.8, 10.6, 5.9, 14, 0.2);
const karstShape = blob(10.5, 16.2, 6.0, 6.0, 12, 0.22);
const ashS = blob(27, 8.4, 11.5, 3.3, 13, 0.25);
const cliffPath = [[7, 22.6], [11, 26.8], [17.5, 29.8], [26, 30.8], [35, 28.8], [42, 25.2], [47, 21]];
const dunes = [[39.5, 12, 2.7, 2.1], [42.8, 17.2, 3.2, 2.6], [40, 22.5, 2.8, 2.2], [47.5, 14, 2.2, 1.7]];
const F4 = {
  n: "F4", title: "The Inland Sea", seed: 101, world: [W * 1000, H * 1000],
  tagline: "A shallow mud sea of rich food with plain islands, a poisoned north shore, dune fields, a drowned town and a curved cliff coast",
  layers: [
    layer("karst", { poly: karstShape, food: 1.2, poison: 0.8, feather: 2.0 }),
    layer("ash", { poly: ashS, food: 1.8, poison: 2, feather: 2.0 }),
    layer("dunecoast", { poly: blob(43.5, 17.5, 8, 8.5, 12, 0.25), food: 0.65, feather: 3.0, warp: 1.4 }),
    ...dunes.map(([x, y, rx, ry], i) => layer("dune" + i, { poly: blob(x, y, rx, ry, 10, 0.3), firm: { coverage: 0.85, scale: 2.2 }, food: 0.6, feather: 1.2, warp: 0.9 })),
    layer("sea", { poly: seaShape, food: 1.6, poison: 0, mud: { coverage: 1, deep: 2.5 }, feather: 0.9, warp: 1.4, rough: 0.5 }),
    ...[[20.5, 14.8, 1.9, 1.3], [25.2, 18.6, 1.5, 1.0], [29.8, 15.0, 1.3, 0.9], [32.6, 18.4, 2.3, 1.5], [36.0, 13.2, 1.2, 0.8]].flatMap(([x, y, rx, ry], i) => [
      layer("beach" + i, { poly: blob(x, y, rx * 1.35, ry * 1.45, 10, 0.3), clearMud: true, food: 1.4, poison: 0, feather: 0.6, warp: 0.35, rough: 0.2 }),
      layer("isle" + i, { poly: blob(x, y, rx, ry, 10, 0.3), clearMud: true, food: 1.5, poison: 0, feather: 0.5, warp: 0.3, rough: 0.2 }),
    ]),
  ],
  rock: [
    rock("karst-out", "outcrop", { poly: karstShape, cover: 0.28, clump: 2.6, feather: 2.0 }),
    rock("karst-tal", "talus", { poly: karstShape, cover: 0.04, clump: 1.4, feather: 3.0, pow: 2 }),
    { ...rock("cliffs", "massif", { path: cliffPath, w: [1.5, 2.1, 2.5, 2.7, 2.5, 2.1, 1.5], warp: 0.9, rough: 0.5, feather: 0.9, wobble: 0.3, taper: true, passes: [[21.2, 30.4, 1.7], [35.2, 28.8, 1.5]] }) },
    rock("cliff-tal", "talus", { path: cliffPath, w: [5, 5.5, 5.5, 5.5, 5.5, 5, 4.5], cover: 0.03, clump: 1.5, feather: 2.0, pow: 2 }),
    rock("ash-tal", "talus", { poly: ashS, cover: 0.03, clump: 1.8, feather: 2.0, pow: 1.5 }),
  ],
  inset: { at: [35.2, 19.4] },
  labels: [lab("The Shallows", [27, 12.4], 1.15, "mud, rich food"), lab("Ashfall Shore", [27, 8.0], 1, "poison, rich food"), lab("Dune Coast", [47.5, 18.5], 1, "four dune fields, poor food"), lab("The Drowned Town", [9.8, 16.2], 1, "karst rock field"), lab("Cliff Coast", [27, 26.2], 1, "curved massif, two passes"), lab("Isles", [27.6, 17.0], 0.75)],
  table: [["Shallows", "1.6", "none", "mud, deeper in the middle", "slow, rich"], ["Isles", "1.5", "none", "plain, beaches", "reachable by wading"], ["Ashfall Shore", "1.8", "2.0", "plain", "poison, rich"], ["Dune Coast", "0.6", "1.0", "4 firm dune fields", "fast, poor"], ["Drowned Town", "1.2", "0.8", "rock outcrops", "tight steering"], ["Cliff Coast", "1.0", "1.0", "massif, 2 passes", "barrier"]],
};

export default [F1, F2, F3, F4];
