// Writes the prebuilt Live map files (src/live/maps/<name>.bin, gzipped) from the map builder and the drawing code; maps.test.ts fails while one is stale.
// Run from src/typescript: node scripts/buildMapAsset.ts
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { encodeMapAsset } from "../src/live/mapAsset.ts";

for (const name of ["inland-sea"]) {
  const raw = encodeMapAsset(name);
  const gz = gzipSync(raw, { level: 9 });
  const path = new URL(`../src/live/maps/${name}.bin`, import.meta.url);
  writeFileSync(path, gz);
  console.log(`${name}: ${raw.length} bytes, ${gz.length} gzipped -> ${path.pathname}`);
}
