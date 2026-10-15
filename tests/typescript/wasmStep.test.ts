import "../../src/typescript/src/sim/maps/index.ts"; // the Inland Sea cases build the map
import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { ECO_PRESETS, withEcoPreset } from "../../src/typescript/src/sim/presets.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { LAYOUT as L } from "../../src/typescript/src/sim/wasm/layout.ts";
import { wasmAvailable } from "../../src/typescript/src/sim/wasm/loader.ts";

// The WebAssembly step (step.wat, stepKernel.ts) against the Creature code it replaces (remember and steer, which run on resident rows like on any state) on the same rows:
// every f64 of every row and every memory unit must be the same bit for bit (Object.is), tick after tick, in worlds of every kind, and whole runs and saves must not tell the two apart.

type Any = any; // the tests reach into the Ecosystem's tick phases

const ROW_F = L.ROW_BYTES / 8;

const make = (setup: (c: EcoConfig) => EcoConfig, founders: number, seed = 1, base: EcoConfig = DEFAULT_ECO_CONFIG): Ecosystem => {
  const config = setup(structuredClone(base));
  config.seed = seed;
  config.eco.initialPopulation = founders;
  return new Ecosystem(config, null);
};
const inland = (c: EcoConfig): EcoConfig => withEcoPreset(c, "inland-sea", ECO_PRESETS);
const aging = (c: EcoConfig): EcoConfig => ({ ...c, eco: { ...c.eco, aging: true, agingStart: 2, agingRate: 30 } });
const damage = (c: EcoConfig): EcoConfig => ({ ...c, eco: { ...c.eco, collisions: true, collisionDamage: true, damagePerSpeed: 1 } });

// Every f64 of the batch's rows, then their memory units.
function capture(e: Any, n: number): Float64Array[] {
  const store = e.resident;
  const out: Float64Array[] = [];
  for (let k = 0; k < n; k++) {
    const o = e.table.slotRows[k] >> 3;
    out.push(store.f64.slice(o, o + ROW_F));
    const b = (o << 1) + L.R_UNITS / 4;
    const at = store.i32[b] >> 3;
    out.push(store.f64.slice(at, at + store.i32[(o << 1) + L.R_UNIT_COUNT / 4]));
  }
  return out;
}
function restore(e: Any, n: number, saved: Float64Array[]): void {
  const store = e.resident;
  for (let k = 0; k < n; k++) {
    const o = e.table.slotRows[k] >> 3;
    store.f64.set(saved[2 * k]!, o);
    store.f64.set(saved[2 * k + 1]!, store.i32[(o << 1) + L.R_UNITS / 4] >> 3);
  }
}
const differences = (a: Float64Array[], b: Float64Array[]): number => {
  let bad = 0;
  a.forEach((x, i) => x.forEach((v, j) => { if (!Object.is(v, b[i]![j])) bad++; }));
  return bad;
};

// The Creature code's memory and motion for every member.
function stepCreatures(eco: Ecosystem): void {
  for (const m of (eco as Any).table.bySlot) {
    m.creature.remember();
    m.creature.steer();
  }
}

// The step on the rows of the current batch, once by each implementation from the same start. Leaves the WebAssembly result in the rows.
function stepBoth(eco: Ecosystem): number {
  const e = eco as Any;
  const n = eco.members.length;
  const start = capture(e, n);
  e.kernels.stepper.step(e.table.slotRows, n, e.aging, e.items.terrain);
  const wasm = capture(e, n);
  restore(e, n, start);
  stepCreatures(eco);
  const js = capture(e, n);
  restore(e, n, wasm);
  return differences(wasm, js);
}

// A tick whose step is checked: sense and think, step by both, then the rest of the tick from the WebAssembly result.
function checkedTick(eco: Ecosystem): number {
  const e = eco as Any;
  eco.prepareTick();
  eco.sensePhase();
  const bad = eco.members.length ? stepBoth(eco) : 0;
  e.sharedPhase();
  return bad;
}

// Throws some creatures into the cases the formulas branch on: walls, rock edges, extreme speeds, energies and headings.
function perturb(eco: Ecosystem, seed: number): void {
  const rng = createRng(seed);
  const { width, height } = eco.config.world;
  const t = (eco as Any).items.terrain;
  const r = eco.config.creature.radius;
  const pick = <T,>(v: T[]): T => v[rng.int(v.length)]!;
  for (const m of eco.members) {
    if (rng.next() > 0.25) continue;
    const s = m.creature.state;
    switch (rng.int(7)) {
      case 0: s.x = pick([0, r, width - r, width]); s.vx = pick([-300, 300, 0]); break;
      case 1: s.y = pick([0, r, height - r, height]); s.vy = pick([-300, 300, 0]); break;
      case 2: [s.vx, s.vy] = [pick([0, 1e3, -1e3, 1e5, -1e-9]), pick([0, 1e3, -1e3, 1e5])]; break;
      case 3: s.energy = pick([0, 1e-9, 1e6, 0.5]); break;
      case 4: s.heading = pick([0, 1e5, -1e5, Math.PI, 123456.789]); s.turnRate = pick([0, 50, -50]); break;
      case 5: s.ticksAlive = pick([0, 1e3, 1e6]); break;
      default:
        if (t.rockCount > 0) {
          const i = rng.int(t.rockCount);
          const a = rng.next() * 2 * Math.PI;
          const reach = t.rockR[i] + r + pick([-3, -0.5, 0, 0.5, 3]); // just inside, on and just outside the contact distance
          s.x = Math.min(width - r, Math.max(r, t.rockX[i] + Math.cos(a) * reach));
          s.y = Math.min(height - r, Math.max(r, t.rockY[i] + Math.sin(a) * reach));
          s.vx = pick([-200, 0, 200]);
          s.vy = pick([-200, 0, 200]);
        }
    }
  }
}

describe.skipIf(!wasmAvailable())("the WebAssembly step equals the Creature code", () => {
  const worlds: [string, () => Ecosystem][] = [
    ["a plain world", () => make((c) => c, 300)],
    ["the Inland Sea (rock, mud and firm ground)", () => make(inland, 1200)],
    ["old-age upkeep", () => make(aging, 300)],
    ["collision damage", () => make(damage, 400)],
    ["collision damage and ageing on the Inland Sea", () => make((c) => damage(aging(inland(c))), 800)],
    ["two species with different bodies", () => new Ecosystem(structuredClone(DEFAULT_PREDATOR_CONFIG), null)],
    ["a single creature", () => make((c) => c, 1)],
  ];
  for (const [name, build] of worlds) {
    it(`on ${name}, field for field over 120 ticks with perturbed creatures`, () => {
      const eco = build();
      expect((eco as Any).kernels).not.toBeNull();
      let bad = 0;
      for (let t = 0; t < 120 && !eco.extinct; t++) {
        if (t % 3 === 0) perturb(eco, 1000 + t);
        bad += checkedTick(eco);
      }
      expect(bad).toBe(0);
    });
  }

  it("on randomised worlds of every size, density, map and speed", () => {
    let bad = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const rng = createRng(seed * 7919);
      const eco = make((c) => {
        const w = c.world as Any;
        w.width = 800 + rng.int(6000);
        w.height = 600 + rng.int(4000);
        for (const k of ["stoneDensity", "ridgeDensity", "slowDensity", "fastDensity"]) w[k] = rng.next() < 0.4 ? 0 : rng.range(0, 0.15);
        (c.creature as Any).radius = rng.range(3, 14);
        (c.creature as Any).wallBounce = rng.next();
        if (rng.next() < 0.5) c = aging(c);
        if (rng.next() < 0.5) c = damage(c);
        return c;
      }, [0, 1, 2, 7, 60, 200][rng.int(6)]!, seed, seed % 3 === 0 ? DEFAULT_PREDATOR_CONFIG : DEFAULT_ECO_CONFIG); // every third world has several species with bodies of their own
      for (let t = 0; t < 40 && !eco.extinct; t++) {
        if (t % 2 === 0) perturb(eco, seed * 100 + t);
        bad += checkedTick(eco);
      }
    }
    expect(bad).toBe(0);
  });

  it("on rows with NaN and infinite fields, as on any other", () => {
    const eco = make(inland, 300);
    const e = eco as Any;
    for (let t = 0; t < 5; t++) eco.step();
    eco.members.forEach((m, i) => {
      const s = m.creature.state;
      if (i % 5 === 0) s.heading = NaN;
      if (i % 5 === 1) s.x = NaN;
      if (i % 5 === 2) s.vy = Infinity;
      if (i % 5 === 3) s.energy = -Infinity;
    });
    eco.prepareTick(); // the ground factor of a row is the one read when the body was sensed, as the Creature code reads it where the body stands
    eco.sensePhase();
    expect(stepBoth(eco)).toBe(0);
    expect(e.kernels).not.toBeNull();
  });

  // The f32 brain outputs of the row at batch position k, as an index into the f32 view.
  const outAt = (e: Any, k: number): number => e.resident.i32[((e.table.slotRows[k] >> 3) << 1) + L.R_OUT / 4] >> 2;

  it("on a creature exactly on a rock centre, which must leave along +x", () => {
    const eco = make(inland, 300);
    const e = eco as Any;
    for (let t = 0; t < 3; t++) eco.step();
    const rock = e.items.terrain;
    for (let k = 0; k < 12; k++) {
      const c = e.table.bySlot[k].creature;
      c.state.x = rock.rockX[k * 3];
      c.state.y = rock.rockY[k * 3];
      c.state.vx = c.state.vy = 0;
    }
    eco.prepareTick();
    eco.sensePhase();
    const f32 = e.kernels.f32;
    for (let k = 0; k < 12; k++) {
      f32[outAt(e, k)] = 0; // no turn
      f32[outAt(e, k) + 1] = -1; // brake from rest: the body stays where it is
    }
    expect(stepBoth(eco)).toBe(0);
    expect(e.table.bySlot[0].creature.state.x).not.toBe(rock.rockX[0]); // and was pushed out
  });

  it("on NaN rows in a world with rock in the first grid cell, where the NaN distance reaches a disc", () => {
    let eco: Ecosystem | null = null;
    for (let seed = 1; seed <= 80 && !eco; seed++) {
      const tried = make((c) => ({ ...c, world: { ...c.world, width: 1500, height: 1500, stoneDensity: 0.1, ridgeDensity: 0.05 } }), 40, seed);
      if ((tried as Any).items.terrain.rockStart[1] > 0) eco = tried;
    }
    expect(eco).not.toBeNull();
    const e = eco as Any;
    eco!.members.forEach((m, i) => {
      if (i % 3 === 0) m.creature.state.x = NaN;
      if (i % 3 === 1) m.creature.state.y = NaN;
    });
    eco!.prepareTick();
    eco!.sensePhase();
    expect(stepBoth(eco!)).toBe(0);
    expect(e.table.bySlot.some((m: Any) => Number.isFinite(m.creature.state.x))).toBe(true); // JS and WebAssembly both leave along +x from a disc, so some come out finite
  });

  it("on NaN, negative zero and infinite brain outputs", () => {
    for (const build of [() => make((c) => c, 100), () => make(inland, 100)]) {
      const eco = build();
      const e = eco as Any;
      for (let t = 0; t < 3; t++) eco.step();
      eco.prepareTick();
      eco.sensePhase();
      const f32 = e.kernels.f32;
      const turns = [NaN, -0, 0, 1, -1, Infinity];
      const thrusts = [NaN, -0, Infinity, -Infinity, 0.5, -0.5, 1e-30];
      eco.members.forEach((_, k) => {
        f32[outAt(e, k)] = turns[k % turns.length]!;
        f32[outAt(e, k) + 1] = thrusts[k % thrusts.length]!;
        if (k % 4 === 0) f32[outAt(e, k) + 2] = NaN; // a memory target
      });
      expect(stepBoth(eco)).toBe(0);
    }
  });

  it("when the memory grows between sensing and stepping", () => {
    const eco = make(inland, 300);
    const e = eco as Any;
    let bad = 0;
    for (let t = 0; t < 30; t++) {
      eco.prepareTick();
      eco.sensePhase();
      if (t % 10 === 5) e.kernels.brains.alloc(30 * 1024 * 1024); // replaces every view of the memory
      bad += stepBoth(eco);
      e.sharedPhase();
    }
    expect(bad).toBe(0);
  });
});

// Whole runs: the WebAssembly step and the Creature code's step must not tell apart in anything the world reaches.
describe.skipIf(!wasmAvailable())("whole runs with the WebAssembly step and with the Creature code's step", () => {
  const tick = (eco: Ecosystem, js: boolean): void => {
    if (!js) return eco.step();
    if (eco.extinct) return;
    eco.prepareTick();
    eco.sensePhase();
    stepCreatures(eco);
    (eco as Any).sharedPhase();
  };
  const run = (build: () => Ecosystem, ticks: number, js: boolean, midRun?: (eco: Ecosystem, t: number) => void): [number, number, number] => {
    const eco = build();
    for (let t = 0; t < ticks && !eco.extinct; t++) {
      midRun?.(eco, t);
      tick(eco, js);
    }
    return [eco.fingerprint(), eco.population, eco.deaths];
  };
  const cases: [string, () => Ecosystem][] = [
    ["plain", () => make((c) => c, 200)],
    ["Inland Sea", () => make(inland, 800)],
    ["ageing and damage on the Inland Sea", () => make((c) => damage(aging(inland(c))), 600)],
    ["predators", () => new Ecosystem(structuredClone(DEFAULT_PREDATOR_CONFIG), null)],
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
        const genome = eco.members[0]!.creature.brain.genome.slice();
        expect(eco.insertCreature({ genome, plan: { ...plan }, x: 500, y: 500, hue: 3, name: "v" }).ok).toBe(true);
      }
      if (t === 80) expect(eco.retune({ eco: { aging: true, agingStart: 1, agingRate: 2, collisions: true, collisionDamage: true, damagePerSpeed: 0.5 } })).toMatchObject({ ok: true });
    };
    expect(run(() => make(inland, 500), 200, false, go)).toEqual(run(() => make(inland, 500), 200, true, go));
  });

  it("save in one mode and continue in the other, both ways", () => {
    const build = () => make((c) => damage(aging(inland(c))), 500);
    for (const [first, second] of [[false, true], [true, false]] as const) {
      const a = build();
      for (let t = 0; t < 60; t++) tick(a, first);
      const state = JSON.parse(JSON.stringify(saveState(a))) as EcoState;
      const b = restoreState(state);
      for (let t = 0; t < 60; t++) tick(a, first);
      for (let t = 0; t < 60; t++) tick(b, second);
      expect([b.fingerprint(), b.population, b.deaths]).toEqual([a.fingerprint(), a.population, a.deaths]);
    }
  });
});
