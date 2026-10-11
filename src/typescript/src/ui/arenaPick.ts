import { KINDS } from "../sim/rl/creatureFile.ts";
import type { CreatureKind } from "../sim/rl/creatureFile.ts";
import { checkEnv } from "../sim/rl/env.ts";
import type { EnvSpec, Rivals } from "../sim/rl/env.ts";
import type { PlanView } from "../sim/sensors.ts";

// The envs a creature kind can train in: those of its world with its species as the learner.
export const envsForKind = (envs: readonly EnvSpec[], kind: CreatureKind): EnvSpec[] => envs.filter((e) => e.world === KINDS[kind].world && e.role === KINDS[kind].role);

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

// The custom environment editor's values; reward weights are null when left empty.
export interface CustomEnvForm {
  name: string;
  width: number;
  height: number;
  food: number;
  poison: number;
  regrow: number;
  seconds: number;
  rivals: Rivals[];
  reward: { food: number | null; kill: number | null; survive: number | null; energy: number | null };
}

// The checked env for the kind, with the given unique id, or the reason the form is not valid.
export function customEnv(form: CustomEnvForm, id: string, kind: CreatureKind): EnvSpec | string {
  const reward: Record<string, number> = {};
  for (const [k, v] of Object.entries(form.reward)) if (v !== null && Number.isFinite(v)) reward[k] = v;
  if (!Object.values(reward).some((v) => v !== 0)) return "set at least one reward weight other than 0";
  const { world, role } = KINDS[kind];
  return checkEnv(
    { id, name: form.name.trim() || `Custom ${id.replace(/\D+/g, "")}`, size: [form.width, form.height], food: form.food, poison: form.poison, foodRegrow: form.regrow, seconds: form.seconds, rivals: form.rivals, reward },
    world,
    role,
  );
}
