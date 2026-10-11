import { ENV_GROUPS, groupOf } from "../sim/rl/envs.ts";
import type { EnvGroup } from "../sim/rl/envs.ts";
import type { EnvSpec } from "../sim/rl/env.ts";

// Pure helpers of the environment gallery: grouping and the picked set. Sets are never mutated, so callers can compare before and after.

export interface GalleryGroup {
  group: EnvGroup;
  envs: EnvSpec[];
}

// One entry per non-empty group, in ENV_GROUPS order, each keeping the envs' own order.
export function galleryGroups(envs: readonly EnvSpec[]): GalleryGroup[] {
  return ENV_GROUPS.map((group) => ({ group, envs: envs.filter((e) => groupOf(e) === group) })).filter((g) => g.envs.length > 0);
}

export function toggleEnv(picked: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(picked);
  if (!next.delete(id)) next.add(id);
  return next;
}

// Adds (on) or removes (off) all of `ids`.
export function setEnvs(picked: ReadonlySet<string>, ids: readonly string[], on: boolean): Set<string> {
  const next = new Set(picked);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

export const pickedIn = (picked: ReadonlySet<string>, envs: readonly EnvSpec[]): number => envs.filter((e) => picked.has(e.id)).length;

export const summaryLine = (n: number): string => (n === 0 ? "No environment chosen" : `${n} environment${n === 1 ? "" : "s"} chosen`);

// The card's small tags: size, episode length, rivals, then the env's own tags.
export function envFacts(e: EnvSpec): string[] {
  const rivals = e.rivals.reduce((n, r) => n + r.count, 0);
  return [`${e.size[0]}×${e.size[1]}`, `${e.seconds} s`, ...(rivals > 0 ? [`${rivals} rival${rivals === 1 ? "" : "s"}`] : [])];
}
