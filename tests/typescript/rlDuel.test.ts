import { charger, checkEnv, runEpisode, variantFor } from "../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec } from "../../src/typescript/src/sim/rl/env.ts";
import { recordEpisode } from "../../src/typescript/src/sim/rl/recording.ts";
import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import { Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { restoreState, saveState } from "../../src/typescript/src/sim/ecoState.ts";

const duel = (le: number, re: number): EnvSpec => ({
  id: "d", name: "d", description: "d", world: "ecosystem", role: 0, size: [600, 600], food: 0, poison: 0, foodRegrow: 0, seconds: 6, rivals: [], collisionDamage: true,
  duel: { distance: [150, 150], bearing: [0, 0], speed: [1, 1], offset: [0, 0], learnerEnergy: [le, le], rivalEnergy: [re, re] }, reward: { ram: 1 }, tags: [],
});
const still = charger("ecosystem", 0);

describe("duel envs (#44)", () => {
  it("send a charger straight at the learner: a strong one kills a weak learner that stands still", () => {
    const r = runEpisode(duel(10, 250), still, 1);
    expect(r.seconds).toBeLessThan(3); // hit after about 2 s, long before the learner would starve
  });

  it("let a strong learner that stands still survive a strong charger's hit", () => {
    const r = runEpisode(duel(250, 250), still, 1);
    expect(r.seconds).toBe(6);
    expect(r.energy).toBeLessThan(250 - 6 * 1.5 - 10); // upkeep plus the hit
  });

  it("credit a weak charger that dies on the learner as a ram, with killEnergy on top, and keep kills for hunts", () => {
    const plain = runEpisode(duel(250, 30), still, 1);
    expect(plain.rams).toBe(1);
    expect(plain.kills).toBe(0); // kills count hunts only, so a kill reward never pays a bump twice
    const bonus = runEpisode({ ...duel(250, 30), killEnergy: 40 }, still, 1);
    expect(bonus.energy).toBeCloseTo(plain.energy + 40, 3);
  });

  it("report a lethal bump through the ecosystem's onBumpKill hook, survivor first", () => {
    const calls: [number, number][] = [];
    let hooked = false;
    runEpisode(duel(250, 30), still, 1, null, {}, (eco) => {
      if (hooked) return;
      hooked = true;
      eco.onBumpKill = (survivor, victim) => calls.push([survivor.energy, victim.energy]);
    });
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBeGreaterThan(0);
    expect(calls[0]![1]).toBeLessThanOrEqual(0);
  });

  it("start the charger its full distance away, also when the learner is drawn by a wall", () => {
    const env: EnvSpec = { ...duel(250, 250), size: [400, 400], duel: { ...duel(250, 250).duel!, distance: [150, 150], bearing: [-Math.PI, Math.PI] } };
    for (let seed = 1; seed <= 30; seed++) {
      let gap = 0;
      runEpisode(env, still, seed, null, {}, (eco) => {
        if (gap) return;
        const [a, b] = eco.members.map((m) => m.creature.state);
        gap = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      });
      expect(gap, `seed ${seed}`).toBeGreaterThan(145); // one tick of motion at most
    }
  });

  it("count a lethal bump as the survivor's bump kill, kept apart from hunts and through a save (#52)", () => {
    let eco: Ecosystem | null = null;
    let kills: [number, number] = [-1, -1];
    runEpisode(duel(250, 30), still, 1, null, {}, (e) => {
      eco = e;
      const me = e.get(0);
      if (me) kills = [me.bumpKills, me.kills];
    });
    expect(kills).toEqual([1, 0]);
    const back = restoreState(saveState(eco!));
    expect(back.get(0)!.bumpKills).toBe(1);
  });

  it("keep the onBumpKill hook readable, so it can be chained", () => {
    const eco = new Ecosystem({ ...structuredClone(DEFAULT_ECO_CONFIG), seed: 1 });
    const f = () => {};
    eco.onBumpKill = f;
    expect(eco.onBumpKill).toBe(f);
  });

  it("are checked like other custom envs", () => {
    const { id: _, ...v } = duel(10, 250);
    expect(checkEnv(v, "ecosystem", 0)).not.toBeTypeOf("string");
    expect(checkEnv({ ...v, duel: { ...v.duel, speed: [0.5, 2] } }, "ecosystem", 0)).toMatch(/speed/);
    expect(checkEnv({ ...v, duel: { ...v.duel, distance: [200, 100] } }, "ecosystem", 0)).toMatch(/distance/);
    expect(checkEnv({ ...v, duel: "x" }, "ecosystem", 0)).toBeTypeOf("string");
    expect(checkEnv({ ...v, augment: { energy: 0.3 } }, "ecosystem", 0)).toMatch(/augment/);
    expect(checkEnv({ ...v, collisionDamage: false }, "ecosystem", 0)).toMatch(/collision damage/);
    expect(checkEnv({ ...v, rivals: [{ species: 0, count: 2, source: "random" }] }, "ecosystem", 0)).toMatch(/instead of rivals/);
    expect(checkEnv({ ...v, layout: { kind: "patch", radius: 60 } }, "ecosystem", 0)).toMatch(/no layout/);
    expect(checkEnv({ ...v, duel: { ...v.duel, distance: [100, 290] } }, "ecosystem", 0)).toMatch(/distance/); // 600 wide: at most 270
    expect(checkEnv({ ...v, duel: { ...v.duel, distance: [0, 100] } }, "ecosystem", 0)).toMatch(/distance/);
  });
});

describe("augment (#44)", () => {
  const env: EnvSpec = { ...duel(100, 100), duel: undefined, food: 20, poison: 10, foodRegrow: 1, learnerEnergy: 200, rivals: [{ species: 0, count: 6, source: "random", energy: 100 }], augment: { energy: 0.5, count: 0.5, items: 0.5, size: 0.3 } };

  it("draws a variant per seed within the factors, the same one for the same seed", () => {
    const seen = new Set<number>();
    for (let s = 1; s <= 20; s++) {
      const v = variantFor(env, s);
      expect(v).toEqual(variantFor(env, s));
      expect(v.augment).toBeUndefined();
      expect(v.size[0]).toBeGreaterThanOrEqual(420);
      expect(v.size[0]).toBeLessThanOrEqual(780);
      expect(v.food).toBeGreaterThanOrEqual(10);
      expect(v.food).toBeLessThanOrEqual(30);
      expect(v.learnerEnergy!).toBeGreaterThanOrEqual(100);
      expect(v.rivals[0]!.count).toBeGreaterThanOrEqual(3);
      seen.add(v.size[0]);
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it("keeps the rivals within the custom env cap", () => {
    const big: EnvSpec = { ...env, rivals: [{ species: 0, count: 20, source: "random" }, { species: 0, count: 10, source: "random" }], augment: { count: 0.9 } };
    for (let s = 1; s <= 30; s++) expect(variantFor(big, s).rivals.reduce((a, r) => a + r.count, 0)).toBeLessThanOrEqual(30);
  });

  it("records the sides an augmented episode played, and refuses a size factor with a layout", () => {
    const seed = 4;
    expect(recordEpisode(env, still, seed, null, {}).width).toBe(variantFor(env, seed).size[0]);
    expect(variantFor(env, seed).size[0]).not.toBe(env.size[0]);
    const { id: _, ...v } = env;
    expect(checkEnv({ ...v, layout: { kind: "patch", radius: 60 } }, "ecosystem", 0)).toMatch(/layout/);
    expect(checkEnv({ ...v, layout: { kind: "patch", radius: 60 }, augment: { items: 0.3 } }, "ecosystem", 0)).not.toBeTypeOf("string");
  });

  it("leaves an env without augment as it is, and rejects factors out of range", () => {
    const { augment: _, ...plain } = env;
    expect(variantFor(plain, 3)).toBe(plain);
    const { id: __, ...v } = env;
    expect(checkEnv({ ...v, augment: { size: 1.5 } }, "ecosystem", 0)).toMatch(/augment size/);
  });
});

describe("bump kills in saves", () => {
  it("come back 0 from a save without them and are refused when malformed", () => {
    const eco = new Ecosystem({ ...structuredClone(DEFAULT_ECO_CONFIG), seed: 1, eco: { ...DEFAULT_ECO_CONFIG.eco, initialPopulation: 3 } });
    eco.members[1]!.bumpKills = 4;
    const state = saveState(eco);
    expect(state.creatures.bumpKills).toEqual([[1, 4]]);
    expect(restoreState(state).members.map((m) => m.bumpKills)).toEqual([0, 4, 0]);
    const old = structuredClone(state);
    old.creatures.bumpKills = undefined;
    expect(restoreState(old).members.map((m) => m.bumpKills)).toEqual([0, 0, 0]);
    for (const bad of [[[1, -1]], [[1, 1.5]], [[3, 1]], [[1, Number.NaN]], [[1, 2 ** 32]], [[1]], "x", [[0, 1], [1, 1], [2, 1], [0, 1]]]) {
      const s = structuredClone(state);
      (s.creatures as { bumpKills: unknown }).bumpKills = bad;
      expect(() => restoreState(s), JSON.stringify(bad)).toThrow(/bumpKills/);
    }
  });
});

describe("eco.killEnergy in saves", () => {
  it("is refused out of range when a save is restored", () => {
    const eco = new Ecosystem({ ...structuredClone(DEFAULT_ECO_CONFIG), seed: 1, eco: { ...DEFAULT_ECO_CONFIG.eco, initialPopulation: 3 } });
    const state = saveState(eco);
    expect(() => restoreState(state)).not.toThrow();
    for (const bad of [-1, 1e6]) {
      const s = structuredClone(state);
      (s.config as { eco: { killEnergy: number } }).eco.killEnergy = bad;
      expect(() => restoreState(s), String(bad)).toThrow(/killEnergy/);
    }
  });
});
