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
