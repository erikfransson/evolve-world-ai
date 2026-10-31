import { layerSizes, randomGenome } from "../sim/brain.ts";
import type { SimConfig } from "../sim/config.ts";
import { Episode } from "../sim/episode.ts";
import { founderRng, layoutSeedFor } from "../sim/evolution.ts";

// Generation-0 world with its first creature and sensed rays, or null if the settings cannot build one.
export function buildPreview(config: SimConfig): Episode | null {
  try {
    const genome = randomGenome(layerSizes(config), founderRng(config.seed));
    const episode = new Episode(config, genome, layoutSeedFor(config.seed, 0), 0, true, null); // never stepped, so no brain kernel
    episode.sense();
    return episode;
  } catch (error) {
    console.warn("No preview for these settings:", error);
    return null;
  }
}
