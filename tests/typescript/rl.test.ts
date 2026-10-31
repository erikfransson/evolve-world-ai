import { genomeLength, layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { castFor, checkEnv, envConfig, isRam, RAM_MIN_ENERGY, randomLearner, runEpisode } from "../../src/typescript/src/sim/rl/env.ts";
import { recordEpisode } from "../../src/typescript/src/sim/rl/recording.ts";
import { wasmAvailable } from "../../src/typescript/src/sim/wasm/loader.ts";
import { creatureFile, parseCreatureFile } from "../../src/typescript/src/sim/rl/creatureFile.ts";
import type { EnvSpec } from "../../src/typescript/src/sim/rl/env.ts";
import { ENVS, ENV_GROUPS, envById, groupOf } from "../../src/typescript/src/sim/rl/envs.ts";
import { placeLayout } from "../../src/typescript/src/sim/rl/layouts.ts";
import { Es, centredRanks, standardise } from "../../src/typescript/src/sim/rl/es.ts";
import { parseLibrary, serialiseLearner } from "../../src/typescript/src/sim/rl/library.ts";
import { testRng } from "./helpers.ts";
import { HIT_FOOD, HIT_POISON } from "../../src/typescript/src/sim/types.ts";

describe("centredRanks", () => {
  it("maps ranks to [-0.5, 0.5] and shares ties", () => {
    expect(centredRanks([10, -3, 7])).toEqual([0.5, -0.5, 0]);
    expect(centredRanks([1, 1, 2, 0])).toEqual([0, 0, 0.5, -0.5]);
  });
});

describe("standardise", () => {
  it("gives mean 0 and std 1, and zeros for equal rewards", () => {
    const z = standardise([1, 2, 3, 6]);
    expect(z.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 12);
    expect(Math.sqrt(z.reduce((a, b) => a + b * b, 0) / z.length)).toBeCloseTo(1, 12);
    expect(standardise([4, 4, 4])).toEqual([0, 0, 0]);
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

  it("prepare draws the next step's noise ahead with identical candidates", () => {
    const a = new Es(new Float32Array(6), { pairs: 3 });
    const b = new Es(new Float32Array(6), { pairs: 3 });
    const ra = testRng(5);
    const rb = testRng(5);
    for (let k = 0; k < 3; k++) {
      const ca = a.ask(ra);
      const cb = b.ask(rb);
      b.prepare(rb); // while the episodes would run
      const r = ca.map((_, i) => Math.sin(i + k));
      a.tell(r);
      b.tell(r);
      expect(cb).toEqual(ca);
      expect(b.theta).toEqual(a.theta);
    }
    expect(b.ask(rb)).toEqual(a.ask(ra)); // consumes the prepared noise
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
    const env: EnvSpec = { ...envById("minefield")!, food: 200, poison: 0, seconds: 20, size: [300, 300] };
    const r = runEpisode(env, randomLearner(env, 1), 3);
    expect(r.reward).toBe(r.food);
    expect(r.seconds).toBeGreaterThan(0);
  });
});

describe("library", () => {
  it("round-trips a learner at 3 decimals and skips malformed entries", () => {
    const l = randomLearner(envById("minefield")!, 1);
    const short = { ...serialiseLearner(l), genome: serialiseLearner(l).genome.slice(1) };
    const lib = parseLibrary({ version: 1, envs: { "minefield": [serialiseLearner(l), { plan: {}, genome: ["x"] }, short], nope: [serialiseLearner(l)] } });
    expect(lib["minefield"]).toHaveLength(1);
    expect(lib["minefield"]![0]!.genome[0]).toBeCloseTo(l.genome[0]!, 3);
    expect(Object.keys(lib)).toEqual(["minefield"]); // only built-in env ids, whose world fixes the layout
    expect(Object.keys(parseLibrary({ version: 2, envs: {} }))).toEqual([]);
  });

  it("ignores prototype keys, and an env drawing rivals from them falls back to random ones", () => {
    const lib = parseLibrary(JSON.parse('{"version":1,"envs":{"__proto__":[{"plan":{}}],"constructor":[]}}'));
    expect(Object.getPrototypeOf(lib)).toBe(null);
    const raw: EnvSpec = { ...envById("rivals")!, seconds: 5, rivals: [{ species: 0, count: 2, source: "library:constructor" }] };
    expect(checkEnv(raw, "ecosystem", 0)).toMatch(/library/); // the gate refuses it
    expect(runEpisode(raw, randomLearner(raw, 1), 3, null, lib).seconds).toBeGreaterThan(0); // and an episode given it anyway falls back
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
  const custom = { ...envById("minefield")!, size: [500, 500], rivals: [{ species: 0, count: 3, source: "pool" }] };

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

  it("bounds layouts by the world size and keeps rivals out of walled worlds", () => {
    const fence = { ...custom, rivals: [], layout: { kind: "fence", gap: 60 } };
    expect(typeof checkEnv(fence, "ecosystem", 0)).toBe("object");
    expect(checkEnv({ ...fence, layout: { kind: "fence", gap: 300 } }, "ecosystem", 0)).toMatch(/gap/);
    expect(checkEnv({ ...fence, layout: { kind: "patch", radius: 300 } }, "ecosystem", 0)).toMatch(/radius/);
    expect(checkEnv({ ...fence, rivals: [{ species: 0, count: 1, source: "random" }] }, "ecosystem", 0)).toMatch(/does not take rivals/);
  });

  it("keeps custom ids apart from the built-in ones", () => {
    const env = checkEnv({ ...custom, id: "minefield", name: "\u202eevil" }, "ecosystem", 0);
    expect(typeof env === "object" && [env.id, env.name]).toEqual(["custom-minefield", "evil"]);
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

describe("cleared boxes", () => {
  it("pay nothing for a box that starts without food", () => {
    const env: EnvSpec = { ...envById("nibble")!, food: 0, poison: 2, seconds: 5 };
    const r = runEpisode(env, randomLearner(env, 1), 4);
    expect(r.reward).toBe(0);
  });

  it("end early only when the learner itself ate every starting food, and pay the seconds left", () => {
    const env: EnvSpec = { ...envById("nibble")!, food: 3, poison: 0, size: [200, 200] };
    for (let seed = 1; seed < 40; seed++) {
      const r = runEpisode(env, randomLearner(env, seed), seed);
      if (r.food < env.food) expect(r.reward).toBe(r.food);
      else expect(r.reward).toBeGreaterThan(r.food); // cleared before the end: food plus 0.1 per second left
    }
  });
});

describe("library rivals", () => {
  it("are only drawn from envs of the same world and species, so a layout never mismatches", () => {
    const hunter = randomLearner(envById("hunt-grazers")!, 2); // a predator in the two-species layout
    const lib = parseLibrary({ version: 1, envs: { "hunt-grazers": [serialiseLearner(hunter)] } });
    expect(lib["hunt-grazers"]).toHaveLength(1);
    const env: EnvSpec = { ...envById("nibble")!, seconds: 5, rivals: [{ species: 0, count: 2, source: "library:hunt-grazers" }] };
    expect(() => runEpisode(env, randomLearner(env, 1), 3, null, lib)).not.toThrow();
    expect(checkEnv(env, "ecosystem", 0)).toMatch(/library/);
  });
});

describe("env groups", () => {
  it("file every built-in env under a group, the small ones outside Advanced", () => {
    for (const e of ENVS) expect(ENV_GROUPS).toContain(groupOf(e));
    expect(groupOf(envById("fence")!)).toBe("Avoid and find a way");
    expect(groupOf(envById("brawl")!)).toBe("Fight");
    expect(groupOf(envById("aggressor")!)).toBe("Fight");
    expect(groupOf(envById("poison-field")!)).toBe("Avoid and find a way");
    expect(groupOf(envById("glimpse")!)).toBe("Memory");
    expect(groupOf(envById("hunt-grazers")!)).toBe("Advanced");
    expect(groupOf(envById("live-patch")!)).toBe("Bigger");
  });

  it("gives every forager group at least three envs", () => {
    const count = new Map<string, number>();
    for (const e of ENVS) if (e.tags.includes("forager")) count.set(groupOf(e), (count.get(groupOf(e)) ?? 0) + 1);
    for (const g of ENV_GROUPS) if (g !== "Advanced" && g !== "Custom") expect(count.get(g) ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("holds four Time pressure envs, Lap among them, filed with navigation tags but under Time pressure", () => {
    expect(ENVS.filter((e) => groupOf(e) === "Time pressure").length).toBeGreaterThanOrEqual(4);
    expect(groupOf(envById("lap")!)).toBe("Time pressure");
    expect(typeof checkEnv(JSON.parse(JSON.stringify(envById("lap")!)), "ecosystem", 0)).not.toBe("string");
  });

  it("keeps every Bigger env within the custom env limits", () => {
    const bigger = ENVS.filter((e) => groupOf(e) === "Bigger");
    expect(bigger.length).toBeGreaterThanOrEqual(4);
    for (const e of bigger) expect(typeof checkEnv(JSON.parse(JSON.stringify(e)), "ecosystem", 0)).not.toBe("string");
  });
});

describe("hidden food in envs", () => {
  // Per tick, whether any learner ray sees food and any sees the poison behind it, with food hidden for ticks 4 to 9.
  const timeline = (wasm: boolean): string[] => {
    const env = envById("flash")!;
    const base = envConfig(env, 1);
    const config = { ...base, eco: { ...base.eco, wasm } };
    const learner = randomLearner(env, 1);
    const [cx, cy] = [300, 300];
    const offsets = new Ecosystem(config, null, { cast: castFor(env, config, learner, 1, null, {}) }).get(0)!.creature.rayOffsets;
    const cast = castFor(env, config, learner, 1, null, {}, { x: cx, y: cy, heading: -offsets[0]! }); // the first ray points along +x
    const L = learner.plan.rayLength;
    const items = [{ x: cx + 0.5 * L, y: cy, kind: HIT_FOOD }, { x: cx + 0.8 * L, y: cy, kind: HIT_POISON }] as const;
    const eco = new Ecosystem(config, null, { cast, items });
    expect(eco.wasm).toBe(wasm);
    eco.detail = 0;
    const out: string[] = [];
    for (let t = 0; t < 14; t++) {
      if (t === 4) eco.setFoodHidden(true);
      if (t === 10) eco.setFoodHidden(false);
      eco.prepareTick();
      eco.sensePhase();
      const c = eco.get(0)!.creature;
      out.push(`${c.rays.some((r) => r.kind === HIT_FOOD) ? "F" : "-"}${c.rays.some((r) => r.kind === HIT_POISON) ? "P" : "-"}`);
      c.outputs.fill(0);
      eco.finishTick();
    }
    expect(eco.get(0)!.eaten).toBe(0); // the food stays put, so every tick tests the same geometry
    return out;
  };

  it("hides food from the rays on the WASM path exactly when the JS path does", () => {
    const js = timeline(false);
    expect(js.slice(0, 4).every((s) => s[0] === "F")).toBe(true);
    expect(js.slice(4, 10).every((s) => s === "-P")).toBe(true);
    expect(js.slice(10).every((s) => s[0] === "F")).toBe(true);
    if (wasmAvailable()) expect(timeline(true)).toEqual(js);
  });

  it("runs memory envs on the WASM kernels", () => {
    const env = envById("flash")!;
    expect(envConfig(env, 1).eco.wasm).toBe(wasmAvailable());
    expect(runEpisode(env, randomLearner(env, 2), 3).seconds).toBeGreaterThan(0);
  });
});

describe("memory envs", () => {
  it("has at least four, and each runs and passes the custom env checks", () => {
    const memory = ENVS.filter((e) => groupOf(e) === "Memory");
    expect(memory.length).toBeGreaterThanOrEqual(4);
    for (const e of memory) {
      expect(typeof checkEnv(JSON.parse(JSON.stringify(e)), "ecosystem", 0)).not.toBe("string");
      expect(runEpisode(e, randomLearner(e, 2), 3).seconds).toBeGreaterThan(0);
    }
  });

  it("deals the stops layout into evenly sized clusters, away from the start", () => {
    const placed = placeLayout({ kind: "stops", count: 2 }, [600, 600], 8, 0, 5);
    expect(placed.items.length).toBe(8);
    for (const it of placed.items) expect(Math.hypot(it.x - 300, it.y - 300)).toBeGreaterThan(100);
    const side = placed.items.map((it) => (it.x - 300) * (placed.items[0]!.x - 300) + (it.y - 300) * (placed.items[0]!.y - 300) > 0);
    expect(side.filter(Boolean).length).toBe(4);
  });

  it("keeps the stops count through checkEnv and rejects a bad one", () => {
    const spec = JSON.parse(JSON.stringify(envById("two-stops")!));
    const checked = checkEnv(spec, "ecosystem", 0) as EnvSpec;
    expect(checked.layout).toEqual({ kind: "stops", count: 2 });
    for (const count of [0, 1.5, 7, -1]) expect(checkEnv({ ...spec, layout: { kind: "stops", count } }, "ecosystem", 0)).toMatch(/stops count/);
  });
});

describe("learner input under the WASM kernels", () => {
  it("records the learner's rays and brain input, and backprop RL sees them", () => {
    const env = envById("nibble")!;
    expect(envConfig(env, 1).eco.wasm).toBe(wasmAvailable());
    const learner = randomLearner(env, 3);
    const rec = recordEpisode(env, learner, 5, null, {}, 2, true);
    expect(rec.inputs.some((v) => v !== 0)).toBe(true);
    expect(rec.rays.some((v, k) => k % 2 === 0 && v !== 0)).toBe(true);
    let seen = 0;
    runEpisode(env, learner, 5, null, {}, undefined, (c) => {
      seen += c.brain.layerActivations()[0]!.filter((v) => v !== 0).length > 1 ? 1 : 0;
    });
    expect(seen).toBeGreaterThan(0);
  });
});

describe("rams", () => {
  // A scripted learner charges a weak rival at full speed: the kill is a ram, though the learner's energy drops (it gains the
  // rival's energy from before the hit, at most the damage it took itself).
  it("counts a rival killed by bumping into the learner", () => {
    const env = checkEnv({ id: "ram-test", name: "Ram", size: [200, 200], food: 0, poison: 0, foodRegrow: 0, seconds: 15, collisionDamage: true, learnerEnergy: 300, rivals: [{ species: 0, count: 1, source: "random", energy: 10 }], reward: { ram: 1 } }, "ecosystem", 0) as EnvSpec;
    let rams = 0;
    for (let seed = 1; seed <= 4; seed++) {
      let eco: Ecosystem | null = null;
      const charge = (c: { state: { x: number; y: number; heading: number }; outputs: Float32Array }): void => {
        const rival = eco?.members.find((m) => m.id !== 0)?.creature.state;
        if (!rival) return;
        const turn = Math.atan2(rival.y - c.state.y, rival.x - c.state.x) - c.state.heading;
        c.outputs[0] = Math.max(-1, Math.min(1, 3 * Math.atan2(Math.sin(turn), Math.cos(turn))));
        c.outputs[1] = 1;
      };
      rams += runEpisode(env, randomLearner(env, seed), seed, null, undefined, (e) => (eco = e), charge as never).rams;
    }
    expect(rams).toBeGreaterThan(0);
  });

  // Each clause of the rule on its own: a ram, then the same death with one condition changed.
  const ram = { learnerAlive: true, touchesLearner: true, energyBefore: 5, touchesOtherRival: false, poisonEatenThisTick: false };
  it("credits a rival with energy left that dies touching only the living learner", () => expect(isRam(ram)).toBe(true));
  it("does not credit a rival that starved next to the learner", () => expect(isRam({ ...ram, energyBefore: RAM_MIN_ENERGY })).toBe(false));
  it("does not credit a rival killed by another rival", () => expect(isRam({ ...ram, touchesOtherRival: true })).toBe(false));
  it("does not credit a poison death beside the learner", () => expect(isRam({ ...ram, poisonEatenThisTick: true })).toBe(false));
  it("does not credit a death away from the learner or after it died", () => {
    expect(isRam({ ...ram, touchesLearner: false })).toBe(false);
    expect(isRam({ ...ram, learnerAlive: false })).toBe(false);
  });
});
