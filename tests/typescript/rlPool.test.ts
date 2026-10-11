import { deriveSeed } from "../../src/typescript/src/sim/rng.ts";
import { randomLearner, scoreLearner } from "../../src/typescript/src/sim/rl/env.ts";
import type { EnvSpec, Library } from "../../src/typescript/src/sim/rl/env.ts";
import { envById } from "../../src/typescript/src/sim/rl/envs.ts";
import { recordEpisode } from "../../src/typescript/src/sim/rl/recording.ts";
import { createNodeRlPool } from "../../src/typescript/src/worker/nodePool.ts";
import { RlPool, inlineRlPort, rlHelper } from "../../src/typescript/src/worker/rlPool.ts";
import type { RlDone, RlJob, RlPort, RlSetup, RlTask } from "../../src/typescript/src/worker/rlPool.ts";

const short = (id: string): EnvSpec => ({ ...envById(id)!, seconds: 6 });
const envs = [short("minefield"), short("rivals")];
const learner = randomLearner(envs[0]!, 3);
const library: Library = {};
const setup: RlSetup = { envs, plan: learner.plan, pool: null, library };
const genomes = [0, 1, 2].map((k) => Float32Array.from(learner.genome, (v, i) => v + 0.05 * Math.sin(i + k)));
const tasks: RlTask[] = genomes.flatMap((genome) => envs.flatMap((_, env) => [11, 12, 13].map((seed) => ({ env, genome, seed }))));
const serialRewards = tasks.map((t) => scoreLearner(envs[t.env]!, { plan: learner.plan, genome: t.genome }, [t.seed], null, library).reward);

// A helper on this thread that replies in a scrambled order, as threads with episodes of different lengths do.
function scrambledPort(): RlPort {
  const help = rlHelper();
  let callback: (done: RlDone) => void = () => {};
  const held: RlDone[] = [];
  return {
    post: (job: RlJob) => {
      const done = help(job);
      if (!done) return;
      held.unshift(done); // newest first
      queueMicrotask(() => held.length && callback(held.shift()!));
    },
    onMessage: (cb) => { callback = cb; },
    onError: () => {},
    terminate: () => {},
  };
}

describe("RlPool", () => {
  it("rejects, instead of hanging, when an episode throws, on this thread or a helper", async () => {
    for (const pool of [new RlPool([inlineRlPort()], setup), new RlPool([scrambledPort(), scrambledPort()], setup)]) {
      await expect(pool.rewards([{ env: 99, genome: genomes[0]!, seed: 1 }])).rejects.toThrow(/episode failed/);
      await expect(pool.rewards(tasks)).rejects.toThrow(/episode failed/); // the pool stays broken
    }
  });

  it("gives the serial rewards from one inline helper", async () => {
    const pool = new RlPool([inlineRlPort()], setup);
    expect(await pool.rewards(tasks)).toEqual(serialRewards);
  });

  it("gives the serial rewards in task order from several helpers answering out of order", async () => {
    const pool = new RlPool([scrambledPort(), scrambledPort(), scrambledPort()], setup);
    expect(await pool.rewards(tasks)).toEqual(serialRewards);
  });

  it("gives the serial rewards from worker_threads", async () => {
    const pool = createNodeRlPool(setup, 3);
    try {
      expect(await pool.rewards(tasks)).toEqual(serialRewards);
    } finally {
      pool.close();
    }
  });

  it("records the same episodes as recordEpisode, with inputs only where asked", async () => {
    const pool = createNodeRlPool(setup, 2);
    try {
      const shows = genomes.map((genome, k) => ({ env: k % 2, genome, seed: deriveSeed(5, k, 0x5404) }));
      const got = await pool.recordings(shows, 2, (k) => k === 0);
      shows.forEach((t, k) => {
        const want = recordEpisode(envs[t.env]!, { plan: learner.plan, genome: t.genome }, t.seed, null, library, 2, k === 0);
        expect(got[k]!.result).toEqual(want.result);
        expect(got[k]!.frames).toBe(want.frames);
        expect(got[k]!.inputSize).toBe(want.inputSize);
        expect(got[k]!.creatureData).toEqual(want.creatureData);
      });
      expect(got[0]!.inputSize).toBeGreaterThan(0);
      expect(got[1]!.inputSize).toBe(0);
    } finally {
      pool.close();
    }
  });

  it("falls back to the caller's thread when the helpers fail before a result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail: (error: unknown) => void = () => {};
    const broken: RlPort = { post: () => {}, onMessage: () => {}, onError: (cb) => { fail = cb; }, terminate: () => {} };
    const pool = new RlPool([broken], setup);
    const result = pool.rewards(tasks);
    fail(new Error("no nested workers"));
    expect(await result).toEqual(serialRewards);
    warn.mockRestore();
  });

  it("rejects after a helper dies mid-run, and after close", async () => {
    let fail: (error: unknown) => void = () => {};
    let seen = 0;
    const help = rlHelper();
    const dying: RlPort = {
      post: (job) => {
        const done = help(job);
        if (done && ++seen === 3) fail(new Error("helper died"));
        else if (done) queueMicrotask(() => cb(done));
      },
      onMessage: (c) => { cb = c; },
      onError: (c) => { fail = c; },
      terminate: () => {},
    };
    let cb: (done: RlDone) => void = () => {};
    const pool = new RlPool([dying], setup);
    await expect(pool.rewards(tasks)).rejects.toThrow("helper died");
    await expect(pool.rewards(tasks)).rejects.toThrow("helper died");
    const closed = new RlPool([inlineRlPort()], setup);
    closed.close();
    await expect(closed.rewards(tasks)).rejects.toThrow("closed");
  });
});

describe("RlPool watchdog", () => {
  it("fails a batch whose helpers never answer", async () => {
    vi.useFakeTimers();
    try {
      const silent: RlPort = { post: () => {}, onMessage: () => {}, onError: () => {}, terminate: () => {} };
      const pool = new RlPool([silent], setup);
      const run = pool.rewards(tasks.slice(0, 1));
      const caught = run.catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(121_000);
      expect(await caught).toMatch(/no episode result/);
    } finally {
      vi.useRealTimers();
    }
  });
});
