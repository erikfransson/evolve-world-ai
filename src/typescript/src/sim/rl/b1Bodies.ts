import type { PanelDesign } from "./designPanel.ts";

// B1 only: two extra test bodies beside the design panel (which stays the yardstick, unchanged) for the extremes users can build:
// the largest brain (4x32) and the smallest brain with long rays, few rays and the longest memory.
export const EXTRA_DESIGNS: readonly PanelDesign[] = [
  { id: "p9-max-brain", note: "16 rays, 4x32, length 150, spread 2.0, no memory", seed: 109, plan: { rayCount: 16, raySpread: 2.0, rayLength: 150, hiddenLayers: [32, 32, 32, 32], memoryShort: 0, memoryLong: 0 } },
  { id: "p10-two-rays-mem", note: "2 rays, 1x4, memory 8+8, length 400, spread 0.2", seed: 110, plan: { rayCount: 2, raySpread: 0.2, rayLength: 400, hiddenLayers: [4], memoryShort: 8, memoryLong: 8 } },
];
