import { layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import type { InsertSpec } from "../../src/typescript/src/sim/ecosystem.ts";
import { LIVE_FIELDS } from "../../src/typescript/src/sim/retune.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import { ThinkPool, serveHelper } from "../../src/typescript/src/worker/ecoPool.ts";
import type { HelperIn, HelperOut, HelperPort } from "../../src/typescript/src/worker/ecoPool.ts";

// A small crowded world where creatures are born and die within a few hundred ticks, with the features that carry state: collision damage, aging, seasons.
function cfg(wasm: boolean): EcoConfig {
  const d = structuredClone(DEFAULT_ECO_CONFIG);
  return {
    ...d,
    seed: 5,
    world: { ...d.world, width: 900, height: 900 },
    creature: { ...d.creature, startEnergy: 60 },
    eco: {
      ...d.eco, wasm, initialPopulation: 60, foundersVary: true, structuralRate: 0.3, collisionDamage: true, damagePerSpeed: 0.5,
      aging: true, agingStart: 5, agingRate: 3, seasons: true, yearMinutes: 1,
      birthEnergyRange: [76, 76], birthCostRange: [75, 75], birthCooldownRange: [10, 10],
    },
  };
}

// In-process helper threads over cloned messages.
function pool(n: number): ThinkPool {
  const ports: HelperPort[] = Array.from({ length: n }, () => {
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
  return new ThinkPool(ports);
}

// A world with 0 (serial) or 3 helper threads, started.
async function world(config: EcoConfig, threads: number): Promise<{ eco: Ecosystem; step: (ticks: number) => Promise<void>; pool: ThinkPool | null }> {
  const p = threads ? pool(threads) : null;
  const eco = new Ecosystem(config, null, { journal: threads > 0 });
  await p?.start(eco);
  return { eco, pool: p, step: attach(eco, p) };
}

function attach(eco: Ecosystem, p: ThinkPool | null): (ticks: number) => Promise<void> {
  return async (ticks) => {
    for (let t = 0; t < ticks; t++) {
      if (p) await p.step(eco);
      else eco.step();
    }
  };
}

const PLAN: BodyPlan = { rayCount: 5, raySpread: 2, rayLength: 90, hiddenLayers: [7], memoryShort: 2, memoryLong: 1 };

function spec(config: EcoConfig, over: Partial<InsertSpec> = {}): InsertSpec {
  return { genome: randomGenome(layerSizes(config, PLAN), createRng(11)), plan: PLAN, x: 450, y: 450, hue: 300, name: "Zed", ...over };
}

const json = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("save and restore", () => {
  for (const wasm of [false, true]) {
    for (const threads of [0, 3]) {
      it(`continues bit-identically (wasm ${wasm}, ${threads} helper threads)`, async () => {
        const config = cfg(wasm);
        // Uninterrupted reference, with an inserted creature and a live retune on the way.
        const ref = await world(structuredClone(config), 0);
        await ref.step(120);
        expect(ref.eco.insertCreature(spec(config)).ok).toBe(true);
        await ref.step(280);

        const a = await world(structuredClone(config), threads);
        await a.step(120);
        const inserted = a.eco.insertCreature(spec(config));
        expect(inserted.ok).toBe(true);
        await a.step(100);
        const saved = json(saveState(a.eco));
        a.pool?.close();

        const eco = restoreState(saved, null, { journal: threads > 0 });
        const p = threads ? pool(threads) : null;
        await p?.start(eco);
        await attach(eco, p)(180);
        expect(eco.fingerprint()).toBe(ref.eco.fingerprint());
        // The whole state matches too, so a field that has not yet changed a position would show.
        expect(json(saveState(eco))).toEqual(json(saveState(ref.eco)));
        expect(eco.lineageName(inserted.ok ? inserted.id : -1)).toBe("Zed");
      });
    }
  }

  it("rejects a state of another version", () => {
    const eco = new Ecosystem(cfg(false));
    const state = json(saveState(eco));
    expect(() => restoreState({ ...state, version: 99 })).toThrow(/version/);
  });

  it("keeps the state size modest", () => {
    const eco = new Ecosystem(cfg(false));
    for (let t = 0; t < 20; t++) eco.step();
    const bytes = JSON.stringify(saveState(eco)).length;
    expect(bytes / eco.population).toBeLessThan(20_000);
  });
});

describe("insertCreature", () => {
  it("gives the same world with 0 and 3 helper threads, and starts a lineage", async () => {
    const config = cfg(false);
    const prints: number[] = [];
    for (const threads of [0, 3]) {
      const w = await world(structuredClone(config), threads);
      await w.step(50);
      const before = w.eco.population;
      const r = w.eco.insertCreature(spec(config, { name: "Alpha", x: 100, y: 120, energy: 80, hue: -60 }));
      expect(r).toEqual({ ok: true, id: expect.any(Number) });
      if (!r.ok) return;
      expect(w.eco.population).toBe(before + 1);
      expect(w.eco.get(r.id)!.founderId).toBe(r.id);
      expect(w.eco.get(r.id)!.hue).toBe(300);
      expect(w.eco.lineageSize(r.id)).toBe(1);
      expect(w.eco.lineageName(r.id)).toBe("Alpha");
      await w.step(1);
      w.eco.insertCreature(spec(config, { name: "Beta", x: 700, y: 650, species: 0, birth: { energy: 90, cost: 70, cooldown: 4 } }));
      await w.step(250);
      prints.push(w.eco.fingerprint());
      expect(w.eco.topLineages(200).some((l) => l.founder === r.id) || w.eco.lineageSize(r.id) === 0).toBe(true);
      w.pool?.close();
    }
    expect(prints[1]).toBe(prints[0]);
  });

  it("rejects bad input and changes nothing", async () => {
    const config = cfg(false);
    const w = await world(structuredClone(config), 0);
    const before = saveState(w.eco);
    const planned = (plan: BodyPlan): Partial<InsertSpec> => ({ plan, genome: randomGenome(layerSizes(config, plan), createRng(3)) }); // genome fits, only the plan is too big
    const bad: [string, Partial<InsertSpec>][] = [
      ["genome length", { genome: new Float32Array(3) }],
      ["nan genome", { genome: new Float32Array(spec(config).genome.length).fill(NaN) }],
      ["nan x", { x: NaN }],
      ["outside", { y: -5 }],
      ["too many rays", { plan: { ...PLAN, rayCount: 65 } }],
      ["more rays than a creature file allows", planned({ ...PLAN, rayCount: 17 })],
      ["more memory than a creature file allows", planned({ ...PLAN, memoryShort: 9 })],
      ["more neurons than a creature file allows", planned({ ...PLAN, hiddenLayers: [33] })],
      ["no hidden layer", { plan: { ...PLAN, hiddenLayers: [] } }],
      ["fractional neurons", { plan: { ...PLAN, hiddenLayers: [2.5] } }],
      ["bad species", { species: 3 }],
      ["zero energy", { energy: 0 }],
      ["long name", { name: "x".repeat(25) }],
      ["control character in name", { name: "a\nb" }],
      ["infinite hue", { hue: Infinity }],
      ["negative birth cost", { birth: { cost: -1 } }],
    ];
    for (const [what, over] of bad) {
      const r = w.eco.insertCreature(spec(config, over));
      expect(r.ok, what).toBe(false);
    }
    expect(json(saveState(w.eco))).toEqual(json(before));
  });

  it("rejects an insert into a full world", async () => {
    const config = cfg(false);
    config.eco.maxPopulation = 60;
    const w = await world(config, 0);
    const r = w.eco.insertCreature(spec(config));
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("full") });
  });
});

describe("retune", () => {
  it("rejects unsafe or invalid changes without applying any", () => {
    const eco = new Ecosystem(cfg(false));
    const before = JSON.stringify(eco.config);
    for (const patch of [
      { eco: { wasm: false } }, { eco: { initialPopulation: 5 } }, { creature: { livingCost: 1 } }, { eco: { foodRegrow: -1 } },
      { eco: { foodRegrow: 0.1, seasons: 1 } }, { eco: { birthEnergyRange: [9, 3] } }, { eco: { foodMaxDensity: 50 } }, { eco: { maxPopulation: 1.5 } },
    ]) {
      expect(eco.retune(patch as never).ok, JSON.stringify(patch)).toBe(false);
    }
    expect(JSON.stringify(eco.config)).toBe(before);
    expect(Object.keys(LIVE_FIELDS.eco)).toContain("foodRegrow");
  });

  it("applies live changes the same with 0 and 3 helper threads, and changes the run", async () => {
    const config = cfg(false);
    const prints: number[] = [];
    for (const threads of [0, 3, -1]) {
      const w = await world(structuredClone(config), Math.max(0, threads));
      await w.step(100);
      if (threads >= 0) {
        const r = w.eco.retune({ eco: { foodRegrow: 0.02, poisonRegrow: 0, birthEnergyRange: [60, 90], aging: false, collisionDamage: false, hueDrift: 20 }, mutation: { std: 0.3 } });
        expect(r.ok).toBe(true);
      }
      await w.step(200);
      prints.push(w.eco.fingerprint());
      if (threads >= 0) {
        expect(w.eco.config.eco.foodRegrow).toBe(0.02);
        // A saved retuned world restores with the new settings.
        expect(restoreState(json(saveState(w.eco))).config.eco.aging).toBe(false);
      }
      w.pool?.close();
    }
    expect(prints[1]).toBe(prints[0]);
    expect(prints[2]).not.toBe(prints[0]); // the unchanged run differs
  });
});

describe("restoreState validation", () => {
  const good = (): EcoState => {
    const eco = new Ecosystem(cfg(false));
    for (let t = 0; t < 30; t++) eco.step();
    eco.insertCreature(spec(cfg(false)));
    return json(saveState(eco));
  };
  const b64 = (a: ArrayBufferView): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
  const edit = (text: string, Kind: { new (b: ArrayBuffer): Int32Array | Float64Array }, f: (a: Int32Array | Float64Array) => void): string => {
    const raw = Buffer.from(text, "base64");
    const a = new Kind(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
    f(a);
    return b64(a);
  };

  it("restores an untouched state", () => {
    const state = good();
    expect(state.lineages.late.length).toBe(1);
    expect(() => restoreState(state)).not.toThrow();
  });

  const cases: [string, RegExp, (s: EcoState) => void][] = [
    ["a cycle in the item lists", /loop|share/, (s) => { s.items.nextItem = edit(s.items.nextItem, Int32Array, (a) => { const raw = Buffer.from(s.items.cellHead, "base64");
      const head = new Int32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)).find((h) => h >= 0)!; a[head] = head; }); }],
    ["a NaN position", /not finite/, (s) => { s.creatures.scalars = edit(s.creatures.scalars, Float64Array, (a) => { a[15] = NaN; }); }],
    ["a bad species", /species/, (s) => { s.creatures.scalars = edit(s.creatures.scalars, Float64Array, (a) => { a[7] = 5; }); }],
    ["a duplicate id", /twice/, (s) => { s.creatures.scalars = edit(s.creatures.scalars, Float64Array, (a) => { a[25] = a[0]!; }); }],
    ["a missing lineage", /lineage/, (s) => { s.lineages.late = []; }],
    ["more rays than the kernels take", /rayCount/, (s) => { s.creatures.plans[0]![0] = 65; }],
    ["a zero ray length", /ray length/, (s) => { s.creatures.plans[0]![2] = 0; }],
    ["a ghost lineage", /lineage/, (s) => { s.lineages.live[s.lineages.founders - 1] = 3; }],
    ["a next id at or below an id", /id/, (s) => { s.core.nextId = 3; }],
    ["a huge item capacity", /itemCapacity/, (s) => { s.core.itemCapacity = 1e12; }],
    ["a truncated column", /wrong size/, (s) => { s.creatures.genomes = s.creatures.genomes.slice(0, -8); }],
    ["a huge due", /foodDue/, (s) => { s.core.foodDue = 1e20; }],
    ["an unknown config key", /unknown config key/, (s) => { (s.config.eco as unknown as Record<string, number>).bogus = 1; }],
    ["a non-finite config value", /not a finite/, (s) => { s.config.world.width = Infinity; }],
    ["a position outside the walls", /outside the walls/, (s) => { s.creatures.scalars = edit(s.creatures.scalars, Float64Array, (a) => { a[15] = 1e12; }); }],
    ["a negative position", /outside the walls/, (s) => { s.creatures.scalars = edit(s.creatures.scalars, Float64Array, (a) => { a[16] = -1; }); }],
    ["a huge velocity", /faster/, (s) => { s.creatures.scalars = edit(s.creatures.scalars, Float64Array, (a) => { a[18] = 1e308; }); }],
    ["a heading that is not a unit vector", /unit vector/, (s) => { s.creatures.scalars = edit(s.creatures.scalars, Float64Array, (a) => { a[23] = 1e308; a[24] = 1e308; }); }],
    ["a late lineage with an object for a name", /late lineage name/, (s) => { (s.lineages.late[0] as unknown[])[5] = { evil: 1 }; }],
    ["a late lineage with a long name", /late lineage name/, (s) => { s.lineages.late[0]![5] = "x".repeat(25); }],
    ["a late lineage name with a control character", /late lineage name/, (s) => { s.lineages.late[0]![5] = "a\u001b[2Jb"; }],
    ["a late lineage with a text hue", /hue/, (s) => { (s.lineages.late[0] as unknown[])[2] = "x"; }],
    ["a late lineage row of the wrong length", /malformed/, (s) => { (s.lineages.late as unknown[]).push([1]); }],
    ["a lineage hue that is text", /hue/, (s) => { (s.lineages.hue as unknown[])[0] = "x"; }],
  ];
  for (const [what, message, corrupt] of cases) {
    it(`rejects ${what}`, () => {
      const state = good();
      corrupt(state);
      expect(() => restoreState(state)).toThrow(message);
    });
  }
});

describe("regrowth with huge rates", () => {
  it("retune rejects regrowth above the bound", () => {
    const eco = new Ecosystem(cfg(false));
    expect(eco.retune({ eco: { foodRegrow: 1e6 } }).ok).toBe(false);
    expect(eco.retune({ eco: { birthEnergyRange: [0, 90] } }).ok).toBe(false);
    expect(eco.retune({ eco: { maxPopulation: 1e6, birthSpeed: 1e9, damagePerSpeed: 50 } }).ok).toBe(false);
  });

  it("a huge amount due finishes at once", () => {
    const eco = new Ecosystem(cfg(false));
    const state = json(saveState(eco));
    state.core.foodDue = 9e5;
    state.core.poisonDue = 9e5;
    const restored = restoreState(state);
    const t0 = performance.now();
    for (let t = 0; t < 5; t++) restored.step();
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("an unbounded rate set straight on the config still finishes", () => {
    const eco = new Ecosystem(cfg(false));
    eco.config.eco.foodRegrow = 1e20;
    (eco as unknown as { foodPerTick: number }).foodPerTick = 1e20;
    const t0 = performance.now();
    eco.step();
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
