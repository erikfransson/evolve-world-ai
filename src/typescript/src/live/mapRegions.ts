import { mapSpec } from "../sim/maps/index.ts";
import type { WireRegion } from "./protocol.ts";

// The named regions of the hand-designed maps for the info table below the Live world: the spec layer whose food and poison weights
// the row shows (none: the map's base weights) and the words for its ground and role, after the map drafts in docs/world-maps/.
interface RegionText {
  name: string;
  layer: string | null;
  ground: string;
  role: string;
}
const REGIONS: Readonly<Record<string, readonly RegionText[]>> = {
  "inland-sea": [
    { name: "The Shallows", layer: "sea", ground: "mud, half speed", role: "slow, rich" },
    { name: "Isles", layer: "isle0", ground: "plain, beaches", role: "reachable by wading" },
    { name: "Ashfall Shore", layer: "ash", ground: "plain, talus", role: "poison, rich" },
    { name: "Dune Coast", layer: "dunecoast", ground: "4 firm dune fields", role: "fast, poor" },
    { name: "Drowned Town", layer: "karst", ground: "rock outcrops", role: "tight steering" },
    { name: "Cliff Coast", layer: null, ground: "massif, 2 passes", role: "barrier" },
    { name: "Open plain", layer: null, ground: "plain", role: "everywhere else" },
  ],
};

// The region rows of a map by name, food and poison as the spec's weights (1 is plain food); none for the random map or an unknown name.
export function mapRegions(name: string | undefined): WireRegion[] {
  const spec = name ? mapSpec(name) : undefined;
  if (!spec) return [];
  return (REGIONS[spec.name] ?? []).map((r) => {
    const layer = r.layer === null ? undefined : spec.layers.find((l) => l.id === r.layer);
    return { name: r.name, food: layer?.food ?? spec.baseFood ?? 1, poison: layer?.poison ?? spec.basePoison ?? 1, ground: r.ground, role: r.role };
  });
}
