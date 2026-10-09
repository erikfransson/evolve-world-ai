import { packGenomes, unpackGenome } from "../../src/typescript/src/sim/protocol.ts";

describe("protocol", () => {
  it("round-trips genomes through pack and unpack", () => {
    const genomes = [new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6]), new Float32Array([7, 8, 9])];
    const flat = packGenomes(genomes);
    expect(flat.length).toBe(9);
    genomes.forEach((g, i) => expect(Array.from(unpackGenome(flat, 3, i))).toEqual(Array.from(g)));
  });

  it("packs an empty population", () => {
    expect(packGenomes([]).length).toBe(0);
  });
});
