import type { EcoConfig } from "../sim/ecoConfig.ts";
import { mapPartsOf, seedMapTerrain } from "../sim/terrain.ts";
import type { MapParts } from "../sim/terrain.ts";
import type { Ecosystem } from "../sim/ecosystem.ts";
import { ShareCoordinator, ShareHelper, fittedCaps, packetBytes, packetViews, publishedBytes } from "../sim/ecoShare.ts";
import type { Port } from "./port.ts";
import { gentleCount } from "./pacer.ts";
import type { Caps, Packet } from "../sim/ecoShare.ts";

// Helper threads for one Ecosystem run (see ecoShare.ts), over message passing.
// Fork-join: each tick every helper gets a copy of the coordinator's packet by transfer and hands it back with its outputs.
// gen: the run a message belongs to, echoed in the reply, so a late reply from an earlier run is dropped.

export type HelperIn =
  | { type: "init"; gen: number; config: EcoConfig; worldCapacity: number; index: number; wasm: boolean; map: MapParts | null } // a new run, wasm as the coordinator; map: a hand-designed map's built arrays, so helpers skip its multi-second build
  | { type: "tick"; gen: number; buffer: ArrayBuffer }; // one tick's packet, transferred both ways

export type HelperOut = { type: "ready"; gen: number } | { type: "done"; gen: number; buffer: ArrayBuffer };

export type HelperPort = Port<HelperIn, HelperOut>;

const START_MS = 20_000; // helpers not ready for a run after this long are lost (the first start loads their scripts)
const TICK_MS = 5_000; // default for a tick or packet waiting so long that a helper is lost
const TICK_CAP_MS = 120_000; // the adaptive timeout never grows past this, so a dead helper is still noticed
const TICK_SLACK = 20; // the timeout is this many times the average tick, so a slow machine is not mistaken for a dead helper
const TICK_SMOOTHING = 0.2; // weight of the newest tick in the running average

// Timeout for one tick: base, or TICK_SLACK times the average tick duration when that is longer, capped at TICK_CAP_MS.
export function tickTimeoutMs(base: number, avgTickMs: number | null): number {
  if (avgTickMs === null) return base;
  return Math.max(base, Math.min(TICK_CAP_MS, TICK_SLACK * avgTickMs));
}

// Helper threads when none are asked for: leave one core for the page and one for the coordinator, at most 4; on a 4-core machine 6 were no faster than 4.
// Gentle on CPU: one fewer, leaving at least 2 cores free.
export function defaultHelpers(cores: number, gentle = false): number {
  const normal = Math.max(1, Math.min(cores - 1, 4));
  return gentle ? gentleCount(normal, cores) : normal;
}

export class ThinkPool {
  watch: number | null = null; // id of a creature the coordinator senses even when a helper owns it, so its rays and inputs are fresh for the page
  private readonly ports: HelperPort[];
  private coordinator: ShareCoordinator;
  private caps: Caps | null = null;
  private home: Packet | null = null; // the coordinator's packet: published here, read by senseOwn and collect
  private packets: Packet[] = []; // helper h's packet
  private readonly tickMs: number;
  private waiting: { count: number; resolve: () => void; reject: (e: unknown) => void } | null = null;
  private broken: unknown = null;
  private fresh = true; // no tick has run since the last start
  private avgTickMs: number | null = null; // running average of tick durations in this run, see tickTimeoutMs
  private gen = 0; // the current run, see HelperIn
  private last: Promise<unknown> = Promise.resolve(); // the latest start or step; a new start waits for it

  // tickMs: how long a tick waits for the helpers before the pool fails.
  constructor(ports: HelperPort[], tickMs = TICK_MS) {
    this.tickMs = tickMs;
    this.ports = ports;
    this.coordinator = new ShareCoordinator(ports.length);
    ports.forEach((port, h) => {
      port.onMessage((msg) => this.receive(h, msg));
      port.onError((error) => this.fail(error));
    });
  }

  get helpers(): number {
    return this.ports.length;
  }

  // False once a helper failed or close() was called; the pool is then useless.
  get alive(): boolean {
    return this.broken === null;
  }

  // Prepares the helpers for a new run, after the previous start or step has finished; eco must have been built with
  // the journal option and not stepped yet.
  start(eco: Ecosystem): Promise<void> {
    const started = this.last.catch(() => {}).then(() => this.begin(eco));
    this.last = started;
    return started;
  }

  // One tick of eco, once start has resolved: helpers sense and think, then the coordinator moves and runs the shared phase.
  step(eco: Ecosystem): Promise<void> {
    const stepped = this.stepNow(eco);
    this.last = stepped;
    return stepped;
  }

  close(): void {
    this.fail(new Error("pool closed"));
  }

  private begin(eco: Ecosystem): Promise<void> {
    if (this.broken) return Promise.reject(this.broken);
    const gen = ++this.gen;
    this.coordinator = new ShareCoordinator(this.ports.length);
    this.caps = null;
    this.home = null;
    this.packets = [];
    this.fresh = true;
    this.avgTickMs = null;
    const done = this.expect(START_MS);
    const map = mapPartsOf(eco.config);
    this.ports.forEach((port, index) => port.post({ type: "init", gen, config: eco.config, worldCapacity: eco.world.count, index, wasm: eco.wasm, map }));
    return done;
  }

  private async stepNow(eco: Ecosystem): Promise<void> {
    if (this.broken) throw this.broken;
    const caps = fittedCaps(this.caps, this.coordinator.need(eco));
    if (caps) this.resize(caps);
    try {
      await this.tick(eco);
    } catch (error) {
      if (this.home) this.coordinator.undoOwn(eco, this.home);
      throw error;
    }
  }

  private resize(caps: Caps): void {
    this.caps = caps;
    const bytes = packetBytes(caps);
    this.home = packetViews(new ArrayBuffer(bytes), caps);
    this.packets = this.ports.map(() => packetViews(new ArrayBuffer(bytes), caps));
  }

  private async tick(eco: Ecosystem): Promise<void> {
    const home = this.home!;
    this.coordinator.publish(eco, home, this.packets);
    const state = new Uint8Array(home.buffer, 0, publishedBytes(home));
    for (const p of this.packets) new Uint8Array(p.buffer).set(state);
    const cold = this.fresh; // the first tick builds every creature's brain and runs cold code; its duration seeds the average, which only loosens the timeout
    const base = cold ? Math.max(START_MS, this.tickMs) : this.tickMs;
    const done = this.expect(tickTimeoutMs(base, this.avgTickMs));
    this.fresh = false;
    const gen = this.gen;
    const started = performance.now();
    this.ports.forEach((port, h) => {
      const buffer = this.packets[h]!.buffer as ArrayBuffer;
      port.post({ type: "tick", gen, buffer }, [buffer]);
    });
    this.senseOwn(eco);
    await done;
    this.observe(performance.now() - started);
    this.finish(eco);
  }

  private observe(ms: number): void {
    this.avgTickMs = this.avgTickMs === null ? ms : (1 - TICK_SMOOTHING) * this.avgTickMs + TICK_SMOOTHING * ms;
  }

  private finish(eco: Ecosystem): void {
    this.coordinator.collect(eco, this.home!, this.packets);
    eco.finishTick(this.home!.touched);
  }

  // The coordinator's own share, while the helpers run theirs.
  private senseOwn(eco: Ecosystem): void {
    eco.prepareTick();
    this.coordinator.senseOwn(eco, this.home!, this.watch);
  }

  // A promise for one reply of the current run from every helper; fails the pool after ms.
  private expect(ms: number): Promise<void> {
    if (this.waiting) throw new Error("helper threads are still busy");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("helper threads stopped answering")), ms);
      this.waiting = {
        count: this.ports.length,
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  private receive(h: number, msg: HelperOut): void {
    if (msg.gen !== this.gen) return;
    if (msg.type === "done") this.packets[h] = packetViews(msg.buffer);
    const w = this.waiting;
    if (w && --w.count === 0) {
      this.waiting = null;
      w.resolve();
    }
  }

  private fail(error: unknown): void {
    if (this.broken) return;
    this.broken = error;
    for (const port of this.ports) port.terminate();
    const w = this.waiting;
    this.waiting = null;
    w?.reject(error);
  }
}

// Body of a helper thread: returns the message handler. post sends a reply to the coordinator.
export function serveHelper(post: (msg: HelperOut, transfer?: Transferable[]) => void): (msg: HelperIn) => void {
  let helper: ShareHelper | null = null;
  return (msg) => {
    switch (msg.type) {
      case "init":
        if (msg.map && msg.config.world.map) seedMapTerrain(msg.config.world.map, msg.config.world.width, msg.config.world.height, msg.map);
        helper = new ShareHelper(msg.config, msg.worldCapacity, msg.index, msg.wasm);
        post({ type: "ready", gen: msg.gen });
        break;
      case "tick":
        helper!.run(packetViews(msg.buffer));
        post({ type: "done", gen: msg.gen, buffer: msg.buffer }, [msg.buffer]);
        break;
    }
  };
}
