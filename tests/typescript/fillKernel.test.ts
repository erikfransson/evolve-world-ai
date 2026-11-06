import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { F, I, ResidentStore } from "../../src/typescript/src/sim/wasm/resident.ts";
import { WasmBrainBank } from "../../src/typescript/src/sim/wasm/brainKernel.ts";
import { WasmFiller } from "../../src/typescript/src/sim/wasm/fillKernel.ts";
import { prepareRows } from "../../src/typescript/src/sim/wasm/residentStep.ts";
import { setWasmDisabled, wasmAvailable } from "../../src/typescript/src/sim/wasm/loader.ts";
import { World } from "../../src/typescript/src/sim/world.ts";
import { EXTRA_TERRAIN } from "../../src/typescript/src/sim/sensors.ts";

// WasmFiller.prepare against its JS twin prepareRows, on rows set up by hand (the fill call itself is checked through the sense kernels in wasmSense.test.ts).

afterEach(() => setWasmDisabled(false));

describe.skipIf(!wasmAvailable())("WasmFiller", () => {
  const config = structuredClone(DEFAULT_ECO_CONFIG);
  config.world = { ...config.world, width: 1500, height: 1500, stoneDensity: 0.05, ridgeDensity: 0.02 };
  const world = new World(config, 10);

  function rows(n: number) {
    const store = new ResidentStore(WasmBrainBank.createSync()!);
    store.species.push(config);
    const states = Array.from({ length: n }, (_, k) => {
      const s = store.add();
      s.species = 0;
      s.x = 100 + 130 * k;
      s.y = 50 + 90 * k;
      s.heading = 0.3 * k;
      s.cos = Math.cos(s.heading);
      s.sin = Math.sin(s.heading);
      s.vx = 20 - 7 * k;
      s.vy = -5 + 3 * k;
      s.turnRate = 0.2 * k - 0.5;
      s.energy = 10 + 37 * k;
      return s;
    });
    return { store, states, ptrs: Int32Array.from(states, (s) => s.ptr) };
  }
  const extras = (store: ResidentStore, ptr: number): number[] => {
    const o = ptr >> 3;
    return [1, 2, 3, EXTRA_TERRAIN].map((i) => store.f64[o + F.extras + i]!).concat(store.f64[o + F.groundFactor]!);
  };

  it("writes the same body extras and ground factors as prepareRows, on open ground and over a map with rock and mud", () => {
    expect(world.terrain.empty).toBe(false);
    const a = rows(6);
    const b = rows(6);
    for (const terrain of [world.terrain, new World({ ...config, world: { ...config.world, stoneDensity: 0, ridgeDensity: 0 } }, 10).terrain]) {
      prepareRows(a.store, a.ptrs, 6, terrain);
      const filler = WasmFiller.create(b.store)!;
      expect(filler).not.toBeNull();
      filler.prepare(b.ptrs, 6, terrain);
      for (let k = 0; k < 6; k++) expect(extras(b.store, b.ptrs[k]!), `row ${k}`).toEqual(extras(a.store, a.ptrs[k]!));
    }
    // the rows were really written: the speeds and turn are not zero
    expect(extras(b.store, b.ptrs[0]!).some((v) => v !== 0)).toBe(true);
  });

  it("prepares an empty batch without touching rows", () => {
    const { store, ptrs } = rows(1);
    const filler = WasmFiller.create(store)!;
    filler.prepare(ptrs, 0, world.terrain);
    expect(store.i32[(ptrs[0]! >> 2) + I.species]).toBe(0);
    expect(extras(store, ptrs[0]!)).toEqual([0, 0, 0, 0, 0]); // untouched
  });

  it("returns null instead of throwing when the module does not link to the store's memory", () => {
    const store = { bank: { memory: {} } } as unknown as ResidentStore;
    expect(WasmFiller.create(store)).toBeNull();
  });
});
