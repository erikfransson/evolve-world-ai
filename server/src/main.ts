import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePool } from "../../src/typescript/src/sim/seedPool.ts";
import { OVERRIDES, loadAdminToken, loadOverrides, startAdmin } from "./admin.ts";
import { HELPER_THREADS, HOST, LIMITS, PORTS, SEED_COPIES, liveConfig } from "./config.ts";
import { loadFounders } from "./founders.ts";
import type { Value } from "./tunables.ts";
import { createNodeThinkPool } from "../../src/typescript/src/worker/nodePool.ts";
import { LiveWorld, runTicks } from "./liveWorld.ts";
import { startPublic } from "./public.ts";
import { Saves } from "./saves.ts";
import { StateStore } from "./state.ts";

// parameters
const publicPort = Number(process.env.LIVE_PORT ?? PORTS.public);
const adminPort = Number(process.env.LIVE_ADMIN_PORT ?? PORTS.admin);
const stateDir = process.env.LIVE_STATE_DIR ?? fileURLToPath(new URL("../state", import.meta.url));
const poolFile = fileURLToPath(new URL("../../src/typescript/public/pool.json", import.meta.url));
const foundersFile = process.env.LIVE_FOUNDERS_FILE ?? fileURLToPath(new URL("../../src/typescript/public/live-founders.json", import.meta.url)); // seeds a fresh world
const threads = Number(process.env.LIVE_THREADS ?? HELPER_THREADS);
const webRoot = process.env.LIVE_WEB_ROOT ?? fileURLToPath(new URL("../../src/typescript/dist", import.meta.url)); // npm run build in src/typescript

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
// A startup step that fails exits with code 1, so systemd restarts the server (from the last good save) instead of serving half a world.
function startup<T>(what: string, step: () => T): T {
  const t0 = performance.now();
  try {
    const out = step();
    console.log(`${what}: ${Math.round(performance.now() - t0)} ms`);
    return out;
  } catch (e) {
    console.error(`STARTUP FAILED, ${what}: ${errText(e)}`);
    process.exit(1);
  }
}

const store = new StateStore(stateDir);
const token = loadAdminToken(stateDir);
const pool = parsePool(JSON.parse(readFileSync(poolFile, "utf8"))).entries;
if (!Number.isInteger(threads) || threads < 0 || threads > 16) throw new Error("LIVE_THREADS must be an integer from 0 to 16");
const founders = startup("founders file checked", () => loadFounders(foundersFile)); // checked on every start, so a bad file shows at once
const live = startup(`world built (${liveConfig.world.map || "random map"}, ${liveConfig.world.width} x ${liveConfig.world.height})`, () => new LiveWorld(liveConfig, pool, threads > 0 ? createNodeThinkPool(threads) : null));

const saves = new Saves(live, store);
const restored = await saves.restoreNewest();
let savedOverrides: Record<string, Value> = {};
if (restored) savedOverrides = loadOverrides(stateDir, live); // after the restore, so they apply to the world that runs
else {
  // A fresh world starts from liveConfig: overrides tuned for an earlier world are not applied (the file stays until the next admin change).
  if (existsSync(join(stateDir, OVERRIDES))) console.log(`fresh world: ${OVERRIDES} not applied`);
  const n = startup("founders seeded", () => live.seedFounders(founders));
  console.log(`fresh world seeded with ${n} creatures, ${SEED_COPIES} of each of ${founders.map((f) => f.name).join(", ")}`);
}

const pub = startPublic(HOST, publicPort, live);

const saveNow = (): Promise<string> => saves.save();
setInterval(() => void saveNow().then(console.log, (e: unknown) => console.error(errText(e))), LIMITS.stateEveryMs);

async function loadSave(name: string): Promise<string> {
  const line = await saves.load(name);
  pub.forgetFrames();
  return line;
}

// Save, then exit. Used by the admin stop and by SIGTERM and SIGINT.
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    console.log(await saveNow());
  } catch (e) {
    console.error(errText(e));
  }
  shutdown();
}

const admin = startAdmin(HOST, adminPort, token, live, stateDir, webRoot, savedOverrides, {
  pause: () => { live.paused = true; },
  resume: () => { live.paused = false; },
  paused: () => live.paused,
  saveNow,
  listSaves: () => store.list(),
  loadSave,
  stop,
});

runTicks(live, LIMITS.maxTickFailures, (why) => {
  console.error(`${why}, exiting without a save`);
  process.exit(1);
});
console.log(`${live.threads} helper threads`);
console.log(`live world on ws://${HOST}:${publicPort}, admin on ws://${HOST}:${adminPort} (token in ${stateDir}/admin-token)`);

function shutdown(): void {
  live.close();
  pub.close();
  admin.close();
  process.exit(0);
}
// A promise nobody handled is a bug: log it and exit, systemd restarts from the last good save.
process.on("unhandledRejection", (e) => {
  console.error(`unhandled rejection: ${errText(e)}`);
  process.exit(1);
});
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
