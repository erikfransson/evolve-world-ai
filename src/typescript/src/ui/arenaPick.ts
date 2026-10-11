import type { EnvSpec } from "../sim/rl/env.ts";
import type { PlanView } from "../sim/sensors.ts";

export const ROLE_LABELS = ["Foragers", "Hunters", "Prey"] as const;

// The picker group of an env: hunters are predators, "prey" envs are prey in a hunt world, the rest forage.
export const roleGroup = (env: Pick<EnvSpec, "world" | "role">): (typeof ROLE_LABELS)[number] => (env.role === 1 ? "Hunters" : env.world === "hunt" ? "Prey" : "Foragers");

// One line on a body plan: rays, sight, brain layers and memory.
export function planSummary(plan: PlanView): string {
  const layers = plan.hiddenLayers.length ? plan.hiddenLayers.join("+") : "none";
  const memory = plan.memoryShort + plan.memoryLong;
  return `${plan.rayCount} rays over ${Math.round((plan.raySpread * 180) / Math.PI)}°, sight ${Math.round(plan.rayLength)}, hidden ${layers}, ${memory} memory unit${memory === 1 ? "" : "s"}`;
}

// A signed change with a direction for styling; "up" is better.
export function change(now: number, start: number): { text: string; dir: "up" | "down" | "flat" } {
  const d = now - start;
  if (Math.abs(d) < 0.05) return { text: "±0", dir: "flat" };
  return { text: `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}`, dir: d > 0 ? "up" : "down" };
}
