import { DEFAULT_ECO_CONFIG } from "../../src/typescript/src/sim/ecoConfig.ts";
import type { EcoConfig } from "../../src/typescript/src/sim/ecoConfig.ts";
import { itemsPerDensity } from "../../src/typescript/src/sim/config.ts";
import { MAX_ITEM_SLOTS, creatureFrameBytes, itemsBytes } from "../../src/typescript/src/live/protocol.ts";
import { MAX_FOUNDERS } from "../../src/typescript/src/live/founders.ts";
import { LIVE_BIRTH, MAX_COPIES } from "../../src/typescript/src/live/add.ts";

// Also the admin's upper limit (tunables.ts). At 3000 a creature frame is 57 kB: room() lets in about 23 to 38 viewers at the full
// population (fewer while items change fast), a save is about 29 MB of JSON, and a save and admin load peak near 720 MB (2500: 687 MB, 5000: 857 MB).
export const MAX_POPULATION = 3000;

// The one world this server runs: The Inland Sea map (src/sim/maps/inlandSea.ts) with the Ecosystem rules, collision damage on.
// The admin channel (admin.ts) edits this object in place for the settings the engine reads every tick.
// Food values from the launch plan (docs/status.md A5): food worth 50, slow regrowth, a fairly high cap, scarce poison.
export const liveConfig: EcoConfig = structuredClone(DEFAULT_ECO_CONFIG);
liveConfig.seed = 1;
liveConfig.world.map = "inland-sea";
liveConfig.world.width = 30000;
liveConfig.world.height = 18750;
liveConfig.world.foodEnergy = 50;
liveConfig.world.poisonDamage = 50; // a bite costs one food's worth, not the life (POISON_LETHAL is 100); see docs/tuning-notes.md
liveConfig.world.poisonDensity = 0.01; // start counts stay at or below the caps (foodDensity 0.5 is 28 125 items)
liveConfig.eco.initialPopulation = 0; // a fresh world is seeded with the founders file instead (founders.ts)
liveConfig.eco.foodRegrow = 0.003;
liveConfig.eco.foodMaxDensity = 1.5;
liveConfig.eco.poisonRegrow = 0.0003;
liveConfig.eco.poisonMaxDensity = 0.01;
liveConfig.eco.collisionDamage = true;
liveConfig.eco.maxPopulation = MAX_POPULATION; // bounds the frame size, so the viewer budget holds
liveConfig.eco.birthReserve = 100; // births stop 100 below the cap, so visitors can still add (insertCreature fills to maxPopulation)
liveConfig.eco.seasons = true;
liveConfig.eco.yearMinutes = 60;
liveConfig.eco.winterFood = 0.4;
liveConfig.eco.birthEnergyRange = [...LIVE_BIRTH.energy]; // wider than the Ecosystem's, for visitors' adds and their descendants' drift
liveConfig.eco.birthCostRange = [...LIVE_BIRTH.cost];
liveConfig.eco.birthCooldownRange = [...LIVE_BIRTH.cooldown];
liveConfig.eco.hueDrift = 3; // degrees (Ecosystem 8): families keep their colour longer, so the view reads as lineages

// A fresh world gets this many copies of each founder in the founders file, at random open spots.
export const SEED_COPIES = 10;
export const MAX_SEED_FOUNDERS = MAX_FOUNDERS; // the same bound as the pages (live/founders.ts)
export const MAX_FOUNDERS_FILE_BYTES = 512 * 1024; // 4 trained founders are 57 kB; 8 of the largest genomes an add allows (7538 weights, about 60 kB each) fit

// Item slots are fixed when a world is built, so it is built with room for admin to raise the food and poison caps (densities).
// Up to ITEM_HEADROOM where that fits (small worlds); else the slots are held to ITEM_SLOT_SHARE of the wire's MAX_ITEM_SLOTS:
// poison gets POISON_ROOM times its cap (at most its ITEM_HEADROOM), food the rest, never below the caps in force.
// The Inland Sea (56 250 items per density unit) gets the full headroom, food 3 and poison 1: 225 000 slots.
// Measured at about 1000 creatures on the old 17000 x 10600 world: caps 3 and 1 cost 20 MB more RSS at a save than 0.7 and 0.1.
export const ITEM_HEADROOM = { foodMaxDensity: 3, poisonMaxDensity: 1 };
export const ITEM_SLOT_SHARE = 0.9;
export const POISON_ROOM = 5;
type Caps = { foodMaxDensity: number; poisonMaxDensity: number };

// The caps a world is built with (its item slots), for its size and the caps in force. Throws when the caps alone pass the slot budget.
export function itemHeadroom(world: { width: number; height: number }, caps: Caps): Caps {
  const perDensity = itemsPerDensity({ world } as Parameters<typeof itemsPerDensity>[0]);
  const room = (ITEM_SLOT_SHARE * MAX_ITEM_SLOTS) / perDensity; // density units of slots in all
  const fixed = { foodMaxDensity: Math.max(caps.foodMaxDensity, ITEM_HEADROOM.foodMaxDensity), poisonMaxDensity: Math.max(caps.poisonMaxDensity, ITEM_HEADROOM.poisonMaxDensity) };
  if (fixed.foodMaxDensity + fixed.poisonMaxDensity <= room) return fixed;
  if (caps.foodMaxDensity + caps.poisonMaxDensity > room) throw new Error(`food and poison caps ${caps.foodMaxDensity} and ${caps.poisonMaxDensity} need more item slots than the wire carries (${Math.floor(room * 100) / 100} density units at ${size(world)})`);
  const poison = Math.max(caps.poisonMaxDensity, Math.min(ITEM_HEADROOM.poisonMaxDensity, POISON_ROOM * caps.poisonMaxDensity, room - caps.foodMaxDensity));
  const food = Math.max(caps.foodMaxDensity, Math.min(ITEM_HEADROOM.foodMaxDensity, Math.floor((room - poison) * 20) / 20));
  return { foodMaxDensity: food, poisonMaxDensity: poison };
}
const size = (w: { width: number; height: number }): string => `${w.width} x ${w.height}`;

// The admin's upper limits for the caps of the configured world (tunables.ts); retune also refuses caps past the slots a world has.
export const CAP_LIMITS = itemHeadroom(liveConfig.world, liveConfig.eco);

// Settings of the server rather than the engine, changed from the admin page (tunables.ts).
export const LIVE = {
  speed: 3, // target simulated seconds per real second; a tick costs about 7-16 ms at 1500-2200 creatures, so 4x would not keep up on one idle core
  reseed: 0, // 1: an extinct world starts over with a new seed; 0 (Erik's choice): it stays empty until visitors add creatures
  // Visitor adds ("Add your creature"), all admin-tunable as "add.<field>" (tunables.ts); adds.ts enforces them.
  add: {
    perWindow: 50, // creatures added by all visitors together per window (Erik): five full adds every 5 minutes
    windowS: 300,
    maxCopies: MAX_COPIES, // copies per add (10); each copy is one insert and one free-spot search of at most 40 tries
    aliveMax: 50, // visitor-added creatures alive at once (the inserted ones, not their children), whatever the population (Erik)
    perVisitor: 30, // creatures per visitor per window, three full adds, so at least 20 of perWindow stay for others: per address with trustForwardedFor, else per connection
    burst: 3, // adds a connection may send back to back (three full adds without waiting), then one per socketEveryS
    socketEveryS: 10, // one add per this many seconds on one connection after the burst; faster is refused with retryS, and 3 strikes (one back per minute) cut the connection
    minSpeed: 0.5, // simulated seconds per real second: below this the world counts as busy and adds wait
    startEnergy: 300, // energy an added creature starts with (the visitor never sets it)
    birthHoldS: 60, // simulated seconds after insertion before an added creature may first give birth; its children start without it
  },
};
// Per-visitor limits key on the address the tunnel puts in X-Forwarded-For. Tailscale Funnel (serve proxy mode) sets that header,
// overwriting any the visitor sent, to the address its ingress saw (ipn/ipnlocal/serve.go, addProxyForwardedHeaders).
// Off until checked with a real request through the tunnel (Erik's rule); LIVE_TRUST_FORWARDED=1 turns it on. Off, only the global caps apply.
export const TRUST_FORWARDED = process.env.LIVE_TRUST_FORWARDED === "1";
// Helper threads that sense and think (createNodeThinkPool); fixed for the process, LIVE_THREADS overrides. They inherit the unit's idle scheduling.
// None by default: under SCHED_IDLE on a busy host the server gets about one core whatever the thread count, and helpers cost 2.3x the CPU
// per tick (1190 creatures: 92 ticks/s on one thread, 53 with 6 helpers; 8.8 against 20.3 CPU ms per tick, review 2026-10-11).
export const HELPER_THREADS = 0;

export const LIMITS = {
  maxViewers: 100,
  maxSendBytesPerSecond: 3_000_000, // total upload budget, the home uplink is the limit; viewers get fewer frames, and none join past the slowest rate (budget.ts)
  connectBytesPerSecond: 300_000, // of the budget: catch-up frames for viewers that just connected, skipped when used up
  // The connect allowance holds this much at once: the largest full item set any world can have (all of the wire's MAX_ITEM_SLOTS in use)
  // plus a creature frame at MAX_POPULATION, about 1.17 MB, so a new viewer always gets its set from it, after a reseed or a load too.
  // At the 300 kB burst that went with the rate, the Inland Sea's sets (up to about 720 kB) all came out of the frame budget's resync share.
  connectBurstBytes: itemsBytes(MAX_ITEM_SLOTS, MAX_ITEM_SLOTS) + creatureFrameBytes(MAX_POPULATION),
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
  statsGetsPerSecond: 5, // GET /stats (the landing page's numbers), all callers together; past it a 503
  statsGetBurst: 20,
  statsEveryMs: 1000,
  stateEveryMs: 4 * 60 * 60 * 1000,
  keepStateMs: 4 * 24 * 60 * 60 * 1000, // saves older than this are deleted, except the newest six (state.ts)
  maxStateDirBytes: 2e9, // no save is written while the state directory holds more than this
  maxSaveJsonBytes: 50e6, // a save may be at most this much JSON (Inland Sea: 24 MB at 2500 creatures, 42 MB at 5000, about 29 MB at the 3000 cap); parsing runs in a worker with its own heap cap (saveParse.ts)
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
