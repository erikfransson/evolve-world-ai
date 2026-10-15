import { Worker } from "node:worker_threads";
import type { EcoState } from "../../src/typescript/src/sim/ecoState.ts";

// Unzips, parses and checks a save on a worker thread with its own small heap, so a crafted save (deep or many tiny JSON values)
// can at worst kill that worker, never the server. Resolves with a state restoreState accepted there, rejects with the reason otherwise.
// verifyOnly: only check, and resolve with nothing, so the rebuilt state (100 to 200 MB at 2500 creatures, more at the 3000 cap) never crosses to the main heap.
export const PARSE_HEAP_MB = 384;
const PARSE_TIMEOUT_MS = 120_000;
// A save's own check must finish well inside the unit's TimeoutStopSec=60, so a slow one cannot cost the shutdown save; a real one takes 3 to 6 s.
export const VERIFY_TIMEOUT_MS = 40_000;
const WORKER = new URL("./saveParseWorker.ts", import.meta.url);

// A save of another world: another size, map or map data. Startup starts a fresh world past it instead of retrying.
export class OtherWorld extends Error {}

// The world a server runs, as a save must match it: size, map name ("" for none) and that map's mapVersion ("" for none).
export interface Home {
  width: number;
  height: number;
  map: string;
  mapVersion: string;
}

// Why a parsed save is of another world than `home`, or null. Checked before the engine's own restore, whose checks of a named map
// (its size, its version) would otherwise refuse the save as broken.
export function otherWorldReason(state: unknown, home: Home): string | null {
  const s = typeof state === "object" && state !== null ? (state as { config?: { world?: { width?: unknown; height?: unknown; map?: unknown } }; mapVersion?: unknown }) : {};
  const w = s.config?.world;
  const map = typeof w?.map === "string" ? w.map : "";
  const show = (v: unknown, n: number): string => (typeof v === "number" || typeof v === "string" ? String(v).slice(0, n) : typeof v); // never a crafted object's toString
  const where = (width: unknown, height: unknown, m: string): string => `${show(width, 12)} x ${show(height, 12)} world${m ? ` (${m.slice(0, 40)})` : " without a map"}`;
  if (!w || w.width !== home.width || w.height !== home.height || map !== home.map) return `it is a ${where(w?.width, w?.height, map)}, this server runs ${where(home.width, home.height, home.map)}; the save is kept`;
  if (home.map && s.mapVersion !== undefined && s.mapVersion !== home.mapVersion) return `it was made on another version of the map ${home.map} (${show(s.mapVersion, 16)}, this server runs ${home.mapVersion}); the save is kept`;
  return null;
}

// home: when given, a save of another world rejects with OtherWorld before the engine's checks run.
export function parseSave(gz: Uint8Array, maxJsonBytes: number, verifyOnly?: false, home?: Home): Promise<EcoState>;
export function parseSave(gz: Uint8Array, maxJsonBytes: number, verifyOnly: true, home?: Home): Promise<undefined>;
export function parseSave(gz: Uint8Array, maxJsonBytes: number, verifyOnly = false, home?: Home): Promise<EcoState | undefined> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: { gz, maxJsonBytes, verifyOnly, home: home ?? null }, resourceLimits: { maxOldGenerationSizeMb: PARSE_HEAP_MB, maxYoungGenerationSizeMb: 32 }, stdout: false, stderr: false });
    let settled = false;
    const finish = (err: Error | null, state?: EcoState | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (err) reject(err);
      else resolve(verifyOnly ? undefined : state!);
    };
    const timer = setTimeout(() => finish(new Error("parsing the save took too long")), verifyOnly ? VERIFY_TIMEOUT_MS : PARSE_TIMEOUT_MS);
    worker.on("message", (m: { ok: true; state: EcoState | null } | { ok: false; reason: string; other?: boolean }) => finish(m.ok ? null : m.other ? new OtherWorld(m.reason) : new Error(m.reason), m.ok ? m.state : undefined));
    worker.on("error", (e: Error) => finish(new Error(`save parser failed: ${e.message}`)));
    worker.on("exit", (code) => finish(new Error(`save parser stopped (exit ${code})`)));
  });
}
