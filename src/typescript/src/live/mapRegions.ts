import { builtMap, mapSpec } from "../sim/maps/index.ts";
import { WEIGHT_UNIT } from "../sim/maps/weights.ts";
import { GROUND_PAD } from "../sim/groundField.ts";
import type { BuiltMap } from "../sim/maps/mapBuild.ts";
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

// A region's row read from the built map: food and poison weights and the ground at its centre and four points half a radius out.
function builtRow(b: BuiltMap, g: { title: string; x: number; y: number; r: number }): WireRegion {
  const { weights: w, ground } = b;
  const pts = [[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]].map(([a, c]) => [g.x + a! * g.r, g.y + c! * g.r] as const);
  let food = 0;
  let poison = 0;
  let mud = 0;
  let firm = 0;
  for (const [x, y] of pts) {
    const i = Math.round(x / w.cell) + GROUND_PAD + (Math.round(y / w.cell) + GROUND_PAD) * w.cols;
    food += w.food[i]! / WEIGHT_UNIT / pts.length;
    poison += w.poison[i]! / WEIGHT_UNIT / pts.length;
    mud += ground.blend(0, x, y) / pts.length;
    firm += ground.blend(1, x, y) / pts.length;
  }
  const round = (v: number): number => Math.round(v * 100) / 100;
  const groundText = mud > 128 ? "mud, half speed" : firm > 128 ? "firm ground, fast" : mud > 40 ? "patches of mud" : firm > 40 ? "patches of firm ground" : "plain";
  const role = poison > 1 ? "poison, rich" : poison > 0.5 ? "some poison" : food >= 1.5 ? "rich" : food >= 0.3 ? "moderate" : "poor"; // 1 is plain food
  return { name: g.title, food: round(food), poison: round(poison), ground: groundText, role };
}

// The region rows of a map by name, food and poison as the built weights (1 is plain food); none for the random map or an unknown name.
// A map with `regions` gets its rows from them, any other from the table above.
export function mapRegions(name: string | undefined): WireRegion[] {
  const spec = name ? mapSpec(name) : undefined;
  if (!spec) return [];
  if (spec.regions?.length) {
    const b = builtMap(spec.name);
    return spec.regions.map((g) => builtRow(b, g));
  }
  return (REGIONS[spec.name] ?? []).map((r) => {
    const layer = r.layer === null ? undefined : spec.layers.find((l) => l.id === r.layer);
    return { name: r.name, food: layer?.food ?? spec.baseFood ?? 1, poison: layer?.poison ?? spec.basePoison ?? 1, ground: r.ground, role: r.role };
  });
}
