import type { GenerationMessage, InMessage, OutMessage } from "./protocol.ts";
import { createBrowserEvaluator } from "./browserPool.ts";
import type { Evaluator } from "../sim/evaluator.ts";
import { Evolution } from "../sim/evolution.ts";
import { planRecording } from "../sim/trajectory.ts";
import type { Trajectories } from "../sim/trajectory.ts";

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
      const pool = evaluator;
      let step;
      let plan;
      let frames;
      try {
        step = await current.runGeneration(pool);
        plan = planRecording(step.result.fitness, step.result.bestIndex, current.config.dt);
        frames = pool.frames(plan);
      } catch (error) {
        if (current !== evolution) continue; // restarted, the old pool was closed under us
        throw error;
      }
      if (current !== evolution) continue; // restarted while evaluating, drop the stale generation
      const { result, population } = step;
      const trajectories: Trajectories = { offsets: plan.offsets, data: frames };
      const msg: GenerationMessage = {
        type: "generation",
        result,
        bestEver: current.bestEver,
        genomes: population.data,
        genomeLength: population.genomeLength,
        populationSize: population.size,
        trajectories,
      };
      post(msg, [population.data.buffer, result.fitness.buffer, trajectories.offsets.buffer, trajectories.data.buffer]);
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
    evaluator = createBrowserEvaluator(msg.config, undefined, true);
    evolution = new Evolution(msg.config);
    void loop();
  } else if (msg.type === "pause") {
    paused = true;
  } else if (paused) {
    paused = false;
    void loop();
  }
};
