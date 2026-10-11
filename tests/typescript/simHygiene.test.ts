import { Brain, genomeLength } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { ShareHelper } from "../../src/typescript/src/sim/ecoShare.ts";
import { HIT_FOOD } from "../../src/typescript/src/sim/types.ts";
import { SenseKernels } from "../../src/typescript/src/sim/wasm/senseKernels.ts";
import { startItems } from "../../src/typescript/src/ui/ecoIdle.ts";
import { ThinkPool, serveHelper } from "../../src/typescript/src/worker/ecoPool.ts";
import type { HelperIn, HelperOut, HelperPort } from "../../src/typescript/src/worker/ecoPool.ts";
import { testRng } from "./helpers.ts";

// The crowded small world of the ecoPool tests, so creatures are born and die within a few hundred ticks.
function cfg(wasm: boolean): EcoConfig {
  const d = structuredClone(DEFAULT_ECO_CONFIG);
  return {
    ...d,
    seed: 5,
    world: { ...d.world, width: 900, height: 900 },
    creature: { ...d.creature, startEnergy: 60 },
    eco: { ...d.eco, wasm, initialPopulation: 60, foundersVary: true, structuralRate: 0.3, birthEnergyRange: [76, 76], birthCostRange: [75, 75], birthCooldownRange: [10, 10] },
  };
}

// In-process helpers over cloned messages.
function fakePorts(n: number): HelperPort[] {
  return Array.from({ length: n }, () => {
    let reply: (msg: HelperOut) => void = () => {};
    const handle = serveHelper((msg, transfer) => queueMicrotask(() => reply(structuredClone(msg, { transfer: transfer as ArrayBuffer[] }))));
    return {
      post: (msg: HelperIn, transfer?: Transferable[]) => {
        const copy = structuredClone(msg, { transfer: (transfer ?? []) as ArrayBuffer[] });
        queueMicrotask(() => handle(copy));
      },
      onMessage: (callback) => { reply = callback; },
      onError: () => {},
      terminate: () => {},
    };
  });
}

describe("watched creature with helpers", () => {
  // The watched id changes every tick and refreshDetail runs on some, as the page does while a creature is selected.
  it.each([
    [false, 866550263], // re-pinned for the terrain input (#34), were 84105801 and 116543125
    [true, 81047108],
  ])("keeps the run equal to the serial one (wasm %s)", async (wasm, fingerprint) => {
    const serial = new Ecosystem(cfg(wasm));
    for (let t = 0; t < 300; t++) serial.step();
    expect(serial.fingerprint()).toBe(fingerprint);

    const pool = new ThinkPool(fakePorts(2));
    try {
      const eco = new Ecosystem(cfg(wasm), null, { journal: true });
      await pool.start(eco);
      for (let t = 0; t < 300; t++) {
        const id = eco.members[(t * 7) % eco.population]?.id ?? null;
        pool.watch = eco.detail = id;
        if (t % 7 === 3) eco.refreshDetail();
        await pool.step(eco);
      }
      expect(eco.fingerprint()).toBe(fingerprint);
    } finally {
      pool.close();
    }
  }, 120_000);
});

describe("sim core hygiene", () => {
  it("a helper that gets no WebAssembly kernels although the coordinator did fails loudly", () => {
    const spy = vi.spyOn(SenseKernels, "create").mockReturnValue(null);
    try {
      expect(() => new ShareHelper(cfg(true), 100, 0, true)).toThrow(/kernels/);
      expect(() => new ShareHelper(cfg(false), 100, 0, false)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("a brain keeps its own copy of the genome it was given, also when it is loaded again", () => {
    const sizes = [4, 3, 2];
    const rng = testRng(1);
    const random = (s: number[]) => Float32Array.from({ length: genomeLength(s) }, () => rng.next());
    const genome = random(sizes);
    const before = genome.slice();
    const brain = new Brain(sizes, genome);
    brain.load(sizes, random(sizes));
    brain.load([4, 5, 2], random([4, 5, 2]));
    expect(genome).toEqual(before);
  });

  it("the idle preview scatters the items the run starts with", () => {
    const config = cfg(false);
    const preview = startItems(config)!;
    const eco = new Ecosystem(config);
    // Poison near founders is moved afterwards, food stays where the scatter put it.
    let food = 0;
    for (let i = 0; i < preview.count; i++) {
      if (preview.kinds[i] !== HIT_FOOD) continue;
      food++;
      expect([eco.world.kinds[i], eco.world.xs[i], eco.world.ys[i]]).toEqual([HIT_FOOD, preview.xs[i], preview.ys[i]]);
    }
    expect(food).toBeGreaterThan(0);
  });
});
