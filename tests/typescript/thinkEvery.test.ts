import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import { ThinkPool, serveHelper } from "../../src/typescript/src/worker/ecoPool.ts";
import type { HelperIn, HelperOut, HelperPort } from "../../src/typescript/src/worker/ecoPool.ts";

// eco.thinkEvery: a creature senses and thinks every k-th tick, staggered by id, and keeps its outputs in between.

// The small crowded world of ecoPool.test.ts, with births and deaths within a few hundred ticks.
function cfg(thinkEvery: number, wasm = true): EcoConfig {
  const d = structuredClone(DEFAULT_ECO_CONFIG);
  return {
    ...d,
    seed: 5,
    world: { ...d.world, width: 900, height: 900 },
    creature: { ...d.creature, startEnergy: 60 },
    eco: { ...d.eco, wasm, thinkEvery, initialPopulation: 60, foundersVary: true, structuralRate: 0.3, birthEnergyRange: [76, 76], birthCostRange: [75, 75], birthCooldownRange: [10, 10] },
  };
}

// In-process helpers over cloned messages; failAt: the tick message on which a helper reports an error.
function ports(n: number, failAt = Infinity): HelperPort[] {
  return Array.from({ length: n }, () => {
    let reply: (msg: HelperOut) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    let ticks = 0;
    const handle = serveHelper((msg, transfer) => queueMicrotask(() => reply(structuredClone(msg, { transfer: transfer as ArrayBuffer[] }))));
    return {
      post: (msg: HelperIn, transfer?: Transferable[]) => {
        if (msg.type === "tick" && ++ticks >= failAt) return queueMicrotask(() => fail(new Error("helper lost")));
        const copy = structuredClone(msg, { transfer: (transfer ?? []) as ArrayBuffer[] });
        queueMicrotask(() => handle(copy));
      },
      onMessage: (callback) => { reply = callback; },
      onError: (callback) => { fail = callback; },
      terminate: () => {},
    };
  });
}

function serial(config: EcoConfig, ticks: number): Ecosystem {
  const eco = new Ecosystem(config);
  for (let t = 0; t < ticks; t++) eco.step();
  return eco;
}

// Steps eco on pool, and on this thread once the pool has failed (as LiveWorld and EcoRunner do).
async function steps(eco: Ecosystem, pool: ThinkPool | null, ticks: number): Promise<void> {
  for (let t = 0; t < ticks; t++) {
    if (pool?.alive) {
      try {
        await pool.step(eco);
        continue;
      } catch {
        eco.dropJournal();
      }
    }
    eco.step();
  }
}

const json = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("thinkEvery", () => {
  for (const wasm of [false, true]) {
    it(`2 thinks for the creatures of one id parity per tick, and newborns, and holds the others' outputs (wasm ${wasm})`, () => {
      const eco = new Ecosystem(cfg(2, wasm));
      let thinkers = 0;
      let changed = 0;
      let parities = 0;
      for (let t = 0; t < 200; t++) {
        const before = new Map(eco.members.map((m) => [m.id, { out: m.creature.outputs.slice(), age: m.ageTicks }]));
        const tick = eco.tick;
        eco.step();
        for (const m of eco.members) {
          const b = before.get(m.id);
          if (!b) continue; // born this tick
          const thinks = b.age === 0 || (tick + m.id) % 2 === 0;
          const same = b.out.every((v, i) => v === m.creature.outputs[i]);
          if (thinks) {
            thinkers++;
            if (!same) changed++;
          } else expect(same).toBe(true);
          if (b.age > 0) parities += (tick + m.id) % 2;
        }
      }
      expect(eco.births).toBeGreaterThan(0);
      expect(changed / thinkers).toBeGreaterThan(0.9);
      expect(thinkers / (200 * 60)).toBeGreaterThan(0.3); // about half each tick
      expect(parities).toBeGreaterThan(1000);
    });
  }

  it("the brain run order survives its stamp wrapping, with the same results", () => {
    const eco = new Ecosystem(cfg(1));
    const bank = (eco as unknown as { kernels: { brains: { stamp: number } } }).kernels.brains;
    bank.stamp = 0x7fffffff - 2; // two ticks from the i32 limit of the per-slot marks
    for (let t = 0; t < 300; t++) eco.step();
    expect(bank.stamp).toBeLessThan(300);
    expect(eco.fingerprint()).toBe(81047108);
  });

  it("1 thinks for everyone every tick and gives the pinned WebAssembly run of ecoPool.test.ts", () => {
    const eco = new Ecosystem(cfg(1));
    let same = 0;
    let all = 0;
    for (let t = 0; t < 300; t++) {
      const before = new Map(eco.members.map((m) => [m.id, m.creature.outputs.slice()]));
      eco.step();
      for (const m of eco.members) {
        const b = before.get(m.id);
        if (!b) continue;
        all++;
        if (b.every((v, i) => v === m.creature.outputs[i])) same++;
      }
    }
    expect(same / all).toBeLessThan(0.05);
    expect(eco.fingerprint()).toBe(81047108);
  });

  it("2 changes the run", () => {
    expect(serial(cfg(2), 300).fingerprint()).not.toBe(serial(cfg(1), 300).fingerprint());
  });

  for (const wasm of [false, true]) {
    it(`2 gives the serial run with 3 helper threads, after a restore, and after the helpers fail (wasm ${wasm})`, async () => {
      const ref = serial(cfg(2, wasm), 300);

      const a = new Ecosystem(cfg(2, wasm), null, { journal: true });
      const p1 = new ThinkPool(ports(3));
      await p1.start(a);
      await steps(a, p1, 300);
      p1.close();
      expect(a.fingerprint()).toBe(ref.fingerprint());

      // Saved mid-run with helpers, restored onto fresh helpers that hold none of the outputs yet.
      const b = new Ecosystem(cfg(2, wasm), null, { journal: true });
      const p2 = new ThinkPool(ports(3));
      await p2.start(b);
      await steps(b, p2, 151);
      const saved = json(saveState(b));
      p2.close();
      expect(saved.creatures.outputs).toBeDefined();
      const c = restoreState(saved, null, { journal: true });
      const p3 = new ThinkPool(ports(2));
      await p3.start(c);
      await steps(c, p3, 149);
      p3.close();
      expect(c.fingerprint()).toBe(ref.fingerprint());
      expect(json(saveState(c))).toEqual(json(saveState(ref)));

      // Helpers that fail mid-run: the coordinator holds every creature's outputs and goes on alone.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const d = new Ecosystem(cfg(2, wasm), null, { journal: true });
      const p4 = new ThinkPool(ports(2, 75));
      await p4.start(d);
      await steps(d, p4, 300);
      warn.mockRestore();
      expect(p4.alive).toBe(false);
      expect(d.fingerprint()).toBe(ref.fingerprint());
    });
  }

  it("1 saves no outputs, and a restore rejects outputs out of range", () => {
    expect(saveState(serial(cfg(1), 20)).creatures.outputs).toBeUndefined();
    const state = json(saveState(serial(cfg(2), 20)));
    const raw = Uint8Array.from(atob(state.creatures.outputs!), (ch) => ch.charCodeAt(0));
    new Float32Array(raw.buffer)[0] = 5;
    state.creatures.outputs = btoa(String.fromCharCode(...raw));
    expect(() => restoreState(state)).toThrow(/output/);
    expect(() => restoreState({ ...state, config: { ...state.config, eco: { ...state.config.eco, thinkEvery: 0 } } })).toThrow(/thinkEvery/);
  });
});
