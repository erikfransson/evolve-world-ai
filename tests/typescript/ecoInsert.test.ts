import { genomeLength, layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { MAX_INSERT_ENERGY, MAX_INSERT_RAYS, MAX_NAME_LENGTH, checkInsert } from "../../src/typescript/src/sim/ecoInsert.ts";
import type { InsertSpec, InsertWorld } from "../../src/typescript/src/sim/ecoInsert.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import type { BirthTraits } from "../../src/typescript/src/sim/planMutation.ts";
import type { BodyPlan } from "../../src/typescript/src/sim/sensors.ts";

// checkInsert alone (insertCreature is covered through the Ecosystem in mutationScale.test.ts and ecoLive.test.ts): every refusal leaves the traits and the world alone.

type Any = any; // the test reads the Ecosystem's private world view

const config = structuredClone(DEFAULT_ECO_CONFIG);
config.eco.initialPopulation = 1;
const eco = new Ecosystem(config, null) as Any;
const world = (over: Partial<InsertWorld> = {}): InsertWorld => ({
  config: eco.config, species: eco.species, ranges: eco.ranges, engines: eco.engines, population: 1, terrain: eco.items.terrain, ...over,
});
const PLAN: BodyPlan = { rayCount: 3, raySpread: 1, rayLength: 60, hiddenLayers: [4], memoryShort: 0, memoryLong: 0 };
const spec = (over: Partial<InsertSpec> = {}): InsertSpec => ({
  genome: new Float32Array(genomeLength(layerSizes(eco.engines[0], PLAN))).fill(0.1), plan: PLAN, x: 500, y: 400, hue: 5, name: "v", ...over,
});
const traits = (): BirthTraits => ({ energy: -1, cost: -1, cooldown: -1 });
const reason = (s: InsertSpec, w = world()): string => {
  const r = checkInsert(s, w, traits());
  if (r.ok) throw new Error("expected a refusal");
  return r.reason;
};

describe("checkInsert", () => {
  it("accepts a good spec, copies the genome and fills the defaults and the birth traits from the species' ranges", () => {
    const s = spec();
    const t = traits();
    const r = checkInsert(s, world(), t);
    if (!r.ok) throw new Error(r.reason);
    expect(r).toMatchObject({ sp: 0, heading: 0, mutationScale: 1, energy: eco.species[0].startEnergy });
    expect(r.genome).not.toBe(s.genome);
    expect(Array.from(r.genome)).toEqual(Array.from(s.genome));
    const ranges = eco.ranges[0];
    expect(t.energy).toBeGreaterThanOrEqual(ranges.birthEnergyRange[0]);
    expect(t.energy).toBeLessThanOrEqual(ranges.birthEnergyRange[1]);
    expect(t.cost).toBeGreaterThan(0);
    expect(t.cooldown).toBeGreaterThanOrEqual(0);
  });

  it("clamps given birth traits into the species' ranges", () => {
    const t = traits();
    const ranges = eco.ranges[0];
    const r = checkInsert(spec({ birth: { energy: 1e9, cost: 1e-9, cooldown: 1e9 } }), world(), t);
    expect(r.ok).toBe(true);
    expect([t.energy, t.cost, t.cooldown]).toEqual([ranges.birthEnergyRange[1], ranges.birthCostRange[0], ranges.birthCooldownRange[1]]);
  });

  it("refuses each bad field with its own reason", () => {
    expect(reason(spec({ species: 1 }))).toMatch(/species must be 0 to 0/);
    expect(reason(spec({ species: 0.5 }))).toMatch(/species must be/);
    expect(reason(spec(), world({ population: eco.config.eco.maxPopulation }))).toMatch(/full/);
    expect(reason(spec({ plan: { ...PLAN, rayCount: MAX_INSERT_RAYS + 1 } }))).toMatch(/plan needs/);
    expect(reason(spec({ plan: { ...PLAN, rayLength: NaN } }))).toMatch(/plan needs/);
    expect(reason(spec({ plan: { ...PLAN, memoryShort: -1 } }))).toMatch(/memory units/);
    expect(reason(spec({ plan: { ...PLAN, hiddenLayers: [] } }))).toMatch(/hidden layers/);
    expect(reason(spec({ x: -1 }))).toMatch(/inside the walls/);
    expect(reason(spec({ y: NaN }))).toMatch(/inside the walls/);
    expect(reason(spec({ hue: Infinity }))).toMatch(/hue/);
    expect(reason(spec({ heading: NaN }))).toMatch(/heading/);
    expect(reason(spec({ energy: 0 }))).toMatch(/energy must be/);
    expect(reason(spec({ energy: MAX_INSERT_ENERGY + 1 }))).toMatch(/energy must be/);
    expect(reason(spec({ name: "x".repeat(MAX_NAME_LENGTH + 1) }))).toMatch(/name must be/);
    expect(reason(spec({ name: "a\nb" }))).toMatch(/name must be/);
    expect(reason(spec({ mutationScale: 4.01 }))).toMatch(/mutationScale/);
    expect(reason(spec({ birth: { cost: -1 } }))).toMatch(/birth energy/);
  });

  it("refuses a genome of the wrong length or with a non-finite weight, and leaves a spec of the right length alone", () => {
    const g = spec().genome as Float32Array;
    expect(reason(spec({ genome: g.slice(1) }))).toMatch(/genome has \d+ numbers, the plan needs \d+/);
    const bad = g.slice();
    bad[3] = NaN;
    expect(reason(spec({ genome: bad }))).toMatch(/finite/);
    expect(checkInsert(spec({ genome: g }), world(), traits()).ok).toBe(true);
  });
});
