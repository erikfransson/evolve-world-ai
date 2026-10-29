// @vitest-environment node
// Idea 138: the viewer frame path rewritten for speed must give the same bytes, records, family list and detail rows as before.
import { parsedName, parsedNameCacheSize } from "../../server/src/chronicle.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { namedTop } from "../../server/src/chronicle.ts";
import { encodeMembers } from "../../server/src/memberFrame.ts";
import { MAX_RECORDS, LINEAGE_TOP } from "../../src/typescript/src/live/protocol.ts";
import { encodeCreatures } from "./frameOracle.ts";
import { wireName } from "../../src/typescript/src/live/add.ts";
import { Leaderboard } from "../../src/typescript/src/sim/leaderboard.ts";
import { fullEnergy } from "../../src/typescript/src/sim/species.ts";
import { wrapAngle } from "../../src/typescript/src/sim/angle.ts";
import type { EcoCreature, Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { smallConfig } from "./liveHelpers.ts";

// The path before the change: readCreatures into f32 arrays, the age by id, encodeCreatures.
function oldFrame(e: Ecosystem): Uint8Array {
  const f = e.readCreatures();
  const age = new Float32Array(f.count);
  for (let i = 0; i < f.count; i++) age[i] = e.get(f.ids[i]!)!.ageTicks * e.config.dt;
  return encodeCreatures(e.tick, { ...f, age, radius: e.config.creature.radius }, e.config.world, fullEnergy(e.config.eco));
}
const newFrame = (e: Ecosystem): Uint8Array => encodeMembers(e.tick, e.members, e.config.dt, e.config.creature.radius, e.config.world, fullEnergy(e.config.eco));
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && Buffer.compare(a, b) === 0;

function seeded(wasm: boolean): LiveWorld {
  const c = smallConfig();
  c.eco.wasm = wasm;
  c.eco.initialPopulation = 60;
  c.eco.maxPopulation = 150;
  return new LiveWorld(c, null);
}

describe.each([false, true])("creature frame bytes, resident bodies %s", (wasm) => {
  it("equals readCreatures + encodeCreatures over a run with births, deaths, odd values and added creatures", () => {
    const w = seeded(wasm);
    const e = w.eco;
    let compared = 0;
    for (let step = 0; step < 1500; step++) {
      e.step();
      if (step === 100) {
        const ms = e.members;
        const odd = [1e6, -1e6, 7, -7, Math.PI, -Math.PI, 2 * Math.PI, 1e-30, -1e-30, NaN, Infinity];
        ms.forEach((m, i) => {
          const s = m.creature.state;
          s.heading = odd[i % odd.length]!;
          if (i % 5 === 0) m.hue = [-30, 359.9999, 360, 725, NaN][i % 25 / 5 | 0]!;
          if (i % 7 === 0) s.x = -3;
          if (i % 11 === 0) s.y = e.config.world.height * 2;
          if (i % 13 === 0) s.energy = 1e9;
          if (i % 17 === 0) s.energy = -5;
          if (i % 19 === 0) s.ticksAlive = 1e7;
        });
      }
      if (step % 20 === 0 || step < 3) {
        expect(same(newFrame(e), oldFrame(e)), `step ${step}`).toBe(true);
        expect(same(w.creatureFrame(), oldFrame(e))).toBe(true);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20);
    expect(e.births + e.deaths).toBeGreaterThan(0);
  });
});

describe("creature frame bytes, random member values", () => {
  it("equal to the old path on 40000 members with ranges and edges of every field", () => {
    const rnd = ((s: number) => () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296))(7);
    const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
    const num = (scale: number, specials: number[]): number => (rnd() < 0.2 ? pick(specials) : (rnd() * 2 - 1) * scale);
    const n = 40000;
    const members: EcoCreature[] = [];
    for (let i = 0; i < n; i++) {
      members.push({
        id: pick([i, i + 2 ** 31, 2 ** 32 + i, -i - 1]),
        hue: num(500, [0, 360, 359.99999, -0, NaN, 1e300]),
        founderId: pick([i, 2 ** 31 + i, -5, 2 ** 33]),
        creature: { state: { x: num(1e4, [0, -0, NaN, 1e300]), y: num(1e4, [0, 1e300, -Infinity]), heading: num(20, [Math.PI, -Math.PI, 1e-30, -1e-30, -0, 1e300, NaN, Infinity, 2 * Math.PI, 3.9999999, -3.9999999]), energy: num(500, [0, NaN, 1e300]), ticksAlive: Math.floor(Math.abs(num(1e5, [0, 1e12, NaN]))) } },
      } as unknown as EcoCreature);
    }
    const world = { width: 2000, height: 1300 };
    const dt = 1 / 30, radius = 4.3, fe = 217.5;
    const fakeEco = {
      tick: 123456, members, config: { dt, creature: { radius }, world, eco: {} },
      get: (id: number) => members.find((m) => m.id === id)!,
    };
    // the old path on the same members (readCreatures' stores, then encodeCreatures)
    const ids = new Int32Array(n), x = new Float32Array(n), y = new Float32Array(n), heading = new Float32Array(n), energy = new Float32Array(n), hue = new Float32Array(n), founder = new Int32Array(n), age = new Float32Array(n);
    members.forEach((m, i) => {
      const s = m.creature.state;
      ids[i] = m.id; x[i] = s.x; y[i] = s.y; heading[i] = wrapAngle(s.heading); energy[i] = s.energy; hue[i] = m.hue; founder[i] = m.founderId; age[i] = s.ticksAlive * dt;
    });
    const old = encodeCreatures(fakeEco.tick, { count: n, ids, x, y, heading, energy, hue, founder, age, radius }, world, fe);
    expect(same(encodeMembers(fakeEco.tick, members, dt, radius, world, fe), old)).toBe(true);
  });
});

describe("Leaderboard.floor", () => {
  it("offering only values that are not below the floor leaves every list as offering everything, for creatures whose values only grow", () => {
    const rnd = ((s: number) => () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296))(11);
    const all = new Leaderboard(MAX_RECORDS), skipped = new Leaderboard(MAX_RECORDS);
    const values = Array.from({ length: 300 }, () => 0);
    let offersSkipped = 0, offersAll = 0;
    const build = (id: number) => () => ({ id, species: 0, hue: 1, from: 0, plan: { rayCount: 1, raySpread: 1, rayLength: 1, hiddenLayers: [], memoryShort: 0, memoryLong: 0 } });
    for (let round = 1; round <= 400; round++) {
      for (let id = 0; id < values.length; id++) {
        if (rnd() < 0.3) values[id]! += rnd() < 0.5 ? 0 : Math.floor(rnd() * 3); // only grows, zeros and ties included
        const v = values[id]!;
        all.offer("age", 0, id, v, round, true, build(id));
        offersAll++;
        if (v > 0 && v >= skipped.floor(skipped.entries("age", 0))) {
          skipped.offer("age", 0, id, v, round, true, build(id));
          offersSkipped++;
        }
      }
      expect(JSON.stringify(skipped.snapshot())).toBe(JSON.stringify(all.snapshot()));
    }
    expect(offersSkipped).toBeLessThan(offersAll / 2);
    expect(new Leaderboard(3).floor(undefined)).toBe(0);
  });
});

describe("the stats pass", () => {
  it("gives the same records, best, depth and lineages as offering every creature, and calls offer far less once the records are high", async () => {
    const run = (legacy: boolean): { seen: string[]; offers: number } => {
      const proto = Leaderboard.prototype;
      const floor = proto.floor, offer = proto.offer;
      let offers = 0;
      proto.offer = function (this: Leaderboard, ...a: Parameters<Leaderboard["offer"]>) { offers++; return offer.apply(this, a); };
      if (legacy) proto.floor = () => 0; // v > 0 && v >= 0: every creature with a value is offered, the old loop
      try {
        const w = seeded(true);
        const seen: string[] = [];
        for (let t = 1; t <= 1500; t++) {
          w.eco.step();
          if (t === 900) {
            // records far above any living creature, as in a world that has run for hours: from here on almost everyone is below the floor
            const chronicle = (w as unknown as { chronicle: { board: Leaderboard } }).chronicle;
            const plan = { rayCount: 1, raySpread: 1, rayLength: 1, hiddenLayers: [], memoryShort: 0, memoryLong: 0 };
            for (const board of ["age", "children", "eaten"] as const) for (let k = 0; k < 3; k++) chronicle.board.offer(board, 0, -1 - k, 1e6 + k, t, false, () => ({ id: -1 - k, species: 0, hue: 1, from: 0, plan }));
            offers = 0;
          }
          if (t % 30 === 0) {
            const s = w.stats(1, t % 150 === 0);
            seen.push(JSON.stringify({ best: s.best, depth: s.depth, lineages: s.lineages, records: s.records }));
          }
        }
        return { seen, offers };
      } finally {
        proto.floor = floor;
        proto.offer = offer;
      }
    };
    const old = run(true), now = run(false);
    expect(now.seen).toEqual(old.seen);
    expect(new Set(now.seen.slice(0, 30).map((s) => JSON.stringify(JSON.parse(s).records))).size).toBeGreaterThan(3); // records did change before: the slow path ran
    expect(now.offers).toBeLessThan(old.offers / 3);
  });
});

describe("namedTop with the name cache", () => {
  // The function before the cache.
  function oldTop(eco: Ecosystem, k: number): unknown {
    const groups = new Map<string, { founder: number; hue: number; pool: boolean; count: number; name: string; starter: boolean; others: number[] }>();
    eco.lineages.forEachLiving((founder, count, hue, pool) => {
      const { name, starter } = wireName(eco.lineageName(founder));
      const key = name ? `${starter ? "*" : ""}${name.toLowerCase()}` : `#${founder}`;
      const g = groups.get(key);
      if (!g) groups.set(key, { founder, hue, pool, count, name, starter, others: [] });
      else {
        g.count += count;
        if (founder < g.founder) {
          g.others.push(g.founder);
          Object.assign(g, { founder, hue, pool, name });
        } else g.others.push(founder);
      }
    });
    return [...groups.values()].sort((a, b) => b.count - a.count || a.founder - b.founder).slice(0, k);
  }

  it("matches the uncached list for starters, blanked, invalid, mixed-case and repeated names, before and after a rename", () => {
    const w = seeded(false);
    const e = w.eco;
    for (let i = 0; i < 30; i++) e.step();
    const founders = [...new Set(e.members.map((m) => m.founderId))];
    const names = ["Kiwi", "kiwi", "KIWI", "*Starter", "*starter", "-", "bad name", "", "x".repeat(200), "Zed1", "Zed1", "*", "Ünï", "a<b>"];
    for (let round = 0; round < 3; round++) {
      founders.forEach((f, i) => e.lineages.describe(f, (i * 37) % 360, 0, i % 3 === 0, names[(i + round) % names.length]!));
      expect(JSON.stringify(namedTop(e, LINEAGE_TOP))).toBe(JSON.stringify(oldTop(e, LINEAGE_TOP)));
      expect(JSON.stringify(namedTop(e, 1000))).toBe(JSON.stringify(oldTop(e, 1000)));
    }
  });
});

describe("followed creatures", () => {
  it("rebuilding the crowd grid once per refresh gives the same detail rows and the same world as once per creature", () => {
    const run = (legacy: boolean): { rows: string[]; fingerprint: number } => {
      const w = seeded(false);
      const e = w.eco;
      for (let i = 0; i < 40; i++) e.step();
      const priv = w as unknown as { refreshes: { take(n: number): boolean }; capture(id: number): unknown };
      priv.refreshes = { take: () => true };
      const ids = e.members.slice(0, 6).map((m) => m.id);
      ids.forEach((id) => w.watch(id));
      const rows: string[] = [];
      for (let t = 0; t < 120; t++) {
        e.step();
        if (t % 6 === 0) {
          if (legacy) {
            for (const id of ids) if (e.get(id)) { e.detail = id; e.refreshDetail(); priv.capture(id); }
            e.detail = null;
          } else w.refreshWatched();
          for (const id of ids) rows.push(Buffer.from(w.detail(id) ?? new Uint8Array(0)).toString("base64"));
        }
      }
      return { rows, fingerprint: e.fingerprint() };
    };
    const a = run(true), b = run(false);
    expect(b.rows).toEqual(a.rows);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(a.rows.some((r) => r.length > 0)).toBe(true);
  });
});

describe("the parsed-name cache", () => {
  it("stays under its bound through more distinct names than it holds, and still parses after the clear", () => {
    for (let i = 0; i < 2100; i++) parsedName(`Name${i}`);
    expect(parsedNameCacheSize()).toBeLessThanOrEqual(2048); // red without the clear: 2100
    expect(parsedName("Name5").name).toBe(parsedName("Name5").name);
    expect(parsedName("Zed").name).toBe("Zed");
  });
});
