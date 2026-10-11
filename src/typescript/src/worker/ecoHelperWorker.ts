// Browser entry of an Ecosystem helper thread, spawned by the Ecosystem worker.
import { serveHelper } from "./ecoPool.ts";
import type { HelperIn } from "./ecoPool.ts";

const handle = serveHelper((msg, transfer) => self.postMessage(msg, { transfer }));
self.onmessage = (e: MessageEvent<HelperIn>) => handle(e.data);
