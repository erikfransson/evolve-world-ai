import { MAX_SHOW_TILES } from "../worker/rlProtocol.ts";

// Which replays the Arena shows and how its tile grid is laid out: one tile per environment in use, so the grid follows the
// chosen (or running) envs and never hides one; a few extra layouts per env when there are only a few envs.

export const LAYOUT_CHOICES = ["auto", "1", "2", "4"] as const;

// Replays per env: a number from the form, or "auto": 4 layouts of a single env, 2 each of two or three, else one each.
export function layoutsPerEnv(choice: string, envCount: number): number {
  const n = Number(choice);
  if (Number.isInteger(n) && n >= 1) return Math.min(4, n);
  return envCount <= 1 ? 4 : envCount <= 3 ? 2 : 1;
}

// Recordings in a show of `total` for `envCount` envs (recording k plays env k % envCount), in display order: each env's layouts side by side.
export function displayOrder(total: number, envCount: number): number[] {
  const n = Math.max(1, envCount);
  const ks = Array.from({ length: total }, (_, k) => k);
  return ks.sort((a, b) => (a % n) - (b % n) || a - b);
}

// Envs past the show cap train but get no replay.
export const unshownEnvs = (envCount: number): number => Math.max(0, envCount - MAX_SHOW_TILES);

// Columns for n tiles in a width: as many rows as the widest grid needs, then the columns balanced over them (12 in 4 per row is 4 x 3, 5 is 3 + 2).
export function gridColumns(n: number, width: number, minTile = 190): number {
  if (n <= 1) return 1;
  const max = Math.max(1, Math.floor(width / minTile));
  const rows = Math.ceil(n / max);
  return Math.ceil(n / rows);
}

export const PAGE_SIZE = 12;

// The tiles of one page: [from, to) into the display order, the page clamped to the ones there are.
export function pageOf(total: number, page: number, size = PAGE_SIZE): { from: number; to: number; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(pages - 1, Math.max(0, Math.floor(page)));
  return { from: p * size, to: Math.min(total, (p + 1) * size), page: p, pages };
}

// The phase the page is in, for its status pill and the tiles' badges.
export type Phase = "ready" | "training" | "paused" | "done";
export const phaseOf = (state: "idle" | "running" | "paused", hasRun: boolean): Phase => (state === "running" ? "training" : state === "paused" ? "paused" : hasRun ? "done" : "ready");
export const PHASE_TEXT: Record<Phase, string> = { ready: "Ready", training: "Training", paused: "Paused", done: "Finished" };
