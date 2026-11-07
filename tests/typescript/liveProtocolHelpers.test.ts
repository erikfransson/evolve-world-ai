import { ITEMS_HEADER, MSG_CREATURES, MSG_ITEMS, encodeItems, frameType, itemsBytes, newCreatureFrame, q16, unq16 } from "../../src/typescript/src/live/protocol.ts";

// The small pure helpers of the wire protocol: quantizing, message type and sizes (the frames themselves are in liveProtocol.test.ts and liveV2.test.ts).

describe("q16 and unq16", () => {
  it("map the span to 0..65535, clamp outside it and round trip within half a step", () => {
    expect([q16(0, 100), q16(100, 100), q16(50, 100)]).toEqual([0, 65535, 32768]);
    expect([q16(-5, 100), q16(1e9, 100), q16(-Infinity, 100), q16(Infinity, 100)]).toEqual([0, 65535, 0, 65535]);
    for (const v of [0, 0.3, 17.77, 99.99, 100]) expect(Math.abs(unq16(q16(v, 100), 100) - v)).toBeLessThanOrEqual(100 / 65535 / 2 + 1e-9);
    expect(unq16(0, 100)).toBe(0);
    expect(unq16(65535, 100)).toBe(100);
  });
});

describe("frameType and sizes", () => {
  it("frameType reads the first byte of a Uint8Array and of an ArrayBuffer", () => {
    const items = encodeItems(1, { xs: [10], ys: [20], kinds: [1], slots: 1 }, { width: 100, height: 100 });
    expect(frameType(items)).toBe(MSG_ITEMS);
    expect(frameType(items.buffer as ArrayBuffer)).toBe(MSG_ITEMS);
    expect(frameType(newCreatureFrame(5, 0))).toBe(MSG_CREATURES);
  });

  it("itemsBytes is the header, two bits per slot rounded up to bytes, and four bytes per item, as encodeItems writes", () => {
    expect(itemsBytes(0, 0)).toBe(ITEMS_HEADER);
    expect(itemsBytes(5, 2)).toBe(ITEMS_HEADER + 2 + 8);
    expect(encodeItems(3, { xs: [1, 2, 3, 4, 5], ys: [1, 2, 3, 4, 5], kinds: [1, 0, 2, 0, 0], slots: 5 }, { width: 10, height: 10 }).length).toBe(itemsBytes(5, 2));
  });
});
