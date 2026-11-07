import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { LIVE_FIELDS, LIVE_MAX, checkRetune } from "../../src/typescript/src/sim/retune.ts";

// checkRetune alone: the shape and range of a live settings patch (Ecosystem.retune applying it is covered in ecoLive.test.ts).

const config = DEFAULT_ECO_CONFIG;
const refused = (patch: unknown, c = config): string => {
  const r = checkRetune(patch, c);
  if ("fields" in r) throw new Error(`expected a refusal, got ${JSON.stringify(r.fields)}`);
  return r.reason;
};

describe("checkRetune", () => {
  it("returns the [section, field, value] triples of a good patch, in order", () => {
    expect(checkRetune({ eco: { foodRegrow: 0.04, aging: true, birthCostRange: [5, 9] }, world: { foodEnergy: 30 }, mutation: { rate: 0.1 } }, config)).toEqual({
      fields: [["eco", "foodRegrow", 0.04], ["eco", "aging", true], ["eco", "birthCostRange", [5, 9]], ["world", "foodEnergy", 30], ["mutation", "rate", 0.1]],
    });
    expect(checkRetune({}, config)).toEqual({ fields: [] });
  });

  it("refuses a non-object patch, unknown sections and fields, and sections that are not objects", () => {
    for (const p of [null, 5, "x", [], undefined]) expect(refused(p)).toMatch(/needs an object/);
    expect(refused({ creature: { radius: 3 } })).toMatch(/"creature" cannot be changed live/);
    expect(refused({ eco: { wasm: false } })).toMatch(/eco\.wasm cannot be changed live/);
    expect(refused({ eco: [1] })).toMatch(/must be an object/);
    expect(refused({ eco: null })).toMatch(/must be an object/);
  });

  it("refuses values of the wrong kind, out of range, or past the maximum", () => {
    expect(refused({ eco: { foodRegrow: -1 } })).toMatch(/eco\.foodRegrow has an invalid value -1/);
    expect(refused({ eco: { foodRegrow: NaN } })).toMatch(/invalid value/);
    expect(refused({ eco: { foodRegrow: LIVE_MAX["eco.foodRegrow"]! + 0.5 } })).toMatch(/at most 1/);
    expect(refused({ eco: { aging: 1 } })).toMatch(/invalid value 1 \(bool\)/);
    expect(refused({ eco: { yearMinutes: 0 } })).toMatch(/positive/);
    expect(refused({ eco: { winterFood: 1.5 } })).toMatch(/unit/);
    expect(refused({ eco: { maxPopulation: 10.5 } })).toMatch(/count/);
    expect(refused({ eco: { birthCostRange: [9, 5] } })).toMatch(/posrange/);
    expect(refused({ eco: { birthCostRange: [0, 5] } })).toMatch(/posrange/);
    expect(refused({ eco: { birthCooldownRange: [0, 601] } })).toMatch(/at most 600/);
  });

  it("accepts the maximum itself and a range starting at 0 for a cooldown", () => {
    expect(checkRetune({ eco: { foodRegrow: LIVE_MAX["eco.foodRegrow"], birthCooldownRange: [0, 5] } }, config)).toHaveProperty("fields");
  });

  it("refuses a range in a world with a species list", () => {
    const withSpecies = { ...config, species: [{ name: "a" }] } as unknown as typeof config;
    expect(refused({ eco: { birthCostRange: [5, 9] } }, withSpecies)).toMatch(/set per species/);
    expect(checkRetune({ eco: { foodRegrow: 0.1 } }, withSpecies)).toHaveProperty("fields");
  });

  it("every field of LIVE_FIELDS has a kind checkRetune understands", () => {
    for (const [section, table] of Object.entries(LIVE_FIELDS)) for (const key of Object.keys(table)) expect(refused({ [section]: { [key]: "not a value" } })).toMatch(new RegExp(`${section}\\.${key} has an invalid value`));
  });

  it("refuses __proto__ and constructor as a section holding unknown fields", () => {
    expect(refused(JSON.parse('{"__proto__":{"eco":1}}'))).toMatch(/cannot be changed live/); // JSON.parse gives __proto__ as an own key, as a visitor's message would
    expect(refused({ constructor: { x: 1 } })).toMatch(/constructor\b.*cannot be changed live/);
  });

  // Source finding: the tables are plain objects, so table[key] finds inherited names (Object.prototype), which count as a known kind and pass the number check.
  it("refuses the field name constructor", () => {
    expect(refused({ eco: { constructor: 1 } })).toMatch(/eco\.constructor cannot be changed live/);
  });
  it("refuses the field name __proto__", () => {
    expect(refused(JSON.parse('{"eco":{"__proto__":1}}'))).toMatch(/eco\.__proto__ cannot be changed live/);
  });
  it("refuses an inherited section name such as toString", () => {
    expect(refused({ toString: {} })).toMatch(/cannot be changed live/);
  });
});
