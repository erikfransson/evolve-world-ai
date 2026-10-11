import type { PoolEntry } from "../sim/seedPool.ts";
import { runEpisode } from "../sim/rl/env.ts";
import type { EnvSpec, Learner, Library } from "../sim/rl/env.ts";
import { recordEpisode, recordingBuffers } from "../sim/rl/recording.ts";
import type { Recording } from "../sim/rl/recording.ts";
import type { Port } from "./port.ts";

// Episodes of the RL trainer spread over helper threads. A reward is a pure function of genome, env and seed,
// so results come back by task index and do not depend on the thread count.

// Sent once to each helper: everything an episode needs besides its genome.
export interface RlSetup {
  envs: EnvSpec[];
  plan: Learner["plan"];
  pool: PoolEntry[] | null;
  library: Library;
}

export interface RlTask {
  env: number; // index into the setup's envs
  genome: Float32Array;
  seed: number;
}

export type RlJob =
  | ({ type: "setup" } & RlSetup)
  | ({ type: "episode"; id: number } & RlTask)
  | ({ type: "record"; id: number; every: number; inputs: boolean } & RlTask); // inputs: also record the brain input

export type RlDone = { id: number; reward: number } | { id: number; recording: Recording };

export type RlPort = Port<RlJob, RlDone>;

// Body of a helper, shared by the browser and Node entries and the in-process port: a setup replies nothing.
export function rlHelper(): (job: RlJob) => RlDone | null {
  let setup: RlSetup;
  return (job) => {
    if (job.type === "setup") {
      setup = job;
      return null;
    }
    const learner = { plan: setup.plan, genome: job.genome };
    const env = setup.envs[job.env]!;
    if (job.type === "episode") return { id: job.id, reward: runEpisode(env, learner, job.seed, setup.pool, setup.library).reward };
    return { id: job.id, recording: recordEpisode(env, learner, job.seed, setup.pool, setup.library, job.every, job.inputs) };
  };
}

// The buffers of a reply to hand over instead of copy.
export const rlTransferList = (done: RlDone): ArrayBuffer[] => ("recording" in done ? recordingBuffers(done.recording) : []);

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

const IN_FLIGHT = 2; // jobs queued per helper, so it never waits for the next one

interface Run {
  jobs: Omit<Extract<RlJob, { id: number }>, "id">[];
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
  private readonly setup: RlSetup;
  private readonly fallback: () => RlPort;
  private load = new Map<RlPort, number>(); // jobs in flight per port
  private run: Run | null = null;
  private broken: { error: unknown } | null = null;
  private started = false;

  constructor(ports: RlPort[], setup: RlSetup, fallback: () => RlPort = inlineRlPort) {
    this.setup = setup;
    this.fallback = fallback;
    this.ports = ports;
    this.attach(ports);
  }

  // Rewards of the tasks, in task order.
  async rewards(tasks: readonly RlTask[]): Promise<number[]> {
    const done = await this.runAll(tasks.map((t) => ({ type: "episode" as const, ...t })));
    return done.map((d) => (d as { reward: number }).reward);
  }

  // The tasks played and recorded (see recordEpisode), in task order; withInputs says which also keep the brain input.
  async recordings(tasks: readonly RlTask[], every: number, withInputs: (k: number) => boolean): Promise<Recording[]> {
    const done = await this.runAll(tasks.map((t, k) => ({ type: "record" as const, every, inputs: withInputs(k), ...t })));
    return done.map((d) => (d as { recording: Recording }).recording);
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
    }
  }

  private runAll(jobs: Run["jobs"]): Promise<RlDone[]> {
    if (this.broken) return Promise.reject(this.broken.error);
    if (this.run) return Promise.reject(new Error("pool already running"));
    if (!jobs.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      this.run = { jobs, results: new Array(jobs.length), next: 0, remaining: jobs.length, resolve, reject };
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
    this.load.set(port, this.load.get(port)! - 1);
    r.results[done.id] = done;
    if (--r.remaining === 0) {
      this.run = null;
      r.resolve(r.results);
    } else this.dispatch();
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

  private fail(error: unknown): void {
    if (this.broken) return;
    this.broken = { error };
    for (const port of this.ports) port.terminate();
    const r = this.run;
    this.run = null;
    r?.reject(error);
  }
}
