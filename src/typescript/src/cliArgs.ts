// Shared command-line checks for the RL and benchmark tools: numbers that must be numbers, pool and library files that must exist when asked for.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Library } from "./sim/rl/env.ts";
import { parseLibrary } from "./sim/rl/library.ts";
import { parsePool } from "./sim/seedPool.ts";
import type { PoolEntry } from "./sim/seedPool.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const fail = (msg: string): never => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

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
        if (Date.now() - statSync(lock).mtimeMs > staleMs) unlinkSync(lock);
      } catch { /* released meanwhile */ }
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
