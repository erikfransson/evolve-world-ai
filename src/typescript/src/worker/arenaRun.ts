import { deriveSeed } from "../sim/rng.ts";
import type { PoolEntry } from "../sim/seedPool.ts";
import type { EnvSpec, Library } from "../sim/rl/env.ts";
import { serialiseLearner } from "../sim/rl/library.ts";
import { recordingBuffers } from "../sim/rl/recording.ts";
import { BackpropTrainer } from "../sim/rl/ppo.ts";
import { Trainer, heldSeeds } from "../sim/rl/trainer.ts";
import type { RlTrainer } from "../sim/rl/trainer.ts";
import type { RlPool, RlSetup } from "./rlPool.ts";
import { Pacer, gentleController } from "./pacer.ts";
import type { DutyController } from "./pacer.ts";
import { MAX_SHOW_TILES } from "./rlProtocol.ts";
import type { RlInMessage, RlOutMessage } from "./rlProtocol.ts";

// One Arena training run: ES or backprop steps over the chosen envs, a held-out check every few steps, and a show of the latest best
// candidate whenever the page asks. Pause waits between steps; envs sent while paused apply at the next step.
// Kept apart from the worker's messaging so it runs and is tested in Node with an in-process pool.

const HELD_EVERY = 5;

export type Start = Extract<RlInMessage, { type: "start" }>;
export type Post = (msg: RlOutMessage, transfer?: Transferable[]) => void;

// The page's backprop settings kept within the form's ranges, so a bad message cannot stall or blow up training.
const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
function backpropOptions(o: { lr?: number; episodes?: number } | undefined): { lr: number; episodes: number } {
  return { lr: clamp(o?.lr, 0.0005, 0.01, 0.003), episodes: Math.round(clamp(o?.episodes, 4, 320, 16)) };
}

export class ArenaRun {
  private readonly start: Start;
  private readonly post: Post;
  private readonly pool: RlPool;
  private readonly assets: { pool: PoolEntry[] | null; library: Library };
  private envs: EnvSpec[];
  private readonly heldSeeds: number[]; // a fixed set, the same whatever the run seed, so held-out scores compare across runs
  private gate: { wait: Promise<void>; open: () => void } | null = null; // set while paused
  private nextEnvs: EnvSpec[] | null = null;
  private showWanted = false; // the page asked for a new show; steps run much faster than the page plays them
  private playback: boolean; // false: the page shows no replays (Max speed), so shows are skipped but the last
  private stopped = false;
  private readonly pacer = new Pacer();
  private gentle: DutyController | null = null; // set while Gentle on CPU is on

  constructor(start: Start, assets: { pool: PoolEntry[] | null; library: Library }, makePool: (setup: RlSetup) => RlPool, post: Post) {
    this.start = start;
    this.post = post;
    this.envs = start.envs;
    this.heldSeeds = heldSeeds(Math.round(clamp(start.held, 1, 32, 4)));
    this.playback = start.playback !== false;
    this.assets = assets;
    if (start.gentle) this.setGentle(true);
    this.pool = makePool({ envs: start.envs, plan: start.learner.plan, pool: assets.pool, library: assets.library });
  }

  pause(): void {
    if (this.gate || this.stopped) return;
    let open = (): void => {};
    const wait = new Promise<void>((done) => (open = done));
    this.gate = { wait, open };
  }

  resume(): void {
    this.gate?.open();
    this.gate = null;
  }

  setEnvs(envs: EnvSpec[]): void {
    if (envs.length) this.nextEnvs = envs;
  }

  setGentle(on: boolean): void {
    this.gentle = on ? (this.gentle ?? gentleController()) : null;
  }

  wantShow(): void {
    this.showWanted = true;
  }

  setPlayback(on: boolean): void {
    this.playback = on;
    if (on) this.showWanted = true;
  }

  // Ends the run at its next check and frees the helpers; a run in a pause wakes up to end.
  stop(): void {
    this.stopped = true;
    this.resume();
    this.pool.close();
  }

  async run(): Promise<void> {
    const { learner, options } = this.start;
    const plan = learner.plan;
    const tiles = Math.max(1, Math.min(12, this.start.tiles));
    const genome = Float32Array.from(learner.genome);
    const trainer: RlTrainer =
      this.start.method === "backprop"
        ? new BackpropTrainer({ plan, genome }, this.envs, backpropOptions(options.backprop), this.pool, this.start.seed, this.assets.pool, this.assets.library)
        : new Trainer(genome, options, this.pool, this.envs.length, options.episodes, this.start.seed);
    const t0 = performance.now();
    let lastBest: Float32Array | null = null; // the latest step's best candidate
    const start = await trainer.held(this.heldSeeds);
    if (this.stopped) return;
    this.post({ type: "ready", held: start.mean, perEnv: start.perEnv });
    if (this.playback) await this.show(tiles, 0, trainer.theta);
    while (!this.stopped && trainer.iter < options.iterations) {
      if (this.gate) await this.gate.wait;
      if (this.stopped) return;
      if (this.nextEnvs) {
        // The helpers keep running with the new envs; the held-out reference restarts there, so before and after compare on the same worlds.
        this.envs = this.nextEnvs;
        this.nextEnvs = null;
        this.pool.setEnvs(this.envs);
        trainer.setEnvs(this.pool, this.envs);
        const held = await trainer.held(this.heldSeeds);
        this.post({ type: "rebased", iter: trainer.iter, held: held.mean, perEnv: held.perEnv });
        this.showWanted = true;
      }
      this.pacer.began();
      const began = performance.now();
      const step = await trainer.step();
      lastBest = step.bestGenome;
      const held = step.iter % HELD_EVERY === 0 ? await trainer.held(this.heldSeeds) : null;
      this.post({ type: "iteration", it: { iter: step.iter, train: step.train, best: step.best, held: held?.mean ?? null, perEnv: held?.perEnv ?? null, seconds: (performance.now() - t0) / 1000 } });
      if (held) this.post({ type: "learner", iter: step.iter, learner: serialiseLearner({ plan, genome: trainer.theta }) });
      if (this.showWanted && this.playback) {
        this.showWanted = false;
        await this.show(tiles, step.iter, step.bestGenome);
      }
      if (this.gentle) this.pacer.finished(began, this.gentle.duty());
      await new Promise((done) => setTimeout(done, Math.max(0, this.gentle ? this.pacer.wait() : 0))); // lets pause and envs messages in; with Gentle on CPU also idles
    }
    if (this.stopped) return;
    if (lastBest) await this.show(tiles, trainer.iter, lastBest); // so the tiles end on the trained creature
    if (this.stopped) return;
    this.post({ type: "learner", iter: trainer.iter, learner: serialiseLearner({ plan, genome: trainer.theta }) });
    this.post({ type: "done", iter: trainer.iter });
    this.stop();
  }

  private async show(tiles: number, iter: number, genome: Float32Array): Promise<void> {
    const count = this.start.tilesPerEnv ? Math.min(MAX_SHOW_TILES, tiles * this.envs.length) : tiles;
    const tasks = Array.from({ length: count }, (_, k) => ({ env: k % this.envs.length, genome, seed: deriveSeed(iter, k, 0x5404) }));
    const recordings = await this.pool.recordings(tasks, 2, (k) => k === 0);
    if (this.stopped) return;
    this.post({ type: "show", iter, genome, recordings }, recordings.flatMap(recordingBuffers));
  }
}
