import { randomLearner } from "../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec } from "../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { serialiseLearner } from "../../src/typescript/src/sim/rl/library.ts";
import { ArenaRun } from "../../src/typescript/src/worker/arenaRun.ts";
import type { Start } from "../../src/typescript/src/worker/arenaRun.ts";
import { RlPool, inlineRlPort } from "../../src/typescript/src/worker/rlPool.ts";
import type { RlPort } from "../../src/typescript/src/worker/rlPool.ts";
import type { RlOutMessage } from "../../src/typescript/src/worker/rlProtocol.ts";

const short = (id: string): EnvSpec => ({ ...envById(id)!, seconds: 3 });
const learner = serialiseLearner(randomLearner(short("nibble"), 2));
const start = (iterations: number, envs = [short("nibble")]): Start => ({
  type: "start",
  envs,
  learner,
  options: { pairs: 2, sigma: 0.08, lr: 0.02, decay: 0.005, episodes: 1, iterations },
  tiles: 2,
  seed: 1,
  poolUrl: "",
  libraryUrl: "",
});
const assets = { pool: null, library: {} };
const inline = (setup: ConstructorParameters<typeof RlPool>[1]) => new RlPool([inlineRlPort()], setup);
const types = (out: RlOutMessage[]): string[] => out.map((m) => m.type);
const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe("ArenaRun", () => {
  it("trains to the end: ready, iterations, held-out checks, a last show of the best, done", async () => {
    const out: RlOutMessage[] = [];
    await new ArenaRun(start(6), assets, inline, (m) => out.push(m)).run();
    expect(types(out).filter((t) => t === "iteration")).toHaveLength(6);
    expect(types(out).slice(0, 2)).toEqual(["ready", "show"]);
    expect(types(out).slice(-3)).toEqual(["show", "learner", "done"]);
    expect(out.filter((m) => m.type === "iteration" && m.it.held !== null)).toHaveLength(1); // every 5th
  });

  it("holds between steps while paused and goes on after resume", async () => {
    const out: RlOutMessage[] = [];
    const run = new ArenaRun(start(3), assets, inline, (m) => out.push(m));
    run.pause();
    const done = run.run();
    for (let k = 0; k < 20; k++) await tick();
    expect(types(out)).not.toContain("iteration");
    run.resume();
    await done;
    expect(types(out)).toContain("done");
  });

  it("switches envs while paused: the held-out reference restarts on the new set", async () => {
    const out: RlOutMessage[] = [];
    const run = new ArenaRun(start(5), assets, inline, (m) => out.push(m));
    run.pause();
    const done = run.run();
    for (let k = 0; k < 20; k++) await tick();
    run.setEnvs([short("nibble"), short("minefield")]);
    run.resume();
    await done;
    const rebased = out.find((m) => m.type === "rebased");
    expect(rebased?.type === "rebased" && rebased.perEnv).toHaveLength(2);
    const lastHeld = out.filter((m) => m.type === "iteration" && m.it.perEnv).at(-1);
    expect(lastHeld?.type === "iteration" && lastHeld.it.perEnv).toHaveLength(2);
  });

  it("rejects when the helpers fail, so the worker can report it", async () => {
    const broken: RlPort = { post: () => {}, onMessage: () => {}, onError: (cb) => queueMicrotask(() => cb(new Error("boom"))), terminate: () => {} };
    const run = new ArenaRun(start(3), assets, (setup) => new RlPool([broken], setup, () => broken), () => {});
    await expect(run.run()).rejects.toThrow(/boom/);
  });
});
