import { formatElapsed } from "./elapsed.ts";

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// Tile value with its unit; "-" and no unit when the value is null. The unit is drawn by CSS.
export function setTile(id: string, value: string | null, unit = ""): void {
  const e = $(id);
  e.textContent = value ?? "-";
  e.dataset.unit = value === null ? "" : unit;
}

// The one duration style: "12.3 s" under a minute, then "4m 15s" (see formatElapsed).
export function formatDuration(s: number): { text: string; unit: string } {
  return Math.round(s * 10) / 10 < 60 ? { text: Math.max(0, s).toFixed(1), unit: " s" } : { text: formatElapsed(s), unit: "" };
}

export function durationText(s: number): string {
  const d = formatDuration(s);
  return d.text + d.unit;
}
