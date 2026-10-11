import { Brain, layerSizes } from "../sim/brain.ts";
import { layoutConfig } from "../sim/rl/env.ts";
import type { EnvSpec } from "../sim/rl/env.ts";
import { inputLayout } from "../sim/sensors.ts";
import type { InputLayout, PlanView } from "../sim/sensors.ts";
import type { Recording } from "../sim/rl/recording.ts";
import { learnerAlive } from "./arenaScene.ts";
import { BrainView } from "./brainView.ts";

// The shown candidate's brain, replayed on the inputs recorded in tile 0.
export class BrainReplay {
  private readonly canvas: HTMLCanvasElement;
  private readonly view: BrainView;
  private brain: Brain | null = null;
  private layout: InputLayout | null = null;
  private out = new Float32Array(0);
  private genome: Float32Array | null = null;
  private last = -1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.view = new BrainView(canvas);
  }

  // env only supplies the world's input layout; plan is the creature's.
  setGenome(env: EnvSpec, plan: PlanView, genome: Float32Array): void {
    if (genome === this.genome) return;
    const config = layoutConfig(env.world);
    this.genome = genome;
    this.brain = new Brain(layerSizes(config, plan), genome);
    this.layout = inputLayout(config, plan);
    this.out = new Float32Array(this.layout.outputs);
    this.last = -1;
    this.canvas.style.height = `${Math.max(230, 70 + plan.rayCount * 15)}px`;
  }

  draw(rec: Recording, frame: number): void {
    const { brain, layout } = this;
    if (!brain || !layout || rec.inputSize !== layout.size) return;
    const key = frame + (rec.frames << 16);
    if (key === this.last) return;
    this.last = key;
    brain.forward(rec.inputs.subarray(frame * rec.inputSize, (frame + 1) * rec.inputSize), this.out);
    this.view.draw(brain, learnerAlive(rec, frame), layout);
  }

  reset(): void {
    this.genome = null;
    this.brain = null;
    this.last = -1;
  }
}
