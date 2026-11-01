import { mapSpec, mapVersion } from "../sim/maps/index.ts";
import { packMap } from "../sim/maps/mapParts.ts";
import { mapTerrain } from "../sim/terrain.ts";
import type { Terrain } from "../sim/terrain.ts";
import { tintPixels, seedTint } from "../ui/mapTint.ts";
import { floorPixels, seedFloorImage } from "../ui/noiseTex.ts";
import { rockGeometry } from "../ui/rockOutline.ts";
import type { MapOut } from "../worker/mapWorker.ts";
import { loadMapTerrain, terrainFromParts } from "./mapTerrain.ts";

// A hand-designed map prebuilt for the Live page: the arrays the map worker would make (rock, ground, weights, rock outlines) plus the
// floor and wash pixels, made by the same code ahead of time (scripts/buildMapAsset.ts) and shipped gzipped as a static file, so a first
// visit draws the map at once instead of building it for seconds. mapAsset.test.ts checks the shipped file still equals a fresh build.
// The page checks everything in it as it checks the worker's arrays, and builds the map on the worker when the file is missing or does not fit.

const MAGIC = "EWMAP1";
const SECTIONS = ["rock", "ground", "food", "poison", "bodyLoops", "loopPoints", "points", "floor", "tint"] as const;
type Key = (typeof SECTIONS)[number];
const TYPES: Record<Key, Float64ArrayConstructor | Uint32ArrayConstructor | Uint8ArrayConstructor | Uint8ClampedArrayConstructor> = {
  rock: Float64Array,
  ground: Uint8Array,
  food: Uint8Array,
  poison: Uint8Array,
  bodyLoops: Uint32Array,
  loopPoints: Uint32Array,
  points: Float64Array,
  floor: Uint8ClampedArray,
  tint: Uint8ClampedArray,
};
const MAX_ASSET_BYTES = 32 << 20; // unzipped; the Inland Sea's is about 3 MB
const pad8 = (n: number): number => (n + 7) & ~7;

interface Header {
  name: string;
  version: string;
  width: number;
  height: number;
  sizes: number[]; // bytes per section, in SECTIONS order
}

// The unzipped file of a map: magic, header length (u32), header JSON, then each section on an 8-byte boundary.
export function encodeMapAsset(name: string): Uint8Array {
  const spec = mapSpec(name);
  if (!spec) throw new Error(`unknown map "${name}"`);
  const t = mapTerrain(spec.name, spec.width, spec.height);
  const parts = packMap(t)!;
  const g = rockGeometry(t);
  const data: Record<Key, ArrayBufferView> = { ...parts, ...g, floor: floorPixels(spec.width, spec.height), tint: tintPixels(t) };
  const header: Header = { name, version: mapVersion(name), width: spec.width, height: spec.height, sizes: SECTIONS.map((k) => data[k].byteLength) };
  const head = new TextEncoder().encode(JSON.stringify(header));
  let at = pad8(MAGIC.length + 4 + head.length);
  const out = new Uint8Array(at + header.sizes.reduce((s, n) => s + pad8(n), 0));
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(MAGIC.length, head.length, true);
  out.set(head, MAGIC.length + 4);
  for (const k of SECTIONS) {
    const v = data[k];
    out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), at);
    at += pad8(v.byteLength);
  }
  return out;
}

export interface MapAsset {
  parts: MapOut;
  floor: Uint8ClampedArray<ArrayBuffer>;
  tint: Uint8ClampedArray<ArrayBuffer>;
}

// The sections of an unzipped file of this map, version and size; null when it is not one. Only the layout is checked here: the arrays
// go through the same checks as the worker's (terrainFromParts) and the pixels must fit their images (seedFloorImage, seedTint).
export function decodeMapAsset(bytes: Uint8Array, name: string, width: number, height: number): MapAsset | null {
  try {
    if (bytes.length > MAX_ASSET_BYTES || bytes.length < MAGIC.length + 4 || new TextDecoder().decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) return null;
    const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(MAGIC.length, true);
    if (MAGIC.length + 4 + n > bytes.length) return null;
    const h = JSON.parse(new TextDecoder().decode(bytes.subarray(MAGIC.length + 4, MAGIC.length + 4 + n))) as Partial<Header>;
    if (h.name !== name || h.version !== mapVersion(name) || h.width !== width || h.height !== height) return null;
    const sizes = h.sizes;
    if (!Array.isArray(sizes) || sizes.length !== SECTIONS.length) return null;
    let at = pad8(MAGIC.length + 4 + n);
    const out = {} as Record<Key, ArrayBufferView>;
    for (let i = 0; i < SECTIONS.length; i++) {
      const k = SECTIONS[i]!;
      const size = sizes[i];
      const T = TYPES[k];
      if (!Number.isInteger(size) || size! < 0 || size! % T.BYTES_PER_ELEMENT !== 0 || at + size! > bytes.length) return null;
      const copy = new Uint8Array(size!); // a copy: aligned, and its own buffer (a Node Buffer's slice would be a view)
      copy.set(bytes.subarray(at, at + size!));
      out[k] = new T(copy.buffer);
      at += pad8(size!);
    }
    const o = out as unknown as { rock: Float64Array; ground: Uint8Array; food: Uint8Array; poison: Uint8Array; bodyLoops: Uint32Array; loopPoints: Uint32Array; points: Float64Array; floor: Uint8ClampedArray<ArrayBuffer>; tint: Uint8ClampedArray<ArrayBuffer> };
    return {
      parts: { ok: true, ms: 0, rock: o.rock, ground: o.ground, food: o.food, poison: o.poison, outlines: { bodyLoops: o.bodyLoops, loopPoints: o.loopPoints, points: o.points } },
      floor: o.floor,
      tint: o.tint,
    };
  } catch {
    return null;
  }
}

// The Terrain of a map from a decoded file, its floor and wash seeded for drawing; null when anything does not fit.
export function terrainFromAsset(name: string, width: number, height: number, a: MapAsset): Terrain | null {
  const t = terrainFromParts(name, width, height, a.parts);
  if (!t || !seedFloorImage(width, height, a.floor) || !seedTint(t, a.tint)) return null;
  return t;
}

// Gunzips a fetched file (a server may already have taken the gzip off in transit).
async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Fetches and puts together the prebuilt map at url; null when it cannot (then the caller builds the map on a worker).
export async function loadMapAsset(url: string, name: string, width: number, height: number, timeoutMs = 20_000): Promise<Terrain | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const a = decodeMapAsset(await gunzip(new Uint8Array(await res.arrayBuffer())), name, width, height);
    return a ? terrainFromAsset(name, width, height, a) : null;
  } catch {
    return null;
  }
}

// The page's map loader: the prebuilt file when there is one for the map (files: name -> url), else (or when it fails) the worker build.
export function mapLoader(files: Readonly<Record<string, string>>): (name: string, width: number, height: number) => Promise<Terrain | null> {
  return async (name, width, height) => {
    const url = Object.hasOwn(files, name) ? files[name] : undefined;
    return (url ? await loadMapAsset(url, name, width, height) : null) ?? loadMapTerrain(name, width, height);
  };
}
