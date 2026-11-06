import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { startItems } from "../../src/typescript/src/ui/ecoIdle.ts";

describe("startItems", () => {
  it("scatters again when a terrain setting changes", () => {
    const base = structuredClone(DEFAULT_ECO_CONFIG);
    const first = startItems(base);
    expect(startItems(structuredClone(base))).toBe(first);
    for (const key of ["stoneDensity", "ridgeDensity", "slowDensity", "fastDensity", "slowSize", "fastSize"] as const) {
      const c = structuredClone(base);
      c.world[key] = key.endsWith("Size") ? 2 : 0.1;
      expect(startItems(c), key).not.toBe(startItems(base));
    }
  });
});
