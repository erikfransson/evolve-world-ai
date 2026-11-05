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

describe("drifting rivals (Rivals.speed)", () => {
  const base: EnvSpec = { id: "dr", name: "dr", description: "dr", world: "ecosystem", role: 0, size: [3000, 3000], food: 0, poison: 0, foodRegrow: 0, seconds: 5, rivals: [], collisionDamage: true, reward: { survive: 1 }, tags: [] };
  const withSpeed = (speed: number | undefined, energy = 20): EnvSpec => ({ ...base, rivals: [{ species: 0, count: 1, source: "random", energy, ...(speed === undefined ? {} : { speed }) }] });
  const still = randomLearner(base, 1);

  // The rival's path length over the episode, with the learner far away in a big room.
  const travelled = (env: EnvSpec, seed = 3): number => {
    let last: { x: number; y: number } | null = null;
    let total = 0;
    runEpisode(env, still, seed, null, {}, (eco: Ecosystem) => {
      const s = eco.members.find((m) => m.id === 1)!.creature.state;
      if (last) total += Math.hypot(s.x - last.x, s.y - last.y);
      last = { x: s.x, y: s.y };
    });
    return total;
  };

  it("are deterministic: the same seed gives the same result twice", () => {
    const env = withSpeed(0.1);
    expect(runEpisode(env, still, 5)).toEqual(runEpisode(env, still, 5));
    expect(travelled(env, 9)).toBe(travelled(env, 9));
  });

  it("move slower the lower the speed, and not at all at 0", () => {
    const [d0, d1, d5] = [0, 0.1, 0.5].map((v) => travelled(withSpeed(v)));
    expect(d0).toBeLessThan(0.01);
    expect(d1).toBeGreaterThan(d0 + 5); // top speed 0.1 x 80 = 8 u/s, 3 s, minus the ramp up
    expect(d5).toBeGreaterThan(2 * d1);
  });

  it("heal back to their start energy and no further, and do not starve", () => {
    let hit = false;
    const seen: number[] = [];
    const env = { ...withSpeed(0, 20), seconds: 6 };
    runEpisode(env, still, 3, null, {}, (eco: Ecosystem) => {
      const s = eco.members.find((m) => m.id === 1)!.creature.state;
      if (!hit) { s.energy = 5; hit = true; }
      seen.push(s.energy);
    });
    expect(seen[seen.length - 1]).toBeCloseTo(20, 6);
    expect(Math.max(...seen)).toBeLessThanOrEqual(20);
    expect(seen[60]).toBeGreaterThan(seen[1]!); // regaining after the hit
  });

  it("leave rivals without a speed as they were (no regen, no cap)", () => {
    let e = 0;
    runEpisode({ ...withSpeed(undefined, 20), seconds: 2 }, still, 3, null, {}, (eco: Ecosystem) => { e = eco.members.find((m) => m.id === 1)!.creature.state.energy; });
    expect(e).toBeLessThan(20); // pays living cost
  });

  it("are checked: speed must lie in 0 to 1 and survives checkEnv", () => {
    const ok = checkEnv(withSpeed(0.2), "ecosystem", 0);
    expect(typeof ok).not.toBe("string");
    expect((ok as EnvSpec).rivals[0]!.speed).toBe(0.2);
    for (const bad of [-0.1, 1.5, NaN, "0.1"]) expect(typeof checkEnv({ ...base, rivals: [{ species: 0, count: 1, source: "random", speed: bad }] }, "ecosystem", 0)).toBe("string");
    expect((checkEnv({ ...base, rivals: [{ species: 0, count: 1, source: "random" }] }, "ecosystem", 0) as EnvSpec).rivals[0]).not.toHaveProperty("speed");
  });
});
