import { worldToCanvas } from "../../src/typescript/src/ui/render.ts";

describe("worldToCanvas", () => {
  it("centres a square world horizontally in a wide canvas", () => {
    const t = worldToCanvas(1000, 1000, 1600, 800);
    expect(t.offsetX).toBeCloseTo((1600 - 1000 * t.scale) / 2);
    expect(t.offsetX).toBeGreaterThan(t.offsetY);
  });

  it("centres vertically in a tall canvas", () => {
    const t = worldToCanvas(1000, 1000, 800, 1600);
    expect(t.offsetY).toBeCloseTo((1600 - 1000 * t.scale) / 2);
    expect(t.offsetY).toBeGreaterThan(t.offsetX);
  });

  it("fits the world inside the canvas", () => {
    for (const [cw, ch] of [[1600, 800], [800, 1600], [500, 500]] as const) {
      const t = worldToCanvas(1000, 600, cw, ch);
      expect(t.offsetX).toBeGreaterThanOrEqual(0);
      expect(t.offsetY).toBeGreaterThanOrEqual(0);
      expect(t.offsetX + 1000 * t.scale).toBeLessThanOrEqual(cw);
      expect(t.offsetY + 600 * t.scale).toBeLessThanOrEqual(ch);
    }
  });
});
