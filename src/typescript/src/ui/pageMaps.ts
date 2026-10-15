import { MapCache } from "../live/mapTerrain.ts";
import { packMap } from "../sim/maps/mapParts.ts";
import type { MapParts } from "../sim/maps/mapParts.ts";
import type { MapReady } from "./mapReady.ts";
import { rockGeometryOf } from "./rockOutline.ts";

// A named map built once on a worker (the Live page's MapCache), which the Ecosystem page hands to whoever draws and to the simulation worker,
// so none of them builds it again.
export class PageMaps {
  private readonly cache: MapCache;
  private current: MapReady | null = null;

  constructor(load?: ConstructorParameters<typeof MapCache>[0]) {
    this.cache = new MapCache(load);
  }

  // The map once it is built, or null when it cannot be (the next ask tries again).
  async load(name: string, width: number, height: number): Promise<MapReady | null> {
    const t = await this.cache.get(name, width, height);
    const parts = t && packMap(t);
    const outlines = t && rockGeometryOf(t);
    if (!parts || !outlines) return null;
    return (this.current = { name, width, height, parts, outlines });
  }

  // The arrays of a map already built, for a run that starts with it.
  partsOf(name: string | undefined, width: number, height: number): MapParts | undefined {
    const m = this.current;
    return m && m.name === name && m.width === width && m.height === height ? m.parts : undefined;
  }
}
