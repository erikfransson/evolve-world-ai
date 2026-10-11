import { snapshotBytes, snapshotViews } from "../../src/typescript/src/worker/ecoProtocol.ts";
import type { RenderSnapshot } from "../../src/typescript/src/worker/renderProtocol.ts";

// The render worker module talks through `self`, so a stand-in is installed before it is imported.
const sent: any[] = [];
const given: any[] = [];
const port: any = { postMessage: (m: unknown) => given.push(m), onmessage: null };
const scope: any = { postMessage: (m: unknown) => sent.push(m) };

function snapshot(run: number): RenderSnapshot {
  const buffer = new ArrayBuffer(snapshotBytes(4, 4));
  const v = snapshotViews(buffer, 2, 0, 4, 4);
  v.ids.set([10, 11]);
  v.x.set([100, 300]);
  v.y.set([100, 300]);
  return { type: "snapshot", run, count: 2, itemCount: 0, creatureCap: 4, itemCap: 4, buffer, selected: null };
}

describe("render worker", () => {
  beforeAll(async () => {
    (globalThis as any).self = scope;
    await import("../../src/typescript/src/worker/renderWorker.ts");
    scope.onmessage({ data: { type: "init", canvas: { width: 100, height: 100, getContext: () => ({}) }, port } });
  });
  beforeEach(() => {
    sent.length = 0;
    given.length = 0;
  });

  it("says ready once loaded", () => {
    // the ready message was posted at import time, before beforeEach cleared the list
    expect(typeof scope.onmessage).toBe("function");
  });

  it("answers a pick with the creature of the current run, and with nothing for another run", () => {
    port.onmessage({ data: snapshot(2) });
    scope.onmessage({ data: { type: "pick", request: 1, run: 2, x: 301, y: 299, reach: 5 } });
    expect(sent[0]).toEqual({ type: "picked", request: 1, run: 2, id: 11, x: 300, y: 300 });
    scope.onmessage({ data: { type: "pick", request: 2, run: 1, x: 301, y: 299, reach: 5 } });
    expect(sent[1]).toMatchObject({ type: "picked", request: 2, run: 1, id: -1 });
  });

  it("hands a replaced snapshot's buffer back and drops one from an earlier run", () => {
    const next = snapshot(2);
    port.onmessage({ data: next });
    expect(given.length).toBe(1); // the previous snapshot's buffer
    const late = snapshot(1);
    port.onmessage({ data: late });
    expect(given.length).toBe(2); // returned at once, never shown
    expect(given[1].buffer).toBeInstanceOf(ArrayBuffer);
  });
});
