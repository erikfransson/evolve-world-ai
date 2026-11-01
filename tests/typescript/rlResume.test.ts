import { layerSizes } from "../../src/typescript/src/sim/brain.ts";
import { layoutConfig, randomLearner, scoreLearner } from "../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { Ppo } from "../../src/typescript/src/sim/rl/ppo.ts";
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
});
