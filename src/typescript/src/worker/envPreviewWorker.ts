import { loadPool } from "../sim/seedPool.ts";
import type { PoolEntry } from "../sim/seedPool.ts";
import { poolLearner, randomLearner } from "../sim/rl/env.ts";
import type { EnvSpec, Learner, Library } from "../sim/rl/env.ts";
import { parseLibrary } from "../sim/rl/library.ts";
import { recordEpisode, recordingBuffers } from "../sim/rl/recording.ts";
import type { Recording } from "../sim/rl/recording.ts";

// Records one short clip per env for the Arena's environment gallery, off the page's thread: the strongest seed-pool founder
// (a random creature without a pool) plays one fixed seed, every 3rd tick kept. Clips come back one by one, buffers transferred.

export type PreviewIn = { type: "record"; envs: EnvSpec[]; poolUrl: string; libraryUrl: string };
export type PreviewOut = { type: "clip"; id: string; rec: Recording } | { type: "failed"; id: string; message: string };

const SEED = 20261011;
const EVERY = 3;
const CLIP_SECONDS = 24; // longer episodes are cut, so big worlds stay quick to record

let assets: Promise<{ pool: PoolEntry[] | null; library: Library }> | undefined;
const loadAssets = (poolUrl: string, libraryUrl: string) =>
  (assets ??= Promise.all([
    loadPool(poolUrl),
    fetch(libraryUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then(parseLibrary)
      .catch((): Library => parseLibrary(null)),
  ]).then(([pool, library]) => ({ pool, library })));

// The founder with the highest fitness.
const strongest = (pool: readonly PoolEntry[]): PoolEntry => pool.reduce((a, b) => (b.fitness > a.fitness ? b : a));

function recordClip(env: EnvSpec, pool: readonly PoolEntry[] | null, library: Library): Recording {
  const learner: Learner = pool?.length ? poolLearner(env, strongest(pool)) : randomLearner(env, SEED);
  return recordEpisode({ ...env, seconds: Math.min(env.seconds, CLIP_SECONDS) }, learner, SEED, pool, library, EVERY);
}

self.onmessage = (e: MessageEvent<PreviewIn>) => {
  const msg = e.data;
  if (msg.type !== "record") return;
  void loadAssets(msg.poolUrl, msg.libraryUrl).then(({ pool, library }) => {
    for (const env of msg.envs) {
      try {
        const rec = recordClip(env, pool, library);
        self.postMessage({ type: "clip", id: env.id, rec } satisfies PreviewOut, { transfer: recordingBuffers(rec) });
      } catch (error) {
        self.postMessage({ type: "failed", id: env.id, message: error instanceof Error ? error.message : String(error) } satisfies PreviewOut);
      }
    }
  });
};
