import type { PoolEntry } from "../sim/seedPool.ts";
import { SELF, runEpisode } from "../sim/rl/env.ts";
import type { EnvSpec, Learner, Library } from "../sim/rl/env.ts";
import { playRollout } from "../sim/rl/ppo.ts";
import type { Rollout, RolloutTask } from "../sim/rl/ppo.ts";
import { recordEpisode, recordingBuffers } from "../sim/rl/recording.ts";
import type { Recording } from "../sim/rl/recording.ts";
import type { RlTask } from "../sim/rl/trainer.ts";
import type { Port } from "./port.ts";

export type { RlTask } from "../sim/rl/trainer.ts";

// Episodes of the RL trainer spread over helper threads. A reward is a pure function of genome, env and seed,
// so results come back by task index and do not depend on the thread count.

// Sent once to each helper: everything an episode needs besides its genome.
export interface RlSetup {
  envs: EnvSpec[];
  plan: Learner["plan"];
  pool: PoolEntry[] | null;
  library: Library;
}


export type RlJob =
  | ({ type: "setup" } & RlSetup)
  | { type: "league"; genomes: Float32Array[] } // the self-play rivals from now on (see SELF)
  | ({ type: "episode"; id: number } & RlTask)
  | ({ type: "rollout"; id: number } & RolloutTask) // a stochastic episode of backprop RL, played against a mirror of the learner
  | { type: "batch"; id: number; genomes: Float32Array[]; tasks: Float64Array } // episodes in a row: triples (env, index into genomes, seed)
  | ({ type: "record"; id: number; every: number; inputs: boolean } & RlTask); // inputs: also record the brain input

export type RlDone = { id: number; reward: number } | { id: number; rewards: Float64Array } | { id: number; recording: Recording } | { id: number; rollout: Rollout } | { id: number; error: string }; // error: the episode threw

export type RlPort = Port<RlJob, RlDone>;

// Body of a helper, shared by the browser and Node entries and the in-process port: a setup replies nothing, and an episode
// that throws replies with the error, so the pool can tell a bad episode from a helper that never started.
export function rlHelper(): (job: RlJob) => RlDone | null {
  let setup: RlSetup;
  let base: Library; // without the league, which rollouts do not use
  return (job) => {
    if (job.type === "setup") {
      setup = job;
      base = job.library;
      return null;
    }
    if (job.type === "league") {
      const league = job.genomes.map((genome) => ({ plan: setup.plan, genome }));
      setup = { ...setup, library: Object.assign(Object.create(null) as Library, setup.library, { [SELF]: league }) };
      return null;
    }
    try {
      if (job.type === "batch") {
        const rewards = new Float64Array(job.tasks.length / 3);
        const learners = job.genomes.map((genome) => ({ plan: setup.plan, genome }));
        for (let k = 0; k < rewards.length; k++) {
          const env = setup.envs[job.tasks[3 * k]!]!;
          rewards[k] = runEpisode(env, learners[job.tasks[3 * k + 1]!]!, job.tasks[3 * k + 2]!, setup.pool, setup.library).reward;
        }
        return { id: job.id, rewards };
      }
      const env = setup.envs[job.env]!;
      if (job.type === "rollout") return { id: job.id, rollout: playRollout(env, setup.plan, job, setup.pool, base) };
      const learner = { plan: setup.plan, genome: job.genome };
      if (job.type === "episode") return { id: job.id, reward: runEpisode(env, learner, job.seed, setup.pool, setup.library).reward };
      return { id: job.id, recording: recordEpisode(env, learner, job.seed, setup.pool, setup.library, job.every, job.inputs) };
    } catch (error) {
      return { id: job.id, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

// The buffers of a reply to hand over instead of copy.
export const rlTransferList = (done: RlDone): ArrayBuffer[] => {
  if ("recording" in done) return recordingBuffers(done.recording);
  if ("rollout" in done) {
    const r = done.rollout;
    return [r.obs.buffer, r.z.buffer, r.logp.buffer, r.adv.buffer, r.ret.buffer] as ArrayBuffer[];
  }
  return [];
};

// A helper that runs on the caller's thread, for one thread and for tests.
export function inlineRlPort(): RlPort {
  const helper = rlHelper();
  let callback: (done: RlDone) => void = () => {};
  return {
    post: (job) => {
      const done = helper(job);
      if (done) queueMicrotask(() => callback(done));
    },
    onMessage: (cb) => { callback = cb; },
    onError: () => {},
    terminate: () => {},
  };
}

const STALL_MS = 120_000; // no result at all for this long fails the run: an episode takes well under a second
const CHUNKS_PER_PORT = 6; // batches per helper in a call of rewards()
const MAX_BATCH = 16; // episodes per batch at most, so one batch stays far inside STALL_MS even with few helpers
const IN_FLIGHT = 2; // jobs queued per helper, so it never waits for the next one

interface Run {
  jobs: (Extract<RlJob, { id: number }> extends infer J ? (J extends unknown ? Omit<J, "id"> : never) : never)[]; // Omit per job kind, not over the union
  results: RlDone[];
  next: number; // first job not yet handed out
  remaining: number;
  resolve: (results: RlDone[]) => void;
  reject: (error: unknown) => void;
}

// Hands jobs one by one to the helpers with room (episodes differ a lot in length, since a learner can die early) and gathers the results in job order.
// A failure before the first result switches to `fallback` (e.g. the browser cannot start nested workers); a later one, or close(), breaks the pool for good.
export class RlPool {
  private ports: RlPort[];
  private setup: RlSetup;
  private readonly fallback: () => RlPort;
  private load = new Map<RlPort, number>(); // jobs in flight per port
  private run: Run | null = null;
  private broken: { error: unknown } | null = null;
  private started = false;
  private league: Float32Array[] | null = null; // sent again to a fallback port

  constructor(ports: RlPort[], setup: RlSetup, fallback: () => RlPort = inlineRlPort) {
    this.setup = setup;
    this.fallback = fallback;
    this.ports = ports;
    this.attach(ports);
  }

  // Rewards of the tasks, in task order.
  async rewards(tasks: readonly RlTask[]): Promise<number[]> {
    // Chunks of consecutive tasks (genome by genome), so a genome crosses to a helper once per chunk, and a few chunks per helper to balance load.
    const size = Math.max(1, Math.min(MAX_BATCH, Math.ceil(tasks.length / (this.ports.length * CHUNKS_PER_PORT))));
    const jobs: Run["jobs"] = [];
    for (let from = 0; from < tasks.length; from += size) {
      const end = Math.min(tasks.length, from + size);
      const index = new Map<Float32Array, number>();
      const genomes: Float32Array[] = [];
      const triples = new Float64Array(3 * (end - from));
      for (let k = from; k < end; k++) {
        const t = tasks[k]!;
        let gi = index.get(t.genome);
        if (gi === undefined) index.set(t.genome, (gi = genomes.push(t.genome) - 1));
        triples.set([t.env, gi, t.seed], 3 * (k - from));
      }
      jobs.push({ type: "batch", genomes, tasks: triples });
    }
    const done = await this.runAll(jobs);
    return done.flatMap((d) => Array.from((d as { rewards: Float64Array }).rewards));
  }

  // Backprop RL's stochastic episodes, in task order.
  async rollouts(tasks: readonly RolloutTask[]): Promise<Rollout[]> {
    const done = await this.runAll(tasks.map((t) => ({ type: "rollout" as const, ...t })));
    return done.map((d) => (d as { rollout: Rollout }).rollout);
  }

  // The tasks played and recorded (see recordEpisode), in task order; withInputs says which also keep the brain input.
  async recordings(tasks: readonly RlTask[], every: number, withInputs: (k: number) => boolean): Promise<Recording[]> {
    const done = await this.runAll(tasks.map((t, k) => ({ type: "record" as const, every, inputs: withInputs(k), ...t })));
    return done.map((d) => (d as { recording: Recording }).recording);
  }

  // Other envs for the episodes that follow: the helpers keep running and get the new setup (and the league again).
  setEnvs(envs: EnvSpec[]): void {
    if (this.broken) return;
    this.setup = { ...this.setup, envs };
    for (const port of this.ports) {
      port.post({ type: "setup", ...this.setup });
      if (this.league) port.post({ type: "league", genomes: this.league });
    }
  }

  // Self-play rivals for the episodes that follow (helpers handle messages in order).
  setLeague(genomes: readonly Float32Array[]): void {
    if (this.broken) return;
    this.league = genomes.map((g) => Float32Array.from(g));
    for (const port of this.ports) port.post({ type: "league", genomes: this.league });
  }

  close(): void {
    this.fail(new Error("pool closed"));
  }

  private attach(ports: RlPort[]): void {
    for (const port of ports) {
      this.load.set(port, 0);
      port.onMessage((done) => this.handleDone(port, done));
      port.onError((error) => this.handleError(port, error));
      port.post({ type: "setup", ...this.setup });
      if (this.league) port.post({ type: "league", genomes: this.league });
    }
  }

  private runAll(jobs: Run["jobs"]): Promise<RlDone[]> {
    if (this.broken) return Promise.reject(this.broken.error);
    if (this.run) return Promise.reject(new Error("pool already running"));
    if (!jobs.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      this.run = { jobs, results: new Array(jobs.length), next: 0, remaining: jobs.length, resolve, reject };
      this.arm();
      this.dispatch();
    });
  }

  private dispatch(): void {
    const r = this.run;
    if (!r) return;
    for (const port of this.ports) {
      while (r.next < r.jobs.length && this.load.get(port)! < IN_FLIGHT) {
        const id = r.next++;
        this.load.set(port, this.load.get(port)! + 1);
        port.post({ ...r.jobs[id]!, id } as RlJob);
      }
    }
  }

  private handleDone(port: RlPort, done: RlDone): void {
    const r = this.run;
    if (!r || r.results[done.id]) return;
    this.started = true;
    if ("error" in done) return this.fail(new Error(`episode failed: ${done.error}`));
    this.load.set(port, this.load.get(port)! - 1);
    r.results[done.id] = done;
    if (--r.remaining === 0) {
      this.disarm();
      this.run = null;
      r.resolve(r.results);
    } else {
      this.arm();
      this.dispatch();
    }
  }

  private handleError(port: RlPort, error: unknown): void {
    if (!this.ports.includes(port)) return; // a port already replaced
    if (this.started || this.broken) return this.fail(error);
    console.warn("Helper threads failed to start, running serially:", error);
    for (const port of this.ports) port.terminate();
    this.started = true; // one fallback only
    this.ports = [this.fallback()];
    this.load.clear();
    this.attach(this.ports);
    if (this.run) this.run.next = 0; // nothing had finished, so every job goes again
    this.dispatch();
  }

  private watchdog: ReturnType<typeof setTimeout> | null = null;

  // (Re)starts the no-progress timer of the running batch.
  private arm(): void {
    this.disarm();
    this.watchdog = setTimeout(() => this.fail(new Error(`no episode result for ${STALL_MS / 1000} s, the helper threads seem stuck`)), STALL_MS);
  }

  private disarm(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private fail(error: unknown): void {
    this.disarm();
    if (this.broken) return;
    this.broken = { error };
    for (const port of this.ports) port.terminate();
    const r = this.run;
    this.run = null;
    r?.reject(error);
  }
}
