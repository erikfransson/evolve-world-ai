import { createRng } from "../../sim/rng.ts";
import type { EpisodeView } from "../../sim/types.ts";
import { drawScene } from "../scene.ts";
import { foodWorld, moveAndEat, nearestFood, scriptedCreature, sceneConfig, steer } from "./kit.ts";
import type { Scene } from "./kit.ts";

const VIEW = { showAll: false, showRays: true, pov: false };

// Trials: one creature with its ray fan, chasing food in its own arena. Energy never runs out here.
export function trialsScene(seed: number): Scene {
  const config = sceneConfig(300, 190, 1.6, { raySpread: (110 * Math.PI) / 180 });
  const world = foodWorld(config, createRng(seed));
  const respawnRng = createRng(seed + 1);
  const creature = scriptedCreature(config, 150, 95, 0.4);
  const { state, rays, rayOffsets } = creature;
  const view: EpisodeView = { state, rays, rayOffsets, world };
  return {
    step() {
      const target = nearestFood(world, state.x, state.y);
      const { turn, thrust } = steer(state, world.xs[target]!, world.ys[target]!);
      moveAndEat(creature, world, turn, thrust, respawnRng);
      creature.sense(world); // after the move, so the drawn rays start where the body is and stop at the wall
      state.energy = Math.max(state.energy, 0.2 * config.creature.startEnergy); // keep the body fill in the readable range
    },
    draw(ctx) {
      drawScene(ctx, config, view, [], VIEW);
    },
  };
}
