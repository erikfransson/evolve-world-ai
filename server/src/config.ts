import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";

export const MAX_POPULATION = 2500; // also the admin's upper limit (tunables.ts)

// The one world this server runs: the Ecosystem Normal preset on a world twice the area, collision damage on.
// The admin channel (admin.ts) edits this object in place for the settings the engine reads every tick.
// Tuned for roughly 1000 to 2000 creatures, see docs/tuning-notes.md.
export const liveConfig: EcoConfig = structuredClone(DEFAULT_ECO_CONFIG);
liveConfig.seed = 1;
liveConfig.world.width = 17000;
liveConfig.world.height = 10600;
liveConfig.eco.initialPopulation = 1000;
liveConfig.eco.foodRegrow = 0.02; // population settles near 1100 after 10 min (0.03 gives about 1650)
liveConfig.eco.collisionDamage = true;
liveConfig.eco.maxPopulation = MAX_POPULATION; // bounds the frame size, so the viewer budget holds

// Item slots are fixed when a world is built, so it is built with room for admin to raise the food and poison caps (densities, LIVE_MAX allows 10 each).
// Measured at about 1000 creatures: caps 3 and 1 cost 20 MB more RSS at a save and 0.1 s more saveState than 0.7 and 0.1, caps 10 and 10 cost 90 MB and 0.5 s.
export const ITEM_HEADROOM = { foodMaxDensity: 3, poisonMaxDensity: 1 };

// Settings of the server rather than the engine, changed from the admin page (tunables.ts).
export const LIVE = { speed: 2 }; // target simulated seconds per real second

export const LIMITS = {
  maxViewers: 100,
  maxSendBytesPerSecond: 3_000_000, // total upload budget, the home uplink is the limit; viewers get fewer frames, and none join past the slowest rate (budget.ts)
  connectBytesPerSecond: 300_000, // of the budget: catch-up frames for viewers that just connected, skipped when used up
  textBytesPerViewer: 1000, // of the budget, per viewer slot: stats, hello and pong
  acceptsPerSecond: 10, // new viewers, for all callers together
  acceptBurst: 30,
  headersTimeoutMs: 10_000, // an http request (the WebSocket upgrade) must arrive within this
  statsEveryMs: 1000,
  stateEveryMs: 4 * 60 * 60 * 1000,
  keepStateMs: 4 * 24 * 60 * 60 * 1000, // saves older than this are deleted, except the newest six (state.ts)
  maxStateDirBytes: 2e9, // no save is written while the state directory holds more than this
  maxSaveJsonBytes: 50e6, // a save may be at most this much JSON (real saves ~15 MB at 2300 creatures); parsing runs in a worker with its own heap cap (saveParse.ts)
  maxCatchUpS: 1, // after a stall longer than this the clock resyncs instead of racing to catch up
  sliceMs: 15, // simulation work per event-loop turn, so sockets stay served
  maxBufferedBytes: 1_000_000, // a viewer with more queued than this is skipped for frames (slow link)
  hardBufferedBytes: 2_000_000, // more than this queued: the client is dropped (100 viewers x 2 MB stays well inside the 1 GB unit cap)
  slowDropMs: 10_000, // a client above maxBufferedBytes for this long is dropped
  heartbeatMs: 30_000, // ws ping, a client that misses the pong is dropped
  idleDropMs: 60_000, // no message from the client for this long: dropped (the page pings every 20 s)
  maxClientMessagesPerSecond: 20,
};

export const PORTS = { public: 8787, admin: 8788 };
export const HOST = "127.0.0.1";
