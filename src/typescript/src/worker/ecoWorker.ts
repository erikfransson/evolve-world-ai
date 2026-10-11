import type { EcoInMessage } from "./ecoProtocol.ts";
import { EcoRunner } from "./ecoRunner.ts";
import { createBrowserThinkPool } from "./browserPool.ts";
import { ThinkPool, canShare, defaultHelpers } from "./ecoPool.ts";
import { loadPool } from "../sim/seedPool.ts";
import type { PoolEntry } from "../sim/seedPool.ts";

const runner = new EcoRunner((msg, transfer) => self.postMessage(msg, { transfer }));
let busy = false; // a pump is scheduled or running
let seedPool: Promise<PoolEntry[] | null> | undefined; // fetched on the first start, then reused
let queue = Promise.resolve(); // messages and pumps run in order, also while the first start waits for the pool
let helpers: ThinkPool | null = null;

function fail(error: unknown): void {
  self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
}

function schedule(wait: number): void {
  busy = true;
  setTimeout(() => {
    queue = queue.then(async () => {
      let next = -1;
      try {
        next = await runner.pumpAsync();
      } catch (error) {
        fail(error);
      }
      busy = false;
      if (next >= 0) schedule(next);
    });
  }, wait);
}

// The helper threads for a run: reused while the count and mode stay, otherwise replaced; none for 0 or without nested workers.
function helpersFor(msg: Extract<EcoInMessage, { type: "start" }>): ThinkPool | null {
  const count = msg.threads ?? defaultHelpers(navigator.hardwareConcurrency || 2);
  const shared = msg.shared !== false && canShare(self);
  if (helpers && helpers.alive && helpers.helpers === count && helpers.shared === shared) return helpers;
  helpers?.close();
  helpers = null;
  if (count <= 0 || typeof Worker === "undefined") return null;
  try {
    helpers = createBrowserThinkPool(count, shared);
  } catch (error) {
    console.warn("Helper threads unavailable, running on one thread:", error);
  }
  return helpers;
}

async function receive(msg: EcoInMessage): Promise<void> {
  try {
    if (msg.type === "start") {
      runner.seedPool = await (seedPool ??= msg.poolUrl ? loadPool(msg.poolUrl) : Promise.resolve(null));
      runner.useHelpers(helpersFor(msg));
    }
    runner.handle(msg);
  } catch (error) {
    fail(error);
    return;
  }
  if (!busy) schedule(0);
}

self.onmessage = (e: MessageEvent<EcoInMessage>) => {
  queue = queue.then(() => receive(e.data));
};
