import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePool } from "../../src/typescript/src/sim/seedPool.ts";
import { loadAdminToken, loadOverrides, startAdmin } from "./admin.ts";
import { HOST, LIMITS, PORTS, liveConfig } from "./config.ts";
import { LiveWorld } from "./liveWorld.ts";
import { startPublic } from "./public.ts";
import { Saves } from "./saves.ts";
import { StateStore } from "./state.ts";

// parameters
const publicPort = Number(process.env.LIVE_PORT ?? PORTS.public);
const adminPort = Number(process.env.LIVE_ADMIN_PORT ?? PORTS.admin);
const stateDir = process.env.LIVE_STATE_DIR ?? fileURLToPath(new URL("../state", import.meta.url));
const poolFile = fileURLToPath(new URL("../../src/typescript/public/pool.json", import.meta.url));
const webRoot = process.env.LIVE_WEB_ROOT ?? fileURLToPath(new URL("../../src/typescript/dist", import.meta.url)); // npm run build in src/typescript

const store = new StateStore(stateDir);
const token = loadAdminToken(stateDir);
const pool = parsePool(JSON.parse(readFileSync(poolFile, "utf8"))).entries;
const live = new LiveWorld(liveConfig, pool);

const saves = new Saves(live, store);
await saves.restoreNewest();
const savedOverrides = loadOverrides(stateDir, live); // after the restore, so they apply to the world that runs

const pub = startPublic(HOST, publicPort, live);

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
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

function loop(): void {
  setTimeout(loop, live.advance());
}
loop();
console.log(`live world on ws://${HOST}:${publicPort}, admin on ws://${HOST}:${adminPort} (token in ${stateDir}/admin-token)`);

function shutdown(): void {
  pub.close();
  admin.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
