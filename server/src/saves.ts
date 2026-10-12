import { LIMITS } from "./config.ts";
import { parseSave } from "./saveParse.ts";
import { OtherWorld } from "./liveWorld.ts";
import type { LiveWorld } from "./liveWorld.ts";
import type { StateStore } from "./state.ts";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const SAVE_MAX_LATE = 20_000; // late lineage rows restoreState accepts (MAX_CREATURES in ecoState.ts)
const UNREADABLE = "SAVE REFUSED: it would not restore, the last good save is kept";

// Saving and restoring the live world. Jobs run one at a time. Only saveState and JSON.stringify block the tick loop, the gzip runs on a worker thread.
export class Saves {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly live: LiveWorld;
  private readonly store: StateStore;

  constructor(live: LiveWorld, store: StateStore) {
    this.live = live;
    this.store = store;
  }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // A short line saying what was saved; rejects with the reason when nothing was.
  save(): Promise<string> {
    return this.exclusive(async () => {
      if (this.live.failedTicks > 0) throw new Error(`its ticks are failing (${this.live.failedTicks} in a row), the last good save is kept`);
      const t0 = performance.now();
      const state = await this.live.whenIdle(() => this.live.saveState());
      if (state.lineages.late.length > SAVE_MAX_LATE) {
        console.error(UNREADABLE);
        throw new Error(`the world has ${state.lineages.late.length} lineage rows, more than a restore accepts (${SAVE_MAX_LATE})`);
      }
      const json = JSON.stringify(state);
      const bytes = Buffer.byteLength(json);
      if (bytes > LIMITS.maxSaveJsonBytes) {
        const why = `the world is ${Math.round(bytes / 1e6)} MB of JSON, over the ${LIMITS.maxSaveJsonBytes / 1e6} MB a save may hold (it could not be read back)`;
        console.error(`SAVE REFUSED: ${why}`);
        throw new Error(why);
      }
      const stallMs = Math.round(performance.now() - t0);
      // The same parse and checks as a restore, on the worker with its heap cap; a save that fails them is never written.
      const verify = (gz: Uint8Array): Promise<unknown> =>
        parseSave(gz, LIMITS.maxSaveJsonBytes, true).catch((e: unknown) => {
          console.error(UNREADABLE);
          throw new Error(`it would not restore: ${errText(e)}`);
        });
      const name = await this.store.write(json, { population: this.live.eco.population, tick: this.live.eco.tick }, new Date(), true, verify);
      return `saved ${name} (${Math.round(json.length / 1e6)} MB json, ${stallMs} ms tick stall)`;
    }).catch((e: unknown) => {
      throw new Error(`not saved: ${errText(e)}`);
    });
  }

  private async restore(name: string): Promise<string> {
    const state = await this.store.read(name);
    await this.live.whenIdle(() => this.live.restoreState(state)); // throws, and keeps the running world, when the save is unusable
    return `${name}: tick ${this.live.eco.tick}, ${this.live.eco.population} creatures`;
  }

  // At startup: the newest save that restores, else the world as built. True when a save was restored. Saves that do not restore
  // (another world's, or broken) stay on disk; rotation (state.ts) deletes them only once older than keepStateMs and not among the newest six.
  // The first save of another world ends the search: older ones are taken to be of earlier worlds too, so a move to a new map
  // parses one old save (about 5 s), not all of them.
  async restoreNewest(log: (line: string) => void = console.log): Promise<boolean> {
    for (const { name } of this.store.list()) {
      try {
        const t0 = performance.now();
        log(`restored ${await this.restore(name)} (${Math.round(performance.now() - t0)} ms)`);
        return true;
      } catch (e) {
        log(`cannot restore ${name}: ${errText(e)}`);
        if (e instanceof OtherWorld) {
          log("older saves are taken to be of earlier worlds and are not tried; all are kept on disk");
          break;
        }
      }
    }
    log("no usable save, starting a fresh world");
    return false;
  }

  // Saves the running world, then replaces it with the named save. Only a name from the listing is accepted, and a failure at any step keeps the running world.
  async load(name: unknown): Promise<string> {
    if (typeof name !== "string" || !this.store.list().some((s) => s.name === name)) throw new Error("no such save");
    await this.save();
    return this.exclusive(async () => `loaded ${await this.restore(name)}`);
  }
}
