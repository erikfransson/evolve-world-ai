import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import { ShareCoordinator, fittedCaps, packetBytes, packetViews, publishedBytes } from "../../src/typescript/src/sim/ecoShare.ts";
import { ThinkPool, defaultHelpers, serveHelper, tickTimeoutMs } from "../../src/typescript/src/worker/ecoPool.ts";
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
    eco: { ...d.eco, initialPopulation: 60, foundersVary: true, structuralRate: 0.3, birthEnergyRange: [76, 76], birthCostRange: [75, 75], birthCooldownRange: [10, 10] },
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
  const eco = () => runner.ecosystem!;
  while (eco().tick < ticks) {
    await runner.pumpAsync();
    onTick(eco().tick);
  }
  return eco();
}

describe("ThinkPool", () => {
  // One feature-rich world compared across every helper kind. Each feature must change the serial result, so a helper that skipped it would show.
  describe("parity with the serial run", () => {
    const rich = (wasm: boolean): EcoConfig => {
      const c = cfg();
      c.eco.wasm = wasm;
      c.eco.collisionDamage = true;
      c.eco.damagePerSpeed = 0.5;
      c.eco.aging = true; // helpers apply ticks alive and the ageing rule themselves
      c.eco.agingStart = 5;
      c.eco.agingRate = 3;
      c.eco.seasons = true;
      c.eco.yearMinutes = 0.2; // a short year so winter is passed
      Object.assign(c.world, { width: 1600, height: 1200, stoneDensity: 0.08, ridgeDensity: 0.05, slowDensity: 0.15, fastDensity: 0.15 }); // rock and ground: helpers rebuild the map from config and seed
      return c;
    };
    const without: Record<string, (c: EcoConfig) => void> = {
      damage: (c) => { c.eco.collisionDamage = false; },
      aging: (c) => { c.eco.aging = false; },
      seasons: (c) => { c.eco.seasons = false; },
      map: (c) => { Object.assign(c.world, { stoneDensity: 0, ridgeDensity: 0, slowDensity: 0, fastDensity: 0 }); },
    };
    // A predators world, a small and dense one so hunters catch prey within a few hundred ticks.
    const predators = (wasm: boolean): EcoConfig => {
      const d = structuredClone(DEFAULT_PREDATOR_CONFIG);
      d.species![0]!.founders = 70;
      d.species![1]!.founders = 25;
      return { ...d, seed: 7, world: { ...d.world, width: 900, height: 700 }, eco: { ...d.eco, wasm, structuralRate: 0.3 } };
    };
    const stats = (e: Ecosystem) => [e.fingerprint(), e.births, e.deaths, e.speciesCounts.map((s) => s.eaten)];

    async function compareAll(make: () => EcoConfig, ticks: number, ref: Ecosystem) {
      const failures: string[] = [];
      const check = async (label: string, pool: ThinkPool) => {
        try {
          if (JSON.stringify(stats(await pooled(pool, make(), ticks))) !== JSON.stringify(stats(ref))) failures.push(label);
        } finally {
          pool.close();
        }
      };
      await check("fake 1", new ThinkPool(fakePorts(1)));
      await check("fake 3", new ThinkPool(fakePorts(3)));
      await check("threads", createNodeThinkPool(2));
      expect(failures).toEqual([]);
    }

    it.each([false, true])("matches with collision damage, ageing, seasons and a map on, WebAssembly %s", async (wasm) => {
      const ref = serial(rich(wasm), 250);
      expect(ref.wasm).toBe(wasm);
      expect(ref.births).toBeGreaterThan(0);
      expect(ref.deaths).toBeGreaterThan(0);
      for (const [name, off] of Object.entries(without)) {
        const c = rich(wasm);
        off(c);
        expect([name, serial(c, 250).fingerprint() === ref.fingerprint()]).toEqual([name, false]);
      }
      await compareAll(() => rich(wasm), 250, ref);
    }, 60_000);

    it("matches with poison that hurts but does not always kill", async () => {
      const poisoned = (): EcoConfig => {
        const c = cfg();
        c.eco.wasm = false;
        c.world.poisonDensity = 0.5; // plenty, so random walkers bite some
        return c;
      };
      const hurting = (): EcoConfig => {
        const c = poisoned();
        c.world.poisonDamage = 30;
        return c;
      };
      const plain = poisoned();
      const ref = serial(hurting(), 400);
      expect(ref.fingerprint()).not.toBe(serial(plain, 400).fingerprint());
      await compareAll(hurting, 400, ref);
    }, 60_000);

    it.each([false, true])("matches with rock and slow and fast ground, WebAssembly %s", async (wasm) => {
      const mapped = (): EcoConfig => {
        const c = cfg();
        c.eco.wasm = wasm;
        c.world = { ...c.world, width: 1800, height: 1300, stoneDensity: 0.06, ridgeDensity: 0.05, slowDensity: 0.1, fastDensity: 0.1 };
        return c;
      };
      const ref = serial(mapped(), 300);
      expect(ref.wasm).toBe(wasm);
      const plain = mapped();
      plain.world = { ...plain.world, stoneDensity: 0, ridgeDensity: 0, slowDensity: 0, fastDensity: 0 };
      expect(serial(plain, 300).fingerprint()).not.toBe(ref.fingerprint());
      await compareAll(mapped, 300, ref);
    }, 60_000);

    it.each([false, true])("matches in the predators world, WebAssembly %s", async (wasm) => {
      const ref = serial(predators(wasm), 200);
      expect(ref.wasm).toBe(wasm);
      expect(ref.speciesCounts[0]!.eaten).toBeGreaterThan(0);
      expect(ref.speciesCounts[1]!.births).toBeGreaterThan(0);
      await compareAll(() => predators(wasm), 200, ref);
    }, 60_000);
  });

  it.each([false, true])("keeps the memory units of a restored world on the helpers, WebAssembly %s", async (wasm) => {
    const config = (): EcoConfig => ({ ...cfg(), eco: { ...cfg().eco, wasm } });
    const before = serial(config(), 120);
    expect(before.members.some((m) => m.creature.memory.some((v) => v !== 0))).toBe(true); // the helpers must start from these, not from zeros
    const saved = saveState(before);
    const ref = restoreState(structuredClone(saved));
    for (let t = 0; t < 80; t++) ref.step();
    const pool = new ThinkPool(fakePorts(2));
    try {
      const eco = restoreState(structuredClone(saved), null, { journal: true });
      await pool.start(eco);
      for (let t = 0; t < 80; t++) await pool.step(eco);
      expect(eco.fingerprint()).toBe(ref.fingerprint());
    } finally {
      pool.close();
    }
  }, 60_000);

  it.each([false, true])("a watched creature that a helper owns has the serial run's rays, WebAssembly %s", async (wasm) => {
    const config = (): EcoConfig => ({ ...cfg(), eco: { ...cfg().eco, wasm } });
    const ref = serial(config(), 60);
    const pool = new ThinkPool(fakePorts(2));
    try {
      const eco = await pooled(pool, config(), 60);
      const id = eco.members.find((m) => m.owner < 2)!.id;
      pool.watch = id;
      eco.detail = ref.detail = id;
      let seen = 0;
      for (let t = 0; t < 8; t++) {
        ref.step();
        await pool.step(eco);
        const a = ref.get(id)?.creature;
        const b = eco.get(id)?.creature;
        if (!a || !b) break;
        expect(b.rays).toEqual(a.rays);
        seen++;
      }
      expect(seen).toBeGreaterThan(0);
      expect(eco.fingerprint()).toBe(ref.fingerprint());
    } finally {
      pool.close();
    }
  }, 60_000);

  it("reuses its helpers for a second run", async () => {
    const pool = new ThinkPool(fakePorts(2));
    await pooled(pool, cfg(1), 50);
    const eco = await pooled(pool, cfg(2), 100);
    expect(eco.fingerprint()).toBe(serial(cfg(2), 100).fingerprint());
  });

  it("a second start before the first one is ready keeps the helpers in step", async () => {
    const pools = [new ThinkPool(fakePorts(2)), createNodeThinkPool(2)];
    for (const pool of pools) {
      try {
        const clock = { t: 0 };
        const runner = new EcoRunner(() => {}, () => (clock.t += 1));
        runner.useHelpers(pool);
        runner.handle({ type: "start", config: cfg(1), run: 1 });
        runner.handle({ type: "start", config: cfg(2), run: 2 });
        runner.handle({ type: "speed", speed: "max" });
        const eco = () => runner.ecosystem!;
        while (eco().tick < 60) await runner.pumpAsync();
        expect(pool.alive).toBe(true);
        expect(eco().fingerprint()).toBe(serial(cfg(2), eco().tick).fingerprint());
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
    expect(a.fingerprint()).toBe(81047108); // pinned; re-pinned for the terrain input (#34), was 116543125; change it only on purpose
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

  it("falls back to the JS path, exactly and without throwing, when plans may exceed the kernel's ray limit", () => {
    const c = wasmCfg();
    const many = { ...c, creature: { ...c.creature, rayCount: 70 }, eco: { ...c.eco, initialPopulation: 8 } };
    const eco = serial(many, 20);
    expect(eco.wasm).toBe(false);
    expect(eco.population).toBeGreaterThan(0);
    const ok = { ...c, creature: { ...c.creature, rayCount: 40 }, eco: { ...c.eco, initialPopulation: 8 } };
    expect(serial(ok, 5).wasm).toBe(true);
  });

  it("keep each creature's brain across births, deaths, recycling and plan mutations", () => {
    const c = wasmCfg();
    const eco = new Ecosystem({ ...c, world: { ...c.world, foodDensity: 2 }, eco: { ...c.eco, foodRegrow: 1, foodMaxDensity: 2, birthEnergyRange: [30, 30], birthCostRange: [20, 20], birthCooldownRange: [2, 2] } }); // fast turnover
    const out = new Float32Array(64);
    let checked = 0;
    const recycledShapes = new Set<number>(); // genome lengths of creatures that took over a dead one
    for (let t = 0; t < 600; t++) {
      // Only the detail creature keeps its brain input; the next member takes over each tick.
      const m = eco.members[t % eco.population]!;
      eco.detail = m.id;
      eco.prepareTick();
      eco.sensePhase(0, eco.population);
      const c = m.creature;
      if (c.brainVersion > 0) recycledShapes.add(c.brain.genome.length);
      c.brain.forward(c.brain.layerActivations()[0]!, out.subarray(0, c.outputs.length));
      for (let i = 0; i < c.outputs.length; i++) expect(Math.abs(c.outputs[i]! - out[i]!)).toBeLessThan(1e-4);
      checked++;
      eco.finishTick();
    }
    expect(eco.deaths).toBeGreaterThan(60);
    expect(recycledShapes.size).toBeGreaterThan(5);
    expect(checked).toBe(600);
  });
});

describe("tick timeout", () => {
  it("is the base until a tick has been timed, then 20 times the average tick", () => {
    expect(tickTimeoutMs(5_000, null)).toBe(5_000);
    expect(tickTimeoutMs(5_000, 100)).toBe(5_000); // 2 s is below the base
    expect(tickTimeoutMs(5_000, 400)).toBe(8_000); // a 50000-wide world on a loaded machine
    expect(tickTimeoutMs(50, 1)).toBe(50); // a short base stays short when ticks are fast
  });

  it("is capped at 120 s, so a dead helper is still noticed", () => {
    expect(tickTimeoutMs(5_000, 10_000)).toBe(120_000);
    expect(tickTimeoutMs(5_000, 6_000)).toBe(120_000); // 20 x 6 s = 120 s exactly
    expect(tickTimeoutMs(5_000, 5_999)).toBe(119_980);
  });
});

describe("helper fallbacks", () => {
  it("leaves a core for the page and one for the coordinator, at most 4 helpers", () => {
    expect(defaultHelpers(8)).toBe(4);
    expect(defaultHelpers(4)).toBe(3);
    expect(defaultHelpers(1)).toBe(1);
  });

  it("a runner whose helpers fail mid-run continues on one thread with the same result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pool = new ThinkPool(fakePorts(2, 30));
    const eco = await runFor(pool, 200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(pool.alive).toBe(false);
    expect(eco.journal).toBeNull();
    expect(eco.fingerprint()).toBe(serial(cfg(), eco.tick).fingerprint());
  });

  it("a helper that never answers a tick fails the pool after the timeout", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pool = new ThinkPool(fakePorts(2, 30, true), 50);
    const eco = await runFor(pool, 100);
    warn.mockRestore();
    expect(pool.alive).toBe(false);
    expect(eco.fingerprint()).toBe(serial(cfg(), eco.tick).fingerprint());
  });

  it("a helper that exits mid-run fails the pool at once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ports = nodeHelperPorts(2);
    const pool = new ThinkPool(ports);
    let killedAt = 0;
    let failedAt = 0;
    const eco = await runFor(pool, 100, (tick) => {
      if (tick >= 30 && !killedAt) {
        killedAt = tick;
        ports[0]!.terminate();
      }
      if (killedAt && !pool.alive && !failedAt) failedAt = tick;
    });
    warn.mockRestore();
    expect(pool.alive).toBe(false);
    expect(failedAt).toBeGreaterThan(0);
    expect(failedAt - killedAt).toBeLessThanOrEqual(3); // noticed within a few ticks, not after the 5 s tick timeout
    expect(eco.fingerprint()).toBe(serial(cfg(), eco.tick).fingerprint());
  });
});

describe("ThinkPool message handling", () => {
  // A helper port driven by hand: it records what the pool posts, answers init with ready when asked, and never answers a tick.
  function manualPort(autoReady = false) {
    let reply: (msg: HelperOut) => void = () => {};
    const posted: HelperIn[] = [];
    const terminate = vi.fn();
    const port: HelperPort = {
      post: (msg) => {
        posted.push(msg);
        if (autoReady && msg.type === "init") queueMicrotask(() => reply({ type: "ready", gen: msg.gen }));
      },
      onMessage: (callback) => { reply = callback; },
      onError: () => {},
      terminate,
    };
    return { port, posted, reply: (msg: HelperOut) => reply(msg), terminate };
  }
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const small = () => new Ecosystem(cfg(), null, { journal: true });

  it("ignores a late reply of an earlier run, clears its timers and stops its helpers once", async () => {
    vi.useFakeTimers();
    try {
      const h = manualPort();
      const pool = new ThinkPool([h.port]);
      const first = pool.start(small());
      await flush();
      const gen1 = h.posted[0]!.gen;
      h.reply({ type: "ready", gen: gen1 });
      await first;
      expect(vi.getTimerCount()).toBe(0); // the start timeout is cleared once the helpers answered

      let ready = false;
      const second = pool.start(small()).then(() => { ready = true; }, () => {});
      await flush();
      expect(h.posted[1]!.gen).not.toBe(gen1);
      h.reply({ type: "ready", gen: gen1 }); // the first run's helper answering late
      await flush();
      expect(ready).toBe(false);
      h.reply({ type: "ready", gen: h.posted[1]!.gen });
      await second;
      expect(ready).toBe(true);

      const third = pool.start(small()).then(() => "ready", () => "failed");
      await flush();
      pool.close();
      pool.close(); // a second close or failure changes nothing
      expect(await third).toBe("failed");
      expect(h.terminate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the first, cold tick the long start timeout and later ticks the short one", async () => {
    vi.useFakeTimers();
    try {
      const h = manualPort(true);
      const pool = new ThinkPool([h.port], 50);
      const eco = small();
      await pool.start(eco);
      const outcome = pool.step(eco).then(() => "ran", (e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(1_000); // far past the 50 ms tick timeout, within the cold allowance
      expect(pool.alive).toBe(true);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(pool.alive).toBe(false);
      expect(await outcome).toMatch(/stopped answering/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("helper packets", () => {
  it("fittedCaps grows for a bigger genome area, and the delta cap counts every word publish writes", () => {
    const caps = { creatures: 10, memory: 10, delta: 100, genome: 100 };
    expect(fittedCaps(caps, { ...caps, genome: 101 })).not.toBeNull();
    expect(fittedCaps(caps, caps)).toBeNull();

    const eco = new Ecosystem(cfg(), null, { journal: true });
    for (let t = 0; t < 120; t++) eco.step(); // the journal keeps filling: items, births, deaths
    expect(eco.journal!.born.length).toBeGreaterThan(0);
    expect(eco.journal!.died.length).toBeGreaterThan(0);
    const coordinator = new ShareCoordinator(2);
    const need = coordinator.need(eco);
    const fitted = fittedCaps(null, need)!;
    const home = packetViews(new ArrayBuffer(packetBytes(fitted)), fitted);
    coordinator.publish(eco, home, [0, 1].map(() => packetViews(new ArrayBuffer(packetBytes(fitted)), fitted)));
    expect((publishedBytes(home) - home.delta.byteOffset) / 8).toBe(need.delta);
  });

  it("helpers follow a live change of the ageing rate, as the serial run does", async () => {
    const aging = (): EcoConfig => {
      const c = cfg();
      c.eco.wasm = false;
      c.eco.aging = true;
      c.eco.agingStart = 2;
      c.eco.agingRate = 0.1;
      return c;
    };
    const run = async (retune: boolean, pool: ThinkPool | null): Promise<number> => {
      const eco = new Ecosystem(aging(), null, { journal: pool !== null });
      if (pool) await pool.start(eco);
      for (let t = 0; t < 160; t++) {
        if (t === 60 && retune) expect(eco.retune({ eco: { agingRate: 2 } }).ok).toBe(true);
        if (pool) await pool.step(eco);
        else eco.step();
      }
      return eco.fingerprint();
    };
    const pool = new ThinkPool(fakePorts(2));
    try {
      const serialRetuned = await run(true, null);
      expect(serialRetuned).not.toBe(await run(false, null)); // the change matters
      expect(await run(true, pool)).toBe(serialRetuned);
    } finally {
      pool.close();
    }
  });
});
