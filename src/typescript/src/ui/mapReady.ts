import type { MapParts } from "../sim/maps/mapParts.ts";
import { mapTerrain, seedMapTerrain } from "../sim/terrain.ts";
import { useRockGeometry } from "./rockOutline.ts";
import type { RockGeometry } from "./rockOutline.ts";

// A named map built elsewhere (the page's map worker), as the arrays a thread needs to draw and run it without the map builder.
export interface MapReady {
  name: string;
  width: number;
  height: number;
  parts: MapParts;
  outlines: RockGeometry;
}

// Makes terrainOf return this map in this thread without building it.
export function applyMap(m: MapReady): void {
  seedMapTerrain(m.name, m.width, m.height, m.parts);
  useRockGeometry(mapTerrain(m.name, m.width, m.height), m.outlines);
}
