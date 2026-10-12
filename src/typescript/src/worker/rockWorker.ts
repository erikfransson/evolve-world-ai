import { terrainOf } from "../sim/terrain.ts";
import type { TerrainSettings } from "../sim/terrain.ts";
import { rockGeometry } from "../ui/rockOutline.ts";
import type { RockGeometry } from "../ui/rockOutline.ts";

// Traces the outlines of a map's rock off the page's thread (they take about a second on a big map), see rockPrefetch.ts.

export type RockIn = TerrainSettings;
export type RockOut = RockGeometry | null; // null when it failed

self.onmessage = (e: MessageEvent<RockIn>) => {
  try {
    const g = rockGeometry(terrainOf(e.data));
    (self as unknown as Worker).postMessage(g, [g.box.buffer, g.bodyLoops.buffer, g.loopPoints.buffer, g.points.buffer]);
  } catch {
    (self as unknown as Worker).postMessage(null); // the page then traces the outlines itself, body by body, as it draws them
  }
};
