import { boxBlur, distance, fillLoops } from "../../src/typescript/src/ui/edt.ts";

describe("edt", () => {
  it("fills the pixels whose centres lie inside a loop", () => {
    const inside = fillLoops([[1, 1, 4, 1, 4, 4, 1, 4]], 0, 0, 1, 6, 6); // a 3 x 3 square, pixel centres at i + 0.5
    const rows = Array.from({ length: 6 }, (_, y) => Array.from(inside.subarray(6 * y, 6 * y + 6)).join(""));
    expect(rows).toEqual(["000000", "011100", "011100", "011100", "000000", "000000"]);
  });

  it("gives each inside pixel its euclidean distance to the nearest outside one", () => {
    const w = 7;
    const inside = new Uint8Array(w * w);
    for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) inside[y * w + x] = 1;
    const d = distance(inside, w, w);
    expect(d[0]).toBe(0);
    expect(d[1 * w + 1]).toBe(1);
    expect(d[3 * w + 3]).toBe(3);
    expect(d[2 * w + 3]).toBe(2);
  });

  it("blurs without changing a constant and keeps a spike's sum away from the edges", () => {
    const flat = new Float32Array(25).fill(2);
    boxBlur(flat, 5, 5, 1);
    for (const v of flat) expect(v).toBeCloseTo(2, 5);
    const spike = new Float32Array(41 * 41);
    spike[20 * 41 + 20] = 1;
    boxBlur(spike, 41, 41, 2);
    expect(spike.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 4);
    expect(spike[20 * 41 + 20]!).toBeLessThan(0.1);
  });
});
