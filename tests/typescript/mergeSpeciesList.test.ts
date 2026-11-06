import { DEFAULT_PREDATOR_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { mergeSpeciesList } from "../../src/typescript/src/sim/species.ts";

const defaults = DEFAULT_PREDATOR_CONFIG.species!;
const merge = (v: unknown) => () => mergeSpeciesList(v, defaults);

describe("mergeSpeciesList", () => {
  it("merges each item over its default and leaves the rest as the defaults", () => {
    const merged = mergeSpeciesList([{ founders: 10 }, { eatBaseline: 5, rayLengthRange: [60, 200] }], defaults);
    expect(merged[0]).toEqual({ ...defaults[0]!, founders: 10 });
    expect(merged[1]).toEqual({ ...defaults[1]!, eatBaseline: 5, rayLengthRange: [60, 200] });
    expect(mergeSpeciesList([{}, {}], defaults)).toEqual(defaults);
  });

  it("rejects lists of the wrong length, bad prey indices, unknown keys and wrong types", () => {
    expect(merge([{}])).toThrow(/exactly 2 species \(Prey, Predator\), got 1/);
    expect(merge([{}, {}, {}])).toThrow(/exactly 2 species/);
    expect(merge({})).toThrow(/must be a list of 2 species/);
    expect(merge([{}, { prey: [5] }])).toThrow(/species\[1\].prey" must list other species by index, 0 to 1/);
    expect(merge([{}, { prey: [1] }])).toThrow(/must list other species/);
    expect(merge([{ fangs: 3 }, {}])).toThrow(/unknown config key "species\[0\].fangs"/);
    expect(merge([{}, { speed: "fast" }])).toThrow(/species\[1\].speed" must be a number/);
    expect(merge([{}, { rayLengthRange: [1, 2, 3] }])).toThrow(/must be \[min, max\]/);
  });

  it("converts items saved before heritable birth traits and checks range order", () => {
    const notes: string[] = [];
    const merged = mergeSpeciesList([{ birthEnergy: 100 }, { birthCost: 150, childEnergy: 80 }], defaults, notes);
    expect(merged[0]!.birthEnergyRange).toEqual([100, 100]);
    expect(merged[1]!.birthCostRange).toEqual([150, 150]);
    expect(notes.join(" ")).toMatch(/species\[1\]\.birthCost 150/);
    expect(merge([{ birthEnergyRange: [200, 100] }, {}])).toThrow(/species\[0\].birthEnergyRange" must have min at most max/);
  });

  it("rejects values the engine cannot run: negative or inverted ranges, non-positive speed, fractional founders", () => {
    expect(merge([{ birthEnergyRange: [-100, 200] }, {}])).toThrow(/species\[0\].birthEnergyRange" has an invalid value/);
    expect(merge([{}, { birthCostRange: [-1, 50] }])).toThrow(/birthCostRange" has an invalid value/);
    expect(merge([{ speed: 0 }, {}])).toThrow(/species\[0\].speed" has an invalid value/);
    expect(merge([{ speed: -1 }, {}])).toThrow(/speed" has an invalid value/);
    expect(merge([{ founders: 2.5 }, {}])).toThrow(/founders" has an invalid value/);
    expect(merge([{ founders: -1 }, {}])).toThrow(/founders" has an invalid value/);
    expect(merge([{ startEnergy: 0 }, {}])).toThrow(/startEnergy" has an invalid value/);
    expect(merge([{ livingCost: -0.1 }, {}])).toThrow(/livingCost" has an invalid value/);
    expect(merge([{ poolFraction: 1.5 }, {}])).toThrow(/poolFraction" has an invalid value/);
    expect(mergeSpeciesList([{}, { birthCostRange: [0, 50] }], defaults)[1]).toMatchObject({ birthCostRange: [0, 50] });
    expect(mergeSpeciesList([{ founders: 0, speed: 0.5 }, {}], defaults)[0]).toMatchObject({ founders: 0, speed: 0.5 });
  });

  it("rejects a non-number legacy birth value, and notes a conversion only when it wrote a range", () => {
    expect(merge([{ birthEnergy: "abc" }, {}])).toThrow(/species\[0\].birthEnergy" must be a number/);
    const notes: string[] = [];
    const merged = mergeSpeciesList([{ birthCost: 150, birthCostRange: [60, 70] }, {}], defaults, notes);
    expect(merged[0]!.birthCostRange).toEqual([60, 70]);
    expect(notes).toEqual([]);
  });

  it("calls prototype names unknown config keys", () => {
    expect(merge([{ constructor: 1 }, {}])).toThrow(/unknown config key "species\[0\].constructor"/);
    expect(merge([{}, { toString: 1 }])).toThrow(/unknown config key "species\[1\].toString"/);
  });
});
