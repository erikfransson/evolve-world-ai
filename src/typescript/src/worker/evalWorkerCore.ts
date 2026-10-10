import type { SimConfig } from "../sim/config.ts";
import { evaluateRange } from "../sim/evaluator.ts";
import type { EvalDone, EvalIn } from "./evalProtocol.ts";

// Environment-agnostic body of an evaluation worker: feed it messages, post what it returns.
export function createEvalHandler(): (msg: EvalIn) => EvalDone | null {
  let config: SimConfig | null = null;
  return (msg) => {
    if (msg.type === "init") {
      config = msg.config;
      return null;
    }
    if (!config) throw new Error("eval job before init");
    const fitness = new Float64Array(msg.end - msg.start);
    evaluateRange(config, msg.genomes, msg.genomeLength, msg.layoutSeed, msg.start, msg.end, fitness, msg.start);
    return { type: "done", job: msg.job, start: msg.start, fitness };
  };
}
