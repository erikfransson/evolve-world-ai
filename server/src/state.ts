import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzip, gzipSync } from "node:zlib";
import { promisify } from "node:util";
import { LIMITS } from "./config.ts";
import { parseSave } from "./saveParse.ts";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";

// Saves are `world-<UTC timestamp>.json.gz` (gzipped JSON of the engine's saveState) with a small sidecar `world-<timestamp>.meta.json`
// for the listing. Only names matching these exact patterns are ever read, listed or deleted.
const STAMP = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z";
const SAVE = new RegExp(`^world-(${STAMP})\\.json\\.gz$`);
const META = new RegExp(`^world-(${STAMP})\\.meta\\.json$`);
const TMP = new RegExp(`^world-${STAMP}\\.(json\\.gz|meta\\.json)\\.tmp$`);
const MAX_META_BYTES = 4096;

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

  // Total size of the files in the directory, for the disk cap.
  dirBytes(): number {
    let total = 0;
    for (const n of readdirSync(this.dir)) {
      try {
        total += statSync(join(this.dir, n)).size;
      } catch { /* removed meanwhile */ }
    }
    return total;
  }

  // Writes the gzipped JSON through a .tmp file and a rename, then rotates. Throws, writing nothing, when the directory is over the cap.
  // asyncGzip: compress off the main thread, so only the caller's own JSON work blocks.
  // verify: rejects, so nothing is written, when the gzipped save would not be read back.
  async write(json: string, meta: { population: number; tick: number }, at = new Date(), asyncGzip = true, verify?: (gz: Uint8Array) => Promise<unknown>): Promise<string> {
    const used = this.dirBytes();
    if (used > LIMITS.maxStateDirBytes) throw new Error(`state directory holds ${Math.round(used / 1e6)} MB, over the ${LIMITS.maxStateDirBytes / 1e6} MB cap: not saving`);
    const data = asyncGzip ? await gzipAsync(json) : gzipSync(json);
    if (verify) await verify(data);
    const name = saveName(at);
    this.put(name, data);
    this.put(metaName(name), Buffer.from(JSON.stringify(meta)));
    this.rotate(at.getTime());
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
          }
          return [info];
        } catch {
          return [];
        }
      });
  }

  // Whether any file here is named as a save, whether or not the listing shows it (stamped in the future by a clock that was behind, a
  // sidecar that does not parse): the store holds saves, so startup must not take it for an empty one.
  hasSaveFiles(): boolean {
    return readdirSync(this.dir).some(isSaveName);
  }

  // The checked state of a save, parsed on a worker (saveParse.ts). The name must be one the listing shows (pattern, regular file, not from the future),
  // never a path from the caller. Rejects on a missing, special or oversized file, a gzip that unpacks past the cap, bad JSON or an invalid state.
  async read(name: unknown): Promise<EcoState> {
    if (!isSaveName(name)) throw new Error("not a save name");
    if (!this.list().some((s) => s.name === name)) throw new Error("no such save");
    return parseSave(readRegularFile(join(this.dir, name), LIMITS.maxSaveJsonBytes), LIMITS.maxSaveJsonBytes);
  }
}
