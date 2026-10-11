import { Brain, layerSizes } from "../sim/brain.ts";
import type { EngineConfig } from "../sim/config.ts";
import { inputLayout } from "../sim/sensors.ts";
import type { InputLayout } from "../sim/sensors.ts";
import type { SelectedDetails } from "../worker/ecoProtocol.ts";

// The selected creature's brain as the page draws it: sized by the creature's own plan.
export interface SelectedBrain {
  brain: Brain;
  layout: InputLayout;
  out: Float32Array; // forward's output buffer
}

// details must carry the genome, which the worker sends once after selecting.
export function buildSelectedBrain(config: EngineConfig, details: SelectedDetails): SelectedBrain {
  const layout = inputLayout(config, details.plan);
  return { brain: new Brain(layerSizes(config, details.plan), details.genome!), layout, out: new Float32Array(layout.outputs) };
}
