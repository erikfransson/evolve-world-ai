// @vitest-environment node
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { decodeMapAsset, encodeMapAsset, mapLoader, terrainFromAsset } from "../../src/typescript/src/live/mapAsset.ts";
import { MAP_FILES } from "../../src/typescript/src/live/mapFiles.ts";
import { builtHash, builtMap, mapSpec } from "../../src/typescript/src/sim/maps/index.ts";
import { packMap } from "../../src/typescript/src/sim/maps/mapParts.ts";
import { tintPixels } from "../../src/typescript/src/ui/mapTint.ts";
import { floorPixels } from "../../src/typescript/src/ui/noiseTex.ts";
import { rockBodies } from "../../src/typescript/src/ui/rockOutline.ts";

const NAME = "inland-sea";
const spec = mapSpec(NAME)!;
const shipped = (): Uint8Array => new Uint8Array(gunzipSync(readFileSync(new URL("../../src/typescript/src/live/maps/inland-sea.bin", import.meta.url))));

describe("the prebuilt Live map file", () => {
  it("equals a fresh build of the map and its drawing (else run node scripts/buildMapAsset.ts in src/typescript)", () => {
    const fresh = encodeMapAsset(NAME);
    expect(Buffer.from(shipped()).equals(Buffer.from(fresh))).toBe(true);
    expect(Object.keys(MAP_FILES)).toEqual([NAME]);
  }, 60_000);

  it("puts together the same map the builder makes, with the floor and wash the page would compute", () => {
    const a = decodeMapAsset(shipped(), NAME, spec.width, spec.height)!;
    const t = terrainFromAsset(NAME, spec.width, spec.height, a)!;
    const parts = packMap(t)!;
    const b = builtMap(NAME);
    expect(t.rockCount).toBe(b.rock.length);
    expect(Buffer.from(parts.ground).equals(Buffer.from(b.ground.data))).toBe(true);
    expect(Buffer.from(parts.food).equals(Buffer.from(b.weights.food))).toBe(true);
    expect(Buffer.from(parts.poison).equals(Buffer.from(b.weights.poison))).toBe(true);
    expect(Array.from(parts.rock.subarray(0, 6))).toEqual([b.rock[0]!.x, b.rock[0]!.y, b.rock[0]!.r, b.rock[1]!.x, b.rock[1]!.y, b.rock[1]!.r]);
    expect(builtHash(NAME)).toBeTypeOf("string");
    expect(rockBodies(t)).toHaveLength(a.parts.ok ? a.parts.outlines.bodyLoops.length : -1);
    expect(Buffer.from(a.floor).equals(Buffer.from(floorPixels(spec.width, spec.height)))).toBe(true);
    expect(Buffer.from(a.tint).equals(Buffer.from(tintPixels(t)))).toBe(true);
  }, 60_000);

  it("refuses a file of another map, version or size, or one that is cut short or corrupt", () => {
    const bytes = shipped();
    expect(decodeMapAsset(bytes, "nowhere", spec.width, spec.height)).toBeNull();
    expect(decodeMapAsset(bytes, NAME, 17000, spec.height)).toBeNull();
    expect(decodeMapAsset(bytes.subarray(0, bytes.length - 100), NAME, spec.width, spec.height)).toBeNull();
    expect(decodeMapAsset(bytes.subarray(0, 5), NAME, spec.width, spec.height)).toBeNull();
    const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(6, true);
    const head = new TextDecoder().decode(bytes.subarray(10, 10 + n));
    const swap = (from: string, to: string): Uint8Array => {
      const h = new TextEncoder().encode(head.replace(from, to));
      expect(h.length).toBe(n); // same length, so the sections stay where they are
      const c = bytes.slice();
      c.set(h, 10);
      return c;
    };
    const version = (JSON.parse(head) as { version: string }).version;
    expect(decodeMapAsset(swap(version, version.replace(/^./, (c) => (c === "0" ? "1" : "0"))), NAME, spec.width, spec.height)).toBeNull();
    const bad = bytes.slice();
    bad[0] = 0;
    expect(decodeMapAsset(bad, NAME, spec.width, spec.height)).toBeNull();
    // Arrays that decode but do not fit the map: refused by the page's checks.
    const a = decodeMapAsset(bytes, NAME, spec.width, spec.height)!;
    expect(terrainFromAsset(NAME, spec.width, spec.height, { ...a, floor: a.floor.subarray(4) })).toBeNull();
    expect(terrainFromAsset(NAME, spec.width, spec.height, { ...a, tint: a.tint.subarray(4) })).toBeNull();
    if (!a.parts.ok) throw new Error("decoded parts");
    expect(terrainFromAsset(NAME, spec.width, spec.height, { ...a, parts: { ...a.parts, ground: a.parts.ground.subarray(1) } })).toBeNull();
  }, 60_000);

  it("the page falls back to the worker build when the file cannot be fetched", async () => {
    const fetchWas = globalThis.fetch;
    globalThis.fetch = (async () => new Response("no", { status: 404 })) as typeof fetch;
    try {
      // no Worker in node: the fallback resolves to null instead of a map
      expect(await mapLoader(MAP_FILES)(NAME, spec.width, spec.height)).toBeNull();
      expect(await mapLoader({})(NAME, spec.width, spec.height)).toBeNull();
    } finally {
      globalThis.fetch = fetchWas;
    }
  });
});
