import { liveConfig } from "../../server/src/config.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";

// The live settings on a small world, so a test builds and saves one in milliseconds.
export function smallConfig(): EcoConfig {
  const c = structuredClone(liveConfig);
  c.world.width = 2000;
  c.world.height = 1300;
  c.eco.initialPopulation = 40;
  c.eco.wasm = false;
  c.seed = 3; // a seed whose founders survive 2000 ticks, which the records test needs (most seeds die out and restart)
  return c;
}
