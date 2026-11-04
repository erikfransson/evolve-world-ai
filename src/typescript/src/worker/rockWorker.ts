import { haloPixels, rasterPixels } from "../ui/abyssRock.ts";
import type { RockJob, RockPixels } from "../ui/abyssRock.ts";

// Builds the shaded image or the halo of a rock body off the page's thread (ui/rockFarm.ts), pixels transferred back.

export type RockIn = { n: number; job: RockJob; cell: number; halo: boolean };
export type RockOut = { n: number; pixels: RockPixels | null };

self.onmessage = (e: MessageEvent<RockIn>) => {
  const { n, job, cell, halo } = e.data;
  let pixels: RockPixels | null = null;
  try {
    pixels = halo ? haloPixels(job, cell) : rasterPixels(job, cell);
  } catch {
    pixels = null;
  }
  (self as unknown as Worker).postMessage({ n, pixels } satisfies RockOut, pixels ? [pixels.px.buffer] : []);
};
