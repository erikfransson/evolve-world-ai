import { LIMITS, SEED_COPIES } from "./config.ts";
import { loadOverrides, retireOverrides } from "./admin.ts";
import type { SeedFounder } from "./founders.ts";
import type { Value } from "./tunables.ts";
import { parseSave } from "./saveParse.ts";
import { OtherWorld } from "./liveWorld.ts";
import type { LiveWorld } from "./liveWorld.ts";
import type { StateStore } from "./state.ts";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const RESTORE_TRIES = 3; // saves of this world tried at startup before giving up, so a failing start exits in minutes and systemd stops retrying
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
    const state = await this.store.read(name, this.live.homeWorld());
    await this.live.whenIdle(() => this.live.restoreState(state)); // throws, and keeps the running world, when the save is unusable
    return `${name}: tick ${this.live.eco.tick}, ${this.live.eco.population} creatures`;
  }

  // At startup: the newest save that restores. "restored" when one did; "fresh" when there is no save or the newest is of another world
  // (a move to a new map), so a fresh world may start; "unreadable" when saves of this world are there and none restores (a worker out of
  // memory, a parse timeout on a busy host, a bad deploy; at most RESTORE_TRIES are tried), or when save files are on disk that the listing
  // hides: the caller must not start over on top of them. Saves that do not restore stay
  // on disk; rotation (state.ts) deletes them only once older than keepStateMs and not among the newest six.
  // A save of another world ends the search: older ones are taken to be of earlier worlds too, so a move to a new map parses one old
  // save (about 5 s), not all of them.
  async restoreNewest(log: (line: string) => void = console.log): Promise<"restored" | "fresh" | "unreadable"> {
    let tried = 0;
    for (const { name } of this.store.list()) {
      try {
        const t0 = performance.now();
        log(`restored ${await this.restore(name)} (${Math.round(performance.now() - t0)} ms)`);
        return "restored";
      } catch (e) {
        log(`cannot restore ${name}: ${errText(e)}`);
        if (e instanceof OtherWorld) {
          log("older saves are taken to be of earlier worlds and are not tried; all are kept on disk");
          if (tried > 0) return "unreadable";
          break;
        }
        if (++tried >= RESTORE_TRIES) return "unreadable";
      }
    }
    if (tried > 0) return "unreadable";
    const hidden = this.store.hiddenSaves();
    if (hidden > 0) {
      log(`${hidden} saves on disk are not listed (stamped in the future by a clock behind at boot, or an unreadable sidecar): not starting a fresh world`);
      return "unreadable";
    }
    log("no usable save, starting a fresh world");
    return "fresh";
  }

  // Saves the running world, then replaces it with the named save. Only a name from the listing is accepted, and a failure at any step keeps the running world.
  async load(name: unknown): Promise<string> {
    if (typeof name !== "string" || !this.store.list().some((s) => s.name === name)) throw new Error("no such save");
    await this.save();
    return this.exclusive(async () => `loaded ${await this.restore(name)}`);
  }
}

// At startup: the newest save that restores, with the admin overrides applied to it; else, with no save or only another world's, a fresh
// world seeded with the founders, the overrides of the world before set aside (they were tuned for it), and none in force.
// Throws when saves of this world are there but none restores (main exits 1 and systemd tries again; a fresh world's save would
// otherwise become the newest and rotation would delete the real world's), and when seeding fails.
export async function openWorld(saves: Saves, live: LiveWorld, stateDir: string, founders: readonly SeedFounder[], log: (line: string) => void = console.log): Promise<Record<string, Value>> {
  live.founders = founders;
  const found = await saves.restoreNewest(log);
  if (found === "restored") return loadOverrides(stateDir, live);
  if (found === "unreadable") throw new Error("saves of this world are there but none restores: not starting a fresh world over them");
  const retired = retireOverrides(stateDir);
  if (retired) log(retired);
  const n = live.seedFounders(founders);
  log(`fresh world seeded with ${n} creatures, ${SEED_COPIES} of each of ${founders.map((f) => f.name).join(", ")}`);
  // Saved at once, so a crash before the first 4-hourly save restores this world instead of starting yet another (and retiring its overrides).
  // A failed save is logged and the world runs on, as with any save.
  await saves.save().then(log, (e: unknown) => log(errText(e)));
  return {};
}
