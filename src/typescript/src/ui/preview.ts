import { layerSizes, randomGenome } from "../sim/brain.ts";
import type { SimConfig } from "../sim/config.ts";
import { Episode } from "../sim/episode.ts";
import { founderRng, layoutSeedFor } from "../sim/evolution.ts";

const OPEN_FRACTIONS = [1, 0.75, 0.5, 0.3]; // of the ray length kept free of rock around the preview creature, tried in turn
const SEARCH_RINGS = 40;
const TURN_RATE = 0.7; // radians per second the preview creature turns, so its rays sweep

// A spot near (x, y) with no rock within clear, else null. The centre itself when it is open.
function openSpot(t: Episode["world"]["terrain"], x: number, y: number, clear: number, w: number, h: number): { x: number; y: number } | null {
  if (!t.touchesRock(x, y, clear)) return { x, y };
  for (let ring = 1; ring <= SEARCH_RINGS; ring++) {
    const d = ring * clear * 0.5;
    const points = ring * 8;
    for (let k = 0; k < points; k++) {
      const a = (2 * Math.PI * k) / points;
      const px = Math.min(w - clear, Math.max(clear, x + d * Math.cos(a)));
      const py = Math.min(h - clear, Math.max(clear, y + d * Math.sin(a)));
      if (!t.touchesRock(px, py, clear)) return { x: px, y: py };
    }
  }
  return null;
}

// Preview only: moves the never-run creature to open space (clear of rock for most of its ray length), leaving the real run's start alone.
function moveToOpenSpace(episode: Episode, config: SimConfig): void {
  const { width, height } = config.world;
  const s = episode.state;
  for (const f of OPEN_FRACTIONS) {
    const spot = openSpot(episode.world.terrain, s.x, s.y, Math.min(f * config.creature.rayLength, Math.min(width, height) / 2), width, height);
    if (spot) {
      s.x = spot.x;
      s.y = spot.y;
      return;
    }
  }
}

// Turns the preview creature in place for dt seconds and casts its rays again.
export function turnPreview(episode: Episode, dt: number): void {
  const s = episode.state;
  s.heading += TURN_RATE * Math.min(dt, 0.1);
  episode.creature.heading.cos = Math.cos(s.heading);
  episode.creature.heading.sin = Math.sin(s.heading);
  episode.sense();
}

// Generation-0 world with its first creature and sensed rays, or null if the settings cannot build one.
export function buildPreview(config: SimConfig): Episode | null {
  try {
    const genome = randomGenome(layerSizes(config), founderRng(config.seed));
    const episode = new Episode(config, genome, layoutSeedFor(config.seed, 0), 0, true, null); // never stepped, so no brain kernel
    moveToOpenSpace(episode, config);
    episode.sense();
    return episode;
  } catch (error) {
    console.warn("No preview for these settings:", error);
    return null;
  }
}
