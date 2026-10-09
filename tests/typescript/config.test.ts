import { DEFAULT_CONFIG, itemCounts, maxLifeTicks, withOverrides } from "../../src/typescript/src/sim/config.ts";

describe("withOverrides", () => {
  it("returns a new config with nested values replaced and the rest kept", () => {
    const out = withOverrides(DEFAULT_CONFIG, { seed: 9, world: { respawn: true }, brain: { hiddenLayers: [8, 8] } });
    expect(out.seed).toBe(9);
    expect(out.world.respawn).toBe(true);
    expect(out.world.width).toBe(DEFAULT_CONFIG.world.width);
    expect(out.brain.hiddenLayers).toEqual([8, 8]);
    expect(out.ga).toEqual(DEFAULT_CONFIG.ga);
  });

  it("does not mutate base or share nested objects with it", () => {
    const snapshot = structuredClone(DEFAULT_CONFIG);
    const overrides = { brain: { hiddenLayers: [4] } };
    const out = withOverrides(DEFAULT_CONFIG, { world: { width: 5 }, ...overrides });
    expect(DEFAULT_CONFIG).toEqual(snapshot);
    expect(out.ga).not.toBe(DEFAULT_CONFIG.ga);
    overrides.brain.hiddenLayers.push(9);
    expect(out.brain.hiddenLayers).toEqual([4]);
  });

  it("throws on unknown keys with the full path", () => {
    expect(() => withOverrides(DEFAULT_CONFIG, JSON.parse('{"world":{"widht":1}}'))).toThrow('unknown config key "world.widht"');
    expect(() => withOverrides(DEFAULT_CONFIG, JSON.parse('{"nope":1}'))).toThrow('unknown config key "nope"');
  });

  it("throws on wrong value types with the full path", () => {
    const bad = (json: string) => () => withOverrides(DEFAULT_CONFIG, JSON.parse(json));
    expect(bad('{"seed":"1"}')).toThrow('config "seed" must be a number');
    expect(bad('{"world":{"respawn":1}}')).toThrow('config "world.respawn" must be a boolean');
    expect(bad('{"ga":{"selection":3}}')).toThrow('config "ga.selection" must be a string');
    expect(bad('{"brain":{"hiddenLayers":16}}')).toThrow('config "brain.hiddenLayers" must be an array');
    expect(bad('{"brain":{"hiddenLayers":[8,"x"]}}')).toThrow('config "brain.hiddenLayers[1]" must be a number');
    expect(bad('{"world":5}')).toThrow('config "world" must be an object');
    expect(bad("[]")).toThrow("must be an object");
  });
});

describe("maxLifeTicks", () => {
  it("converts creature.maxLifeSeconds using dt", () => {
    const cfg = withOverrides(DEFAULT_CONFIG, { dt: 0.5, creature: { maxLifeSeconds: 10 } });
    expect(maxLifeTicks(cfg)).toBe(20);
  });
});

describe("itemCounts", () => {
  it("does not depend on the vision range", () => {
    const far = withOverrides(DEFAULT_CONFIG, { creature: { rayLength: 300 } });
    expect(itemCounts(far)).toEqual(itemCounts(DEFAULT_CONFIG));
  });
});
