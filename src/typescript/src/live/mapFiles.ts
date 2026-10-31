import inlandSea from "./maps/inland-sea.bin?url";
import inlandPreview from "./maps/inland-sea-ground-preview.webp?inline";
import inlandLow from "./maps/inland-sea-ground-0.025.webp?url";
import inlandHigh from "./maps/inland-sea-ground-0.05.webp?url";
import inlandWinter from "./maps/inland-sea-ground-winter.png?url";
import type { BackdropFiles } from "../ui/groundBackdrop.ts";

// The prebuilt map files the build ships (live/mapAsset.ts), by map name; `node scripts/buildMapAsset.ts` remakes them after a map change.
export const MAP_FILES: Readonly<Record<string, string>> = { "inland-sea": inlandSea };

// The ground pictures of each map (ui/groundBackdrop.ts); `node scripts/buildMapImage.ts` remakes them after a map or look change.
export const GROUND_FILES: Readonly<Record<string, BackdropFiles>> = {
  "inland-sea": { preview: inlandPreview, images: { "0.025": inlandLow, "0.05": inlandHigh }, winter: inlandWinter },
};
