/// <reference types="vite/client" />
import clock from "./maps/clock.bin?url";
import clockLow from "./maps/clock-ground-0.025.webp?url";
import clockHigh from "./maps/clock-ground-0.05.webp?url";
import clockWinter from "./maps/clock-ground-winter.png?url";
import type { BackdropFiles } from "../ui/groundBackdrop.ts";

// The prebuilt map files the build ships (live/mapAsset.ts), by map name; `scripts/remakeClockAssets.sh` remakes them after a map change.
export const MAP_FILES: Readonly<Record<string, string>> = { clock };

// The ground pictures of each map (ui/groundBackdrop.ts; live.css shows them and the preview before any script); `node scripts/buildMapImage.ts` remakes them after a map or look change.
export const GROUND_FILES: Readonly<Record<string, BackdropFiles>> = {
  clock: { images: { "0.025": clockLow, "0.05": clockHigh }, winter: clockWinter },
};
