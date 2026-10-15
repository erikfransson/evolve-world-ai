import { mapSpec } from "../sim/maps/index.ts";

// A hash of a map's design (its spec as JSON), for the hello: the page compares it with its own bundle. It hashes plain data, never
// built floats, so every browser gets the same value (sin, cos and hypot may differ in the last bit between engines). "" for an unknown map.
export function specVersion(name: string): string {
  const spec = mapSpec(name);
  if (!spec) return "";
  const s = JSON.stringify(spec);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}
