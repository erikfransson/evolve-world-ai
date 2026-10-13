import { builtMap, mapSpec } from "../sim/maps/index.ts";
import { terrainOf } from "../sim/terrain.ts";
import { rockGeometry } from "../ui/rockOutline.ts";
import type { RockGeometry } from "../ui/rockOutline.ts";

// Builds a hand-designed map off the page's thread (a few seconds for The Inland Sea) with its rock outlines, and sends back the raw
// arrays, buffers transferred; the page checks them and puts the Terrain together (live/mapTerrain.ts). One map per worker, which the page then closes.

export type MapIn = { name: string };
export type MapOut = { ok: true; rock: Float64Array; ground: Uint8Array; food: Uint8Array; poison: Uint8Array; outlines: RockGeometry; ms: number } | { ok: false; message: string };

self.onmessage = (e: MessageEvent<MapIn>) => {
  const post = (m: MapOut, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(m, transfer);
  try {
    const name = e.data?.name;
    const spec = typeof name === "string" ? mapSpec(name) : undefined;
    if (!spec) return post({ ok: false, message: "unknown map" });
    const t0 = performance.now();
    const b = builtMap(spec.name);
    const terrain = terrainOf({ seed: 0, world: { width: spec.width, height: spec.height, stoneDensity: 0, ridgeDensity: 0, slowDensity: 0, fastDensity: 0, map: spec.name } });
    const outlines = rockGeometry(terrain);
    const rock = new Float64Array(3 * b.rock.length);
    b.rock.forEach((d, i) => rock.set([d.x, d.y, d.r], 3 * i));
    const { data } = b.ground;
    const { food, poison } = b.weights;
    const buffers = [rock.buffer, data.buffer, food.buffer, poison.buffer, outlines.box.buffer, outlines.bodyLoops.buffer, outlines.loopPoints.buffer, outlines.points.buffer];
    post({ ok: true, rock, ground: data, food, poison, outlines, ms: Math.round(performance.now() - t0) }, buffers);
  } catch (err) {
    post({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
