import "../../src/typescript/src/sim/maps/index.ts";
import { builtMap } from "../../src/typescript/src/sim/maps/index.ts";

// The map worker transfers its arrays; its cached Terrain must keep its own, so a second request for the same map works.

describe("the map worker", () => {
  it("answers a second request for the same map and leaves the built map attached", async () => {
    const replies: Array<{ m: { ok: boolean; message?: string; ground?: Uint8Array }; transfer: Transferable[] }> = [];
    const scope = {
      onmessage: null as null | ((e: { data: unknown }) => void),
      postMessage: (m: never, transfer: Transferable[]) => {
        structuredClone(m, { transfer }); // detaches the transferred buffers, and throws on one already detached
        replies.push({ m, transfer });
      },
    };
    vi.stubGlobal("self", scope);
    await import("../../src/typescript/src/worker/mapWorker.ts");
    for (let i = 0; i < 2; i++) scope.onmessage!({ data: { name: "inland-sea" } });
    vi.unstubAllGlobals();
    expect(replies.map((r) => r.m.ok)).toEqual([true, true]);
    expect(builtMap("inland-sea").ground.data.byteLength).toBeGreaterThan(0);
  }, 120_000);
});
