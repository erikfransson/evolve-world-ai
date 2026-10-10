import type { EcoInMessage } from "./ecoProtocol.ts";
import { EcoRunner } from "./ecoRunner.ts";

const runner = new EcoRunner((msg, transfer) => self.postMessage(msg, { transfer }));
let timer: ReturnType<typeof setTimeout> | undefined;

function loop(): void {
  timer = undefined;
  try {
    const wait = runner.pump();
    if (wait >= 0) timer = setTimeout(loop, wait);
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

self.onmessage = (e: MessageEvent<EcoInMessage>) => {
  try {
    runner.handle(e.data);
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (timer === undefined) timer = setTimeout(loop, 0);
};
