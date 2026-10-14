import { GroundField } from "../sim/groundField.ts";
import { MapWeights } from "../sim/maps/mapBuild.ts";
import { mapSpec } from "../sim/maps/index.ts";
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
// 3 points a loop and 1 loop a body, every coordinate finite and near the world, boxes the right way round.
export function checkOutlines(g: unknown, width: number, height: number): g is RockGeometry {
  if (typeof g !== "object" || g === null) return false;
  const { box, bodyLoops, loopPoints, points } = g as Partial<RockGeometry>;
  if (!(box instanceof Float64Array) || !(bodyLoops instanceof Uint32Array) || !(loopPoints instanceof Uint32Array) || !(points instanceof Float64Array)) return false;
  const bodies = bodyLoops.length;
  if (bodies > MAX_ROCK || loopPoints.length > MAX_OUTLINE_LOOPS || points.length > 2 * MAX_OUTLINE_POINTS || points.length % 2 !== 0 || box.length !== 4 * bodies) return false;
  if (!cumulative(bodyLoops, 1, loopPoints.length) || !cumulative(loopPoints, 3, points.length / 2)) return false;
  const lo = -OUTLINE_PAD;
  const hi = Math.max(width, height) + OUTLINE_PAD;
  if (!within(box, lo, hi) || !within(points, lo, hi)) return false;
  for (let b = 0; b < bodies; b++) if (box[4 * b]! > box[4 * b + 2]! || box[4 * b + 1]! > box[4 * b + 3]!) return false;
  return true;
}

// The Terrain of a hand-designed map from the worker's arrays, its rock outlines in place, or null when they do not fit the map (checked, never trusted).
export function terrainFromParts(name: string, width: number, height: number, m: MapOut): Terrain | null {
  const spec = mapSpec(name);
  if (!spec || spec.width !== width || spec.height !== height || !m.ok) return null;
  const ground = new GroundField(width, height);
  const nodes = ground.cols * ground.rows;
  const { rock } = m;
  if (!(m.ground instanceof Uint8Array) || m.ground.length !== ground.data.length) return null;
  if (!(m.food instanceof Uint8Array) || !(m.poison instanceof Uint8Array) || m.food.length !== nodes || m.poison.length !== nodes) return null;
  if (!(rock instanceof Float64Array) || rock.length % 3 !== 0 || rock.length > 3 * MAX_ROCK || !rock.every(Number.isFinite)) return null;
  if (!checkOutlines(m.outlines, width, height)) return null;
  ground.data.set(m.ground);
  const discs = Array.from({ length: rock.length / 3 }, (_, i) => ({ x: rock[3 * i]!, y: rock[3 * i + 1]!, r: rock[3 * i + 2]! }));
  const t = new Terrain(discs, ground, width, height, new MapWeights(ground, m.food, m.poison, discs));
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

// Builds a map on a worker so the page stays responsive; resolves to its Terrain, or null when it cannot be built in timeoutMs.
export function loadMapTerrain(name: string, width: number, height: number, timeoutMs = MAP_TIMEOUT_MS, makeWorker: () => MapWorker = newWorker): Promise<Terrain | null> {
  return new Promise((resolve) => {
    let worker: MapWorker;
    try {
      worker = makeWorker();
    } catch {
      return resolve(null);
    }
    let settled = false;
    const done = (t: Terrain | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(t);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    worker.onmessage = (e: MessageEvent<MapOut>) => done(terrainFromParts(name, width, height, e.data));
    worker.onerror = () => done(null);
    worker.postMessage({ name });
  });
}

// One map for the page at a time: the same name and size share one build; a build that failed or timed out is forgotten, so the next asks again.
export class MapCache {
  private key = "";
  private promise: Promise<Terrain | null> | null = null;
  private readonly load: typeof loadMapTerrain;

  constructor(load: typeof loadMapTerrain = loadMapTerrain) {
    this.load = load;
  }

  get(name: string, width: number, height: number): Promise<Terrain | null> {
    const key = `${name}|${width}|${height}`;
    if (key !== this.key || !this.promise) {
      this.key = key;
      const p = this.load(name, width, height);
      this.promise = p;
      void p.then((t) => {
        if (!t && this.promise === p) this.promise = null;
      });
    }
    return this.promise;
  }
}
