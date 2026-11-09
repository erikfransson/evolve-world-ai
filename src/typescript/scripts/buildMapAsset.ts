// Writes the prebuilt Live map files (src/live/maps/<name>.bin, gzipped) from the map builder and the drawing code; mapAsset.test.ts fails while one is stale.
// Also writes tests/typescript/clockPins.json (the clock map's builtHash and mapVersion, which maps.test.ts checks; clock.ts is still being designed).
// Run from src/typescript: node scripts/buildMapAsset.ts, or scripts/remakeClockAssets.sh for everything that depends on clock.ts
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { encodeMapAsset } from "../src/live/mapAsset.ts";
import { builtHash, mapVersion } from "../src/sim/maps/index.ts";

for (const name of ["clock"]) {
  const raw = encodeMapAsset(name);
  const gz = gzipSync(raw, { level: 9 });
  const path = new URL(`../src/live/maps/${name}.bin`, import.meta.url);
  writeFileSync(path, gz);
  console.log(`${name}: ${raw.length} bytes, ${gz.length} gzipped -> ${path.pathname}`);
}

const pins = new URL("../../../tests/typescript/clockPins.json", import.meta.url);
writeFileSync(pins, JSON.stringify({ builtHash: builtHash("clock"), mapVersion: mapVersion("clock") }, null, 1) + "\n");
console.log(`pins -> ${pins.pathname}`);
