// Node entry of an Ecosystem helper thread (worker_threads).
import { parentPort } from "node:worker_threads";
import { serveHelper } from "./ecoPool.ts";

const handle = serveHelper((msg, transfer) => parentPort!.postMessage(msg, (transfer ?? []) as ArrayBuffer[]));
parentPort!.on("message", handle);
