// usage: node to-engine.mjs map-F4.json <width> <height> <name> <title> [detailWidth] > src/typescript/src/sim/maps/<file>.ts
// Scales a draft layer spec to a new world size: coordinates (and fadeX) by the two axis factors, geography lengths (warp, feather, band, path width,
// pass radius, texture sizes, coarse noise wavelengths) by their mean. Detail (edge roughness and its wavelengths, clump, edge) is scaled to the world
// width detailWidth (the target's aspect) instead, default the target itself, so a map can shrink without its rock and ground looking different.
// The Inland Sea: node to-engine.mjs map-F5.json 50000 31250 inland-sea "The Inland Sea" 40000 (then the hand edits listed in inlandSea.ts).
import { readFileSync } from "node:fs";
import { basename } from "node:path";
const [file, W, H, name, title, detailWidth] = process.argv.slice(2);
const d = JSON.parse(readFileSync(file, "utf8"));
const sx = Number(W) / d.world[0], sy = Number(H) / d.world[1], s = (sx + sy) / 2;
const dw = Number(detailWidth ?? W);
const sf = (dw / d.world[0] + (dw * Number(H) / Number(W)) / d.world[1]) / 2; // detail: as if the world were detailWidth wide
const r = (v) => Math.round(v);
const pt = ([x, y]) => [r(x * sx), r(y * sy)];
const len = (v) => (v === undefined ? v : r(v * s));
const fine = (v) => (v === undefined ? v : r(v * sf));
const shape = (h) => (h.type === "poly" ? { type: "poly", pts: h.pts.map(pt) } : { type: "path", path: h.path.map(pt), w: h.w.map(len) });
const tex = (t) => (t === undefined ? t : { ...t, scale: len(t.scale), deep: len(t.deep), inset: len(t.inset) });
const clean = (o) => JSON.parse(JSON.stringify(o)); // drops undefined
const layers = d.layers.map((L) => clean({ ...L, shape: shape(L.shape), warp: len(L.warp), rough: fine(L.rough), feather: len(L.feather), edge: fine(L.edge), band: len(L.band), mud: tex(L.mud), firm: tex(L.firm) }));
const rock = d.rock.map((R) => clean({ ...R, shape: shape(R.shape), warp: len(R.warp), rough: fine(R.rough), feather: len(R.feather), clump: fine(R.clump), fadeX: R.fadeX?.map((x) => r(x * sx)), passes: R.passes?.map(([x, y, pr]) => [r(x * sx), r(y * sy), len(pr)]) })); // stone sizes and gaps are creature-scale and stay
const spec = { name, title, seed: d.seed, width: Number(W), height: Number(H), scale: +s.toFixed(4), ...(detailWidth === undefined ? {} : { fineScale: +sf.toFixed(4) }), layers, rock };
const body = JSON.stringify(spec, (k, v) => (Array.isArray(v) && v.every((e) => typeof e === "number") ? `\u0000${JSON.stringify(v)}\u0000` : v), 1).replace(/"\\u0000(.*?)\\u0000"/g, "$1");
console.log(`import type { MapSpec } from "./mapBuild.ts";\n\n// ${title}: ${d.tagline}.\n// Generated from docs/world-maps/tools/${basename(file)} by docs/world-maps/tools/to-engine.mjs (drafted at ${d.world.join(" x ")}, scaled to ${W} x ${H}${detailWidth === undefined ? "" : `, detail kept as at ${detailWidth} wide`}).\nexport const INLAND_SEA: MapSpec = ${body};`);
