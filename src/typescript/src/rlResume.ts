// Helpers of the opt-in save/resume flags of rlGrad and rlTrain (--state, --ckpt, --ckpt-dir).
import { renameSync, writeFileSync } from "node:fs";

// A file that is complete or absent, never half written (a killed run leaves the old one).
export function writeFileAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

// "2000,6000" to [2000, 6000], ascending; the error text when a value is not a positive number (or not a whole one when whole).
export function parseCkpts(text: string | undefined, whole: boolean): number[] | string {
  const items = (text ?? "").split(",").filter(Boolean);
  const out = items.map(Number);
  if (out.some((v) => !(Number.isFinite(v) && v > 0 && (!whole || Number.isInteger(v))))) return `--ckpt must be a comma list of positive ${whole ? "whole " : ""}numbers, got "${text}"`;
  return [...new Set(out)].sort((a, b) => a - b);
}
