import { mapSpec } from "../sim/maps/index.ts";
import { packMap } from "../sim/maps/mapParts.ts";
import type { MapParts } from "../sim/maps/mapParts.ts";
import { mapTerrain } from "../sim/terrain.ts";
import { rockGeometry } from "../ui/rockOutline.ts";
import type { RockGeometry } from "../ui/rockOutline.ts";

// Builds a hand-designed map off the page's thread (a few seconds for The Inland Sea) with its rock outlines, and sends back the raw
// arrays, buffers transferred; the page checks them and puts the Terrain together (live/mapTerrain.ts). One map per worker, which the page then closes.

export type MapIn = { name: string };
export type MapOut = ({ ok: true; outlines: RockGeometry; ms: number } & MapParts) | { ok: false; message: string };

self.onmessage = (e: MessageEvent<MapIn>) => {
  const post = (m: MapOut, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(m, transfer);
  try {
    const name = e.data?.name;
    const spec = typeof name === "string" ? mapSpec(name) : undefined;
    if (!spec) return post({ ok: false, message: "unknown map" });
    const t0 = performance.now();
    const terrain = mapTerrain(spec.name, spec.width, spec.height);
    const parts = packMap(terrain)!;
    const outlines = rockGeometry(terrain);
    const buffers = [parts.rock.buffer, parts.ground.buffer, parts.food.buffer, parts.poison.buffer, outlines.bodyLoops.buffer, outlines.loopPoints.buffer, outlines.points.buffer];
    post({ ok: true, ...parts, outlines, ms: Math.round(performance.now() - t0) }, buffers);
  } catch (err) {
    post({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
