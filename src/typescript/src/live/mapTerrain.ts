import { mapSpec } from "../sim/maps/index.ts";
import { unpackMap } from "../sim/maps/mapParts.ts";
import { Terrain } from "../sim/terrain.ts";
import { useRockGeometry } from "../ui/rockOutline.ts";
import type { RockGeometry } from "../ui/rockOutline.ts";
import type { MapOut } from "../worker/mapWorker.ts";

const MAX_ROCK = 8000; // discs, mapBuild's own limit, and so the most bodies
export const MAX_OUTLINE_LOOPS = 65_536; // the Inland Sea has 209
export const MAX_OUTLINE_POINTS = 1_000_000; // 16 MB of points; the Inland Sea has 12 674
const OUTLINE_PAD = 1000; // world units outlines and boxes may reach past the walls

// Whether every value is finite and inside lo..hi.
const within = (a: Float64Array, lo: number, hi: number): boolean => {
  for (let i = 0; i < a.length; i++) if (!(a[i]! >= lo && a[i]! <= hi)) return false;
  return true;
};
// Whether a cumulative count array rises by at least `step` each entry, from 0, and ends at `total`.
const cumulative = (a: Uint32Array, step: number, total: number): boolean => {
  let prev = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < prev + step) return false;
    prev = a[i]!;
  }
  return prev === total;
};

// Rock outlines from the worker that fit a world of this size: bounded counts, cumulative arrays that rise and add up, at least
// 3 points a loop and 1 loop a body, every coordinate finite and near the world.
export function checkOutlines(g: unknown, width: number, height: number): g is RockGeometry {
  if (typeof g !== "object" || g === null) return false;
  const { bodyLoops, loopPoints, points } = g as Partial<RockGeometry>;
  if (!(bodyLoops instanceof Uint32Array) || !(loopPoints instanceof Uint32Array) || !(points instanceof Float64Array)) return false;
  const bodies = bodyLoops.length;
  if (bodies > MAX_ROCK || loopPoints.length > MAX_OUTLINE_LOOPS || points.length > 2 * MAX_OUTLINE_POINTS || points.length % 2 !== 0) return false;
  if (!cumulative(bodyLoops, 0, loopPoints.length) || !cumulative(loopPoints, 3, points.length / 2)) return false;
  const lo = -OUTLINE_PAD;
  const hi = Math.max(width, height) + OUTLINE_PAD;
  return within(points, lo, hi);
}

// The Terrain of a hand-designed map from the worker's arrays, its rock outlines in place, or null when they do not fit the map (checked, never trusted).
export function terrainFromParts(name: string, width: number, height: number, m: MapOut): Terrain | null {
  const spec = mapSpec(name);
  if (!spec || spec.width !== width || spec.height !== height || !m.ok) return null;
  if (!checkOutlines(m.outlines, width, height)) return null;
  let map: ReturnType<typeof unpackMap>;
  try {
    map = unpackMap(width, height, m);
  } catch {
    return null;
  }
  const t = new Terrain(map.rock, map.ground, width, height, map.weights);
  try {
    useRockGeometry(t, m.outlines); // throws when the bodies are not this map's
  } catch {
    return null;
  }
  return t;
}

export const MAP_TIMEOUT_MS = 60_000; // a map not built by then (a stuck or very slow worker) is given up, and the next hello tries again
type MapWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;
const newWorker = (): MapWorker => new Worker(new URL("../worker/mapWorker.ts", import.meta.url), { type: "module" });

// Builds a map on a worker so the page stays responsive; resolves to its Terrain, null when it cannot be built in timeoutMs, or "stale"
// when the server's map data (version, from the hello) is not this page's: the page then draws plain ground until it is updated.
export type MapResult = Terrain | null | "stale";
export function loadMapTerrain(name: string, width: number, height: number, timeoutMs = MAP_TIMEOUT_MS, makeWorker: () => MapWorker = newWorker, version?: string): Promise<MapResult> {
  return new Promise((resolve) => {
    let worker: MapWorker;
    try {
      worker = makeWorker();
    } catch {
      return resolve(null);
    }
    let settled = false;
    const done = (t: MapResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(t);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    worker.onmessage = (e: MessageEvent<MapOut>) => done(version !== undefined && e.data?.ok && e.data.version !== version ? "stale" : terrainFromParts(name, width, height, e.data));
    worker.onerror = () => done(null);
    worker.postMessage({ name });
  });
}

// One map for the page at a time: the same name and size share one build; a build that failed or timed out is forgotten, so the next asks again.
export class MapCache {
  private key = "";
  private promise: Promise<MapResult> | null = null;
  private readonly load: typeof loadMapTerrain;

  constructor(load: typeof loadMapTerrain = loadMapTerrain) {
    this.load = load;
  }

  get(name: string, width: number, height: number, version?: string): Promise<MapResult> {
    const key = `${name}|${width}|${height}|${version ?? ""}`;
    if (key !== this.key || !this.promise) {
      this.key = key;
      const p = this.load(name, width, height, undefined, undefined, version);
      this.promise = p;
      void p.then((t) => {
        if ((t === null || t === "stale") && this.promise === p) this.promise = null;
      });
    }
    return this.promise;
  }
}
