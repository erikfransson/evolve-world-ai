import { itemsPerDensity } from "./config.ts";
import { seasonFactor } from "./ecoConfig.ts";
import type { EcoConfig } from "./ecoConfig.ts";
import type { StatefulRng } from "./rng.ts";
import { terrainOf } from "./terrain.ts";
import { HIT_FOOD, HIT_POISON } from "./types.ts";
import type { HitKind } from "./types.ts";
import type { World } from "./world.ts";

export interface ItemCaps {
  food: number;
  poison: number;
  limits: [Int32Array, Int32Array] | null;
}

// The most food and poison items a world holds. On a map with weights each cap cell has its own limit (the density times the cell's area and
// mean weight, see MapWeights.limits), so a rich region keeps more and a bare one less; the totals are the sums of the cells.
export function capsOf(config: EcoConfig, eco: Pick<EcoConfig["eco"], "foodMaxDensity" | "poisonMaxDensity">): ItemCaps {
  const perDensity = itemsPerDensity(config);
  const weights = terrainOf(config).weights;
  if (!weights) return { food: Math.round(eco.foodMaxDensity * perDensity), poison: Math.round(eco.poisonMaxDensity * perDensity), limits: null };
  const food = weights.limits(0, eco.foodMaxDensity, perDensity);
  const poison = weights.limits(1, eco.poisonMaxDensity, perDensity);
  return { food: food.reduce((a, b) => a + b, 0), poison: poison.reduce((a, b) => a + b, 0), limits: [food, poison] };
}

// The food and poison of an ecosystem: how many items of each kind the world holds, how fast they regrow and up to what cap.
export class ItemEconomy {
  food = 0; // items of each kind in the world now
  poison = 0;
  foodDue = 0; // fractional items accumulated by regrowth
  poisonDue = 0;
  private foodCap = 0;
  private poisonCap = 0;
  private foodPerTick = 0;
  private poisonPerTick = 0;
  private readonly config: EcoConfig;
  private readonly items: World;
  private readonly rng: StatefulRng;

  constructor(config: EcoConfig, items: World, rng: StatefulRng, caps: ItemCaps) {
    this.config = config;
    this.items = items;
    this.rng = rng;
    this.retune(caps);
  }

  // Takes the caps and the regrowth rates in force; the config holds the new rates already.
  retune(caps: ItemCaps): void {
    const { config } = this;
    this.foodCap = caps.food;
    this.poisonCap = caps.poison;
    if (caps.limits) this.items.setCapLimits(caps.limits[0], caps.limits[1]);
    const perDensity = itemsPerDensity(config);
    this.foodPerTick = config.eco.foodRegrow * perDensity * config.dt;
    this.poisonPerTick = config.eco.poisonRegrow * perDensity * config.dt;
  }

  // One tick of regrowth, at tick number tick.
  regrow(tick: number): void {
    this.foodDue += this.config.eco.seasons ? this.foodPerTick * seasonFactor(this.config.eco, tick * this.config.dt) : this.foodPerTick;
    this.poisonDue += this.poisonPerTick;
    // At the cap the rest of the due items is dropped at once, so a huge rate cannot loop; below 2^53 the leftover fraction is what counting down leaves.
    while (this.foodDue >= 1 && this.food < this.foodCap) {
      this.foodDue--;
      const grown = this.grow(HIT_FOOD);
      if (grown < 0) break; // no free slot
      this.food += grown;
    }
    this.foodDue -= Math.floor(this.foodDue);
    while (this.poisonDue >= 1 && this.poison < this.poisonCap) {
      this.poisonDue--;
      const grown = this.grow(HIT_POISON);
      if (grown < 0) break;
      this.poison += grown;
    }
    this.poisonDue -= Math.floor(this.poisonDue);
  }

  // Places one item at a random spot, spaced from poison like every placement; returns 1, 0 when the spot's cap cell was full, or -1 if no slot was free.
  private grow(kind: HitKind): number {
    const slot = this.items.addRandomly(kind, this.rng);
    return slot >= 0 ? 1 : slot === -1 ? -1 : 0;
  }

  // Whether a founder may start at (x, y): clear of rock, and on a map with weights accepted by the food weight, so founders favour the rich places.
  startOk(x: number, y: number, r: number): boolean {
    const t = this.items.terrain;
    return !t.touchesRock(x, y, r) && (t.weights === null || t.weights.accepts(0, x, y, this.rng.next()));
  }
}
