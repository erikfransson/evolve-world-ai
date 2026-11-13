import { readFileSync } from "node:fs";
import { parseFounders } from "../../src/typescript/src/live/founders.ts";
import { castFor, checkEnv, envConfig, randomLearner, runEpisode } from "../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec } from "../../src/typescript/src/sim/rl/env.ts";
import { ENVS, FOUNDER_IDS, PREY, envById, groupOf } from "../../src/typescript/src/sim/rl/envs.ts";
import { withFounders } from "../../src/typescript/src/sim/rl/library.ts";

// Founder rivals (frozen Live founders as "founder:<id>") and the Founders env group.

const founders = parseFounders(JSON.parse(readFileSync(new URL("../../src/typescript/public/live-founders.json", import.meta.url), "utf8")));
const library = withFounders({}, founders);
const FOUNDER_ENVS = ["bloom-race", "crags-brawl", "blight", "six-realms"];

const spec = (source: string, count = 3): EnvSpec => ({ ...envById("rivals")!, seconds: 5, rivals: [{ species: PREY, count, source: source as `founder:${string}` }] });

describe("founder rivals", () => {
  it("knows the ids of the shipped founders file", () => {
    expect([...FOUNDER_IDS].sort()).toEqual(founders.map((f) => f.id).sort());
  });

  it("casts the founder's own plan and genome", () => {
    const env = spec("founder:oracle");
    const cast = castFor(env, envConfig(env, 1), randomLearner(env, 1), 1, null, library);
    const oracle = founders.find((f) => f.id === "oracle")!;
    expect(cast).toHaveLength(4);
    for (const m of cast.slice(1)) {
      expect(m.plan).toEqual(oracle.plan);
      expect(Array.from(m.genome)).toEqual(Array.from(oracle.genome));
    }
  });

  it("falls back to random rivals without the founders, and with a prototype key", () => {
    for (const source of ["founder:oracle", "founder:constructor"]) {
      const env = spec(source);
      const cast = castFor(env, envConfig(env, 1), randomLearner(env, 1), 1, null, {});
      expect(cast).toHaveLength(4);
      expect(cast[1]!.plan).not.toEqual(founders.find((f) => f.id === "oracle")!.plan);
      expect(runEpisode(env, randomLearner(env, 1), 3, null, {}).seconds).toBeGreaterThan(0);
    }
  });

  it("is accepted by the custom env check for known ids, refused for others", () => {
    const ok = checkEnv(spec("founder:grazer"), "ecosystem", 0);
    expect(typeof ok).toBe("object");
    for (const id of FOUNDER_IDS) expect(typeof checkEnv(spec(`founder:${id}`), "ecosystem", 0)).toBe("object");
    for (const bad of ["founder:nobody", "founder:", "founder:../x", "founder:__proto__", "founder:Oracle"]) expect(checkEnv(spec(bad), "ecosystem", 0), bad).toMatch(/founder/);
    expect(checkEnv({ ...spec("founder:grazer"), rivals: [{ species: 1, count: 1, source: "founder:grazer" }] }, "hunt", 0)).toMatch(/rival species|founder/);
  });
});

describe("Founders envs", () => {
  it("are four, in their own group, scored on survival alone", () => {
    expect(ENVS.filter((e) => groupOf(e) === "Founders").map((e) => e.id)).toEqual(FOUNDER_ENVS);
    for (const id of FOUNDER_ENVS) {
      const e = envById(id)!;
      expect(e.reward).toEqual({ survive: 1 });
      expect(e.seconds).toBeLessThanOrEqual(180);
      expect(e.poisonDamage).toBe(50);
      expect(e.collisionDamage).toBe(true);
      expect(e.rivals.every((r) => r.source.startsWith("founder:") && FOUNDER_IDS.includes(r.source.slice(8)))).toBe(true);
      expect(typeof checkEnv(e, "ecosystem", 0)).toBe("object"); // the gate takes the env as a custom one
    }
  });

  it("end a creature that stands still well before the end", () => {
    for (const id of FOUNDER_ENVS) {
      const env = envById(id)!;
      const rl = randomLearner(env, 1);
      const r = runEpisode(env, { ...rl, genome: new Float32Array(rl.genome.length) }, 7, null, library);
      expect(r.died, id).toBe(1);
      expect(r.reward, id).toBeLessThan(env.seconds * 0.6);
    }
  });
});
