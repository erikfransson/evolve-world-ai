import { checkEnv, randomLearner, runEpisode } from "../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec } from "../../src/typescript/src/sim/rl/env.ts";
import type { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { ENVS, envById, groupOf } from "../../src/typescript/src/sim/rl/envs.ts";

const NEW_FIGHT = ["ambush", "turf-war", "cull", "corral"];

describe("fight envs", () => {
  it("are filed under Fight, keep within the custom env limits and play an episode", () => {
    for (const id of NEW_FIGHT) {
      const env = envById(id)!;
      expect(groupOf(env)).toBe("Fight");
      expect(typeof checkEnv(JSON.parse(JSON.stringify(env)), "ecosystem", 0)).not.toBe("string");
      expect(Number.isFinite(runEpisode({ ...env, seconds: 3 }, randomLearner(env, 1), 7).reward)).toBe(true);
    }
  });

  it("Corral pays rams only", () => {
    const env = envById("corral")!;
    expect(env.reward).toEqual({ ram: 1 });
  });

  it("Fight holds at least four envs", () => {
    expect(ENVS.filter((e) => groupOf(e) === "Fight").length).toBeGreaterThanOrEqual(4);
  });

  // early pays a ram like a bite: the share of the episode left when the rival dies.
  it("early pays a ram by the share of the episode left", () => {
    const base = checkEnv({ id: "ram-early", name: "Ram", size: [200, 200], food: 0, poison: 0, foodRegrow: 0, seconds: 15, collisionDamage: true, learnerEnergy: 300, rivals: [{ species: 0, count: 1, source: "random", energy: 10 }], reward: { ram: 1 } }, "ecosystem", 0) as EnvSpec;
    let checked = 0;
    for (let seed = 1; seed <= 8; seed++) {
      let eco: Ecosystem | null = null;
      const charge = (c: { state: { x: number; y: number; heading: number }; outputs: Float32Array }): void => {
        const rival = eco?.members.find((m) => m.id !== 0)?.creature.state;
        if (!rival) return;
        const turn = Math.atan2(rival.y - c.state.y, rival.x - c.state.x) - c.state.heading;
        c.outputs[0] = Math.max(-1, Math.min(1, 3 * Math.atan2(Math.sin(turn), Math.cos(turn))));
        c.outputs[1] = 1;
      };
      const run = (reward: EnvSpec["reward"]) => runEpisode({ ...base, reward }, randomLearner(base, seed), seed, null, undefined, (e) => (eco = e), charge as never);
      const ram = run({ ram: 1 });
      if (ram.rams === 0) continue;
      const early = run({ early: 1 });
      expect(early.reward).toBeGreaterThan(0);
      expect(early.reward).toBeLessThan(ram.reward);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
