import type { EcoConfig } from "../sim/ecoConfig.ts";
import type { MapReady } from "../ui/mapReady.ts";
import type { EcoDrawConfig } from "../ui/ecoScene.ts";
import type { SelectedDetails } from "./ecoProtocol.ts";

// Render worker (OffscreenCanvas): the page owns the camera and posts one frame request per animation frame; the
// simulation worker sends snapshots straight to it over a MessagePort and gets the buffers back on the same port.
export interface RenderSnapshot {
  type: "snapshot";
  run: number;
  count: number;
  itemCount: number;
  creatureCap: number;
  itemCap: number;
  buffer: ArrayBuffer;
  events?: Float32Array;
  selected: SelectedDetails | null;
}

export type RenderInMessage =
  | { type: "init"; canvas: OffscreenCanvas; port: MessagePort }
  | { type: "size"; width: number; height: number }
  | { type: "frame"; run: number; view: { cx: number; cy: number; zoom: number; focusX: number; focusY: number }; cfg: EcoDrawConfig; selectedId: number | null; showRays: boolean; dpr: number; highlight: number }
  | { type: "pick"; request: number; run: number; x: number; y: number; reach: number }
  | { type: "idle"; config: EcoConfig; dpr: number }
  | { type: "map"; map: MapReady }; // a named map built elsewhere, which this worker draws instead of building it

export type RenderOutMessage = { type: "ready" } | { type: "picked"; request: number; run: number; id: number; x: number; y: number };
