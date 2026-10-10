import { genomeLength, layerSizes, randomGenome } from "../../src/typescript/src/sim/brain.ts";
import { DEFAULT_CONFIG, withOverrides } from "../../src/typescript/src/sim/config.ts";
import type { DeepPartial, SimConfig } from "../../src/typescript/src/sim/config.ts";
import { runEpisode } from "../../src/typescript/src/sim/episode.ts";
import { Evolution } from "../../src/typescript/src/sim/evolution.ts";
import { FRAME_FLOATS, FrameRecorder } from "../../src/typescript/src/sim/trajectory.ts";
import { testRng } from "./helpers.ts";

// Extremes of the settings form (trials/index.html sliders), plus values only the API allows.
const SHORT = { creature: { maxLifeSeconds: 8 } };
const cases: Record<string, DeepPartial<SimConfig>> = {
  "one ray": { creature: { rayCount: 1 } },
  "max rays": { creature: { rayCount: 16 } },
  "full circle spread": { creature: { raySpread: 2 * Math.PI } },
  "minimum spread (10 degrees)": { creature: { raySpread: (10 * Math.PI) / 180 } },
  "spread near zero": { creature: { raySpread: 1e-6, rayCount: 8 } },
  "one ray, full circle": { creature: { rayCount: 1, raySpread: 2 * Math.PI } },
  "no food": { world: { foodDensity: 0 } },
  "no poison": { world: { poisonDensity: 0 } },
  "no items at all": { world: { foodDensity: 0, poisonDensity: 0 } },
  "max densities": { world: { foodDensity: 1, poisonDensity: 1 } },
  "max densities with respawn": { world: { foodDensity: 1, poisonDensity: 1, respawn: true }, ...SHORT },
  "smallest world": { world: { width: 200, height: 200 } },
  "smallest world, max density": { world: { width: 200, height: 200, foodDensity: 1, poisonDensity: 1, respawn: true }, ...SHORT },
  "largest world": { world: { width: 4000, height: 3000 }, ...SHORT },
  "narrow world": { world: { width: 4000, height: 200 }, ...SHORT },
  "respawn without food": { world: { respawn: true, foodDensity: 0 }, ...SHORT },
  "shortest hidden layers": { brain: { hiddenLayers: [4] } },
  "widest hidden layers": { brain: { hiddenLayers: [32, 32, 32, 32] } },
  "minimum vision range": { creature: { rayLength: 40 } },
  "maximum vision range": { creature: { rayLength: 300 } },
  "very short life": { creature: { maxLifeSeconds: 0.1 } },
  "life shorter than one tick": { creature: { maxLifeSeconds: 0.001 } },
};

function config(over: DeepPartial<SimConfig>, size = 3): SimConfig {
  const base = withOverrides(DEFAULT_CONFIG, { population: { size }, creature: { maxLifeSeconds: 10 } });
  return withOverrides(base, over);
}

function genomeFor(c: SimConfig, seed = 5) {
  return randomGenome(layerSizes(c), testRng(seed));
}

describe.each(Object.entries(cases))("extreme setting: %s", (_name, over) => {
  const c = config(over);

  it("runs deterministically with finite fitness and energy and positions inside the world", () => {
    const recorder = new FrameRecorder(1);
    const fitness = [runEpisode(c, genomeFor(c), 77, 0, recorder)];
    expect(runEpisode(c, genomeFor(c), 77, 0)).toBe(fitness[0]); // same seed, same result
    for (const f of fitness) {
      expect(Number.isFinite(f)).toBe(true);
      expect(f).toBeGreaterThanOrEqual(0);
    }
    const { data } = recorder.result();
    expect(data.length).toBeGreaterThanOrEqual(FRAME_FLOATS);
    const { width, height } = c.world;
    const r = c.creature.radius;
    for (let i = 0; i < data.length; i += FRAME_FLOATS) {
      const [x, y, heading, energy] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
      expect(Number.isFinite(heading) && !Number.isNaN(energy)).toBe(true);
      // The body stays fully inside the walls; the slack covers Float32 storage.
      const eps = 1e-2;
      if (!(x >= r - eps && x <= width - r + eps && y >= r - eps && y <= height - r + eps)) throw new Error(`frame ${i / FRAME_FLOATS} outside world: ${x}, ${y}`);
    }
  });
});

describe("tiny populations", () => {
  it.each([1, 2, 3])("evolves a population of %i for a few generations deterministically", async (size) => {
    const c = config({ creature: { maxLifeSeconds: 10 } }, size);
    const run = async () => {
      const evo = new Evolution(c);
      const best: number[] = [];
      for (let g = 0; g < 3; g++) {
        const { result } = await evo.runGeneration();
        expect(result.fitness.length).toBe(size);
        expect(Number.isFinite(result.meanFitness)).toBe(true);
        best.push(result.bestFitness);
      }
      expect(evo.population.size).toBe(size);
      expect(evo.population.data.every(Number.isFinite)).toBe(true);
      return best;
    };
    expect(await run()).toEqual(await run());
  });

  it("evolves with extreme genetic algorithm settings", async () => {
    for (const ga of [{ mutationRate: 0 }, { mutationRate: 0.5 }, { selection: "proportional" as const }, { eliteFraction: 0, parentFraction: 1 }]) {
      const evo = new Evolution(config({ ga, creature: { maxLifeSeconds: 5 } }, 4));
      await evo.runGeneration();
      const { result } = await evo.runGeneration();
      expect(Number.isFinite(result.bestFitness)).toBe(true);
      expect(evo.population.data.every(Number.isFinite)).toBe(true);
    }
  });

  it("builds a minimal and a maximal brain with matching genome length", () => {
    for (const hiddenLayers of [[4], [32, 32, 32, 32]]) {
      const c = config({ brain: { hiddenLayers } });
      expect(genomeFor(c).length).toBe(genomeLength(layerSizes(c)));
    }
  });
});
