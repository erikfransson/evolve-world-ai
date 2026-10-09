import type { GenerationMessage, InMessage } from "./protocol.ts";
import { Evolution } from "../sim/evolution.ts";

let evolution: Evolution | null = null;
let paused = false;
let scheduled = false; // true while a loop tick is queued, so resume cannot start a second loop

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(loop, 0);
}

function loop(): void {
  scheduled = false;
  if (!evolution || paused) return;
  const { result, population } = evolution.runGeneration();
  const msg: GenerationMessage = {
    type: "generation",
    result,
    bestEver: evolution.bestEver,
    genomes: population.data,
    genomeLength: population.genomeLength,
    populationSize: population.size,
  };
  self.postMessage(msg, { transfer: [population.data.buffer, result.fitness.buffer] });
  schedule();
}

self.onmessage = (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  if (msg.type === "start") {
    paused = false;
    evolution = new Evolution(msg.config);
    schedule();
  } else if (msg.type === "pause") {
    paused = true;
  } else if (paused) {
    paused = false;
    schedule();
  }
};
