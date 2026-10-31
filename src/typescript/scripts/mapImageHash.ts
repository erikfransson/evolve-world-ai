// What the shipped ground pictures were drawn from (scripts/buildMapImage.ts): the map's prebuilt file and the drawing code, as hashes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const root = new URL("..", import.meta.url);
// The code a ground picture is drawn by; a change to any of these needs new pictures.
export const LOOK_FILES = [
  "src/ui/terrainScene.ts",
  "src/ui/groundScene.ts",
  "src/ui/groundOutline.ts",
  "src/ui/abyssRock.ts",
  "src/ui/rockOutline.ts",
  "src/ui/noiseTex.ts",
  "src/ui/mapTint.ts",
  "src/ui/palette.ts",
  "src/ui/edt.ts",
  "src/ui/canvas.ts",
  "src/geom/contour.ts",
  "src/ui/groundBackdrop.ts",
  "scripts/mapImage.ts",
];

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export function groundImageHashes(name: string): { map: string; look: string } {
  const map = sha(gunzipSync(readFileSync(new URL(`src/live/maps/${name}.bin`, root))));
  const h = createHash("sha256");
  for (const f of LOOK_FILES) h.update(f).update(readFileSync(new URL(f, root)));
  return { map, look: h.digest("hex") };
}
