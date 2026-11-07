// Shared command-line checks for the RL and benchmark tools: numbers that must be numbers, pool and library files that must exist when asked for.
import { createHash } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import type { Library } from "./sim/rl/env.ts";
import { parseLibrary } from "./sim/rl/library.ts";
import { parsePool } from "./sim/seedPool.ts";
import type { PoolEntry } from "./sim/seedPool.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const fail = (msg: string): never => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

// parseArgs in strict mode (unknown flags and positionals are errors) that ends with the error, the script's "Usage:" comment line and exit 1, not a stack trace.
export function strictArgs<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs({ ...config, strict: true }) as ReturnType<typeof parseArgs<T>>;
  } catch (e) {
    const script = process.argv[1];
    const lines = script ? readFileSync(script, "utf8").split("\n") : [];
    const at = lines.findIndex((l) => l.startsWith("// Usage:"));
    const usage = at < 0 ? [] : [lines[at]!, ...lines.slice(at + 1).slice(0, lines.slice(at + 1).findIndex((l) => !/^\/\/\s{2,}\S/.test(l)))];
    return fail(`${(e as Error).message}${usage.map((l) => `\n${l.slice(3)}`).join("")}`);
  }
}

// The seed of a `random[:SEED]` --from: a bare "random" is seed 1; anything else must be a whole number.
export function randomSeed(arg: string | undefined): number {
  if (arg === undefined) return 1;
  const v = Number(arg);
  return arg.trim() !== "" && Number.isInteger(v) ? v : fail(`random seed must be an integer, got "${arg}"`);
}

// A short hash of a rival library, kept in resumable states to notice a library that changed since.
export const libraryHash = (library: Library): string => createHash("sha256").update(JSON.stringify(library)).digest("hex").slice(0, 16);

// The warning for resuming a state saved against another rival library, or null when it matches.
export function libraryResumeWarning(saved: string | undefined, current: string): string | null {
  if (saved === undefined) return "the state file records no rival library (saved by an older version), resuming against the current one";
  return saved === current ? null : "the rival library differs from the one the state was saved with, resuming against the current one";
}

// A whole number of at least `min` (1: a positive integer).
export function positiveInt(name: string, raw: string | undefined, min = 1): number {
  const v = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(v) && v >= min ? v : fail(`--${name} must be an integer of at least ${min}, got "${raw}"`);
}

// A finite number from `min` (default: any) to `max`.
export function finiteNumber(name: string, raw: string | undefined, min = -Infinity, max = Infinity): number {
  const v = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(v) && v >= min && v <= max ? v : fail(`--${name} must be a number${min > -Infinity ? ` from ${min}` : ""}${max < Infinity ? ` to ${max}` : ""}, got "${raw}"`);
}

// The file a --pool or --library flag names. An explicit path must exist; an absent default (public/ in the package, whatever the cwd) gives null with a note.
function assetPath(flag: string, given: string | undefined, fallback: string): string | null {
  if (given !== undefined) return existsSync(given) ? resolve(given) : fail(`--${flag} ${given} does not exist`);
  const path = resolve(PACKAGE_ROOT, fallback);
  if (existsSync(path)) return path;
  console.error(`note: no ${fallback} (looked in ${path}), going on without a ${flag}`);
  return null;
}
export const DEFAULT_LIBRARY = resolve(PACKAGE_ROOT, "public/rl/library.json");
export const poolPath = (given: string | undefined): string | null => assetPath("pool", given, "public/pool.json");
export const libraryPath = (given: string | undefined): string | null => assetPath("library", given, "public/rl/library.json");

export function loadPoolFile(given: string | undefined): PoolEntry[] | null {
  const path = poolPath(given);
  return path === null ? null : parsePool(JSON.parse(readFileSync(path, "utf8"))).entries;
}

export function loadLibraryFile(given: string | undefined): Library {
  const path = libraryPath(given);
  return parseLibrary(path === null ? null : JSON.parse(readFileSync(path, "utf8")));
}

// Creates the folder of an output file now, so a long run does not lose its result to a missing folder at the end.
export function prepareOut(path: string | undefined): void {
  if (path !== undefined) mkdirSync(dirname(resolve(path)), { recursive: true });
}

// Runs fn while holding `path`.lock (created exclusively, so two processes never both hold it); a lock older than `staleMs` is a crashed holder's and is taken over.
export function withFileLock<T>(path: string, fn: () => T, staleMs = 60_000, waitMs = 120_000): T {
  const lock = `${path}.lock`;
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  const t0 = Date.now();
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          // Only one waiter's rename of the stale file succeeds; the others get ENOENT and loop.
          const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
          renameSync(lock, aside);
          try {
            // A fresh lock replaced the stale one between the stat and the rename (released and taken again): put it back. A waiter creating the lock in these microseconds would make two holders; accepted.
            if (Date.now() - statSync(aside).mtimeMs <= staleMs) linkSync(aside, lock);
          } finally {
            unlinkSync(aside);
          }
        }
      } catch { /* released or taken over meanwhile */ }
      if (Date.now() - t0 > waitMs) throw new Error(`${lock} stays locked`);
      Atomics.wait(sleep, 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch { /* taken over as stale */ }
  }
}
