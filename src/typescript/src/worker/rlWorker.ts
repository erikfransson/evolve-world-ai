import { loadPool } from "../sim/seedPool.ts";
import type { PoolEntry } from "../sim/seedPool.ts";
import type { Library } from "../sim/rl/env.ts";
import { parseLibrary } from "../sim/rl/library.ts";
import { ArenaRun } from "./arenaRun.ts";
import { createBrowserRlPool } from "./browserPool.ts";
import type { RlInMessage, RlOutMessage } from "./rlProtocol.ts";

// The Arena's worker: loads the seed pool and the library once, and runs one ArenaRun at a time (the page makes a new
// worker for every run, so a run never meets messages of an older one).

const post = (msg: RlOutMessage, transfer: Transferable[] = []): void => self.postMessage(msg, { transfer });
const report = (error: unknown): void => post({ type: "error", message: error instanceof Error ? error.message : String(error) });

let run: ArenaRun | null = null;
let early: RlInMessage[] = []; // pause, envs and show messages that arrive while the assets still load, applied once the run exists
let assets: Promise<{ pool: PoolEntry[] | null; library: Library }> | undefined;

// Fetched once from the URLs of the first start; a missing library leaves the league rivals random.
const loadAssets = (poolUrl: string, libraryUrl: string): Promise<{ pool: PoolEntry[] | null; library: Library }> =>
  (assets ??= Promise.all([
    loadPool(poolUrl),
    fetch(libraryUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then(parseLibrary)
      .catch((): Library => parseLibrary(null)),
  ]).then(([pool, library]) => ({ pool, library })));

// Anything that escapes a run's own error handling still reaches the page with its message.
self.addEventListener("error", (e) => {
  e.preventDefault();
  report(e.error ?? e.message);
});
self.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  report(e.reason);
});

self.onmessage = (e: MessageEvent<RlInMessage>) => {
  const msg = e.data;
  if (msg.type === "start") {
    if (!msg.envs.length) return report("choose at least one environment");
    void loadAssets(msg.poolUrl, msg.libraryUrl)
      .then((loaded) => {
        const r = (run = new ArenaRun(msg, loaded, createBrowserRlPool, post));
        for (const m of early) apply(m);
        early = [];
        return r.run().catch((error) => {
          r.stop();
          throw error;
        });
      })
      .catch(report);
  } else if (run) apply(msg);
  else early.push(msg);
};

function apply(msg: RlInMessage): void {
  if (msg.type === "pause") run?.pause();
  else if (msg.type === "resume") run?.resume();
  else if (msg.type === "envs") run?.setEnvs(msg.envs);
  else if (msg.type === "show") run?.wantShow();
}
