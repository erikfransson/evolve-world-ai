import type { EcoInMessage } from "./ecoProtocol.ts";
import { EcoRunner } from "./ecoRunner.ts";
import { loadPool } from "../sim/seedPool.ts";
import type { PoolEntry } from "../sim/seedPool.ts";

const runner = new EcoRunner((msg, transfer) => self.postMessage(msg, { transfer }));
let timer: ReturnType<typeof setTimeout> | undefined;
let seedPool: Promise<PoolEntry[] | null> | undefined; // fetched on the first start, then reused
let queue = Promise.resolve(); // messages are handled in order, also while the first start waits for the pool

function loop(): void {
  timer = undefined;
  try {
    const wait = runner.pump();
    if (wait >= 0) timer = setTimeout(loop, wait);
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

async function receive(msg: EcoInMessage): Promise<void> {
  try {
    if (msg.type === "start") runner.seedPool = await (seedPool ??= msg.poolUrl ? loadPool(msg.poolUrl) : Promise.resolve(null));
    runner.handle(msg);
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (timer === undefined) timer = setTimeout(loop, 0);
}

self.onmessage = (e: MessageEvent<EcoInMessage>) => {
  queue = queue.then(() => receive(e.data));
};
