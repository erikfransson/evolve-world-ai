import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { ThinkPool, canShare, defaultHelpers, serveHelper } from "../../src/typescript/src/worker/ecoPool.ts";
import type { HelperIn, HelperOut, HelperPort } from "../../src/typescript/src/worker/ecoPool.ts";
import { EcoRunner } from "../../src/typescript/src/worker/ecoRunner.ts";
import { createNodeThinkPool, nodeHelperPorts } from "../../src/typescript/src/worker/nodePool.ts";

// A small crowded world with varied plans and structural mutations, so creatures are born and die within a few hundred ticks.
function cfg(seed = 5): EcoConfig {
  const d = structuredClone(DEFAULT_ECO_CONFIG);
  return {
    ...d,
    seed,
    world: { ...d.world, width: 900, height: 900 },
    creature: { ...d.creature, startEnergy: 60 },
    eco: { ...d.eco, initialPopulation: 60, foundersVary: true, structuralRate: 0.3, birthEnergy: 40 },
  };
}

// In-process helpers over cloned messages; failAt: the tick message on which the helper reports an error instead, or never answers with hang.
function fakePorts(n: number, failAt = Infinity, hang = false): HelperPort[] {
  return Array.from({ length: n }, () => {
    let reply: (msg: HelperOut) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    let ticks = 0;
    const handle = serveHelper((msg, transfer) => queueMicrotask(() => reply(structuredClone(msg, { transfer: transfer as ArrayBuffer[] }))));
    return {
      post: (msg: HelperIn, transfer?: Transferable[]) => {
        if (msg.type === "tick" && ++ticks >= failAt) return hang ? undefined : queueMicrotask(() => fail(new Error("helper lost")));
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

async function pooled(pool: ThinkPool, config: EcoConfig, ticks: number): Promise<Ecosystem> {
  const eco = new Ecosystem(config, null, { journal: true });
  await pool.start(eco);
  for (let t = 0; t < ticks; t++) await pool.step(eco);
  return eco;
}

// A runner on pool at full speed; onTick runs after each pump.
async function runFor(pool: ThinkPool, ticks: number, onTick: (tick: number) => void = () => {}): Promise<Ecosystem> {
  const clock = { t: 0 };
  const runner = new EcoRunner(() => {}, () => (clock.t += 1));
  runner.useHelpers(pool);
  runner.handle({ type: "start", config: cfg(), run: 1 });
  runner.handle({ type: "speed", speed: "max" });
  const eco = () => (runner as unknown as { eco: Ecosystem }).eco;
  while (eco().tick < ticks) {
    await runner.pumpAsync();
    onTick(eco().tick);
  }
  return eco();
}

describe("ThinkPool", () => {
  it("matches the single-threaded run for 1 and 3 helpers, with births and deaths between ticks, on the JS path", async () => {
    const js = (): EcoConfig => ({ ...cfg(), eco: { ...cfg().eco, wasm: false } });
    const ref = serial(js(), 400);
    expect(ref.births).toBeGreaterThan(0);
    expect(ref.deaths).toBeGreaterThan(0);
    for (const n of [1, 3]) {
      const eco = await pooled(new ThinkPool(fakePorts(n), false), js(), 400);
      expect([eco.fingerprint(), eco.births, eco.deaths]).toEqual([ref.fingerprint(), ref.births, ref.deaths]);
    }
  });

  it("matches with collision damage on, which kills and pays out between ticks", async () => {
    const damaged = (): EcoConfig => {
      const c = cfg();
      c.eco.collisionDamage = true;
      c.eco.damagePerSpeed = 0.5;
      return c;
    };
    const ref = serial(damaged(), 400);
    expect(ref.deaths).toBeGreaterThan(serial(cfg(), 400).deaths);
    for (const n of [1, 3]) {
      const eco = await pooled(new ThinkPool(fakePorts(n), false), damaged(), 400);
      expect([eco.fingerprint(), eco.births, eco.deaths]).toEqual([ref.fingerprint(), ref.births, ref.deaths]);
    }
  });

  it("matches with seasons on, with a short year so winter is passed", async () => {
    const seasonal = (): EcoConfig => {
      const c = cfg();
      c.eco.seasons = true;
      c.eco.yearMinutes = 0.2;
      return c;
    };
    const ref = serial(seasonal(), 400);
    expect(ref.fingerprint()).not.toBe(serial(cfg(), 400).fingerprint());
    for (const n of [1, 3]) expect((await pooled(new ThinkPool(fakePorts(n), false), seasonal(), 400)).fingerprint()).toBe(ref.fingerprint());
  });

  it("reuses its helpers for a second run", async () => {
    const pool = new ThinkPool(fakePorts(2), false);
    await pooled(pool, cfg(1), 50);
    const eco = await pooled(pool, cfg(2), 100);
    expect(eco.fingerprint()).toBe(serial(cfg(2), 100).fingerprint());
  });

  it("reuses shared-memory helpers for a second run", async () => {
    const pool = createNodeThinkPool(2, true);
    try {
      await pooled(pool, cfg(1), 50);
      expect((await pooled(pool, cfg(2), 100)).fingerprint()).toBe(serial(cfg(2), 100).fingerprint());
    } finally {
      pool.close();
    }
  });

  it("a second start before the first one is ready keeps the helpers in step", async () => {
    const pools = [new ThinkPool(fakePorts(2), false), createNodeThinkPool(2, false), createNodeThinkPool(2, true)];
    for (const pool of pools) {
      try {
        const clock = { t: 0 };
        const runner = new EcoRunner(() => {}, () => (clock.t += 1));
        runner.useHelpers(pool);
        runner.handle({ type: "start", config: cfg(1), run: 1 });
        runner.handle({ type: "start", config: cfg(2), run: 2 });
        runner.handle({ type: "speed", speed: "max" });
        const eco = () => (runner as unknown as { eco: Ecosystem }).eco;
        while (eco().tick < 150) await runner.pumpAsync();
        expect(pool.alive).toBe(true);
        expect(eco().fingerprint()).toBe(serial(cfg(2), eco().tick).fingerprint());
      } finally {
        pool.close();
      }
    }
  });

  it("matches on worker threads, by messages and in shared memory", async () => {
    const ref = serial(cfg(), 150).fingerprint();
    for (const shared of [false, true]) {
      const pool = createNodeThinkPool(2, shared);
      expect(pool.shared).toBe(shared);
      try {
        expect((await pooled(pool, cfg(), 150)).fingerprint()).toBe(ref);
      } finally {
        pool.close();
      }
    }
  });
});

describe("WebAssembly kernels", () => {
  const wasmCfg = (seed = 5, wasm = true): EcoConfig => {
    const c = cfg(seed);
    return { ...c, eco: { ...c.eco, wasm } };
  };

  it("are deterministic for a seed and close to the JS path at first", () => {
    const a = serial(wasmCfg(), 300);
    expect(a.wasm).toBe(true);
    expect(a.births).toBeGreaterThan(0);
    expect(a.deaths).toBeGreaterThan(0);
    expect(serial(wasmCfg(), 300).fingerprint()).toBe(a.fingerprint());
    const js = serial(wasmCfg(5, false), 300);
    expect(js.wasm).toBe(false);
    expect(serial(cfg(), 300).fingerprint()).toBe(a.fingerprint()); // WASM is the default
    expect(js.fingerprint()).not.toBe(a.fingerprint());
    // f32 changes trajectories, but one tick from the same start barely moves anyone.
    const [w1, j1] = [serial(wasmCfg(), 1), serial(wasmCfg(5, false), 1)];
    let maxMove = 0;
    for (let i = 0; i < w1.population; i++) {
      const [p, q] = [w1.members[i]!.creature.state, j1.members[i]!.creature.state];
      maxMove = Math.max(maxMove, Math.hypot(p.x - q.x, p.y - q.y));
    }
    expect(maxMove).toBeLessThan(1e-3);
  });

  it("keep each creature's brain across births, deaths, recycling and plan mutations", () => {
    const c = wasmCfg();
    const eco = new Ecosystem({ ...c, world: { ...c.world, foodDensity: 2 }, eco: { ...c.eco, foodRegrow: 1, foodMaxDensity: 2, birthEnergy: 30, birthCost: 20, childEnergy: 15, birthCooldown: 2 } }); // fast turnover
    const out = new Float32Array(64);
    let checked = 0;
    const recycledShapes = new Set<number>(); // genome lengths of creatures that took over a dead one
    for (let t = 0; t < 600; t++) {
      eco.prepareTick();
      eco.sensePhase(0, eco.population);
      if (t % 5 === 4) {
        for (const m of eco.members) {
          const c = m.creature;
          if (c.brainVersion > 0) recycledShapes.add(c.brain.genome.length);
          c.brain.forward(c.brain.layerActivations()[0]!, out.subarray(0, c.outputs.length));
          for (let i = 0; i < c.outputs.length; i++) expect(Math.abs(c.outputs[i]! - out[i]!)).toBeLessThan(1e-4);
          checked++;
        }
      }
      eco.finishTick();
    }
    expect(eco.deaths).toBeGreaterThan(60);
    expect(recycledShapes.size).toBeGreaterThan(5);
    expect(checked).toBeGreaterThan(2000);
  });

  it("give the same run for any helper count and mode", async () => {
    const ticks = 300;
    const ref = serial(wasmCfg(), ticks);
    for (const n of [1, 3]) {
      const eco = await pooled(new ThinkPool(fakePorts(n), false), wasmCfg(), ticks);
      expect([eco.fingerprint(), eco.births, eco.deaths]).toEqual([ref.fingerprint(), ref.births, ref.deaths]);
    }
    for (const shared of [false, true]) {
      const pool = createNodeThinkPool(2, shared);
      try {
        expect((await pooled(pool, wasmCfg(), ticks)).fingerprint()).toBe(ref.fingerprint());
      } finally {
        pool.close();
      }
    }
  });
});

describe("helper fallbacks", () => {
  it("uses shared memory only when isolated and SharedArrayBuffer exists", () => {
    expect(canShare({ crossOriginIsolated: true })).toBe(true);
    expect(canShare({ crossOriginIsolated: false })).toBe(false);
    expect(canShare({})).toBe(false);
    vi.stubGlobal("SharedArrayBuffer", undefined);
    try {
      expect(canShare({ crossOriginIsolated: true })).toBe(false);
      expect(createNodeThinkPool(1, true).shared).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(defaultHelpers(8)).toBe(4);
    expect(defaultHelpers(4)).toBe(3);
    expect(defaultHelpers(1)).toBe(1);
  });

  it("a runner whose helpers fail mid-run continues on one thread with the same result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pool = new ThinkPool(fakePorts(2, 30), false);
    const eco = await runFor(pool, 200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(pool.alive).toBe(false);
    expect(eco.journal).toBeNull();
    expect(eco.fingerprint()).toBe(serial(cfg(), eco.tick).fingerprint());
  });

  it("a helper that never answers a tick fails the pool after the timeout", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pool = new ThinkPool(fakePorts(2, 30, true), false, 50);
    const eco = await runFor(pool, 100);
    warn.mockRestore();
    expect(pool.alive).toBe(false);
    expect(eco.fingerprint()).toBe(serial(cfg(), eco.tick).fingerprint());
  });

  it("a shared-memory helper that exits mid-run fails the pool at once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ports = nodeHelperPorts(2);
    const pool = new ThinkPool(ports, true);
    let killedAt = 0;
    const eco = await runFor(pool, 200, (tick) => {
      if (tick >= 30 && !killedAt) {
        killedAt = Date.now();
        ports[0]!.terminate();
      }
    });
    warn.mockRestore();
    expect(pool.alive).toBe(false);
    expect(Date.now() - killedAt).toBeLessThan(2000); // well under the 5 s tick timeout
    expect(eco.fingerprint()).toBe(serial(cfg(), eco.tick).fingerprint());
  });
});
