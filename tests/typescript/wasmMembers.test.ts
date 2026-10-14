import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { ECO_PRESETS, withEcoPreset } from "../../src/typescript/src/sim/presets.ts";
import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { dropSpareKernels, randomLearner, runEpisode } from "../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { forceJsMembers } from "../../src/typescript/src/sim/wasm/membersKernel.ts";
import { wasmAvailable } from "../../src/typescript/src/sim/wasm/loader.ts";
import { F } from "../../src/typescript/src/sim/wasm/resident.ts";

// The WebAssembly settle and birth scans (members.wat, membersKernel.ts) against the loops in Ecosystem.sharedPhase they replace.

type Any = any; // the tests reach into the Ecosystem

const make = (setup: (c: EcoConfig) => EcoConfig, founders: number, seed = 1, base: EcoConfig = DEFAULT_ECO_CONFIG): Ecosystem => {
  const config = setup(structuredClone(base));
  config.seed = seed;
  config.eco.initialPopulation = founders;
  return new Ecosystem(config, null);
};
const inland = (c: EcoConfig): EcoConfig => withEcoPreset(c, "inland-sea", ECO_PRESETS);
const aging = (c: EcoConfig): EcoConfig => ({ ...c, eco: { ...c.eco, aging: true, agingStart: 2, agingRate: 30 } });
const damage = (c: EcoConfig): EcoConfig => ({ ...c, eco: { ...c.eco, collisions: true, collisionDamage: true, damagePerSpeed: 1 } });

describe.skipIf(!wasmAvailable())("the WebAssembly scans equal the loops", () => {
  const energies = [0, -0, -1, 1e-300, 0.5, 7, 1e9, Infinity, -Infinity, NaN];

  it("settle: the same ticks counted and the same members listed, on rows with every kind of energy", () => {
    const eco = make(inland, 200);
    const e = eco as Any;
    for (let t = 0; t < 3; t++) eco.step();
    const rng = createRng(5);
    for (let round = 0; round < 20; round++) {
      const n = eco.members.length;
      eco.members.forEach((m) => {
        m.creature.state.energy = energies[rng.int(energies.length)]!;
        m.creature.state.ticksAlive = rng.int(5);
      });
      const f = e.resident.f64;
      const wantTicks = eco.members.map((m) => m.creature.state.ticksAlive + (m.creature.state.energy > 0 ? 1 : 0));
      const wantList: number[] = [];
      for (let i = n - 1; i >= 0; i--) if (!(f[e.rowAt[i] + F.energy] > 0)) wantList.push(i);
      const got = Array.from(e.wasmMembers.settle(e.rowAt, n));
      expect(got).toEqual(wantList);
      expect(eco.members.map((m) => m.creature.state.ticksAlive)).toEqual(wantTicks);
    }
  });

  it("birth candidates: the same members in the same order from any start, with energies at, below and above the threshold and NaN", () => {
    const eco = make((c) => c, 150);
    const e = eco as Any;
    for (let t = 0; t < 3; t++) eco.step();
    const rng = createRng(9);
    for (let round = 0; round < 30; round++) {
      const n = eco.members.length;
      const thresholds = eco.members.map(() => [10, 100, 1e6][rng.int(3)]!);
      eco.members.forEach((m, i) => {
        m.creature.state.energy = [thresholds[i]! - 1e-9, thresholds[i]!, thresholds[i]! + 1e-9, NaN, 0, Infinity][rng.int(6)]!;
      });
      const first = rng.int(n);
      const f = e.resident.f64;
      const want: number[] = [];
      for (let k = 0; k < n; k++) {
        const at = (first + k) % n;
        if (!(f[e.rowAt[at] + F.energy] < thresholds[at]!)) want.push(at);
      }
      expect(Array.from(e.wasmMembers.birthCandidates(e.rowAt, n, thresholds, first))).toEqual(want);
    }
  });

  it("with no members and with one", () => {
    const one = make((c) => c, 1);
    const e = one as Any;
    expect(Array.from(e.wasmMembers.birthCandidates(e.rowAt, 1, [0], 0))).toEqual([0]);
    expect(Array.from(e.wasmMembers.birthCandidates(e.rowAt, 0, [], 0))).toEqual([]);
    expect(Array.from(e.wasmMembers.settle(e.rowAt, 0))).toEqual([]);
  });
});

describe.skipIf(!wasmAvailable())("whole runs with the WebAssembly scans and with the JS loops", () => {
  afterEach(() => forceJsMembers(false));
  type Mid = (eco: Ecosystem, t: number) => void;
  const run = (build: () => Ecosystem, ticks: number, js: boolean, mid?: Mid): [number, number, number, number] => {
    forceJsMembers(js);
    const eco = build();
    for (let t = 0; t < ticks && !eco.extinct; t++) {
      mid?.(eco, t);
      eco.step();
    }
    forceJsMembers(false);
    return [eco.fingerprint(), eco.population, eco.deaths, eco.births];
  };
  // Feeds some creatures past their birth threshold and starves others, so births, deaths and swap-removals happen throughout.
  const churn: Mid = (eco, t) => {
    eco.members.forEach((m, i) => {
      if (i % 7 === t % 7) m.creature.state.energy = 1e4;
      if (i % 11 === t % 11) m.creature.state.energy = 0;
    });
  };
  const cases: [string, () => Ecosystem][] = [
    ["plain", () => make((c) => c, 200)],
    ["Inland Sea", () => make(inland, 600)],
    ["ageing and damage", () => make((c) => damage(aging(c)), 300)],
    ["predators", () => new Ecosystem(structuredClone(DEFAULT_PREDATOR_CONFIG), null)],
    ["a full world (the birth cap stops births)", () => make((c) => ({ ...c, eco: { ...c.eco, maxPopulation: 120, birthReserve: 5 } }), 100)],
  ];
  for (const [name, build] of cases) {
    it(`give the same world on ${name}, with births and deaths forced`, () => {
      const wasm = run(build, 150, false, churn);
      expect(wasm[3]).toBeGreaterThan(0);
      expect(wasm[2]).toBeGreaterThan(0);
      expect(wasm).toEqual(run(build, 150, true, churn));
    });
  }

  it("give the same world with creatures inserted and a retune on the way", () => {
    const go: Mid = (eco, t) => {
      churn(eco, t);
      if (t === 30) {
        const plan = eco.members[0]!.creature.plan;
        expect(eco.insertCreature({ genome: eco.members[0]!.creature.brain.genome.slice(), plan: { ...plan }, x: 500, y: 500, hue: 3, name: "v" }).ok).toBe(true);
      }
      if (t === 60) expect(eco.retune({ eco: { birthReserve: 10, aging: true, agingStart: 1, agingRate: 2 } })).toMatchObject({ ok: true });
    };
    expect(run(() => make(inland, 300), 120, false, go)).toEqual(run(() => make(inland, 300), 120, true, go));
  });

  it("save in one mode and continue in the other, both ways", () => {
    const build = () => make((c) => damage(aging(inland(c))), 300);
    for (const [first, second] of [[false, true], [true, false]] as const) {
      forceJsMembers(first);
      const a = build();
      for (let t = 0; t < 50; t++) {
        churn(a, t);
        a.step();
      }
      const state = JSON.parse(JSON.stringify(saveState(a))) as EcoState;
      forceJsMembers(second);
      const b = restoreState(state);
      forceJsMembers(first);
      for (let t = 50; t < 100; t++) {
        churn(a, t);
        a.step();
      }
      forceJsMembers(second);
      for (let t = 50; t < 100; t++) {
        churn(b, t);
        b.step();
      }
      forceJsMembers(false);
      expect([b.fingerprint(), b.population, b.deaths, b.births]).toEqual([a.fingerprint(), a.population, a.deaths, a.births]);
    }
  });

  it("give the same RL episodes, on reused kernels", () => {
    const env = envById("islands")!;
    const l = randomLearner(env, 3);
    dropSpareKernels();
    forceJsMembers(true);
    const js = runEpisode(env, l, 11);
    forceJsMembers(false);
    runEpisode(envById("crowd")!, l, 5);
    expect(runEpisode(env, l, 11)).toEqual(js);
  });
});
