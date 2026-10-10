import type { GenerationMessage, InMessage, OutMessage, PastRequest } from "./protocol.ts";
import { createBrowserEvaluator } from "./browserPool.ts";
import type { SimConfig } from "../sim/config.ts";
import { evaluateCreatures } from "../sim/evaluator.ts";
import type { Evaluator } from "../sim/evaluator.ts";
import { Evolution } from "../sim/evolution.ts";

let config: SimConfig | null = null;
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
      try {
        step = await current.runGeneration(pool, {});
      } catch (error) {
        if (current !== evolution) continue; // restarted, the old pool was closed under us
        throw error;
      }
      if (current !== evolution) continue; // restarted while evaluating, drop the stale generation
      const { result, population } = step;
      const trajectories = step.frames!; // recorded, since runGeneration got record options
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

// Runs between the awaits of the generation loop, so it works while running and paused.
function replayPast(msg: PastRequest): void {
  if (!config || !evolution) return; // no run (anymore), main drops the missing reply
  try {
    const { frames } = evaluateCreatures(config, msg.genomes, msg.genomeLength, msg.layoutSeed, msg.indices);
    const reply: OutMessage = {
      type: "past",
      request: msg.request,
      generation: msg.generation,
      layoutSeed: msg.layoutSeed,
      bestIndex: msg.indices[0]!,
      genome: msg.genomes.slice(0, msg.genomeLength),
      trajectories: frames,
    };
    post(reply, [frames.offsets.buffer, frames.data.buffer]);
  } catch (error) {
    post({ type: "pastError", request: msg.request, message: error instanceof Error ? error.message : String(error) });
  }
}

// Only the newest request runs, so a burst of graph clicks costs one re-simulation.
let pendingPast: PastRequest | null = null;
function runPendingPast(): void {
  const msg = pendingPast;
  pendingPast = null;
  if (msg) replayPast(msg);
}

self.onmessage = (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  if (msg.type === "past") {
    if (!pendingPast) setTimeout(runPendingPast, 0);
    pendingPast = msg;
  } else if (msg.type === "start") {
    config = msg.config;
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
