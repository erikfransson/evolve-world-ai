import { BIRTH_WEIGHT_CAP, LIMITS, SEED_COPIES, mostCopies, seedRoom } from "./config.ts";
import { IGNORED_OVERRIDES, OVERRIDES, PREVIOUS_OVERRIDES, loadOverrides, retireOverrides } from "./admin.ts";
import type { SeedFounder } from "./founders.ts";
import type { Value } from "./tunables.ts";
import { parseSave } from "./saveParse.ts";
import { OtherWorld } from "./saveParse.ts";
import type { LiveWorld } from "./liveWorld.ts";
import { seedWeights } from "./liveWorld.ts";
import { SEED_FILE } from "./state.ts";
import { CARRY_FILE, MAX_CARRY_FILE_BYTES, NEXT_CARRY, REFUSED_CARRY, USED_CARRY, carryFounder, carryLine, checkCarry } from "./carry.ts";
import type { CarryOrder } from "./carry.ts";
import type { StateStore } from "./state.ts";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const RESTORE_TRIES = 3; // saves of this world tried at startup before giving up, so a failing start exits in minutes and systemd stops retrying
const UNREADABLE = "SAVE REFUSED: it would not restore, the last good save is kept";
export const MAX_KEPT_RESETS = 3; // reset folders kept before a reset is refused: each holds the saves of the last 4 days (about 1 GB at 40 MB a save), outside the disk cap

// The copies a reset may ask for: whole, at least 1, and the founders all fit below the birth reserve. The reason when not.
export function copiesProblem(copies: number, founders: number, eco: { maxPopulation: number; birthReserve: number }): string | null {
  const most = mostCopies(founders, eco);
  return Number.isInteger(copies) && copies >= 1 && copies <= most ? null : `copies must be a whole number from 1 to ${most} (${founders} founders, room for ${seedRoom(eco)} below the birth reserve)`;
}

// The copies in the seed file, or SEED_COPIES when there is none or it does not hold a valid count (logged).
export function readSeedCopies(store: StateStore, founders: number, eco: { maxPopulation: number; birthReserve: number }, log: (line: string) => void = console.log): number {
  try {
    const n = store.seedCopies();
    if (n === null) return SEED_COPIES;
    const bad = copiesProblem(n, founders, eco);
    if (!bad) return n;
    log(`${SEED_FILE} ignored: ${bad}`);
  } catch (e) {
    log(`${SEED_FILE} ignored: ${errText(e)}`);
  }
  return SEED_COPIES;
}

// Saving and restoring the live world. Jobs run one at a time. Only saveState and JSON.stringify block the tick loop, the gzip runs on a worker thread.
export class Saves {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly live: LiveWorld;
  readonly store: StateStore;
  private resetting = false; // set once a reset moved the saves aside: nothing more is saved next to the kept world, the server exits

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
    return this.exclusive(() => this.saveNow()).catch((e: unknown) => {
      throw new Error(`not saved: ${errText(e)}`);
    });
  }

  private async saveNow(): Promise<string> {
      if (this.resetting) throw new Error("the world is being reset");
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
      const h = this.live.homeWorld();
      const world = `${h.map || "random"} ${h.width}x${h.height}${h.mapVersion ? ` ${h.mapVersion}` : ""}`; // so the listing tells this world's saves from another's
      const name = await this.store.write(json, { population: this.live.eco.population, tick: this.live.eco.tick, world }, new Date(), true, verify);
      return `saved ${name} (${Math.round(json.length / 1e6)} MB json, ${stallMs} ms tick stall)`;
  }

  // An admin reset: saves the running world, then moves every save, the admin overrides and the seed file into before-reset-<time>/
  // (kept, never listed, rotated or restored), and writes the copies of each founder the next world starts with. Saving then stays
  // off, so the caller exits and the next start seeds a fresh world. Any failure before the move keeps the running world as it was;
  // a failure while moving keeps it running too (the newest saves move last, so a restart restores the newest left).
  // carry: a checked order (carry.ts) the next start seeds with the founders; it must fit below the birth reserve with them.
  reset(copies: number, founders: number, at = new Date(), carry?: CarryOrder): Promise<string> {
    return this.exclusive(async () => {
      const bad = copiesProblem(copies, founders, this.live.freshEco);
      if (bad) throw new Error(bad);
      const room = seedRoom(this.live.freshEco) - copies * founders;
      if (carry && carry.copies > room) throw new Error(`${carry.copies} carried copies do not fit: ${room} places are left below the birth reserve after ${copies} of each founder`);
      const weights = seedWeights(this.live.founders, copies, carry ? { founder: carryFounder(carry), copies: carry.copies } : undefined);
      if (weights > BIRTH_WEIGHT_CAP) throw new Error(`the next world would start with ${weights} brain weights, over the ${BIRTH_WEIGHT_CAP} births stop at: seed fewer copies`);
      const carryText = carry ? JSON.stringify(carry) : "";
      if (carryText.length > MAX_CARRY_FILE_BYTES) throw new Error(`the carry order is ${carryText.length} bytes, over the ${MAX_CARRY_FILE_BYTES} the next start reads`);
      const kept = this.store.keptResets();
      if (kept >= MAX_KEPT_RESETS) throw new Error(`${kept} before-reset folders are kept in the state directory: move or delete the old ones first`);
      if (this.resetting) throw new Error("the world is being reset");
      const saved = await this.saveNow();
      const sub = `before-reset-${at.toISOString().replace(/[:.]/g, "-")}`;
      this.store.remove(NEXT_CARRY); // a stale one, from a reset that died between its write and its rename
      if (carry) this.store.writeFile(NEXT_CARRY, carryText); // before anything moves: a failure here keeps the world as it was
      this.resetting = true;
      let n: number;
      try {
        n = this.store.moveAside(sub, [OVERRIDES, PREVIOUS_OVERRIDES, IGNORED_OVERRIDES, SEED_FILE, CARRY_FILE, USED_CARRY, REFUSED_CARRY]);
      } catch (e) {
        if (carry) this.store.remove(NEXT_CARRY); // the world runs on, so no later fresh start may carry it
        this.resetting = false;
        // Saves or settings may be in the folder already: a save now puts the running world back in place for a restart.
        const again = await this.saveNow().then((l) => `, ${l}`, (s: unknown) => `, and saving again failed too: ${errText(s)}`);
        throw new Error(`reset stopped part-way, the world runs on${again}; check ${sub} before trying again (its admin settings no longer apply after a restart): ${errText(e)}`);
      }
      const moved = `${saved}; ${n} saves and the admin settings moved to ${sub}`;
      let carried = "";
      if (carry) {
        try {
          this.store.rename(NEXT_CARRY, CARRY_FILE);
          carried = ` and ${carryLine(carry, this.live.config.dt)}`;
        } catch (e) {
          carried = `, carrying nothing: ${NEXT_CARRY} could not be renamed to ${CARRY_FILE} (${errText(e)}), so the fresh world starts without it`;
        }
      }
      try {
        this.store.writeSeedCopies(copies);
      } catch (e) {
        return `${moved}; ${SEED_FILE} could not be written (${errText(e)}), so the next start seeds ${SEED_COPIES} of each founder${carried}`; // the reset goes on: the saves are moved already
      }
      return `${moved}; the next start seeds ${copies} of each founder${carried}`;
    });
  }

  private async restore(name: string): Promise<string> {
    const state = await this.store.read(name, this.live.homeWorld());
    await this.live.whenIdle(() => this.live.restoreState(state)); // throws, and keeps the running world, when the save is unusable
    return `${name}: tick ${this.live.eco.tick}, ${this.live.eco.population} creatures`;
  }

  // At startup: the newest save of this world that restores. "restored" when one did; "fresh" only when no save of this world is on
  // disk (none at all, or only other worlds' saves: another size, map or map data), so a fresh world may start; "unreadable" when saves
  // of this world are there and none restores (a worker out of memory, a parse timeout on a busy host, a bad deploy; at most
  // RESTORE_TRIES are tried), or when save files are on disk that the listing hides: the caller must not start over on top of them.
  // Other worlds' saves are skipped, not taken to end the search, so one run on a test map and a revert finds this world's older saves.
  // Saves that do not restore stay on disk; rotation (state.ts) deletes them only once older than keepStateMs and not among the newest six.
  async restoreNewest(log: (line: string) => void = console.log): Promise<"restored" | "fresh" | "unreadable"> {
    let tried = 0;
    let others = 0;
    for (const { name } of this.store.list()) {
      try {
        const t0 = performance.now();
        log(`restored ${await this.restore(name)} (${Math.round(performance.now() - t0)} ms)`);
        return "restored";
      } catch (e) {
        log(`cannot restore ${name}: ${errText(e)}`);
        if (e instanceof OtherWorld) others++;
        else if (++tried >= RESTORE_TRIES) break;
      }
    }
    if (tried > 0) return "unreadable";
    const hidden = this.store.hiddenSaves();
    if (hidden > 0) {
      log(`${hidden} saves on disk are not listed (stamped in the future by a clock behind at boot, or an unreadable sidecar): not starting a fresh world`);
      return "unreadable";
    }
    if (others > 0) log(`${others} saves of other worlds are kept on disk`);
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
  const store = saves.store;
  live.founders = founders;
  const found = await saves.restoreNewest(log);
  live.seedCopies = readSeedCopies(store, founders.length, live.freshEco, log);
  if (found === "restored") return loadOverrides(stateDir, live);
  if (found === "unreadable") throw new Error("saves of this world are there but none restores: not starting a fresh world over them");
  const retired = retireOverrides(stateDir);
  if (retired) log(retired);
  // Founders with bigger brains than the seed file's count was chosen for (a new founders file) start with fewer copies, not a failed start.
  const perCopy = seedWeights(founders, 1);
  const copies = Math.max(1, Math.min(live.seedCopies, Math.floor(BIRTH_WEIGHT_CAP / perCopy)));
  if (copies < live.seedCopies) {
    log(`SEED CUT: ${live.seedCopies} of each founder would hold ${perCopy * live.seedCopies} brain weights, over the ${BIRTH_WEIGHT_CAP} births stop at: seeding ${copies}`);
    live.seedCopies = copies;
  }
  // A reset's carry order, checked again as an upload is: a bad or unreadable one is set aside and the world starts without it.
  try {
    store.remove(NEXT_CARRY); // only carry.json is carried: this one is from a reset that stopped between its write and its rename
  } catch (e) {
    log(`${NEXT_CARRY} not removed: ${errText(e)}`);
  }
  let carry: CarryOrder | null = null;
  let refused = "";
  try {
    const raw = store.readJson(CARRY_FILE, MAX_CARRY_FILE_BYTES);
    const order = raw === null ? null : checkCarry(raw, live.freshAddRules(), seedRoom(live.freshEco) - copies * founders.length, founders.map((f) => f.name));
    if (typeof order === "string") refused = order;
    else if (order && perCopy * copies + order.creature.genome.length * order.copies > BIRTH_WEIGHT_CAP) refused = `${order.copies} copies would take the world past the ${BIRTH_WEIGHT_CAP} brain weights births stop at`;
    else carry = order;
  } catch (e) {
    refused = errText(e);
  }
  if (refused) {
    log(`${CARRY_FILE} refused, nothing carried: ${refused}`);
    try {
      store.rename(CARRY_FILE, REFUSED_CARRY);
    } catch (e) {
      log(`${CARRY_FILE} not moved aside: ${errText(e)}`);
    }
  }
  let n: number;
  try {
    n = live.seedFounders(founders, Math.random, copies, carry ? { founder: carryFounder(carry), copies: carry.copies } : undefined);
  } catch (e) {
    if (!carry) throw e;
    // A carry that does not go in (no room left on the map, an insert refused) must not stop every restart: it is set aside instead.
    log(`${CARRY_FILE} refused, nothing carried: seeding with it failed (${errText(e)})`);
    carry = null;
    try {
      store.rename(CARRY_FILE, REFUSED_CARRY);
    } catch (m) {
      log(`${CARRY_FILE} not moved aside: ${errText(m)}`);
    }
    n = live.seedFounders(founders, Math.random, copies); // seedFounders checks before it inserts, so the world is still empty
  }
  if (carry) {
    const got = n - copies * founders.length;
    if (got < carry.copies) log(`CARRY SHORT: only ${got} of ${carry.copies} copies named ${carry.name} went in (an insert was refused)`);
    log(`carried ${carryLine({ ...carry, copies: got }, live.config.dt)}`);
    try {
      store.rename(CARRY_FILE, USED_CARRY); // carried once: a later fresh start does not carry it again
    } catch (e) {
      log(`${CARRY_FILE} not moved to ${USED_CARRY} (${errText(e)}): remove it before the next fresh start`);
    }
  }
  try {
    store.writeSeedCopies(copies);
  } catch (e) {
    log(`${SEED_FILE} not written (${errText(e)}): the page shows the default count after a restart`); // as with a failed save, the world runs on
  }
  log(`fresh world seeded with ${n} creatures, ${copies} of each of ${founders.map((f) => f.name).join(", ")}`);
  // Saved at once, so a crash before the first 4-hourly save restores this world instead of starting yet another (and retiring its overrides).
  // A failed save is logged and the world runs on, as with any save.
  await saves.save().then(log, (e: unknown) => log(errText(e)));
  return {};
}
