import { layerSizes, randomGenome } from "../brain.ts";
import { createRng, deriveSeed } from "../rng.ts";
import type { BodyPlan } from "../sensors.ts";
import { layoutConfig } from "./env.ts";
import type { Learner } from "./env.ts";

// A fixed panel of user-like designs for judging RL training across bodies and brains: small to large brains, few short to
// many long rays, with and without memory, narrow to wide spread. Each design has a fixed init seed, so the untrained
// panel is the same on every machine and run. Other tracks import this; change it only by adding designs at the end.

export interface PanelDesign {
  id: string;
  note: string;
  plan: BodyPlan;
  seed: number; // init seed of the weights
}

const d = (id: string, note: string, seed: number, rayCount: number, raySpread: number, rayLength: number, hiddenLayers: number[], memoryShort: number, memoryLong: number): PanelDesign => ({
  id, note, seed, plan: { rayCount, raySpread, rayLength, hiddenLayers, memoryShort, memoryLong },
});

export const DESIGN_PANEL: readonly PanelDesign[] = [
  d("p1-tiny", "3 short rays, 1x8, no memory", 101, 3, 1.0, 60, [8], 0, 0),
  d("p2-narrow-long", "5 narrow long rays, 1x8, no memory", 102, 5, 0.6, 200, [8], 0, 0),
  d("p3-mid", "8 rays, 1x16, 1+1 memory", 103, 8, 2.0, 120, [16], 1, 1),
  d("p4-wide-short", "8 wide short rays, 2x12, no memory", 104, 8, 3.5, 60, [12, 12], 0, 0),
  d("p5-many-rays", "16 long rays, 2x16, 2+2 memory", 105, 16, 2.5, 250, [16, 16], 2, 2),
  d("p6-big-brain", "8 rays, 3x32, no memory", 106, 8, 2.0, 150, [32, 32, 32], 0, 0),
  d("p7-big-memory", "12 rays all round, 2x24, 4+4 memory", 107, 12, Math.PI, 170, [24, 24], 4, 4),
  d("p8-few-wide-mem", "4 very wide rays, 2x8, 4+0 memory", 108, 4, 4.5, 100, [8, 8], 4, 0),
];

// The untrained learner of a design (Ecosystem input layout).
export function designLearner(design: PanelDesign): Learner {
  const rng = createRng(deriveSeed(design.seed, 0xde51));
  const plan: BodyPlan = { ...design.plan, hiddenLayers: design.plan.hiddenLayers.slice() };
  return { plan, genome: randomGenome(layerSizes(layoutConfig("ecosystem"), plan), rng) };
}
