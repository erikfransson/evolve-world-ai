import { INLAND_SEA } from "./inlandSea.ts";
import { CLOCK } from "./clock.ts";
import { registerMaps, Terrain } from "../terrain.ts";
import { packMap, unpackMap } from "./mapParts.ts";
import type { MapParts } from "./mapParts.ts";
import { buildMap, MAP_BUILD } from "./mapBuild.ts";
import type { BuiltMap, MapSpec } from "./mapBuild.ts";

// The hand-designed maps a world can name with world.map ("" for the random map). Each is built once per process from its spec alone,
// so the name is all a save, a helper thread or a Live config needs.
export const MAPS: Readonly<Record<string, MapSpec>> = { [INLAND_SEA.name]: INLAND_SEA, [CLOCK.name]: CLOCK };

export const mapSpec = (name: string): MapSpec | undefined => (Object.hasOwn(MAPS, name) ? MAPS[name] : undefined);

const built = new Map<string, BuiltMap>();

// The built map of a known name; throws for an unknown one.
export function builtMap(name: string): BuiltMap {
  const spec = mapSpec(name);
  if (!spec) throw new Error(`unknown map "${name}"`);
  let b = built.get(name);
  if (!b) built.set(name, (b = buildMap(spec)));
  return b;
}

// A built map as arrays for another thread (a save worker), so it need not build it again: seconds for a large map.
export function packedMap(name: string): { parts: MapParts; stats: BuiltMap["stats"] } {
  const b = builtMap(name);
  const spec = mapSpec(name)!;
  return { parts: packMap(new Terrain(b.rock, b.ground, spec.width, spec.height, b.weights))!, stats: b.stats };
}

// Takes a map packedMap made in this process's parent as this thread's built map; the arrays are checked to fit (unpackMap).
// Only for arrays from the server itself, never from a file or a visitor.
export function seedBuiltMap(name: string, packed: { parts: MapParts; stats: BuiltMap["stats"] }): void {
  const spec = mapSpec(name);
  if (!spec || built.has(name)) return;
  built.set(name, { ...unpackMap(spec.width, spec.height, packed.parts), stats: packed.stats });
}

const fnv = (h: number, a: Uint8Array): number => {
  for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i]!, 0x01000193);
  return h;
};
const hex = (h: number): string => (h >>> 0).toString(16).padStart(8, "0");
const versions = new Map<string, string>();

// The version a save and the Live hello carry: a hash of the spec plus MAP_BUILD. It never depends on floating point results, which may
// differ by an ulp between engines or Node versions, so a host upgrade cannot turn the running world's saves into another world's.
export function mapVersion(name: string): string {
  let v = versions.get(name);
  if (v === undefined) {
    const spec = mapSpec(name);
    if (!spec) throw new Error(`unknown map "${name}"`);
    versions.set(name, (v = `${hex(fnv(0x811c9dc5, new TextEncoder().encode(JSON.stringify(spec))))}-${MAP_BUILD}`));
  }
  return v;
}

// A hash of the built rock, ground and weights, for maps.test.ts only: it pins what the builder makes, so a change to the output with
// the same spec and MAP_BUILD fails a test instead of silently restoring saves onto different rock.
export function builtHash(name: string): string {
  const b = builtMap(name);
  const spec = mapSpec(name)!;
  const parts = packMap(new Terrain(b.rock, b.ground, spec.width, spec.height, b.weights))!;
  return hex([parts.ground, parts.food, parts.poison, new Uint8Array(parts.rock.buffer), ...(parts.paint ? [parts.paint] : [])].reduce(fnv, 0x811c9dc5));
}

registerMaps({ spec: mapSpec, built: builtMap });
