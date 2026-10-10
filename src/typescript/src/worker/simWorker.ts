import type { GenerationMessage, InMessage, OutMessage } from "./protocol.ts";
import { createBrowserEvaluator } from "./browserPool.ts";
import type { Evaluator } from "../sim/evaluator.ts";
import { Evolution } from "../sim/evolution.ts";

let evolution: Evolution | null = null;
let evaluator: Evaluator | null = null;
let paused = false;
let looping = false; // true while a loop is running, so resume cannot start a second one

function post(msg: OutMessage, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

async function loop(): Promise<void> {
  if (looping) return;
  looping = true;
  try {
    while (evolution && evaluator && !paused) {
      const current = evolution;
      let step;
      try {
        step = await current.runGeneration(evaluator);
      } catch (error) {
        if (current !== evolution) continue; // restarted, the old pool was closed under us
        throw error;
      }
      if (current !== evolution) continue; // restarted while evaluating, drop the stale generation
      const { result, population } = step;
      const msg: GenerationMessage = {
        type: "generation",
        result,
        bestEver: current.bestEver,
        genomes: population.data,
        genomeLength: population.genomeLength,
        populationSize: population.size,
      };
      post(msg, [population.data.buffer, result.fitness.buffer]);
    }
  } catch (error) {
    evaluator?.close();
    evolution = evaluator = null; // the run is over, main stops it on the error message
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    looping = false;
  }
}

self.onmessage = (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  if (msg.type === "start") {
    paused = false;
    evaluator?.close();
    evaluator = createBrowserEvaluator(msg.config);
    evolution = new Evolution(msg.config);
    void loop();
  } else if (msg.type === "pause") {
    paused = true;
  } else if (paused) {
    paused = false;
    void loop();
  }
};
