import { genomeLength, layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { castFor, checkEnv, envConfig, randomLearner, runEpisode } from "../../src/typescript/src/sim/rl/env.ts";
import { creatureFile, parseCreatureFile } from "../../src/typescript/src/sim/rl/creatureFile.ts";
import type { EnvSpec } from "../../src/typescript/src/sim/rl/env.ts";
import { ENVS, envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { Es, centredRanks } from "../../src/typescript/src/sim/rl/es.ts";
import { parseLibrary, serialiseLearner } from "../../src/typescript/src/sim/rl/library.ts";
import { testRng } from "./helpers.ts";

describe("centredRanks", () => {
  it("maps ranks to [-0.5, 0.5] and shares ties", () => {
    expect(centredRanks([10, -3, 7])).toEqual([0.5, -0.5, 0]);
    expect(centredRanks([1, 1, 2, 0])).toEqual([0, 0, 0.5, -0.5]);
  });
});

describe("Es", () => {
  it("climbs a smooth reward towards its peak", () => {
    const target = Float32Array.from({ length: 20 }, (_, i) => Math.sin(i));
    const dist = (x: Float32Array): number => Math.hypot(...x.map((v, i) => v - target[i]!));
    const es = new Es(new Float32Array(20), { pairs: 12, sigma: 0.1, lr: 0.05, decay: 0 });
    const rng = testRng(3);
    const before = dist(es.theta);
    for (let k = 0; k < 150; k++) es.tell(es.ask(rng).map((g) => -dist(g)));
    expect(dist(es.theta)).toBeLessThan(0.3 * before);
  });

  it("rejects a reward list of the wrong length", () => {
    const es = new Es(new Float32Array(4), { pairs: 2 });
    es.ask(testRng(1));
    expect(() => es.tell([1, 2, 3])).toThrow(/expected 4/);
  });
});

describe("RL envs", () => {
  it("have unique ids, a learner species of their world and rivals of it", () => {
    expect(new Set(ENVS.map((e) => e.id)).size).toBe(ENVS.length);
    for (const env of ENVS) {
      const species = env.world === "hunt" ? 2 : 1;
      expect(env.role).toBeLessThan(species);
      for (const r of env.rivals) expect(r.species).toBeLessThan(species);
    }
  });

  it("build a birthless world with the env's items and creatures", () => {
    const env = envById("rivals")!;
    const config = envConfig(env, 5);
    const learner = randomLearner(env, 2);
    const eco = new Ecosystem(config, null, { cast: castFor(env, config, learner, 5, null, {}) });
    expect([eco.food, eco.poison, eco.population]).toEqual([env.food, env.poison, 7]);
    expect(Array.from(eco.get(0)!.creature.brain.genome)).toEqual(Array.from(learner.genome));
    for (const m of eco.members) expect(m.birth.energy).toBeGreaterThanOrEqual(1e9);
    for (let t = 0; t < 300; t++) eco.step();
    expect(eco.births).toBe(0);
  });

  it("stay birthless through deaths", () => {
    const env = envById("hunt-grazers")!;
    const config = envConfig(env, 2);
    const eco = new Ecosystem(config, null, { cast: castFor(env, config, randomLearner(env, 2), 2, null, {}) });
    for (let t = 0; t < 1800 && eco.deaths === 0; t++) eco.step();
    expect(eco.deaths).toBeGreaterThan(0);
    for (let t = 0; t < 30; t++) eco.step();
    expect(eco.births).toBe(0);
  });

  it("plays the same episode for the same seed, and a hunter's genome fits the two-species layout", () => {
    const env = envById("hunt-wanderers")!;
    const learner = randomLearner(env, 4);
    expect(learner.genome.length).toBe(genomeLength(layerSizes(envConfig(env, 1), learner.plan)));
    const short: EnvSpec = { ...env, seconds: 5 };
    expect(runEpisode(short, learner, 9)).toEqual(runEpisode(short, learner, 9));
  });

  it("scores the reward from the learner's own food", () => {
    const env: EnvSpec = { ...envById("forage-box")!, food: 200, poison: 0, seconds: 20, size: [300, 300] };
    const r = runEpisode(env, randomLearner(env, 1), 3);
    expect(r.reward).toBe(r.food);
    expect(r.seconds).toBeGreaterThan(0);
  });
});

describe("library", () => {
  it("round-trips a learner at 3 decimals and skips malformed entries", () => {
    const l = randomLearner(envById("forage-box")!, 1);
    const short = { ...serialiseLearner(l), genome: serialiseLearner(l).genome.slice(1) };
    const lib = parseLibrary({ version: 1, envs: { "forage-box": [serialiseLearner(l), { plan: {}, genome: ["x"] }, short], nope: [serialiseLearner(l)] } });
    expect(lib["forage-box"]).toHaveLength(1);
    expect(lib["forage-box"]![0]!.genome[0]).toBeCloseTo(l.genome[0]!, 3);
    expect(Object.keys(lib)).toEqual(["forage-box"]); // only built-in env ids, whose world fixes the layout
    expect(Object.keys(parseLibrary({ version: 2, envs: {} }))).toEqual([]);
  });

  it("ignores prototype keys, and an env drawing rivals from them falls back to random ones", () => {
    const lib = parseLibrary(JSON.parse('{"version":1,"envs":{"__proto__":[{"plan":{}}],"constructor":[]}}'));
    expect(Object.getPrototypeOf(lib)).toBe(null);
    const env = checkEnv({ ...envById("rivals")!, seconds: 5, rivals: [{ species: 0, count: 2, source: "library:constructor" }] }, "ecosystem", 0);
    expect(typeof env).toBe("object");
    expect(runEpisode(env as EnvSpec, randomLearner(envById("rivals")!, 1), 3, null, lib).seconds).toBeGreaterThan(0);
  });
});

describe("creature files", () => {
  const learner = randomLearner(envById("hunt-wanderers")!, 3);
  const file = creatureFile("predator", "Rex", learner, { envs: ["hunt-wanderers"], iterations: 5, from: "random:3", heldStart: 0, heldEnd: 1, date: "2026-10-11" });

  it("round-trip through JSON text", () => {
    const back = parseCreatureFile(JSON.stringify(file));
    expect(typeof back).toBe("object");
    expect(back).toEqual(file);
  });

  it("reject wrong kinds, layouts, sizes and values with a reason", () => {
    const bad = (patch: Record<string, unknown>): unknown => parseCreatureFile({ ...file, ...patch });
    expect(bad({ format: "x" })).toMatch(/not an Evolve World/);
    expect(bad({ kind: "__proto__" })).toMatch(/kind/);
    expect(bad({ kind: "forager" })).toMatch(/genome must have/); // a predator's genome does not fit the one-species layout
    expect(bad({ genome: [...file.genome.slice(1), 1e9] })).toMatch(/finite/);
    expect(bad({ plan: { ...file.plan, hiddenLayers: [64] } })).toMatch(/hiddenLayers/);
    expect(parseCreatureFile("{ not json")).toBe("not a JSON file");
  });

  it("keep names as short plain text", () => {
    const f = parseCreatureFile({ ...file, name: "<img src=x onerror=alert(1)>\u0000" + "x".repeat(200) });
    expect(typeof f === "object" && f.name.length).toBeLessThanOrEqual(80);
    expect(typeof f === "object" && f.name.includes("\u0000")).toBe(false);
  });
});

describe("checkEnv", () => {
  const custom = { ...envById("forage-box")!, size: [500, 500], rivals: [{ species: 0, count: 3, source: "pool" }] };

  it("accepts a valid custom env for the learner's world and drops unknown fields", () => {
    const env = checkEnv({ ...custom, extra: 1 }, "ecosystem", 0);
    expect(typeof env === "object" && env.tags).toEqual(["custom"]);
    expect(env).not.toHaveProperty("extra");
  });

  it("rejects worlds that would stall the page or name missing species", () => {
    expect(checkEnv({ ...custom, size: [100000, 500] }, "ecosystem", 0)).toMatch(/sides/);
    expect(checkEnv({ ...custom, rivals: [{ species: 1, count: 2, source: "random" }] }, "ecosystem", 0)).toMatch(/species/);
    expect(checkEnv({ ...custom, rivals: [{ species: 0, count: 99, source: "random" }] }, "ecosystem", 0)).toMatch(/at most/);
    expect(checkEnv({ ...custom, rivals: [{ species: 0, count: 1, source: "library:../x" }] }, "ecosystem", 0)).toMatch(/source/);
    expect(checkEnv({ ...custom, rivals: Array.from({ length: 9 }, () => ({ species: 0, count: 0, source: "random" })) }, "ecosystem", 0)).toMatch(/groups/);
  });

  it("keeps custom ids apart from the built-in ones", () => {
    const env = checkEnv({ ...custom, id: "forage-box", name: "\u202eevil" }, "ecosystem", 0);
    expect(typeof env === "object" && [env.id, env.name]).toEqual(["custom-forage-box", "evil"]);
  });
});

describe("episode reward", () => {
  it("gives a learner that dies no end energy", () => {
    const env: EnvSpec = { ...envById("endurance")!, food: 0, seconds: 60 }; // nothing to eat, so it starves well before the end
    const r = runEpisode(env, randomLearner(env, 1), 1);
    expect(r.seconds).toBeLessThan(60);
    expect(r.energy).toBe(0);
    expect(r.reward).toBeCloseTo(0.1 * r.seconds, 9);
  });
});
