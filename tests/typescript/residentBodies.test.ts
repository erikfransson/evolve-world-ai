import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { ECO_PRESETS, withEcoPreset } from "../../src/typescript/src/sim/presets.ts";
import { wasmAvailable } from "../../src/typescript/src/sim/wasm/loader.ts";
import { stepRows } from "../../src/typescript/src/sim/wasm/residentStep.ts";

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

// One tick, checked against the Creature code: the sense inputs the fill kernel wrote against Creature.writeBodyInputs, then the row step
// against remember + steer on the same state (the ground factor is the one prepareRows wrote). Returns how many values differ.
function checkedTick(eco: Ecosystem): number {
  const e = eco as Any;
  eco.prepareTick();
  eco.sensePhase(0, eco.members.length);
  const creatures = e.bySlot.map((m: Any) => m.creature);
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
  stepRows(e.resident, f32, e.slotRows, creatures.length, e.aging, e.items.terrain);
  const got = creatures.map(grab);
  creatures.forEach((c: Any, k: number) => {
    const s = c.state;
    const a = before[k]!;
    [s.x, s.y, s.vx, s.vy, s.heading, s.turnRate, s.energy, s.ticksAlive] = a;
    c.heading.cos = a[8];
    c.heading.sin = a[9];
    const u = c.memory as Float64Array;
    for (let i = 0; i < u.length; i++) u[i] = a[10 + i]!;
    const out = c.outputArray(f32);
    c.remember(out);
    c.steer(out);
    const want = grab(c);
    for (let i = 0; i < want.length; i++) if (!Object.is(want[i], got[k]![i])) bad++;
  });
  e.batchAll = false;
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

  it("helper-thread worlds keep plain bodies", () => {
    const eco = new Ecosystem(structuredClone(DEFAULT_ECO_CONFIG), null, { journal: true });
    expect(eco.members[0]!.creature.resident).toBeNull();
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
      expect(e.rowAt.length).toBe(n);
      expect(e.bySlot.length).toBe(n);
      for (let i = 0; i < n; i++) expect(e.rowAt[i]).toBe(eco.members[i]!.creature.resident!.o);
      for (let k = 0; k < n; k++) {
        const m = e.bySlot[k];
        expect(e.slotRows[k]).toBe(m.creature.resident.ptr);
        expect(e.slotSelves[k]).toBe(m.index);
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
