// @vitest-environment node
import { readFileSync, statSync } from "node:fs";
import { groundImageHashes } from "../../src/typescript/scripts/mapImageHash.ts";
import { GROUND_FILES, LIVE_MAP, MAP_FILES } from "../../src/typescript/src/live/mapFiles.ts";
import { BACKDROP_SCALES } from "../../src/typescript/src/ui/groundBackdrop.ts";

const dir = new URL("../../src/typescript/src/live/maps/", import.meta.url);

describe("the shipped ground pictures of the Live map", () => {
  it("were drawn from the shipped map file and the current drawing code (else run node scripts/buildMapImage.ts in src/typescript)", () => {
    const made = JSON.parse(readFileSync(new URL("inland-sea-ground.json", dir), "utf8")) as { map: string; look: string };
    const now = groundImageHashes("inland-sea");
    expect(made.map, "the map changed since the pictures were drawn").toBe(now.map);
    expect(made.look, "the drawing code changed since the pictures were drawn").toBe(now.look);
  });

  it("are there for every scale, with a preview small enough to inline", () => {
    expect(Object.keys(GROUND_FILES)).toEqual(Object.keys(MAP_FILES));
    expect(GROUND_FILES[LIVE_MAP]).toBeDefined();
    for (const s of BACKDROP_SCALES) expect(statSync(new URL(`inland-sea-ground-${s}.webp`, dir)).size).toBeGreaterThan(1000);
    expect(statSync(new URL("inland-sea-ground-preview.webp", dir)).size).toBeLessThan(4096);
    expect(GROUND_FILES[LIVE_MAP]!.preview.startsWith("data:image/webp")).toBe(true);
  });
});
