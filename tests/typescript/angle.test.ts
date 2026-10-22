import { wrapAngle } from "../../src/typescript/src/sim/angle.ts";

describe("wrapAngle", () => {
  it("wraps into [-pi, pi)", () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(wrapAngle(-0.5 - 20 * Math.PI)).toBeCloseTo(-0.5, 9);
    expect(wrapAngle(0.25)).toBe(0.25);
  });
});
