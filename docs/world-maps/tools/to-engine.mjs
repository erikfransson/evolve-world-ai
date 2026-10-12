// usage: node to-engine.mjs map-F4.json <width> <height> <name> <title> > src/typescript/src/sim/maps/<file>.ts
// Scales a draft layer spec to a new world size: coordinates by the two axis factors, lengths and noise wavelengths by their mean.
import { readFileSync } from "node:fs";
const [file, W, H, name, title] = process.argv.slice(2);
const d = JSON.parse(readFileSync(file, "utf8"));
const sx = Number(W) / d.world[0], sy = Number(H) / d.world[1], s = (sx + sy) / 2;
const r = (v) => Math.round(v);
const pt = ([x, y]) => [r(x * sx), r(y * sy)];
const len = (v) => (v === undefined ? v : r(v * s));
const shape = (h) => (h.type === "poly" ? { type: "poly", pts: h.pts.map(pt) } : { type: "path", path: h.path.map(pt), w: h.w.map(len) });
const tex = (t) => (t === undefined ? t : { ...t, scale: len(t.scale), deep: len(t.deep), inset: len(t.inset) });
const clean = (o) => JSON.parse(JSON.stringify(o)); // drops undefined
const layers = d.layers.map((L) => clean({ ...L, shape: shape(L.shape), warp: len(L.warp), rough: len(L.rough), feather: len(L.feather), edge: len(L.edge), band: len(L.band), mud: tex(L.mud), firm: tex(L.firm) }));
const rock = d.rock.map((R) => clean({ ...R, shape: shape(R.shape), warp: len(R.warp), rough: len(R.rough), feather: len(R.feather), clump: len(R.clump), passes: R.passes?.map(([x, y, pr]) => [r(x * sx), r(y * sy), len(pr)]) })); // stone sizes and gaps are creature-scale and stay
const spec = { name, title, seed: d.seed, width: Number(W), height: Number(H), scale: +s.toFixed(4), layers, rock };
const body = JSON.stringify(spec, (k, v) => (Array.isArray(v) && v.every((e) => typeof e === "number") ? `\u0000${JSON.stringify(v)}\u0000` : v), 1).replace(/"\\u0000(.*?)\\u0000"/g, "$1");
console.log(`import type { MapSpec } from "./mapBuild.ts";\n\n// ${title}: ${d.tagline}.\n// Generated from docs/world-maps/tools/map-F4.json by docs/world-maps/tools/to-engine.mjs (drafted at ${d.world.join(" x ")}, scaled to ${W} x ${H}).\nexport const INLAND_SEA: MapSpec = ${body};`);
