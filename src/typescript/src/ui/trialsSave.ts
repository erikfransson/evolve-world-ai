import type { SimConfig } from "../sim/config.ts";
import { creatureFile } from "../sim/rl/creatureFile.ts";
import type { CreatureFile } from "../sim/rl/creatureFile.ts";
import { trialsToEcoGenome } from "../sim/seedPool.ts";
import { planOf } from "../sim/sensors.ts";
import type { GenerationMessage } from "../worker/protocol.ts";

// "Save best creature" on the Trials page: the best creature of the newest generation as the RL Arena's creature file.
// Trials brains do not see other creatures, so the genome is mapped to the Ecosystem's "forager" layout with zero weights on the
// creature inputs (trialsToEcoGenome, as for the seed pool): it acts exactly as it did in Trials. The file holds no birth traits,
// Live's add panel and the Arena fill those from their own ranges.

const MAX_FROM = 80; // creatureFile.ts keeps 80 characters of a text, so a longer one would be cut mid-word

// The parts joined by commas, the last ones left out until it fits.
function fromText(parts: string[]): string {
  let text = parts.join(", ");
  for (let n = parts.length - 1; text.length > MAX_FROM && n > 1; n--) text = parts.slice(0, n).join(", ");
  return text;
}

export function trialsCreatureFile(config: SimConfig, m: GenerationMessage, date = new Date().toISOString().slice(0, 10)): CreatureFile {
  const { generation, bestIndex, bestFitness } = m.result;
  const plan = planOf(config);
  const own = m.genomes.subarray(bestIndex * m.genomeLength, (bestIndex + 1) * m.genomeLength);
  return creatureFile("forager", `Trials gen ${generation}`, { plan, genome: trialsToEcoGenome(plan, own) }, {
    envs: ["trials"],
    iterations: generation,
    from: fromText([`Trials gen ${generation}`, `${bestFitness.toFixed(1)} s`, `seed ${config.seed}`, `pop ${m.populationSize}`, `food ${config.world.foodDensity}`, `poison ${config.world.poisonDensity}`]),
    heldStart: null,
    heldEnd: null, // fitness here is one generation's layout, not a held-out score
    date,
  });
}

export const trialsFileName = (m: GenerationMessage): string => `trials-gen${m.result.generation}-fitness${Math.round(m.result.bestFitness)}.json`;
