import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { ECO_PRESETS, withEcoPreset } from "../../src/typescript/src/sim/presets.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { dropSpareKernels, randomLearner, runEpisode } from "../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { LAYOUT as L } from "../../src/typescript/src/sim/wasm/layout.ts";
import { wasmAvailable } from "../../src/typescript/src/sim/wasm/loader.ts";
import { stepRows } from "../../src/typescript/src/sim/wasm/residentStep.ts";
import { forceJsStep } from "../../src/typescript/src/sim/wasm/stepKernel.ts";

// The WebAssembly step (step.wat, stepKernel.ts) against its JS twin stepRows (residentStep.ts) on the same rows: every f64 of every row and every
// memory unit must be the same bit for bit (Object.is), tick after tick, in worlds of every kind, and whole runs and saves must not tell the two apart.

type Any = any; // the tests reach into the Ecosystem's tick phases

const ROW_F = L.ROW_BYTES / 8;

const make = (setup: (c: EcoConfig) => EcoConfig, founders: number, seed = 1): Ecosystem => {
  const config = setup(structuredClone(DEFAULT_ECO_CONFIG));
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
    const o = e.slotRows[k] >> 3;
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
    const o = e.slotRows[k] >> 3;
    store.f64.set(saved[2 * k]!, o);
    store.f64.set(saved[2 * k + 1]!, store.i32[(o << 1) + L.R_UNITS / 4] >> 3);
  }
}
const differences = (a: Float64Array[], b: Float64Array[]): number => {
  let bad = 0;
  a.forEach((x, i) => x.forEach((v, j) => { if (!Object.is(v, b[i]![j])) bad++; }));
  return bad;
};

// The step on the rows of the current batch, once by each implementation from the same start. Leaves the WebAssembly result in the rows.
function stepBoth(eco: Ecosystem): number {
  const e = eco as Any;
  const n = eco.members.length;
  const start = capture(e, n);
  e.resident.stepper.step(e.slotRows, n, e.aging, e.items.terrain);
  const wasm = capture(e, n);
  restore(e, n, start);
  stepRows(e.resident, e.kernels.f32, e.slotRows, n, e.aging, e.items.terrain);
  const js = capture(e, n);
  restore(e, n, wasm);
  return differences(wasm, js);
}

// A tick whose step is checked: sense and think, step by both, then the rest of the tick from the WebAssembly result.
function checkedTick(eco: Ecosystem): number {
  const e = eco as Any;
  eco.prepareTick();
  eco.sensePhase(0, eco.members.length);
  const bad = eco.members.length ? stepBoth(eco) : 0;
  e.batchAll = false;
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

describe.skipIf(!wasmAvailable())("the WebAssembly step equals stepRows", () => {
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
      expect((eco as Any).resident.stepper).not.toBeNull();
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
      }, [0, 1, 2, 7, 60, 200][rng.int(6)]!, seed);
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
    eco.prepareTick();
    eco.sensePhase(0, eco.members.length);
    eco.members.forEach((m, i) => {
      const s = m.creature.state;
      if (i % 5 === 0) s.heading = NaN;
      if (i % 5 === 1) s.x = NaN;
      if (i % 5 === 2) s.vy = Infinity;
      if (i % 5 === 3) s.energy = -Infinity;
    });
    expect(stepBoth(eco)).toBe(0);
    expect(e.resident.stepper).not.toBeNull();
  });

  it("when the memory grows between sensing and stepping", () => {
    const eco = make(inland, 300);
    const e = eco as Any;
    let bad = 0;
    for (let t = 0; t < 30; t++) {
      eco.prepareTick();
      eco.sensePhase(0, eco.members.length);
      if (t % 10 === 5) e.kernels.brains.alloc(30 * 1024 * 1024); // replaces every view of the memory
      bad += stepBoth(eco);
      e.batchAll = false;
      e.sharedPhase();
    }
    expect(bad).toBe(0);
  });
});

// Whole runs: the WebAssembly step and the JS step must not tell apart in anything the world reaches.
describe.skipIf(!wasmAvailable())("whole runs with the WebAssembly step and with the JS step", () => {
  afterEach(() => forceJsStep(false));
  const run = (build: () => Ecosystem, ticks: number, js: boolean, midRun?: (eco: Ecosystem, t: number) => void): [number, number, number] => {
    forceJsStep(js);
    const eco = build();
    for (let t = 0; t < ticks && !eco.extinct; t++) {
      midRun?.(eco, t);
      eco.step();
    }
    forceJsStep(false);
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
      forceJsStep(first);
      const a = build();
      for (let t = 0; t < 60; t++) a.step();
      const state = JSON.parse(JSON.stringify(saveState(a))) as EcoState;
      forceJsStep(second);
      const b = restoreState(state);
      forceJsStep(first);
      for (let t = 0; t < 60; t++) a.step();
      forceJsStep(second);
      for (let t = 0; t < 60; t++) b.step();
      forceJsStep(false);
      expect([b.fingerprint(), b.population, b.deaths]).toEqual([a.fingerprint(), a.population, a.deaths]);
    }
  });

  it("give the same RL episodes, on reused kernels", () => {
    const env = envById("islands")!;
    const l = randomLearner(env, 3);
    dropSpareKernels();
    forceJsStep(true);
    const js = runEpisode(env, l, 11);
    forceJsStep(false);
    runEpisode(envById("crowd")!, l, 5); // leaves another world's state in the shared kernel
    expect(runEpisode(env, l, 11)).toEqual(js);
  });
});
