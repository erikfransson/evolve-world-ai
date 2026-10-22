import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { wasmAvailable } from "../../src/typescript/src/sim/wasm/loader.ts";

// Worlds of at most 32 members run the settle and birth scans in JS, larger ones in the WebAssembly kernel (ecosystem.ts SMALL_SCAN).
// Both paths must give the same world on either side of the switch, with births taking the world past the switch and deaths bringing it back.

type Any = any; // the test switches the Ecosystem's private kernel off

const run = (founders: number, kernel: boolean): [number, number, number, number] => {
  const config = structuredClone(DEFAULT_ECO_CONFIG);
  config.seed = 3;
  config.eco = { ...config.eco, initialPopulation: founders, aging: true, agingStart: 6, agingRate: 4, birthEnergyRange: [40, 60], birthCostRange: [20, 25], birthCooldownRange: [1, 2] };
  const eco = new Ecosystem(config, null);
  if (!kernel) (eco as Any).wasmMembers = null;
  for (let t = 0; t < 3000 && !eco.extinct; t++) eco.step();
  return [eco.fingerprint(), eco.population, eco.deaths, eco.births];
};

describe.skipIf(!wasmAvailable())("settle and birth scans in JS and in the kernel", () => {
  for (const founders of [32, 33]) {
    it(`give the same world from ${founders} founders`, () => {
      const withKernel = run(founders, true);
      expect(withKernel[3]).toBeGreaterThan(0); // births, so the world crosses the switch (32 founders grow past 32)
      expect(run(founders, false)).toEqual(withKernel);
    });
  }
});
