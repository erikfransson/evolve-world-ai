import { Population } from "../../src/typescript/src/sim/population.ts";

describe("Population", () => {
  it("genome returns writable views into the flat data", () => {
    const pop = new Population(3, 2);
    pop.genome(1).set([5, 6]);
    expect(Array.from(pop.data)).toEqual([0, 0, 5, 6, 0, 0]);
    expect(pop.genome(1).buffer).toBe(pop.data.buffer);
  });

  it("wraps an existing buffer without copying", () => {
    const data = Float32Array.from([1, 2, 3, 4]);
    const pop = new Population(2, 2, data);
    expect(pop.data).toBe(data);
    expect(Array.from(pop.genome(1))).toEqual([3, 4]);
  });

  it("rejects a buffer of the wrong length", () => {
    expect(() => new Population(2, 2, new Float32Array(3))).toThrow(/does not match/);
  });
});
