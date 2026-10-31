import { randomLearner } from "../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec } from "../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { serialiseLearner } from "../../src/typescript/src/sim/rl/library.ts";
import { ArenaRun } from "../../src/typescript/src/worker/arenaRun.ts";
import type { Start } from "../../src/typescript/src/worker/arenaRun.ts";
import { RlPool, inlineRlPort } from "../../src/typescript/src/worker/rlPool.ts";
import type { RlPort } from "../../src/typescript/src/worker/rlPool.ts";
import type { RlOutMessage, TrainMethod } from "../../src/typescript/src/worker/rlProtocol.ts";

const short = (id: string): EnvSpec => ({ ...envById(id)!, seconds: 3 });
const learner = serialiseLearner(randomLearner(short("nibble"), 2));
const startOf = (iterations: number, envs = [short("nibble")], method: TrainMethod = "es"): Start => ({
  type: "start",
  envs,
  learner,
  method,
  options: { pairs: 2, sigma: 0.08, lr: 0.02, decay: 0.005, episodes: 1, iterations, backprop: { episodes: 2 } },
  tiles: 2,
  seed: 1,
  poolUrl: "",
  libraryUrl: "",
});
const assets = { pool: null, library: {} };
const inline = (setup: ConstructorParameters<typeof RlPool>[1]) => new RlPool([inlineRlPort()], setup);
const types = (out: RlOutMessage[]): string[] => out.map((m) => m.type);
const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe.each(["es", "backprop"] as const)("ArenaRun with %s", (method) => {
  const start = (iterations: number, envs = [short("nibble")]): Start => startOf(iterations, envs, method);

  it("trains to the end: ready, iterations, held-out checks, a last show of the best, done", async () => {
    const out: RlOutMessage[] = [];
    await new ArenaRun(start(6), assets, inline, (m) => out.push(m)).run();
    expect(types(out).filter((t) => t === "iteration")).toHaveLength(6);
    expect(types(out).slice(0, 2)).toEqual(["ready", "show"]);
    expect(types(out).slice(-3)).toEqual(["show", "learner", "done"]);
    expect(out.filter((m) => m.type === "iteration" && m.it.held !== null)).toHaveLength(1); // every 5th
  });

  it("playback off (Max): no shows while stepping, only the final one; same results; on again asks for a show", async () => {
    const full: RlOutMessage[] = [];
    await new ArenaRun(start(6), assets, inline, (m) => full.push(m)).run();
    const out: RlOutMessage[] = [];
    const run = new ArenaRun({ ...start(6), playback: false }, assets, inline, (m) => out.push(m));
    run.wantShow(); // e.g. the page's tiles finished, or a rebase
    await run.run();
    expect(types(out).filter((t) => t === "show")).toHaveLength(1);
    expect(types(out).slice(-3)).toEqual(["show", "learner", "done"]);
    const trace = (o: RlOutMessage[]) => o.flatMap((m) => (m.type === "iteration" ? [[m.it.train, m.it.best]] : []));
    expect(trace(out)).toEqual(trace(full));

    const again: RlOutMessage[] = [];
    const r2 = new ArenaRun({ ...start(4), playback: false }, assets, inline, (m) => again.push(m));
    r2.setPlayback(true);
    await r2.run();
    expect(types(again).filter((t) => t === "show").length).toBeGreaterThan(1); // one at the next step end, one final
  });

  it("with tiles per env, shows that many of every env, also after the envs change", async () => {
    const out: RlOutMessage[] = [];
    const run = new ArenaRun({ ...start(3, [short("nibble"), short("minefield")]), tiles: 2, tilesPerEnv: true }, assets, inline, (m) => out.push(m));
    run.pause();
    const done = run.run();
    for (let k = 0; k < 20; k++) await tick();
    run.setEnvs([short("nibble"), short("minefield"), short("corridor")]);
    run.resume();
    await done;
    const counts = out.flatMap((m) => (m.type === "show" ? [m.recordings.length] : []));
    expect(counts[0]).toBe(4);
    expect(counts.at(-1)).toBe(6);
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

  it("gives the same results with Gentle on CPU, which only paces the steps", async () => {
    const scores = async (gentle: boolean): Promise<number[]> => {
      const out: RlOutMessage[] = [];
      const run = new ArenaRun({ ...start(3), gentle }, assets, inline, (m) => out.push(m));
      run.setGentle(gentle);
      await run.run();
      return out.flatMap((m) => (m.type === "iteration" ? [m.it.train, m.it.best] : []));
    };
    expect(await scores(true)).toEqual(await scores(false));
  });

  it("rejects when the helpers fail, so the worker can report it", async () => {
    const broken: RlPort = { post: () => {}, onMessage: () => {}, onError: (cb) => queueMicrotask(() => cb(new Error("boom"))), terminate: () => {} };
    const run = new ArenaRun(start(3), assets, (setup) => new RlPool([broken], setup, () => broken), () => {});
    await expect(run.run()).rejects.toThrow(/boom/);
  });

  it("shows the genome it reports as the learner at the end", async () => {
    const out: RlOutMessage[] = [];
    await new ArenaRun(start(3), assets, inline, (m) => out.push(m)).run();
    const show = out.filter((m) => m.type === "show").at(-1);
    const learnt = out.filter((m) => m.type === "learner").at(-1);
    if (show?.type !== "show" || learnt?.type !== "learner") throw new Error("no show or learner");
    if (method === "backprop") show.genome.forEach((w, i) => expect(w).toBeCloseTo(learnt.learner.genome[i]!, 2));
    expect(show.iter).toBe(3);
  });
});
