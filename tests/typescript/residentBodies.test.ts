import "../../src/typescript/src/sim/maps/index.ts"; // the Inland Sea cases build the map
import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { GROUND_BLOCK_SHIFT, GROUND_PAD, GroundField } from "../../src/typescript/src/sim/groundField.ts";
import { ECO_PRESETS, withEcoPreset } from "../../src/typescript/src/sim/presets.ts";
import { wasmAvailable } from "../../src/typescript/src/sim/wasm/loader.ts";
import { F } from "../../src/typescript/src/sim/wasm/resident.ts";
import { Terrain } from "../../src/typescript/src/sim/terrain.ts";
import { prepareRows } from "./helpers.ts";

// Creature bodies resident in the WebAssembly memory (wasm/resident.ts): the row code (fill kernel, residentStep.ts) must equal the
// Creature code it replaces, bit for bit, on every tick.

type Any = any; // the tests reach into the Ecosystem's tick phases

const world = (setup: (c: EcoConfig) => EcoConfig, founders: number): Ecosystem => {
  const config = setup(structuredClone(DEFAULT_ECO_CONFIG));
  config.eco.initialPopulation = founders;
  return new Ecosystem(config, null);
};

const grab = (c: Any): number[] => {
  const s = c.state;
  return [s.x, s.y, s.vx, s.vy, s.heading, s.turnRate, s.energy, s.ticksAlive, c.heading.cos, c.heading.sin, ...c.memory];
};

// One tick, checked against the Creature code: the sense inputs the fill kernel wrote against Creature.writeBodyInputs, then the WebAssembly step
// against remember + steer on the same state (the ground factor is the one prepareRows wrote). Returns how many values differ.
function checkedTick(eco: Ecosystem): number {
  const e = eco as Any;
  eco.prepareTick();
  eco.sensePhase();
  const creatures = e.table.bySlot.map((m: Any) => m.creature);
  const kernels = e.kernels;
  const f32 = kernels.f32;
  const scratch = new Float32Array(256);
  let bad = 0;
  for (const c of creatures) {
    const at = kernels.brains.inputAt(c.kernelSlot) + c.plan.rayCount * kernels.stride;
    scratch.fill(0);
    c.writeBodyInputs(scratch, 0);
    for (let i = 0; i < 5 + c.memory.length; i++) if (!Object.is(scratch[i], f32[at + i])) bad++;
  }
  const before = creatures.map(grab);
  kernels.stepper.step(e.table.slotRows, creatures.length, e.aging, e.items.terrain);
  const outF32 = kernels.f32; // the step's first rock tables may grow the memory, which replaces f32
  const got = creatures.map(grab);
  creatures.forEach((c: Any, k: number) => {
    const s = c.state;
    const a = before[k]!;
    [s.x, s.y, s.vx, s.vy, s.heading, s.turnRate, s.energy, s.ticksAlive] = a;
    c.heading.cos = a[8];
    c.heading.sin = a[9];
    const u = c.memory as Float64Array;
    for (let i = 0; i < u.length; i++) u[i] = a[10 + i]!;
    const out = c.outputArray(outF32);
    c.remember(out);
    c.steer(out);
    const want = grab(c);
    for (let i = 0; i < want.length; i++) if (!Object.is(want[i], got[k]![i])) bad++;
  });
  e.sharedPhase();
  return bad;
}

describe.skipIf(!wasmAvailable())("resident bodies", () => {
  const worlds: [string, () => Ecosystem][] = [
    ["a plain world", () => world((c) => c, 300)],
    ["the Inland Sea (rock, mud and firm ground)", () => world((c) => withEcoPreset(c, "inland-sea", ECO_PRESETS), 1500)],
    ["old-age upkeep", () => world((c) => ({ ...c, eco: { ...c.eco, aging: true, agingStart: 2, agingRate: 30 } }), 300)],
    ["two species", () => new Ecosystem({ ...structuredClone(DEFAULT_PREDATOR_CONFIG) }, null)],
  ];
  for (const [name, make] of worlds) {
    it(`the fill kernel and the row step equal the Creature code on ${name}`, () => {
      const eco = make();
      expect((eco as Any).resident).not.toBeNull();
      let bad = 0;
      for (let t = 0; t < 80 && !eco.extinct; t++) bad += checkedTick(eco);
      expect(bad).toBe(0);
    });
  }

  it("the fill kernel's prepare equals the oracle bit for bit, on ground, edges and outside the world", () => {
    const eco = world((c) => withEcoPreset(c, "inland-sea", ECO_PRESETS), 600);
    const e = eco as Any;
    const kernels = e.kernels;
    const store = kernels.store;
    const terrain = e.items.terrain;
    const n = eco.members.length;
    const rows = Int32Array.from({ length: n }, (_, k) => eco.members[k]!.creature.resident!.ptr);
    const w = e.world.width as number;
    const h = e.world.height as number;
    let seed = 12345;
    const rnd = (): number => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    let slow = 0;
    let fast = 0;
    for (let round = 0; round < 6; round++) {
      eco.members.forEach((m, k) => {
        const s = m.creature.state;
        s.x = k % 9 === 0 ? (rnd() - 0.5) * 2 * w : rnd() * w;
        s.y = k % 9 === 1 ? (rnd() - 0.5) * 2 * h : rnd() * h;
        s.vx = (rnd() - 0.5) * 20;
        s.vy = (rnd() - 0.5) * 20;
        s.turnRate = (rnd() - 0.5) * 0.3;
        s.energy = 1 + rnd() * 100;
      });
      const ex = (o: number): number[] => [0, 1, 2, 3, 4].map((i) => store.f64[o + F.extras + i]!).concat(store.f64[o + F.groundFactor]!);
      prepareRows(store, rows, n, terrain);
      const want = Array.from(rows, (r) => ex(r >> 3));
      const wanted = Array.from(rows, (r) => store.f64[(r >> 3) + F.groundFactor]!);
      for (const r of rows) {
        store.f64[(r >> 3) + F.groundFactor] = NaN;
        for (let i = 0; i <= 4; i++) store.f64[(r >> 3) + F.extras + i] = NaN;
      }
      kernels.filler.prepare(rows, n, terrain, true);
      const got = Array.from(rows, (r) => ex(r >> 3));
      for (let k = 0; k < n; k++) for (let i = 0; i < 6; i++) expect(Object.is(got[k]![i], want[k]![i])).toBe(true);
      for (const v of wanted) if (v < 1) slow++; else if (v > 1) fast++;
    }
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(0);
  });

  it("the fill kernel's prepare equals the oracle on hand-made fields: sizes off the block grid, sparse and weak corners, block edges, the map edge", () => {
    const eco = world((c) => c, 500);
    const e = eco as Any;
    const kernels = e.kernels;
    const store = kernels.store;
    const n = eco.members.length;
    const rows = Int32Array.from({ length: n }, (_, k) => eco.members[k]!.creature.resident!.ptr);
    let seed = 777;
    const rnd = (): number => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const sizes: [number, number][] = [[1000, 1000], [2600, 700], [450, 3100], [8 * 50 * 3, 8 * 50 * 2], [60_000, 40_000]];
    let seen = 0;
    for (const [w, h] of sizes) for (const density of [0.003, 0.05]) {
      const field = new GroundField(w, h);
      const d = field.data;
      for (let k = 0; k < d.length; k++) {
        const r = rnd();
        d[k] = r < density ? 255 : r < density * 2 ? 128 : r < 0.3 ? 127 : Math.floor(rnd() * 100); // 127 on all four corners must stay below one half
      }
      const terrain = new Terrain([], field, w, h);
      const block = field.cell << GROUND_BLOCK_SHIFT;
      eco.members.forEach((m, k) => {
        const s = m.creature.state;
        const edge = (v: number, extent: number): number => { // on, just before and just after a block edge or a node, or anywhere including outside
          const b = (Math.floor(rnd() * (extent / block + 2)) * block) - GROUND_PAD * field.cell;
          return k % 4 === 0 ? b + (rnd() - 0.5) * 1e-6 : k % 4 === 1 ? b + (rnd() - 0.5) * field.cell : v;
        };
        s.x = edge((rnd() * 1.4 - 0.2) * w, w);
        s.y = edge((rnd() * 1.4 - 0.2) * h, h);
        s.vx = (rnd() - 0.5) * 20;
        s.vy = (rnd() - 0.5) * 20;
        s.turnRate = (rnd() - 0.5) * 0.3;
      });
      const at = (r: number): number[] => [0, 1, 2, 3, 4].map((i) => store.f64[(r >> 3) + F.extras + i]!).concat(store.f64[(r >> 3) + F.groundFactor]!);
      prepareRows(store, rows, n, terrain);
      const want = Array.from(rows, at);
      for (const r of rows) {
        store.f64[(r >> 3) + F.groundFactor] = NaN;
        for (let i = 0; i <= 4; i++) store.f64[(r >> 3) + F.extras + i] = NaN;
      }
      kernels.filler.prepare(rows, n, terrain, true);
      const got = Array.from(rows, at);
      for (let k = 0; k < n; k++) for (let i = 0; i < 6; i++) expect(Object.is(got[k]![i], want[k]![i])).toBe(true);
      for (const v of want) if (v[4] !== 0) seen++;
    }
    expect(seen).toBeGreaterThan(100);
  });

  it("bodies survive the memory growing, and a long run stays equal to the JS", () => {
    const eco = world((c) => c, 200);
    const before = eco.members.map((m) => grab(m.creature));
    const bank = (eco as Any).kernels.brains;
    bank.alloc(40 * 1024 * 1024); // grows the memory and so replaces every view of it
    expect(eco.members.map((m) => grab(m.creature))).toEqual(before);
    let bad = 0;
    for (let t = 0; t < 40; t++) {
      bad += checkedTick(eco);
      if (t === 20) bank.alloc(20 * 1024 * 1024);
    }
    expect(bad).toBe(0);
  });

  it("helper-thread worlds have resident bodies too", () => {
    const eco = new Ecosystem(structuredClone(DEFAULT_ECO_CONFIG), null, { journal: true });
    expect(eco.members[0]!.creature.resident).not.toBeNull();
  });

  it("the member list, rows and sense batch stay in step through births and deaths", () => {
    const eco = world((c) => ({ ...c, eco: { ...c.eco, foodRegrow: 0.05 } }), 400);
    const e = eco as Any;
    for (let t = 0; t < 60; t++) {
      // feed some creatures past their birth threshold and starve others, so births and swap-removals happen throughout
      eco.members.forEach((m, i) => {
        if (i % 7 === t % 7) m.creature.state.energy = 1e4;
        if (i % 11 === t % 11) m.creature.state.energy = 0;
      });
      eco.step();
      if (t % 5 !== 0) continue;
      const n = eco.members.length;
      expect(e.table.length).toBe(n);
      expect(e.table.bySlot.length).toBe(n);
      for (let i = 0; i < n; i++) expect(e.table.rowAt[i]).toBe(eco.members[i]!.creature.resident!.o);
      for (let k = 0; k < n; k++) {
        const m = e.table.bySlot[k];
        expect(e.table.slotRows[k]).toBe(m.creature.resident.ptr);
        expect(e.table.slotSelves[k]).toBe(m.index);
      }
    }
    expect(eco.births).toBeGreaterThan(0);
    expect(eco.deaths).toBeGreaterThan(0);
  });

  it("plans with more memory units than a fixed row would hold run and save like any other", () => {
    const eco = world((c) => ({ ...c, brain: { ...c.brain, memory: 1 }, eco: { ...c.eco, memoryRange: [20, 24] } }), 40);
    expect((eco as Any).resident).not.toBeNull();
    expect(eco.members[0]!.creature.memory.length).toBeGreaterThan(16);
    let bad = 0;
    for (let t = 0; t < 20; t++) bad += checkedTick(eco);
    expect(bad).toBe(0);
  });
});
