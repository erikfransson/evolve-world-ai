import { builtMap, mapSpec } from "../sim/maps/index.ts";

// Builds a hand-designed map off the page's thread (about a second for The Inland Sea) and sends back its raw arrays, buffers transferred;
// the page puts the Terrain together from them (live/mapTerrain.ts). One map per worker, which the page then closes.

export type MapIn = { name: string };
export type MapOut = { ok: true; rock: Float64Array; ground: Uint8Array; food: Uint8Array; poison: Uint8Array; ms: number } | { ok: false; message: string };

self.onmessage = (e: MessageEvent<MapIn>) => {
  const post = (m: MapOut, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(m, transfer);
  try {
    const name = e.data?.name;
    if (typeof name !== "string" || !mapSpec(name)) return post({ ok: false, message: "unknown map" });
    const t0 = performance.now();
    const b = builtMap(name);
    const rock = new Float64Array(3 * b.rock.length);
    b.rock.forEach((d, i) => rock.set([d.x, d.y, d.r], 3 * i));
    const { data } = b.ground;
    const { food, poison } = b.weights;
    post({ ok: true, rock, ground: data, food, poison, ms: Math.round(performance.now() - t0) }, [rock.buffer, data.buffer, food.buffer, poison.buffer]);
  } catch (err) {
    post({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
