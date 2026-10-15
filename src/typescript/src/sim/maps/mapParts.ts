import { GroundField } from "../groundField.ts";
import type { Terrain } from "../terrain.ts";
import { discsBlocked, MapWeights } from "./weights.ts";
import type { Disc } from "./weights.ts";

// A built hand-designed map as plain arrays, enough to rebuild its Terrain in another thread without the seconds the build takes. Every
// thread and page that gets a map's arrays from elsewhere goes through packMap and unpackMap.
export interface MapParts {
  rock: Float64Array; // x, y, r per disc
  ground: Uint8Array;
  food: Uint8Array;
  poison: Uint8Array;
}

export const MAX_MAP_DISCS = 8000; // the most rock discs a map has, which mapBuild enforces
export const MAX_MAP_DISC_R = 400; // the widest disc: stones reach 380 and massif discs 300

// The arrays of a map's Terrain, shared with it (postMessage clones them, or transfers them when asked); null when it is not a hand-designed map.
export function packMap(t: Pick<Terrain, "rockCount" | "rockX" | "rockY" | "rockR" | "ground" | "weights">): MapParts | null {
  if (!t.ground || !t.weights) return null;
  const rock = new Float64Array(3 * t.rockCount);
  for (let i = 0; i < t.rockCount; i++) rock.set([t.rockX[i]!, t.rockY[i]!, t.rockR[i]!], 3 * i);
  return { rock, ground: t.ground.data, food: t.weights.food, poison: t.weights.poison };
}

// The rock, ground and weights of a map of this size from its arrays. Throws when they do not fit: they are checked, never trusted.
export function unpackMap(width: number, height: number, parts: MapParts): { rock: Disc[]; ground: GroundField; weights: MapWeights } {
  const ground = new GroundField(width, height);
  const nodes = ground.cols * ground.rows;
  const { rock, food, poison } = parts;
  if (!(parts.ground instanceof Uint8Array) || parts.ground.length !== ground.data.length) throw new Error("ground does not fit the map");
  if (!(food instanceof Uint8Array) || !(poison instanceof Uint8Array) || food.length !== nodes || poison.length !== nodes) throw new Error("weights do not fit the map");
  if (!(rock instanceof Float64Array) || rock.length % 3 !== 0 || rock.length > 3 * MAX_MAP_DISCS || !rock.every(Number.isFinite)) throw new Error("rock does not fit the map");
  for (let i = 0; i < rock.length; i += 3) {
    const r = rock[i + 2]!;
    if (!(r > 0 && r <= MAX_MAP_DISC_R) || rock[i]! < -r || rock[i]! > width + r || rock[i + 1]! < -r || rock[i + 1]! > height + r) throw new Error("rock does not fit the map");
  }
  ground.data.set(parts.ground);
  const discs = Array.from({ length: rock.length / 3 }, (_, i) => ({ x: rock[3 * i]!, y: rock[3 * i + 1]!, r: rock[3 * i + 2]! }));
  return { rock: discs, ground, weights: new MapWeights(ground, food, poison, discsBlocked(discs, width)) };
}
