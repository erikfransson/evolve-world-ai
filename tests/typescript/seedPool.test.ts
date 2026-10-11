import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Brain, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { POOL_VERSION, ecoSizes, loadPool, parsePool, trialsSizes, trialsToEcoGenome } from "../../src/typescript/src/sim/seedPool.ts";
import type { PoolEntry } from "../../src/typescript/src/sim/seedPool.ts";
import { CREATURE_RAY_FEATURE_LABELS, FEAT_CREATURE, FEAT_SEEN_ENERGY, RAY_FEATURES } from "../../src/typescript/src/sim/sensors.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import { testRng } from "./helpers.ts";

const plan = (rayCount: number, hiddenLayers: number[], memoryShort = 2, memoryLong = 1): BodyPlan => ({ rayCount, raySpread: 1.2, rayLength: 90, hiddenLayers, memoryShort, memoryLong });
const PLANS = [plan(3, [8]), plan(6, [12, 8], 0, 0), plan(10, [16], 4, 4)];

function entry(p: BodyPlan, seed: number): PoolEntry {
  return { plan: p, genome: randomGenome(trialsSizes(p), testRng(seed)), fitness: 50 + seed, world: { food: 0.7, poison: 0.1 } };
}

// A JSON pool entry as buildPool writes it.
const json = (e: PoolEntry) => ({ plan: e.plan, world: e.world, fitness: e.fitness, run: 0, genome: Array.from(e.genome) });

describe("trialsToEcoGenome", () => {
  it("gives identical outputs, whatever the creature features hold", () => {
    for (const [k, p] of PLANS.entries()) {
      const e = entry(p, k + 1);
      const trials = new Brain(trialsSizes(p), e.genome);
      const eco = new Brain(ecoSizes(p), trialsToEcoGenome(p, e.genome));
      const rng = testRng(10 + k);
      const nIn = trialsSizes(p)[0]!;
      const F = CREATURE_RAY_FEATURE_LABELS.length;
      for (let trial = 0; trial < 20; trial++) {
        const tIn = Float32Array.from({ length: nIn }, () => (rng.next() < 0.5 ? 0 : rng.next() * 2 - 1));
        const eIn = new Float32Array(ecoSizes(p)[0]!);
        for (let i = 0; i < nIn; i++) {
          const ray = Math.floor(i / RAY_FEATURES);
          eIn[i < p.rayCount * RAY_FEATURES ? ray * F + (i % RAY_FEATURES) : i + p.rayCount * (F - RAY_FEATURES)] = tIn[i]!;
        }
        // Zero creature features first, then seen creatures: neither may change the output.
        for (const seen of [0, 1]) {
          for (let r = 0; r < p.rayCount; r++) {
            eIn[r * F + FEAT_CREATURE] = seen;
            eIn[r * F + FEAT_SEEN_ENERGY] = seen * rng.next();
          }
          const tOut = new Float32Array(trialsSizes(p).at(-1)!);
          const eOut = new Float32Array(tOut.length);
          trials.forward(tIn, tOut);
          eco.forward(eIn, eOut);
          expect(Array.from(eOut)).toEqual(Array.from(tOut));
        }
      }
    }
  });

  it("rejects a genome of the wrong length", () => {
    expect(() => trialsToEcoGenome(PLANS[0]!, new Float32Array(3))).toThrow(/genome length/);
  });
});

describe("parsePool", () => {
  it("keeps valid entries and rejects malformed ones with a reason", () => {
    const good = PLANS.map((p, k) => json(entry(p, k + 1)));
    const shortGenome = { ...good[0]!, genome: good[0]!.genome.slice(1) };
    const nanGenome = { ...good[1]!, genome: good[1]!.genome.map((v, i) => (i === 5 ? null : v)) };
    const badPlan = { ...good[2]!, plan: { ...good[2]!.plan, rayCount: 2.5 } };
    const { entries, rejected } = parsePool({ version: POOL_VERSION, entries: [good[0], shortGenome, good[1], nanGenome, badPlan, "x", good[2]] });
    expect(entries.map((e) => e.plan)).toEqual(PLANS);
    expect(entries[1]!.genome).toEqual(entry(PLANS[1]!, 2).genome);
    expect(rejected).toHaveLength(4);
    expect(rejected[0]).toMatch(/entry 1: genome/);
    expect(rejected[2]).toMatch(/entry 4: bad rayCount/);
  });

  it("throws on a file that is not a pool of this version", () => {
    expect(() => parsePool({ entries: "nope" })).toThrow(/not a pool/);
    expect(() => parsePool({ version: 99, entries: [] })).toThrow(/version/);
  });

  it("accepts the shipped public/pool.json in full, with at least 50 entries", () => {
    const file = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../src/typescript/public/pool.json"), "utf8"));
    const { entries, rejected } = parsePool(file);
    expect(rejected).toEqual([]);
    expect(entries.length).toBeGreaterThanOrEqual(50);
  });
});

describe("loadPool", () => {
  const respond = (body: unknown, status = 200) => () => Promise.resolve(new Response(JSON.stringify(body), { status }));

  it("returns the parsed entries", async () => {
    const pool = await loadPool("pool.json", respond({ version: POOL_VERSION, entries: [json(entry(PLANS[0]!, 1))] }) as typeof fetch);
    expect(pool).toHaveLength(1);
  });

  it("warns and returns null on a failed fetch, an HTTP error or an empty pool", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadPool("pool.json", (() => Promise.reject(new Error("offline"))) as typeof fetch)).toBeNull();
    expect(await loadPool("pool.json", respond({}, 404) as typeof fetch)).toBeNull();
    expect(await loadPool("pool.json", respond({ version: POOL_VERSION, entries: [{}] }) as typeof fetch)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(4); // the empty pool also warns about its malformed entry
    warn.mockRestore();
  });
});

describe("Ecosystem founders from a pool", () => {
  const pool = PLANS.map((p, k) => entry(p, k + 1));
  const cfg = (eco: Partial<EcoConfig["eco"]> = {}, mutationRate = DEFAULT_ECO_CONFIG.mutation.rate): EcoConfig => {
    const d = structuredClone(DEFAULT_ECO_CONFIG);
    return { ...d, seed: 5, world: { ...d.world, width: 1000, height: 1000 }, eco: { ...d.eco, initialPopulation: 40, foundersVary: false, ...eco }, mutation: { ...d.mutation, rate: mutationRate } };
  };
  const samePlan = (a: BodyPlan, b: BodyPlan): boolean => JSON.stringify(a) === JSON.stringify(b);

  it("takes poolFraction of the founders round-robin from the pool, the rest random", () => {
    const eco = new Ecosystem(cfg({ poolFraction: 0.5 }, 0), pool);
    expect(eco.poolFounders).toBe(20);
    const counts = pool.map(() => 0);
    eco.members.forEach((m, i) => {
      const k = pool.findIndex((e) => samePlan(e.plan, m.creature.plan as BodyPlan));
      if (i >= 20) return expect(k).toBe(-1);
      counts[k]!++;
      expect(Array.from(m.creature.brain.genome)).toEqual(Array.from(trialsToEcoGenome(pool[k]!.plan, pool[k]!.genome)));
      // Round-robin: consecutive founders take consecutive entries.
      const prev = pool.findIndex((e) => samePlan(e.plan, eco.members[i - 1]?.creature.plan as BodyPlan));
      if (i > 0) expect(k).toBe((prev + 1) % pool.length);
    });
    expect(counts.slice().sort()).toEqual([6, 7, 7]);
  });

  it("mutates pool founders, and has none at fraction 0 or without a pool", () => {
    const eco = new Ecosystem(cfg({ poolFraction: 1 }), pool);
    expect(eco.poolFounders).toBe(40);
    const m = eco.members[0]!;
    const k = pool.findIndex((e) => samePlan(e.plan, m.creature.plan as BodyPlan));
    expect(Array.from(m.creature.brain.genome)).not.toEqual(Array.from(trialsToEcoGenome(pool[k]!.plan, pool[k]!.genome)));
    expect(new Ecosystem(cfg({ poolFraction: 0 }), pool).poolFounders).toBe(0);
    expect(new Ecosystem(cfg({ poolFraction: 0.5 })).poolFounders).toBe(0);
    expect(new Ecosystem(cfg({ poolFraction: 0.5 }), []).poolFounders).toBe(0);
  });

  it("is deterministic with a given pool, and a pool at fraction 0 changes nothing", () => {
    const run = (c: EcoConfig, p: PoolEntry[] | null) => {
      const eco = new Ecosystem(c, p);
      for (let t = 0; t < 200; t++) eco.step();
      return eco.fingerprint();
    };
    expect(run(cfg(), pool)).toBe(run(cfg(), pool));
    expect(run(cfg(), pool)).not.toBe(run(cfg(), null));
    expect(run(cfg({ poolFraction: 0 }), pool)).toBe(run(cfg(), null));
  });
});
