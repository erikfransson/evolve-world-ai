import { DEFAULT_CONFIG } from "../../src/typescript/src/sim/config.ts";

test("config loads", () => {
  expect(DEFAULT_CONFIG.population.size).toBeGreaterThan(0);
});
