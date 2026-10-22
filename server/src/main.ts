import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePool } from "../../src/typescript/src/sim/seedPool.ts";
import { loadAdminToken, startAdmin } from "./admin.ts";
import { HELPER_THREADS, HOST, LIMITS, PORTS, liveConfig, seedRoom } from "./config.ts";
import { loadFounders, loadPools } from "./founders.ts";
import { checkCarry, oldestInWorld } from "./carry.ts";
import type { CarryOrder } from "./carry.ts";
import type { Value } from "./tunables.ts";
import { createNodeThinkPool } from "../../src/typescript/src/worker/nodePool.ts";
import { LiveWorld, runTicks } from "./liveWorld.ts";
import { startPublic } from "./public.ts";
import { Saves, copiesProblem, openWorld } from "./saves.ts";
import { StateStore } from "./state.ts";

// parameters
const publicPort = Number(process.env.LIVE_PORT ?? PORTS.public);
const adminPort = Number(process.env.LIVE_ADMIN_PORT ?? PORTS.admin);
const stateDir = process.env.LIVE_STATE_DIR ?? fileURLToPath(new URL("../state", import.meta.url));
const poolFile = fileURLToPath(new URL("../../src/typescript/public/pool.json", import.meta.url));
const foundersFile = process.env.LIVE_FOUNDERS_FILE ?? fileURLToPath(new URL("../../src/typescript/public/live-founders.json", import.meta.url)); // seeds a fresh world
const poolsFile = process.env.LIVE_FOUNDER_POOLS_FILE ?? fileURLToPath(new URL("../founder-pools.json", import.meta.url)); // trained variants the seeded copies are drawn from, if there is one
const threads = Number(process.env.LIVE_THREADS ?? HELPER_THREADS);
const webRoot = process.env.LIVE_WEB_ROOT ?? fileURLToPath(new URL("../../src/typescript/dist", import.meta.url)); // npm run build in src/typescript
const RESET_EXIT = 75; // after an admin reset: the unit restarts on it (RestartForceExitStatus), and the next start seeds the fresh world

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
const founders = startup("founders file checked", () => loadPools(poolsFile, loadFounders(foundersFile), process.env.LIVE_FOUNDER_POOLS_FILE !== undefined)); // checked on every start, so a bad file shows at once
console.log(`founder pools: ${founders.some((f) => f.pool) ? founders.map((f) => `${f.name} ${f.pool?.length ?? 0}`).join(", ") : "none"} (${poolsFile})`);
const live = startup(`world built (${liveConfig.world.map || "random map"}, ${liveConfig.world.width} x ${liveConfig.world.height})`, () => new LiveWorld(liveConfig, pool, threads > 0 ? createNodeThinkPool(threads) : null));

const saves = new Saves(live, store);
let savedOverrides: Record<string, Value>;
try {
  savedOverrides = await openWorld(saves, live, stateDir, founders);
} catch (e) {
  console.error(`STARTUP FAILED, opening the world: ${errText(e)}`);
  process.exit(1);
}

const pub = startPublic(HOST, publicPort, live);

const saveNow = (): Promise<string> => saves.save();
setInterval(() => void saveNow().then(console.log, (e: unknown) => console.error(errText(e))), LIMITS.stateEveryMs);

async function loadSave(name: string): Promise<string> {
  const line = await saves.load(name);
  pub.forgetFrames();
  return line;
}

// The one way out under way. A stop saves and exits 0. A reset keeps the world aside and exits RESET_EXIT, so the unit starts the fresh
// world; a stop asked meanwhile wins: the reset then exits 0 and the server stays down (or, the reset failed, the stop runs).
const exit: { way: "stop" | "reset" | null; stopAsked: boolean } = { way: null, stopAsked: false };

// Save, then exit. Used by the admin stop and by SIGTERM and SIGINT.
async function stop(): Promise<void> {
  if (exit.way === "reset") {
    exit.stopAsked = true;
    console.log("stop asked during a reset: the server stays down after it");
    return;
  }
  if (exit.way === "stop") return;
  exit.way = "stop";
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
  blankName: (name) => live.whenIdle(() => live.blankName(name)),
  renameName: (from, to, force) => live.whenIdle(() => live.renameName(from, to, force)),
  reset: async (copies, ask) => {
    if (exit.way) throw new Error(exit.way === "stop" ? "the server is stopping" : "a reset is under way");
    // The creature to carry, picked now: from the listed save asked for (another world's too), else the running world.
    let carry: CarryOrder | undefined;
    const badCopies = copiesProblem(copies, founders.length, live.freshEco); // first, so the carry's room is not reported from a bad count
    if (badCopies) throw new Error(badCopies);
    if (ask) {
      const creature = ask.from ? await store.readCarry(ask.from) : await live.whenIdle(() => oldestInWorld(live.eco));
      if (!creature) throw new Error(`no living creature to carry in ${ask.from ?? "the running world"}`);
      const order = checkCarry({ version: 1, name: ask.name, copies: ask.copies, creature }, live.freshAddRules(), seedRoom(live.freshEco) - copies * founders.length, founders.map((f) => f.name));
      if (typeof order === "string") throw new Error(order);
      carry = order;
    }
    if (exit.way) throw new Error(exit.way === "stop" ? "the server is stopping" : "a reset is under way"); // asked again while the save was read
    exit.way = "reset"; // a stop now saves nothing next to the kept world
    try {
      const line = await saves.reset(copies, founders.length, new Date(), carry);
      console.log(`reset: ${line}`);
      setTimeout(() => shutdown(exit.stopAsked ? 0 : RESET_EXIT), 500); // the reply goes out first
      return exit.stopAsked ? `${line}; a stop came meanwhile, so the server stays down until started` : line;
    } catch (e) {
      exit.way = null;
      if (exit.stopAsked) void stop();
      throw e;
    }
  },
});

runTicks(live, LIMITS.maxTickFailures, (why) => {
  console.error(`${why}, exiting without a save`);
  process.exit(1);
});
console.log(`${live.threads} helper threads`);
console.log(`live world on ws://${HOST}:${publicPort}, admin on ws://${HOST}:${adminPort} (token in ${stateDir}/admin-token)`);

function shutdown(code = 0): void {
  live.close();
  pub.close();
  admin.close();
  process.exit(code);
}
// A promise nobody handled is a bug: log it and exit, systemd restarts from the last good save.
process.on("unhandledRejection", (e) => {
  console.error(`unhandled rejection: ${errText(e)}`);
  process.exit(1);
});
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
