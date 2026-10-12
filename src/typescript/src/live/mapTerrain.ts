import { GroundField } from "../sim/groundField.ts";
import { MapWeights } from "../sim/maps/mapBuild.ts";
import { mapSpec } from "../sim/maps/index.ts";
import { Terrain } from "../sim/terrain.ts";
import type { MapOut } from "../worker/mapWorker.ts";

const MAX_ROCK = 8000; // discs, mapBuild's own limit

// The Terrain of a hand-designed map from the worker's arrays, or null when they do not fit the map's size (checked, never trusted).
export function terrainFromParts(name: string, width: number, height: number, m: MapOut): Terrain | null {
  const spec = mapSpec(name);
  if (!spec || spec.width !== width || spec.height !== height || !m.ok) return null;
  const ground = new GroundField(width, height);
  const nodes = ground.cols * ground.rows;
  const { rock } = m;
  if (!(m.ground instanceof Uint8Array) || m.ground.length !== ground.data.length) return null;
  if (!(m.food instanceof Uint8Array) || !(m.poison instanceof Uint8Array) || m.food.length !== nodes || m.poison.length !== nodes) return null;
  if (!(rock instanceof Float64Array) || rock.length % 3 !== 0 || rock.length > 3 * MAX_ROCK || !rock.every(Number.isFinite)) return null;
  ground.data.set(m.ground);
  const discs = Array.from({ length: rock.length / 3 }, (_, i) => ({ x: rock[3 * i]!, y: rock[3 * i + 1]!, r: rock[3 * i + 2]! }));
  return new Terrain(discs, ground, width, height, new MapWeights(ground, m.food, m.poison, discs));
}

// Builds a map on a worker so the page stays responsive; resolves to its Terrain, or null when it cannot be built.
export function loadMapTerrain(name: string, width: number, height: number): Promise<Terrain | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("../worker/mapWorker.ts", import.meta.url), { type: "module" });
    } catch {
      return resolve(null);
    }
    const done = (t: Terrain | null): void => {
      worker.terminate();
      resolve(t);
    };
    worker.onmessage = (e: MessageEvent<MapOut>) => done(terrainFromParts(name, width, height, e.data));
    worker.onerror = () => done(null);
    worker.postMessage({ name });
  });
}
