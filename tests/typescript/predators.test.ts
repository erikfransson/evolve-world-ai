import { Brain, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { Crowd } from "../../src/typescript/src/sim/crowd.ts";
import { DEFAULT_ECO_CONFIG, DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { trialsSizes, trialsToEcoGenome } from "../../src/typescript/src/sim/seedPool.ts";
import type { PoolEntry } from "../../src/typescript/src/sim/seedPool.ts";
import { FEAT_CREATURE, RAY_FEATURES, encodeInputs, energySignal, inputLayout, rayFeatureCount } from "../../src/typescript/src/sim/sensors.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";
import { ONE_SPECIES, bandHue, founderCounts, resolveSpecies, speciesEngine, speciesList } from "../../src/typescript/src/sim/species.ts";
import { HIT_CREATURE, HIT_NONE } from "../../src/typescript/src/sim/types.ts";
import type { CreatureState, RayHit } from "../../src/typescript/src/sim/types.ts";
import { layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { testRng } from "./helpers.ts";

// A small The Great Hunt world; prey and predators founders, everything else from the defaults.
function predCfg(prey: number, predators: number, seed = 3, over: Partial<EcoConfig["eco"]> = {}): EcoConfig {
  const d = structuredClone(DEFAULT_PREDATOR_CONFIG);
  d.species![0]!.founders = prey;
  d.species![1]!.founders = predators;
  return { ...d, seed, world: { ...d.world, width: 1200, height: 900 }, eco: { ...d.eco, ...over } };
}

// No items and no collisions, so only the hunting changes energies besides the creatures' own costs.
const bare = (prey: number, predators: number): EcoConfig => {
  const c = predCfg(prey, predators, 1, { foodRegrow: 0, poisonRegrow: 0, collisions: false });
  c.species![1]!.birthEnergyRange = [1e9, 1e9]; // no births, which would change the counts
  return { ...c, world: { ...c.world, foodDensity: 0, poisonDensity: 0 } };
};

const place = (eco: Ecosystem, i: number, x: number, y: number, energy?: number): CreatureState => {
  const s = eco.members[i]!.creature.state;
  s.x = x;
  s.y = y;
  if (energy !== undefined) s.energy = energy;
  return s;
};

describe("The Great Hunt", () => {
  it("a one-species list computes exactly as the Ecosystem without one", () => {
    const d = structuredClone(DEFAULT_ECO_CONFIG);
    const base: EcoConfig = { ...d, seed: 4, world: { ...d.world, width: 1000, height: 1000 }, creature: { ...d.creature, startEnergy: 140 }, eco: { ...d.eco, initialPopulation: 60, birthEnergyRange: [80, 80], birthCostRange: [75, 75], birthCooldownRange: [10, 10] } };
    const run = (c: EcoConfig) => {
      const eco = new Ecosystem(c);
      for (let t = 0; t < 300; t++) eco.step();
      return [eco.fingerprint(), eco.births, eco.deaths];
    };
    const a = run(base);
    expect(a[1]).toBeGreaterThan(0);
    expect(run({ ...base, species: [ONE_SPECIES] })).toEqual(a);
    // Overrides equal to the shared settings change nothing either.
    const same = { ...ONE_SPECIES, founders: 60, birthEnergyRange: [80, 80], birthCostRange: [75, 75], birthCooldownRange: [10, 10], startEnergy: 140, speed: 1, rayLengthRange: [...base.eco.rayLengthRange] };
    expect(run({ ...base, species: [same] })).toEqual(a);
  });

  it("keeps the plain Ecosystem run fixed (pinned fingerprint)", () => {
    const d = structuredClone(DEFAULT_ECO_CONFIG);
    const c: EcoConfig = { ...d, seed: 4, world: { ...d.world, width: 1000, height: 1000 }, creature: { ...d.creature, startEnergy: 140 }, eco: { ...d.eco, initialPopulation: 60, birthEnergyRange: [80, 80], birthCostRange: [75, 75], birthCooldownRange: [10, 10], structuralRate: 0.2, collisionDamage: true, wasm: false } };
    const eco = new Ecosystem(c);
    for (let t = 0; t < 300; t++) eco.step();
    expect([eco.fingerprint(), eco.births, eco.deaths]).toEqual([558194966, 66, 19]); // re-pinned for item spacing from poison; was 764941132, 66, 20
  });

  it("shares the population limit among the species' founders in proportion", () => {
    const list = speciesList(DEFAULT_PREDATOR_CONFIG); // 400 prey, 40 predators
    expect(founderCounts(list, 10000)).toEqual([400, 40]);
    expect(founderCounts(list, 400)).toEqual([364, 36]);
    expect(founderCounts(list, 11)).toEqual([10, 1]);
    expect(founderCounts(speciesList(DEFAULT_ECO_CONFIG), 300)).toEqual([300]);
    const c = predCfg(400, 40);
    const eco = new Ecosystem({ ...c, eco: { ...c.eco, maxPopulation: 400 } });
    expect(eco.speciesCounts.map((k) => k.population)).toEqual([364, 36]);
  });

  it("children keep their parent's species and stay in the species' colour band", () => {
    const eco = new Ecosystem(predCfg(80, 20, 2, { birthEnergyRange: [70, 70], birthCostRange: [35, 35] })); // prey breed readily
    const founderSpecies = new Map(eco.lineages.top(eco.founders).map((l) => [l.founder, l.species]));
    for (let t = 0; t < 900; t++) eco.step();
    const counts = eco.speciesCounts;
    expect(counts[0]!.births).toBeGreaterThan(0);
    expect(counts[1]!.births).toBeGreaterThan(0);
    let children = 0;
    for (const m of eco.members) {
      expect(m.species).toBe(founderSpecies.get(m.founderId));
      const sp = eco.species[m.species]!;
      expect(Math.abs(((m.hue - sp.hue + 540) % 360) - 180)).toBeLessThanOrEqual(sp.hueSpread / 2 + 1e-9);
      if (m.parentId >= 0) children++;
    }
    expect(children).toBeGreaterThan(0);
    expect(counts[0]!.population + counts[1]!.population).toBe(eco.population);
    expect(counts.reduce((n, c) => n + c.births, 0)).toBe(eco.births);
    expect(counts.reduce((n, c) => n + c.deaths, 0)).toBe(eco.deaths);
  });

  it("bandHue reflects at the band edges and wraps around 0", () => {
    const sp = { ...DEFAULT_PREDATOR_CONFIG.species![1]!, hue: 4, hueSpread: 30 };
    expect(bandHue(sp, 10)).toBeCloseTo(10);
    expect(bandHue(sp, 24)).toBeCloseTo(14); // 5 past the edge at 19
    expect(bandHue(sp, 350)).toBeCloseTo(350);
    expect(bandHue(sp, 340)).toBeCloseTo(358); // 9 past the edge at 349
    expect(bandHue(ONE_SPECIES, 370)).toBeCloseTo(10);
  });

  it("a hunter gains the prey's energy times the efficiency plus the baseline", () => {
    // The same tick with and without hunting: the hunter's energy differs by exactly the gain from the prey's energy.
    const setUp = (hunts: boolean) => {
      const c = bare(1, 1);
      if (!hunts) c.species![1]!.prey = [];
      const eco = new Ecosystem(c);
      place(eco, 0, 500, 500, 37);
      place(eco, 1, 512, 500, 90);
      eco.step();
      return eco;
    };
    const hunted = setUp(true);
    const twin = setUp(false);
    const sp = hunted.species[1]!;
    const preyEnergy = twin.members[0]!.creature.state.energy;
    const hunterBefore = twin.members[1]!.creature.state.energy;
    expect(hunted.population).toBe(1);
    expect(hunted.members[0]!.species).toBe(1);
    expect(hunted.members[0]!.kills).toBe(1);
    expect(hunted.members[0]!.creature.state.energy).toBeCloseTo(hunterBefore + sp.eatEfficiency * preyEnergy + sp.eatBaseline, 9);
    expect(hunted.deaths).toBe(1);
    expect(hunted.speciesCounts.map((c) => [c.population, c.deaths, c.eaten])).toEqual([[0, 1, 1], [1, 0, 0]]);
  });

  it("a prey touched by two hunters is eaten once, and a hunter eats one prey per tick", () => {
    const eco = new Ecosystem(bare(2, 2));
    place(eco, 0, 500, 500, 40); // touched by both hunters
    place(eco, 1, 800, 500, 40); // out of reach
    place(eco, 2, 485, 500, 90);
    place(eco, 3, 515, 500, 90);
    const before = new Map(eco.members.map((m) => [m.id, m.creature.state.energy]));
    eco.step();
    expect(eco.deaths).toBe(1);
    expect(eco.speciesCounts[0]!.eaten).toBe(1);
    const hunters = eco.members.filter((m) => m.species === 1);
    expect(hunters.map((m) => m.kills).sort()).toEqual([0, 1]);
    for (const m of hunters) expect(m.creature.state.energy - before.get(m.id)! > 30).toBe(m.kills === 1); // only the eater got the meal
    expect(eco.members.some((m) => m.species === 0 && m.creature.state.x > 700)).toBe(true);

    // One hunter between two prey eats only one of them this tick.
    const one = new Ecosystem(bare(2, 1));
    place(one, 0, 490, 500, 40);
    place(one, 1, 510, 500, 40);
    place(one, 2, 500, 500, 90);
    one.step();
    expect(one.speciesCounts.map((c) => c.population)).toEqual([1, 1]);
    one.step();
    expect(one.speciesCounts.map((c) => c.population)).toEqual([0, 1]);
    expect(one.members[0]!.kills).toBe(2);
  });

  it("a hunter between two prey at the same distance eats the one with the lower id", () => {
    const c = bare(2, 1);
    const eco = new Ecosystem({ ...c, creature: { ...c.creature, maxThrust: 1e-300 } }); // moves below a rounding step, so distances stay exact
    // Across a grid row boundary (cells of 100), so the grid meets the higher id first.
    place(eco, 0, 500, 612, 40);
    place(eco, 1, 500, 588, 40);
    place(eco, 2, 500, 600, 90);
    eco.step();
    expect(eco.members.filter((m) => m.species === 0).map((m) => m.id)).toEqual([1]); // id 0 was eaten
  });

  it("plant-free hunters pass over food", () => {
    const c = predCfg(0, 30, 6, { foodRegrow: 0, poisonRegrow: 0 });
    const eco = new Ecosystem({ ...c, world: { ...c.world, foodDensity: 3, poisonDensity: 0 } });
    const food = eco.food;
    for (let t = 0; t < 120; t++) eco.step();
    expect(eco.food).toBe(food);
  });
});

describe("Species ray features", () => {
  const two = predCfg(1, 1);

  it("the input layout has one flag per species, then the seen energy", () => {
    expect(rayFeatureCount(two)).toBe(RAY_FEATURES + 3);
    expect(inputLayout(two).rayFeatureLabels).toEqual(["closeness", "food", "poison", "wall", "Prey", "Predator", "seen energy"]);
    expect(rayFeatureCount(DEFAULT_ECO_CONFIG)).toBe(RAY_FEATURES + 2);
  });

  it("the crowd reports the seen creature's species and energy, and encodeInputs sets that species' flag", () => {
    const crowd = new Crowd(two);
    const states: CreatureState[] = [
      { x: 100, y: 100, heading: 0, vx: 0, vy: 0, turnRate: 0, energy: 50, alive: true, ticksAlive: 0 },
      { x: 160, y: 100, heading: 0, vx: 0, vy: 0, turnRate: 0, energy: 77, alive: true, ticksAlive: 0 },
      { x: 100, y: 160, heading: 0, vx: 0, vy: 0, turnRate: 0, energy: 33, alive: true, ticksAlive: 0 },
    ];
    crowd.rebuild(states, 3, [0, 1, 0]);
    const rays: RayHit[] = [0, 1].map(() => ({ closeness: 0, kind: HIT_NONE, energy: 0, species: 0 }));
    crowd.castRays(100, 100, Float64Array.of(1, 0), Float64Array.of(0, 1), rays, 0, 100);
    expect(rays.map((r) => [r.kind, r.species, r.energy])).toEqual([[HIT_CREATURE, 1, 77], [HIT_CREATURE, 0, 33]]);
    // Both species read the seen energy on one shared scale, the larger start energy.
    const scale = Math.max(...speciesList(two).map((sp) => sp.startEnergy));
    for (const s of [0, 1]) {
      const base = speciesEngine(two, speciesList(two)[s]!);
      const engine = { ...base, creature: { ...base.creature, rayCount: 2 } };
      expect(engine.seenEnergyScale).toBe(scale);
      const F = rayFeatureCount(engine);
      const out = new Float32Array(inputLayout(engine).size);
      encodeInputs(states[0]!, rays, engine, out, 1, 0);
      expect(Array.from(out.subarray(FEAT_CREATURE, F))).toEqual([0, 1, Math.fround(energySignal(77, scale))]);
      expect(Array.from(out.subarray(F + FEAT_CREATURE, 2 * F))).toEqual([1, 0, Math.fround(energySignal(33, scale))]);
    }
  });

  it("seed-pool genomes map in with zero weights on the species features", () => {
    const plan: BodyPlan = { rayCount: 5, raySpread: 1.2, rayLength: 90, hiddenLayers: [8], memoryShort: 1, memoryLong: 1 };
    const genome = randomGenome(trialsSizes(plan), testRng(4));
    const trials = new Brain(trialsSizes(plan), genome);
    const pred = new Brain(layerSizes(two, plan), trialsToEcoGenome(plan, genome, two));
    const F = rayFeatureCount(two);
    const rng = testRng(8);
    for (let trial = 0; trial < 10; trial++) {
      const tIn = Float32Array.from({ length: trialsSizes(plan)[0]! }, () => rng.next() * 2 - 1);
      const pIn = new Float32Array(layerSizes(two, plan)[0]!);
      for (let i = 0; i < tIn.length; i++) pIn[i < plan.rayCount * RAY_FEATURES ? Math.floor(i / RAY_FEATURES) * F + (i % RAY_FEATURES) : i + plan.rayCount * (F - RAY_FEATURES)] = tIn[i]!;
      for (let r = 0; r < plan.rayCount; r++) for (let f = FEAT_CREATURE; f < F; f++) pIn[r * F + f] = rng.next();
      const tOut = new Float32Array(trialsSizes(plan).at(-1)!);
      const pOut = new Float32Array(tOut.length);
      trials.forward(tIn, tOut);
      pred.forward(pIn, pOut);
      expect(Array.from(pOut)).toEqual(Array.from(tOut));
    }
    // Founders from the pool, of both species.
    const entry: PoolEntry = { plan, genome, fitness: 60, world: { food: 0.7, poison: 0.1 } };
    const eco = new Ecosystem(predCfg(10, 4), [entry]);
    expect(eco.poolFounders).toBe(5 + 2);
    expect(eco.lineages.fromPool(0) && eco.lineages.fromPool(10) && !eco.lineages.fromPool(9)).toBe(true);
  });
});
