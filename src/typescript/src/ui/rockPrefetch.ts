import { terrainOf } from "../sim/terrain.ts";
import type { Terrain, TerrainSettings } from "../sim/terrain.ts";
import { useRockGeometry } from "./rockOutline.ts";
import type { RockOut } from "../worker/rockWorker.ts";

const started = new WeakSet<Terrain>();
const MIN_DISCS = 1000; // smaller maps trace in well under a second on the page
let running = false; // one worker at a time, so settings edited in a form cannot pile them up

// Starts tracing the rock outlines of a big map on a Web Worker, once per map and one map at a time. Until they arrive the page traces each body when it first draws it.
export function prefetchRock(settings: TerrainSettings): void {
  const t = terrainOf(settings);
  if (t.rockCount < MIN_DISCS || running || started.has(t) || typeof Worker === "undefined") return;
  started.add(t);
  running = true;
  try {
    const w = new Worker(new URL("../worker/rockWorker.ts", import.meta.url), { type: "module" });
    const done = (): void => {
      running = false;
      w.terminate();
    };
    w.onmessage = (e: MessageEvent<RockOut>) => {
      try {
        if (e.data) useRockGeometry(t, e.data);
      } catch {
        // not this map's geometry: ignore
      }
      done();
    };
    w.onerror = done;
    w.postMessage(settings);
  } catch {
    running = false; // no worker here: the page traces them itself
  }
}
