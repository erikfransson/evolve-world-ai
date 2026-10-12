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
liveConfig.eco.seasons = true; // a 40 min year is 10 min at 4x; population swings about 530 to 1220 (docs/tuning-notes.md)
liveConfig.eco.yearMinutes = 40;
liveConfig.eco.winterFood = 0.4;

// Item slots are fixed when a world is built, so it is built with room for admin to raise the food and poison caps (densities, LIVE_MAX allows 10 each).
// Measured at about 1000 creatures: caps 3 and 1 cost 20 MB more RSS at a save and 0.1 s more saveState than 0.7 and 0.1, caps 10 and 10 cost 90 MB and 0.5 s.
export const ITEM_HEADROOM = { foodMaxDensity: 3, poisonMaxDensity: 1 };

// Settings of the server rather than the engine, changed from the admin page (tunables.ts).
export const LIVE = {
  speed: 4, // target simulated seconds per real second
  // Visitor adds ("Add your creature"), all admin-tunable as "add.<field>" (tunables.ts); adds.ts enforces them.
  add: {
    perWindow: 20, // creatures added by all visitors together per window
    windowS: 300,
    maxCopies: 3, // copies per add (the protocol allows at most 3)
    aliveShare: 0.1, // added creatures alive (the inserted ones, not their children) at most this share of the population
    perVisitor: 3, // creatures per visitor address per window; needs trustForwardedFor
    socketEveryS: 10, // one add per this many seconds on one connection (burst 2); faster gets the connection cut
    minSpeed: 0.5, // simulated seconds per real second: below this the world counts as busy and adds wait
  },
};
// Per-visitor limits key on the address the tunnel puts in X-Forwarded-For. Tailscale Funnel (serve proxy mode) sets that header,
// overwriting any the visitor sent, to the address its ingress saw (ipn/ipnlocal/serve.go, addProxyForwardedHeaders, tailscale 1.104).
// The public port listens on loopback only, so nothing else can reach it with a made-up header. LIVE_TRUST_FORWARDED=0 turns it off.
export const TRUST_FORWARDED = process.env.LIVE_TRUST_FORWARDED !== "0";
// Helper threads that sense and think (createNodeThinkPool); fixed for the process, LIVE_THREADS overrides. They inherit the unit's idle scheduling.
// None by default: under SCHED_IDLE on a busy host the server gets about one core whatever the thread count, and helpers cost 2.3x the CPU
// per tick (1190 creatures: 92 ticks/s on one thread, 53 with 6 helpers; 8.8 against 20.3 CPU ms per tick, review 2026-10-11).
export const HELPER_THREADS = 0;

export const LIMITS = {
  maxViewers: 100,
  maxSendBytesPerSecond: 3_000_000, // total upload budget, the home uplink is the limit; viewers get fewer frames, and none join past the slowest rate (budget.ts)
  connectBytesPerSecond: 300_000, // of the budget: catch-up frames for viewers that just connected, skipped when used up
  maxTickFailures: 50, // consecutive failed ticks before the server exits (code 1) for systemd to restart it from the last good save
  textBytesPerViewer: 2000, // of the budget, per viewer slot: stats (with lineages, records every few seconds), hello and pong
  detailBytesPerViewer: 3000, // of the budget, per viewer slot: the selected creature's details (about 2 kB/s) and its genome once
  detailBurstBytes: 17_000, // a viewer's detail allowance holds this much, room for the largest genome (15 kB) plus a detail
  selectsPerSecond: 2, // selection changes per viewer; more are ignored (and every message counts against maxClientMessagesPerSecond)
  selectBurst: 4,
  detailRefreshesPerSecond: 25, // senses of followed creatures for their rays and brain inputs, all viewers together: 5 viewers get 5 Hz, 100 share it
  recordsEveryS: 5, // the records ride along with every this many stats
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
  addAttemptsPerSecond: 2, // add messages parsed per second, all viewers together; past it they are refused unread
  addAttemptBurst: 5,
};

export const PORTS = { public: 8787, admin: 8788 };
export const HOST = "127.0.0.1";
