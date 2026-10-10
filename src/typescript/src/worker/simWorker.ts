import type { GenerationMessage, InMessage } from "./protocol.ts";
import { createBrowserEvaluator } from "./browserPool.ts";
import { SerialEvaluator } from "../sim/evaluator.ts";
import type { Evaluator } from "../sim/evaluator.ts";
import { Evolution } from "../sim/evolution.ts";
import type { SimConfig } from "../sim/config.ts";

let evolution: Evolution | null = null;
let evaluator: Evaluator | null = null;
let config: SimConfig | null = null;
let paused = false;
let looping = false; // true while a loop is running, so resume cannot start a second one

async function loop(): Promise<void> {
  if (looping) return;
  looping = true;
  try {
    while (evolution && evaluator && !paused) {
      const current = evolution;
      let step;
      try {
        step = await current.runGenerationWith(evaluator);
      } catch (error) {
        if (current !== evolution) continue; // restarted, the old pool was closed under us
        if (!config || evaluator instanceof SerialEvaluator) throw error;
        evaluator.close(); // the pool failed, e.g. nested workers unsupported; continue serially
        evaluator = new SerialEvaluator(config);
        continue;
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
      self.postMessage(msg, { transfer: [population.data.buffer, result.fitness.buffer] });
    }
  } finally {
    looping = false;
  }
}

self.onmessage = (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  if (msg.type === "start") {
    paused = false;
    evaluator?.close();
    config = msg.config;
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
