import { createRng } from "../../src/typescript/src/sim/rng.ts";
import { layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { layoutConfig, randomLearner, scoreLearner } from "../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { Ppo } from "../../src/typescript/src/sim/rl/ppo.ts";
import { assertSameSettings } from "../../src/typescript/src/sim/rl/resume.ts";
import { Es } from "../../src/typescript/src/sim/rl/es.ts";
import { Trainer } from "../../src/typescript/src/sim/rl/trainer.ts";
import type { RlTask, Scorer } from "../../src/typescript/src/sim/rl/trainer.ts";

const env = { ...envById("nibble")!, seconds: 3 };
const learner = randomLearner(env, 1);
const sizes = layerSizes(layoutConfig(env.world), learner.plan);
const json = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T; // a state goes through a file

describe("resume", () => {
  it("PPO: save, load into a new run and carry on equals one uninterrupted run, bit for bit", () => {
    const make = () => new Ppo([env], learner, sizes, { episodes: 2, epochs: 1, logStdMin: -1 }, 7);
    const whole = make();
    for (let i = 0; i < 4; i++) whole.step();
    const first = make();
    for (let i = 0; i < 2; i++) first.step();
    const second = make();
    second.load(json(first.save()));
    for (let i = 0; i < 2; i++) second.step();
    expect(Array.from(second.theta)).toEqual(Array.from(whole.theta));
    expect(Array.from(second.logStd)).toEqual(Array.from(whole.logStd));
    expect(json(second.save())).toEqual(json(whole.save()));
    expect(Array.from(whole.theta)).not.toEqual(Array.from(learner.genome)); // the runs did move
  });

  it("ES: save, load into a new trainer and carry on equals one uninterrupted run, bit for bit", async () => {
    const scorer: Scorer = { rewards: async (tasks: readonly RlTask[]) => tasks.map((t) => scoreLearner(env, { plan: learner.plan, genome: t.genome }, [t.seed]).reward) };
    const make = () => new Trainer(Float32Array.from(learner.genome), { pairs: 2, sigma: 0.08, lr: 0.02 }, scorer, 1, 1, 5);
    const whole = make();
    for (let i = 0; i < 4; i++) await whole.step();
    const first = make();
    for (let i = 0; i < 2; i++) await first.step();
    const second = make();
    second.load(json(first.save()));
    for (let i = 0; i < 2; i++) await second.step();
    expect(Array.from(second.theta)).toEqual(Array.from(whole.theta));
    expect(json(second.save())).toEqual(json(whole.save()));
    expect(Array.from(whole.theta)).not.toEqual(Array.from(learner.genome));
  });

  it("ES: load refuses noise drawn for another number of pairs, and non-finite values", () => {
    const small = new Es(Float32Array.from(learner.genome), { pairs: 2 });
    small.prepare(createRng(1));
    const saved = json(small.save());
    expect(() => new Es(Float32Array.from(learner.genome), { pairs: 3 }).load(saved)).toThrow("pairs");
    expect(() => new Es(Float32Array.from(learner.genome), { pairs: 2 }).load(json({ ...saved, m: saved.m.map(() => NaN) }))).toThrow("non-finite");
    expect(() => new Es(Float32Array.from(learner.genome), { pairs: 2 }).load(saved)).not.toThrow();
  });

  it("PPO: load refuses a state with a non-finite number", () => {
    const make = () => new Ppo([env], learner, sizes, { episodes: 2, epochs: 1 }, 7);
    const saved = json(make().save());
    expect(() => make().load({ ...saved, critic: saved.critic.map(() => NaN) })).toThrow("non-finite");
    expect(() => make().load({ ...saved, policyAdam: { ...saved.policyAdam, m: saved.policyAdam.m.map(() => NaN) } })).toThrow("non-finite");
  });

  it("settings: equal after a JSON round trip, a difference is named", () => {
    const a = { pairs: 2, from: "random:1", plan: { rayCount: 3 } };
    expect(() => assertSameSettings(json(a), a)).not.toThrow();
    expect(() => assertSameSettings(json(a), { ...a, pairs: 3 })).toThrow(/pairs: saved 2, now 3/);
    expect(() => assertSameSettings(json(a), { ...a, plan: { rayCount: 4 } })).toThrow("plan");
  });
});
