// What the shipped ground pictures were drawn from (scripts/buildMapImage.ts): the map's prebuilt file and the code that draws them, as short hashes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
export const REMAKE = "cd src/typescript && node scripts/buildMapImage.ts"; // the command that draws the pictures again

// Every source file scripts/mapImage.ts imports, directly or not (relative .ts imports), itself included: the code a picture is drawn by.
export function lookFiles(): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    // Statement by statement, skipping `import type` and `export type`: erased at build time, they cannot change a picture.
    for (const m of text.matchAll(/^(import|export)\b([^;"]*?)(?:from\s+)?"(\.{1,2}\/[^"]+\.ts)"/gm)) if (!/^\s+type\b/.test(m[2]!)) visit(join(dirname(file), m[3]!));
  };
  visit(join(root, "scripts/mapImage.ts"));
  return [...seen].map((f) => relative(root, f)).sort();
}

// A source as it draws: without comment lines, end-of-line comments, trailing spaces and blank lines, so editing a comment needs no new pictures.
export function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/\s.*$/, "").trimEnd())
    .filter((l) => l.trim() !== "")
    .join("\n");
}

const short = (h: ReturnType<typeof createHash>): string => h.digest("hex").slice(0, 16);

export function groundImageHashes(name: string): { map: string; look: string } {
  const map = short(createHash("sha256").update(gunzipSync(readFileSync(join(root, `src/live/maps/${name}.bin`)))));
  const h = createHash("sha256");
  for (const f of lookFiles()) h.update(f).update(codeOf(readFileSync(join(root, f), "utf8")));
  return { map, look: short(h) };
}
