// @vitest-environment node
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_POOL, MAX_POOL_WEIGHTS, MAX_POOLS_FILE_BYTES, mostCopies } from "../../server/src/config.ts";
import { loadFounders, loadPools, parsePools } from "../../server/src/founders.ts";
import type { SeedFounder } from "../../server/src/founders.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";

import { smallConfig } from "./liveHelpers.ts";

const FOUNDERS = loadFounders(new URL("../../src/typescript/public/live-founders.json", import.meta.url).pathname);
const tmp = (): string => mkdtempSync(join(tmpdir(), "evolve-pools-"));
// Variant v of a founder: its genome with every weight shifted by v / 1000, so each variant is told apart by its first weight.
const variant = (f: SeedFounder, v: number): number[] => Array.from(f.genome, (w) => Math.round((w + v / 1000) * 1e6) / 1e6);
const pools = (f: SeedFounder, k: number) => ({ version: 1, pools: { [f.id]: Array.from({ length: k }, (_, v) => variant(f, v + 1)) } });
const fresh = (): LiveWorld => {
  const c = smallConfig();
  c.eco.initialPopulation = 0;
  return new LiveWorld(c, null);
};
const seq = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
};
// The variant number (0 the founder's own genome) of each seeded creature, from its first weight.
const drawn = (live: LiveWorld, f: SeedFounder): number[] => live.eco.members.map((m) => Math.round((m.creature.brain.genome[0]! - f.genome[0]!) * 1000));

describe("founder pools file", () => {
  const f = FOUNDERS[FOUNDERS.length - 1]!;

  it("adds each founder's pool, and leaves founders without one as they were", () => {
    const r = parsePools(pools(f, 3), FOUNDERS);
    if (typeof r === "string") throw new Error(r);
    expect(r.map((x) => x.pool?.length ?? 0)).toEqual(FOUNDERS.map((x) => (x.id === f.id ? 3 : 0)));
    expect(r.find((x) => x.id === f.id)!.pool![1]![0]).toBeCloseTo(f.genome[0]! + 0.002, 5);
    const none = parsePools({ version: 1, pools: {} }, FOUNDERS);
    expect(none).toEqual(FOUNDERS);
  });

  it("refuses a wrong shape, an unknown or shared id, too many variants, too many weights, a wrong length and bad weights", () => {
    const bad = (data: unknown, founders = FOUNDERS): string => {
      const r = parsePools(data, founders);
      if (typeof r !== "string") throw new Error("accepted");
      return r;
    };
    for (const d of [null, [], { pools: {} }, { version: 2, pools: {} }, { version: 1, pools: [] }]) expect(bad(d)).toMatch(/must be/);
    expect(bad({ version: 1, pools: { nobody: [] } })).toMatch(/for no founder/);
    expect(bad(pools(f, 1), [f, { ...f, name: "Twin" }])).toMatch(/more than one founder/);
    expect(bad(pools(f, MAX_POOL + 1))).toMatch(new RegExp(`at most ${MAX_POOL}`));
    expect(bad({ version: 1, pools: { [f.id]: "x" } })).toMatch(/a list/);
    // The largest shipped plan, as many founders as it takes to pass the bound with full pools.
    const big = FOUNDERS.reduce((a, b) => (b.genome.length > a.genome.length ? b : a));
    const many = Array.from({ length: Math.ceil(MAX_POOL_WEIGHTS / (MAX_POOL * big.genome.length)) + 1 }, (_, i) => ({ ...big, id: `b${i}` }));
    const full = { version: 1, pools: Object.fromEntries(many.map((x) => [x.id, Array.from({ length: MAX_POOL }, () => Array.from(big.genome))])) };
    expect(bad(full, many)).toMatch(new RegExp(`more than ${MAX_POOL_WEIGHTS} weights`));
    const g = variant(f, 1);
    expect(bad({ version: 1, pools: { [f.id]: [g.slice(1)] } })).toMatch(/genome 1: genome must have/);
    for (const w of [null, "0.1", 1e9, Infinity]) expect(bad({ version: 1, pools: { [f.id]: [g, [w, ...g.slice(1)]] } })).toMatch(/genome 2: genome weights must be finite/);
  });

  it("loads nothing when there is no file, and refuses a broken or oversized file", () => {
    const dir = tmp();
    expect(loadPools(join(dir, "none.json"), FOUNDERS)).toBe(FOUNDERS);
    expect(() => loadPools(join(dir, "none.json"), FOUNDERS, true)).toThrow(/founder pools file/); // a path the admin set must be there
    const file = join(dir, "founder-pools.json");
    writeFileSync(file, JSON.stringify(pools(f, 2)));
    expect(loadPools(file, FOUNDERS).find((x) => x.id === f.id)!.pool).toHaveLength(2);
    writeFileSync(file, "{not json");
    expect(() => loadPools(file, FOUNDERS)).toThrow(/founder pools file/);
    writeFileSync(file, JSON.stringify({ version: 1, pools: { nobody: [] } }));
    expect(() => loadPools(file, FOUNDERS)).toThrow(/for no founder/);
    writeFileSync(file, " ".repeat(MAX_POOLS_FILE_BYTES + 1));
    expect(() => loadPools(file, FOUNDERS)).toThrow(/founder pools file/);
    const link = join(dir, "dangling.json");
    symlinkSync(join(dir, "gone.json"), link);
    expect(() => loadPools(link, FOUNDERS)).toThrow(/founder pools file/); // a link is no missing file: the start stops
  });
});

describe("seeding from founder pools", () => {
  const f = FOUNDERS[FOUNDERS.length - 1]!;
  const withPool = (k: number): SeedFounder[] => {
    const r = parsePools(pools(f, k), [f]);
    if (typeof r === "string") throw new Error(r);
    return r;
  };

  it("gives every copy a different variant while there are enough, and cycles evenly through them when there are not", () => {
    const room = mostCopies(1, smallConfig().eco);
    expect(room).toBeGreaterThanOrEqual(12);
    const a = fresh();
    a.seedFounders(withPool(9), seq(1), 10); // 10 copies, 10 variants: each once
    expect(drawn(a, f).sort((x, y) => x - y)).toEqual([...Array(10).keys()]);
    const b = fresh();
    b.seedFounders(withPool(3), seq(1), 10); // 10 copies, 4 variants: 3, 3, 2 and 2
    const counts = [0, 0, 0, 0];
    for (const v of drawn(b, f)) counts[v]!++;
    expect(counts.sort()).toEqual([2, 2, 3, 3]);
    const c = fresh();
    c.seedFounders([f], seq(1), 5); // no pool: clones, as before
    expect(drawn(c, f)).toEqual([0, 0, 0, 0, 0]);
  });

  it("balances the variants of every founder, not only the first", () => {
    const [a, b] = [FOUNDERS.find((x) => x.genome.length !== f.genome.length)!, f]; // told apart by genome length
    const r = parsePools({ version: 1, pools: { [a.id]: [1, 2, 3].map((v) => variant(a, v)), [b.id]: [1, 2, 3].map((v) => variant(b, v)) } }, [a, b]);
    if (typeof r === "string") throw new Error(r);
    expect(mostCopies(2, smallConfig().eco)).toBeGreaterThanOrEqual(10);
    const live = fresh();
    live.seedFounders(r, seq(3), 10); // 10 copies each, 4 variants each: 3, 3, 2 and 2 for both
    for (const x of [a, b]) {
      const counts = [0, 0, 0, 0];
      for (const m of live.eco.members) if (m.creature.brain.genome.length === x.genome.length) counts[Math.round((m.creature.brain.genome[0]! - x.genome[0]!) * 1000)]!++;
      expect(counts.sort()).toEqual([2, 2, 3, 3]);
    }
  });

  it("draws the variant order from the server's draws, so fresh worlds differ while the same draws give the same order", () => {
    const order = (draws: number): number[] => {
      const live = fresh();
      live.seedFounders(withPool(MAX_POOL), seq(draws), 4);
      return drawn(live, f).sort((x, y) => x - y);
    };
    expect(order(1)).toEqual(order(1));
    expect(order(1)).not.toEqual(order(2));
  });
});
