import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzip, gzipSync } from "node:zlib";
import { promisify } from "node:util";
import { LIMITS } from "./config.ts";
import { parseCarry, parseSave } from "./saveParse.ts";
import type { Carried } from "./carry.ts";
import type { Home } from "./saveParse.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";

// Saves are `world-<UTC timestamp>.json.gz` (gzipped JSON of the engine's saveState) with a small sidecar `world-<timestamp>.meta.json`
// for the listing. Only names matching these exact patterns are ever read, listed or deleted.
const STAMP = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z";
const SAVE = new RegExp(`^world-(${STAMP})\\.json\\.gz$`);
const META = new RegExp(`^world-(${STAMP})\\.meta\\.json$`);
const TMP = new RegExp(`^world-${STAMP}\\.(json\\.gz|meta\\.json)\\.tmp$`);
const MAX_META_BYTES = 4096;

export const SEED_FILE = "seed-copies"; // copies of each founder the world was seeded with; an admin reset writes the next world's
export const RESET_DIR = /^before-reset-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/; // where a reset keeps the world before it
const resetTimeOf = (name: string): string => { // the ISO time inside a before-reset folder's name
  const s = name.slice("before-reset-".length);
  return `${s.slice(0, 11)}${s.slice(11, 19).replace(/-/g, ":")}.${s.slice(20, 23)}Z`;
};

export const isSaveName = (name: unknown): name is string => typeof name === "string" && SAVE.test(name);
const stampOf = (name: string): string => SAVE.exec(name)![1]!;
export const saveName = (at: Date): string => `world-${at.toISOString().replace(/[:.]/g, "-")}.json.gz`;
const metaName = (name: string): string => `world-${stampOf(name)}.meta.json`;
const timeOf = (name: string): string => { // the ISO time inside the name
  const s = stampOf(name);
  return `${s.slice(0, 11)}${s.slice(11, 19).replace(/-/g, ":")}.${s.slice(20, 23)}Z`;
};

export interface SaveInfo {
  name: string;
  time: string;
  bytes: number;
  population?: number;
  tick?: number;
  world?: string; // the world it is of (map, size, map version), absent in saves before 0.2.4
}

export const KEEP_NEWEST = 6; // saves kept whatever their age, so a host that was off for days still has its recent history
export const FUTURE_SLACK_MS = 5 * 60 * 1000; // a save stamped later than this ahead of the clock is ignored (clock skew or a planted file)

// True for a save whose stamp lies more than FUTURE_SLACK_MS after now.
export const fromFuture = (name: string, now: number): boolean => Date.parse(timeOf(name)) - now > FUTURE_SLACK_MS;

// Names to delete: saves older than keepMs before `now`, except the KEEP_NEWEST newest whatever their age, and their sidecars; plus sidecars without a save.
// Saves from the future are neither counted nor deleted.
export function namesToDelete(names: readonly string[], now: number, keepMs: number): string[] {
  const saves = names.filter((n) => SAVE.test(n) && !fromFuture(n, now)).sort();
  const newest = new Set(saves.slice(-KEEP_NEWEST));
  const drop = saves.filter((n) => !newest.has(n) && now - Date.parse(timeOf(n)) > keepMs);
  const gone = new Set(drop);
  const kept = new Set(names.filter((n) => SAVE.test(n) && !gone.has(n)).map(metaName));
  return [...drop, ...names.filter((n) => META.test(n) && !kept.has(n))];
}

export const KEEP_IN_BUDGET = 2; // newest saves the byte budget never deletes

// What to delete so the saves (with their sidecars) and the before-reset folders together hold at most `budget` bytes: older reset
// folders oldest first, then saves oldest first except the KEEP_IN_BUDGET newest, then the newest folder's saves oldest first except
// its newest. The newest folder and its newest save are never deleted: over is true when the budget still does not hold after that.
// saves: oldest first; folders: oldest first (the newest last), each with its saves oldest first; fixed: bytes nothing here may delete.
export interface BudgetEntry { name: string; bytes: number }
export interface BudgetFolder { name: string; bytes: number; saves: readonly BudgetEntry[] }
export function overBudget(saves: readonly BudgetEntry[], folders: readonly BudgetFolder[], budget: number, fixed = 0): { gone: string[]; over: boolean } {
  let total = fixed + saves.reduce((s, e) => s + e.bytes, 0) + folders.reduce((s, f) => s + f.bytes, 0);
  const gone: string[] = [];
  const take = (name: string, bytes: number): void => {
    if (total <= budget) return;
    gone.push(name);
    total -= bytes;
  };
  for (const f of folders.slice(0, -1)) take(f.name, f.bytes);
  for (const s of saves.slice(0, Math.max(0, saves.length - KEEP_IN_BUDGET))) take(s.name, s.bytes);
  const last = folders.at(-1);
  if (last) for (const s of last.saves.slice(0, -1)) take(join(last.name, s.name), s.bytes);
  return { gone, over: total > budget };
}

// The log line of a prune, "" when it deleted nothing and the budget holds.
export function pruneLine(p: { gone: string[]; over: boolean; error?: string }): string {
  const parts: string[] = [];
  if (p.gone.length) parts.push(`deleted ${p.gone.join(", ")}`);
  if (p.error) parts.push(`stopped by an error: ${p.error}`);
  else if (p.over) parts.push("still over budget: the newest saves and the newest before-reset save are kept");
  return parts.length ? `state budget ${LIMITS.maxStateBytes / 1e6} MB: ${parts.join("; ")}` : "";
}

// Bytes of the regular files under dir, not following symlinks. An entry removed meanwhile counts nothing.
function treeBytes(dir: string): number {
  let total = 0;
  for (const n of readdirSync(dir)) {
    try {
      const st = lstatSync(join(dir, n));
      if (st.isFile()) total += st.size;
      else if (st.isDirectory()) total += treeBytes(join(dir, n));
    } catch { /* removed meanwhile */ }
  }
  return total;
}

// The bytes of a regular file, refusing symlinks (O_NOFOLLOW), FIFOs and devices (no blocking open, then fstat) and files over maxBytes.
export function readRegularFile(file: string, maxBytes: number): Buffer {
  if (!lstatSync(file).isFile()) throw new Error("not a regular file");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > maxBytes) throw new Error("save file is too big");
    const buf = Buffer.alloc(st.size);
    let at = 0;
    while (at < buf.length) {
      const n = readSync(fd, buf, at, buf.length - at, at);
      if (n === 0) break;
      at += n;
    }
    return buf.subarray(0, at);
  } finally {
    closeSync(fd);
  }
}

const gzipAsync = promisify(gzip);

export class StateStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const n of readdirSync(dir)) if (TMP.test(n)) unlinkSync(join(dir, n)); // left by a crash mid-write
  }

  // Total size of the files in the directory and its before-reset folders, for the disk cap.
  dirBytes(): number {
    return treeBytes(this.dir);
  }

  // Writes the gzipped JSON through a .tmp file and a rename, then rotates. Throws, writing nothing, when the directory is over the cap.
  // asyncGzip: compress off the main thread, so only the caller's own JSON work blocks.
  // verify: rejects, so nothing is written, when the gzipped save would not be read back.
  async write(json: string, meta: { population: number; tick: number; world?: string }, at = new Date(), asyncGzip = true, verify?: (gz: Uint8Array) => Promise<unknown>): Promise<string> {
    return this.writeGzipped(asyncGzip ? await gzipAsync(json) : gzipSync(json), meta, at, verify);
  }

  // write for a save gzipped elsewhere (saves.ts packs it on a worker).
  async writeGzipped(data: Uint8Array, meta: { population: number; tick: number; world?: string }, at = new Date(), verify?: (gz: Uint8Array) => Promise<unknown>): Promise<string> {
    const used = this.dirBytes();
    if (used > LIMITS.maxStateDirBytes) throw new Error(`state directory holds ${Math.round(used / 1e6)} MB, over the ${LIMITS.maxStateDirBytes / 1e6} MB cap: not saving`);
    if (verify) await verify(data);
    const name = saveName(at);
    this.put(name, data);
    this.put(metaName(name), Buffer.from(JSON.stringify(meta)));
    this.rotate(at.getTime());
    try {
      const line = pruneLine(this.prune(at.getTime()));
      if (line) console.log(line);
    } catch (e) {
      console.error(`pruning to the state budget failed: ${e instanceof Error ? e.message : String(e)}`); // the save itself is written
    }
    return name;
  }

  private put(name: string, data: Uint8Array): void {
    const tmp = join(this.dir, `${name}.tmp`);
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, join(this.dir, name)); // a crash mid-write never leaves a half file under the real name
  }

  rotate(now = Date.now()): void {
    for (const name of namesToDelete(readdirSync(this.dir), now, LIMITS.keepStateMs)) unlinkSync(join(this.dir, name));
  }

  // Deletes old saves and before-reset folders until they hold at most LIMITS.maxStateBytes together (overBudget). Saves and folders
  // stamped in the future count but are never deleted, nor is `keep` (the folder a reset just made, then the newest); other files
  // (admin token, seed copies, carry, overrides) are not counted or touched. gone: what was deleted, also when a delete failed (error).
  prune(now = Date.now(), keep?: string): { gone: string[]; over: boolean; error?: string } {
    const withMeta = (dir: string, names: readonly string[], future: (n: string) => boolean): BudgetEntry[] =>
      names.filter((n) => SAVE.test(n) && !future(n)).sort().flatMap((name) => {
        try {
          const st = lstatSync(join(dir, name));
          if (!st.isFile()) return [];
          let bytes = st.size;
          try { const m = lstatSync(join(dir, metaName(name))); if (m.isFile()) bytes += m.size; } catch { /* no sidecar */ }
          return [{ name, bytes }];
        } catch { return []; }
      });
    const names = readdirSync(this.dir);
    const saves = withMeta(this.dir, names, (n) => fromFuture(n, now));
    let fixed = withMeta(this.dir, names, (n) => !fromFuture(n, now)).reduce((s, e) => s + e.bytes, 0);
    const folders: BudgetFolder[] = [];
    let kept: BudgetFolder | undefined;
    for (const name of names.filter((n) => RESET_DIR.test(n) && lstatSync(join(this.dir, n)).isDirectory()).sort()) {
      const dir = join(this.dir, name);
      const f = { name, bytes: treeBytes(dir), saves: withMeta(dir, readdirSync(dir), () => false) };
      if (name === keep) kept = f;
      else if (Date.parse(resetTimeOf(name)) - now > FUTURE_SLACK_MS || Number.isNaN(Date.parse(resetTimeOf(name)))) fixed += f.bytes;
      else folders.push(f);
    }
    if (kept) folders.push(kept); // the newest whatever its stamp: only its older saves may go
    const plan = overBudget(saves, folders, LIMITS.maxStateBytes, fixed);
    const gone: string[] = [];
    try {
      for (const n of plan.gone) {
        if (RESET_DIR.test(n)) rmSync(join(this.dir, n), { recursive: true, force: true });
        else {
          unlinkSync(join(this.dir, n));
          rmSync(join(this.dir, n.replace(/\.json\.gz$/, ".meta.json")), { force: true });
        }
        gone.push(n);
      }
    } catch (e) {
      return { gone, over: true, error: e instanceof Error ? e.message : String(e) };
    }
    return { gone, over: plan.over };
  }

  // Saves newest first. Reads only the file sizes and the small sidecars.
  // Only regular files, and none stamped in the future.
  list(now = Date.now()): SaveInfo[] {
    const names = readdirSync(this.dir);
    const metas = new Set(names.filter((n) => META.test(n)));
    return names
      .filter((n) => SAVE.test(n) && !fromFuture(n, now))
      .sort()
      .reverse()
      .flatMap((name) => {
        try {
          const st = lstatSync(join(this.dir, name));
          if (!st.isFile()) return [];
          const info: SaveInfo = { name, time: timeOf(name), bytes: st.size };
          const meta = metaName(name);
          if (metas.has(meta)) {
            const m = JSON.parse(readRegularFile(join(this.dir, meta), MAX_META_BYTES).toString("utf8"));
            if (Number.isSafeInteger(m.population)) info.population = m.population;
            if (Number.isSafeInteger(m.tick)) info.tick = m.tick;
            if (typeof m.world === "string" && /^[A-Za-z0-9 .:x-]{1,80}$/.test(m.world)) info.world = m.world;
          }
          return [info];
        } catch {
          return [];
        }
      });
  }

  // Files named as saves that the listing does not show (stamped in the future by a clock that was behind, a sidecar that does not
  // parse): they may be the running world's, so startup must not start over while there are any.
  hiddenSaves(): number {
    const listed = new Set(this.list().map((s) => s.name));
    return readdirSync(this.dir).filter((n) => isSaveName(n) && !listed.has(n)).length;
  }

  // Moves every save and sidecar into the new subdirectory `sub` (kept: listing, rotation and the disk cap read only this directory's own
  // files), oldest first, so a failure part-way leaves the newest saves in place for a restart. Then the extra state files named in
  // `also` that exist. Returns how many saves moved. Throws when `sub` exists.
  moveAside(sub: string, also: readonly string[] = []): number {
    const to = join(this.dir, sub);
    if (existsSync(to)) throw new Error(`${sub} exists already`);
    mkdirSync(to, { mode: 0o700 });
    const names = readdirSync(this.dir).filter((n) => SAVE.test(n) || META.test(n)).sort();
    for (const n of [...names, ...also.filter((n) => existsSync(join(this.dir, n)))]) renameSync(join(this.dir, n), join(to, n));
    return names.filter((n) => SAVE.test(n)).length;
  }

  // Folders an admin reset kept the world before it in.
  keptResets(): number {
    return readdirSync(this.dir).filter((n) => RESET_DIR.test(n)).length;
  }

  // The count in the seed file: null when there is none; throws when it is not a small regular file.
  seedCopies(): number | null {
    const file = join(this.dir, SEED_FILE);
    return existsSync(file) ? Number(readRegularFile(file, 64).toString("utf8").trim()) : null;
  }

  // Through a temp file and a rename, like a save: whatever was at the name (a symlink, a FIFO) is replaced, never written through.
  writeSeedCopies(copies: number): void {
    this.put(SEED_FILE, Buffer.from(`${copies}\n`));
  }

  // A small state file by its fixed name (never a caller's path), written like the seed file. The carry order of a reset (carry.ts).
  writeFile(name: string, text: string): void {
    this.put(name, Buffer.from(text));
  }

  // The JSON of a small state file, or null when there is none. Throws when it is not a regular file of at most maxBytes, or not JSON.
  readJson(name: string, maxBytes: number): unknown {
    const file = join(this.dir, name);
    try {
      lstatSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; // a dangling link is not "none": readRegularFile refuses it below
      throw e;
    }
    return JSON.parse(readRegularFile(file, maxBytes).toString("utf8"));
  }

  // Removes a state file by its fixed name, if it is there.
  remove(name: string): void {
    rmSync(join(this.dir, name), { force: true });
  }

  // Renames a state file by its fixed name, replacing what is at `to`.
  rename(name: string, to: string): void {
    renameSync(join(this.dir, name), join(this.dir, to));
  }

  // The checked state of a save, parsed on a worker (saveParse.ts). The name must be one the listing shows (pattern, regular file, not from the future),
  // never a path from the caller. Rejects on a missing, special or oversized file, a gzip that unpacks past the cap, bad JSON or an invalid state.
  // home: a save of another world rejects with OtherWorld (saveParse.ts) before the engine's checks.
  async read(name: unknown, home?: Home): Promise<EcoState> {
    if (!isSaveName(name)) throw new Error("not a save name");
    if (!this.list().some((s) => s.name === name)) throw new Error("no such save");
    return parseSave(readRegularFile(join(this.dir, name), LIMITS.maxSaveJsonBytes), LIMITS.maxSaveJsonBytes, false, home);
  }

  // The oldest living creature of a listed save, of any world (carry.ts, saveParse.ts parseCarry), null when it holds none.
  async readCarry(name: unknown): Promise<Carried | null> {
    if (!isSaveName(name)) throw new Error("not a save name");
    if (!this.list().some((s) => s.name === name)) throw new Error("no such save");
    return parseCarry(readRegularFile(join(this.dir, name), LIMITS.maxSaveJsonBytes), LIMITS.maxSaveJsonBytes, name);
  }
}
