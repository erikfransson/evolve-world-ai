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
  it("matches the single-threaded run for 1 and 3 helpers, with births and deaths between ticks", async () => {
    const ref = serial(cfg(), 400);
    expect(ref.births).toBeGreaterThan(0);
    expect(ref.deaths).toBeGreaterThan(0);
    for (const n of [1, 3]) {
      const eco = await pooled(new ThinkPool(fakePorts(n), false), cfg(), 400);
      expect([eco.fingerprint(), eco.births, eco.deaths]).toEqual([ref.fingerprint(), ref.births, ref.deaths]);
    }
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
