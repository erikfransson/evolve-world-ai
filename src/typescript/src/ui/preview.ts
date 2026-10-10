import { layerSizes, randomGenome } from "../sim/brain.ts";
import type { SimConfig } from "../sim/config.ts";
import { Episode } from "../sim/episode.ts";
import { createRng, deriveSeed } from "../sim/rng.ts";

// Generation-0 world with one random creature and its sensed rays, or null if the settings cannot build one.
export function buildPreview(config: SimConfig): Episode | null {
  try {
    const genome = randomGenome(layerSizes(config), createRng(deriveSeed(config.seed, 0xbeef)));
    const episode = new Episode(config, genome, deriveSeed(config.seed, 0), 0);
    episode.sense();
    return episode;
  } catch {
    return null;
  }
}
