import "../../src/typescript/src/sim/maps/index.ts"; // the Inland Sea cases build the map
import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Crowd, SMALL_SORT as SMALL } from "../../src/typescript/src/sim/crowd.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { ECO_PRESETS, withEcoPreset } from "../../src/typescript/src/sim/presets.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { energySignal } from "../../src/typescript/src/sim/sensors.ts";
import { wasmAvailable } from "../../src/typescript/src/sim/wasm/loader.ts";
import { F, Region } from "../../src/typescript/src/sim/wasm/resident.ts";
import { prepareRows } from "../../src/typescript/src/sim/wasm/residentStep.ts";
import { useKernels } from "./helpers.ts";

// The WebAssembly crowd grid (crowd.wat, crowdKernel.ts) against its JS twin Crowd.rebuild (crowd.ts): every array must be the same bit for bit,
// on rows anywhere (outside the world, NaN, infinite), and whole runs must not tell the two apart.

type Any = any; // the tests reach into the Ecosystem

const make = (setup: (c: EcoConfig) => EcoConfig, founders: number, seed = 1, base: EcoConfig = DEFAULT_ECO_CONFIG): Ecosystem => {
  const config = setup(structuredClone(base));
  config.seed = seed;
  config.eco.initialPopulation = founders;
  return new Ecosystem(config, null);
};
const inland = (c: EcoConfig): EcoConfig => withEcoPreset(c, "inland-sea", ECO_PRESETS);
const damage = (c: EcoConfig): EcoConfig => ({ ...c, eco: { ...c.eco, collisions: true, collisionDamage: true, damagePerSpeed: 1 } });

// Differences between the crowd as built (by the kernel) and a fresh JS Crowd built from the same rows.
function crowdDifferences(eco: Ecosystem): number {
  const e = eco as Any;
  const n = eco.members.length;
  const got: Crowd = e.crowd;
  const want = new Crowd(eco.config, 64);
  want.rebuild(e.table.states, n, e.multi ? e.table.kinds : undefined);
  let bad = 0;
  const same = (a: ArrayLike<number>, b: ArrayLike<number>, len: number): void => {
    for (let i = 0; i < len; i++) if (!Object.is(a[i], b[i])) bad++;
  };
  if (got.count !== want.count || got.occupiedCount !== want.occupiedCount) bad++;
  same(got.xs, want.xs, n);
  same(got.ys, want.ys, n);
  same(got.energies, want.energies, n);
  same(got.species, want.species, n);
  same(got.owners, want.owners, n);
  same(got.occupied, want.occupied, want.occupiedCount);
  if (got.cellStart.length !== want.cellStart.length) bad++;
  same(got.cellStart, want.cellStart, want.cellStart.length);
  return bad;
}

// Rows anywhere, so that every clamp of the cell key is taken.
// Returns the way back to the true positions and energies, so the run goes on with sane bodies.
function scatter(eco: Ecosystem, seed: number): () => void {
  const rng = createRng(seed);
  const saved = eco.members.map((m) => [m.creature.state.x, m.creature.state.y, m.creature.state.energy]);
  const { width, height } = eco.config.world;
  const pick = <T,>(v: T[]): T => v[rng.int(v.length)]!;
  for (const m of eco.members) {
    const s = m.creature.state;
    const r = rng.next();
    if (r < 0.1) s.x = pick([-1e6, -1, 0, width, width + 1, 1e9, Infinity, -Infinity, NaN]);
    else if (r < 0.2) s.y = pick([-1e6, -1, 0, height, height + 1, 1e9, Infinity, -Infinity, NaN]);
    else if (r < 0.5) {
      s.x = rng.next() * width;
      s.y = rng.next() * height;
    }
    if (rng.next() < 0.1) s.energy = pick([0, 1e-9, 1e9, -3]);
  }
  return () => eco.members.forEach((m, i) => ([m.creature.state.x, m.creature.state.y, m.creature.state.energy] = saved[i]! as [number, number, number]));
}

describe.skipIf(!wasmAvailable())("the WebAssembly crowd grid equals Crowd.rebuild", () => {
  const worlds: [string, () => Ecosystem][] = [
    ["a plain world", () => make((c) => c, 300)],
    ["the Inland Sea", () => make(inland, 1500)],
    ["two species", () => new Ecosystem(structuredClone(DEFAULT_PREDATOR_CONFIG), null)],
    ["13 creatures, just past the insertion sort", () => make((c) => c, 13)],
    ["12 creatures, JS only", () => make((c) => c, 12)],
    ["2 creatures", () => make((c) => c, 2)],
    ["1000 creatures in a tiny world (few cells)", () => make((c) => ({ ...c, world: { ...c.world, width: 300, height: 200 } }), 1000)],
  ];
  for (const [name, build] of worlds) {
    it(`on ${name}, array for array, with rows scattered anywhere`, () => {
      const eco = build();
      const e = eco as Any;
      expect(e.wasmCrowd).not.toBeNull();
      let bad = 0;
      for (let t = 0; t < 30; t++) {
        eco.step();
        if (eco.members.length < 2) break;
        const back = t % 2 === 0 ? scatter(eco, 50 + t) : () => {};
        e.gridCrowd(eco.members.length, e.multi ? e.table.kinds : undefined);
        bad += crowdDifferences(eco);
        back();
      }
      expect(bad).toBe(0);
    });
  }

  it("on randomised worlds of every size and species mix", () => {
    let bad = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const rng = createRng(seed * 31);
      const eco = make((c) => {
        (c.world as Any).width = 400 + rng.int(9000);
        (c.world as Any).height = 300 + rng.int(6000);
        (c.creature as Any).rayLength = rng.range(40, 400);
        return c;
      }, [3, 13, 14, 40, 300, 900][rng.int(6)]!, seed, seed % 2 ? DEFAULT_PREDATOR_CONFIG : DEFAULT_ECO_CONFIG);
      const e = eco as Any;
      for (let t = 0; t < 8 && eco.members.length > 0; t++) {
        eco.step();
        const back = t % 2 === 0 ? scatter(eco, seed * 10 + t) : () => {};
        e.gridCrowd(eco.members.length, e.multi ? e.table.kinds : undefined);
        bad += crowdDifferences(eco);
        back();
      }
    }
    expect(bad).toBe(0);
  });

  it("in the f32 columns the sense kernel reads (positions and energy signals)", () => {
    const eco = make(inland, 400);
    const e = eco as Any;
    for (let t = 0; t < 5; t++) eco.step();
    eco.prepareTick();
    const crowd: Crowd = e.crowd;
    expect(crowd.kernel).not.toBeNull();
    const start = 50;
    const store = e.resident;
    const [sx, sy, sig] = [new Region(), new Region(), new Region()].map((r) => store.grow(r, crowd.count * 4 + 16));
    crowd.kernel!.pack(start, sx!, sy!, sig!);
    const f32 = e.kernels.f32;
    let bad = 0;
    for (let k = 0; k < crowd.count; k++) {
      if (!Object.is(f32[(sx! >> 2) + k], Math.fround(crowd.xs[k]!))) bad++;
      if (!Object.is(f32[(sy! >> 2) + k], Math.fround(crowd.ys[k]!))) bad++;
      if (!Object.is(f32[(sig! >> 2) + k], Math.fround(energySignal(crowd.energies[k]!, start)))) bad++;
    }
    expect(bad).toBe(0);
  });

  it("with toRows, in each creature's row as its first brain input extra, which prepareRows then leaves", () => {
    const eco = make(inland, 400);
    const e = eco as Any;
    for (let t = 0; t < 5; t++) eco.step();
    eco.prepareTick();
    const crowd: Crowd = e.crowd;
    const store = e.resident;
    const [sx, sy, sig] = [new Region(), new Region(), new Region()].map((r) => store.grow(r, crowd.count * 4 + 16));
    crowd.kernel!.pack(300, sx!, sy!, sig!, true);
    const { rows, n } = eco.senseBatchRows();
    const first = (k: number) => store.f64[(rows[k]! >> 3) + F.extras] as number;
    let bad = 0;
    for (let k = 0; k < crowd.count; k++) {
      const row = e.table.rowAt[crowd.owners[k]!]!;
      if (!Object.is(store.f64[row + F.extras], Math.fround(energySignal(crowd.energies[k]!, 300)))) bad++;
    }
    const kept = Array.from({ length: n }, (_, k) => first(k));
    prepareRows(store, rows, n, e.items.terrain, true);
    for (let k = 0; k < n; k++) if (!Object.is(first(k), kept[k])) bad++;
    expect(bad).toBe(0);
  });

  it("after the memory grows, which replaces every view of it", () => {
    const eco = make(inland, 300);
    const e = eco as Any;
    for (let t = 0; t < 4; t++) eco.step();
    eco.prepareTick();
    expect(crowdDifferences(eco)).toBe(0);
    e.kernels.brains.alloc(40 * 1024 * 1024);
    expect(e.crowd.xs.buffer).toBe(e.kernels.brains.memory.buffer); // still views, not detached
    expect(crowdDifferences(eco)).toBe(0);
    for (let t = 0; t < 5; t++) {
      eco.step();
      e.kernels.brains.alloc(16 * 1024 * 1024);
      expect(crowdDifferences(eco)).toBe(0);
    }
  });

  it("when the tick start reuses the grid of the shared phase, through births, deaths, eating, hunting and bumps", () => {
    const worlds: [string, () => Ecosystem][] = [
      ["bumps with damage", () => make((c) => damage({ ...c, world: { ...c.world, width: 1500, height: 1000 }, eco: { ...c.eco, birthEnergyRange: [60, 80], birthCostRange: [20, 30], birthCooldownRange: [1, 2] } }), 300)],
      ["hunting", () => new Ecosystem(structuredClone(DEFAULT_PREDATOR_CONFIG), null)],
    ];
    for (const [name, build] of worlds) {
      const eco = build();
      const e = eco as Any;
      let reused = 0;
      let rebuilt = 0;
      let bad = 0;
      const refresh = e.wasmCrowd.refresh.bind(e.wasmCrowd);
      e.wasmCrowd.refresh = (...a: unknown[]): boolean => {
        const ok = refresh(...a);
        if (ok) reused++;
        return ok;
      };
      const rebuild = e.wasmCrowd.rebuild.bind(e.wasmCrowd);
      e.wasmCrowd.rebuild = (...a: unknown[]): void => {
        rebuilt++;
        rebuild(...a);
      };
      const births = eco.births;
      for (let t = 0; t < 300 && eco.members.length > SMALL; t++) {
        eco.step();
        // what the next tick start sees, after edits between ticks: energies only, or a move into another cell
        if (t % 7 === 3) eco.members[t % eco.members.length]!.creature.state.energy *= 0.5;
        if (t % 11 === 5) eco.members[t % eco.members.length]!.creature.state.x += 2 * e.crowd.cell;
        eco.prepareTick();
        bad += crowdDifferences(eco);
      }
      expect(bad, name).toBe(0);
      expect(reused, name).toBeGreaterThan(20);
      expect(rebuilt - 300, name).toBeGreaterThan(20); // the shared phase rebuilds every tick, the tick start after births, deaths and cell changes
      expect(eco.births - births, name).toBeGreaterThan(0);
    }
  });

  it("when the world shrinks to JS-only sizes and grows again", () => {
    const eco = make((c) => ({ ...c, eco: { ...c.eco, foodRegrow: 0 } }), 40);
    const e = eco as Any;
    let bad = 0;
    for (let t = 0; t < 40; t++) {
      while (eco.members.length > 40 - t) (eco as Any).remove(eco.members.length - 1); // ends in the 1-12 range, then none
      if (eco.members.length >= 2) {
        e.gridCrowd(eco.members.length, undefined);
        bad += crowdDifferences(eco);
      }
    }
    expect(bad).toBe(0);
  });
});

// The item each creature touches, looked up by the kernel over the packed item rows (crowd.wat touch), against World.touchedBatch on the same crowd.
describe.skipIf(!wasmAvailable())("the WebAssembly item lookup equals World.touchedBatch", () => {
  const lookups = (eco: Ecosystem): [Int32Array, Int32Array, boolean] => {
    const e = eco as Any;
    const n = eco.members.length;
    const tables = e.kernels.itemTables(e.items);
    const crowd: Crowd = e.crowd;
    const want = new Int32Array(n).fill(-7);
    e.items.touchedBatch(crowd.xs, crowd.ys, crowd.owners, n, eco.config.creature.radius, want);
    const got = new Int32Array(n).fill(-7);
    if (tables) crowd.kernel!.touch(tables, e.items.rows, 1 / e.items.cell, eco.config.creature.radius + e.items.itemRadius, got);
    return [got, want, tables !== null];
  };
  const compare = (eco: Ecosystem): number => {
    const [got, want, fresh] = lookups(eco);
    expect(fresh).toBe(true);
    let bad = 0;
    want.forEach((v, i) => { if (got[i] !== v) bad++; });
    return bad;
  };

  it("on worlds of every size and density, with creatures anywhere", () => {
    let bad = 0;
    let hits = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const rng = createRng(seed * 977);
      const eco = make((c) => {
        (c.world as Any).width = 500 + rng.int(5000);
        (c.world as Any).height = 400 + rng.int(3000);
        (c.world as Any).foodDensity = rng.range(0.05, 2);
        (c.world as Any).poisonDensity = rng.range(0, 0.3);
        (c.creature as Any).radius = rng.range(3, 20);
        return c;
      }, [14, 60, 400][rng.int(3)]!, seed, seed % 2 ? DEFAULT_PREDATOR_CONFIG : DEFAULT_ECO_CONFIG);
      const e = eco as Any;
      for (let t = 0; t < 6 && eco.members.length > 13; t++) {
        eco.prepareTick();
        eco.sensePhase(); // brings the packed item rows up to date
        const back = scatter(eco, seed * 7 + t);
        e.gridCrowd(eco.members.length, e.multi ? e.table.kinds : undefined);
        bad += compare(eco);
        hits += lookups(eco)[1].filter((v) => v >= 0).length;
        back();
        e.finishTick();
      }
    }
    expect(bad).toBe(0);
    expect(hits).toBeGreaterThan(50); // the worlds had creatures touching items, not only misses
  });

  it("only while the packed rows match the items", () => {
    const eco = make(inland, 300);
    const e = eco as Any;
    for (let t = 0; t < 3; t++) eco.step();
    eco.prepareTick();
    eco.sensePhase();
    expect(e.kernels.itemTables(e.items)).not.toBeNull();
    const item = e.items.kinds.findIndex((k: number) => k !== 0);
    e.items.removeItem(item);
    expect(e.kernels.itemTables(e.items)).toBeNull(); // changed since the sync: the JS lookup is used
    eco.prepareTick();
    eco.sensePhase();
    expect(e.kernels.itemTables(e.items)).not.toBeNull();
  });
});

// The collision sweep's pairs: the kernel finds them (crowd.wat sweep) in the order of the loops of Contacts.collideAll. The pairs are compared with no bump in
// between, so the arrays stay as they are; the whole-run tests below cover the bumps.
describe.skipIf(!wasmAvailable())("the WebAssembly collision sweep finds the pairs of the JS sweep, in order", () => {
  function jsPairs(crowd: Crowd, reach2: number): [number, number][] {
    const { cols, rows, cellStart, xs, ys } = crowd;
    const pairs: [number, number][] = [];
    for (let o = 0; o < crowd.occupiedCount; o++) {
      const c = crowd.occupied[o]!;
      const cy = Math.floor(c / cols);
      const cx = c - cy * cols;
      const end = cellStart[c + 1]!;
      const hasRight = cx + 1 < cols;
      const run1 = hasRight ? cellStart[c + 2]! : end;
      let run2a = 0;
      let run2b = 0;
      if (cy + 1 < rows) {
        const below = c + cols;
        run2a = cellStart[cx > 0 ? below - 1 : below]!;
        run2b = cellStart[hasRight ? below + 2 : below + 1]!;
      }
      for (let s = cellStart[c]!; s < end; s++) {
        for (let t = s + 1; t < run1; t++) if (!((xs[t]! - xs[s]!) ** 2 + (ys[t]! - ys[s]!) ** 2 >= reach2)) pairs.push([s, t]);
        for (let t = run2a; t < run2b; t++) if (!((xs[t]! - xs[s]!) ** 2 + (ys[t]! - ys[s]!) ** 2 >= reach2)) pairs.push([s, t]);
      }
    }
    return pairs;
  }

  it("on crowded worlds of every shape, with creatures anywhere", () => {
    let found = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const rng = createRng(seed * 131);
      const eco = make((c) => {
        (c.world as Any).width = 300 + rng.int(3000);
        (c.world as Any).height = 200 + rng.int(2000);
        (c.creature as Any).radius = rng.range(3, 25);
        (c.creature as Any).rayLength = rng.range(30, 300);
        return c;
      }, [14, 80, 500][rng.int(3)]!, seed, seed % 2 ? DEFAULT_PREDATOR_CONFIG : DEFAULT_ECO_CONFIG);
      const e = eco as Any;
      const back = scatter(eco, seed);
      e.gridCrowd(eco.members.length, e.multi ? e.table.kinds : undefined);
      const crowd: Crowd = e.crowd;
      const reach2 = (2 * eco.config.creature.radius) ** 2;
      const want = jsPairs(crowd, reach2);
      const kernel = crowd.kernel!;
      const got: [number, number][] = [];
      kernel.sweepStart(reach2);
      while (kernel.sweepNext()) got.push([kernel.hitS, kernel.hitT]);
      expect(got).toEqual(want);
      found += want.length;
      back();
    }
    expect(found).toBeGreaterThan(200);
  });
});

describe.skipIf(!wasmAvailable())("the WebAssembly kernels at their edges", () => {
  it("switching between the WebAssembly and the JS crowd while the memory grows", () => {
    const eco = make(inland, 300);
    const e = eco as Any;
    for (let t = 0; t < 4; t++) eco.step();
    for (const grow of [true, false]) {
      e.gridCrowd(eco.members.length, undefined); // by the kernel
      expect(e.crowd.kernel).not.toBeNull();
      useKernels(eco, { crowd: false });
      e.gridCrowd(eco.members.length, undefined); // by JS: the arrays are the crowd's own again
      if (grow) e.kernels.brains.alloc(40 * 1024 * 1024); // replaces every view of the memory
      expect(e.crowd.kernel).toBeNull(); // and does not make the kernel's old grid the crowd again
      expect(crowdDifferences(eco)).toBe(0);
      expect(e.crowd.cellStart.length).toBe(e.crowd.cols * e.crowd.rows + 1);
      useKernels(eco, { crowd: true });
      eco.step();
      expect(crowdDifferences(eco)).toBe(0);
    }
  });

  it("the crowd's views are kept across rebuilds until a region moves or the memory grows", () => {
    const eco = make(inland, 300);
    const e = eco as Any;
    const xs = e.crowd.xs;
    e.gridCrowd(eco.members.length - 40, undefined); // fewer creatures, the same regions
    expect(e.crowd.xs).toBe(xs);
    expect(e.crowd.count).toBe(eco.members.length - 40);
    e.gridCrowd(eco.members.length, undefined);
    expect(e.crowd.xs).toBe(xs);
    e.kernels.brains.alloc(40 * 1024 * 1024); // replaces every view of the memory
    expect(e.crowd.xs === xs).toBe(false);
    expect(crowdDifferences(eco)).toBe(0);
  });

  it("a JS rebuild on the Crowd itself drops the kernel's grid and takes the set-aside arrays back", () => {
    const eco = make(inland, 300);
    const e = eco as Any;
    const crowd: Crowd = e.crowd;
    expect(crowd.kernel).not.toBeNull();
    const own = (crowd as Any).kept.xs;
    const n = eco.members.length;
    const x = Float64Array.from(eco.members, (m) => m.creature.state.x);
    const y = Float64Array.from(eco.members, (m) => m.creature.state.y);
    crowd.rebuildFrom(x, y, new Float64Array(n), n);
    expect(crowd.kernel).toBeNull();
    expect(e.wasmCrowd.n).toBe(0); // so a memory growth does not put the old grid back
    expect(crowd.xs).toBe(own);
    e.kernels.brains.alloc(40 * 1024 * 1024);
    expect(crowd.xs).toBe(own);
  });

  it("the sense kernel on creatures at extreme positions, in both crowd modes, with and without rock", () => {
    for (const js of [false, true]) {
      for (const build of [() => make((c) => c, 100), () => make(inland, 200)]) {
        const eco = build();
        useKernels(eco, { crowd: !js });
        for (let t = 0; t < 2; t++) eco.step();
        eco.members.forEach((m, i) => {
          const s = m.creature.state;
          if (i % 6 === 0) s.x = 1e9;
          if (i % 6 === 1) s.x = -1e9;
          if (i % 6 === 2) s.y = 1e9;
          if (i % 6 === 3) s.y = -1e9;
          if (i % 6 === 4) s.x = s.y = -1e18;
        });
        eco.prepareTick();
        expect(() => eco.sensePhase()).not.toThrow();
      }
    }
  });

  it("an item exactly at reach is not touched, one just inside is", () => {
    const eco = make((c) => ({ ...c, world: { ...c.world, foodDensity: 0.3 } }), 40);
    const e = eco as Any;
    for (let t = 0; t < 2; t++) eco.step();
    eco.prepareTick();
    eco.sensePhase(); // the packed item rows match the items
    const items = e.items;
    // an item with no other within 6 units, and a body 3 and 4 units from it (so exactly 5, with every value exact)
    let item = -1;
    for (let i = 0; i < items.count && item < 0; i++) {
      if (items.kinds[i] === 0) continue;
      let alone = true;
      for (let j = 0; j < items.count && alone; j++) if (j !== i && items.kinds[j] !== 0 && Math.hypot(items.xs[j] - items.xs[i], items.ys[j] - items.ys[i]) < 8) alone = false;
      if (alone) item = i;
    }
    expect(item).toBeGreaterThanOrEqual(0);
    const bodyX = items.xs[item] + 3;
    const bodyY = items.ys[item] + 4;
    const back = scatter(eco, 3);
    eco.members.forEach((m, i) => {
      m.creature.state.x = i === 0 ? bodyX : 50 + 150 * i;
      m.creature.state.y = i === 0 ? bodyY : 50;
    });
    e.gridCrowd(eco.members.length, undefined);
    const crowd: Crowd = e.crowd;
    const tables = e.kernels.itemTables(items);
    expect(tables).not.toBeNull();
    const out = new Int32Array(eco.members.length);
    crowd.kernel!.touch(tables, items.rows, 1 / items.cell, 5, out);
    expect(out[0]).toBe(-1);
    crowd.kernel!.touch(tables, items.rows, 1 / items.cell, 5.000001, out);
    expect(out[0]).toBe(item);
    back();
  });

  it("a pair exactly the contact distance apart is not a pair, one just inside is", () => {
    const eco = make((c) => c, 20);
    const e = eco as Any;
    eco.members.forEach((m, i) => {
      m.creature.state.x = i === 1 ? 103 : 100 + 200 * i;
      m.creature.state.y = i === 1 ? 104 : 100;
    });
    e.gridCrowd(eco.members.length, undefined);
    const kernel = (e.crowd as Crowd).kernel!;
    const pairs = (reach2: number): number => {
      let n = 0;
      kernel.sweepStart(reach2);
      while (kernel.sweepNext()) n++;
      return n;
    };
    expect(pairs(25)).toBe(0); // 3 and 4 apart is exactly 5
    expect(pairs(25.000001)).toBe(1);
  });
});

describe.skipIf(!wasmAvailable())("whole runs with the WebAssembly crowd grid and with the JS one", () => {
  const run = (build: () => Ecosystem, ticks: number, js: boolean, midRun?: (eco: Ecosystem, t: number) => void): [number, number, number] => {
    const eco = build();
    useKernels(eco, { crowd: !js });
    for (let t = 0; t < ticks && !eco.extinct; t++) {
      midRun?.(eco, t);
      eco.step();
    }
    return [eco.fingerprint(), eco.population, eco.deaths];
  };
  const cases: [string, () => Ecosystem][] = [
    ["plain", () => make((c) => c, 200)],
    ["Inland Sea", () => make(inland, 800)],
    ["collisions and damage", () => make((c) => damage(c), 400)],
    ["a crowded small world with damage (many bumps)", () => make((c) => damage({ ...c, world: { ...c.world, width: 700, height: 500, foodDensity: 1 } }), 350)],
    ["predators (hunting uses the grid)", () => new Ecosystem(structuredClone(DEFAULT_PREDATOR_CONFIG), null)],
  ];
  for (const [name, build] of cases) {
    it(`give the same world on ${name}`, () => {
      expect(run(build, 300, false)).toEqual(run(build, 300, true));
    });
  }

  it("give the same world with creatures inserted and a retune on the way", () => {
    const go = (eco: Ecosystem, t: number): void => {
      if (t === 40) {
        const plan = eco.members[0]!.creature.plan;
        expect(eco.insertCreature({ genome: eco.members[0]!.creature.brain.genome.slice(), plan: { ...plan }, x: 500, y: 500, hue: 3, name: "v" }).ok).toBe(true);
      }
      if (t === 80) expect(eco.retune({ eco: { collisions: true, collisionDamage: true, damagePerSpeed: 0.5 } })).toMatchObject({ ok: true });
    };
    expect(run(() => make(inland, 500), 200, false, go)).toEqual(run(() => make(inland, 500), 200, true, go));
  });

  it("save in one mode and continue in the other, both ways", () => {
    const build = () => make((c) => damage(inland(c)), 500);
    for (const [first, second] of [[false, true], [true, false]] as const) {
      const a = build();
      useKernels(a, { crowd: !first });
      for (let t = 0; t < 60; t++) a.step();
      const state = JSON.parse(JSON.stringify(saveState(a))) as EcoState;
      const b = restoreState(state);
      useKernels(b, { crowd: !second });
      for (let t = 0; t < 60; t++) a.step();
      for (let t = 0; t < 60; t++) b.step();
      expect([b.fingerprint(), b.population, b.deaths]).toEqual([a.fingerprint(), a.population, a.deaths]);
    }
  });
});
