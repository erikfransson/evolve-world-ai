import type { EcoInMessage } from "./ecoProtocol.ts";
import type { RenderSnapshot } from "./renderProtocol.ts";
import { EcoRunner } from "./ecoRunner.ts";
import { createBrowserThinkPool } from "./browserPool.ts";
import { ThinkPool, defaultHelpers } from "./ecoPool.ts";
import { gentleController } from "./pacer.ts";
import type { DutyController } from "./pacer.ts";
import { loadPool } from "../sim/seedPool.ts";
import type { PoolEntry } from "../sim/seedPool.ts";

let renderPort: MessagePort | null = null; // set when a render worker draws: snapshot buffers go to it, the page gets the rest
const NO_BUFFER = new ArrayBuffer(0);
const runner = new EcoRunner((msg, transfer) => {
  if (renderPort && msg.type === "snapshot") {
    const { buffer, selected, events } = msg;
    const toRender: RenderSnapshot = { type: "snapshot", run: msg.run, count: msg.count, itemCount: msg.itemCount, creatureCap: msg.creatureCap, itemCap: msg.itemCap, buffer, events, selected: selected && { ...selected, genome: null } };
    renderPort.postMessage(toRender, { transfer: [buffer] });
    self.postMessage({ ...msg, buffer: NO_BUFFER, events: undefined }); // the page needs neither the buffer nor the events
    return;
  }
  self.postMessage(msg, { transfer });
});
let busy = false; // a pump is scheduled or running
let seedPool: Promise<PoolEntry[] | null> | undefined; // fetched on the first start, then reused
let queue = Promise.resolve(); // messages and pumps run in order, also while the first start waits for the pool
let helpers: ThinkPool | null = null;
let controller: DutyController | null = null; // created on the first gentle run
const setGentle = (on: boolean): void => { runner.gentle = on ? (controller ??= gentleController()) : null; };

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

// The helper threads for a run: reused while the count stays, otherwise replaced; none for 0 or without nested workers.
function helpersFor(msg: Extract<EcoInMessage, { type: "start" }>): ThinkPool | null {
  const count = msg.threads ?? defaultHelpers(navigator.hardwareConcurrency || 2, msg.gentle ?? false);
  if (helpers && helpers.alive && helpers.helpers === count) return helpers;
  helpers?.close();
  helpers = null;
  if (count <= 0 || typeof Worker === "undefined") return null;
  try {
    helpers = createBrowserThinkPool(count);
  } catch (error) {
    console.warn("Helper threads unavailable, running on one thread:", error);
  }
  return helpers;
}

async function receive(msg: EcoInMessage): Promise<void> {
  try {
    if (msg.type === "gentle") {
      setGentle(msg.gentle); // the helper count changes at the next start
      return;
    }
    if (msg.type === "start") {
      setGentle(msg.gentle ?? false);
      runner.seedPool = await (seedPool ??= msg.poolUrl ? loadPool(msg.poolUrl) : Promise.resolve(null));
      if (!runner.seedPool) seedPool = undefined; // a failed load is tried again on the next start
      runner.useHelpers(helpersFor(msg));
    }
    runner.handle(msg);
  } catch (error) {
    fail(error);
    return;
  }
  if (!busy) schedule(0);
}

self.onmessage = (e: MessageEvent<EcoInMessage | { type: "renderPort"; port: MessagePort } | { type: "renderGone" }>) => {
  if (e.data.type === "renderPort") {
    renderPort = e.data.port;
    renderPort.onmessage = (p: MessageEvent<{ buffer: ArrayBuffer }>) => { queue = queue.then(() => receive({ type: "refill", buffer: p.data.buffer })); };
    return;
  }
  if (e.data.type === "renderGone") {
    renderPort?.close(); // the render worker died: later snapshots go to the page with their buffers
    renderPort = null;
    return;
  }
  const data = e.data;
  queue = queue.then(() => receive(data));
};
