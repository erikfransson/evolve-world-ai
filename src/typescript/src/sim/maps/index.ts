import { INLAND_SEA } from "./inlandSea.ts";
import { buildMap } from "./mapBuild.ts";
import type { BuiltMap, MapSpec } from "./mapBuild.ts";

// The hand-designed maps a world can name with world.map ("" for the random map). Each is built once per process from its spec alone,
// so the name is all a save, a helper thread or a Live config needs.
export const MAPS: Readonly<Record<string, MapSpec>> = { [INLAND_SEA.name]: INLAND_SEA };

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

const versions = new Map<string, string>();

// A hash of the built rock, ground and weights, so a save can tell that the map data changed under the same name. Pinned in maps.test.ts.
export function mapVersion(name: string): string {
  let v = versions.get(name);
  if (v === undefined) {
    const b = builtMap(name);
    let h = 0x811c9dc5;
    const feed = (a: Uint8Array): void => {
      for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i]!, 0x01000193);
    };
    const rock = new Float64Array(b.rock.length * 3);
    b.rock.forEach((d, i) => rock.set([d.x, d.y, d.r], 3 * i));
    for (const a of [b.ground.data, b.weights.food, b.weights.poison, new Uint8Array(rock.buffer)]) feed(a);
    versions.set(name, (v = (h >>> 0).toString(16).padStart(8, "0")));
  }
  return v;
}
